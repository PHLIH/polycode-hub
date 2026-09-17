// YAML 配置加载与校验（对齐 Go internal/config/config.go）。
// 硬约束：凭据不落明文——严格模式拒绝未知字段（含 jwt/token 等明文凭据字段）。

import { existsSync, readFileSync } from 'node:fs'
import { parse } from 'yaml'
import {
  providerValidate,
  validRisk,
  type Account, type Provider,
} from '../model/index.ts'

// 上游超时默认值。
// 首字节 15s：用户拍板（60s 太长，卡住时宁可快速报错重试）。
// 流中途静默 60s：首字节已出说明链路是通的，模型长思考时会静默一阵，给宽一倍。
export const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 15_000
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000

export interface GatewayConfig {  host: string
  port: number
  adminKey: string
  gatewayKey: string // 为空则不校验 client Bearer
  defaultModel: string
  riskMax: 'low' | 'medium' | 'high'
  precheckContext: boolean // 上下文预检开关，默认关（绝不截断）
  // 上游首字节超时（毫秒）。0/缺省 = 用 defaultFirstByteTimeoutMs。
  // 上游接受连接后不回数据时必须自己掐断，否则客户端永远等下去（不报错也不成功）。
  firstByteTimeoutMs: number
  // 上游流中途静默超时（毫秒）：首字节已出，但之后长时间没有新字节。
  // 比首字节超时宽松——模型思考时本来就会静默一阵。
  streamIdleTimeoutMs: number
}

// 出口代理定义（EGRESS-SPIKE 方案 A）：Provider 引用 id，未引用 = 直连。
// kind 支持 http/https（socks5 需专用 agent，暂不支持；Clash 类混合端口用 http:// 即可）。
export interface Egress {
  id: string
  kind: 'http' | 'https'
  addr: string
}

export interface Config {
  gateway: GatewayConfig
  dataDir: string
  egresses: Egress[]
  providers: Provider[]
  accounts: Account[]
}

// 文件不存在 → 全默认配置（零配置启动：剩下的去前端配）。显式路径不可读仍报错。
export function loadOrDefault(path: string): Config {
  if (!existsSync(path)) return defaults()
  return loadConfig(path)
}

export function loadConfig(path: string): Config {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`读取配置失败: ${(err as Error).message}（可 cp config/apps.example.yaml config/apps.yaml 起步，POLYCODE_CONFIG 可覆盖路径）`)
  }
  const raw_ = parse(raw) as Record<string, unknown> | null
  const top = raw_ ?? {}
  migrateLegacy(top)
  const cfg = fromRaw(top)
  applyDefaults(cfg)
  validate(cfg)
  return cfg
}

