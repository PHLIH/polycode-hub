// 配置侧数据实体（对齐 Go internal/model/provider.go + account.go 的 JSON 形状）。
// 属性名 = Go json tag，保证 admin API 返回的 JSON 逐字段兼容。

import { readFileSync } from 'node:fs'
import { normalizeReasoningKey, REASONING_FOLLOW, REASONING_LEVELS, validReasoningLevel, validProtocol, type Protocol } from '../ir/index.ts'

// 档位词汇（REASONING_LEVELS / REASONING_FOLLOW）定义在 ir（应用侧也要用），
// 这里再导出给 model 层消费者（admin api / 前端文案），避免两侧 import 口径分裂。
export { REASONING_FOLLOW, REASONING_LEVELS, validReasoningLevel } from '../ir/index.ts'

export type AccessKind = 'official' | 'session-reuse' | 'simulated-login' | 'reverse'

const ACCESS_KINDS: AccessKind[] = ['official', 'session-reuse', 'simulated-login', 'reverse']

// 供管理面 PATCH 复用：合法值只在上面这一处定义，避免校验规则两处漂移。
export function validAccessKind(k: string): k is AccessKind {
  return (ACCESS_KINDS as string[]).includes(k)
}

export type Risk = 'low' | 'medium' | 'high'

const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 }

export function validRisk(r: string): r is Risk {
  return r === 'low' || r === 'medium' || r === 'high'
}

export function riskAllowed(maxRisk: Risk, risk: Risk): boolean {
  return RISK_RANK[risk] <= RISK_RANK[maxRisk]
}

export type Stability = 'stable' | 'beta' | 'experimental'

const STABILITIES: Stability[] = ['stable', 'beta', 'experimental']

// CredentialRef：凭据不落明文，只存环境变量名或密钥文件路径。
// 文件引用的值每次请求现读：改文件即换凭据，进程不重启（热轮换）。
export interface CredentialRef {
  apiKeyEnv?: string
  apiKeyFile?: string
}

// 解析凭据引用：apiKeyFile 优先于 apiKeyEnv（文件热轮换覆盖环境）。
// 返回 [值, 是否成功]：读文件失败 → ['', false]；无凭据声明（公开端点）→ ['', true]。

export function credentialResolve(
  c: CredentialRef,
  lookup: (name: string) => [string, boolean],
): [string, boolean] {
  if (c.apiKeyFile) {
    try {
      return [readFileSync(c.apiKeyFile, 'utf8').trim(), true]
    } catch {
      return ['', false]
    }
  }
  if (!c.apiKeyEnv) return ['', true] // 无凭据（公开端点）
  return lookup(c.apiKeyEnv)
}

export interface DynamicHeadersSpec {
  command: string
  args?: string[]
  timeoutMs?: number // <=0 默认 8000
  // 触发「重铸再打一次」的响应标记（大小写不敏感子串匹配）；
  // 空用默认：3007/captcha/F008/verify（ZCode plan 通道实测）。
  retryOn?: string[]
}

export function dynamicHeadersTimeout(d?: DynamicHeadersSpec): number {
  return !d || !d.timeoutMs || d.timeoutMs <= 0 ? 8000 : d.timeoutMs
}

export interface Model {
  id: string
  displayName?: string
  contextWindow?: number // 0 = 未知（放行 + warn）
  maxOutputTokens?: number
  input?: string[] // ["text"] 或 ["text","image"]
  api?: Protocol // 覆盖 Provider 级 api（空 = 继承）
  egress?: string // 覆盖 Provider 级出口代理（空 = 继承；EGRESS-SPIKE §7 粒度拍板：精确到模型）
  // 推理等级预设：配了就**强制覆盖**客户端透传的档位（不管上级发的什么，都按这里来）；
  // 'follow'（跟随上游）= 不覆盖，客户端（上级）发什么档位就用什么。
  // 空/缺省与 follow 同义。off/none 系 = 强制关闭思考。
  reasoningEffort?: string
  // 按档位的推理预算上限（token 数）：键 = 档位名（小写，xhigh/high/…），
  // 值 = 该档位生效时 maxTokens 的上限。只压不抬——客户端 maxTokens 高于上限时
  // 压到上限，低于或没给值时不动。按「当前生效档位」查键，与 reasoningEffort
  // 预设解耦（预设定了 high，就查 high 的键）。例：{"xhigh": 65536, "high": 32768}。
  reasoningMaxTokens?: Record<string, number>
  // 备注：一句话运维知识（如「23 点后才免费，白天用会扣额度」）。
  // 与 displayName 分工不同——displayName 是"叫什么"，note 是"要注意什么"。
  note?: string
  manual: boolean
  enabled: boolean
}

