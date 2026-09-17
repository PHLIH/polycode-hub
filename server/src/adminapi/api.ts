// 管理面 REST（/admin/api/*，对齐 Go internal/adminapi/api.go）。
// 鉴权 withAuth（X-Admin-Key 或 Bearer；key 空 = 本机裸跑放行）；错误形状 {error:{type,message}}。
// 依赖注入：prober/lister/modelProber/resetter/discover/stats 未接线时对应端点 501
// （discover 列表例外：返回空列表，对齐 Go）；sidecar/projects 以 Hono 子应用注入。

import { Hono, type Context } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFile0600 } from './credential_file.ts'
import { ERR, validProtocol } from '../ir/index.ts'
import {
  providerValidate, accountHealth, validAccessKind, validRisk, sanitizeReasoningEffort,
  REASONING_EFFORT_MAX_LEN,
  credentialResolve, forgetProtocol,
  type Account, type CredentialRef, type Model, type Provider,
} from '../model/index.ts'
import type { ProbeResult } from '../gateway/probe.ts'
import { MemoryAccountStore, MemoryProviderStore, type AccountStore, type EgressStore, type ProviderStore } from './store.ts'
import { isObj, parseAccount, parseCredential, parseProvider } from './parse.ts'
import { registerDiscoverRoutes, workbuddyTokenHash } from './discover_api.ts'
import type {
  AccountProber, AccountResetter, AccountRuntime, ChangeNotifier, DiscoverSource, ModelList,
  ProviderModelLister, ProviderModelProber, ProviderProber,
  StatsSource,
} from './types.ts'
export type { ModelList }

// ---- 依赖装配 ----

export interface AdminApiDeps {
  adminKey: string
  egresses?: EgressStore
  providers?: ProviderStore
  accounts?: AccountStore
  stats?: StatsSource
  discover?: DiscoverSource
  resetter?: AccountResetter
  // 账号池运行时快照（冷却/连败不在 DB 里，列表页靠它显示真实状态）
  accountRuntime?: AccountRuntime
  accountProber?: AccountProber
  prober?: ProviderProber
  lister?: ProviderModelLister
  modelProber?: ProviderModelProber
  notify?: ChangeNotifier
  sidecar?: Hono
  projects?: Hono
}

// PATCH 白名单（只读字段出现即 400；ID 永久不可改；credential 只收引用）。
// accessKind/risk/stability/api 是运维判断，允许改；id 是通道身份，改 = 新建 + 删旧。
// api 放开编辑：改完清掉该 Provider 的协议探测缓存（forgetProtocol），下次请求按新声明直达。
// credentialInput 是「用户在界面粘的 Key 本体」输入口，由 handler 落成凭据文件（不收明文入库）；
// credentialKind 声明它的语义（key=Key 本体 / env=环境变量名），两者总是成对出现。
const PROVIDER_PATCH_ALLOW = new Set([
  // name 可改：只动对外名，providerId 与所有引用（账号归属、用量归因）都不动。
  // state 是三态开关（active/paused）；enabled 是它的布尔兼容写法。
  'name', 'state', 'enabled', 'priority', 'streamOnly', 'displayName', 'riskNote', 'risk',
  'credential', 'models', 'probeModel', 'egress', 'stability', 'accessKind', 'api',
  'credentialInput', 'credentialKind', 'baseUrl',
])

const ACCOUNT_PATCH_ALLOW = new Set([
  'status', 'displayName', 'credential', 'weight', 'credentialInput', 'credentialKind',
])

// ---- 小件 ----

type C = Context

function ok(c: C, status: 200 | 201 | 409 | 501 | 502, v?: unknown): Response {
  return c.json(v ?? {}, status)
}

function errRes(c: C, status: 400 | 401 | 403 | 404 | 409 | 500 | 501 | 502, typ: string, msg: string): Response {
  return c.json({ error: { type: typ, message: msg } }, status)
}

// ---- 粘贴的 Key → 凭据文件（真实缺陷修复）----
//
// 背景：管理台「API Key」框的语义是「环境变量名」，但用户看到这四个字就是把 Key
// 粘进去——粘完保存，credential.apiKeyEnv 存下了 Key 本体，网关拿它当变量名去
// process.env 里找，永远找不到，请求发出不带 Authorization，上游回 401。
// 用户侧看到的报错是「环境变量 atr_xxx 未设置」——让人一头雾水：我明明填了 Key。
//
// 判别方式：**不猜形状**。实测 atr_EXAMPLE0000000000000000000000abcd 这类 Key
// （36 位、全为 [A-Za-z0-9_]）与环境变量名的字符集完全重合，靠形状判别必然误判。
// 因此由界面显式声明语义（credentialKind）：
//   'key' → 当作 Key 本体，落凭据文件（用户粘完即能用）
//   'env' → 当作环境变量名，维持原语义
// 未声明（老客户端 / 直接调 API）时沿用历史行为 = env，不做任何猜测。
export type CredentialInputKind = 'key' | 'env'

// 凭据文件路径：一律落在 config/credentials/ 下（复用 discover 的路径守卫口径，
// 防路径穿越）。文件名从 provider/account id 派生，只保留安全字符。
// 注意 '..' 必须单独收敛：只保留 [a-zA-Z0-9._-] 时 '.' 是合法字符，id=".." 会拼出
// "config/credentials/provider-..-key" —— 文件名本身不越界，但让人误读成上级目录，
// 且某些平台对含 .. 的路径有额外解释。统一把连续点折成单个点。
export function credentialPathFor(kind: string, id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/\.{2,}/g, '.')
  return join('config', 'credentials', `${kind}-${safe}-key`)
}

// 把「用户填的凭据输入 + 界面声明的语义」规范化成 CredentialRef。
// 返回 [ref, err]：写文件失败时 err 非空（调用方转 500）。
// kind 缺省 = 'env'（历史行为，绝不静默改写老配置的语义）。
export function resolveCredentialInput(
  input: string, kind: CredentialInputKind, ownerKind: string, id: string,
): [CredentialRef | undefined, string] {
  const v = input.trim()
  if (v === '') return [undefined, '']
  if (kind === 'env') return [{ apiKeyEnv: v }, '']
  const file = credentialPathFor(ownerKind, id)
  try {
    writeFile0600(file, v)
  } catch (e) {
    return [undefined, `写凭据文件失败: ${(e as Error).message}`]
  }
  return [{ apiKeyFile: file }, '']
}