// ---- 旧结构自动迁移（e95c1d3 废弃 sources / provider.id / source_id）----
//
// 背景：config/apps.yaml 是 gitignored 本地文件，`git reset --hard` 盖不掉它。
// 老文件（顶层 sources + providers[].id/source_id + accounts[].source_id +
// models[].provider_id）在严格模式下会直接抛 `未知字段 "sources"` 导致进程退出。
// 这里做只增不减的兼容：识别已知的旧字段，原地迁成新形状 + console.warn 提示改文件。
// 真正拼错的字段仍然抛错（防拼错 + 凭据不落明文的硬约束不变）。
// 只做内存迁移，不回写文件（保住用户注释；DB 播种会把迁后的值落库）。
function migrateLegacy(top: Record<string, unknown>): void {
  // 1. 顶层 sources：概念已删除，直接忽略。
  if ('sources' in top) {
    console.warn('配置兼容：顶层 sources 段已废弃（Provider 改用 name 标识），已忽略该段；建议从配置文件手动删除')
    delete top.sources
  }
  const providers = Array.isArray(top.providers)
    ? (top.providers as Record<string, unknown>[])
    : undefined
  // 先收映射表（删 source_id 之前）：老 source 名 -> 旗下 Provider 名。
  // 另收老 provider id -> 新 name（id 改名来的）。
  const sourceToProviders = new Map<string, string[]>()
  const idToName = new Map<string, string>()
  if (providers) {
    for (const p of providers) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue
      const oldId = typeof p.id === 'string' ? p.id : ''
      const curName = typeof p.name === 'string' ? p.name : ''
      if (oldId && !curName) {
        p.name = oldId
        console.warn(`配置兼容：providers[].id "${oldId}" 已改名为 providers[].name，已自动迁移；请改文件`)
        idToName.set(oldId, oldId)
      } else if (oldId && curName && oldId !== curName) {
        console.warn(`配置兼容：provider 同时有 id "${oldId}" 与 name "${curName}"，已采用 name；请删除 id`)
        idToName.set(oldId, curName)
      } else if (oldId) {
        idToName.set(oldId, curName)
      }
      const sid = typeof p.source_id === 'string' ? p.source_id : ''
      if (sid) {
        const key = (typeof p.name === 'string' && p.name) || oldId || sid
        const arr = sourceToProviders.get(sid) ?? []
        arr.push(key)
        sourceToProviders.set(sid, arr)
      }
    }
    // 第二遍：删 source_id、enabled→state、清 models.provider_id。
    for (const p of providers) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue
      const pname = (typeof p.name === 'string' && p.name) || (typeof p.id === 'string' && p.id) || '?'
      if ('source_id' in p) {
        console.warn(`配置兼容：provider ${pname} 的 source_id 已废弃（sources 概念已删除），已忽略；请删除该行`)
        delete p.source_id
      }
      if ('id' in p) delete p.id // 已迁成 name（或与 name 并存时已取 name），不留脏字段
      if ('enabled' in p && !('state' in p)) {
        // 与 adminapi/store.migrateProviders 同口径：enabled===false→paused，其余→active。
        p.state = p.enabled === false ? 'paused' : 'active'
        if (p.enabled === false) {
          console.warn(`配置兼容：provider ${pname} 的 enabled: false 已迁成 state: paused；请改文件`)
        }
        delete p.enabled
      } else if ('enabled' in p) {
        console.warn(`配置兼容：provider ${pname} 同时有 enabled 与 state，已采用 state；请删除 enabled`)
        delete p.enabled
      }
      if (Array.isArray(p.models)) {
        for (const m of p.models as Record<string, unknown>[]) {
          if (!m || typeof m !== 'object' || Array.isArray(m)) continue
          if ('provider_id' in m) {
            // 模型嵌在 Provider 下，反向引用冗余，直接丢掉。只在真删掉时告警，避免新配置每次启动刷屏。
            console.warn(`配置兼容：provider ${pname} 下 models[].provider_id 已废弃（嵌套即归属），已忽略`)
            delete m.provider_id
            break
          }
        }
      }
    }
  }
  // 3. 账号归属：老 accounts[].source_id（源名）→ 新 provider（Provider 名）。
  // 老语义：账号挂在 Source 下；新语义：账号挂在 Provider 下。
  // 解析顺序：① source_id 值直命中 Provider 名（单源单 Provider 最常见，源名常与 Provider 名相同）；
  // ② 老 id→name 改名表；③ 该源旗下的 Provider（唯一则取它，多个取首个并告警）。
  // 都命中不到则留空（下游 cli 会点名该账号不参与轮询，但进程照常启动）。
  const providerNames = new Set<string>()
  if (providers) {
    for (const p of providers) {
      if (p && typeof p === 'object' && !Array.isArray(p) && typeof p.name === 'string') {
        providerNames.add(p.name)
      }
    }
  }
  if (Array.isArray(top.accounts)) {
    for (const a of top.accounts as Record<string, unknown>[]) {
      if (!a || typeof a !== 'object' || Array.isArray(a)) continue
      const aid = (typeof a.id === 'string' && a.id) || '?'
      // provider_id 写成字符串（老手误把名字填进数字字段）：当名字用。
      // 与 adminapi/store.migrateAccounts 同口径（两种旧形态都存的是名字，都要查表换 id）。
      if (typeof a.provider_id === 'string' && !('provider' in a)) {
        console.warn(`配置兼容：账号 ${aid} 的 provider_id 是字符串，已按 Provider 名处理；请改成 provider: ${a.provider_id}`)
        a.provider = a.provider_id
        delete a.provider_id
      }
      if (!('source_id' in a)) continue
      const sid = typeof a.source_id === 'string' ? a.source_id : ''
      delete a.source_id
      if ('provider' in a) {
        console.warn(`配置兼容：账号 ${aid} 同时有 source_id 与 provider，已采用 provider；请删除 source_id`)
        continue
      }
      let resolved = ''
      if (sid && providerNames.has(sid)) resolved = sid
      else if (sid && idToName.has(sid)) resolved = idToName.get(sid)!
      else if (sid && sourceToProviders.has(sid)) {
        const cands = sourceToProviders.get(sid)!
        resolved = cands[0]!
        if (cands.length > 1) {
          console.warn(`配置兼容：账号 ${aid} 的源 "${sid}" 下有 ${cands.length} 个 Provider（${cands.join('、')}），已暂挂到 ${resolved}；请在文件里明确写 provider: <名> 或去管理面调整`)
        } else {
          console.warn(`配置兼容：账号 ${aid} 的 source_id "${sid}" 已迁成 provider: ${resolved}；请改文件`)
        }
      }
      if (resolved) {
        a.provider = resolved
      } else if (sid) {
        console.warn(`配置兼容：账号 ${aid} 的源 "${sid}" 找不到对应 Provider，该账号暂不参与轮询（进程照常启动）；请写 provider: <现有 Provider 名> 或去管理面调整`)
      }
    }
  }
}

