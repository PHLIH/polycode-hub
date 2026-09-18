// 配置侧数据实体（对齐 Go internal/model/provider.go + account.go 的 JSON 形状）。
// 属性名 = Go json tag，保证 admin API 返回的 JSON 逐字段兼容。

import { readFileSync } from 'node:fs'
import { validProtocol, type Protocol } from '../ir/index.ts'

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

// 推理强度预设：网关不做档位白名单——各家上游的档位名不是通用的，
// 网关只负责原样透传，取值的合法性由上游判定：
//   DeepSeek 官方：low / high / max（medium、xhigh 兼容映射为 high）
//   OpenAI：按模型 low / medium / high，GPT-5 系另有 minimal，个别模型有 none、xhigh
//   Anthropic 新式：low / medium / high（max 仅 Opus 系；xhigh 看模型版本）
//   DSH 档位 ID：off / minimal / low / medium / high / xhigh / max
// 另有网关自定义过线上拼写（如 light / extra_high / ultra），白名单会误杀它们。
// 空 = 未设置（跟随客户端透传）；off/none 系 = 强制关闭思考（各出站 codec 自行映射）。
export const REASONING_EFFORT_SUGGESTIONS = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
] as const

// 预设值上限：wire 上就是个短枚举字符串，超长一定是填错了，在入口处拦掉。
export const REASONING_EFFORT_MAX_LEN = 32

// 收敛成可存的值：去首尾空格、非空、限长；原样保留大小写（某些上游大小写敏感）。
// 返回 undefined = 非法（调用方报错，不静默吞）。
export function sanitizeReasoningEffort(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (t === '' || t.length > REASONING_EFFORT_MAX_LEN) return undefined
  return t
}

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
  // 模型级推理强度预设（强制覆盖语义）：配了就听模型的，客户端传什么都被替换；
  // 空 = 未设置，跟随客户端透传。off/none = 强制关闭思考。
  // 取值按上游文档填（各家档位名不通用，见 sanitizeReasoningEffort 注释），网关原样透传。
  reasoningEffort?: string
  // 备注：一句话运维知识（如「23 点后才免费，白天用会扣额度」）。
  // 与 displayName 分工不同——displayName 是"叫什么"，note 是"要注意什么"。
  note?: string
  manual: boolean
  enabled: boolean
}

export function modelEffAPI(m: Model, providerAPI: Protocol): Protocol {
  return m.api ? m.api : providerAPI
}

// 模型预设应用到待发请求（强制覆盖）：有预设就替换客户端档位，同时清掉客户端带的
// budget——否则 Anthropic 出站优先走旧式 budget，预设会被静默架空；无预设原样返回。
export function applyReasoningPreset<T extends { reasoningEffort?: string; thinkingBudget?: number }>(
  req: T, m: Model | undefined,
): T {
  const preset = m?.reasoningEffort?.trim()
  if (!preset) return req
  return { ...req, reasoningEffort: preset, thinkingBudget: undefined }
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
  streamOnly?: boolean // 上游只支持流式（如 WorkBuddy 对非流式报 11101/404）
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
    if (m.reasoningEffort !== undefined && m.reasoningEffort.trim() !== '' && sanitizeReasoningEffort(m.reasoningEffort) === undefined) {
      return `provider ${p.name} 模型 ${m.id}: reasoning_effort 过长（>${REASONING_EFFORT_MAX_LEN} 字符），请按上游文档填短档位名`
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
export function accountEffectiveStatus(a: Account, now: Date): AccountStatus {
  if (a.status === 'cooldown' && a.cooldownUntil && now > a.cooldownUntil) return 'available'
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
