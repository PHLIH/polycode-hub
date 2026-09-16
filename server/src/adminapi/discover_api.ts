// 发现 + 一键采用（对齐 Go internal/adminapi/api.go 的 discover 端点与 quickimport.go）。
// 一键导入：一次请求走完「发现 → 采用 Provider → 全量导入共存登录态 → 补齐凭据默认值」。
// 红线：token 全程服务端读写、不经过前端、不落日志；tokenPath 必须在本次扫描结果内
// （防任意文件读）；credentialFile 只允许写在 config/credentials/ 下（防路径穿越）。

import { readFileSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { writeFile0600 } from './credential_file.ts'
import { ERR } from '../ir/index.ts'
import { providerValidate, type Account, type Provider } from '../model/index.ts'
import type { Context, Hono } from 'hono'
import type { DiscoveredAccount, Finding } from './types.ts'
import type { AdminCtx } from './api.ts'

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

async function jsonBody(c: Context): Promise<unknown> {
  return c.req.json().catch(() => undefined)
}

function ok(c: Context, status: 200 | 201, v: unknown): Response {
  return c.json(v as Record<string, unknown>, status)
}

function errRes(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 500 | 501 | 502,
  typ: string, msg: string,
): Response {
  return c.json({ error: { type: typ, message: msg } }, status)
}

function field(o: Record<string, unknown>, k: string): string {
  return typeof o[k] === 'string' ? o[k] as string : ''
}

// credentialFile 校验：Clean 后必须仍带 config/credentials/ 前缀
// （穿越路径、绝对路径、目录本身一律拒绝）。
export function credentialPathOK(p: string): boolean {
  return normalize(p).startsWith('config/credentials' + sep)
}

// 读登录态文件并取出 accessToken。
function readAccessToken(tokenPath: string): string {
  let raw: string
  try {
    raw = readFileSync(tokenPath, 'utf8')
  } catch (e) {
    throw new Error((e as Error).message)
  }
  let token = ''
  try {
    const f: unknown = JSON.parse(raw)
    if (isObj(f) && isObj(f.auth) && typeof f.auth.accessToken === 'string') token = f.auth.accessToken
  } catch {
    // 落到下面的空值校验
  }
  if (token === '') throw new Error('登录态文件不含有效 accessToken')
  return token
}

export function registerDiscoverRoutes(app: Hono, ctx: AdminCtx): void {
  const { providers, accounts, changed, discover } = ctx

  // ---- GET /discover ----
  app.get('/admin/api/discover', async (c) => {
    if (!discover) return ok(c, 200, { findings: [] })
    const findings = (await discover.scan()).map((f) => ({ ...f }))
    // 已接管判定：发现项草稿的 Provider 名是否已有活跃行。
    // 只看未删除的行：删干净之后必须回到「未接管」，
    // 否则发现页永远显示「已导入」而「一键导入」被禁用 → 用户既导不进来也无处可删。
    const active = new Map(providers.list()
      .filter((p) => p.state !== 'deleted')
      .map((p) => [p.name, p] as const))
    for (const f of findings) {
      const draft = f.suggestedProvider
      const hit = draft ? active.get(draft.name) : undefined
      if (hit) f.adoptedProviderId = hit.providerId // 报真实行 id，前端据此定位/删除
    }
    return ok(c, 200, { findings })
  })

  // ---- POST /discover/adopt ----
  app.post('/admin/api/discover/adopt', async (c) => {
    if (!discover) return errRes(c, 501, ERR.API, '发现未接线')
    const body = await jsonBody(c)
    const key = isObj(body) ? field(body, 'key') : ''
    const customName = isObj(body) ? field(body, 'name') : ''
    if (key === '') return errRes(c, 400, ERR.INVALID_REQUEST, 'key 必填')
    const found = (await discover.scan()).find((f) => f.key === key)
    if (!found) return errRes(c, 404, ERR.NOT_FOUND, `未发现 ${key}`)
    if (found.status !== 'ready') {
      return errRes(c, 400, ERR.INVALID_REQUEST,
        `该 harness 未就绪（${found.status}），先按指引处理：${(found.actions ?? []).join('；')}`)
    }
    if (!found.suggestedProvider) {
      return errRes(c, 500, ERR.API, '该发现项无采用草稿')
    }
    const p: Provider = cloneProvider(found.suggestedProvider)
    if (customName !== '') p.name = customName
    p.providerId = 0
    const verr = providerValidate(p)
    if (verr) return errRes(c, 400, ERR.INVALID_REQUEST, verr)
    const existing = providers.getByName(p.name)
    if (existing && existing.state !== 'deleted') return ok(c, 200, existing) // 幂等：重复采用直接返回已有的

    // 采用必须一并把登录态导入账号池，否则 Provider 只挂着一个空的环境变量引用
    // （apiKeyEnv=WB_TOKEN），进程里没这个变量、池子也是空的 → 请求不带 Authorization
    // 打到上游，被前置网关拦成 HTML 401，用户以为「上游鉴权失败」（issue #1）。
    // 与 quick-import 共用同一段逻辑，避免两条路径的凭据处理再次漂移。
    const warnings = applyCredentialDefaults(p)
    const { warnings: importWarnings, imported } =
      importSuggestedAccounts(key, found.suggestedAccounts, p.providerId)
    warnings.push(...importWarnings)
    if (imported > 0) changed()
    providers.put(p)
    changed()
    const res: Record<string, unknown> = { ...p }
    if (warnings.length > 0) res.warnings = warnings
    return ok(c, 201, res)
  })

  // ---- POST /discover/import-account ----
  app.post('/admin/api/discover/import-account', async (c) => {
    const body = await jsonBody(c)
    if (!isObj(body)) return errRes(c, 400, ERR.INVALID_REQUEST, '请求体不是合法 JSON')
    const key = field(body, 'key')
    const tokenPath = field(body, 'tokenPath')
    const accountID = field(body, 'accountId')
    const displayName = field(body, 'displayName')
    const credentialFile = field(body, 'credentialFile')
    if (key === '' || tokenPath === '' || accountID === '' || credentialFile === '') {
      return errRes(c, 400, ERR.INVALID_REQUEST, 'key/tokenPath/accountId/credentialFile 必填')
    }
    if (!credentialPathOK(credentialFile)) {
      return errRes(c, 400, ERR.INVALID_REQUEST, 'credentialFile 必须位于 config/credentials/ 目录下')
    }
    if (!discover) return errRes(c, 501, ERR.API, '发现未接线')
    // 找到该 harness 的发现结果，并校验 tokenPath 确实在其中（防任意文件读）。
    let known: DiscoveredAccount[] | undefined
    for (const f of await discover.scan()) {
      if (f.key === key) known = f.suggestedAccounts
    }
    if (!known) return errRes(c, 404, ERR.NOT_FOUND, `未发现 ${key} 的共存登录态`)
    const acct0 = known.find((a) => a.tokenPath === tokenPath)
    if (!acct0) {
      return errRes(c, 400, ERR.INVALID_REQUEST,
        'tokenPath 不在本次发现结果内（已拒绝：只允许导入扫描到的登录态）')
    }
    if (!acct0.alive) {
      return errRes(c, 400, ERR.INVALID_REQUEST, '该登录态已过期，先在客户端重新登录')
    }
    if (accounts.get(accountID)) {
      return errRes(c, 409, ERR.INVALID_REQUEST, `账号 ${accountID} 已存在`)
    }
    // 归属：该 harness 已被哪个 Provider 接管（账号挂在它名下）。
    const owner = providerOfFinding(key)
    if (!owner) {
      return errRes(c, 400, ERR.INVALID_REQUEST,
        `还没有接管 ${key} 的 Provider，先「一键导入」采用它，再导账号`)
    }
    // 服务端读 token → 写凭据文件（0600）→ 建 account（只存文件引用）。
    let token: string
    try {
      token = readAccessToken(tokenPath)
    } catch (e) {
      const msg = (e as Error).message
      return errRes(c, 400, ERR.INVALID_REQUEST,
        msg === '登录态文件不含有效 accessToken' ? msg : `读取登录态失败: ${msg}`)
    }
    try {
      writeFile0600(credentialFile, token)
    } catch (e) {
      return errRes(c, 500, ERR.API, `写凭据文件失败: ${(e as Error).message}`)
    }
    const acct: Account = {
      id: accountID,
      providerId: owner.providerId,
      displayName: displayName !== '' ? displayName : acct0.nickname,
      credential: { apiKeyFile: credentialFile },
      status: 'available',
      fails: 0,
    }
    accounts.put(acct)
    changed()
    return ok(c, 201, acct)
  })

  // ---- POST /discover/quick-import ----
  app.post('/admin/api/discover/quick-import', async (c) => {
    if (!discover) return errRes(c, 501, ERR.API, '发现未接线')
    const body = await jsonBody(c)
    const key = isObj(body) ? field(body, 'key') : ''
    if (key === '') return errRes(c, 400, ERR.INVALID_REQUEST, 'key 必填')
    const found: Finding | undefined = (await discover.scan()).find((f: Finding) => f.key === key)
    if (!found) return errRes(c, 404, ERR.NOT_FOUND, `本机未发现 ${key}（未安装或从未登录过）`)
    if (found.status !== 'ready') {
      return errRes(c, 400, ERR.INVALID_REQUEST,
        `${key} 未就绪（${found.status}）：${(found.actions ?? []).join('；')}`)
    }
    if (!found.suggestedProvider) {
      return errRes(c, 500, ERR.API, '该发现项无采用草稿')
    }

    const warnings: string[] = []

    // ① 采用 Provider（幂等有两层：ID 相同直接返回；SourceID 相同也视为已接管）。
    const suggested = cloneProvider(found.suggestedProvider)
    const verr = providerValidate(suggested)
    if (verr) return errRes(c, 400, ERR.INVALID_REQUEST, verr)
    let p: Provider
    let created: boolean
    const existing = providers.getByName(suggested.name)
    if (existing) {
      p = existing
      created = false
    } else {
      // 幂等第二层：同名且未删除的 Provider 已存在（用户之前手工建过）——
      // 视为已接管，不重复建。
      const named = providers.getByName(suggested.name)
      const sameProvider = named && named.state !== 'deleted' ? named : undefined
      if (sameProvider) {
        p = sameProvider
        created = false
      } else {
        providers.put(suggested)
        changed()
        p = suggested
        created = true
      }
    }

    // ② 凭据默认值：ZEN_KEY 未配置时自动落免费档公共 key 凭据文件。
    warnings.push(...applyCredentialDefaults(p))

    // ③ 全量导入共存登录态（只导扫描结果里、活着的；按 token 内容去重；
    //    tokenPath 来自本次扫描结果，不收前端路径）。
    const { warnings: importWarnings, imported, skipped } =
      importSuggestedAccounts(key, found.suggestedAccounts, p.providerId)
    if (imported > 0) changed()
    warnings.push(...importWarnings)

    const res: Record<string, unknown> = { provider: p, created, imported, skipped }
    if (warnings.length > 0) res.warnings = warnings
    return ok(c, 200, res)
  })

  // 凭据默认值（adopt 与 quick-import 共用）：ZEN_KEY 未配置时把免费档公共 key
  // 落成凭据文件并改写 Provider 引用——否则和 WB_TOKEN 一样只剩一个空的环境变量引用。
  function applyCredentialDefaults(p: Provider): string[] {
    const warnings: string[] = []
    if (p.credential.apiKeyEnv === 'ZEN_KEY' && !process.env.ZEN_KEY) {
      const cred = join('config', 'credentials', 'zen-key')
      try {
        writeFile0600(cred, 'public')
        p.credential = { apiKeyFile: cred }
        providers.put(p)
        changed()
        warnings.push(`ZEN_KEY 未设置，已把公共 key 写入 ${cred}`)
      } catch {
        // 写不了就保持环境变量引用
      }
    }
    return warnings
  }

  // 把本次扫描到的共存登录态导入账号池（adopt 与 quick-import 共用）。
  // 只导活着的；tokenPath 一律取自扫描结果，不收前端传入的路径。
  function importSuggestedAccounts(
    key: string, suggested: DiscoveredAccount[] | undefined, ownerId: number,
  ): { warnings: string[]; imported: number; skipped: number } {
    const warnings: string[] = []
    let imported = 0
    let skipped = 0
    for (const acc of suggested ?? []) {
      if (!acc.alive) continue
      let tok: string
      try {
        tok = readAccessToken(acc.tokenPath)
      } catch (e) {
        warnings.push(`${acc.nickname}：跳过（${(e as Error).message}）`)
        continue
      }
      if (sourceAccountHasToken(ownerId, tok)) {
        skipped++
        continue
      }
      // 同身份但 token 变了 = 登录态轮换：原位更新凭据文件，不另建新账号。
      const same = findSameIdentity(ownerId, acc.nickname)
      if (same && same.credential.apiKeyFile) {
        try {
          writeFile0600(same.credential.apiKeyFile, tok)
          skipped++
          warnings.push(`${acc.nickname}：登录态已刷新（token 轮换）`)
          continue
        } catch {
          // 写失败则落到新建分支
        }
      }
      let id = ''
      for (let n = 1; ; n++) {
        const cand = `${shortAccountPrefix(key)}-${n}`
        if (!accounts.get(cand)) {
          id = cand
          break
        }
      }
      const credFile = join('config', 'credentials', `${id}-jwt`)
      try {
        writeFile0600(credFile, tok)
      } catch (e) {
        warnings.push(`${acc.nickname}：跳过（${(e as Error).message}）`)
        continue
      }
      accounts.put({
        id, providerId: ownerId, displayName: acc.nickname,
        credential: { apiKeyFile: credFile },
        status: 'available', fails: 0,
      })
      imported++
    }
    return { warnings, imported, skipped }
  }

  // harness key → 已接管它的 Provider（未删除）。discover 的 key 是 harness 名
  // （workbuddy / opencode-zen），而账号归属要的是 Provider.providerId。
  function providerOfFinding(key: string, suggested?: Provider): Provider | undefined {
    const byName = suggested ? providers.getByName(suggested.name) : undefined
    if (byName && byName.state !== 'deleted') return byName
    const hit = providers.getByName(key)
    return hit && hit.state !== 'deleted' ? hit : undefined
  }

  // 同 Provider 账号池里是否已有这个 token（按凭据文件内容比对；读不了视为不重复）。
  function sourceAccountHasToken(providerId: number, token: string): boolean {
    for (const acct of accounts.list()) {
      if (acct.providerId !== providerId || !acct.credential.apiKeyFile) continue
      try {
        if (readFileSync(acct.credential.apiKeyFile, 'utf8') === token) return true
      } catch {
        // 读不了视为不重复
      }
    }
    return false
  }

  // 同 Provider 且显示名含昵称的账号（昵称是稳定身份，显示名可能带后缀，包含匹配）。
  function findSameIdentity(providerId: number, nickname: string): Account | undefined {
    if (nickname === '') return undefined
    return accounts.list().find(
      (a) => a.providerId === providerId && (a.displayName ?? '').includes(nickname))
  }
}

function cloneProvider(p: Provider): Provider {
  return { ...p, models: p.models.map((m) => ({ ...m })), credential: { ...p.credential } }
}

// 账号池 ID 前缀（沿用既有 workbuddy-N 惯例）。
function shortAccountPrefix(key: string): string {
  return key === 'workbuddy' ? 'workbuddy' : key
}