export function modelEffAPI(m: Model, providerAPI: Protocol): Protocol {
  return m.api ? m.api : providerAPI
}

// 推理预算键长度上限：防把整段配置粘进档位名（档位是短词，正常最长 'minimal'）。
export const REASONING_KEY_MAX_LEN = 32

// 推理等级预设应用到待发请求：
//   · 预设为 follow（跟随上游）或缺省 → 档位原样透传（客户端没带就不凭空注入）；
//   · 预设为具体档位 → 强制覆盖客户端档位，并清掉客户端带的 budget——否则
//     Anthropic 出站优先走旧式 budget，预设会被静默架空。
// 无需覆盖时返回原引用（便于调用方判定「没动过」）。
export function applyReasoningPreset<T extends { reasoningEffort?: string; thinkingBudget?: number }>(
  req: T, m: Model | undefined,
): T {
  const preset = normalizeReasoningKey(m?.reasoningEffort)
  if (preset === undefined || preset === REASONING_FOLLOW) return req
  // 档位相同且 budget 缺省：真·没动过，返回原引用（调用方的 [effort] 日志据此判定）。
  if (normalizeReasoningKey(req.reasoningEffort) === preset && req.thinkingBudget === undefined) return req
  return { ...req, reasoningEffort: preset, thinkingBudget: undefined }
}

// 按档位预算收敛：对象形态，键收小写、值须为正整数（无上限——上游自己有硬顶，
// 用户写多大是自己的判断，超出由上游报错并按事实归因）。空/非法返回 undefined。
export function sanitizeReasoningMaxTokens(v: unknown): Record<string, number> | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, number> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const key = normalizeReasoningKey(k)
    if (key === undefined || key.length > REASONING_KEY_MAX_LEN) return undefined
    if (typeof val !== 'number' || !Number.isSafeInteger(val) || val <= 0) return undefined
    out[key] = val
  }
  return Object.keys(out).length > 0 ? out : undefined
}

// 生效档位的预算上限：档位取自**实际生效**的档位（覆盖后的），键不限定具体档位集合。
// 没配映射 / 键没命中 / 值非法 → undefined（不干预）。
export function reasoningCapFor(effort: string | undefined, m: Model | undefined): number | undefined {
  const eff = normalizeReasoningKey(effort)
  if (eff === undefined) return undefined
  const cap = m?.reasoningMaxTokens?.[eff]
  if (cap === undefined || cap <= 0) return undefined
  return cap
}

// 档位预算上限应用到待发请求（只压不抬）：生效档位在映射里有上限、且客户端给了
// 正值 maxTokens 高于上限时，压到上限；低于上限、没给值、无映射一律原样返回。
export function applyReasoningCap<T extends { reasoningEffort?: string; maxTokens?: number }>(
  req: T, m: Model | undefined,
): T {
  const cap = reasoningCapFor(req.reasoningEffort, m)
  if (cap === undefined) return req
  if (req.maxTokens === undefined || req.maxTokens === 0) return req
  if (req.maxTokens <= cap) return req
  return { ...req, maxTokens: cap }
}

export function supportsImage(m: Model): boolean {
  return (m.input ?? []).includes('image')
}

export interface Capabilities {
  input: string[]
  contextWindow: number
  maxOutputTokens: number
}

