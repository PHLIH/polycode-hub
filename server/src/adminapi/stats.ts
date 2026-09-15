// usage.Store → 管理面 StatsSource 适配（对齐 Go main.go usageStatsAdapter）。

import type { AccountUsage, Breakdown, Store as UsageStore } from '../usage/store.ts'
import type { StatsSource, Summary } from './types.ts'

export function usageStatsSource(store: UsageStore): StatsSource {
  return {
    async summarize(since: Date, until?: Date): Promise<Summary> {
      const s = await store.summarize(since, until)
      return {
        requests: s.requests,
        tokens: {
          inputTokens: s.inputTokens,
          outputTokens: s.outputTokens,
          cacheReadTokens: s.cacheReadTokens,
          cacheCreationTokens: s.cacheCreationTokens,
          reasoningTokens: s.reasoningTokens,
          totalTokens: s.totalTokens,
        },
        errors: s.errors,
      }
    },
    breakdown: (since: Date, until?: Date, accountId?: string): Promise<Breakdown> =>
      store.breakdown(since, until, accountId ?? ''),
    accountBreakdown: (since: Date, until?: Date): Promise<AccountUsage[]> =>
      store.accountBreakdown(since, until),
  }
}
