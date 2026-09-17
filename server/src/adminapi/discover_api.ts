// 发现 + 一键采用（对齐 Go internal/adminapi/api.go 的 discover 端点与 quickimport.go）。
// 一键导入：一次请求走完「发现 → 采用 Provider → 全量导入共存登录态 → 补齐凭据默认值」。
// 红线：token 全程服务端读写、不经过前端、不落日志；tokenPath 必须在本次扫描结果内
// （防任意文件读）；credentialFile 只允许写在 config/credentials/ 下（防路径穿越）。

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
function readSession(tokenPath: string): { token: string; uid?: string } {
  let raw: string
  try {
    raw = readFileSync(tokenPath, 'utf8')
  } catch (e) {
    throw new Error((e as Error).message)
  }
  let token = ''
  let uid: string | undefined
  try {
    const f: unknown = JSON.parse(raw)
    if (isObj(f) && isObj(f.auth) && typeof f.auth.accessToken === 'string') token = f.auth.accessToken.trim()
    if (isObj(f) && isObj(f.account) && typeof f.account.uid === 'string') {
      const value = f.account.uid.trim()
      if (value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(value)) uid = value
    }
  } catch {}
  if (token === '') throw new Error('登录态文件不含有效 accessToken')
  return { token, uid }
}

export function registerDiscoverRoutes(app: Hono, ctx: AdminCtx): void {
  const { providers, accounts, changed, discover, lister } = ctx

  // ---- GET /discover ----
  app.get('/admin/api/discover', async (c) => {
    if (!discover) return ok(c, 200, { findings: [] })
    // ?refresh=1 绕过缓存强制实时探测（用户点「重新探测」）；
    // 默认走缓存 + 后台刷新：zen 的联网验证固有 2~8 秒，页面刷新不该干等。
    const force = c.req.query('refresh') === '1'
    const findings = (await discover.scan(force)).map((f) => ({ ...f }))
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

    // 顺序关键：必须先 providers.put(p) 落库，再导入账号。
    // providerId 是在 put 里由存储层分配并回填 p.providerId 的（store.ts 内存实现
    // 与 SQLite 实现都是如此）；放到后面，importSuggestedAccounts 拿到的仍是
    // 上面赋的 0，账号就带着 providerId=0 落库——而 pool/router 一律用
    // `a.providerId === providerId` 严格匹配，0 永远命不中，一键导入的账号
    // 因此根本不参与轮询（正是下面注释想防止的故障的另一种形态）。
    // 以前这里 put 在最后，实测 adopt 返回 providerId=1 而账号是 0。
    // quick-import 路径（第 228-241 行）顺序正确，两条路径就此对齐。
    providers.put(p)
    changed()

    // 采用必须一并把登录态导入账号池，否则 Provider 只挂着一个空的环境变量引用
    // （apiKeyEnv=WB_TOKEN），进程里没这个变量、池子也是空的 → 请求不带 Authorization
    // 打到上游，被前置网关拦成 HTML 401，用户以为「上游鉴权失败」（issue #1）。
    // 与 quick-import 共用同一段逻辑，避免两条路径的凭据处理再次漂移。
    const warnings = applyCredentialDefaults(p)
    const { warnings: importWarnings, imported } =
      importSuggestedAccounts(key, found.suggestedAccounts, p.providerId)
    warnings.push(...importWarnings)
    if (imported > 0) changed()
    // 与 quick-import 同样自动补全模型目录（两条路径行为必须一致，
    // 否则「采用」和「一键导入」出来的 Provider 可用性不同）。
    const modelWarn = await fillModelsIfEmpty(p)
    if (modelWarn) warnings.push(modelWarn)
    const res: Record<string, unknown> = { ...(providers.get(p.providerId) ?? p) }
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
    // workbuddy 单账号导入同样打来源标记，否则账号页的「签到」（自动登录）按钮
    // 永不显示——该按钮只认 importSource === 'workbuddy'（见 api.ts checkin）。
    let sess: { token: string; uid?: string }
    try {
      sess = readSession(tokenPath)
    } catch (e) {
      const msg = (e as Error).message
      return errRes(c, 400, ERR.INVALID_REQUEST,
        msg === '登录态文件不含有效 accessToken' ? msg : `读取登录态失败: ${msg}`)
    }
    try {
      writeFile0600(credentialFile, sess.token)
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
    if (key === 'workbuddy') markWorkbuddySource(acct, sess)
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
    if (existing && existing.state !== 'deleted') {
      p = existing
      created = false
    } else {
      suggested.providerId = 0
      providers.put(suggested)
      changed()
      p = suggested
      created = true
    }

    // ② 凭据默认值：ZEN_KEY 未配置时自动落免费档公共 key 凭据文件。
    warnings.push(...applyCredentialDefaults(p))

    // ③ 全量导入共存登录态（只导扫描结果里、活着的；按 token 内容去重；
    //    tokenPath 来自本次扫描结果，不收前端路径）。
    const { warnings: importWarnings, imported, skipped } =
      importSuggestedAccounts(key, found.suggestedAccounts, p.providerId)
    if (imported > 0) changed()
    warnings.push(...importWarnings)

    // ④ 自动补全模型目录（本次新增，修「导入后按真名调用 404」）：
    //    导入的 Provider 目录若是空的，用户拿上游真实模型名一调就 404，
    //    还得自己知道要去 Providers 页点「扫描可用性」。这里顺手扫一次，
    //    让「一键导入」真的做到一键可用。扫不到（无列表接口且无痕迹）不报错，
    //    只给一条指引——发现失败不该让整个导入动作失败。
    const modelWarn = await fillModelsIfEmpty(p)
    if (modelWarn) warnings.push(modelWarn)
    const latest = providers.get(p.providerId) ?? p

    const res: Record<string, unknown> = { provider: latest, created, imported, skipped }
    if (warnings.length > 0) res.warnings = warnings
    return ok(c, 200, res)
  })

  // 模型目录为空时自动拉一次真实模型并写回（adopt 与 quick-import 共用）。
  //
  // 为什么需要：采用草稿的模型目录是空的（不再预填猜的模型名，见 discover.wbSuggestedProvider）。
  // 目录空 = 用户拿上游真实模型名调用会 404「没有声明模型」，而「扫描可用性」这一步
  // README 没提、新用户不会知道要做。这里顺手补上，让「一键导入」真的一键可用。
  //
  // 边界：
  //   - 已有模型则不覆盖（用户可能手工维护过，尊重既有目录）；
  //   - lister 未接线 / 扫描失败 → 不抛错，回到「目录为空」并给一条可执行指引
  //     （发现失败不该让导入动作整个失败，那是两件事）；
  //   - 只写「启用」的新模型。
  // 返回一条 warning（无需提示时返回空串）。
  async function fillModelsIfEmpty(p: Provider): Promise<string> {
    const cur = providers.get(p.providerId)
    if (cur && cur.models.length > 0) return ''
    if (!lister) {
      return `模型目录为空：请到 Providers 页点「扫描可用性」获取真实模型（未接线，无法自动扫描）`
    }
    let ids: string[] = []
    // 上游慢/网络差时 fetchModelsWithProtocols 可能挂很久——导入响应绝不能被它拖住
    // （provider 在前面的 put 就已落库，模型补全晚到只损失「自动发现模型」这一项）。
    // 8s 竞速：超时走 catch 分支给指引，用户可稍后手动「扫描可用性」。
    try {
      const list = await Promise.race([
        lister.listProviderModels(p.providerId),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('模型自动扫描超时（8s）')), 8000)),
      ])
      ids = (list as { models: string[] }).models
    } catch (e) {
      return `模型目录为空且自动扫描未完成（${(e as Error).message}）：请到 Providers 页点「扫描可用性」或手动添加模型`
    }
    if (ids.length === 0) {
      return `模型目录为空且未能自动发现模型：请到 Providers 页点「扫描可用性」或手动添加模型`
    }
    const target = providers.get(p.providerId)
    if (!target || target.models.length > 0) return ''
    target.models = ids.map((id) => ({ id, manual: false, enabled: true }))
    providers.put(target)
    changed()
    return `已自动发现 ${ids.length} 个模型（${ids.slice(0, 5).join('、')}${ids.length > 5 ? '…' : ''}）；如与实际可用不符，请到 Providers 页核对`
  }

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
      let sess: { token: string; uid?: string }
      try {
        sess = readSession(acc.tokenPath)
      } catch (e) {
        warnings.push(`${acc.nickname}：跳过（${(e as Error).message}）`)
        continue
      }
      const tok = sess.token
      const same = key === 'workbuddy'
        ? findSameWorkbuddyIdentity(sess)
        : findSameIdentity(ownerId, acc.nickname)
      if (same) {
        // 复用而不是新建：原本挂在一条已删除 Provider 记录上的账号，直接改挂到当前
        // Provider 名下（就这一个号，不因为换了个 providerId 又建一行）。
        const prevOwner = providers.list().find((p) => p.providerId === same.providerId)
        if (!prevOwner || prevOwner.state === 'deleted') same.providerId = ownerId
        if (key === 'workbuddy') markWorkbuddySource(same, sess)
        // 凭据就地刷新（token 轮换）：文件型引用原路径覆盖；连引用都没有的补一个。
        let refreshed = false
        if (same.credential.apiKeyFile) {
          try {
            writeFile0600(same.credential.apiKeyFile, tok)
            refreshed = true
          } catch { /* 写失败就保留原凭据 */ }
        } else if (!same.credential.apiKeyEnv) {
          const f = join('config', 'credentials', `${same.id}-jwt`)
          try {
            writeFile0600(f, tok)
            same.credential = { apiKeyFile: f }
            refreshed = true
          } catch { /* 同上 */ }
        }
        warnings.push(refreshed
          ? `${acc.nickname}：登录态已刷新（token 轮换）`
          : `${acc.nickname}：已在账号池（已归到当前 Provider）`)
        accounts.put(same)
        changed()
        skipped++
        continue
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
      const fresh: Account = {
        id, providerId: ownerId, displayName: acc.nickname,
        credential: { apiKeyFile: credFile },
        status: 'available', fails: 0,
      }
      if (key === 'workbuddy') markWorkbuddySource(fresh, { uid: sess.uid, token: tok })
      accounts.put(fresh)
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
  function sourceAccountWithToken(providerId: number, token: string): Account | undefined {
    for (const acct of accounts.list()) {
      if (acct.providerId !== providerId || !acct.credential.apiKeyFile) continue
      try {
        if (readFileSync(acct.credential.apiKeyFile, 'utf8').trim() === token) return acct
      } catch {
        // 读不了视为不重复
      }
    }
    return undefined
  }

  // 同一个 WorkBuddy 身份（账号池里已存在的那一行）。
  //
  // 判据必须**跨 Provider**：反复「删掉 workbuddy 再一键导入」时，每次导入都会
  // 新建一条 Provider 记录（新 providerId），而账号归属判等是
  // `a.providerId === ownerId`，老账号因此永远匹配不上 → 每删导一轮就多出一整批。
  // 表面看是「好多 workbuddy 账号」，其实是同一个号被复制了 N 份。
  // 所以这里按身份（UID 优先，token 指纹兜底）全局找，不按 providerId 找。
  function findSameWorkbuddyIdentity(sess: { token: string; uid?: string }): Account | undefined {
    // 认 WorkBuddy 的行：UID 精确命中优先——它是跨删除/重建唯一稳定的身份凭据。
    if (sess.uid) {
      const byUid = accounts.list().find((a) => a.workbuddyUid === sess.uid)
      if (byUid) return byUid
    }
    // 老行是早期版本导进来的、UID 没落库：token 指纹命中才算同一个身份。
    // 只在已打标记的 workbuddy 行里比指纹，避免拿 zen/zcode 的行当账号认。
    const hash = workbuddyTokenHash(sess.token)
    const byHash = accounts.list().find((a) => a.workbuddyTokenHash === hash)
    if (byHash) return byHash
    // 同上：只对 workbuddy 来源的行比凭据原文，宁漏不错配。
    for (const acct of accounts.list()) {
      if (acct.importSource !== 'workbuddy' || !acct.credential.apiKeyFile) continue
      try {
        if (readFileSync(acct.credential.apiKeyFile, 'utf8').trim() === sess.token) return acct
      } catch {
        // 读不了视为不匹配
      }
    }
    return undefined
  }

  function findSameIdentity(providerId: number, nickname: string): Account | undefined {
    if (nickname === '') return undefined
    return accounts.list().find((a) => a.providerId === providerId
      && (a.displayName ?? '').includes(nickname))
  }

  function markWorkbuddySource(
    acct: Account, s: { uid?: string; token: string },
  ): void {
    acct.importSource = 'workbuddy'
    if (s.uid) acct.workbuddyUid = s.uid
    else delete acct.workbuddyUid
    acct.workbuddyTokenHash = workbuddyTokenHash(s.token)
  }
}

function cloneProvider(p: Provider): Provider {
  return { ...p, models: p.models.map((m) => ({ ...m })), credential: { ...p.credential } }
}

// 账号池 ID 前缀（沿用既有 workbuddy-N 惯例）。
function shortAccountPrefix(key: string): string {
  return key === 'workbuddy' ? 'workbuddy' : key
}

export function workbuddyTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