// 从上游两种常见声明形态（modalities.input 或 input 数组）组装能力；
// 两者皆空且无 limit 时返回 null。input 只认 text/image，声明超集被收敛。
export function capabilitiesFrom(
  modalities: string[], input: string[], context: number, output: number,
): Capabilities | null {
  const src = modalities.length > 0 ? modalities : input
  const ins: string[] = []
  for (const v of src) {
    const k = v.trim().toLowerCase()
    if (k === 'text') ins.push('text')
    else if (k === 'image' || k === 'vision') ins.push('image')
  }
  if (ins.length === 0 && context <= 0 && output <= 0) return null
  if (ins.length === 0) ins.push('text') // 有 limit 无 input 声明：按文本兜底
  return {
    input: ins,
    contextWindow: context > 0 ? context : 0,
    maxOutputTokens: output > 0 ? output : 0,
  }
}

// Provider 状态三态（一列承担「开关」与「删除」两件事）：
//   active  = 生效，参与路由
//   paused  = 开关关掉，仍占名（随时可能恢复），不参与路由
//   deleted = 已删除，名字释放（可被新建复用），仅用于历史用量归因回溯
export type ProviderState = 'active' | 'paused' | 'deleted'

export const PROVIDER_STATES: ProviderState[] = ['active', 'paused', 'deleted']

export interface Provider {
  // providerId 是内部唯一标识（自增，永不变）：账号归属、用量归因都指向它。
  // 改名只动 name，引用不会断。
  providerId: number
  // name 是对外名：模型 ID 前缀（name/modelId）、账号归属的展示、发现页判重都用它。
  // 可以改；改名后旧名立即失效，但接口会给出明确报错（见 unknownProviderMessage）。
  name: string
  state: ProviderState
  displayName: string
  accessKind: AccessKind
  risk: Risk
  riskNote?: string
  stability: Stability
  api: Protocol // 空 = 自动探测
  baseUrl: string // anthropic-messages 不含 /v1，另两种含
  credential: CredentialRef
  headers?: Record<string, string>
  dynamicHeaders?: DynamicHeadersSpec
  priority: number
  streamOnly?: boolean // 上游只提供流式端点（如 WorkBuddy 对非流式报 11101/404）。
  // 网关内部一律流式打上游、非流式客户端由 forward 收齐拼包（见 proxy.collectStreamResponse），
  // 所以该标记不再阻断非流式客户端，只保留作“该源无原生非流式端点”的声明。
  // 出口代理引用（顶层 egresses 定义的 id）；缺省 = 直连（EGRESS-SPIKE 方案 A）。
  egress?: string
  tags?: string[]
  models: Model[]
  probeModel?: string
}

export function providerValidate(p: Provider): string | undefined {
  if (!p.name) return 'provider.name 不能为空'
  if (!validID(p.name)) {
    return `provider.name "${p.name}" 只允许小写字母/数字/连字符`
  }
  if (!PROVIDER_STATES.includes(p.state)) {
    return `provider ${p.name}: state "${p.state}" 非法（active | paused | deleted）`
  }
  if (!ACCESS_KINDS.includes(p.accessKind)) {
    return `provider ${p.name}: access_kind "${p.accessKind}" 非法`
  }
  if (!validRisk(p.risk)) return `provider ${p.name}: risk "${p.risk}" 非法`
  if (!p.riskNote && (p.risk === 'medium' || p.risk === 'high')) {
    return `provider ${p.name}: risk=${p.risk} 必须填写 risk_note（UI 必须显示风险说明）`
  }
  if (!STABILITIES.includes(p.stability)) {
    return `provider ${p.name}: stability "${p.stability}" 非法`
  }
  if (p.api && !validProtocol(p.api)) {
    return `provider ${p.name}: api "${p.api}" 非法（空 = 自动探测；可选 anthropic-messages / openai-completions / openai-responses）`
  }
  if (!p.baseUrl) return `provider ${p.name}: base_url 不能为空`
  for (const m of p.models ?? []) {
    if (m.reasoningEffort !== undefined && m.reasoningEffort.trim() !== '' && !validReasoningLevel(m.reasoningEffort)) {
      return `provider ${p.name} 模型 ${m.id}: reasoning_effort "${m.reasoningEffort}" 非法`
        + `（允许 ${REASONING_LEVELS.join(' / ')}，follow = 跟随上游，留空同义）`
    }
    if (m.reasoningMaxTokens !== undefined && sanitizeReasoningMaxTokens(m.reasoningMaxTokens) === undefined) {
      return `provider ${p.name} 模型 ${m.id}: reasoning_max_tokens 非法`
        + `（须为 {"档位": 正整数预算}，如 {"xhigh": 65536}）`
    }
  }
  if (p.dynamicHeaders) {
    if (!p.dynamicHeaders.command) {
      return `provider ${p.name}: dynamic_headers.command 不能为空`
    }
    if (!p.dynamicHeaders.command.startsWith('/')) {
      return `provider ${p.name}: dynamic_headers.command 必须用绝对路径（不走 shell）`
    }
  }
  return undefined
}

