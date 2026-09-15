import { describe, expect, test } from 'vitest'
import { applyGroups, applyGroupsReport, denomOf, mergeRows, rowKey } from '../../web/src/mergeGroups.ts'
import type { MergeRow } from '../../web/src/mergeGroups.ts'

const row = (over: Partial<MergeRow>): MergeRow => ({
  providerId: 'p', sourceId: 's', modelId: 'm', ...over,
})

describe('归因表手动合并（纯函数）', () => {
  test('rowKey：provider/model 组合', () => {
    expect(rowKey({ providerId: 'zen', modelId: 'm' })).toBe('zen/m')
  })

  test('denomOf：按命中率反推分母；率为 0/null 返回 0', () => {
    expect(denomOf({ cacheReadTokens: 90, cacheHitRate: 0.9 })).toBeCloseTo(100)
    expect(denomOf({ cacheReadTokens: 0, cacheHitRate: 0 })).toBe(0)
    expect(denomOf({ cacheReadTokens: 50, cacheHitRate: null })).toBe(0)
  })

  test('mergeRows：zen + zen-auto 合成一行（真实场景）', () => {
    const a = row({ providerId: 'zen', modelId: 'spark', requests: 1694, inputTokens: 100, outputTokens: 10, cacheReadTokens: 90, cacheHitRate: 0.9, totalTokens: 110, avgTps: 100, avgTtftMs: 5000, sampled: 10 })
    const b = row({ providerId: 'zen-auto', modelId: 'spark', requests: 120, inputTokens: 50, outputTokens: 5, cacheReadTokens: 45, cacheHitRate: 0.9, totalTokens: 55, avgTps: 200, avgTtftMs: 3000, sampled: 10 })
    const m = mergeRows([a, b], 'Zen')
    expect(m.providerId).toBe('Zen')
    expect(m.requests).toBe(1814)
    expect(m.inputTokens).toBe(150)
    expect(m.totalTokens).toBe(165)
    // 命中率 = 总命中/总输入 = 135/150 = 0.9
    expect(m.cacheHitRate).toBeCloseTo(0.9)
    // TPS 按 sampled 加权 = (100*10+200*10)/20 = 150
    expect(m.avgTps).toBeCloseTo(150)
    expect(m.avgTtftMs).toBeCloseTo(4000)
    expect(m.sampled).toBe(20)
  })

  test('mergeRows：权重不同的命中率不平均、按总比重算', () => {
    const a = row({ inputTokens: 1000, cacheReadTokens: 900, cacheHitRate: 0.9 })
    const b = row({ inputTokens: 100, cacheReadTokens: 0, cacheHitRate: 0 })
    const m = mergeRows([a, b], 'g')
    expect(m.cacheHitRate).toBeCloseTo(900 / 1100)
  })

  test('mergeRows：无命中率的行按 inputTokens 计入分母', () => {
    const a = row({ inputTokens: 100, cacheReadTokens: 30, cacheHitRate: null })
    const m = mergeRows([a], 'g')
    expect(m.cacheHitRate).toBeCloseTo(0.3)
  })

  test('mergeRows：全无输入 → null（不产出 0.0）', () => {
    const m = mergeRows([row({}), row({})], 'g')
    expect(m.cacheHitRate).toBeNull()
    expect(m.avgTps).toBeNull()
  })

  test('applyGroups：组内合成一行带明细，未分组行原样', () => {
    const rows = [
      row({ providerId: 'zen', modelId: 'spark', inputTokens: 100 }),
      row({ providerId: 'zen-auto', modelId: 'spark', inputTokens: 50 }),
      row({ providerId: 'wb', modelId: 'hy', inputTokens: 10 }),
    ]
    const out = applyGroups(rows, [{ id: 'g1', name: 'Zen', keys: ['zen/spark', 'zen-auto/spark'] }])
    expect(out).toHaveLength(2)
    expect(out[0]!.providerId).toBe('Zen')
    expect(out[0]!.inputTokens).toBe(150)
    expect(out[0]!._members).toHaveLength(2)
    expect(out[1]!.providerId).toBe('wb')
  })

  test('applyGroups：组顺序 = 组内首行位置', () => {
    const rows = [
      row({ providerId: 'wb', modelId: 'hy', inputTokens: 10 }),
      row({ providerId: 'zen', modelId: 'spark', inputTokens: 100 }),
      row({ providerId: 'zen-auto', modelId: 'spark', inputTokens: 50 }),
    ]
    const out = applyGroups(rows, [{ id: 'g1', name: 'Zen', keys: ['zen/spark', 'zen-auto/spark'] }])
    expect(out[0]!.providerId).toBe('wb')
    expect(out[1]!.providerId).toBe('Zen')
  })

  test('applyGroups：空组列表原样返回；单成员组不合成', () => {
    const rows = [row({ providerId: 'a', modelId: 'm' })]
    expect(applyGroups(rows, [])).toHaveLength(1)
    const out = applyGroups(rows, [{ id: 'g1', name: 'G', keys: ['a/m'] }])
    expect(out).toHaveLength(1)
    expect(out[0]!._groupId).toBeUndefined()
  })

  test('applyGroupsReport：成员不足的组上报 unmatched（不静默失败）', () => {
    const rows = [row({ providerId: 'a', modelId: 'm' })]
    const { rows: out, unmatched } = applyGroupsReport(rows, [
      { id: 'g1', name: 'G', keys: ['a/m', 'b/m'] },
      { id: 'g2', name: 'H', keys: ['x/y', 'z/w'] },
    ])
    expect(out).toHaveLength(1)
    expect(unmatched).toContain('g1') // a/m 在，但 b/m 不在 → 合不成
    expect(unmatched).toContain('g2')
  })

  test('applyGroupsReport：正常组不上报', () => {
    const rows = [row({ providerId: 'a', modelId: 'm' }), row({ providerId: 'b', modelId: 'm' })]
    const { unmatched } = applyGroupsReport(rows, [{ id: 'g1', name: 'G', keys: ['a/m', 'b/m'] }])
    expect(unmatched).toHaveLength(0)
  })
})
