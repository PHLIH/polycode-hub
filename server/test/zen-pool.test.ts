// 会话池健康管理：轮询游标 + 失败计数时间窗 + 淘汰补位。
//
// 规则（用户拍板，2026-09-18）：
//   · 轮询：每个请求从游标取首打会话并前移，16 个会话均摊，避免池首被打满；
//   · 失败：网络抖动/上游 5xx 在 15s 窗口内累计 3 次 → 淘汰该会话并补新；
//   · 超窗重置：间隔 > 15s 视为新一轮，计数重置为 1；
//   · 配额 429 不计失败（会话没坏，只是窗口满）——分流在 upstream，本文件只测计数。

import { beforeEach, describe, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import {
  recordZenFailure, recordZenSuccess, refillZenPool, resetZenPoolState,
  takeNextZenSession, syncZenPool, zenPoolSnapshot, zenSessionUsable,
  ZEN_FAIL_THRESHOLD, ZEN_FAIL_WINDOW_MS,
} from '../src/router/zen_pool.ts'

const A = 'ses_aaaaaaaa1111bbbb2222'
const B = 'ses_bbbbbbbb3333cccc4444'
const C = 'ses_cccccccc5555dddd6666'
const POOL = [A, B, C]

beforeEach(() => resetZenPoolState())

describe('轮询游标：每个请求从游标取首打会话并前移', () => {
  test('连续调用按池序轮转，不是每次都打池首', () => {
    const seen = [0, 1, 2, 3, 4, 5].map(() => takeNextZenSession(1, POOL))
    expect(seen).toEqual([A, B, C, A, B, C]) // 均摊，池首只占 1/3
  })

  test('池只有 1 个时恒定返回它（行为等同旧版）', () => {
    expect(takeNextZenSession(2, [A])).toBe(A)
    expect(takeNextZenSession(2, [A])).toBe(A)
  })

  test('空池返回 undefined', () => {
    expect(takeNextZenSession(3, [])).toBeUndefined()
  })

  test('不同 Provider 的游标互不干扰', () => {
    expect(takeNextZenSession(10, POOL)).toBe(A)
    expect(takeNextZenSession(10, POOL)).toBe(B)
    expect(takeNextZenSession(11, POOL)).toBe(A) // 另一个 Provider 从头开始
  })
})

describe('失败计数与时间窗淘汰', () => {
  test('15s 窗口内第 3 次失败触发淘汰', () => {
    const t0 = 1_000_000
    expect(recordZenFailure(1, A, t0, POOL)).toBe(false) // 1
    expect(recordZenFailure(1, A, t0 + 1000, POOL)).toBe(false) // 2
    expect(recordZenFailure(1, A, t0 + 2000, POOL)).toBe(true) // 3 → 淘汰
    const snap = zenPoolSnapshot(1)
    expect(snap.evicted).toContain(A)
    expect(snap.active).not.toContain(A)
  })

  test('间隔超过 15s → 计数重置为 1（不淘汰）', () => {
    const t0 = 1_000_000
    recordZenFailure(1, A, t0, POOL)
    recordZenFailure(1, A, t0 + 1000, POOL)
    // 第三发距首失败已超窗：重置为 1，不该淘汰
    expect(recordZenFailure(1, A, t0 + ZEN_FAIL_WINDOW_MS + 1, POOL)).toBe(false)
    expect(zenPoolSnapshot(1).fails[A]).toBe(1)
    expect(zenPoolSnapshot(1).evicted).not.toContain(A)
  })

  test('窗口边界：恰好 15s 内算同一窗口（累计），超过则重置', () => {
    const t0 = 0
    recordZenFailure(1, A, t0, POOL)
    // 恰好 15000ms：now - firstAt = 15000，不大于窗口 → 仍累计
    recordZenFailure(1, A, ZEN_FAIL_WINDOW_MS, POOL)
    expect(zenPoolSnapshot(1).fails[A]).toBe(2)
  })

  test('成功后清掉失败记录（偶发抖动不攒成淘汰）', () => {
    const t0 = 1_000_000
    recordZenFailure(1, A, t0, POOL)
    recordZenFailure(1, A, t0 + 1000, POOL)
    recordZenSuccess(1, A) // 成功一次
    expect(zenPoolSnapshot(1).fails[A]).toBeUndefined()
    // 再失败两次也不该淘汰（计数从 1 重新开始）
    expect(recordZenFailure(1, A, t0 + 2000, POOL)).toBe(false)
    expect(recordZenFailure(1, A, t0 + 3000, POOL)).toBe(false)
    expect(zenPoolSnapshot(1).evicted).not.toContain(A)
  })

  test('阈值常量与规则一致（3 次 / 15s）', () => {
    expect(ZEN_FAIL_THRESHOLD).toBe(3)
    expect(ZEN_FAIL_WINDOW_MS).toBe(15_000)
  })

  test('淘汰后 active 不含它，游标不越界', () => {
    const t0 = 1_000_000
    takeNextZenSession(1, POOL, t0) // 游标 0→1（同一时钟，否则 TTL 判过期当场重纳）
    for (let i = 0; i < 3; i++) recordZenFailure(1, B, t0 + i * 100, POOL)
    const snap = zenPoolSnapshot(1)
    expect(snap.active).toEqual([A, C])
    expect(snap.cursor).toBeLessThan(snap.active.length)
    // 后续轮询只在剩下两个里转
    const next2 = [takeNextZenSession(1, POOL, t0 + 300), takeNextZenSession(1, POOL, t0 + 300)]
    expect(next2.every((s) => s === A || s === C)).toBe(true)
  })
})

describe('淘汰后补位', () => {
  test('从候选里补一个没进过池的，保持池容量', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 3; i++) recordZenFailure(1, A, t0 + i * 100, POOL)
    expect(zenPoolSnapshot(1).active).toEqual([B, C])
    // 同一时钟传 now：淘汰 A 的时刻是 t0+200，TTL 内重纳被拒才是预期
    const added = refillZenPool(1, [A, 'ses_new1', 'ses_new2'], POOL, t0 + 300)
    expect(added).toBe('ses_new1') // 跳过冷却中的 A
    expect(zenPoolSnapshot(1).active).toEqual([B, C, 'ses_new1'])
  })

  test('已淘汰的会话不会被补回来（哪怕它在候选里）', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 3; i++) recordZenFailure(1, A, t0 + i * 100, POOL)
    expect(refillZenPool(1, [A], POOL, t0 + 300)).toBeUndefined() // 唯一候选是刚淘汰的
  })

  test('TTL 到期后可重纳（坏会话冷却够了就放出来）', async () => {
    const { ZEN_EVICT_TTL_MS } = await import('../src/router/zen_pool.ts')
    const t0 = 1_000_000
    for (let i = 0; i < 3; i++) recordZenFailure(1, A, t0 + i * 100, POOL)
    // TTL 到期后 sync：库里还有 A → 重纳回 active
    const s = syncZenPool(1, [A, B, C], t0 + 200 + ZEN_EVICT_TTL_MS)
    expect(s.active).toContain(A)
    expect(zenSessionUsable(1, A, t0 + 200 + ZEN_EVICT_TTL_MS)).toBe(true)
  })

  test('没有可用候选时返回 undefined（只淘汰不补，池缩水）', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 3; i++) recordZenFailure(1, A, t0 + i * 100, POOL)
    expect(refillZenPool(1, [B, C], POOL, t0 + 300)).toBeUndefined() // B/C 已在池里
  })

  test('脏候选被过滤：非法 token/重复/超长截断', async () => {
    const { ZEN_POOL_MAX } = await import('../src/model/index.ts')
    const t0 = 1_000_000
    takeNextZenSession(1, POOL, t0) // 初始化 active
    // 非法 token 与重复跳过，合法的收下
    expect(refillZenPool(1, ['has space!', A, 'ses_good0001'], POOL, t0)).toBe('ses_good0001')
  })
})