function validID(s: string): boolean {
  if (!s) return false
  return /^[a-z0-9-]+$/.test(s)
}

// ---- 账号池成员 ----

export type AccountStatus = 'available' | 'cooldown' | 'exhausted' | 'disabled'

export interface Account {
  id: string
  // 归属的 Provider（值是 Provider.providerId，数字，永不变）。
  // 同一个 Provider 下挂多个账号 = 该上游多份凭据轮换（如 WorkBuddy 三个号）。
  // 指向数字 id 而非名字：Provider 改名后账号归属自动跟着走，不用迁移。
  providerId: number
  displayName?: string
  // 该账号由哪个 harness 的登录态导入而来（workbuddy / zcode / opencode-zen…）。
  // 放宽为 string：除 workbuddy 外的渠道同样需要它标记来源，
  // 两侧 channel-specific 逻辑（如签到）仍精确认具体值。
  importSource?: string
  // 导出该登录态的 harness 上的账号 UID（跨删除/重建唯一稳定的身份凭据）。
  // 判重必须与 importSource 分区比对：不同渠道的 UID 命名空间不搭界。
  workbuddyUid?: string
  workbuddyTokenHash?: string
  credential: CredentialRef
  status: AccountStatus
  fails: number
  cooldownUntil?: Date
  lastUsed?: Date
  // 流量权重（同 Provider 账号间按权重分配）：缺省/<=0 按 1 处理。
  // 关（disabled）/失效（exhausted/cooldown）时权重自动失效——eligible 只收可用者，
  // 分母是可用者的权重和，不用手动重算。
  weight?: number
}

// 冷却到期自动复位（不回写，读取时判定）。
// exhausted 不在此列：额度用尽不会自己好，只认「重置」或一次成功的测试。
//
// 到期比较必须数值化：cooldownUntil 类型上是 Date，但 JSON round-trip 后
// 可能是 string（持久层 reviveAccountDates 兜不住的旁路构造场景）。裸写
// `now > a.cooldownUntil` 是 Date > string，恒为 false——冷却永不解除
// （扫描实证的真实缺陷：账号限流一次、网关重启后永久停在 cooldown）。
export function accountEffectiveStatus(a: Account, now: Date): AccountStatus {
  const until = a.cooldownUntil
  if (a.status === 'cooldown' && until) {
    const ms = until instanceof Date ? until.getTime() : new Date(until).getTime()
    if (ms > now.getTime()) return a.status
    return 'available'
  }
  return a.status
}

// 账号健康度：给管理面看的语义色（绿=健康、琥珀=连败超阈值、红=不可用）。
// 纯派生，不落盘：来源是 DB 状态 + 池内惩罚（fails/cooldownUntil）。
export type AccountHealth = 'ok' | 'warn' | 'bad'