// ---- 严格映射：YAML snake_case → camelCase，未知字段报错 ----

type FieldSpec =
  | { kind: 'string' | 'number' | 'boolean' }
  | { kind: 'array'; item: FieldSpec }
  | { kind: 'map' } // 自由键值（provider.headers）
  | { kind: 'object'; spec: Record<string, [string, FieldSpec]> }

// [tsKey, spec]
const CREDENTIAL: Record<string, [string, FieldSpec]> = {
  api_key_env: ['apiKeyEnv', { kind: 'string' }],
  api_key_file: ['apiKeyFile', { kind: 'string' }],
}

const DYNAMIC_HEADERS: Record<string, [string, FieldSpec]> = {
  command: ['command', { kind: 'string' }],
  args: ['args', { kind: 'array', item: { kind: 'string' } }],
  timeout_ms: ['timeoutMs', { kind: 'number' }],
  retry_on: ['retryOn', { kind: 'array', item: { kind: 'string' } }],
}

const MODEL: Record<string, [string, FieldSpec]> = {
  id: ['id', { kind: 'string' }],
  display_name: ['displayName', { kind: 'string' }],
  context_window: ['contextWindow', { kind: 'number' }],
  max_output_tokens: ['maxOutputTokens', { kind: 'number' }],
  input: ['input', { kind: 'array', item: { kind: 'string' } }],
  api: ['api', { kind: 'string' }],
  egress: ['egress', { kind: 'string' }],
  reasoning_effort: ['reasoningEffort', { kind: 'string' }],
  note: ['note', { kind: 'string' }],
  manual: ['manual', { kind: 'boolean' }],
  enabled: ['enabled', { kind: 'boolean' }],
}

const PROVIDER: Record<string, [string, FieldSpec]> = {
  name: ['name', { kind: 'string' }],
  display_name: ['displayName', { kind: 'string' }],
  access_kind: ['accessKind', { kind: 'string' }],
  risk: ['risk', { kind: 'string' }],
  risk_note: ['riskNote', { kind: 'string' }],
  stability: ['stability', { kind: 'string' }],
  // 三态：active / paused / deleted。缺省 active（见 applyDefaults）。
  state: ['state', { kind: 'string' }],
  api: ['api', { kind: 'string' }],
  base_url: ['baseUrl', { kind: 'string' }],
  credential: ['credential', { kind: 'object', spec: CREDENTIAL }],
  headers: ['headers', { kind: 'map' }],
  dynamic_headers: ['dynamicHeaders', { kind: 'object', spec: DYNAMIC_HEADERS }],
  enabled: ['enabled', { kind: 'boolean' }],
  priority: ['priority', { kind: 'number' }],
  stream_only: ['streamOnly', { kind: 'boolean' }],
  tags: ['tags', { kind: 'array', item: { kind: 'string' } }],
  models: ['models', { kind: 'array', item: { kind: 'object', spec: MODEL } }],
  probe_model: ['probeModel', { kind: 'string' }],
  egress: ['egress', { kind: 'string' }],
}

const EGRESS: Record<string, [string, FieldSpec]> = {
  id: ['id', { kind: 'string' }],
  kind: ['kind', { kind: 'string' }],
  addr: ['addr', { kind: 'string' }],
}

