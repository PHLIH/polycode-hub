// 管理面（对齐 Go internal/adminapi）：REST 装置 + 存储 + 统计适配。
export { createAdminApi, type AdminApiDeps, type AdminCtx } from './api.ts'
export {
  MemoryAccountStore, MemoryProviderStore, SQLiteAccountStore, SQLiteProviderStore,
  seedAccountsIfEmpty, seedProvidersIfEmpty,
  type AccountStore, type ProviderStore,
} from './store.ts'
export { usageStatsSource } from './stats.ts'
export { credentialPathOK } from './discover_api.ts'
export type {
  AccountResetter, ChangeNotifier, DiscoverSource, DiscoveredAccount,
  Finding, ModelList, ModelProbe, ProbeResult, ProviderModelLister, ProviderModelProber,
  ProviderProber, StatsSource, Summary, TokenSummary,
} from './types.ts'