// 连续失败多少次才从绿转琥珀：免费档上游会间歇 429/503，阈值太低会误报。
export const FAILS_WARN_AT = 3

export function accountHealth(a: Account, now: Date): AccountHealth {
  const st = accountEffectiveStatus(a, now)
  if (st === 'disabled') return 'bad'
  if (st === 'exhausted') return 'bad'
  if (st === 'cooldown') return 'warn'
  return (a.fails ?? 0) >= FAILS_WARN_AT ? 'warn' : 'ok'
}

// ---- 用量记录（缓存命中/写入独立字段，绝不混入 inputTokens）----

export type UsageStatus = 'ok' | 'upstream_error'

export interface UsageLog {
  id: number
  ts: Date
  requestId: string
  // 归因指向 Provider.providerId（数字）。展示时用 providerName 快照回显——
  // 名字是用户的心智单位，删除重建同名不该在归因表里裂成两行。
  providerId: number
  providerName: string
  accountId?: string
  modelId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  reasoningTokens: number
  totalTokens: number
  accuracy: string // exact | estimated | unknown
  latencyMs: number
  status: UsageStatus
  // ErrorKind 记录失败原因（UpstreamError.kind 原值：quota / rate_limit / auth / network…）。
  // 成功时为空。Status 是「结局」，ErrorKind 是「原因」，两者正交不合并。
  errorKind?: string
  egressId?: string
  nodeId?: string
  stream: boolean
  firstTokenMs?: number
  // 缓存语义（CACHE-SEMANTICS）：该行三桶（input/read/creation）的计量关系，
  // 聚合层分流公式的唯一依据。'subset' = OpenAI 系（prompt_tokens 已含 cached
  // 全量）；'separate' = Anthropic 系（input 只算未命中部分，三桶互斥）。
  // 可选，缺省按 subset 处理（历史行由 store.backfillSemantics 回填）。
  sem?: 'subset' | 'separate'
}

// ---- 免费档启发式 ----
// 命名约定是唯一线索：-free 后缀、contributor 档、trial 档。
// 要求「独立词段」以免误伤（freeform 不判为 free）；误判比漏报安全。
const FREE_MARKERS = ['free', 'contributor', 'trial']

export function looksFree(id: string): boolean {
  return id.toLowerCase().split(/[-_./: \t]+/).some((seg) => FREE_MARKERS.includes(seg))
}

export * from './autoproto.ts'

// ---- OpenCode Zen 反代指纹（与真客户端对齐的头集合） ----
//
// 2026-09-18 真机取证（本地日志端点实测官方客户端发出的请求头）：
//   authorization: Bearer public
//   user-agent: opencode/<ver> ai-sdk/provider-utils/<ver> runtime/bun/<ver>
//   x-opencode-client: cli
//   x-opencode-project: global（或该目录的 hex projectID）
//   x-opencode-request: msg_<24位>（一次会话内稳定）
//   x-opencode-session: ses_<…>（本次运行的真实会话）
// 真客户端**不发** x-session-id / x-session-affinity（那是 ai-sdk 给别的上游用的，
// zen 内建通道只认上面四件套）。此前网关把四件套当“毒头”删掉并只发 x-session-*，
// 与真机行为完全相反——上游收紧校验（2026-09 要求 x-opencode-session）后全量 403。
// 这里只定义头名常量与纯函数，取值（会话发现/刷新）由 discover 与 cli 层负责。

export const ZEN_CLIENT_HEADER = 'x-opencode-client'
export const ZEN_PROJECT_HEADER = 'x-opencode-project'
export const ZEN_REQUEST_HEADER = 'x-opencode-request'
export const ZEN_SESSION_HEADER = 'x-opencode-session'
// 会话池头（网关自定义，上游不认识）：本机近期真实用过的全部会话，逗号分隔、新→旧。
// 免费档限流按会话算（2026-09-18 实测），撞 429 时在池内换会话重打；定义放这里供
// discover（写入池）与 router（轮换取用）共用，避免两侧反向依赖。
export const ZEN_SESSION_POOL_HEADER = 'x-polycode-session-pool'
export const ZEN_POOL_MAX = 16

