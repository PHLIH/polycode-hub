import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Store } from '../src/usage/store.ts'
import type { UsageLog } from '../src/model/index.ts'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'polycode-usage2-')) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const log = (over: Partial<UsageLog>): UsageLog => ({
  id: 0, ts: new Date('2026-09-13T12:00:00Z'), requestId: 'req-1', sourceId: 's',
  providerId: 'p', modelId: 'm', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  cacheCreationTokens: 0, reasoningTokens: 0, totalTokens: 0, accuracy: 'exact',
  latencyMs: 5, status: 'ok', stream: false, ...over,
})

describe('errorKind 落库（ACCOUNT-HEALTH 步骤 1–3）', () => {
  test('写入并查回 errorKind；成功路径为空', async () => {
    const store = await Store.open(join(dir, 'err.db'))
    await store.insertLog(log({ requestId: 'ok1', status: 'ok' }))
    await store.insertLog(log({ requestId: 'bad1', status: 'upstream_error', errorKind: 'quota' }))
    await store.insertLog(log({ requestId: 'bad2', status: 'upstream_error', errorKind: 'rate_limit' }))
    const rows = await store.recent(10)
    expect(rows.find((r) => r.requestId === 'bad1')!.errorKind).toBe('quota')
    expect(rows.find((r) => r.requestId === 'ok1')!.errorKind ?? '').toBe('')
    await store.close()
  })

  test('迁移范本：v1 库（无 error_kind 列）打开后加列且数据无损、user_version=2', async () => {
    const path = join(dir, 'legacy.db')
    // 手工造一个 v1 形态的库（模拟 Go 时代产物）
    const raw = new DatabaseSync(path)
    raw.exec(`CREATE TABLE usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, request_id TEXT NOT NULL,
      source_id TEXT NOT NULL, provider_id TEXT NOT NULL, account_id TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0, accuracy TEXT NOT NULL DEFAULT '',
      latency_ms INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT '',
      egress_id TEXT NOT NULL DEFAULT '', node_id TEXT NOT NULL DEFAULT '',
      stream INTEGER NOT NULL DEFAULT 0, first_token_ms INTEGER NOT NULL DEFAULT 0)`)
    raw.prepare('INSERT INTO usage_logs (ts, request_id, source_id, provider_id, model_id, total_tokens, status) VALUES (?,?,?,?,?,?,?)')
      .run(1, 'legacy-1', 's', 'p', 'm', 5, 'ok')
    raw.exec('PRAGMA user_version=1')
    raw.close()

    const store = await Store.open(path)
    const rows = await store.recent(10)
    expect(rows.length).toBe(1)
    expect(rows[0]!.requestId).toBe('legacy-1')
    expect(rows[0]!.errorKind ?? '').toBe('') // 旧行补空串默认值
    // v2 库可继续写入带 errorKind 的记录
    await store.insertLog(log({ requestId: 'new1', errorKind: 'auth' }))
    expect((await store.recent(10)).find((r) => r.requestId === 'new1')!.errorKind).toBe('auth')
    await store.close()

    const after = new DatabaseSync(path)
    expect((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    after.close()
  })

  test('重复打开（已是 v2）不重复迁移', async () => {
    const path = join(dir, 'twice.db')
    await (await Store.open(path)).close()
    const store = await Store.open(path)
    await store.insertLog(log({ requestId: 'x', errorKind: 'network' }))
    expect((await store.recent(1))[0]!.errorKind).toBe('network')
    await store.close()
  })
})

describe('时间区间 [since, until)（TIME-RANGE-FILTER 步骤 1）', () => {
  test('summarize：until 零值 = 至今；有值 = 左闭右开', async () => {
    const store = await Store.open(join(dir, 'until.db'))
    const t1 = new Date('2026-09-10T12:00:00Z')
    const t2 = new Date('2026-09-12T12:00:00Z')
    await store.insertLog(log({ requestId: 'a', ts: t1, status: 'ok' }))
    await store.insertLog(log({ requestId: 'b', ts: t2, status: 'ok' }))
    // 零 until：全量
    expect((await store.summarize(new Date(0))).requests).toBe(2)
    // [0, t2)：只含 a
    expect((await store.summarize(new Date(0), t2)).requests).toBe(1)
    // 左闭右开：until 恰好等于 t2 时刻不含 b 自身
    expect((await store.summarize(t1, t2)).requests).toBe(1)
    expect((await store.summarize(t2, new Date())).requests).toBe(1)
    // 区间内无数据
    const empty = await store.summarize(new Date('2027-01-01'), new Date('2027-02-01'))
    expect(empty.requests).toBe(0)
    await store.close()
  })

  test('breakdown：until 与 accountID 过滤贯穿 totals/daily/byModel', async () => {
    const store = await Store.open(join(dir, 'bd-until.db'))
    await store.insertLog(log({
      requestId: 'a', ts: new Date('2026-09-10T12:00:00Z'), providerId: 'p1', accountId: 'acc1',
      inputTokens: 10, outputTokens: 20, status: 'ok', stream: true, latencyMs: 2000, firstTokenMs: 500,
    }))
    await store.insertLog(log({
      requestId: 'b', ts: new Date('2026-09-12T12:00:00Z'), providerId: 'p2', accountId: 'acc2',
      inputTokens: 5, status: 'ok',
    }))
    const all = await store.breakdown(new Date(0))
    expect(all.totals.requests).toBe(2)
    const upto12 = await store.breakdown(new Date(0), new Date('2026-09-12T12:00:00Z'))
    expect(upto12.totals.requests).toBe(1)
    expect(upto12.byModel.map((m) => m.providerId)).toEqual(['p1'])
    const acc1 = await store.breakdown(new Date(0), undefined, 'acc1')
    expect(acc1.totals.requests).toBe(1)
    expect(acc1.byModel[0]!.providerId).toBe('p1')
    expect((await store.breakdown(new Date(0), undefined, 'nobody')).totals.requests).toBe(0)
    await store.close()
  })
})

describe('TPS 聚合（TPS-METRIC §3.5，P2 口径）', () => {
  test('byModel：ratio-of-averages + sampled 守卫', async () => {
    const store = await Store.open(join(dir, 'tps.db'))
    const mk = (over: Partial<UsageLog>) => log({
      ts: new Date('2026-09-13T12:00:00Z'), providerId: 'p1', sourceId: 's', modelId: 'm1', ...over,
    })
    // 有效样本：成功流式，decode = 2000-500 = 1500ms，输出 300 token
    await store.insertLog(mk({ requestId: 'ok1', status: 'ok', stream: true, latencyMs: 2000, firstTokenMs: 500, outputTokens: 300 }))
    // 有效样本 2：decode 1000ms，输出 100 → 合计 TPS = 400 / 2.5 = 160
    await store.insertLog(mk({ requestId: 'ok2', status: 'ok', stream: true, latencyMs: 1500, firstTokenMs: 500, outputTokens: 100 }))
    // 失败：排除（会把 TPS 拉高）
    await store.insertLog(mk({ requestId: 'fail', status: 'upstream_error', stream: true, latencyMs: 100, firstTokenMs: 50, outputTokens: 999 }))
    // 非流式：排除（P2）
    await store.insertLog(mk({ requestId: 'ns', status: 'ok', stream: false, latencyMs: 800, outputTokens: 999 }))
    // firstTokenMs=0：排除（缺数据不参与）
    await store.insertLog(mk({ requestId: 'noft', status: 'ok', stream: true, latencyMs: 900, firstTokenMs: 0, outputTokens: 999 }))
    // latency <= first_token：排除（防除零）
    await store.insertLog(mk({ requestId: 'neg', status: 'ok', stream: true, latencyMs: 500, firstTokenMs: 500, outputTokens: 999 }))

    const bd = await store.breakdown(new Date(0))
    const row = bd.byModel.find((m) => m.modelId === 'm1')!
    expect(row.sampled).toBe(2)
    expect(row.avgTps).toBeCloseTo(160) // 400 token / 2.5s
    // 文档口径：TTFT 只看 first_token_ms>0（含失败请求的首字延迟，500+500+50+500)/4
    expect(row.avgTtftMs).toBe(387.5)
    await store.close()
  })

  test('byModel：全被守卫排除时 avgTps=null、sampled=0（缺数据不产出 0.0）', async () => {
    const store = await Store.open(join(dir, 'tps-empty.db'))
    await store.insertLog(log({ providerId: 'p1', modelId: 'm1', status: 'ok', stream: false, outputTokens: 100 }))
    const row = (await store.breakdown(new Date(0))).byModel[0]!
    expect(row.sampled).toBe(0)
    expect(row.avgTps).toBeNull()
    expect(row.avgTtftMs).toBeNull()
    await store.close()
  })
})

describe('账号维度聚合（ACCOUNT-HEALTH §3.4）', () => {
  test('accountBreakdown：分组/失败率/ByKind/最近失败/模型拆分；空 account_id 单独成组', async () => {
    const store = await Store.open(join(dir, 'acct.db'))
    const mk = (over: Partial<UsageLog>) => log({
      ts: new Date('2026-09-13T12:00:00Z'), providerId: 'p1', sourceId: 's', modelId: 'm1', ...over,
    })
    // acc1：3 请求 2 失败（quota + rate_limit）
    await store.insertLog(mk({ requestId: 'a1', accountId: 'acc1', status: 'ok', inputTokens: 10, outputTokens: 20, stream: true, latencyMs: 2000, firstTokenMs: 500 }))
    await store.insertLog(mk({ requestId: 'a2', accountId: 'acc1', status: 'upstream_error', errorKind: 'quota', ts: new Date('2026-09-13T10:00:00Z') }))
    await store.insertLog(mk({ requestId: 'a3', accountId: 'acc1', status: 'upstream_error', errorKind: 'rate_limit', ts: new Date('2026-09-13T11:00:00Z') }))
    // acc1 的第二个模型
    await store.insertLog(mk({ requestId: 'a4', accountId: 'acc1', status: 'ok', modelId: 'm2', inputTokens: 1, outputTokens: 2 }))
    // acc2：1 成功
    await store.insertLog(mk({ requestId: 'b1', accountId: 'acc2', status: 'ok', inputTokens: 5, outputTokens: 5 }))
    // Provider 级凭据（无账号）：单独成组，不混入具体账号
    await store.insertLog(mk({ requestId: 'c1', status: 'upstream_error', errorKind: 'network' }))

    const rows = await store.accountBreakdown(new Date(0))
    const acc1 = rows.find((r) => r.accountId === 'acc1')!
    expect(acc1.requests).toBe(4)
    expect(acc1.errors).toBe(2)
    expect(acc1.errorRate).toBeCloseTo(0.5)
    expect(acc1.byKind).toEqual({ quota: 1, rate_limit: 1 })
    expect(acc1.lastErrorKind).toBe('rate_limit') // 更晚的那条
    expect(acc1.lastErrorAt).toEqual(new Date('2026-09-13T11:00:00Z'))
    expect(acc1.inputTokens).toBe(11)
    expect(acc1.outputTokens).toBe(22)
    expect(acc1.models.map((m) => m.modelId).sort()).toEqual(['m1', 'm2'])
    expect(acc1.models.length).toBe(2)
    const acc2 = rows.find((r) => r.accountId === 'acc2')!
    expect(acc2.errors).toBe(0)
    expect(acc2.byKind).toEqual({})
    const bare = rows.find((r) => r.accountId === '')!
    expect(bare.requests).toBe(1)
    expect(bare.byKind).toEqual({ network: 1 })
    await store.close()
  })

  test('accountBreakdown.models：每个模型带 input/output token（账号页明细用）', async () => {
    const store = await Store.open(join(dir, 'acct-tok.db'))
    const mk = (over: Partial<UsageLog>) => log({
      ts: new Date('2026-09-13T12:00:00Z'), providerId: 'p1', sourceId: 's', modelId: 'm1', ...over,
    })
    await store.insertLog(mk({ requestId: 'a1', accountId: 'acc1', status: 'ok', inputTokens: 10, outputTokens: 20 }))
    await store.insertLog(mk({ requestId: 'a2', accountId: 'acc1', status: 'ok', inputTokens: 5, outputTokens: 7 }))
    await store.insertLog(mk({ requestId: 'b1', accountId: 'acc1', status: 'ok', modelId: 'm2', inputTokens: 1, outputTokens: 2 }))
    const rows = await store.accountBreakdown(new Date(0))
    const acc1 = rows.find((r) => r.accountId === 'acc1')!
    const m1 = acc1.models.find((m) => m.modelId === 'm1')!
    expect(m1.requests).toBe(2)
    expect(m1.inputTokens).toBe(15)
    expect(m1.outputTokens).toBe(27)
    expect(m1.totalTokens).toBe(42)
    const m2 = acc1.models.find((m) => m.modelId === 'm2')!
    expect(m2.inputTokens).toBe(1)
    expect(m2.outputTokens).toBe(2)
    await store.close()
  })
})

describe('缓存命中率 = 缓存读取 / 总输入', () => {
  // OpenAI 系 input（prompt_tokens）已含 cached → 总输入 = input 本身。
  test('breakdown.totals：命中率 = read / input（creation 是 input 子集，不另加）', async () => {
    const store = await Store.open(join(dir, 'hit-dsh.db'))
    const mk = (over: Partial<UsageLog>) => log({
      ts: new Date('2026-09-13T12:00:00Z'), providerId: 'p1', sourceId: 's', modelId: 'm1', ...over,
    })
    // 实抓形态：prompt=425 含 read=320，miss=105 → 320/425
    await store.insertLog(mk({ requestId: 'a', status: 'ok', inputTokens: 425, cacheReadTokens: 320, cacheCreationTokens: 105 }))
    const bd = await store.breakdown(new Date(0))
    // 旧口径 read/(input+creation) = 320/530（偏低）
    expect(bd.totals.cacheHitRate).toBeCloseTo(320 / 425, 10)
    await store.close()
  })

  test('byModel：每行命中率同口径（分母 = input）', async () => {
    const store = await Store.open(join(dir, 'hit-dsh-model.db'))
    await store.insertLog(log({
      requestId: 'a', providerId: 'p1', sourceId: 's', modelId: 'm1',
      inputTokens: 1000, cacheReadTokens: 800, cacheCreationTokens: 100, status: 'ok',
    }))
    const bd = await store.breakdown(new Date(0))
    expect(bd.byModel[0]!.cacheHitRate).toBeCloseTo(800 / 1000, 10)
    await store.close()
  })

  test('无 cacheCreation 时恒为 read/input', async () => {
    const store = await Store.open(join(dir, 'hit-equal.db'))
    await store.insertLog(log({
      requestId: 'a', providerId: 'p1', sourceId: 's', modelId: 'm1',
      inputTokens: 1000, cacheReadTokens: 800, status: 'ok',
    }))
    const bd = await store.breakdown(new Date(0))
    expect(bd.totals.cacheHitRate).toBeCloseTo(0.8, 10)
    expect(bd.byModel[0]!.cacheHitRate).toBeCloseTo(0.8, 10)
    await store.close()
  })

  test('输入侧为 0 → null（缺数据不产出 0.0）', async () => {
    const store = await Store.open(join(dir, 'hit-null.db'))
    await store.insertLog(log({ requestId: 'a', providerId: 'p1', sourceId: 's', modelId: 'm1', status: 'upstream_error' }))
    const bd = await store.breakdown(new Date(0))
    expect(bd.byModel[0]!.cacheHitRate ?? null).toBe(null)
    await store.close()
  })

  test('零命中的 provider 计入分母（不稀释不行）', async () => {
    const store = await Store.open(join(dir, 'hit-zero.db'))
    const mk = (over: Partial<UsageLog>) => log({
      ts: new Date('2026-09-13T12:00:00Z'), sourceId: 's', modelId: 'm1', ...over,
    })
    // p1 全命中：read=100, input=100
    await store.insertLog(mk({ requestId: 'a', providerId: 'p1', status: 'ok', inputTokens: 100, cacheReadTokens: 100 }))
    // p2 零命中：input=900（旧实现把它整个丢掉，导致整体虚高）
    await store.insertLog(mk({ requestId: 'b', providerId: 'p2', status: 'ok', inputTokens: 900 }))
    const bd = await store.breakdown(new Date(0))
    expect(bd.totals.cacheHitRate).toBeCloseTo(100 / 1000, 10)
    await store.close()
  })
})
