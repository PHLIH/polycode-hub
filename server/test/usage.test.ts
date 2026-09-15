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

describe('usage store（schema/总量口径对齐 DSH TokenUsage）', () => {
  test('写入：单行 total 由求和覆盖（DSH 口径 = input + cacheCreation + output）', async () => {
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
    // DSH 口径：billedInput(10+3) + output(20) = 33；reasoning 已含于 output，不重复计
    expect(sum.totalTokens).toBe(33)
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
    // 命中率口径对齐 DSH（2026-09-15）：分母是全部 billed input（三互斥桶之和）。
    // big: input=100 含 read=50 → uncached=50, denom=50+50=100；small: 无缓存，
    // denom=10。合计 = 50/110。旧实现把零命中源整个排除出分母（虚高），已修正。
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

  // 命中率口径（2026-09-15 修正为 DSH 口径）：
  //   DSH TokenUsage 契约（dsh-llm types.d.ts）：三桶【互斥】——inputTokens 只含
  //   未缓存输入，缓存读/写单独计；billed input = 三桶之和。上游把命中折进 prompt
  //   总数的（DeepSeek 系），适配器要【减出去】。
  //   DSH 显示命中率 = cacheRead / billedInput（StatsPills.cacheHitPercent）。
  // 本项目存上游原值（input 含 read），等价分母 = (input-read)+read+write = input+write。
  // 旧实现的 bug：分母漏掉 cache_creation，且把零命中源整个排除出分母（虚高）。
  test('命中率：分母含 cache_creation（分母 = input + write）', async () => {
    const store = await Store.open(join(dir, 'usage7.db'))
    // 上游 prompt_tokens=1000 含 read=900，write=100 → DSH: uncached=100, denom=100+900+100=1100
    await store.insertLog(log({ requestId: 'a', providerId: 'wb', modelId: 'm',
      inputTokens: 1000, cacheReadTokens: 900, cacheCreationTokens: 100 }))
    const bd = await store.breakdown(new Date(0))
    expect(bd.totals.cacheHitRate).toBeCloseTo(900 / 1100)
    await store.close()
  })

  test('命中率：无 cache_creation 时等价于 read/input（不改变历史行为）', async () => {
    const store = await Store.open(join(dir, 'usage8.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 'wb', modelId: 'm',
      inputTokens: 1000, cacheReadTokens: 900 }))
    const bd = await store.breakdown(new Date(0))
    expect(bd.totals.cacheHitRate).toBeCloseTo(900 / 1000) // 0.9
    await store.close()
  })

  test('命中率：多源汇总按 DSH 口径（分子分母各自累加，零命中源计入分母）', async () => {
    const store = await Store.open(join(dir, 'usage9.db'))
    // 全命中源：input 含 read=1000
    await store.insertLog(log({ requestId: 'o', providerId: 'wb', modelId: 'm1',
      inputTokens: 1000, cacheReadTokens: 1000 }))
    // 零命中源：input=900 全是未缓存 → 必须计入分母（旧实现把它整个丢掉 = 虚高）
    await store.insertLog(log({ requestId: 'a', providerId: 'zc', modelId: 'm2',
      inputTokens: 900 }))
    const bd = await store.breakdown(new Date(0))
    // DSH: read=1000, billedInput = (1000-1000)+1000 + 900 = 1900
    expect(bd.totals.cacheHitRate).toBeCloseTo(1000 / 1900)
    await store.close()
  })

  test('byModel 每行命中率同口径（分母 = input + write）', async () => {
    const store = await Store.open(join(dir, 'usage10.db'))
    await store.insertLog(log({ requestId: 'o', providerId: 'wb', modelId: 'm1',
      inputTokens: 1000, cacheReadTokens: 900 }))
    await store.insertLog(log({ requestId: 'a', providerId: 'zc', modelId: 'm2',
      inputTokens: 100, cacheReadTokens: 30, cacheCreationTokens: 70 }))
    const bd = await store.breakdown(new Date(0))
    const byKey = new Map(bd.byModel.map((m) => [`${m.providerId}/${m.modelId}`, m]))
    expect(byKey.get('wb/m1')!.cacheHitRate).toBeCloseTo(0.9)          // 900/1000
    expect(byKey.get('zc/m2')!.cacheHitRate).toBeCloseTo(30 / 170)     // 30/(100+70)
    await store.close()
  })
})

describe('总量口径：对齐 DSH 计费口径（billedInput + output）', () => {
  // DSH 定义（dsh-client-ui-chat UsagePill, client.js:4016）：
  //   total = billedInputTokens + outputTokens
  //   billedInput = uncountedInput + cacheRead + cacheWrite（三互斥桶之和）
  // 本项目 input_tokens 存上游原值（含 read），换算后 billedInput = input + creation，
  // 故 total = input + cacheCreation + output —— 与 provider 语义无关。
  // 旧实现 separate 语义下用 input+output+read+creation，read 被重复计一遍。
  test('summarize：total = input + cacheCreation + output（read 不重复计）', async () => {
    const store = await Store.open(join(dir, 'usage-total-subset.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 'wb', modelId: 'm',
      inputTokens: 1000, outputTokens: 100, cacheReadTokens: 900 }))
    const sum = await store.summarize(new Date(0))
    expect(sum.inputTokens).toBe(1000)
    expect(sum.cacheReadTokens).toBe(900)
    // DSH: uncached=100, read=900, write=0 → billedInput=1000, total=1000+100=1100
    expect(sum.totalTokens).toBe(1100)
    await store.close()
  })

  test('summarize：anthropic 风味行（read > input）同样按 DSH 口径，不重复计 read', async () => {
    const store = await Store.open(join(dir, 'usage-total-separate.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 'zc', modelId: 'm',
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, cacheCreationTokens: 20 }))
    const sum = await store.summarize(new Date(0))
    // DSH: billedInput = input + write = 120, total = 120 + 10 = 130
    // （旧实现给 430：把 read=300 又加了一遍，与 input 内的 read 重复）
    expect(sum.totalTokens).toBe(130)
    await store.close()
  })

  test('summarize：多源汇总为各行之和（口径与语义无关，可直接相加）', async () => {
    const store = await Store.open(join(dir, 'usage-total-mixed.db'))
    await store.insertLog(log({ requestId: 'o', providerId: 'wb', modelId: 'm1',
      inputTokens: 1000, outputTokens: 100, cacheReadTokens: 900 }))
    await store.insertLog(log({ requestId: 'a', providerId: 'zc', modelId: 'm2',
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, cacheCreationTokens: 20 }))
    const sum = await store.summarize(new Date(0))
    expect(sum.totalTokens).toBe(1100 + 130)
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
    expect(byKey.get('zc/m2')!.totalTokens).toBe(130)
    expect(bd.totals.totalTokens).toBe(1230)
    expect(bd.byModel[0]!.providerId).toBe('wb')
    // byModel 各行加合 == totals（DSH 口径下依然可核对）
    expect(bd.byModel.reduce((a, m) => a + m.totalTokens, 0)).toBe(bd.totals.totalTokens)
    expect(bd.daily).toHaveLength(1)
    expect(bd.daily[0]!.totalTokens).toBe(1230)
    await store.close()
  })

  test('总量可按 DSH 四互斥桶核对：uncached + read + write + output', async () => {
    const store = await Store.open(join(dir, 'usage-total-buckets.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 'p1', modelId: 'm1',
      inputTokens: 1000, outputTokens: 77, cacheReadTokens: 800, cacheCreationTokens: 50 }))
    const bd = await store.breakdown(new Date(0))
    const t = bd.totals
    const uncached = t.inputTokens - t.cacheReadTokens
    const billedInput = uncached + t.cacheReadTokens + t.cacheCreationTokens
    expect(billedInput).toBe(t.inputTokens + t.cacheCreationTokens)
    expect(t.totalTokens).toBe(billedInput + t.outputTokens)
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
    expect(acc1.totalTokens).toBe(1230)
    const m1 = acc1.models.find((m) => m.modelId === 'm1')!
    const m2 = acc1.models.find((m) => m.modelId === 'm2')!
    expect(m1.totalTokens).toBe(1100)
    expect(m2.totalTokens).toBe(130)
    await store.close()
  })
})