// 内网头：发往上游前必须剥掉（buildHeaders 统一处理）。池是网关内部
// 轮换用的，一次把全部会话明文发给上游既无用又扩散登录态。

export const ZEN_DEFAULT_CLIENT = 'cli'
export const ZEN_DEFAULT_PROJECT = 'global'

// 是否 Zen 上游（与 router/upstream 的判定同口径，此处独立定义以免 model 反向依赖 router）。
export function isZenBaseUrl(baseUrl: string): boolean {
  try {
    const h = new URL(baseUrl).hostname.toLowerCase()
    return h === 'opencode.ai' || h.endsWith('.opencode.ai')
  } catch {
    return false
  }
}

// 是否 WorkBuddy **海外版**上游（www.workbuddy.ai）。
//
// 海外版与国内版（copilot.tencent.com）是两套独立后端，除了认证域不同，
// 请求约束也不同：海外版要求 messages 首条必须是 system prompt，
// 否则回 400 code 11128「first message is not system prompt」；
// 国内版无此要求（2026-09-19 实测双版本交叉验证）。
// 所以这条适配只能按 host 判定，不能对所有 WorkBuddy 上游一刀切。
export function isWorkBuddyAiBaseUrl(baseUrl: string): boolean {
  try {
    const h = new URL(baseUrl).hostname.toLowerCase()
    return h === 'workbuddy.ai' || h.endsWith('.workbuddy.ai')
  } catch {
    return false
  }
}

// 上游 base_url → WorkBuddy 版本。非 WorkBuddy 上游返回 undefined。
//
// 口径与 isWorkBuddyAiBaseUrl 对称：裸域与子域都算（workbuddy.cn 与
// www.workbuddy.cn 是同一套后端，用户两种写法都常见）。此前国内版只认
// *.workbuddy.cn，漏掉裸域，于是 baseUrl 写成 https://workbuddy.cn/v2 时
// 「账号-Provider 版本校验」与「归因头迁移」双双静默失效（两处都靠本函数判版本）。
export function workBuddyRealmOfBaseUrl(baseUrl: string): 'cn' | 'ai' | undefined {
  let h: string
  try {
    h = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return undefined
  }
  if (h === 'workbuddy.ai' || h.endsWith('.workbuddy.ai')) return 'ai'
  if (h === 'workbuddy.cn' || h.endsWith('.workbuddy.cn') || h === 'copilot.tencent.com') return 'cn'
  return undefined
}

// 认证域 / issuer 字符串 → WorkBuddy 版本（**唯一定义**，发现层与账号校验都指这里）。
//
// 按域后缀匹配，同时容得下裸域与完整 issuer URL
// （www.workbuddy.ai 与 https://www.workbuddy.ai/auth/realms/copilot 都命中 ai）。
// 只认已知域，认不出返回 undefined —— **绝不默认成国内版**：
// 默认成 cn 正是把海外版 token 打进腾讯域名、被 APISIX 拦成 HTML 401 的根因。
export function workBuddyRealmOfIssuer(s: string): 'cn' | 'ai' | undefined {
  const v = s.trim().toLowerCase()
  if (v === '') return undefined
  if (v.includes('workbuddy.ai')) return 'ai'
  if (v.includes('workbuddy.cn') || v.includes('copilot.tencent.com')) return 'cn'
  return undefined
}

// JWT 的 iss → WorkBuddy 版本（不验签；解析不出返回 undefined）。
// 账号侧一致性校验用：凭据文件里只有 token，版本要从 issuer 反推。
export function workBuddyRealmOfToken(token: string): 'cn' | 'ai' | undefined {
  const parts = token.split('.')
  if (parts.length < 2 || !parts[1]) return undefined
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { iss?: string }
    return typeof claims.iss === 'string' ? workBuddyRealmOfIssuer(claims.iss) : undefined
  } catch {
    return undefined
  }
}

