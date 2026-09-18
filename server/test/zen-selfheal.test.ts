// Zen 指纹自愈：与真客户端对齐的头集合 + 自动续期 + 长闲置指引。
//
// 背景（2026-09-18 真机取证）：官方客户端向 zen 发送
// User-Agent + Bearer public + x-opencode-client/project/request/session 四件套，
// 不发 x-session-id/affinity；网关旧逻辑恰好相反（删四件套、只发 x-session-*），
// 上游收紧校验后全量 403。本文件锁定新行为与刷新流程。

import { describe, expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import {
  isZenBaseUrl, mintZenRequestId, parseZenSessionPool, zenHeadersWithFingerprint,
} from '../src/model/index.ts'
import { latestSessionMessageId, parseAllFingerprintsFromLog } from '../src/discover/index.ts'
import {
  NO_LOCAL_FINGERPRINT_NEXT, refreshAllZenProviders, refreshZenProvider,
} from '../src/discover/zen_refresh.ts'
import { createAdminApi } from '../src/adminapi/index.ts'
import { MemoryAccountStore, MemoryProviderStore } from '../src/adminapi/store.ts'
import { Proxy } from '../src/gateway/proxy.ts'
import { Scheduler } from '../src/router/scheduler.ts'
import { Upstream, nextZenSession, resetZenPoolCursor, shiftZenSession, shiftZenSessionHeaders } from '../src/router/upstream.ts'
import { UpstreamError, UPSTREAM } from '../src/ir/index.ts'
import type { Config } from '../src/config/index.ts'
import type { Provider } from '../src/model/index.ts'
import '../src/codec/openaicompletions.ts'

describe('isZenBaseUrl', () => {
  test('opencode.ai 及其子域为 zen；其他不是', () => {
    expect(isZenBaseUrl('https://opencode.ai/zen/v1')).toBe(true)
    expect(isZenBaseUrl('https://foo.opencode.ai/v1')).toBe(true)
    expect(isZenBaseUrl('https://api.example.com/v1')).toBe(false)
    expect(isZenBaseUrl('not a url')).toBe(false)
  })
})

describe('zenHeadersWithFingerprint', () => {
  test('写入四件套；显式配置的 client/project 不覆盖', () => {
    const h: Record<string, string> = { 'x-opencode-client': 'mine' }
    expect(zenHeadersWithFingerprint(h, 'ses_abc')).toBe(true)
    expect(h['x-opencode-session']).toBe('ses_abc')
    expect(h['x-opencode-client']).toBe('mine')
    expect(h['x-opencode-project']).toBe('global')
  })

  test('大小写不敏感：已有 X-OpenCode-Session 就地更新', () => {
    const h: Record<string, string> = { 'X-OpenCode-Session': 'ses_old' }
    zenHeadersWithFingerprint(h, 'ses_new', 'msg_new')
    expect(h['X-OpenCode-Session']).toBe('ses_new')
    expect(h['x-opencode-request']).toBe('msg_new')
    expect(Object.keys(h).filter((k) => k.toLowerCase() === 'x-opencode-session')).toHaveLength(1)
  })

  test('非法会话不写任何头', () => {
    const h: Record<string, string> = {}
    expect(zenHeadersWithFingerprint(h, 'has space!')).toBe(false)
    expect(h).toEqual({})
    expect(zenHeadersWithFingerprint(h, '')).toBe(false)
    expect(h).toEqual({})
  })
})

describe('mintZenRequestId', () => {
  test('形状与观测一致：msg_ + 12 小写 + 12 混合', () => {
    const id = mintZenRequestId(() => 'a')
    expect(id).toBe('msg_' + 'a'.repeat(24))
    const live = mintZenRequestId()
    expect(live).toMatch(/^msg_[0-9a-z]{12}[A-Za-z0-9]{12}$/)
  })
})

describe('latestSessionMessageId', () => {
  const LOG = [
    'timestamp=2026-09-18T00:00:01Z level=INFO message=created id=ses_aaa version=1.18.29',
    'timestamp=2026-09-18T00:00:02Z level=INFO message=process session.id=ses_aaa messageID=msg_0b209c3fc001LViMJFLn53xddn',
    'timestamp=2026-09-18T00:00:03Z level=INFO message=process session.id=ses_bbb messageID=msg_0b20af972001V7PdDm9ch6E4Sw',
    'timestamp=2026-09-18T00:00:04Z level=INFO message=process session.id=ses_aaa messageID=msg_0b20b1080001kXhy2A1x2E1uEC',
  ].join('\n')
  test('取该会话最后一次的 msg，不串会话', () => {
    expect(latestSessionMessageId(LOG, 'ses_aaa')).toBe('msg_0b20b1080001kXhy2A1x2E1uEC')
    expect(latestSessionMessageId(LOG, 'ses_bbb')).toBe('msg_0b20af972001V7PdDm9ch6E4Sw')
    expect(latestSessionMessageId(LOG, 'ses_nope')).toBeUndefined()
    expect(latestSessionMessageId(LOG, '')).toBeUndefined()
  })
})

// ---- 刷新流程（MemoryProviderStore + 临时日志目录，不碰运行环境）----

function zenProvider(over: Partial<Provider> = {}): Provider {
  return {
    providerId: 0, name: 'opencode', state: 'active', displayName: 'Zen',
    accessKind: 'reverse', risk: 'high', riskNote: 'test', stability: 'beta',
    api: 'openai-completions', baseUrl: 'https://opencode.ai/zen/v1',
    credential: {}, priority: 1, models: [], ...over,
  }
}

// 在 dir 下按真实布局写一份 opencode 日志（log/opencode.log），返回 dir。
function writeLogDir(dir: string, text: string): string {
  mkdirSync(join(dir, 'log'), { recursive: true })
  writeFileSync(join(dir, 'log', 'opencode.log'), text)
  return dir
}

const SESSION = 'ses_f4e01c058ffelq11bU6FerX7YN'
const FP_LOG = [
  `timestamp=2026-09-18T00:00:01Z level=INFO message=created id=${SESSION} slug=x version=1.18.29 projectID=global directory=/private/tmp path=private/tmp`,
  `timestamp=2026-09-18T00:00:02Z level=INFO message=process session.id=${SESSION} messageID=msg_0b209c3fc001LViMJFLn53xddn`,
  `timestamp=2026-09-18T00:00:03Z level=INFO message=stream providerID=opencode modelID=mimo-v2.5-free session.id=${SESSION} small=false`,
].join('\n')

describe('refreshZenProvider', () => {
  test('旧会话被新鲜会话替换并写回 msg；通知被调用', () => {
    const dir = writeLogDir(mkdtempSync(join(tmpdir(), 'zenfp-')), FP_LOG)
    try {
      const store = new MemoryProviderStore([zenProvider({
        headers: { 'User-Agent': 'opencode/1.18.29 curated', 'x-session-id': 'ses_stale' },
      })])
      const id = store.list()[0]!.providerId
      let notified = 0
      const rep = refreshZenProvider(store, () => { notified++ }, id, [dir])
      expect(rep.updated).toBe(true)
      expect(rep.sessionChanged).toBe(true)
      expect(rep.detail).toContain(SESSION)
      expect(notified).toBe(1)
      const after = store.get(id)!
      expect(after.headers?.['x-opencode-session']).toBe(SESSION)
      expect(after.headers?.['x-opencode-request']).toBe('msg_0b209c3fc001LViMJFLn53xddn')
      expect(after.headers?.['User-Agent']).toBe('opencode/1.18.29 curated') // UA 不动
      expect(after.headers?.['x-session-id']).toBe(SESSION) // 旧键同步跟上
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('已是最新则不写不断言；本地无会话则给重登指引', () => {
    const dir = writeLogDir(mkdtempSync(join(tmpdir(), 'zenfp-')), FP_LOG)
    try {
      // 会话池头也要在才算“全齐”——池是新增维度（限流按会话算，多会话轮换），
      // 缺了它会补写一次，见下方“池补齐”用例。
      const store = new MemoryProviderStore([zenProvider({
        // UA 也要对上版本才算“最新”（网关权威后客户端 UA 不再补充，见下组测试）
        headers: {
          'User-Agent': 'opencode/1.18.29', 'x-opencode-session': SESSION,
          'x-opencode-request': 'msg_0b209c3fc001LViMJFLn53xddn',
          'x-polycode-session-pool': SESSION,
        },
      })])
      const id = store.list()[0]!.providerId
      let notified = 0
      const rep = refreshZenProvider(store, () => { notified++ }, id, [dir])
      expect(rep.updated).toBe(false)
      expect(notified).toBe(0)

      const empty = mkdtempSync(join(tmpdir(), 'zenfp-empty-'))
      try {
        const rep2 = refreshZenProvider(store, () => {}, id, [empty])
        expect(rep2.updated).toBe(false)
        expect(rep2.next).toBe(NO_LOCAL_FINGERPRINT_NEXT)
      } finally {
        rmSync(empty, { recursive: true, force: true })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('非 zen 上游跳过；refreshAll 只刷 zen 且逐个兜底', () => {
    const store = new MemoryProviderStore([
      zenProvider({ name: 'plain', baseUrl: 'https://api.example.com/v1' }),
      zenProvider({ name: 'gone', state: 'deleted' }),
    ])
    const reps = refreshAllZenProviders(store, () => {}, [tmpdir()])
    expect(reps).toHaveLength(0) // deleted 与非 zen 都不进
    const plainId = store.list().find((p) => p.name === 'plain')!.providerId
    const rep = refreshZenProvider(store, () => {}, plainId, [tmpdir()])
    expect(rep.updated).toBe(false)
    expect(rep.detail).toContain('非 Zen')
  })
})

// ---- 管理面：headers 可 PATCH + 刷新端点 ----

function adminApp(deps: Record<string, unknown> = {}): Hono {
  return createAdminApi({
    adminKey: '',
    providers: new MemoryProviderStore(),
    accounts: new MemoryAccountStore(),
    ...deps,
  } as never)
}

describe('PATCH /admin/api/providers/:pid headers', () => {
  test('整包替换合法头；非法值 400', async () => {
    const providers = new MemoryProviderStore([zenProvider()])
    const app = adminApp({ providers })
    const id = providers.list()[0]!.providerId
    const okRes = await app.request(`/admin/api/providers/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ headers: { 'x-opencode-session': 'ses_hand' } }),
    })
    expect(okRes.status).toBe(200)
    expect(providers.get(id)!.headers).toEqual({ 'x-opencode-session': 'ses_hand' })
    const bad = await app.request(`/admin/api/providers/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ headers: { 'x-bad': 'a\r\nb' } }),
    })
    expect(bad.status).toBe(400)
  })
})

describe('POST /admin/api/providers/:pid/refresh-fingerprint', () => {
  test('未接线 501；不存在 404；接线后透传报告', async () => {
    const providers = new MemoryProviderStore([zenProvider()])
    const id = providers.list()[0]!.providerId
    const bare = adminApp({ providers })
    expect((await bare.request(`/admin/api/providers/${id}/refresh-fingerprint`, { method: 'POST' })).status).toBe(501)
    const wired = adminApp({
      providers,
      fingerprint: {
        refreshFingerprint: async (pid: number) => ({
          providerId: pid, providerName: 'opencode',
          updated: true, sessionChanged: true, detail: 'ok',
        }),
      },
    })
    const res = await wired.request(`/admin/api/providers/${id}/refresh-fingerprint`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { updated: boolean }).updated).toBe(true)
    expect((await wired.request('/admin/api/providers/9999/refresh-fingerprint', { method: 'POST' })).status).toBe(404)
  })
})

// ---- 代理：指纹失败刷新重试一次 ----

const testCfg = (): Config => ({
  gateway: {
    host: '127.0.0.1', port: 0, adminKey: '', gatewayKey: '', defaultModel: '',
    riskMax: 'high', precheckContext: false,
    firstByteTimeoutMs: 15000, streamIdleTimeoutMs: 60000,
  },
  dataDir: 'data', egresses: [], providers: [], accounts: [],
})

// 非流式 openai-completions 完整响应体（forward 非流式分支解析用）。
function nonStreamBody(): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    id: 'c1', object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }))
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(bytes); c.close() } })
}

