// 管理面类型与依赖注入接口（对齐 Go internal/adminapi/api.go 的接口声明）。
// 外部服务（discover/sidecar/projects）以构造参数注入；未注入时端点报 501
// （discover 列表例外：对齐 Go 返回空列表）。

import type { Hono } from 'hono'
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
  probeProvider(providerID: string): Promise<ProbeResult> | ProbeResult
}

// ProviderModelLister 拉取上游模型目录；失败 throw（端点转 502）。
export interface ProviderModelLister {
  listProviderModels(providerID: string): Promise<ModelList>
}

// ProviderModelProber 批量实测候选模型哪些真能用。
export interface ProviderModelProber {
  probeModels(providerID: string, models: string[]): Promise<ModelProbe[]> | ModelProbe[]
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

// ---- 本机 harness 发现（JSON 形状对齐 Go internal/discover）----
// 注：next/server/src/discover/ 由并行工作实现扫描引擎；此处只定义管理面消费的
// 数据形状（与 Go discover.Finding 的 json tag 一致），main 接线时做适配器。

export type DiscoverStatus = 'ready' | 'expired' | 'missing' | 'unknown' | 'unreachable'

export interface DiscoveredAccount {
  nickname: string
  uid?: string
  type?: string
  alive: boolean
  expiresAt?: string
  tokenPath: string
}

export interface Finding {
  key: string
  harness: string
  status: DiscoverStatus
  detail: string
  actions?: string[]
  suggestedProvider?: Provider
  suggestedAccounts?: DiscoveredAccount[]
  adoptedProviderId?: string
}

// DiscoverSource 提供本机 harness 发现。
export interface DiscoverSource {
  scan(): Finding[] | Promise<Finding[]>
}

// sidecar / projects 端点以 Hono 子应用注入（并行工作各自实现），未注入报 501。
export interface OptionalApps {
  sidecar?: Hono
  projects?: Hono
}

export type { ModelList, ModelProbe, ProbeResult }