// 版本的中文名（文案统一出处，避免各处各写一份）。
export function workBuddyRealmLabel(realm: 'cn' | 'ai' | undefined): string {
  return realm === 'ai' ? '海外版' : realm === 'cn' ? '国内版' : '版本未知'
}

// ---- WorkBuddy 官方客户端身份头 ----
//
// ⚠️ 2026-09-19 重大更正（此前的判断是错的，务必读完再改）：
//
// 本模块一度把 X-Product 判成「必须是 WorkBuddy，SaaS 是写错的」，并据此改了
// Provider 草稿、存量行与启动迁移。**那个结论是错的，已回滚。**
//
// 从客户端 app.asar 里挖出的真实逻辑（ProductEndpointHttpInterceptor）：
//
//   if (!config.headers["X-Product"])
//     config.headers.PRODUCT = productManager.getCurrentConfiguration()?.deploymentType
//                              ?? productManager.configuration.getValue()?.deploymentType
//                              ?? DeploymentType.SaaS;
//
// 即 **X-Product = deploymentType（部署类型），取值 'SaaS' | 'Cloud-Hosted' |
// 'Self-Hosted'，缺省才是 'SaaS'**。本机实测 deploymentType = "SaaS"
// （客户端日志 [CodeRatioReporter] {"hasConfigization":true,"deploymentType":"SaaS"}）。
// 所以对这个账号，聊天端点正确的 X-Product **就是 SaaS** —— 网关原来的值是对的。
//
// 为什么会判错：签到端点（api.ts 的 daily-checkin）与 banner 端点用的是**硬编码**
// 的 "X-Product": "WorkBuddy"（见 app.asar getActivityBanner）。那是**另一套端点**
// 的身份，与聊天路径不是同一套。把签到头的值套到聊天路径上，属于把两个端点的
// 身份混为一谈。
//
// 结论：**X-Product 不在这里硬编码**。它是账号/部署维度的值，硬编码成任何常量
// （SaaS 或 WorkBuddy）都只对某一类部署成立。网关保持原样（两个头）反而正确。
//
// 那「官方客户端不扣费、网关扣费」的差异到底在哪？**尚未查明。** 已排除：
//   · 端点不同 —— 客户端日志实测同样打 https://www.workbuddy.ai/v2/chat/completions
//   · X-Product 值 —— 客户端的值就是 SaaS，与网关一致
// 未排除：请求体形态（客户端 agent=cli 的回合体裁）、TLS/证书指纹、
// 或计费根本与请求形态无关（按 plan 判定，见 14018 → "获取 Credits"）。
// **在拿到客户端真实请求头之前不要再猜。**

// WorkBuddy 客户端版本（辅助端点如 banner/签到用的硬编码身份的一部分）。
// 仅用于需要「模拟辅助端点身份」的场景，**不要**用它构造聊天请求头。
export const WB_CLIENT_VERSION = '5.5.3'

// 辅助端点的硬编码身份头（签到 / banner 一类）。
//
// 只适用于这些端点：它们在客户端里是**手写死值** "X-Product": "WorkBuddy"。
// **聊天/推理端点不要用这个函数** —— 那边的 X-Product 是 deploymentType，
// 见上方说明。
export function wbAuxEndpointIdentityHeaders(uid?: string): Record<string, string> {
  const h: Record<string, string> = {
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': WB_CLIENT_VERSION,
    'X-Product': 'WorkBuddy',
    'User-Agent': `WorkBuddy/${WB_CLIENT_VERSION}`,
  }
  if (uid !== undefined && uid !== '') h['X-User-Id'] = uid
  return h
}

// 大小写不敏感的头查找（fetch 头名不敏感，但这里操作的是普通对象）。
export function findHeaderKey(h: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase()
  for (const k of Object.keys(h)) if (k.toLowerCase() === want) return k
  return undefined
}