describe('Proxy 指纹自愈重试', () => {
  test('首错 FINGERPRINT → 刷新成功 → 同候选重试并 200（只调刷新一次）', async () => {
    const seen: Array<Record<string, string> | undefined> = []
    let calls = 0
    const stubUp = {
      stream: async (pv: Provider) => {
        calls++
        seen.push(pv.headers)
        if (calls === 1) throw new UpstreamError(403, UPSTREAM.FINGERPRINT, 'free tier')
        return streamOf(nonStreamBody())
      },
    }
    const pv = zenProvider({
      providerId: 7, headers: { 'x-opencode-session': 'ses_stale' },
      models: [{ id: 'm', manual: false, enabled: true }],
    })
    const sched = new Scheduler([pv], 'high')
    const px = new Proxy(testCfg(), sched, stubUp as never, null)
    let refreshCalls = 0
    px.setFingerprintRefresher(async (got) => {
      refreshCalls++
      expect(got.providerId).toBe(7)
      return { ...got, headers: { 'x-opencode-session': 'ses_fresh' } }
    })
    const app = new Hono()
    px.registerRoutes(app)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'opencode/m', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    expect(calls).toBe(2)
    expect(refreshCalls).toBe(1)
    expect(seen[1]?.['x-opencode-session']).toBe('ses_fresh')
  })

  test('刷新器返回 null → 不重试，原错返回', async () => {
    let calls = 0
    const stubUp = {
      stream: async () => {
        calls++
        throw new UpstreamError(403, UPSTREAM.FINGERPRINT, 'free tier')
      },
    }
    const pv = zenProvider({
      providerId: 7,
      models: [{ id: 'm', manual: false, enabled: true }],
    })
    const sched = new Scheduler([pv], 'high')
    const px = new Proxy(testCfg(), sched, stubUp as never, null)
    px.setFingerprintRefresher(async () => null)
    const app = new Hono()
    px.registerRoutes(app)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'opencode/m', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(401) // FINGERPRINT → authentication
    expect(calls).toBe(1)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain('refresh-fingerprint')
  })
})

