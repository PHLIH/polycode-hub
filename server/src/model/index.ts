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

export interface Source {
  id: string
  displayName: string
  enabled: boolean
  priority: number
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
  providerId: string
  displayName?: string
  contextWindow?: number // 0 = 未知（放行 + warn）
  maxOutputTokens?: number
  input?: string[] // ["text"] 或 ["text","image"]
  api?: Protocol // 覆盖 Provider 级 api（空 = 继承）
  egress?: string // 覆盖 Provider 级出口代理（空 = 继承；EGRESS-SPIKE §7 粒度拍板：精确到模型）
  // 备注：一句话运维知识（如「23 点后才免费，白天用会扣额度」）。
  // 与 displayName 分工不同——displayName 是"叫什么"，note 是"要注意什么"。
  note?: string
  manual: boolean
  enabled: boolean
}

export function modelEffAPI(m: Model, providerAPI: Protocol): Protocol {
  return m.api ? m.api : providerAPI
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

export interface Provider {
  id: string
  sourceId: string
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
  enabled: boolean
  priority: number
  streamOnly?: boolean // 上游只支持流式（如 WorkBuddy 对非流式报 11101/404）
  // 出口代理引用（顶层 egresses 定义的 id）；缺省 = 直连（EGRESS-SPIKE 方案 A）。
  egress?: string
  tags?: string[]
  models: Model[]
  probeModel?: string
}

export function providerValidate(p: Provider): string | undefined {
  if (!p.id) return 'provider.id 不能为空'
  if (!validID(p.id)) {
    return `provider.id "${p.id}" 只允许小写字母/数字/连字符（ID 永久不可改，取名一次到位）`
  }
  if (!ACCESS_KINDS.includes(p.accessKind)) {
    return `provider ${p.id}: access_kind "${p.accessKind}" 非法`
  }
  if (!validRisk(p.risk)) return `provider ${p.id}: risk "${p.risk}" 非法`
  if (!p.riskNote && (p.risk === 'medium' || p.risk === 'high')) {
    return `provider ${p.id}: risk=${p.risk} 必须填写 risk_note（UI 必须显示风险说明）`
  }
  if (!STABILITIES.includes(p.stability)) {
    return `provider ${p.id}: stability "${p.stability}" 非法`
  }
  if (p.api && !validProtocol(p.api)) {
    return `provider ${p.id}: api "${p.api}" 非法（空 = 自动探测；可选 anthropic-messages / openai-completions / openai-responses）`
  }
  if (!p.baseUrl) return `provider ${p.id}: base_url 不能为空`
  if (p.dynamicHeaders) {
    if (!p.dynamicHeaders.command) {
      return `provider ${p.id}: dynamic_headers.command 不能为空`
    }
    if (!p.dynamicHeaders.command.startsWith('/')) {
      return `provider ${p.id}: dynamic_headers.command 必须用绝对路径（不走 shell）`
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
  sourceId: string
  displayName?: string
  credential: CredentialRef
  status: AccountStatus
  fails: number
  cooldownUntil?: Date
  lastUsed?: Date
  // 流量权重（同源账号间按权重分配）：缺省/<=0 按 1 处理。
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
  sourceId: string
  providerId: string
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
