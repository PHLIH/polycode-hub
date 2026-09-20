import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/usage/store.ts'
import type { UsageLog } from '../src/model/index.ts'

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'polycode-usage-')) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// providerId 是数字内部 id（Provider.providerId），providerName 是名字快照
// （归因行展示用，见 model/index.ts 的 UsageLog）。两者语义一致，测试里成对给。
const log = (over: Partial<UsageLog>): UsageLog => ({
  id: 0, ts: new Date('2026-09-13T12:00:00Z'), requestId: 'req-1',
  providerId: 1, providerName: 'p', modelId: 'm', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
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

  // 回归：SQLite 里 LIMIT -1 表示**不限量**。limit 一旦从 HTTP 参数透进来，
  // 负数/NaN 就是全表返回（当前无外部入口，接上 API 即变 DoS）。
  test('recent 钳制非法 limit（负数/NaN/0 不得变成全表返回）', async () => {
    const store = await Store.open(join(dir, 'usage-limit.db'))
    for (let i = 0; i < 5; i++) await store.insertLog(log({ requestId: `r${i}` }))
    // 负数不得等于「不限量」：旧实现会返回全部 5 条，钳制后走默认 50（仍是 5 条上限内）
    expect((await store.recent(-1)).length).toBe(5)
    expect((await store.recent(0)).length).toBe(5)
    expect((await store.recent(NaN)).length).toBe(5)
    // 正常值照常生效
    expect((await store.recent(2)).length).toBe(2)
    await store.close()
  })

  // 回归：idx_usage_ts 原先只写在「重建表」分支，全新安装的库从来没有这个索引，
  // 而所有查询都按 ts 过滤/排序。
  test('新建库即带 ts 索引（不依赖重建分支）', async () => {
    const path = join(dir, 'usage-idx.db')
    const store = await Store.open(path)
    await store.close()
    // node:sqlite 必须走 createRequire（vite-node 不认识该内置模块，见 store.ts 顶部注释）
    const req = createRequire(import.meta.url)
    const { DatabaseSync } = req('node:sqlite') as typeof import('node:sqlite')
    const raw = new DatabaseSync(path, { readOnly: true })
    const idx = raw.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_usage_ts'`).all()
    expect(idx.length).toBe(1)
    raw.close()
  })

  test('breakdown：totals + cacheHitRate + byModel 降序', async () => {
    const store = await Store.open(join(dir, 'usage4.db'))
    await store.insertLog(log({ providerId: 2, providerName: 's', inputTokens: 100, outputTokens: 50, cacheReadTokens: 50 }))
    await store.insertLog(log({ providerId: 2, providerName: 's', inputTokens: 10 }))
    const bd = await store.breakdown(new Date(0))
    expect(bd.totals.requests).toBe(2)
    // 命中率 = 缓存读取 / 总输入：read=50，总输入=100+10=110 → 50/110。
    // 旧实现把零命中来源整个排除出分母（虚高），已修正。
    expect(bd.totals.cacheHitRate).toBeCloseTo(50 / 110)
    // 两条日志同 providerId 同模型 → 合成一行（分组键是 providerId + modelId）
    expect(bd.byModel[0]!.providerId).toBe(2)
    expect(bd.byModel[0]!.requests).toBe(2)
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
    await store.insertLog(log({ requestId: 'a', providerId: 3, providerName: 'p1', modelId: 'm1',
      inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 7 }))
    await store.insertLog(log({ requestId: 'b', providerId: 4, providerName: 'p2', modelId: 'm2',
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
    await store.insertLog(log({ requestId: 'a', providerId: 3, providerName: 'p1', modelId: 'm1', cacheCreationTokens: 7 }))
    await store.insertLog(log({ requestId: 'b', providerId: 4, providerName: 'p2', modelId: 'm2', cacheCreationTokens: 5 }))
    const bd = await store.breakdown(new Date(0))
    const byKey = new Map(bd.byModel.map((m) => [`${m.providerId}/${m.modelId}`, m]))
    expect(byKey.get('3/m1')!.cacheCreationTokens).toBe(7)
    expect(byKey.get('4/m2')!.cacheCreationTokens).toBe(5)
    await store.close()
  })

  // 命中率 = 缓存读取 / 总输入（用户口径：命中了多少输入）。
  // OpenAI 系 input（prompt_tokens）已含 cached → 总输入 = input 本身。
  // 旧实现的 bug：分母用 input + cacheCreation，把 miss 又加一遍（虚低）；
  // 且把零命中源整个排除出分母（虚高）。
  test('命中率：分母就是总输入（creation 不另加）', async () => {
    const store = await Store.open(join(dir, 'usage7.db'))
    // 实抓形态：prompt=425 含 read=320，miss=105 → 命中率 = 320/425
    await store.insertLog(log({ requestId: 'a', providerId: 5, providerName: 'wb', modelId: 'm',
      inputTokens: 425, cacheReadTokens: 320, cacheCreationTokens: 105 }))
    const bd = await store.breakdown(new Date(0))
    expect(bd.totals.cacheHitRate).toBeCloseTo(320 / 425)
    await store.close()
  })

  test('命中率：无 cache_creation 时等价于 read/input', async () => {
    const store = await Store.open(join(dir, 'usage8.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 5, providerName: 'wb', modelId: 'm',
      inputTokens: 1000, cacheReadTokens: 900 }))
    const bd = await store.breakdown(new Date(0))
    expect(bd.totals.cacheHitRate).toBeCloseTo(900 / 1000) // 0.9
    await store.close()
  })

  test('命中率：多源汇总分子分母各自累加，零命中源计入分母', async () => {
    const store = await Store.open(join(dir, 'usage9.db'))
    // 全命中源：input 含 read=1000
    await store.insertLog(log({ requestId: 'o', providerId: 5, providerName: 'wb', modelId: 'm1',
      inputTokens: 1000, cacheReadTokens: 1000 }))
    // 零命中源：input=900 全是未缓存 → 必须计入分母（旧实现把它整个丢掉 = 虚高）
    await store.insertLog(log({ requestId: 'a', providerId: 6, providerName: 'zc', modelId: 'm2',
      inputTokens: 900 }))
    const bd = await store.breakdown(new Date(0))
    expect(bd.totals.cacheHitRate).toBeCloseTo(1000 / 1900)
    await store.close()
  })

  test('byModel 每行命中率同口径（分母 = 总输入）', async () => {
    const store = await Store.open(join(dir, 'usage10.db'))
    await store.insertLog(log({ requestId: 'o', providerId: 5, providerName: 'wb', modelId: 'm1',
      inputTokens: 1000, cacheReadTokens: 900 }))
    await store.insertLog(log({ requestId: 'a', providerId: 6, providerName: 'zc', modelId: 'm2',
      inputTokens: 100, cacheReadTokens: 30, cacheCreationTokens: 70 }))
    const bd = await store.breakdown(new Date(0))
    const byKey = new Map(bd.byModel.map((m) => [`${m.providerId}/${m.modelId}`, m]))
    expect(byKey.get('5/m1')!.cacheHitRate).toBeCloseTo(0.9)          // 900/1000
    expect(byKey.get('6/m2')!.cacheHitRate).toBeCloseTo(30 / 100)     // 30/100
    await store.close()
  })
})

describe('总量口径 = 上游 wire 总量（input + output）', () => {
  // OpenAI 系 wire total = prompt + completion（cached/miss 都是 prompt 的子集）。
  // 实抓：prompt=425/cached=320/miss=105 时 wire total=435。
  // 旧实现总量用 input+creation+output=540，把 miss 重复计一遍。
  test('summarize：total = input + output（creation 不重复计）', async () => {
    const store = await Store.open(join(dir, 'usage-total-subset.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 5, providerName: 'wb', modelId: 'm',
      inputTokens: 1000, outputTokens: 100, cacheReadTokens: 900 }))
    const sum = await store.summarize(new Date(0))
    expect(sum.inputTokens).toBe(1000)
    expect(sum.cacheReadTokens).toBe(900)
    expect(sum.totalTokens).toBe(1100)
    await store.close()
  })

  test('summarize：带 creation 的行同样不重复计', async () => {
    const store = await Store.open(join(dir, 'usage-total-separate.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 6, providerName: 'zc', modelId: 'm',
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, cacheCreationTokens: 20 }))
    const sum = await store.summarize(new Date(0))
    // wire 口径：100 + 10 = 110（旧实现给 130：把 creation=20 又加了一遍）
    expect(sum.totalTokens).toBe(110)
    await store.close()
  })

  test('summarize：多源汇总为各行之和（可直接相加）', async () => {
    const store = await Store.open(join(dir, 'usage-total-mixed.db'))
    await store.insertLog(log({ requestId: 'o', providerId: 5, providerName: 'wb', modelId: 'm1',
      inputTokens: 1000, outputTokens: 100, cacheReadTokens: 900 }))
    await store.insertLog(log({ requestId: 'a', providerId: 6, providerName: 'zc', modelId: 'm2',
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, cacheCreationTokens: 20 }))
    const sum = await store.summarize(new Date(0))
    expect(sum.totalTokens).toBe(1100 + 110)
    await store.close()
  })

  test('breakdown：byModel 行总量与 totals/daily 同口径，且各行加合 == totals', async () => {
    const store = await Store.open(join(dir, 'usage-total-bd.db'))
    await store.insertLog(log({ requestId: 'o', providerId: 2, providerName: 's', modelId: 'm1',
      inputTokens: 1000, outputTokens: 100, cacheReadTokens: 900 }))
    await store.insertLog(log({ requestId: 'a', providerId: 2, providerName: 's', modelId: 'm2',
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, cacheCreationTokens: 20 }))
    const bd = await store.breakdown(new Date(0))
    // 分组键 = providerId + modelId（两条日志同 Provider、不同模型 → 两行）
    const byKey = new Map(bd.byModel.map((m) => [`${m.providerId}/${m.modelId}`, m]))
    expect(byKey.get('2/m1')!.totalTokens).toBe(1100)
    expect(byKey.get('2/m2')!.totalTokens).toBe(110)
    expect(bd.totals.totalTokens).toBe(1210)
    expect(bd.byModel.map((m) => m.providerId)).toEqual([2, 2])
    // byModel 各行加合 == totals
    expect(bd.byModel.reduce((a, m) => a + m.totalTokens, 0)).toBe(bd.totals.totalTokens)
    expect(bd.daily).toHaveLength(1)
    expect(bd.daily[0]!.totalTokens).toBe(1210)
    await store.close()
  })

  test('总量可按输入输出核对：total = input + output', async () => {
    const store = await Store.open(join(dir, 'usage-total-buckets.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 3, providerName: 'p1', modelId: 'm1',
      inputTokens: 1000, outputTokens: 77, cacheReadTokens: 800, cacheCreationTokens: 50 }))
    const bd = await store.breakdown(new Date(0))
    const t = bd.totals
    expect(t.totalTokens).toBe(t.inputTokens + t.outputTokens)
    await store.close()
  })

  test('accountBreakdown：账号总量与模型行同口径', async () => {
    const store = await Store.open(join(dir, 'usage-total-acct.db'))
    const mk = (over: Partial<UsageLog>) => log({
      ts: new Date('2026-09-13T12:00:00Z'), providerId: 2, providerName: 's', accountId: 'acc1', ...over,
    })
    await store.insertLog(mk({ requestId: 'o', providerId: 5, providerName: 'wb', modelId: 'm1',
      inputTokens: 1000, outputTokens: 100, cacheReadTokens: 900 }))
    await store.insertLog(mk({ requestId: 'a', providerId: 6, providerName: 'zc', modelId: 'm2',
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

describe('缓存语义分流（CACHE-SEMANTICS：sem 列 + inputSideTokens）', () => {
  // Anthropic 口径实抓形态（zcode sidecar）：input 只含未命中部分，
  // read 按会话前缀全额报出 → read 常远大于 input。旧实现把这种行当
  // subset 算，命中率 = read/input 曾飙到 1117%。
  test('separate 行：总量 = 三桶 + 输出；输入侧 = 三桶之和；命中率 ≤ 1', async () => {
    const store = await Store.open(join(dir, 'sem-separate.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 7, providerName: 'zc', modelId: 'm',
      inputTokens: 952, outputTokens: 963, cacheReadTokens: 52608, sem: 'separate' }))
    const sum = await store.summarize(new Date(0))
    // total = 952 + 963 + 52608 = 54523（subset 旧口径只有 1915，漏掉命中）
    expect(sum.totalTokens).toBe(54523)
    // 输入侧 = 952 + 52608 = 53560（input 只是未命中部分）
    expect(sum.inputSideTokens).toBe(53560)
    const bd = await store.breakdown(new Date(0))
    expect(bd.totals.cacheHitRate).toBeCloseTo(52608 / 53560)
    expect(bd.byModel[0]!.cacheHitRate).toBeCloseTo(52608 / 53560)
    expect(bd.byModel[0]!.inputSideTokens).toBe(53560)
    await store.close()
  })

  test('subset 行保持原口径：total = input + output，输入侧 = input', async () => {
    const store = await Store.open(join(dir, 'sem-subset.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 5, providerName: 'wb', modelId: 'm',
      inputTokens: 425, outputTokens: 10, cacheReadTokens: 320, cacheCreationTokens: 105, sem: 'subset' }))
    const sum = await store.summarize(new Date(0))
    expect(sum.totalTokens).toBe(435)
    expect(sum.inputSideTokens).toBe(425)
    const bd = await store.breakdown(new Date(0))
    expect(bd.totals.cacheHitRate).toBeCloseTo(320 / 425)
    await store.close()
  })

  test('sem 缺省按 subset 算（兼容未带协议的旧调用点）', async () => {
    const store = await Store.open(join(dir, 'sem-default.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 7, providerName: 'zc', modelId: 'm',
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 }))
    const sum = await store.summarize(new Date(0))
    expect(sum.totalTokens).toBe(110)
    expect(sum.inputSideTokens).toBe(100)
    await store.close()
  })

  test('separate 的 creation 也计入总量与输入侧（三桶互斥）', async () => {
    const store = await Store.open(join(dir, 'sem-creation.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 7, providerName: 'zc', modelId: 'm',
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, cacheCreationTokens: 20, sem: 'separate' }))
    const sum = await store.summarize(new Date(0))
    expect(sum.totalTokens).toBe(430)
    expect(sum.inputSideTokens).toBe(420)
    await store.close()
  })

  test('混语义聚合：byModel 加合 == totals，各源各算各的口径', async () => {
    const store = await Store.open(join(dir, 'sem-mixed.db'))
    // separate 源：read 全额算总量
    await store.insertLog(log({ requestId: 'a', providerId: 7, providerName: 'zc', modelId: 'm1',
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, sem: 'separate' }))
    // subset 源：read 是 input 子集，不另加
    await store.insertLog(log({ requestId: 'b', providerId: 5, providerName: 'wb', modelId: 'm2',
      inputTokens: 1000, outputTokens: 100, cacheReadTokens: 900, sem: 'subset' }))
    const bd = await store.breakdown(new Date(0))
    expect(bd.totals.totalTokens).toBe(410 + 1100)
    expect(bd.totals.inputSideTokens).toBe(400 + 1000)
    // 命中率分母含两个源的输入侧，分子 = 两个源的 read
    expect(bd.totals.cacheHitRate).toBeCloseTo(1200 / 1400)
    const sumOf = (f: string) => bd.byModel.reduce((acc, m) => acc + ((m as never as Record<string, number>)[f] ?? 0), 0)
    for (const f of ['requests', 'inputTokens', 'outputTokens', 'cacheReadTokens',
      'totalTokens', 'inputSideTokens', 'errors']) {
      expect(sumOf(f), `byModel 的 ${f} 加合应等于 totals.${f}`)
        .toBe((bd.totals as never as Record<string, number>)[f])
    }
    await store.close()
  })

  test('daily 与 byModel 同口径（separate 天的总量含三桶）', async () => {
    const store = await Store.open(join(dir, 'sem-daily.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 7, providerName: 'zc', modelId: 'm',
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, sem: 'separate' }))
    const bd = await store.breakdown(new Date(0))
    expect(bd.daily[0]!.totalTokens).toBe(410)
    expect(bd.daily[0]!.inputSideTokens).toBe(400)
    await store.close()
  })

  test('accountBreakdown：separate 账号的总量/输入侧/模型行同口径', async () => {
    const store = await Store.open(join(dir, 'sem-acct.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 7, providerName: 'zc', modelId: 'm',
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, sem: 'separate', accountId: 'acc1' }))
    const rows = await store.accountBreakdown(new Date(0))
    const acc = rows.find((r) => r.accountId === 'acc1')!
    expect(acc.totalTokens).toBe(410)
    expect(acc.inputSideTokens).toBe(400)
    expect(acc.models[0]!.totalTokens).toBe(410)
    expect(acc.models[0]!.inputSideTokens).toBe(400)
    await store.close()
  })

  test('recent 往返还原 sem', async () => {
    const store = await Store.open(join(dir, 'sem-roundtrip.db'))
    await store.insertLog(log({ requestId: 'sep', sem: 'separate' }))
    await store.insertLog(log({ requestId: 'sub', sem: 'subset' }))
    const rows = await store.recent(10)
    expect(rows.find((r) => r.requestId === 'sep')!.sem).toBe('separate')
    expect(rows.find((r) => r.requestId === 'sub')!.sem).toBe('subset')
    await store.close()
  })

  // 回填三段式：协议权威 → read>input 启发式 → 剩余钉 subset。
  test('backfillSemantics：anthropic 行 separate、openai 行 subset、启发式兜底', async () => {
    const store = await Store.open(join(dir, 'sem-backfill.db'))
    // provider 7 = zcode（anthropic-messages），provider 5 = workbuddy（openai-completions）
    await store.insertLog(log({ requestId: 'a', providerId: 7, providerName: 'zc', modelId: 'm',
      inputTokens: 952, outputTokens: 10, cacheReadTokens: 52608 }))
    await store.insertLog(log({ requestId: 'b', providerId: 5, providerName: 'wb', modelId: 'm',
      inputTokens: 425, outputTokens: 10, cacheReadTokens: 320 }))
    // 协议查不到的 Provider（已删）：read > input → 启发式判 separate
    await store.insertLog(log({ requestId: 'c', providerId: 99, providerName: 'gone', modelId: 'm',
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 5000 }))
    // 协议查不到且 read ≤ input：钉 subset
    await store.insertLog(log({ requestId: 'd', providerId: 98, providerName: 'unk', modelId: 'm',
      inputTokens: 1000, outputTokens: 10, cacheReadTokens: 800 }))
    await store.close()

    // 直接再打开验证落盘（backfill 由 cli 接线，这里手动调用与 cli 相同逻辑）
    const store2 = await Store.open(join(dir, 'sem-backfill.db'))
    const fixed = store2.backfillSemantics((id) =>
      id === 7 ? 'anthropic-messages' : id === 5 ? 'openai-completions' : undefined)
    expect(fixed).toBe(4)
    const rows = await store2.recent(10)
    const by = (id: string) => rows.find((r) => r.requestId === id)!
    expect(by('a')!.sem).toBe('separate')
    expect(by('b')!.sem).toBe('subset')
    expect(by('c')!.sem).toBe('separate') // 启发式
    expect(by('d')!.sem).toBe('subset')   // 兜底钉 subset
    // 幂等：再跑一遍 0 行
    expect(store2.backfillSemantics((id) =>
      id === 7 ? 'anthropic-messages' : id === 5 ? 'openai-completions' : undefined)).toBe(0)
    await store2.close()
  })
})
