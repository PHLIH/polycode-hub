import { describe, expect, test } from 'vitest'
import { Hono } from 'hono'
import { createAdminApi } from '../src/adminapi/api.ts'
import type { StatsSource } from '../src/adminapi/types.ts'
import type { AccountUsage, Breakdown } from '../src/usage/store.ts'

// 打桩 StatsSource：记录收到的区间参数，验证端点解析逻辑
function harness() {
  const calls: { since: Date; until?: Date; accountId?: string }[] = []
  const acctCalls: { since: Date; until?: Date }[] = []
  const stats: StatsSource = {
    summarize: (since, until) => {
      calls.push({ since, until })
      return {
        requests: 1, tokens: {
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
          cacheCreationTokens: 0, reasoningTokens: 0, totalTokens: 0,
        }, errors: 0,
      }
    },
    breakdown: (since, until, accountId) => {
      calls.push({ since, until, accountId })
      return {
        totals: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, totalTokens: 0, errors: 0, cacheHitRate: 0 },
        daily: [], byModel: [],
      } satisfies Breakdown
    },
    accountBreakdown: (since, until) => {
      acctCalls.push({ since, until })
      return [{
        accountId: 'a1', requests: 2, errors: 1, errorRate: 0.5,
        byKind: { quota: 1 }, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        models: [],
      }] satisfies AccountUsage[]
    },
  }
  const app = new Hono()
  app.route('/', createAdminApi({ adminKey: '', stats }))
  return { app, calls, acctCalls }
}

describe('GET /admin/api/breakdown 区间解析（TIME-RANGE-FILTER 步骤 2）', () => {
  test('缺省 = 近 365 天，无上界', async () => {
    const { app, calls } = harness()
    await app.request('/admin/api/breakdown')
    expect(calls[0]!.until).toBeUndefined()
    expect(calls[0]!.accountId).toBe('')
    // days=365 → since ≈ 365 天前
    expect(Date.now() - calls[0]!.since.getTime()).toBeGreaterThan(364 * 86_400_000)
  })

  test('days 档位生效', async () => {
    const { app, calls } = harness()
    await app.request('/admin/api/breakdown?days=7')
    expect(Date.now() - calls[0]!.since.getTime()).toBeGreaterThan(6 * 86_400_000)
    expect(Date.now() - calls[0]!.since.getTime()).toBeLessThan(8 * 86_400_000)
  })

  test('since/until 日期形式（本地日历日：until 含当日 → 次日 00:00）', async () => {
    const { app, calls } = harness()
    await app.request('/admin/api/breakdown?since=2026-09-01&until=2026-09-14')
    expect(calls[0]!.since).toEqual(new Date(2026, 8, 1, 0, 0, 0))
    expect(calls[0]!.until).toEqual(new Date(2026, 8, 15, 0, 0, 0))
  })

  test('since/until 完整时间戳形式按原值', async () => {
    const { app, calls } = harness()
    await app.request('/admin/api/breakdown?since=2026-09-01T08:30:00Z&until=2026-09-14T08:30:00Z')
    expect(calls[0]!.since).toEqual(new Date('2026-09-01T08:30:00Z'))
    expect(calls[0]!.until).toEqual(new Date('2026-09-14T08:30:00Z'))
  })

  test('显式 since 优先于 days；account_id 透传', async () => {
    const { app, calls } = harness()
    await app.request('/admin/api/breakdown?days=7&since=2026-09-01&account_id=zcode-1')
    expect(calls[0]!.since).toEqual(new Date(2026, 8, 1))
    expect(calls[0]!.accountId).toBe('zcode-1')
  })

  test('非法 since 忽略（回落 days 路径），非法 until 忽略', async () => {
    const { app, calls } = harness()
    await app.request('/admin/api/breakdown?since=not-a-date&until=also-bad&days=7')
    expect(calls[0]!.until).toBeUndefined()
    expect(Date.now() - calls[0]!.since.getTime()).toBeGreaterThan(6 * 86_400_000)
  })
})

describe('GET /admin/api/usage/accounts（ACCOUNT-HEALTH §3.5 新端点）', () => {
  test('返回 {accounts:[...]}，区间解析同 breakdown', async () => {
    const { app, acctCalls } = harness()
    const res = await app.request('/admin/api/usage/accounts?days=30')
    expect(res.status).toBe(200)
    const b = await res.json() as { accounts: { accountId: string }[] }
    expect(b.accounts[0]!.accountId).toBe('a1')
    expect(Date.now() - acctCalls[0]!.since.getTime()).toBeGreaterThan(29 * 86_400_000)
  })

  test('stats 未接线 → 501', async () => {
    const app = new Hono()
    app.route('/', createAdminApi({ adminKey: '' }))
    const res = await app.request('/admin/api/usage/accounts')
    expect(res.status).toBe(501)
  })
})