describe('refreshZenProvider 同步 UA（网关权威后客户端 UA 不再补充）', () => {
  // 静态缺 UA 或版本落后 → 写回识别到的真串；版本一致则不动（上游随时可能按版本卡）。
  const NEWER_LOG = [
    'timestamp=2026-09-18T00:00:01Z level=INFO message=created id=ses_aaaabbbbccccddddeeeeffff00 slug=x version=1.19.0 projectID=global directory=/private/tmp path=private/tmp',
    'timestamp=2026-09-18T00:00:02Z level=INFO message=process session.id=ses_aaaabbbbccccddddeeeeffff00 messageID=msg_0b209c3fc001LViMJFLn53xddn',
    'timestamp=2026-09-18T00:00:03Z level=INFO message=stream providerID=opencode modelID=mimo-v2.5-free session.id=ses_aaaabbbbccccddddeeeeffff00 small=false',
  ].join('\n')

  test('缺 UA 则补上；版本一致不碰', () => {
    const dir = writeLogDir(mkdtempSync(join(tmpdir(), 'zenua-')), FP_LOG)
    try {
      const store = new MemoryProviderStore([zenProvider({
        headers: { 'x-opencode-session': 'ses_stale' },
      })])
      const id = store.list()[0]!.providerId
      const rep = refreshZenProvider(store, () => {}, id, [dir])
      expect(rep.updated).toBe(true)
      expect(store.get(id)!.headers?.['User-Agent']).toBe('opencode/1.18.29')

      // 版本一致（1.18.29）→ 第二次只换会话不动 UA
      const store2 = new MemoryProviderStore([zenProvider({
        headers: { 'User-Agent': 'opencode/1.18.29 keep', 'x-opencode-session': 'ses_stale' },
      })])
      const id2 = store2.list()[0]!.providerId
      refreshZenProvider(store2, () => {}, id2, [dir])
      expect(store2.get(id2)!.headers?.['User-Agent']).toBe('opencode/1.18.29 keep')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('版本落后则同步新版并点名（会话已是最新也一样写）', () => {
    const dir = writeLogDir(mkdtempSync(join(tmpdir(), 'zenua-newer-')), NEWER_LOG)
    try {
      const store = new MemoryProviderStore([zenProvider({
        headers: {
          'User-Agent': 'opencode/1.18.29 old',
          'x-opencode-session': 'ses_aaaabbbbccccddddeeeeffff00',
          'x-opencode-request': 'msg_0b209c3fc001LViMJFLn53xddn',
        },
      })])
      const id = store.list()[0]!.providerId
      let notified = 0
      const rep = refreshZenProvider(store, () => { notified++ }, id, [dir])
      expect(rep.updated).toBe(true)
      expect(rep.sessionChanged).toBe(false)
      expect(rep.detail).toContain('opencode/1.19.0')
      expect(notified).toBe(1)
      expect(store.get(id)!.headers?.['User-Agent']).toBe('opencode/1.19.0')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// 会话池（2026-09-18 实测缺陷）：zen 免费档限流按 x-opencode-session 算，
// 不是按 IP——同一会话连打十轮 xhigh 必 429，而本机 opencode 多窗口没事。
// 网关把本机全部真实会话收进池轮换，等效多窗口。
describe('会话池：收集本机全部会话并轮换', () => {
  const S1 = 'ses_aaaa1111bbbb2222cccc3333'
  const S2 = 'ses_dddd4444eeee5555ffff6666'
  const POOL_LOG = [
    `timestamp=2026-09-18T00:00:01Z level=INFO message=created id=${S1} slug=x version=1.18.29 projectID=global directory=/private/tmp path=private/tmp`,
    `timestamp=2026-09-18T00:00:03Z level=INFO message=stream providerID=opencode modelID=mimo-v2.5-free session.id=${S1} small=false`,
    `timestamp=2026-09-18T00:10:01Z level=INFO message=created id=${S2} slug=y version=1.18.29 projectID=global directory=/private/tmp path=private/tmp`,
    `timestamp=2026-09-18T00:10:03Z level=INFO message=stream providerID=opencode modelID=mimo-v2.5-free session.id=${S2} small=false`,
  ].join('\n')

  test('parseAllFingerprintsFromLog：收全部会话、去重、保序（旧→新）', () => {
    const all = parseAllFingerprintsFromLog(POOL_LOG)
    expect(all.map((x) => x.sessionID)).toEqual([S1, S2])
    // 重复出现不重复收
    expect(parseAllFingerprintsFromLog(POOL_LOG + '\n' + POOL_LOG.split('\n')[0]).length).toBe(2)
  })

  test('刷新写入池头（新→旧），x-opencode-session = 最新那个', () => {
    const dir = writeLogDir(mkdtempSync(join(tmpdir(), 'zenpool-')), POOL_LOG)
    try {
      const store = new MemoryProviderStore([zenProvider({ headers: {} })])
      const id = store.list()[0]!.providerId
      const rep = refreshZenProvider(store, () => {}, id, [dir])
      expect(rep.updated).toBe(true)
      const h = store.get(id)!.headers ?? {}
      expect(h['x-opencode-session']).toBe(S2) // 最新那个当主会话
      // 池按新→旧：最新的排首位（配额窗口最干净，轮换从它开始）
      expect(parseZenSessionPool(h)).toEqual([S2, S1])
      expect(rep.detail).toContain('会话池 2 个')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('parseZenSessionPool：白名单过滤脏值、去重、保序', () => {
    expect(parseZenSessionPool({ 'x-polycode-session-pool': `${S1}, ${S1}, bad value!, ${S2}` }))
      .toEqual([S1, S2])
    expect(parseZenSessionPool({})).toEqual([])
    expect(parseZenSessionPool({ 'X-Polycode-Session-Pool': S1 })).toEqual([S1]) // 头名大小写不敏感
  })

  test('shiftZenSession：把指定会话提到池首并同步 x-opencode-session', () => {
    const p = zenProvider({ headers: { 'x-polycode-session-pool': `${S1},${S2}`, 'x-opencode-session': S1 } })
    shiftZenSession(p, S2)
    expect(parseZenSessionPool(p.headers!)).toEqual([S2, S1])
    expect(p.headers!['x-opencode-session']).toBe(S2)
    // 不在池里的会话不动（防凭空的会话被塞进去）
    const q = zenProvider({ headers: { 'x-polycode-session-pool': `${S1},${S2}` } })
    shiftZenSession(q, 'ses_zzzz')
    expect(parseZenSessionPool(q.headers!)).toEqual([S1, S2])
  })

  test('nextZenSession：池内轮转；无池返回 undefined', () => {
    resetZenPoolCursor()
    const p = zenProvider({ headers: { 'x-polycode-session-pool': `${S1},${S2}` } })
    expect(nextZenSession(p)).toBe(S1)
    expect(nextZenSession(p)).toBe(S2)
    expect(nextZenSession(p)).toBe(S1) // 回到队首
    resetZenPoolCursor()
    expect(nextZenSession(zenProvider({ headers: {} }))).toBeUndefined()
  })

  test('shiftZenSessionHeaders：只动传入副本，不碰原引用（并发隔离）', () => {
    const headers = { 'x-polycode-session-pool': `${S1},${S2}`, 'x-opencode-session': S1 }
    const snap = { ...headers }
    shiftZenSessionHeaders(headers, [S1, S2], S2)
    expect(parseZenSessionPool(headers)).toEqual([S2, S1])
    expect(headers['x-opencode-session']).toBe(S2)
    expect(snap).toEqual({ 'x-polycode-session-pool': `${S1},${S2}`, 'x-opencode-session': S1 })
  })

  test('buildHeaders：池头永不上 wire（内网轮换用）', () => {
    const up = new Upstream({ credLookup: () => ['', false] })
    const p = zenProvider({
      api: 'openai-completions',
      headers: {
        'x-polycode-session-pool': `${S1},${S2}`,
        'x-opencode-session': S1,
        'x-opencode-request': 'msg_aaaaaaaaaaaaaaaaaaaaaaaa',
      },
    })
    const h = (up as unknown as {
      buildHeaders(p: Provider, s: boolean, d: null, proto: 'openai-completions'): Record<string, string>
    }).buildHeaders(p, true, null, 'openai-completions')
    expect(Object.keys(h).some((k) => k.toLowerCase() === 'x-polycode-session-pool')).toBe(false)
    expect(h['x-opencode-session']).toBe(S1) // 主会话照常发出
    // 库内那份原样保留（发一次不丢池）
    expect(parseZenSessionPool(p.headers!)).toEqual([S1, S2])
  })

  test('429 换会话重试：首打主会话，撞 429 换下一个成功，且不污染库内 Provider', async () => {
    const seen: string[] = []
    const { startOneShot } = await import('./helpers/one-shot-server.ts')
    const okSSE = 'event: message_start\ndata: {"type":"message_start"}\n\n'
    let n = 0
    const { server: sx, base } = await startOneShot((_req, res) => {
      n++
      if (n === 1) {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end('{"error":{"message":"rate_limit_exceeded"}}')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(okSSE)
    })
    try {
      const up = new Upstream({ credLookup: () => ['', false] })
      const orig = zenProvider({
        // isZenUpstream 只认 opencode.ai 域名：用 127.0.0.1 + 池会走“非 zen”分支；
        // 这里用 http://s1.opencode.ai 域名并劫持 fetch，把 host 指回本地桩。
        baseUrl: 'https://s1.opencode.ai/zen/v1', api: 'openai-completions',
        headers: {
          'x-polycode-session-pool': `${S1},${S2}`,
          'x-opencode-session': S1,
          'x-opencode-request': 'msg_aaaaaaaaaaaaaaaaaaaaaaaa',
        },
      })
      const snapPool = `${S1},${S2}`
      const fetchSpy = up as unknown as {
        fetch: (url: string, init: { headers: Record<string, string> }) => Promise<Response>
      }
      const realFetch = fetchSpy.fetch.bind(up)
      fetchSpy.fetch = (async (url: string, init: { headers: Record<string, string> }) => {
        seen.push(init.headers['x-opencode-session'] ?? '')
        // 池头永不上 wire（断言在 fetch 边界做，比 buildHeaders 更贴近真实外发）
        expect(Object.keys(init.headers).some((k) => k.toLowerCase() === 'x-polycode-session-pool')).toBe(false)
        return realFetch(url.replace('https://s1.opencode.ai', base), init)
      }) as typeof fetchSpy.fetch
      const stream = await up.stream(orig, {
        model: 'm', stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)
      await stream.cancel().catch(() => {})
      expect(n).toBe(2) // 首打 429 + 换会话一次成功
      expect(seen).toEqual([S1, S2]) // 首打主会话，重打下一个（不重复打同一会话）
      // 库内 Provider 未被污染：会话与池顺序原样
      expect(orig.headers!['x-opencode-session']).toBe(S1)
      expect(orig.headers!['x-polycode-session-pool']).toBe(snapPool)
    } finally {
      await new Promise<void>((r) => sx.close(() => r()))
    }
  })

  test('429 重试有界：池耗尽后原样抛 429，不无限打', async () => {
    const { startOneShot } = await import('./helpers/one-shot-server.ts')
    let n = 0
    const { server: sx, base } = await startOneShot((_req, res) => {
      n++
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"rate_limit_exceeded"}}')
    })
    try {
      const up = new Upstream({ credLookup: () => ['', false] })
      const orig = zenProvider({
        baseUrl: 'https://s1.opencode.ai/zen/v1', api: 'openai-completions',
        headers: {
          'x-polycode-session-pool': `${S1},${S2}`,
          'x-opencode-session': S1,
          'x-opencode-request': 'msg_aaaaaaaaaaaaaaaaaaaaaaaa',
        },
      })
      const fetchSpy = up as unknown as { fetch: (url: string, init: unknown) => Promise<Response> }
      const realFetch = fetchSpy.fetch.bind(up)
      fetchSpy.fetch = ((url: string, init: unknown) =>
        realFetch(url.replace('https://s1.opencode.ai', base), init)) as typeof fetchSpy.fetch
      await expect(up.stream(orig, {
        model: 'm', stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)).rejects.toMatchObject({ status: 429 })
      expect(n).toBe(2) // 首打 + min(池长 2, 上限 4) - 1 次换会话 = 共 2 次
    } finally {
      await new Promise<void>((r) => sx.close(() => r()))
    }
  })
})