describe('与库内池同步', () => {
  test('刷新写入新池：新增的并进来，已有失败记录保留', () => {
    const t0 = 1_000_000
    takeNextZenSession(1, POOL, t0) // 初始化 active=[A,B,C]
    recordZenFailure(1, A, t0, POOL)
    const s = syncZenPool(1, [A, B, C, 'ses_new'], t0)
    expect(s.active).toEqual([A, B, C, 'ses_new'])
    expect(s.fails.get(A)?.count).toBe(1)
  })

  test('TTL 内淘汰的会话即使回到库里也不复活', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 3; i++) recordZenFailure(1, A, t0 + i * 100, POOL)
    const s = syncZenPool(1, [A, B, C], t0 + 300) // 库里还有 A，但冷却中
    expect(s.active).not.toContain(A)
  })
})

describe('协议记忆落盘与缓存清理（外部调用自动记录）', () => {
  test('未知协议自动探测成功后调 onProtocolLearned（真请求，非恒真断言）', async () => {
    // 本地桩：只有 /responses 能用（模拟 zen muse-spark），首候选 completions 必败。
    let server: Server | null = null
    try {
      server = createServer((req, res) => {
        if (req.url?.includes('/responses')) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n')
          res.write('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n')
          res.end()
          return
        }
        res.writeHead(404, { 'Content-Type': 'text/html' })
        res.end('<!DOCTYPE html><html><body>Not Found</body></html>')
      })
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
      const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
      const { Upstream } = await import('../src/router/upstream.ts')
      await import('../src/codec/openaicompletions.ts')
      await import('../src/codec/openairesponses.ts')
      await import('../src/codec/anthropicmessages.ts')
      const learned: { providerId: number; modelId: string; protocol: string }[] = []
      const up = new Upstream({
        credLookup: () => ['', false],
        onProtocolLearned: (providerId, modelId, protocol) =>
          learned.push({ providerId, modelId, protocol }),
      })
      const p = {
        providerId: 77, name: 'learn-probe', displayName: '', accessKind: 'official' as const,
        risk: 'low' as const, stability: 'stable' as const, api: '' as const,
        baseUrl: base, credential: {}, headers: {}, state: 'active' as const,
        priority: 0, models: [],
      }
      const stream = await up.stream(p, {
        model: 'm-new', stream: true,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)
      await stream.cancel().catch(() => {})
      // openai-completions 首试 404 → 换协议 → responses 成功，钩子被调且值正确
      expect(learned).toEqual([{ providerId: 77, modelId: 'm-new', protocol: 'openai-responses' }])
    } finally {
      if (server) await new Promise<void>((r) => server!.close(() => r()))
    }
  })

  test('已知协议（m.api）成功走内存命中回填：DB 无记录也补写', async () => {
    const { autoProtocol, rememberProtocol } = await import('../src/model/index.ts')
    let server: Server | null = null
    try {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n')
        res.write('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n')
        res.end()
      })
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
      const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
      const { Upstream } = await import('../src/router/upstream.ts')
      await import('../src/codec/openairesponses.ts')
      const learned: { providerId: number; modelId: string; protocol: string }[] = []
      const up = new Upstream({
        credLookup: () => ['', false],
        onProtocolLearned: (providerId, modelId, protocol) =>
          learned.push({ providerId, modelId, protocol }),
      })
      // 只记内存（模拟 probe 记住但 DB 还没落）：DB 的 m.api 为空
      rememberProtocol('mem-hit', 'm2', 'openai-responses')
      const p = {
        providerId: 78, name: 'mem-hit', displayName: '', accessKind: 'official' as const,
        risk: 'low' as const, stability: 'stable' as const, api: '' as const,
        baseUrl: base, credential: {}, headers: {}, state: 'active' as const,
        priority: 0, models: [{ id: 'm2', manual: false, enabled: true }],
      }
      // 先确认内存命中确实走了 known 路径（resolveProtocol 读到内存）
      expect(autoProtocol('mem-hit', 'm2')).toBe('openai-responses')
      const stream = await up.stream(p, {
        model: 'm2', stream: true,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)
      await stream.cancel().catch(() => {})
      expect(learned).toEqual([{ providerId: 78, modelId: 'm2', protocol: 'openai-responses' }])
    } finally {
      if (server) await new Promise<void>((r) => server!.close(() => r()))
    }
  })
})