// 从请求体读出界面声明的凭据语义；未声明/非法值一律回落 'env'（老行为）。
export function parseCredentialKind(raw: Record<string, unknown>): CredentialInputKind {
  return raw.credentialKind === 'key' ? 'key' : 'env'
}

// 恒时比较（防时序攻击；对齐 Go subtle.ConstantTimeCompare 的判定语义）。
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab) // 长度不同也做一次比较，抹平时序
    return false
  }
  return timingSafeEqual(ab, bb)
}

async function jsonBody(c: C): Promise<unknown> {
  return c.req.json().catch(() => undefined)
}

// 路径参数 :pid 的共享解析：只接受十进制正整数串。
//
// 为什么不用裸 Number()：它会把 " 5"、"0x11"、"5.5" 都放进来，非法输入则静默变成 NaN。
// NaN 一旦往下传，错误信息就成了「provider #NaN 不存在」——既看不出是谁传的，
// 还会被读成「Provider 被删了」。更糟的是 NaN 会一路穿到存储层：内存实现 get(NaN)
// 恰好安全返回 undefined，SQLite 绑定 NaN 的行为却没保证（可能直接抛错 → 500）。
// 所以解析失败返回 undefined，调用方一律回 404 并**回显原始字符串**（保留排查线索）。
function parsePid(raw: string): number | undefined {
  if (!/^[0-9]+$/.test(raw)) return undefined
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

// 路径参数 → Provider：非法 pid 与查不到的 id 一视同仁（都 undefined），
// 调用方统一回 404。这样"非法输入"永远到不了存储层。
function findProvider(store: ProviderStore, raw: string): Provider | undefined {
  const pid = parsePid(raw)
  return pid === undefined ? undefined : store.get(pid)
}

interface CapsPatch {
  input?: string[]
  contextWindow?: number
  maxOutputTokens?: number
}

interface PatchModel {
  id: string
  protocol: string
  caps?: CapsPatch
}

// patchModel 兼容 "glm-5" 与 {"id":"glm-5", protocol?, caps?} 两种写法。
function parsePatchModels(v: unknown): PatchModel[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: PatchModel[] = []
  for (const item of v) {
    if (typeof item === 'string') {
      out.push({ id: item, protocol: '' })
      continue
    }
    if (!isObj(item) || typeof item.id !== 'string') return undefined
    const pm: PatchModel = { id: item.id, protocol: '' }
    if (typeof item.protocol === 'string' && validProtocol(item.protocol)) pm.protocol = item.protocol
    if (isObj(item.caps)) {
      const caps: CapsPatch = {}
      const input = item.caps.input
      if (Array.isArray(input) && input.length > 0 && input.every((x) => typeof x === 'string')) {
        caps.input = input as string[]
      }
      if (typeof item.caps.contextWindow === 'number') caps.contextWindow = item.caps.contextWindow
      if (typeof item.caps.maxOutputTokens === 'number') caps.maxOutputTokens = item.caps.maxOutputTokens
      pm.caps = caps
    }
    out.push(pm)
  }
  return out
}

// ---- 装配入口 ----

export function createAdminApi(deps: AdminApiDeps): Hono {
  const providers = deps.providers ?? new MemoryProviderStore()
  const accounts = deps.accounts ?? new MemoryAccountStore()
  const changed: ChangeNotifier = () => deps.notify?.()

  const app = new Hono()

  // withAuth：key 为空 = 裸跑放行；否则 X-Admin-Key 或 Bearer。
  app.use('*', async (c, next) => {
    if (deps.adminKey === '') return next()
    let got = c.req.header('X-Admin-Key') ?? ''
    if (got === '') {
      const authz = c.req.header('Authorization') ?? ''
      got = authz.startsWith('Bearer ') ? authz.slice(7) : authz
    }
    if (!safeEqual(got, deps.adminKey)) {
      return errRes(c, 401, ERR.AUTHENTICATION, '管理口令无效')
    }
    await next()
  })

  // ---- providers ----

  // 顶层出口列表 + CRUD：Provider/模型 egress 绑定的数据源。config/apps.yaml 里的定义由 cli 启动时种进库。
  app.get('/admin/api/egresses', (c) => ok(c, 200, { egresses: deps.egresses?.list() ?? [] }))
  app.put('/admin/api/egresses/:id', async (c) => {
    if (!deps.egresses) return errRes(c, 501, ERR.API, 'egress 存储未接线')
    const id = c.req.param('id')
    if (!id) return errRes(c, 400, ERR.INVALID_REQUEST, 'egress id 不能为空')
    const body = await jsonBody(c)
    if (!isObj(body) || typeof body.kind !== 'string' || typeof body.addr !== 'string' || body.addr === '') {
      return errRes(c, 400, ERR.INVALID_REQUEST, '请求体须为 {"kind": "http"|"https", "addr": "host:port"}')
    }
    if (body.kind !== 'http' && body.kind !== 'https') {
      return errRes(c, 400, ERR.INVALID_REQUEST, 'kind 只支持 http / https（Clash 混合端口用 http）')
    }
    const e = { id, kind: body.kind, addr: body.addr }
    deps.egresses.put(e)
    changed()
    return ok(c, 200, e)
  })
  app.delete('/admin/api/egresses/:id', (c) => {
    if (!deps.egresses) return errRes(c, 501, ERR.API, 'egress 存储未接线')
    if (!deps.egresses.delete(c.req.param('id'))) {
      return errRes(c, 404, ERR.NOT_FOUND, `egress ${c.req.param('id')} 不存在`)
    }
    changed()
    return ok(c, 200, { deleted: true })
  })

  app.get('/admin/api/providers', (c) => {
    return ok(c, 200, { providers: providers.list() })
  })

  // 凭证明文按需查看：列表页永远只下发引用（防泄漏锚点见 adminapi.test.ts），
  // 明文只在这个显式端点返回，且调用方必须是已通过 withAuth 的管理面。
  // 返回 {source, present, value}：无凭据声明 → present=false,value=''；
  // 声明了但解析失败（env 未设置/文件读不到）→ ok=true,present=false + hint 告诉去哪配。
  function credentialView(cr: CredentialRef): {
    source: string; present: boolean; value: string; hint: string
  } {
    if (cr.apiKeyFile) {
      try {
        const v = readFileSync(cr.apiKeyFile, 'utf8').trim()
        return {
          source: `文件 ${cr.apiKeyFile}`, present: v !== '', value: v,
          hint: v === '' ? `文件存在但内容为空：${cr.apiKeyFile}` : '',
        }
      } catch {
        return {
          source: `文件 ${cr.apiKeyFile}`, present: false, value: '',
          hint: `凭据文件读不到 file=${cr.apiKeyFile}（先确认文件存在且可读）`,
        }
      }
    }
    if (!cr.apiKeyEnv) return { source: '无（无需鉴权）', present: false, value: '', hint: '' }
    const [v, resolved] = credentialResolve(cr, (name) =>
      process.env[name] === undefined ? ['', false] : [process.env[name]!, true])
    if (!resolved) {
      return {
        source: `env ${cr.apiKeyEnv}`, present: false, value: '',
        hint: `环境变量 ${cr.apiKeyEnv} 未设置（先 export ${cr.apiKeyEnv}=... 并重启网关）`,
      }
    }
    return {
      source: `env ${cr.apiKeyEnv}`, present: v !== '', value: v,
      hint: v === '' ? `环境变量 ${cr.apiKeyEnv} 为空` : '',
    }
  }

  // 路径参数是 providerId（数字，内部标识）——改名不影响它。
  app.get('/admin/api/providers/:pid/credential', (c) => {
    const raw = c.req.param('pid')
    const p = findProvider(providers, raw)
    if (!p) return errRes(c, 404, ERR.NOT_FOUND, `provider #${raw} 不存在`)
    return ok(c, 200, credentialView(p.credential ?? {}))
  })

  app.post('/admin/api/providers', async (c) => {
    const raw = await jsonBody(c)
    if (raw === undefined) return errRes(c, 400, ERR.INVALID_REQUEST, '请求体不是合法 JSON')
    const p = parseProvider(raw)
    p.providerId = 0 // 由存储层分配
    const verr = providerValidate(p)
    if (verr) return errRes(c, 400, ERR.INVALID_REQUEST, verr)
    // 重名规则：active / paused 占名，deleted 不占（删掉的名字可以复用，会拿到新 provider_id）。
    const same = providers.getByName(p.name)
    if (same && same.state !== 'deleted') {
      return errRes(c, 409, ERR.INVALID_REQUEST,
        `Provider 名 ${p.name} 已被占用（#${same.providerId}，${same.state}）。`
        + `换个名字；若想复用该名字，先把它删掉。`)
    }
    // 用户在「API Key」框里粘的是 Key 本体（不是环境变量名）：落成凭据文件。
    // 顺序关键：credentialInput 必须**覆盖** credential —— 前端编辑表单会同时回传
    // 旧的 credential 引用（保住文件型密钥不被空表单清掉），若 Input 只是"没值才写"，
    // 粘进来的新 Key 就会被旧引用盖掉，用户看到的是"改了没生效"。
    // 直接传 credential{} 的旧调用方（配置种子/测试）不带 credentialInput，语义不变。
    if (isObj(raw) && typeof raw.credentialInput === 'string' && raw.credentialInput.trim() !== '') {
      const [ref, cerr] = resolveCredentialInput(
        raw.credentialInput, parseCredentialKind(raw), 'provider', p.name)
      if (cerr) return errRes(c, 500, ERR.API, cerr)
      if (ref) p.credential = ref
    }
    providers.put(p)
    changed()
    return ok(c, 201, p)
  })

  app.patch('/admin/api/providers/:pid', async (c) => {
    const raw = c.req.param('pid')
    const p = findProvider(providers, raw)
    if (!p) return errRes(c, 404, ERR.NOT_FOUND, `provider #${raw} 不存在`)
    const patch = await jsonBody(c)
    if (!isObj(patch)) return errRes(c, 400, ERR.INVALID_REQUEST, '请求体不是合法 JSON')
    for (const k of Object.keys(patch)) {
      if (!PROVIDER_PATCH_ALLOW.has(k)) {
        return errRes(c, 400, ERR.INVALID_REQUEST, `字段 ${k} 只读`)
      }
    }
    // 改名：只动 name，providerId 与所有引用（账号归属、用量归因）都不动。
    // 目标名被别的活跃 Provider 占用则拒绝；占用者是自己的旧记录（同名）则忽略。
    if (typeof patch.name === 'string' && patch.name !== p.name) {
      const next = patch.name.trim()
      if (next === '') return errRes(c, 400, ERR.INVALID_REQUEST, '名称不能为空')
      if (!/^[a-z0-9-]+$/.test(next)) {
        return errRes(c, 400, ERR.INVALID_REQUEST, '名称只允许小写字母/数字/连字符')
      }
      const other = providers.getByName(next)
      if (other && other.state !== 'deleted' && other.providerId !== p.providerId) {
        return errRes(c, 409, ERR.INVALID_REQUEST, `名称 ${next} 已被 #${other.providerId} 占用`)
      }
      p.name = next
    }
    if ('models' in patch) {
      // 模型采用：只增不减。已有 ID 不删（元数据保留），但补协议与能力（上游新声明的以本次为准）。
      const ids = parsePatchModels(patch.models)
      if (!ids) return errRes(c, 400, ERR.INVALID_REQUEST, 'models 须为 ["id"] 或 [{"id"}]')
      // 去重由下面的 p.models.find(...) 承担（它同时负责"补协议与能力"），
      // 不再另建 have 集合：以前这里建了 Set 并 have.add()，却没有任何 have.has()
      // 读取点，属于只写不读的遗留物——留着只会诱导后人按"have 里没有才新增"重构，
      // 而 have 是 p.models 的快照，两者状态并不真正同步。
      for (const input of ids) {
        if (input.id === '') continue
        const existing = p.models.find((m) => m.id === input.id)
        if (existing) {
          // 已存在：补协议与能力（上游新声明的以本次为准），不动其他元数据。
          if (input.protocol && existing.api !== input.protocol) existing.api = input.protocol
          if (input.caps) {
            if (input.caps.input && input.caps.input.length > 0) existing.input = input.caps.input
            if ((input.caps.contextWindow ?? 0) > 0) existing.contextWindow = input.caps.contextWindow
            if ((input.caps.maxOutputTokens ?? 0) > 0) existing.maxOutputTokens = input.caps.maxOutputTokens
          }
          continue
        }
        const nm: Model = { id: input.id, enabled: true, manual: false }
        if (input.protocol) nm.api = input.protocol
        if (input.caps) {
          nm.input = input.caps.input
          nm.contextWindow = input.caps.contextWindow
          nm.maxOutputTokens = input.caps.maxOutputTokens
        }
        p.models.push(nm)
      }
    }
    const setters: Record<string, (v: unknown) => boolean> = {
      // 开关即 state：active ↔ paused。deleted 只能由 DELETE 端点产生。
      enabled: (v) => {
        if (typeof v !== 'boolean') return false
        if (v) p.state = 'active'
        else if (p.state === 'active') p.state = 'paused'
        return true
      },
      state: (v) => {
        if (v !== 'active' && v !== 'paused') return false
        p.state = v
        return true
      },
      priority: (v) => {
        if (typeof v !== 'number') return false
        p.priority = v
        return true
      },
      streamOnly: (v) => {
        if (typeof v !== 'boolean') return false
        p.streamOnly = v
        return true
      },
      displayName: (v) => {
        if (typeof v !== 'string') return false
        p.displayName = v
        return true
      },
      riskNote: (v) => {
        if (typeof v !== 'string') return false
        p.riskNote = v
        return true
      },
      // 稳定性可在管理面改（stable/beta/experimental）：这是运维判断，不是身份字段。
      stability: (v) => {
        if (v !== 'stable' && v !== 'beta' && v !== 'experimental') return false
        p.stability = v
        return true
      },
      // 接入方式与风险等级同理：描述「这是什么通道、有多大风险」，随认知更新。
      // 「中/高风险必须带 riskNote」的跨字段约束由收尾的 providerValidate 兜底。
      accessKind: (v) => {
        if (typeof v !== 'string' || !validAccessKind(v)) return false
        p.accessKind = v
        return true
      },
      risk: (v) => {
        if (typeof v !== 'string' || !validRisk(v)) return false
        p.risk = v
        return true
      },
      // 协议放开编辑：空 = 自动识别；非空必须是合法协议。改完清探测缓存，
      // 否则进程内记住的旧协议会盖住新声明（resolveProtocol 先读 autoProtocol）。
      api: (v) => {
        if (typeof v !== 'string') return false
        if (v !== '' && !validProtocol(v)) return false
        if (p.api !== v) {
          p.api = v
          forgetProtocol(p.name, '')
        }
        return true
      },
      credential: (v) => {
        if (!isObj(v)) return false
        p.credential = parseCredential(v)
        return true
      },
      baseUrl: (v) => {
        if (typeof v !== 'string' || v === '') return false
        p.baseUrl = v
        return true
      },
      probeModel: (v) => {
        if (typeof v !== 'string') return false
        p.probeModel = v
        return true
      },
      egress: (v) => {
        // 空 = 清除引用（回到直连）；非空字符串 = 出口 id（存在性由调度侧兜底校验）
        if (typeof v !== 'string') return false
        if (v === '') delete p.egress
        else p.egress = v
        return true
      },
    }
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'models' || k === 'credentialInput' || k === 'credentialKind') continue
      const set = setters[k]
      if (!set) continue
      if (!set(v)) return errRes(c, 400, ERR.INVALID_REQUEST, `字段 ${k} 类型错误`)
    }
    // 编辑时同样支持粘贴 Key 本体（语义同 POST）：非空才覆盖，空串 = 不动原引用。
    if (typeof patch.credentialInput === 'string' && patch.credentialInput.trim() !== '') {
      const [ref, cerr] = resolveCredentialInput(
        patch.credentialInput, parseCredentialKind(patch), 'provider', p.name)
      if (cerr) return errRes(c, 500, ERR.API, cerr)
      if (ref) p.credential = ref
    }
    // 逐字段的 setter 只看单值，拦不住跨字段组合：risk 与 riskNote 单看都合法，
    // 合起来可能违反「中/高风险必须带说明」。只在本次真的碰了 risk/riskNote 时才查，
    // 避免对「只改 models」的请求做全量校验——库存量数据可能本就不完整（如 baseUrl 为空）。
    if ('risk' in patch || 'riskNote' in patch) {
      if ((p.risk === 'medium' || p.risk === 'high') && !(p.riskNote ?? '').trim()) {
        return errRes(c, 400, ERR.INVALID_REQUEST,
          `provider ${p.name}: risk=${p.risk} 必须填写 risk_note（UI 必须显示风险说明）`)
      }
    }
    providers.put(p)
    changed()
    return ok(c, 200, p)
  })

  // 删除 = 状态置 deleted（软删）。物理保留该行：历史用量要靠 providerId 回溯，
  // 而且名字被释放后可被新建复用，同名不同 id 在归因上也分得清。
  app.delete('/admin/api/providers/:pid', (c) => {
    const raw = c.req.param('pid')
    const p = findProvider(providers, raw)
    // 回显原始 pid：非法 pid 与不存在的 Provider 一律 404，排查时要能看出调用方传的是什么。
    if (!p) return errRes(c, 404, ERR.NOT_FOUND, `provider #${raw} 不存在`)
    p.state = 'deleted'
    providers.put(p)
    changed()
    return c.body(null, 204)
  })

  // 彻底清理已删除的 Provider（物理删行）。
  // 为什么要有这个端点：DELETE 是软删（保留行让历史用量能回溯到 providerId），
  // 但删掉的记录会**永久堆在库里**，而它又不出现在列表里——用户既看不到也管不了。
  // 代价必须说清：物理删掉后，那批历史用量的归因会退回「未知来源」。
  // 因此只允许删已经处于 deleted 的行：想清一条正在用的通道，必须先正常删除。
  app.delete('/admin/api/providers/:pid/purge', (c) => {
    const raw = c.req.param('pid')
    const p = findProvider(providers, raw)
    if (!p) return errRes(c, 404, ERR.NOT_FOUND, `provider #${raw} 不存在`)
    if (p.state !== 'deleted') {
      return errRes(c, 400, ERR.INVALID_REQUEST,
        `provider #${raw}（${p.name}）还在使用中（state=${p.state}），先删除它再清理`)
    }
    if (!providers.delete(p.providerId)) {
      return errRes(c, 404, ERR.NOT_FOUND, `provider #${raw} 不存在`)
    }
    changed()
    return c.body(null, 204)
  })

  // ---- accounts ----

  // 账号的「归属」= Provider.providerId（数字，永不变）。前端传来的是名字
  // （用户心智单位），这里解析成 id 存下——Provider 改名后账号归属自动跟着走。
  function providerForAccount(providerId: number): Provider | undefined {
    return providers.list().find((p) => p.providerId === providerId && p.state !== 'deleted')
  }

  // 前端按名字指定归属时用：只有活跃 Provider 才算有效归属。
  function activeProviderByName(name: string): Provider | undefined {
    const p = providers.getByName(name)
    return p && p.state !== 'deleted' ? p : undefined
  }

  // 列表：DB 记录 + 池内运行时（冷却/连败）。没有池子时退化为纯 DB 状态。
  // 运行时与 DB 冲突时以运行时为准——池子才是真正在调度的那个对象。
  app.get('/admin/api/accounts', (c) => {
    const now = new Date()
    const rows = accounts.list().map((a) => {
      const rt = deps.accountRuntime?.runtime(a.id)
      if (!rt) return { ...a, health: accountHealth(a, now) }
      const merged = { ...a, status: (rt.status || a.status) as Account['status'], fails: rt.fails }
      if (rt.cooldownUntil) merged.cooldownUntil = rt.cooldownUntil
      // 冷却已过期：不显示"冷却中"，直接复位（与 pick 同语义，避免 UI 撒谎）。
      if (merged.status === 'cooldown' && merged.cooldownUntil && now > merged.cooldownUntil) {
        merged.status = 'available'
        delete merged.cooldownUntil
      }
      // 健康度由后端算好下发：阈值只在 model 层定义一处，前端不必复制常量。
      return { ...merged, health: accountHealth(merged, now) }
    })
    return ok(c, 200, { accounts: rows })
  })

  app.post('/admin/api/accounts', async (c) => {
    const raw = await jsonBody(c)
    if (raw === undefined) return errRes(c, 400, ERR.INVALID_REQUEST, '请求体不是合法 JSON')
    if (isObj(raw) && ['importSource', 'workbuddyUid', 'workbuddyTokenHash'].some((k) => k in raw)) {
      return errRes(c, 400, ERR.INVALID_REQUEST, '导入来源与身份字段只读')
    }
    const ac = parseAccount(raw)
    if (ac.id === '') {
      return errRes(c, 400, ERR.INVALID_REQUEST, 'id 必填')
    }
    // 归属：前端传名字（providerName），也接受已有的数字 providerId。
    const wanted = isObj(raw)
      ? (typeof raw.providerName === 'string' ? raw.providerName : '')
      : ''
    let owner: Provider | undefined
    if (wanted !== '') {
      owner = activeProviderByName(wanted)
      if (!owner) {
        return errRes(c, 400, ERR.INVALID_REQUEST,
          `没有名为 ${wanted} 的 Provider（账号按 Provider 归属，先建 Provider 或从下拉里选）`)
      }
    } else if (ac.providerId > 0) {
      owner = providerForAccount(ac.providerId)
      if (!owner) {
        return errRes(c, 400, ERR.INVALID_REQUEST, `provider #${ac.providerId} 不存在或已删除`)
      }
    } else {
      return errRes(c, 400, ERR.INVALID_REQUEST, '归属 Provider 必填')
    }
    ac.providerId = owner.providerId
    if (!ac.status) ac.status = 'available'
    if (ac.status !== 'available' && ac.status !== 'disabled') {
      return errRes(c, 400, ERR.INVALID_REQUEST, '新建账号 status 只允许 available/disabled')
    }
    if (accounts.get(ac.id)) {
      // 重名直接拒（用户要求：重名就提示，不许悄悄覆盖）。
      return errRes(c, 409, ERR.INVALID_REQUEST, `账号 ID ${ac.id} 已存在，换一个名字`)
    }
    // 与 Provider 同口径：界面里粘的 Key 本体落成凭据文件，不落明文入库。
    // 同上，credentialInput 覆盖 credential（粘的 Key 必须赢过旧引用）。
    if (isObj(raw) && typeof raw.credentialInput === 'string' && raw.credentialInput.trim() !== '') {
      const [ref, cerr] = resolveCredentialInput(
        raw.credentialInput, parseCredentialKind(raw), 'account', ac.id)
      if (cerr) return errRes(c, 500, ERR.API, cerr)
      if (ref) ac.credential = ref
    }
    accounts.put(ac)
    changed()
    return ok(c, 201, ac)
  })

  app.patch('/admin/api/accounts/:id', async (c) => {
    const id = c.req.param('id')
    const ac = accounts.get(id)
    if (!ac) return errRes(c, 404, ERR.NOT_FOUND, `account ${id} 不存在`)
    const patch = await jsonBody(c)
    if (!isObj(patch)) return errRes(c, 400, ERR.INVALID_REQUEST, '请求体不是合法 JSON')
    for (const k of Object.keys(patch)) {
      if (!ACCOUNT_PATCH_ALLOW.has(k)) {
        return errRes(c, 400, ERR.INVALID_REQUEST, `字段 ${k} 只读`)
      }
    }
    if ('status' in patch) {
      const s = patch.status
      if (typeof s !== 'string') return errRes(c, 400, ERR.INVALID_REQUEST, 'status 非法')
      if (s !== 'available' && s !== 'disabled') {
        return errRes(c, 400, ERR.INVALID_REQUEST, 'status 只允许 available/disabled')
      }
      ac.status = s
    }
    const setters: Record<string, (v: unknown) => boolean> = {
      displayName: (v) => {
        if (typeof v !== 'string') return false
        ac.displayName = v
        return true
      },
      credential: (v) => {
        if (!isObj(v)) return false
        ac.credential = parseCredential(v)
        return true
      },
      weight: (v) => {
        // 流量权重：正整数；<=0/非数字拒绝（调用方应显式传，不静默归一）。
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return false
        ac.weight = Math.floor(v)
        return true
      },
    }
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'status' || k === 'credentialInput' || k === 'credentialKind') continue
      const set = setters[k]
      if (!set) continue
      if (!set(v)) return errRes(c, 400, ERR.INVALID_REQUEST, `字段 ${k} 类型错误`)
    }
    // 与 Provider 同口径：粘 Key 本体 → 落文件；空串 = 不动原引用。
    if (typeof patch.credentialInput === 'string' && patch.credentialInput.trim() !== '') {
      const [ref, cerr] = resolveCredentialInput(
        patch.credentialInput, parseCredentialKind(patch), 'account', ac.id)
      if (cerr) return errRes(c, 500, ERR.API, cerr)
      if (ref) ac.credential = ref
    }
    accounts.put(ac)
    changed()
    return ok(c, 200, ac)
  })

  app.delete('/admin/api/accounts/:id', (c) => {
    if (!accounts.delete(c.req.param('id'))) {
      return errRes(c, 404, ERR.NOT_FOUND, 'account 不存在')
    }
    changed()
    return c.body(null, 204)
  })

  // 账号凭证明文按需查看：与 Provider 同口径（列表只下发引用，明文走显式端点）。
  app.get('/admin/api/accounts/:id/credential', (c) => {
    const ac = accounts.get(c.req.param('id'))
    if (!ac) return errRes(c, 404, ERR.NOT_FOUND, `account ${c.req.param('id')} 不存在`)
    return ok(c, 200, credentialView(ac.credential ?? {}))
  })

  // 人工恢复键：只清调度侧惩罚，不探活（零上游成本）。
  app.post('/admin/api/accounts/:id/recheck', (c) => {
    const id = c.req.param('id')
    if (!accounts.get(id)) return errRes(c, 404, ERR.NOT_FOUND, `account ${id} 不存在`)
    const reset = deps.resetter ? deps.resetter.resetAccount(id) : false
    return ok(c, 200, {
      id,
      reset,
      message: '已清除调度惩罚，下一次真实请求即验证；仍 401 则继续冷却并记 ERROR',
    })
  })

  // 账号测试：用该账号的凭据打一次真实请求（模型缺省取源上第一个启用的）。
  // 有上游成本，与「重置」分开：重置零成本，测试是人工验证。
  app.post('/admin/api/accounts/:id/test', async (c) => {
    const id = c.req.param('id')
    if (!accounts.get(id)) return errRes(c, 404, ERR.NOT_FOUND, `account ${id} 不存在`)
    if (!deps.accountProber) return errRes(c, 501, ERR.API, '账号测试未接线')
    const body = await jsonBody(c)
    const model = isObj(body) && typeof body.model === 'string' ? body.model : ''
    const res: ProbeResult = await deps.accountProber.probeAccount(id, model)
    return ok(c, 200, res)
  })

  const checkins = new Set<string>()
  app.post('/admin/api/accounts/:id/checkin', async (c) => {
    const ac = accounts.get(c.req.param('id'))
    if (!ac) return errRes(c, 404, ERR.NOT_FOUND, '账号不存在')
    if (ac.importSource !== 'workbuddy') {
      return errRes(c, 400, ERR.INVALID_REQUEST, '仅支持一键导入的 WorkBuddy 账号')
    }
    if (!providerForAccount(ac.providerId)) {
      return errRes(c, 400, ERR.INVALID_REQUEST, '账号归属 Provider 不存在或已删除')
    }
    const uid = ac.workbuddyUid
    if (!uid || !/^[\x21-\x7e]{1,256}$/.test(uid)) {
      return errRes(c, 400, ERR.INVALID_REQUEST, '缺少有效 WorkBuddy UID，请重新登录后扫描导入')
    }
    const [token, resolved] = credentialResolve(ac.credential, (name) =>
      process.env[name] === undefined ? ['', false] : [process.env[name]!, true])
    if (!resolved || !token || workbuddyTokenHash(token) !== ac.workbuddyTokenHash) {
      return errRes(c, 400, ERR.INVALID_REQUEST, '凭据缺失或已变更，请重新扫描导入以核对身份')
    }
    if (checkins.has(uid)) return errRes(c, 409, ERR.INVALID_REQUEST, '该 WorkBuddy 账号正在签到，请勿重复点击')
    checkins.add(uid)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await fetch('https://copilot.tencent.com/billing/meter/daily-checkin', {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'X-User-Id': uid,
          'X-Domain': 'copilot.tencent.com',
          'X-IDE-Type': 'WorkBuddy',
          'X-IDE-Name': 'WorkBuddy',
          'X-IDE-Version': '5.5.3',
          'X-Product': 'WorkBuddy',
          'User-Agent': 'WorkBuddy/5.5.3',
        },
        body: '{}',
      })
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel()
        return errRes(c, 502, ERR.API, 'WorkBuddy 登录态失效或无权限，请重新登录后导入')
      }
      const data: unknown = await response.json().catch(() => undefined)
      if (response.status === 200 && isObj(data) && data.code === 0 && data.msg === 'OK') {
        return ok(c, 200, { status: 'accepted', message: 'WorkBuddy 已接受本次签到请求' })
      }
      if (response.status === 400 && isObj(data) && data.code === 10001
        && data.msg === '今天已签到，请明天再来') {
        return ok(c, 200, { status: 'already_checked_in', message: '今天已签到，请明天再来' })
      }
      return errRes(c, 502, ERR.API, 'WorkBuddy 返回未识别的签到结果，请在客户端核对；未自动重试')
    } catch {
      return errRes(c, 502, ERR.API, controller.signal.aborted
        ? '签到请求超时，结果未确认；请在客户端核对，未自动重试'
        : '签到请求失败，结果未确认；请在客户端核对，未自动重试')
    } finally {
      clearTimeout(timer)
      checkins.delete(uid)
    }
  })

  // ---- stats ----

  app.get('/admin/api/stats', async (c) => {
    if (!deps.stats) return errRes(c, 501, ERR.API, '统计未接线')
    try {
      return ok(c, 200, await deps.stats.summarize(new Date(0)))
    } catch (e) {
      return errRes(c, 500, ERR.API, '统计失败: ' + (e as Error).message)
    }
  })

  // 仪表盘聚合：days 查询参数限定回溯天数（默认 365，够画一年热力图）。
  // 显式 since/until 优先于 days（TIME-RANGE-FILTER §3.2）：
  //   since/until 支持 ISO 时间戳或 YYYY-MM-DD（本地日历日；until 日期含当日 → 次日 00:00，
  //   与 daily 的 localtime 分组口径一致）。非法值忽略，回落 days 路径。
  // account_id 非空 = 只统计该账号（ACCOUNT-HEALTH：详情页复用本端点）。
  const parseDateParam = (v: string | null | undefined): Date | undefined => {
    if (!v) return undefined
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const [y, m, d] = v.split('-').map(Number)
      return new Date(y!, m! - 1, d!)
    }
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : new Date(t)
  }
  const parseRange = (q: URLSearchParams): { since: Date; until?: Date } => {
    let days = 365
    const v = q.get('days')
    if (v !== undefined && v !== '') {
      const n = Number(v)
      if (Number.isInteger(n) && n > 0 && n <= 3650) days = n
    }
    const since = parseDateParam(q.get('since')) ?? new Date(Date.now() - days * 86_400_000)
    // until 日期形式含当日：加一天使区间右开边界落在次日 00:00
    let until = parseDateParam(q.get('until'))
    if (until && /^\d{4}-\d{2}-\d{2}$/.test(q.get('until')!)) {
      until = new Date(until.getTime() + 86_400_000)
    }
    return { since, until }
  }

  app.get('/admin/api/breakdown', async (c) => {
    if (!deps.stats) return errRes(c, 501, ERR.API, '统计未接线')
    const { since, until } = parseRange(c.req.raw ? new URL(c.req.url).searchParams : new URLSearchParams())
    const accountId = c.req.query('account_id') ?? ''
    try {
      return ok(c, 200, await deps.stats.breakdown(since, until, accountId))
    } catch (e) {
      return errRes(c, 500, ERR.API, '聚合失败: ' + (e as Error).message)
    }
  })

  // 账号维度用量列表（ACCOUNT-HEALTH §3.5）：GET /admin/api/usage/accounts?days=90&since&until
  app.get('/admin/api/usage/accounts', async (c) => {
    if (!deps.stats?.accountBreakdown) return errRes(c, 501, ERR.API, '统计未接线')
    const { since, until } = parseRange(new URL(c.req.url).searchParams)
    try {
      return ok(c, 200, { accounts: await deps.stats.accountBreakdown(since, until) })
    } catch (e) {
      return errRes(c, 500, ERR.API, '聚合失败: ' + (e as Error).message)
    }
  })

  // ---- 发现 + 一键采用（discover_api.ts）----
  registerDiscoverRoutes(app, { providers, accounts, changed, discover: deps.discover, lister: deps.lister })

  // ---- Provider 测试 / 模型发现 / 扫描 ----

  app.post('/admin/api/providers/:pid/test', async (c) => {
    if (!deps.prober) return errRes(c, 501, ERR.API, 'Provider 测试未接线')
    const raw = c.req.param('pid')
    // 先查库：不存在的 Provider 是 404，不是 200 + {ok:false}。
    // 以前把 Number(raw) 直接交给 prober，NaN 会变成「provider #NaN 不存在」的 200 响应，
    // 前端拿 ok:false 当"测试失败"渲染，实际是调用方传错了 id。
    const p = findProvider(providers, raw)
    if (!p) return errRes(c, 404, ERR.NOT_FOUND, `provider #${raw} 不存在`)
    const res: ProbeResult = await deps.prober.probeProvider(p.providerId)
    return ok(c, 200, res)
  })

  // 批量实测候选模型；探到的协议写回模型目录（探测结果即事实，下次转发直达）。
  app.post('/admin/api/providers/:pid/scan', async (c) => {
    if (!deps.modelProber) return errRes(c, 501, ERR.API, '批量模型扫描未接线')
    const raw = c.req.param('pid')
    // 同上：不存在/非法 id 是 404，不能让 NaN 穿到 prober 变成 200 + results[].error。
    const target = findProvider(providers, raw)
    if (!target) return errRes(c, 404, ERR.NOT_FOUND, `provider #${raw} 不存在`)
    const id = target.providerId
    const body = await jsonBody(c)
    const models = isObj(body) && Array.isArray(body.models)
      ? body.models.filter((x): x is string => typeof x === 'string')
      : []
    const results = await deps.modelProber.probeModels(id, models)
    const p = providers.get(id)
    if (p) {
      let mut = false
      for (const r of results) {
        if (!r.ok || !r.protocol) continue
        const m = p.models.find((x) => x.id === r.model)
        if (m && m.api !== r.protocol) {
          m.api = r.protocol
          mut = true
        }
      }
      if (mut) {
        providers.put(p)
        changed()
      }
    }
    return ok(c, 200, { results })
  })

  // 手工指定某模型的协议（空 = 继承 Provider 默认）；扫描自动写入，此端点是纠偏入口。
  app.put('/admin/api/providers/:pid/models/:model/protocol', async (c) => {
    const raw = c.req.param('pid')
    const pid = parsePid(raw)
    const modelID = c.req.param('model')
    const p = pid === undefined ? undefined : providers.get(pid)
    if (!p) return errRes(c, 404, ERR.NOT_FOUND, `provider #${raw} 不存在`)
    const body = await jsonBody(c)
    if (!isObj(body)) return errRes(c, 400, ERR.INVALID_REQUEST, '请求体不是合法 JSON')
    const protocol = typeof body.protocol === 'string' ? body.protocol : ''
    if (protocol !== '' && !validProtocol(protocol)) {
      return errRes(c, 400, ERR.INVALID_REQUEST,
        'protocol 只允许 openai-completions / openai-responses / anthropic-messages，或空字符串表示继承')
    }
    const m = p.models.find((x) => x.id === modelID)
    if (!m) return errRes(c, 404, ERR.NOT_FOUND, `provider #${c.req.param('pid')} 下没有模型 ${modelID}`)
    if (protocol === '') delete m.api
    else m.api = protocol
    providers.put(p)
    changed()
    return ok(c, 200, m)
  })

  // 手工指定某模型的出口代理（空 = 继承 Provider 默认）；引用顶层 egresses 的 id。
  app.put('/admin/api/providers/:pid/models/:model/egress', async (c) => {
    const raw = c.req.param('pid')
    const pid = parsePid(raw)
    const modelID = c.req.param('model')
    const p = pid === undefined ? undefined : providers.get(pid)
    if (!p) return errRes(c, 404, ERR.NOT_FOUND, `provider #${raw} 不存在`)
    const body = await jsonBody(c)
    if (!isObj(body)) return errRes(c, 400, ERR.INVALID_REQUEST, '请求体不是合法 JSON')
    const egress = typeof body.egress === 'string' ? body.egress : ''
    const m = p.models.find((x) => x.id === modelID)
    if (!m) return errRes(c, 404, ERR.NOT_FOUND, `provider #${c.req.param('pid')} 下没有模型 ${modelID}`)
    if (egress === '') delete m.egress
    else m.egress = egress
    providers.put(p)
    changed()
    return ok(c, 200, m)
  })

  // 模型推理强度预设（强制覆盖语义）：{"reasoningEffort": "high"} 配上就听模型的，
  // 客户端传什么档位都会被替换；空串 = 清掉预设，回到跟随客户端透传。
  // 取值按上游文档填（各家档位名不通用，网关原样透传不校验，只限长防填错）。
  app.put('/admin/api/providers/:pid/models/:model/reasoning-effort', async (c) => {
    const raw = c.req.param('pid')
    const pid = parsePid(raw)
    const modelID = c.req.param('model')
    const p = pid === undefined ? undefined : providers.get(pid)
    if (!p) return errRes(c, 404, ERR.NOT_FOUND, `provider #${raw} 不存在`)
    const body = await jsonBody(c)
    if (!isObj(body) || typeof body.reasoningEffort !== 'string') {
      return errRes(c, 400, ERR.INVALID_REQUEST, '请求体须为 {"reasoningEffort": string}（空串 = 清掉预设，跟随客户端）')
    }
    const trimmed = body.reasoningEffort.trim()
    if (trimmed !== '' && sanitizeReasoningEffort(trimmed) === undefined) {
      return errRes(c, 400, ERR.INVALID_REQUEST,
        `reasoningEffort 过长（>${REASONING_EFFORT_MAX_LEN} 字符）：按上游文档填短档位名（如 low / high / max）`)
    }
    const m = p.models.find((x) => x.id === modelID)
    if (!m) return errRes(c, 404, ERR.NOT_FOUND, `provider #${c.req.param('pid')} 下没有模型 ${modelID}`)
    if (trimmed === '') delete m.reasoningEffort
    else m.reasoningEffort = trimmed
    providers.put(p)
    changed()
    return ok(c, 200, m)
  })

  // 模型备注：一句话运维知识（如「23 点后才免费，白天用会扣额度」）。
  // 空串 = 删掉该字段，不留空值。与 displayName 分工不同：那是"叫什么"，这是"要注意什么"。
  app.put('/admin/api/providers/:pid/models/:model/note', async (c) => {
    const raw = c.req.param('pid')
    const pid = parsePid(raw)
    const modelID = c.req.param('model')
    const p = pid === undefined ? undefined : providers.get(pid)
    if (!p) return errRes(c, 404, ERR.NOT_FOUND, `provider #${raw} 不存在`)
    const body = await jsonBody(c)
    if (!isObj(body) || typeof body.note !== 'string') {
      return errRes(c, 400, ERR.INVALID_REQUEST, '请求体须为 {"note": string}')
    }
    const m = p.models.find((x) => x.id === modelID)
    if (!m) return errRes(c, 404, ERR.NOT_FOUND, `provider #${c.req.param('pid')} 下没有模型 ${modelID}`)
    // 限长：这是一行提示，不是文档（前端也是单行输入）。
    const note = body.note.trim().slice(0, 200)
    if (note === '') delete m.note
    else m.note = note
    providers.put(p)
    changed()
    return ok(c, 200, m)
  })

  // 开关单个模型的启用：对外暴露（/v1/models）、路由匹配、测试候选都以它为准。
  app.put('/admin/api/providers/:pid/models/:model/enabled', async (c) => {
    const raw = c.req.param('pid')
    const pid = parsePid(raw)
    const modelID = c.req.param('model')
    const p = pid === undefined ? undefined : providers.get(pid)
    if (!p) return errRes(c, 404, ERR.NOT_FOUND, `provider #${raw} 不存在`)
    const body = await jsonBody(c)
    if (!isObj(body) || typeof body.enabled !== 'boolean') {
      return errRes(c, 400, ERR.INVALID_REQUEST, '请求体须为 {"enabled": boolean}')
    }
    const m = p.models.find((x) => x.id === modelID)
    if (!m) return errRes(c, 404, ERR.NOT_FOUND, `provider #${c.req.param('pid')} 下没有模型 ${modelID}`)
    m.enabled = body.enabled
    providers.put(p)
    changed()
    return ok(c, 200, m)
  })

  // 删除单个模型：手填错的/上游已下架的，得能摘掉。
  // PATCH models 是「只增不减」，所以删除必须是独立端点（否则手填的模型永远删不掉）。
  app.delete('/admin/api/providers/:pid/models/:model', (c) => {
    const raw = c.req.param('pid')
    const pid = parsePid(raw)
    const modelID = c.req.param('model')
    const p = pid === undefined ? undefined : providers.get(pid)
    if (!p) return errRes(c, 404, ERR.NOT_FOUND, `provider #${raw} 不存在`)
    const i = p.models.findIndex((x) => x.id === modelID)
    if (i < 0) return errRes(c, 404, ERR.NOT_FOUND, `provider #${c.req.param('pid')} 下没有模型 ${modelID}`)
    p.models.splice(i, 1)
    providers.put(p)
    changed()
    return c.body(null, 204)
  })

  // 拉取上游模型目录；listler 报错时 502（前端引导手填）。
  app.get('/admin/api/providers/:pid/models', async (c) => {
    const lister: ProviderModelLister | undefined = deps.lister
    if (!lister) return errRes(c, 501, ERR.API, '模型发现未接线')
    const raw = c.req.param('pid')
    // 不存在 → 404（回显原始串）。以前一律 catch 成 502，把"没有这个 Provider"
    // 和"上游真的挂了"混成同一个状态码，前端只能提示用户去手填模型。
    const p = findProvider(providers, raw)
    if (!p) return errRes(c, 404, ERR.NOT_FOUND, `provider #${raw} 不存在`)
    let list: ModelList
    try {
      list = await lister.listProviderModels(p.providerId)
    } catch (e) {
      return errRes(c, 502, ERR.API, (e as Error).message)
    }
    return ok(c, 200, list)
  })

  // ---- sidecar / projects ----

  if (deps.sidecar) {
    app.route('/admin/api/sidecar', deps.sidecar)
  } else {
    app.get('/admin/api/sidecar', (c) => errRes(c, 501, ERR.API, 'sidecar 管理未接线'))
    app.post('/admin/api/sidecar/:action', (c) => errRes(c, 501, ERR.API, 'sidecar 管理未接线'))
  }

  app.route('/admin/api/projects', deps.projects ?? stub501App('项目管理未接线'))

  return app
}

// 未接线的服务路由组：整组 501（路由与鉴权仍齐）。
function stub501App(message: string): Hono {
  const sub = new Hono()
  sub.all('*', (c) => errRes(c, 501, ERR.API, message))
  return sub
}

// 供子模块共享的装配上下文。
export interface AdminCtx {
  providers: ProviderStore
  accounts: AccountStore
  changed: ChangeNotifier
  discover?: DiscoverSource
  // 模型目录探针：一键导入后自动拉一次真实模型写回目录。
  // 不接也能用（行为退回「目录为空，由用户自己去扫」），接了才让默认路径直接可用。
  lister?: ProviderModelLister
}

export type { Account, Provider }
