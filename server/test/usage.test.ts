import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/usage/store.ts'
import type { UsageLog } from '../src/model/index.ts'

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'polycode-usage-')) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const log = (over: Partial<UsageLog>): UsageLog => ({
  id: 0, ts: new Date('2026-09-13T12:00:00Z'), requestId: 'req-1', sourceId: 's',
  providerId: 'p', modelId: 'm', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  cacheCreationTokens: 0, reasoningTokens: 0, totalTokens: 0, accuracy: 'exact',
  latencyMs: 5, status: 'ok', stream: false, ...over,
})

describe('usage store（schema/总量口径 = 上游 wire 总量）', () => {
  test('写入：单行 total 由求和覆盖（total = input + output）', async () => {
    const store = await Store.open(join(dir, 'usage.db'))
    await store.insertLog(log({
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 5,
      cacheCreationTokens: 3, reasoningTokens: 8, totalTokens: 999, // 会被求和覆盖
    }))
    const sum = await store.summarize(new Date(0))
    expect(sum.requests).toBe(1)
    expect(sum.inputTokens).toBe(10)
    expect(sum.outputTokens).toBe(20)
    expect(sum.cacheReadTokens).toBe(5)
    expect(sum.cacheCreationTokens).toBe(3)
    expect(sum.reasoningTokens).toBe(8)
    // 上游 wire 总量：input(10) + output(20) = 30；reasoning 已含于 output，不重复计；
    // cacheCreation（miss）是 input 的子集，不另加
    expect(sum.totalTokens).toBe(30)
    expect(sum.errors).toBe(0)
    await store.close()
  })

  test('status != ok 计入 errors', async () => {
    const store = await Store.open(join(dir, 'usage2.db'))
    await store.insertLog(log({ requestId: 'r1', status: 'ok' }))
    await store.insertLog(log({ requestId: 'r2', status: 'upstream_error' }))
    const sum = await store.summarize(new Date(0))
    expect(sum.requests).toBe(2)
    expect(sum.errors).toBe(1)
    await store.close()
  })

  test('recent 倒序 + 字段还原', async () => {
    const store = await Store.open(join(dir, 'usage3.db'))
    await store.insertLog(log({ requestId: 'old', stream: true, accountId: 'a1', firstTokenMs: 120 }))
    await store.insertLog(log({ requestId: 'new' }))
    const rows = await store.recent(10)
    expect(rows.map((r) => r.requestId)).toEqual(['new', 'old'])
    const old = rows.find((r) => r.requestId === 'old')!
    expect(old.stream).toBe(true)
    expect(old.accountId).toBe('a1')
    expect(old.firstTokenMs).toBe(120)
    await store.close()
  })

  test('breakdown：totals + cacheHitRate + byModel 降序', async () => {
    const store = await Store.open(join(dir, 'usage4.db'))
    await store.insertLog(log({ providerId: 'big', sourceId: 's', inputTokens: 100, outputTokens: 50, cacheReadTokens: 50 }))
    await store.insertLog(log({ providerId: 'small', sourceId: 's', inputTokens: 10 }))
    const bd = await store.breakdown(new Date(0))
    expect(bd.totals.requests).toBe(2)
    // 命中率 = 缓存读取 / 总输入：read=50，总输入=100+10=110 → 50/110。
    // 旧实现把零命中源整个排除出分母（虚高），已修正。
    expect(bd.totals.cacheHitRate).toBeCloseTo(50 / 110)
    expect(bd.byModel[0]!.providerId).toBe('big')
    expect(bd.byModel[0]!.requests).toBe(1)
    expect(bd.daily.length).toBeGreaterThanOrEqual(1)
    await store.close()
  })

  test('accountId 归一化：\'-\' 按 Provider 级凭据（\'\'）落盘（防复发）', async () => {
    const store = await Store.open(join(dir, 'usage-dash.db'))
    await store.insertLog(log({ requestId: 'dash', accountId: '-' }))
    const rows = await store.recent(10)
    expect(rows.find((r) => r.requestId === 'dash')!.accountId).toBe('')
    await store.close()
  })

  test('自动建父目录', async () => {
    const store = await Store.open(join(dir, 'nested/deeper/usage.db'))
    await store.insertLog(log({}))
    expect((await store.recent(1)).length).toBe(1)
    await store.close()
  })

  // 真实缺陷回归：byModel 的 SELECT 漏了 cache_creation_tokens（totals 有），
  // 导致仪表盘下方表格各模型行「加合不出」顶部卡片，用户无法用列表核对区间合计。
  // 契约：byModel 各字段逐行相加，必须等于 totals 的同一字段。
  test('byModel 各字段加合 == totals（含缓存写入，可核对）', async () => {
    const store = await Store.open(join(dir, 'usage5.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 'p1', modelId: 'm1',
      inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 7 }))
    await store.insertLog(log({ requestId: 'b', providerId: 'p2', modelId: 'm2',
      inputTokens: 200, outputTokens: 30, cacheReadTokens: 20, cacheCreationTokens: 5 }))
    const bd = await store.breakdown(new Date(0))
    const sumOf = (f: string) => bd.byModel.reduce((acc, m) => acc + ((m as never as Record<string, number>)[f] ?? 0), 0)
    for (const f of ['requests', 'inputTokens', 'outputTokens', 'cacheReadTokens',
      'cacheCreationTokens', 'totalTokens', 'errors']) {
      expect(sumOf(f), `byModel 的 ${f} 加合应等于 totals.${f}`)
        .toBe((bd.totals as never as Record<string, number>)[f])
    }
    expect(bd.totals.cacheCreationTokens).toBe(12)
    await store.close()
  })

  test('byModel 缓存字段按模型分别归集', async () => {
    const store = await Store.open(join(dir, 'usage6.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 'p1', modelId: 'm1', cacheCreationTokens: 7 }))
    await store.insertLog(log({ requestId: 'b', providerId: 'p2', modelId: 'm2', cacheCreationTokens: 5 }))
    const bd = await store.breakdown(new Date(0))
    const byKey = new Map(bd.byModel.map((m) => [`${m.providerId}/${m.modelId}`, m]))
    expect(byKey.get('p1/m1')!.cacheCreationTokens).toBe(7)
    expect(byKey.get('p2/m2')!.cacheCreationTokens).toBe(5)
    await store.close()
  })

  // 命中率 = 缓存读取 / 总输入（用户口径：命中了多少输入）。
  // OpenAI 系 input（prompt_tokens）已含 cached → 总输入 = input 本身。
  // 旧实现的 bug：分母用 input + cacheCreation，把 miss 又加一遍（虚低）；
  // 且把零命中源整个排除出分母（虚高）。
  test('命中率：分母就是总输入（creation 不另加）', async () => {
    const store = await Store.open(join(dir, 'usage7.db'))
    // 实抓形态：prompt=425 含 read=320，miss=105 → 命中率 = 320/425
    await store.insertLog(log({ requestId: 'a', providerId: 'wb', modelId: 'm',
      inputTokens: 425, cacheReadTokens: 320, cacheCreationTokens: 105 }))
    const bd = await store.breakdown(new Date(0))
    expect(bd.totals.cacheHitRate).toBeCloseTo(320 / 425)
    await store.close()
  })

  test('命中率：无 cache_creation 时等价于 read/input', async () => {
    const store = await Store.open(join(dir, 'usage8.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 'wb', modelId: 'm',
      inputTokens: 1000, cacheReadTokens: 900 }))
    const bd = await store.breakdown(new Date(0))
    expect(bd.totals.cacheHitRate).toBeCloseTo(900 / 1000) // 0.9
    await store.close()
  })

  test('命中率：多源汇总分子分母各自累加，零命中源计入分母', async () => {
    const store = await Store.open(join(dir, 'usage9.db'))
    // 全命中源：input 含 read=1000
    await store.insertLog(log({ requestId: 'o', providerId: 'wb', modelId: 'm1',
      inputTokens: 1000, cacheReadTokens: 1000 }))
    // 零命中源：input=900 全是未缓存 → 必须计入分母（旧实现把它整个丢掉 = 虚高）
    await store.insertLog(log({ requestId: 'a', providerId: 'zc', modelId: 'm2',
      inputTokens: 900 }))
    const bd = await store.breakdown(new Date(0))
    expect(bd.totals.cacheHitRate).toBeCloseTo(1000 / 1900)
    await store.close()
  })

  test('byModel 每行命中率同口径（分母 = 总输入）', async () => {
    const store = await Store.open(join(dir, 'usage10.db'))
    await store.insertLog(log({ requestId: 'o', providerId: 'wb', modelId: 'm1',
      inputTokens: 1000, cacheReadTokens: 900 }))
    await store.insertLog(log({ requestId: 'a', providerId: 'zc', modelId: 'm2',
      inputTokens: 100, cacheReadTokens: 30, cacheCreationTokens: 70 }))
    const bd = await store.breakdown(new Date(0))
    const byKey = new Map(bd.byModel.map((m) => [`${m.providerId}/${m.modelId}`, m]))
    expect(byKey.get('wb/m1')!.cacheHitRate).toBeCloseTo(0.9)          // 900/1000
    expect(byKey.get('zc/m2')!.cacheHitRate).toBeCloseTo(30 / 100)     // 30/100
    await store.close()
  })
})