// 会话 token 白名单（与 upstream 一致：字母数字/_/-，≤128）。
export function validZenToken(s: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(s)
}

// 解析会话池头 → 会话列表（去重、白名单过滤、保序、限长）。
// 保序：池内顺序 = 使用优先级（队首最优先）。写入方按新鲜度排列。
export function parseZenSessionPool(h: Record<string, string>): string[] {
  const k = findHeaderKey(h, ZEN_SESSION_POOL_HEADER)
  const raw = (k !== undefined ? h[k] : undefined) ?? ''
  const out: string[] = []
  for (const part of raw.split(',')) {
    const s = part.trim()
    if (!validZenToken(s) || out.includes(s)) continue
    out.push(s)
    if (out.length >= ZEN_POOL_MAX) break
  }
  return out
}

// 写会话池头（空列表 = 删掉池头）。
export function writeZenSessionPool(h: Record<string, string>, sessions: string[]): void {
  const k = findHeaderKey(h, ZEN_SESSION_POOL_HEADER)
  const clean = sessions.filter((s) => validZenToken(s)).slice(0, ZEN_POOL_MAX)
  if (clean.length === 0) {
    if (k !== undefined) delete h[k]
    return
  }
  if (k !== undefined) h[k] = clean.join(',')
  else h[ZEN_SESSION_POOL_HEADER] = clean.join(',')
}

// 把指纹会话落实为 x-opencode-* 四件套（纯函数，就地改 h 并返回是否写过）：
//   sessionID 必填（无效则什么都不写）；requestID 缺省时保留静态值（真机一次会话内稳定）。
//   client/project 缺省时保留静态值，都没有才填默认值——显式配置优先，不覆盖运维手填。
//   UA 不在这里动（upstream.sanitizeUA 按 静态 > 透传 > ZEN_UA 另行补位）。
export function zenHeadersWithFingerprint(
  h: Record<string, string>, sessionID: string, requestID?: string,
): boolean {
  const sid = (sessionID ?? '').trim()
  if (!validZenToken(sid)) return false
  const set = (name: string, value: string) => {
    const k = findHeaderKey(h, name)
    if (k !== undefined) h[k] = value
    else h[name] = value
  }
  set(ZEN_SESSION_HEADER, sid)
  const rid = (requestID ?? '').trim()
  if (validZenToken(rid)) set(ZEN_REQUEST_HEADER, rid)
  else if (findHeaderKey(h, ZEN_REQUEST_HEADER) === undefined) {
    // 连静态值都没有：调用方应先铸一个再调（见本文件 mintZenRequestId），
    // 这里不凭空编——缺了就缺了，报 403 时指引会点名。
  }
  if (findHeaderKey(h, ZEN_CLIENT_HEADER) === undefined) h[ZEN_CLIENT_HEADER] = ZEN_DEFAULT_CLIENT
  if (findHeaderKey(h, ZEN_PROJECT_HEADER) === undefined) h[ZEN_PROJECT_HEADER] = ZEN_DEFAULT_PROJECT
  return true
}

const ZEN_REQ_LOWER = '0123456789abcdefghijklmnopqrstuvwxyz'
const ZEN_REQ_MIXED = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

// 现铸一个 x-opencode-request ID。观测形状：msg_ + 前 12 位小写字母数字 +
// 后 12 位混合大小写（如 msg_0b20f9fce001SFZUUtZpYDSXKH）。
// 前缀疑似含时间分量——网关无法复刻其编码，随机填之：
// 若上游只验格式/唯一性则可用；若验时间绑定则与现状（陈旧复用）同样 403，不回归。
export function mintZenRequestId(pick: (chars: string) => string = defaultPick): string {
  let pre = ''
  let suf = ''
  for (let i = 0; i < 12; i++) {
    pre += pick(ZEN_REQ_LOWER)
    suf += pick(ZEN_REQ_MIXED)
  }
  return `msg_${pre}${suf}`
}

function defaultPick(chars: string): string {
  return chars[Math.floor(Math.random() * chars.length)]!
}