const ACCOUNT: Record<string, [string, FieldSpec]> = {
  id: ['id', { kind: 'string' }],
  // 账号挂在哪个 Provider 名下。YAML 里写 Provider 名最直观（内部会解析成数字 id）；
  // 也接受 provider_id 直接给数字。
  provider: ['providerName', { kind: 'string' }],
  provider_id: ['providerId', { kind: 'number' }],
  display_name: ['displayName', { kind: 'string' }],
  credential: ['credential', { kind: 'object', spec: CREDENTIAL }],
  status: ['status', { kind: 'string' }],
  fails: ['fails', { kind: 'number' }],
  cooldown_until: ['cooldownUntil', { kind: 'string' }],
  last_used: ['lastUsed', { kind: 'string' }],
}

const CONFIG: Record<string, [string, FieldSpec]> = {
  gateway: ['gateway', {
    kind: 'object', spec: {
      host: ['host', { kind: 'string' }],
      port: ['port', { kind: 'number' }],
      admin_key: ['adminKey', { kind: 'string' }],
      gateway_key: ['gatewayKey', { kind: 'string' }],
      default_model: ['defaultModel', { kind: 'string' }],
      risk_max: ['riskMax', { kind: 'string' }],
      precheck_context: ['precheckContext', { kind: 'boolean' }],
      first_byte_timeout_ms: ['firstByteTimeoutMs', { kind: 'number' }],
      stream_idle_timeout_ms: ['streamIdleTimeoutMs', { kind: 'number' }],
    },
  }],
  data_dir: ['dataDir', { kind: 'string' }],
  egresses: ['egresses', { kind: 'array', item: { kind: 'object', spec: EGRESS } }],
  providers: ['providers', { kind: 'array', item: { kind: 'object', spec: PROVIDER } }],
  accounts: ['accounts', { kind: 'array', item: { kind: 'object', spec: ACCOUNT } }],
}

function strictMap(raw: Record<string, unknown>, spec: Record<string, [string, FieldSpec]>, path: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    const rule = spec[k]
    if (!rule) {
      throw new Error(`配置解析失败: 未知字段 "${path}${k}"（严格模式：防拼错，也强制凭据不落明文）`)
    }
    const [tsKey, fs] = rule
    out[tsKey] = convert(v, fs, `${path}${k}.`)
  }
  return out
}

// YAML 值 → TS 值的宽松转换：string 接受 number/boolean（转字符串）；
// number 走 Number(v)（非法得 NaN：port 靠范围校验/默认值兜底，其余字段 NaN 会透传，必要时补校验）；
// boolean 走 Boolean(v)。
function convert(v: unknown, fs: FieldSpec, path: string): unknown {
  if (fs.kind === 'map') {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw new Error(`配置解析失败: "${path}" 应为键值映射`)
    }
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = String(val)
    return out
  }
  if (fs.kind === 'array') {
    if (!Array.isArray(v)) throw new Error(`配置解析失败: "${path}" 应为数组`)
    return v.map((item, i) => convert(item, fs.item, `${path}${i}.`))
  }
  if (fs.kind === 'object') {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw new Error(`配置解析失败: "${path}" 应为对象`)
    }
    return strictMap(v as Record<string, unknown>, fs.spec, path)
  }
  if (fs.kind === 'string') {
    if (v !== undefined && v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new Error(`配置解析失败: "${path}" 应为字符串`)
    }
    return v === null || v === undefined ? undefined : String(v)
  }
  if (fs.kind === 'number') return v === undefined || v === null ? undefined : Number(v)
  return v === undefined || v === null ? undefined : Boolean(v) // boolean
}

function fromRaw(raw: Record<string, unknown>): Config {
  const m = strictMap(raw, CONFIG, '')
  const c = m as Partial<Config>
  return {
    gateway: (c.gateway ?? {}) as GatewayConfig,
    dataDir: c.dataDir ?? '',
    egresses: (c.egresses ?? []) as Config['egresses'],
    providers: (c.providers ?? []) as Provider[],
    accounts: (c.accounts ?? []) as Account[],
  }
}

// ---- 默认值 ----

