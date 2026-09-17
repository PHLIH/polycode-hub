// 管理面类型与依赖注入接口（对齐 Go internal/adminapi/api.go 的接口声明）。
// 外部服务（discover/sidecar/projects）以构造参数注入；未注入时端点报 501
// （discover 列表例外：对齐 Go 返回空列表）。

import type { ModelList, ModelProbe, ProbeResult } from '../gateway/probe.ts'
import type { AccountUsage, Breakdown } from '../usage/store.ts'
import type { Provider } from '../model/index.ts'

// ---- 统计（本包自定义形状，与存储层解耦；json 键与 Go adminapi 一致）----

export interface TokenSummary {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  reasoningTokens: number
  totalTokens: number
}

export interface Summary {
  requests: number
  tokens: TokenSummary
  errors: number
}

// StatsSource 提供统计聚合（main 用 usageStatsSource 适配 usage.Store）。
export interface StatsSource {
  // until 缺省/零值 = 无上界（[since, until) 左闭右开，TIME-RANGE-FILTER §3.2）。
  summarize(since: Date, until?: Date): Promise<Summary> | Summary
  // accountId 非空 = 只统计该账号（ACCOUNT-HEALTH：详情页复用 breakdown）。
  breakdown(since: Date, until?: Date, accountId?: string): Promise<Breakdown> | Breakdown
  // 账号维度聚合（ACCOUNT-HEALTH §3.4 列表页）。
  accountBreakdown?(since: Date, until?: Date): Promise<AccountUsage[]> | AccountUsage[]
}

// ---- 依赖注入接口（Go 侧 ProviderProber/ModelLister/... 的 TS 形态）----

// ProviderProber 对指定 Provider 打一次最小真实请求（gateway/probe.ts 的 Probe 实现）。
export interface ProviderProber {
  probeProvider(providerID: number): Promise<ProbeResult> | ProbeResult
}

// ProviderModelLister 拉取上游模型目录；失败 throw（端点转 502）。
export interface ProviderModelLister {
  listProviderModels(providerID: number): Promise<ModelList>
}

// ProviderModelProber 批量实测候选模型哪些真能用。
export interface ProviderModelProber {
  probeModels(providerID: number, models: string[]): Promise<ModelProbe[]> | ModelProbe[]
}

// AccountResetter 清除调度侧账号惩罚（pool/AccountPool 实现）。
export interface AccountResetter {
  resetAccount(id: string): boolean
}

// 账号运行时状态：冷却/连败是池内惩罚，列表页要显示就得现问池子（DB 只存 enabled/disabled）。
export interface AccountRuntimeState {
  status: string // available | cooldown | exhausted | disabled
  fails: number
  cooldownUntil?: Date
}

export interface AccountRuntime {
  runtime(id: string): AccountRuntimeState | undefined
}

// AccountProber 用指定账号的凭据打一次真实请求（gateway/probe.ts 的 Probe 实现）。
export interface AccountProber {
  probeAccount(accountID: string, modelID: string): Promise<ProbeResult> | ProbeResult
}

// ChangeNotifier 存储变更通知（调度热重载用）。
export type ChangeNotifier = () => void

// ---- 本机 harness 发现（JSON 形状与 server/src/discover 的 Finding 一致）----
// 此处只定义管理面消费的数据形状，main 接线时经 DiscoverSourceAdapter 适配。

export type DiscoverStatus = 'ready' | 'expired' | 'missing' | 'unknown' | 'unreachable'

export interface DiscoveredAccount {
  nickname: string
  uid?: string
  type?: string
  alive: boolean
  expiresAt?: string
  tokenPath: string
}

// 一条发现结果（JSON 可序列化，无密钥）。这是全仓唯一定义——发现层产出、
// 管理面消费、前端渲染都指它，避免多份定义悄悄漂移。
export interface Finding {
  key: string // 稳定标识：workbuddy / zcode / opencode-zen
  harness: string // 展示名
  status?: DiscoverStatus // 返回前必被赋值（对齐 Go 的先构建后置状态）
  detail?: string // 脱敏说明（昵称/有效期/模型数）
  actions?: string[] // 下一步指引
  suggestedProvider?: Provider // 采用草稿（无密钥明文）
  // 本机发现的多账号登录态（WorkBuddy 类，脱敏）。客户端切号不删旧文件，
  // 多账号天然共存——发现时一次全部列出。
  suggestedAccounts?: DiscoveredAccount[]
  // 已接管该登录态的 Provider：内部数字 id（前端据此定位/删除那一行）。
  adoptedProviderId?: number
}

// DiscoverSource 提供本机 harness 发现。
export interface DiscoverSource {
  // force=true 绕过缓存（用户显式「重新探测」）。默认走缓存/后台刷新，
  // 因为 zen 的联网验证固有 2~8 秒（上游响应头慢），不能让页面刷新时干等。
  scan(force?: boolean): Finding[] | Promise<Finding[]>
}

export type { ModelList, ModelProbe, ProbeResult }