describe('总量口径 = 上游 wire 总量（input + output）', () => {
  // OpenAI 系 wire total = prompt + completion（cached/miss 都是 prompt 的子集）。
  // 实抓：prompt=425/cached=320/miss=105 时 wire total=435。
  // 旧实现总量用 input+creation+output=540，把 miss 重复计一遍。
  test('summarize：total = input + output（creation 不重复计）', async () => {
    const store = await Store.open(join(dir, 'usage-total-subset.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 'wb', modelId: 'm',
      inputTokens: 1000, outputTokens: 100, cacheReadTokens: 900 }))
    const sum = await store.summarize(new Date(0))
    expect(sum.inputTokens).toBe(1000)
    expect(sum.cacheReadTokens).toBe(900)
    expect(sum.totalTokens).toBe(1100)
    await store.close()
  })

  test('summarize：带 creation 的行同样不重复计', async () => {
    const store = await Store.open(join(dir, 'usage-total-separate.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 'zc', modelId: 'm',
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, cacheCreationTokens: 20 }))
    const sum = await store.summarize(new Date(0))
    // wire 口径：100 + 10 = 110（旧实现给 130：把 creation=20 又加了一遍）
    expect(sum.totalTokens).toBe(110)
    await store.close()
  })

  test('summarize：多源汇总为各行之和（可直接相加）', async () => {
    const store = await Store.open(join(dir, 'usage-total-mixed.db'))
    await store.insertLog(log({ requestId: 'o', providerId: 'wb', modelId: 'm1',
      inputTokens: 1000, outputTokens: 100, cacheReadTokens: 900 }))
    await store.insertLog(log({ requestId: 'a', providerId: 'zc', modelId: 'm2',
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, cacheCreationTokens: 20 }))
    const sum = await store.summarize(new Date(0))
    expect(sum.totalTokens).toBe(1100 + 110)
    await store.close()
  })

  test('breakdown：byModel 行总量与 totals/daily 同口径，且各行加合 == totals', async () => {
    const store = await Store.open(join(dir, 'usage-total-bd.db'))
    await store.insertLog(log({ requestId: 'o', providerId: 'wb', sourceId: 's', modelId: 'm1',
      inputTokens: 1000, outputTokens: 100, cacheReadTokens: 900 }))
    await store.insertLog(log({ requestId: 'a', providerId: 'zc', sourceId: 's', modelId: 'm2',
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, cacheCreationTokens: 20 }))
    const bd = await store.breakdown(new Date(0))
    const byKey = new Map(bd.byModel.map((m) => [`${m.providerId}/${m.modelId}`, m]))
    expect(byKey.get('wb/m1')!.totalTokens).toBe(1100)
    expect(byKey.get('zc/m2')!.totalTokens).toBe(110)
    expect(bd.totals.totalTokens).toBe(1210)
    expect(bd.byModel[0]!.providerId).toBe('wb')
    // byModel 各行加合 == totals
    expect(bd.byModel.reduce((a, m) => a + m.totalTokens, 0)).toBe(bd.totals.totalTokens)
    expect(bd.daily).toHaveLength(1)
    expect(bd.daily[0]!.totalTokens).toBe(1210)
    await store.close()
  })

  test('总量可按输入输出核对：total = input + output', async () => {
    const store = await Store.open(join(dir, 'usage-total-buckets.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 'p1', modelId: 'm1',
      inputTokens: 1000, outputTokens: 77, cacheReadTokens: 800, cacheCreationTokens: 50 }))
    const bd = await store.breakdown(new Date(0))
    const t = bd.totals
    expect(t.totalTokens).toBe(t.inputTokens + t.outputTokens)
    await store.close()
  })

  test('accountBreakdown：账号总量与模型行同口径', async () => {
    const store = await Store.open(join(dir, 'usage-total-acct.db'))
    const mk = (over: Partial<UsageLog>) => log({
      ts: new Date('2026-09-13T12:00:00Z'), sourceId: 's', accountId: 'acc1', ...over,
    })
    await store.insertLog(mk({ requestId: 'o', providerId: 'wb', modelId: 'm1',
      inputTokens: 1000, outputTokens: 100, cacheReadTokens: 900 }))
    await store.insertLog(mk({ requestId: 'a', providerId: 'zc', modelId: 'm2',
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, cacheCreationTokens: 20 }))
    const rows = await store.accountBreakdown(new Date(0))
    const acc1 = rows.find((r) => r.accountId === 'acc1')!
    expect(acc1.totalTokens).toBe(1210)
    const m1 = acc1.models.find((m) => m.modelId === 'm1')!
    const m2 = acc1.models.find((m) => m.modelId === 'm2')!
    expect(m1.totalTokens).toBe(1100)
    expect(m2.totalTokens).toBe(110)
    await store.close()
  })
})