function defaults(): Config {
  const cfg: Config = {
    gateway: {
      host: '127.0.0.1', // 安全模型：默认只监听本机
      port: 3000,
      adminKey: '',
      gatewayKey: '',
      defaultModel: '',
      riskMax: 'high', // 默认不过滤风险
      precheckContext: false,
      // 零配置启动也要有超时守卫——默认值就写在这里，不留 0 让下游去猜。
      firstByteTimeoutMs: DEFAULT_FIRST_BYTE_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    },
    dataDir: 'data',
    egresses: [],
    providers: [],
    accounts: [],
  }
  return cfg
}

function applyDefaults(c: Config): void {
  if (!c.gateway.host) c.gateway.host = '127.0.0.1'
  if (!c.gateway.port) c.gateway.port = 3000
  if (!c.gateway.riskMax) c.gateway.riskMax = 'high'
  if (!c.dataDir) c.dataDir = 'data'
  // Go 零值语义：字符串字段缺省 = 空串（admin_key 空合法，鉴权据此判裸跑模式）
  c.gateway.adminKey ??= ''
  c.gateway.gatewayKey ??= ''
  c.gateway.defaultModel ??= ''
  // 超时守卫：上游挂住时必须自己掐断。0/负数/缺省 → 默认值。
  if (!(c.gateway.firstByteTimeoutMs > 0)) c.gateway.firstByteTimeoutMs = DEFAULT_FIRST_BYTE_TIMEOUT_MS
  if (!(c.gateway.streamIdleTimeoutMs > 0)) c.gateway.streamIdleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS
  for (const p of c.providers) {
    if (!p.stability) p.stability = 'stable'
    // state 缺失时按 active 处理：老配置只有 enabled 概念，语义上就是"生效"。
    if (!p.state) p.state = 'active'
    if (!p.risk) p.risk = 'low'
    if (!p.accessKind) p.accessKind = 'official'
    p.models ??= [] // Go 侧 nil 切片语义等价空目录
    for (const m of p.models) {
      if (!m.input || m.input.length === 0) m.input = ['text'] // 手动添加的模型默认纯文本
      // 推理预设只去首尾空格：大小写原样保留（某些上游大小写敏感），
      // 超长等非法值留给 validate()（providerValidate）点名报错，不在这里静默吞掉。
      if (typeof m.reasoningEffort === 'string' && m.reasoningEffort.trim() !== '') {
        m.reasoningEffort = m.reasoningEffort.trim()
      }
    }
  }
  for (const a of c.accounts) {
    if (!a.status) a.status = 'available'
    // providerId 此刻可能还是 0：YAML 里写的归属是 Provider 名（providerName），
    // 名字→数字 id 的解析必须在 provider 入库、拿到 id 之后（见 cli.ts seed 之后）。
    if (!a.providerId) a.providerId = 0
  }
}

// ---- 跨实体校验（admin_key 为空合法：零配置启动时由 main 随机生成）----

function validate(c: Config): void {
  if (!validRisk(c.gateway.riskMax)) {
    throw new Error(`gateway.risk_max "${c.gateway.riskMax}" 非法（low | medium | high）`)
  }
  // 必须用 Number.isInteger 而不是范围比较：NaN 与任何数比较都是 false，
  // `NaN <= 0` 为 false、`NaN > 65535` 也为 false —— 旧写法让 NaN **同时躲过两边**
  // 一路进 serve({port: NaN})。3.5 这类小数同样能蒙过去。
  if (!Number.isInteger(c.gateway.port) || c.gateway.port <= 0 || c.gateway.port > 65535) {
    throw new Error(`gateway.port ${c.gateway.port} 非法（须为 1-65535 的整数）`)
  }
  const egressIDs = new Set(c.egresses.map((e) => e.id))
  const providers = new Set<string>()
  for (const p of c.providers) {
    if (p.egress && !egressIDs.has(p.egress)) {
      throw new Error(`provider ${p.name} 引用了不存在的 egress "${p.egress}"（需先在顶层 egresses 定义）`)
    }
    for (const m of p.models ?? []) {
      if (m.egress && !egressIDs.has(m.egress)) {
        throw new Error(`provider ${p.name} 模型 ${m.id} 引用了不存在的 egress "${m.egress}"（需先在顶层 egresses 定义）`)
      }
    }
    const err = providerValidate(p)
    if (err) throw new Error(err)
    if (providers.has(p.name)) {
      throw new Error(`provider name "${p.name}" 重复（名字唯一）`)
    }
    providers.add(p.name)
  }
}
