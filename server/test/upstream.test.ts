import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { Upstream, joinURL, probeOrder, shouldTryNextProtocol, shouldForgetProtocol, shouldTryOtherProtocol, resolveProtocol, egressProxyURI, buildRequestURL, classifyUpstreamError, applyZenFingerprint, sanitizeUA, summarizeUpstreamBody, ensureZenAgentShape, ZEN_FLOOR_TOOL_NAMES, ensureWbAiSystemFirst, WB_AI_FLOOR_SYSTEM, applyUpstreamFloors, zenPreflightReasons } from '../src/router/upstream.ts'
import { UpstreamError } from '../src/ir/index.ts'
import { forgetProtocol, rememberProtocol } from '../src/model/index.ts'
import type { Provider } from '../src/model/index.ts'
import { UPSTREAM, getOutbound } from '../src/ir/index.ts'
import type { IrRequest } from '../src/ir/index.ts'
import '../src/codec/anthropicmessages.ts'
import '../src/codec/openaicompletions.ts'
import '../src/codec/openairesponses.ts'

let server: Server
let base = ''
const hits: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url} auth=${req.headers['x-api-key'] ?? req.headers.authorization ?? '-'} ah=${req.headers['anthropic-version'] ?? '-'}`)
    if (req.url === '/v1/messages') {
      if (req.headers['x-test-mode'] === 'sse') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
        return // 挂住流，测试侧主动关闭
      }
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"rate limited"}}')
      return
    }
    if (req.url === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        data: [
          { id: 'm1', protocols: ['chat_completions'] },
          { id: 'm2', input: ['text', 'vision'], limit: { context: 8192, output: 4096 } },
          { id: 'm3' },
        ],
      }))
      return
    }
    res.writeHead(404)
    res.end('nope')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

// 固定正数 providerId：模型挂在 Provider 下，两边数值必须一致。
const prov = (over: Partial<Provider>): Provider => ({
  providerId: 1, name: 'demo', displayName: '', accessKind: 'official', risk: 'low',
  stability: 'stable', api: '', baseUrl: base, credential: {}, headers: {},
  state: 'active', priority: 0, models: [], ...over,
})

describe('URL 拼接（坑位 #2）', () => {
  test('joinURL：裸拼接（不做去重，保持既有语义）', () => {
    expect(joinURL('https://api.x.com', '/v1/messages')).toBe('https://api.x.com/v1/messages')
    expect(joinURL('https://api.x.com/v1', 'chat/completions')).toBe('https://api.x.com/v1/chat/completions')
    // 裸拼接会把 /v1 叠成 /v1/v1 —— 这正是真实缺陷，真实请求路径必须用 buildRequestURL。
    expect(joinURL('https://api.x.com/v1/', '/v1/messages')).toBe('https://api.x.com/v1/v1/messages')
  })
})

describe('协议解析与探测（对齐 upstream.go）', () => {
  test('resolveProtocol 优先级：模型级声明 > 探测事实 > Provider 默认', () => {
    const p = prov({
      name: 'rp', api: 'openai-completions',
      models: [{ id: 'm1', api: 'openai-responses', manual: false, enabled: true }],
    })
    expect(resolveProtocol(p, 'm1')).toEqual(['openai-responses', true])
    expect(resolveProtocol(p, 'm2')).toEqual(['openai-completions', true])
    forgetProtocol('rp', 'm2') // 清事实再验证探测优先于默认
    rememberProtocol('rp', 'm2', 'anthropic-messages')
    expect(resolveProtocol(p, 'm2')).toEqual(['anthropic-messages', true])
    const noApi = prov({ name: 'rp2', api: '' })
    expect(resolveProtocol(noApi, 'm3')).toEqual(['', false])
  })

  test('probeOrder：优先上次解析到的协议，其余按常见度补全', () => {
    expect(probeOrder('')).toEqual(['openai-completions', 'openai-responses', 'anthropic-messages'])
    expect(probeOrder('anthropic-messages')).toEqual([
      'anthropic-messages', 'openai-completions', 'openai-responses',
    ])
  })

  test('shouldTryNextProtocol：400/500/网络都换协议试；凭据/配额/限流不换', () => {
    // B-P0-1 拆分：清缓存（shouldForgetProtocol）只有 400 才做；
    // 换协议（shouldTryNextProtocol）500/网络也试——错协议也可能回 500
    // （zen muse-spark 走错端点实测），且 5xx 多为上游病了，换个端点或能好。
    const e = (kind: string) => new UpstreamError(0, kind, 'x')
    expect(shouldTryNextProtocol(e(UPSTREAM.BAD_REQUEST))).toBe(true)
    expect(shouldTryNextProtocol(e(UPSTREAM.SERVER))).toBe(true)
    expect(shouldTryNextProtocol(e(UPSTREAM.NETWORK))).toBe(true)
    expect(shouldTryNextProtocol(e(UPSTREAM.AUTH))).toBe(false)
    expect(shouldTryNextProtocol(e(UPSTREAM.RATE_LIMIT))).toBe(false)
    expect(shouldTryNextProtocol(e(UPSTREAM.QUOTA))).toBe(false)
  })

  test('shouldForgetProtocol：只有 400 才清记住的协议（5xx 不清，防下个请求重探）', () => {
    const e = (kind: string) => new UpstreamError(0, kind, 'x')
    expect(shouldForgetProtocol(e(UPSTREAM.BAD_REQUEST))).toBe(true)
    expect(shouldForgetProtocol(e(UPSTREAM.SERVER))).toBe(false)
    expect(shouldForgetProtocol(e(UPSTREAM.NETWORK))).toBe(false)
    expect(shouldForgetProtocol(e(UPSTREAM.AUTH))).toBe(false)
  })

  test('shouldTryOtherProtocol 旧名兼容：语义 = shouldForgetProtocol（路径不对才换）', () => {
    const e = (kind: string) => new UpstreamError(0, kind, 'x')
    expect(shouldTryOtherProtocol(e(UPSTREAM.BAD_REQUEST))).toBe(true)
    expect(shouldTryOtherProtocol(e(UPSTREAM.SERVER))).toBe(false)
    expect(shouldTryOtherProtocol(e(UPSTREAM.NETWORK))).toBe(false)
    expect(shouldTryOtherProtocol(e(UPSTREAM.AUTH))).toBe(false)
    expect(shouldTryOtherProtocol(e(UPSTREAM.RATE_LIMIT))).toBe(false)
    expect(shouldTryOtherProtocol(e(UPSTREAM.QUOTA))).toBe(false)
  })
})

describe('换源闸门（硬约束）', () => {
  test('上游 2xx → 返回可读流（首字节已出，此后不可换源）', async () => {
    const u = new Upstream({ credLookup: () => ['', false] })
    const p = prov({ api: 'anthropic-messages', headers: { 'x-test-mode': 'sse' } })
    const stream = await u.stream(p, { model: 'm', messages: [], stream: true } as never)
    const reader = stream.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value!)).toContain('message_start')
    await reader.cancel()
  })

  test('上游 429 → 抛 UpstreamError（首字节前，调度器可换源）', async () => {
    const u = new Upstream({ credLookup: () => ['', false] })
    const p = prov({ api: 'anthropic-messages' })
    await expect(u.stream(p, { model: 'm', messages: [], stream: true } as never))
      .rejects.toMatchObject({ status: 429, kind: UPSTREAM.RATE_LIMIT })
  })

  test('协议自动探测：Provider 无 api 时逐协议试，成功者被记住', async () => {
    // /v1/messages 对非 sse 请求一律 429（auth 不该试出来）；换 /models 不适用。
    // 这里验证：openai-completions（探测顺序第一个）先试 → 打到 404 路径
    // （本测试服务器只有 /v1/messages /models），404 属 bad_request → 换下一协议。
    const u = new Upstream({ credLookup: () => ['', false] })
    const p = prov({ name: 'probe-demo', api: '' })
    forgetProtocol('probe-demo', 'm')
    await expect(u.stream(p, { model: 'm', messages: [], stream: true } as never))
      .rejects.toBeInstanceOf(Error)
    // 三协议都试过（前两个 bad_request/server 可换，最后 anthropic-messages 429 收尾）
    expect(hits.some((h) => h.includes('chat/completions'))).toBe(true)
    expect(hits.some((h) => h.includes('responses'))).toBe(true)
    expect(hits.some((h) => h.includes('/v1/messages'))).toBe(true)
  })

  test('协议自动探测：首候选 500 时换下一个协议（错协议也可能回 500，如 muse-spark）', async () => {
    // B-P0-1 回归：shouldTry 收窄时这条会挂——首试 500 直接抛，次候选轮不到。
    const { startOneShot } = await import('./helpers/one-shot-server.ts')
    await import('../src/codec/openaicompletions.ts')
    await import('../src/codec/openairesponses.ts')
    await import('../src/codec/anthropicmessages.ts')
    const hits: string[] = []
    const { server: sx, base } = await startOneShot((req, res) => {
      hits.push(req.url ?? '')
      if (req.url?.includes('/responses')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n')
        res.write('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n')
        res.end()
        return
      }
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"Internal server error"}}')
    })
    try {
      const u = new Upstream({ credLookup: () => ['', false] })
      const p = prov({ name: 'probe-500', api: '', baseUrl: base })
      forgetProtocol('probe-500', 'mm')
      const stream = await u.stream(p, {
        model: 'mm', stream: true,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)
      await stream.cancel().catch(() => {})
      expect(hits.some((h) => h.includes('chat/completions'))).toBe(true) // 首试 completions 撞 500
      expect(hits.some((h) => h.includes('/responses'))).toBe(true) // 回退 responses 成功
    } finally {
      await new Promise<void>((r) => sx.close(() => r()))
    }
  })

  test('已知协议 500 不清缓存但仍换协议试（拆分语义）', async () => {
    // known 路径：记住的是 completions 且回 500 → 缓存保留（下个请求不重探），
    // 但本次请求仍试 responses 并成功。
    const { startOneShot } = await import('./helpers/one-shot-server.ts')
    await import('../src/codec/openaicompletions.ts')
    await import('../src/codec/openairesponses.ts')
    const { server: sx, base } = await startOneShot((req, res) => {
      if (req.url?.includes('/responses')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n')
        res.write('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n')
        res.end()
        return
      }
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"boom"}}')
    })
    try {
      const { rememberProtocol, autoProtocol } = await import('../src/model/index.ts')
      rememberProtocol('known-500', 'mk', 'openai-completions')
      const u = new Upstream({ credLookup: () => ['', false] })
      const p = prov({ name: 'known-500', api: '', baseUrl: base })
      const stream = await u.stream(p, {
        model: 'mk', stream: true,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)
      await stream.cancel().catch(() => {})
      // 缓存不清（仍是 completions），但本次成功记的是 responses
      expect(autoProtocol('known-500', 'mk')).toBe('openai-responses')
    } finally {
      await new Promise<void>((r) => sx.close(() => r()))
    }
  })
})

describe('鉴权与协议头（传输层知识）', () => {
  test('anthropic 协议带 x-api-key + anthropic-version；openai 系带 Bearer', async () => {
    hits.length = 0
    const u = new Upstream({ credLookup: (n) => n === 'K' ? ['sk-test', true] : ['', false] })
    await u.stream(prov({ api: 'anthropic-messages', credential: { apiKeyEnv: 'K' } }),
      { model: 'm', messages: [], stream: true } as never).catch(() => {})
    expect(hits[0]).toContain('auth=sk-test')
    expect(hits[0]).toContain('ah=2023-06-01')
  })
})

describe('上游模型目录（FetchModelsWithProtocols 宽容解析）', () => {
  test('data[].id + protocols 声明 + 能力口径', async () => {
    const u = new Upstream({ credLookup: () => ['', false] })
    const [ids, declared, caps] = await u.fetchModelsWithProtocols(prov({ api: 'openai-completions' }))
    expect(ids).toEqual(['m1', 'm2', 'm3'])
    expect(declared).toEqual({ m1: 'openai-completions' })
    expect(caps).toEqual({ m2: { input: ['text', 'image'], contextWindow: 8192, maxOutputTokens: 4096 } })
  })
})

describe('streamWithTimeout 非 2xx（探测路径，真实缺陷回归）', () => {
  // 真实环境：探测打中上游 429，text() 消费后 cancel() 抛 ERR_INVALID_STATE，
  // 未捕获异常直接崩掉整个进程（UI 表现为 Failed to fetch）。
  test('429 → 抛 UpstreamError 而非崩溃', async () => {
    const { server: s429, base: b429 } = await import('./helpers/one-shot-server.ts').then((m) =>
      m.startOneShot((req, res) => { res.writeHead(429); res.end('{"error":"rate"}') }))
    const u = new Upstream()
    const p = { ...prov({}), baseUrl: b429, api: 'anthropic-messages' }
    await expect(u.streamWithTimeout(p, { model: 'm', stream: true, maxTokens: 16, messages: [] } as never, AbortSignal.timeout(5000)))
      .rejects.toMatchObject({ status: 429 })
    await new Promise<void>((r) => s429.close(() => r()))
  })

  test('内部一律流式：客户端要非流式，落线 body 仍是 stream:true', async () => {
    // 非流式端点残缺的上游（workbuddy 404、zen 403）全靠这条才对客户端透明。
    let seen = ''
    const { server: s, base: b } = await import('./helpers/one-shot-server.ts').then((m) =>
      m.startOneShot((req, res) => {
        let raw = ''
        req.on('data', (c: Buffer) => { raw += c.toString() })
        req.on('end', () => { seen = raw; res.writeHead(429); res.end('{"error":"rate"}') })
      }))
    const u = new Upstream()
    const p = { ...prov({}), baseUrl: b, api: 'openai-completions' }
    await expect(u.streamWithTimeout(p, { model: 'm', stream: false, maxTokens: 16, messages: [] } as never, AbortSignal.timeout(5000)))
      .rejects.toMatchObject({ status: 429 })
    expect(JSON.parse(seen).stream).toBe(true)
    await new Promise<void>((r) => s.close(() => r()))
  })

  test('瞬时 500 同条件重试一次：第二次 200 即返回（共命中 2 次）', async () => {
    let hits = 0
    const { server: s, base: b } = await import('./helpers/one-shot-server.ts').then((m) =>
      m.startOneShot((req, res) => {
        req.resume()
        req.on('end', () => {
          hits++
          if (hits === 1) { res.writeHead(500); res.end('oops'); return }
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.end('data: [DONE]\n\n')
        })
      }))
    const u = new Upstream()
    const p = { ...prov({}), baseUrl: b, api: 'openai-completions' }
    const st = await u.stream(p, { model: 'm', stream: true, maxTokens: 16, messages: [] } as never)
    await st.cancel().catch(() => {})
    expect(hits).toBe(2)
    await new Promise<void>((r) => s.close(() => r()))
  })

  test('401 不重试（确定性拒绝，打一次就抛）', async () => {
    let hits = 0
    const { server: s, base: b } = await import('./helpers/one-shot-server.ts').then((m) =>
      m.startOneShot((req, res) => {
        req.resume()
        req.on('end', () => { hits++; res.writeHead(401); res.end('nope') })
      }))
    const u = new Upstream()
    const p = { ...prov({}), baseUrl: b, api: 'openai-completions' }
    await expect(u.stream(p, { model: 'm', stream: true, maxTokens: 16, messages: [] } as never))
      .rejects.toMatchObject({ status: 401 })
    expect(hits).toBe(1)
    await new Promise<void>((r) => s.close(() => r()))
  })

  test('慢 500 不重试（5s 后才回说明上游在挣扎，直接抛不等第二轮）', async () => {
    let hits = 0
    const { server: s, base: b } = await import('./helpers/one-shot-server.ts').then((m) =>
      m.startOneShot((req, res) => {
        req.resume()
        req.on('end', () => {
          hits++
          setTimeout(() => { res.writeHead(500); res.end('oops') }, 5500)
        })
      }))
    // noAutoProtocol：钉死单协议，避免协议自动回退把 5.5s 复制三遍（那是另一条既有逻辑）
    const u = new Upstream({ noAutoProtocol: true })
    const p = { ...prov({}), baseUrl: b, api: 'openai-completions' }
    await expect(u.stream(p, { model: 'm', stream: true, maxTokens: 16, messages: [] } as never))
      .rejects.toMatchObject({ status: 500 })
    expect(hits).toBe(1)
    await new Promise<void>((r) => s.close(() => r()))
  }, 15000)

  test('连接被拒重试一次仍失败才抛（两次耗时 ≥ 一次退避）', async () => {
    // 127.0.0.1:9（discard 端口）恒拒连：第一次 ECONNREFUSED → 退避 500ms →
    // 第二次仍拒连才抛 NETWORK。服务端无命中可数，用耗时证明“打了两次”。
    const u = new Upstream()
    const p = { ...prov({}), baseUrl: 'http://127.0.0.1:9', api: 'openai-completions' }
    const t0 = Date.now()
    await expect(u.stream(p, { model: 'm', stream: true, maxTokens: 16, messages: [] } as never))
      .rejects.toMatchObject({ kind: 'network' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400)
  })
})

describe('上游错误分类细化：RegionError 不是凭据错误', () => {
  // 真实缺陷：muse 系模型回 403 RegionError，宽泛地归为 auth 会挡死协议自动回退。
  // 分类时应看错误体，RegionError 独立成 region（既不是凭据错，也不是「协议路径不对」）。
  test('403 + RegionError 体 → kind=region（不是 auth，也不是 bad_request）', async () => {
    const { server: s, base: b } = await import('./helpers/one-shot-server.ts').then((m) =>
      m.startOneShot((req, res) => {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end('{"type":"error","error":{"type":"RegionError","message":"This model is not available in your country."}}')
      }))
    const u = new Upstream({ credLookup: () => ['', false], noAutoProtocol: true })
    const p = { ...prov({}), baseUrl: b, api: 'anthropic-messages' }
    await expect(u.streamWithTimeout(p, { model: 'm', stream: true, maxTokens: 16, messages: [] } as never, AbortSignal.timeout(5000)))
      .rejects.toMatchObject({ status: 403, kind: 'region' })
    await new Promise<void>((r) => s.close(() => r()))
  })

  test('403 普通凭据错误 → kind=auth（不换协议）', async () => {
    const { server: s, base: b } = await import('./helpers/one-shot-server.ts').then((m) =>
      m.startOneShot((req, res) => { res.writeHead(403); res.end('forbidden') }))
    const u = new Upstream({ credLookup: () => ['', false], noAutoProtocol: true })
    const p = { ...prov({}), baseUrl: b, api: 'anthropic-messages' }
    await expect(u.streamWithTimeout(p, { model: 'm', stream: true, maxTokens: 16, messages: [] } as never, AbortSignal.timeout(5000)))
      .rejects.toMatchObject({ status: 403, kind: 'auth' })
    await new Promise<void>((r) => s.close(() => r()))
  })
})

describe('上游错误分类细化：429 额度用尽 ≠ 429 限流', () => {
  // 真实缺陷（workbuddy wb-2，2026-09-14）：额度用尽时上游回 429 + code 14018。
  // 只看状态码会归成 rate_limit（1 分钟冷却，到点自动复活）→ 账号每隔一分钟
  // 爬起来再撞一次墙，永远好不了。两者必须分开：限流是临时的，额度是持久的。
  const quotaBody = '{"error":{"data":{"code":14018,"msg":"额度已用尽，请访问以下链接，购买加量包以获取更多额度"}}}'

  test('429 + 额度用尽体 → kind=quota（进 exhausted，不自动恢复）', async () => {
    const { server: s, base: b } = await import('./helpers/one-shot-server.ts').then((m) =>
      m.startOneShot((req, res) => {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(quotaBody)
      }))
    const u = new Upstream({ credLookup: () => ['', false], noAutoProtocol: true })
    const p = { ...prov({}), baseUrl: b, api: 'openai-completions' }
    await expect(u.streamWithTimeout(p, { model: 'm', stream: true, maxTokens: 16, messages: [] } as never, AbortSignal.timeout(5000)))
      .rejects.toMatchObject({ status: 429, kind: 'quota' })
    await new Promise<void>((r) => s.close(() => r()))
  })

  test('429 普通限流体 → kind=rate_limit（保持临时冷却语义）', async () => {
    const { server: s, base: b } = await import('./helpers/one-shot-server.ts').then((m) =>
      m.startOneShot((req, res) => {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end('{"error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}')
      }))
    const u = new Upstream({ credLookup: () => ['', false], noAutoProtocol: true })
    const p = { ...prov({}), baseUrl: b, api: 'openai-completions' }
    await expect(u.streamWithTimeout(p, { model: 'm', stream: true, maxTokens: 16, messages: [] } as never, AbortSignal.timeout(5000)))
      .rejects.toMatchObject({ status: 429, kind: 'rate_limit' })
    await new Promise<void>((r) => s.close(() => r()))
  })

  test('402 支付/额度 → quota（原有语义不变）', () => {
    expect(classifyUpstreamError(402, '')).toBe(UPSTREAM.QUOTA)
  })

  // 回归（真实踩坑）：opencode 免费档被上游用 403 拒绝，
  // 但**不是**用户 Key 的问题——直连上游同样 403：
  //   FreeTierError: OpenCode's free tier can only be used from within OpenCode
  // 归成 auth 会让人反复去翻/重置 API Key（而 Key 是好的），排查方向全错。
  test('403 但属于策略性拒绝时不归 auth（否则误导排查方向）', () => {
    const freeTier = JSON.stringify({
      type: 'error',
      error: { type: 'FreeTierError', message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode" },
    })
    // 指纹缺失单独归类：既不是 Key 错（归 auth 会让人白翻 API Key），
    // 也不是协议路径错（归 bad_request 会被探测当路径噪音压到最低优先级）。
    expect(classifyUpstreamError(403, freeTier)).toBe(UPSTREAM.FINGERPRINT)
    // 地区限制：换出口代理能解，同样不是 Key 错。独立归类而不是混在 bad_request 里——
    // 混着会被探测当成「协议路径噪音」压到最低优先级，用户只看到含糊错误，
    // 以为模型下线了（实际是出口 IP 不在可用地区）。
    expect(classifyUpstreamError(403, '{"error":{"type":"RegionError"}}')).toBe(UPSTREAM.REGION)
    expect(classifyUpstreamError(403, '{"error":{"message":"This model is not available in your country."}}'))
      .toBe(UPSTREAM.REGION)
    // 真正的凭据错误仍归 auth（别把这条顺手改坏了）
    expect(classifyUpstreamError(403, '{"error":{"type":"AuthError","message":"Missing API key."}}'))
      .toBe(UPSTREAM.AUTH)
    expect(classifyUpstreamError(401, 'invalid token')).toBe(UPSTREAM.AUTH)
  })
})

describe('上游错误体提炼 summarizeUpstreamBody（各家字段名不一，只抽人话+业务码）', () => {
  test('OpenAI 形态：error.message', () => {
    expect(summarizeUpstreamBody(`{"error":{"message":"reasoning_effort 'minimal' is not supported","type":"invalid_request_error"}}`))
      .toBe(`reasoning_effort 'minimal' is not supported`)
  })

  test('腾讯系形态：error.data.msg + code（code 拼后缀）', () => {
    expect(summarizeUpstreamBody(`{"error":{"data":{"code":14018,"msg":"额度已用尽"}}}`))
      .toBe('额度已用尽 (code 14018)')
  })

  test('Anthropic 形态：type.error.message；code 已在正文出现不重复', () => {
    expect(summarizeUpstreamBody(`{"type":"error","error":{"type":"rate_limit_error","message":"[1113] Insufficient balance."}}`))
      .toBe('[1113] Insufficient balance.')
  })

  test('顶层 message / 纯文本原样保留（不猜语言）', () => {
    expect(summarizeUpstreamBody(`{"message":"quota exceeded"}`)).toBe('quota exceeded')
    expect(summarizeUpstreamBody('upstream boom')).toBe('upstream boom')
    expect(summarizeUpstreamBody('慢')).toBe('慢')
  })

  test('HTML 错误页去标签（issue-1：整页 HTML 等于没说）', () => {
    const got = summarizeUpstreamBody('<!DOCTYPE html><html><body><h1>404 Not Found</h1></body></html>')
    expect(got).toBe('404 Not Found')
    expect(got).not.toContain('<')
  })

  test('空体与超长回落', () => {
    expect(summarizeUpstreamBody('   ')).toBe('(上游空响应体)')
    expect(summarizeUpstreamBody('x'.repeat(300))).toHaveLength(200)
  })
})

describe('egress 出口分流（按 Provider 选取 dispatcher）', () => {
  test('egress URI 构建：http 直拼；socks5 v1 明确不支持（Clash 类混合端口用 http）', () => {
    expect(egressProxyURI({ id: 'clash', kind: 'http', addr: '127.0.0.1:7897' })).toBe('http://127.0.0.1:7897')
    expect(() => egressProxyURI({ id: 's', kind: 'socks5', addr: '127.0.0.1:7897' })).toThrow(/socks5/)
  })

  test('声明 egress 的 Provider 请求经代理分发器，未声明的直连', async () => {
    const { server: px, base: pbase } = await import('./helpers/one-shot-server.ts').then((m) =>
      m.startOneShot((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"object":"list","data":[{"id":"m"}]}') }))
    const withEg = new Upstream({
      credLookup: () => ['', false],
      egresses: { proxied: pbase },
    })
    expect(await withEg.fetchModels(prov({ baseUrl: `${pbase}/v1`, api: 'openai-completions' }))).toEqual(['m'])
    await new Promise<void>((r) => px.close(() => r()))
  })
})

// 真实缺陷回归：zen 的 baseUrl 是 https://opencode.ai/zen/v1（openai 系口径，停在 /v1），
// 但 anthropic-messages 编解码器的 requestPath 返回 "/v1/messages"（约定 baseUrl 停域名根）。
// 两者相撞拼出 https://opencode.ai/zen/v1/v1/messages → 上游回 404 HTML 页
// （报错串里那串 <!DOCTYPE html>），表现为「muse spark 根本用不了」。
// 修复：拼接时若 baseUrl 已以 /v1 结尾，去掉路径里重复的 /v1，保证只出现一次。
describe('baseUrl 与协议路径相撞：/v1 不得重复（zen muse-spark 真实缺陷）', () => {
  test('/v1 结尾的 baseUrl + anthropic 路径 → 只出现一次 /v1', () => {
    const url = buildRequestURL('https://opencode.ai/zen/v1', '/v1/messages')
    expect(url).toBe('https://opencode.ai/zen/v1/messages')
    expect(url).not.toContain('/v1/v1')
  })

  test('域名根 baseUrl + anthropic 路径 → 原样拼接（不回归）', () => {
    expect(buildRequestURL('https://api.z.ai/api/anthropic', '/v1/messages'))
      .toBe('https://api.z.ai/api/anthropic/v1/messages')
  })

  test('openai 系相对路径不受影响（responses / chat/completions）', () => {
    expect(buildRequestURL('https://opencode.ai/zen/v1', 'responses'))
      .toBe('https://opencode.ai/zen/v1/responses')
    expect(buildRequestURL('https://opencode.ai/zen/v1', 'chat/completions'))
      .toBe('https://opencode.ai/zen/v1/chat/completions')
  })

  test('实测上游路径：zen 三协议最终 URL 都合法', () => {
    const b = 'https://opencode.ai/zen/v1'
    expect(buildRequestURL(b, '/v1/messages')).toBe('https://opencode.ai/zen/v1/messages')
    expect(buildRequestURL(b, 'responses')).toBe('https://opencode.ai/zen/v1/responses')
    expect(buildRequestURL(b, 'chat/completions')).toBe('https://opencode.ai/zen/v1/chat/completions')
  })
})

describe('withOpts 派生实例必须继承 egress 表（探测按钮真实缺陷）', () => {
  // 真实缺陷：Probe.probeOne 用 up.withOpts({noAutoProtocol:true}) 派生实例发请求，
  // 而 withOpts 只复制了 credLookup/noAutoProtocol，egresses 被丢成 {}。
  // 于是「测试」按钮报 egress "clash" 未配置（顶层明明配了），带出口的模型全测不了。
  test('派生实例仍能用 Provider.egress 经代理出网', async () => {
    const { server: px, base: pbase } = await import('./helpers/one-shot-server.ts').then((m) =>
      m.startOneShot((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"object":"list","data":[{"id":"m"}]}')
      }))
    const up = new Upstream({ credLookup: () => ['', false], egresses: { clash: pbase } })
    const derived = up.withOpts({ noAutoProtocol: true })
    const pv = prov({ baseUrl: `${pbase}/v1`, api: 'openai-completions', egress: 'clash' })
    expect(await derived.fetchModels(pv)).toEqual(['m'])
    await new Promise<void>((r) => px.close(() => r()))
  })

  test('派生实例未声明 egress 的 Provider 仍直连', async () => {
    const { server: px, base: pbase } = await import('./helpers/one-shot-server.ts').then((m) =>
      m.startOneShot((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"object":"list","data":[{"id":"m"}]}')
      }))
    const up = new Upstream({ credLookup: () => ['', false], egresses: { clash: 'http://127.0.0.1:1' } })
    const derived = up.withOpts({ noAutoProtocol: true })
    expect(await derived.fetchModels(prov({ baseUrl: `${pbase}/v1`, api: 'openai-completions' }))).toEqual(['m'])
    await new Promise<void>((r) => px.close(() => r()))
  })

  // 真实缺陷（2026-09-17，验证 zen 探针时现场踩到）：withOpts 硬写
  // `credLookup: this.credLookup`，调用方传入的 lookup 被**静默丢弃**。
  // 现象：探针注入了「ZEN_KEY 缺省回落到公共 key public」的 lookup，实际仍走原实例的
  // env-only 查找 → 恒报「环境变量 ZEN_KEY 未设置」，一个看起来像「没配凭据」的假阴性，
  // 而真正的病根是派生实例没接受覆盖。凭据这种事静默走错最危险：报错指向完全无关的方向。
  test('派生实例可覆盖 credLookup（传进来的 lookup 必须生效，不能被静默丢弃）', async () => {
    const seen: string[] = []
    const { server: px, base: pbase } = await import('./helpers/one-shot-server.ts').then((m) =>
      m.startOneShot((req, res) => {
        seen.push(req.headers.authorization ?? '')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"object":"list","data":[{"id":"m"}]}')
      }))
    // 原实例：找不到任何凭据；派生实例：给出公共 key
    const up = new Upstream({ credLookup: () => ['', false] })
    const derived = up.withOpts({ noAutoProtocol: true, credLookup: () => ['public', true] })
    await derived.fetchModels(prov({ baseUrl: `${pbase}/v1`, api: 'openai-completions', credential: { apiKeyEnv: 'ZEN_KEY' } }))
    expect(seen[0]).toBe('Bearer public')
    // 不传 credLookup 时仍继承原实例（默认行为不能被这次修复破坏）
    await expect(up.withOpts({ noAutoProtocol: true })
      .fetchModels(prov({ baseUrl: `${pbase}/v1`, api: 'openai-completions', credential: { apiKeyEnv: 'ZEN_KEY' } })))
      .rejects.toThrow(/ZEN_KEY/)
    await new Promise<void>((r) => px.close(() => r()))
  })
})

test('setEgresses 热更新：换表并清 dispatcher 缓存（旧表引用失效、新表生效）', async () => {  const { server: px, base: pbase } = await import('./helpers/one-shot-server.ts').then((m) =>
    m.startOneShot((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"object":"list","data":[{"id":"m"}]}') }))
  const up = new Upstream({ credLookup: () => ['', false], egresses: { old: 'http://127.0.0.1:1' } })
  const pv = prov({ baseUrl: `${pbase}/v1`, api: 'openai-completions', egress: 'old' })
  await expect(up.fetchModels(pv)).rejects.toThrow(/fetch failed|ECONNREFUSED|connect/) // 旧出口 127.0.0.1:1 连不上
  up.setEgresses({ fresh: pbase })
  expect(await up.fetchModels({ ...pv, egress: 'fresh' })).toEqual(['m'])
  await expect(up.fetchModels(pv)).rejects.toThrow(/old/) // 旧引用已随换表失效
  await new Promise<void>((r) => px.close(() => r()))
})

// zen 指纹校准（与真客户端对齐：发 x-opencode-* 四件套，不删）：
// 2026-09-18 真机取证推翻了旧的“毒头”假设——官方客户端本来就发四件套，
// 删掉才会 403。会话取值 静态 x-opencode-session > 旧 x-session-id 晋升；
// UA 缺省时按 静态 > ZEN_UA 补位，全无则如实不发；客户端透传一律忽略
// （网关权威：第三方 harness 的会话/UA 上游不认，照透必 403）。
describe('zen 指纹校准 applyZenFingerprint', () => {
  // 合规会话 ID：ses_ + 12 位小写 hex + 14 位 base62，且前 12 位 hex 的低 12 位 ≥ 0xfc0。
  // 上游只收这种形状（低 12 位下界是 2026-10-15 实测的，见 model.validZenSessionId）。
  // 短名如 ses_x / ses_static 形状不成立，上游实测 0/3 全 403，不再是合法输入。
  const SID = 'ses_0b20f9fceffeSFZUUtZpYDSXKH'
  const SID2 = 'ses_a1b2c3d4effeSFZUUtZpYDSXKH'
  test('x-opencode-* 四件套保留并补全（大小写不敏感，不再删除）', () => {
    // 用真值形状（msg_ + 12 小写 hex + 14 base62）：形状不对的值会被换掉，
    // 这里要验证的是「合规静态值原样保留」，所以给合规值。
    const realRid = 'msg_0b20f9fce001SFZUUtZpYDSXKH'
    const h: Record<string, string> = {
      'x-opencode-client': 'cli', 'X-OpenCode-Project': 'global',
      'x-opencode-request': realRid, 'x-opencode-session': SID,
      'Content-Type': 'application/json',
    }
    applyZenFingerprint(h, { id: SID2 }, true, '')
    expect(h['x-opencode-session']).toBe(SID) // 客户端透传不再覆盖静态
    // 孪生头必须同值（UA ≥ 1.19.0 时上游必查它，不一致即 403）。
    expect(h['x-opencode-session-id']).toBe(SID)
    expect(h['x-opencode-request']).toBe(realRid) // 合规静态 request 保留（真机一次会话内稳定）
    expect(h['Content-Type']).toBe('application/json') // 无关头不动
    // 大小写不敏感：X-OpenCode-Project 就地识别，不新增重复键
    expect(Object.keys(h).filter((k) => k.toLowerCase() === 'x-opencode-project')).toHaveLength(1)
  })

  test('旧 x-session-id 晋升为 x-opencode-session；缺 request 则按形状现铸', () => {
    const h: Record<string, string> = { 'x-session-id': SID }
    applyZenFingerprint(h, undefined, true, '')
    expect(h['x-opencode-session']).toBe(SID)
    expect(h['x-opencode-session-id']).toBe(SID) // 孪生头同值
    // 2026-10-15 实测：上游只校验形状（msg_ + 12 小写hex + 14 base62 = 30）。
    // 旧实现现铸 28 位值，每发必 403——这条断言就是防那个回归的。
    expect(h['x-opencode-request']).toMatch(/^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/)
    expect(h['x-opencode-client']).toBe('cli')
    expect(h['x-opencode-project']).toBe('global')
  })

  test('库里存着旧实现的 28 位残值时，换成合规新值而不是原样发出', () => {
    // 真实历史值：旧 mintZenRequestId 写进库的残值（28 位，前缀含非 hex 字母）。
    const legacyBad = 'msg_8nkftogpegx0D8cf4x9koRTT'
    const h: Record<string, string> = {
      'x-opencode-session': SID, 'x-opencode-request': legacyBad,
    }
    applyZenFingerprint(h, undefined, true, '')
    expect(h['x-opencode-request']).not.toBe(legacyBad)
    expect(h['x-opencode-request']).toMatch(/^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/)
  })

  test('显式配的 client/project 不覆盖；脏会话不硬凑（改现铸）', () => {
    const h: Record<string, string> = {
      'x-opencode-client': 'mine', 'x-opencode-project': 'proj9',
      'x-opencode-session': SID,
    }
    applyZenFingerprint(h, { id: 'has space!' }, true, '')
    expect(h['x-opencode-session']).toBe(SID) // 脏透传回退静态
    expect(h['x-opencode-session-id']).toBe(SID) // 孪生头同值
    expect(h['x-opencode-client']).toBe('mine')
    expect(h['x-opencode-project']).toBe('proj9')
    // 无静态、无透传：现铸一个合规会话（不再“不凭空编”——上游只校验形状，
    // 现铸与真值等效；留空反而必 403，见 model.mintZenSessionId）。
    const h2: Record<string, string> = {}
    applyZenFingerprint(h2, { id: '' }, true, '')
    expect(h2['x-opencode-session']).toMatch(/^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/)
    expect(h2['x-opencode-session-id']).toBe(h2['x-opencode-session'])
    expect(h2['x-session-id']).toBe(h2['x-opencode-session'])
  })

  test('UA 补位：静态优先（已配不动）；缺时用 ZEN_UA；再缺用兜底值；客户端 UA 永不采用', () => {
    // 静态已配：谁也冲不掉（显式配置优先）
    const h1: Record<string, string> = { 'User-Agent': 'opencode/9.9.9 static' }
    applyZenFingerprint(h1, { userAgent: 'opencode/1.2.3 live' }, true, 'opencode/0.0.0 env')
    expect(h1['User-Agent']).toBe('opencode/9.9.9 static')
    // 缺静态：用 ZEN_UA（客户端透传不再补位）
    const h2: Record<string, string> = {}
    applyZenFingerprint(h2, { userAgent: 'opencode/1.2.3 live' }, true, 'opencode/0.0.0 env')
    expect(h2['User-Agent']).toBe('opencode/0.0.0 env')
    // 无透传：ZEN_UA 补上
    const h3: Record<string, string> = {}
    applyZenFingerprint(h3, { id: SID }, true, 'opencode/0.0.0 env')
    expect(h3['User-Agent']).toBe('opencode/0.0.0 env')
    // 全都没有：用兜底值（上游有最低版本要求：不发 UA 是 403，<1.18.0 是 426，
    // 所以“如实不发”已不是诚实而是必然失败，必须给一个已知可用的版本）。
    const h4: Record<string, string> = {}
    applyZenFingerprint(h4, { id: SID }, true, '')
    expect(h4['User-Agent']).toBe('opencode/1.18.0')
    // 大小写不敏感：已有小写 user-agent 也算已配
    const h5: Record<string, string> = { 'user-agent': 'custom/1.0' }
    applyZenFingerprint(h5, { userAgent: 'opencode/1.2.3 live' }, true, 'opencode/0.0.0 env')
    expect(h5['user-agent']).toBe('custom/1.0')
    // 非 zen 上游：缺 UA 也不补
    const h6: Record<string, string> = {}
    applyZenFingerprint(h6, { userAgent: 'opencode/1.2.3 live' }, false, 'opencode/0.0.0 env')
    expect(h6['User-Agent']).toBeUndefined()
  })

  test('sanitizeUA：只收单行可打印 ASCII；空/CRLF/非ASCII 不要；超长截断', () => {
    expect(sanitizeUA('opencode/1.2.3 live')).toBe('opencode/1.2.3 live')
    expect(sanitizeUA(undefined)).toBeUndefined()
    expect(sanitizeUA('  ')).toBeUndefined()
    expect(sanitizeUA('a\r\nb')).toBeUndefined()
    expect(sanitizeUA('中文UA')).toBeUndefined()
    expect(sanitizeUA('x'.repeat(600))?.length).toBe(512)
  })

  // x-session-affinity 是**毒头**（2026-10-15 在线二分，3/3 稳定复现）：
  // 同会话/同请求体/同 UA/同路径，只加减这一个头——不带 → 200，带（任何值）→ 403
  // FreeTierError。官方客户端从不发它，上游现在拿它当「非官方客户端」的判据。
  // 所以它必须从出站头上**被删掉**，而不是「跟 sid 同步」。
  test('会话头：静态 x-session-id 保留，x-session-affinity 必须被删', () => {
    const h1: Record<string, string> = { 'x-session-id': SID, 'x-session-affinity': SID }
    applyZenFingerprint(h1, { id: SID2, affinity: SID2 })
    expect(h1['x-session-id']).toBe(SID)
    expect(h1['x-session-affinity']).toBeUndefined() // 毒头：出站前抹掉
    const h2: Record<string, string> = {}
    applyZenFingerprint(h2, { id: SID })
    // 无静态、无合规透传 → 现铸（而不是“不写”）：留空必 403。
    expect(h2['x-session-id']).toMatch(/^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/)
    expect(h2['x-session-affinity']).toBeUndefined()
    const h3: Record<string, string> = { 'x-session-id': SID }
    applyZenFingerprint(h3) // 无透传：静态保留，不得凭空补 affinity
    expect(h3['x-session-id']).toBe(SID)
    expect(h3['x-session-affinity']).toBeUndefined()
  })

  test('非法会话值不硬凑：透传脏值时回退静态，静态也脏则现铸', () => {
    const h1: Record<string, string> = { 'x-session-id': SID, 'x-session-affinity': SID }
    applyZenFingerprint(h1, { id: 'has space!' })
    expect(h1['x-session-id']).toBe(SID)
    expect(h1['x-session-affinity']).toBeUndefined()
    const h2: Record<string, string> = {}
    applyZenFingerprint(h2, { id: '' })
    expect(h2['x-session-id']).toMatch(/^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/)
    expect(h2['x-session-affinity']).toBeUndefined()
  })

  test('非 ses_ 透传直接忽略（第三方 harness 自带会话 ID，如 ZCode 的 UUID）', () => {
    // 真实事故（2026-09-18）：zcode 发 x-session-id: 8a843b90-…（UUID，字符集
    // 恰好过白名单），照透则上游百分百 403。必须回退静态，不得透传陌生会话。
    const h1: Record<string, string> = { 'x-opencode-session': SID }
    applyZenFingerprint(h1, { id: '8a843b90-a9c1-4d2e-8f01-xyz123456789', affinity: '8a843b90-a9c1-4d2e-8f01-xyz123456789' })
    expect(h1['x-opencode-session']).toBe(SID)
    expect(h1['x-session-id']).toBe(SID)
    expect(h1['x-session-affinity']).toBeUndefined() // 毒头：无论何值都不发
    // 无静态可退：不得把 UUID 发给上游，改为现铸一个合规会话。
    const h2: Record<string, string> = {}
    applyZenFingerprint(h2, { id: '8a843b90-a9c1-4d2e-8f01-xyz123456789' })
    expect(h2['x-opencode-session']).toMatch(/^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/)
    expect(h2['x-session-id']).toBe(h2['x-opencode-session'])
    expect(h2['x-session-id']).not.toContain('8a843b90') // 绝不透传陌生 UUID
    expect(h2['x-session-affinity']).toBeUndefined()
  })

  test('ses_ 透传同样忽略（网关权威：只用静态，会话过期走刷新流程）', () => {
    const h: Record<string, string> = { 'x-opencode-session': SID }
    applyZenFingerprint(h, { id: SID2, affinity: SID2 })
    expect(h['x-opencode-session']).toBe(SID)
    expect(h['x-session-affinity']).toBeUndefined()
  })
})

describe('WorkBuddy 海外版体裁闸门 ensureWbAiSystemFirst（2026-09-19 双版本实测）', () => {
  // 取证：同一请求体（首条 user），
  //   海外版 www.workbuddy.ai    → 400 code 11128「first message is not system prompt」
  //   国内版 copilot.tencent.com → 200
  // 所以这条适配必须按 host 生效，不能对所有 WorkBuddy 上游一刀切。
  const AI = 'https://www.workbuddy.ai/v2'
  const CN = 'https://copilot.tencent.com/v2'
  const bare = (): IrRequest => ({
    model: 'hy3', stream: true,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })

  test('非海外版上游原样返回（同一引用）', () => {
    const r = bare()
    expect(ensureWbAiSystemFirst(r, 'https://api.deepseek.com')).toBe(r)
    // 国内版无此约束，不得注入（否则是无谓的 system 改写）。
    expect(ensureWbAiSystemFirst(r, CN)).toBe(r)
  })

  test('海外版无 system → 补一条最小中立 system，且不改入参', () => {
    const r = bare()
    const out = ensureWbAiSystemFirst(r, AI)
    expect(out).not.toBe(r)
    expect(r.system).toBeUndefined() // 入参不动
    expect(out.system).toEqual([{ type: 'text', text: WB_AI_FLOOR_SYSTEM }])
  })

  test('海外版已有非空 system → 同一引用（客户端提示词一字不改）', () => {
    const r = bare()
    r.system = [{ type: 'text', text: '你是资深工程师。' }]
    expect(ensureWbAiSystemFirst(r, AI)).toBe(r)
  })

  test('空/纯空白 system 视为没有（照样触发 11128，必须补）', () => {
    for (const text of ['', '   ', '\n']) {
      const r = bare()
      r.system = [{ type: 'text', text }]
      const out = ensureWbAiSystemFirst(r, AI)
      expect(out).not.toBe(r)
      expect(out.system?.length).toBe(2)
      expect(out.system?.[1]).toEqual({ type: 'text', text: WB_AI_FLOOR_SYSTEM })
    }
  })

  test('system 段里全是非 text 块 → 视为没有，补上', () => {
    const r = bare()
    r.system = [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'x' } } as never]
    const out = ensureWbAiSystemFirst(r, AI)
    expect(out).not.toBe(r)
    expect(out.system?.some((b) => b.type === 'text')).toBe(true)
  })

  test('落线形状：补完后 openai-completions 出站首条确为 system', () => {
    // 这是本适配的真正目的——IR 的 system 会被编解码器落成 messages[0]，
    // 所以只需保证 req.system 非空。这里端到端验一次落线结果，防止编解码器改动后失守。
    const out = ensureWbAiSystemFirst(bare(), AI)
    const codec = getOutbound('openai-completions')
    const wire = JSON.parse(new TextDecoder().decode(codec.serializeRequest(out))) as {
      messages: { role: string }[]
    }
    expect(wire.messages[0]?.role).toBe('system')
  })
})

// 回归锚点（用户实测报回）：海外版 system 打头当初只加在转发路径（streamWith），
// 探测/测试路径（streamWithTimeout）漏了 —— 于是「转发能通、点测试报 400 code 11128」，
// 用户看到的是「根本没修好」。两条路径必须走同一个保底函数，这里把它钉死。
describe('applyUpstreamFloors：转发与探测两条路径共用同一套体裁保底', () => {
  const AI = 'https://www.workbuddy.ai/v2'
  const ZEN = 'https://opencode.ai/zen/v1'

  test('海外版：只带 user 的请求经保底后首条变 system', () => {
    const req: IrRequest = {
      model: 'hy3', stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }
    const out = applyUpstreamFloors(req, AI)
    expect(out.system?.length).toBeGreaterThan(0)
    expect(out).not.toBe(req)
  })

  test('zen：同一函数也补 agent 体裁（两条保底互不干扰）', () => {
    const req: IrRequest = {
      model: 'mimo-v2.5-free', stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }
    const out = applyUpstreamFloors(req, ZEN)
    expect(out.tools?.map((t) => t.name)).toEqual([...ZEN_FLOOR_TOOL_NAMES])
    expect(out.toolChoice).toEqual({ mode: 'auto' })
    // zen 不适用 WB 海外版那条：不该被塞 system
    expect(out.system).toBeUndefined()
  })

  test('国内版：两条保底都不适用，原样返回', () => {
    const req: IrRequest = {
      model: 'hy3', stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }
    expect(applyUpstreamFloors(req, 'https://copilot.tencent.com/v2')).toBe(req)
  })

  // 关键：探针请求的形状（probe.probeOne 造的就是这个）必须被兜住。
  // 探针带 maxTokens:16 且只有一条 user —— 正是海外版会拒的形状。
  test('探针形状（maxTokens:16 + 单条 user）在海外版下被补上 system', () => {
    const probeReq: IrRequest = {
      model: 'hy3', stream: true, maxTokens: 16,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }
    const codec = getOutbound('openai-completions')
    const wire = JSON.parse(new TextDecoder().decode(
      codec.serializeRequest(applyUpstreamFloors(probeReq, AI)))) as {
      messages: { role: string }[]
    }
    expect(wire.messages[0]?.role).toBe('system')
  })
})

describe('zen agent 体裁保底 ensureZenAgentShape（2026-09-18 真机取证）', () => {
  // 取证结论：FreeTierError 的另一半开关在请求体——tools 须同时含 read+bash
  // （按名判定，schema 不校验），且 tool_choice 必须显式出现，还须流式。
  // 缺任一项即 403（与指纹头无关的独立判定）；补齐当次转 200。
  const ZEN = 'https://opencode.ai/zen/v1'
  const bare = (): IrRequest => ({
    model: 'mimo-v2.5-free', stream: true,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  const tool = (name: string) => ({ name, description: `${name} file operation.`, inputSchema: { type: 'object', properties: {} } })

  test('非 zen 原样返回（同一引用，不碰别的上游）', () => {
    const r = bare()
    expect(ensureZenAgentShape(r, 'https://api.deepseek.com')).toBe(r)
  })

  test('zen 缺 tools+choice → 补 read/bash + auto，且不改入参', () => {
    const r = bare()
    const out = ensureZenAgentShape(r, ZEN)
    expect(out).not.toBe(r)
    expect(r.tools).toBeUndefined()
    expect(r.toolChoice).toBeUndefined()
    expect(out.tools?.map((t) => t.name)).toEqual([...ZEN_FLOOR_TOOL_NAMES])
    expect(out.toolChoice).toEqual({ mode: 'auto' })
  })

  test('zen 已齐（read+bash+choice）→ 同一引用（一字不动）', () => {
    const r = bare()
    r.tools = [tool('read'), tool('bash')]
    r.toolChoice = { mode: 'auto' }
    expect(ensureZenAgentShape(r, ZEN)).toBe(r)
  })

  test('有 tools 无 choice → 只补 choice，工具原样保留', () => {
    const r = bare()
    r.tools = [tool('read'), tool('bash'), tool('edit')]
    const out = ensureZenAgentShape(r, ZEN)
    expect(out.tools?.map((t) => t.name)).toEqual(['read', 'bash', 'edit'])
    expect(out.toolChoice).toEqual({ mode: 'auto' })
  })

  test('有 choice 无 tools → 补两工具', () => {
    const r = bare()
    r.toolChoice = { mode: 'auto' }
    const out = ensureZenAgentShape(r, ZEN)
    expect(out.tools?.map((t) => t.name)).toEqual([...ZEN_FLOOR_TOOL_NAMES])
    expect(out.toolChoice).toEqual({ mode: 'auto' })
  })

  test('只有假名工具 → 保留假名并补 read/bash（子集语义，不删不改名）', () => {
    const r = bare()
    r.tools = [tool('zen_ping')]
    r.toolChoice = { mode: 'auto' }
    const out = ensureZenAgentShape(r, ZEN)
    expect(out.tools?.map((t) => t.name)).toEqual(['zen_ping', 'read', 'bash'])
  })

  test('线上形态：补齐后经 openai-completions 出站含 tools+choice', () => {
    const out = ensureZenAgentShape(bare(), ZEN)
    const wire = JSON.parse(Buffer.from(getOutbound('openai-completions').serializeRequest(out)).toString()) as {
      tools: { function: { name: string } }[]; tool_choice: unknown; stream: unknown
    }
    expect(wire.tools.map((t) => t.function.name)).toEqual(['read', 'bash'])
    expect(wire.tool_choice).toBe('auto')
    expect(wire.stream).toBe(true)
  })

  test('线上形态：补齐后经 openai-responses 出站含 tools+choice（muse-spark 路径）', () => {
    const out = ensureZenAgentShape(bare(), ZEN)
    const wire = JSON.parse(Buffer.from(getOutbound('openai-responses').serializeRequest(out)).toString()) as {
      tools: { name: string }[]; tool_choice: unknown
    }
    expect(wire.tools.map((t) => t.name)).toEqual(['read', 'bash'])
    expect(wire.tool_choice).toBe('auto')
  })

  // 2026-10-15 修正：垫片工具的 parameters.properties 必须**非空**。
  //
  // 旧结论（「schema 内容不校验，空 parameters 照过」）已失效。新路径下在线二分：
  //   properties={command:{…}} → 200；properties={x:{…}}（假字段）→ 200；
  //   properties={} → 403；properties 缺字段 / null → 403。
  // 即上游只看 properties 非空，字段名与内容不校验。
  //
  // 这条曾是真缺陷：客户端没带 read/bash 时网关补的就是空 schema 垫片，
  // 结果补齐动作本身反而成了恒 403 源。这里把「非空」锁成契约。
  test('垫片工具的 properties 必须非空（空 schema 会被上游判 403）', () => {
    const out = ensureZenAgentShape(bare(), ZEN)
    for (const t of out.tools ?? []) {
      const schema = t.inputSchema as { type?: string; properties?: Record<string, unknown> }
      expect(schema.type).toBe('object')
      expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(0)
    }
    // 出站到 wire 后同样非空（序列化不得把它抺成空）
    const wire = JSON.parse(Buffer.from(getOutbound('openai-completions').serializeRequest(out)).toString()) as {
      tools: { function: { name: string; parameters?: { properties?: Record<string, unknown> } } }[]
    }
    for (const t of wire.tools) {
      expect(Object.keys(t.function.parameters?.properties ?? {}).length).toBeGreaterThan(0)
    }
  })

  // 垫片工具的参数名用真字段名（bash→command / read→filePath）而不是随手编：
  // 万一模型真点了这个垫片，参数名与官方客户端一致，下游处理不会莫名其妙。
  test('垫片工具的参数名与官方客户端一致（bash→command，read→filePath）', () => {
    const out = ensureZenAgentShape(bare(), ZEN)
    const byName = new Map((out.tools ?? []).map((t) => [t.name, t.inputSchema as { properties?: Record<string, unknown> }]))
    expect(Object.keys(byName.get('bash')?.properties ?? {})).toEqual(['command'])
    expect(Object.keys(byName.get('read')?.properties ?? {})).toEqual(['filePath'])
  })
})

// ---- zen 出站指纹体检（2026-10-15 在线二分实测矩阵固化为回归锚点）----
//
// 为什么必须锁住：上游把互不相干的多种拒绝压成**同一句** 403 FreeTierError，
// 网关的旧文案笃定「缺指纹」并只给「去跑一次 opencode」。对 baseURL 还在 /zen、
// UA 缺失、孪生头不一致这三种病因，用户按那句指引做多少遍都不会有任何变化——
// 这是一位真实用户「照着做了两次仍然 403」的直接原因。
// 实测矩阵（Bearer public，逐变量单改，同一真实会话；每格结论见各用例注释）：
//   A 旧路径 /zen + 指纹齐全 → 403    B UA1.19.0 + 缺孪生头 → 403
//   C UA1.19.0 + 有孪生头   → 200    D UA1.18.29 + 无孪生头 → 200
//   E 裸 body（无 tools）    → 403    F 无 UA + 有会话 → 403
//   G 无 UA + 无会话         → 403    H UA1.19.0 + 无会话 → 403
//   I UA1.18.29 + 无会话     → 403    J session≠twin → 403
describe('zen 出站体检：本地可判定项（F~J + 废弃路径）必须先被点名', () => {
  const ZEN_URL = 'https://opencode.ai/inference/v1'

  test('体检通过：UA=1.19.0 + 会话 + 孪生头同值（矩阵 C 那一格）', () => {
    const h: Record<string, string> = {
      'User-Agent': 'opencode/1.19.0',
      'x-opencode-session': 'ses_abcdefgh12345678',
      'x-opencode-session-id': 'ses_abcdefgh12345678',
    }
    expect(zenPreflightReasons(h, ZEN_URL)).toEqual([])
  })

  test('无 UA → 点名 UA（矩阵 F：仅会话救不回来）', () => {
    const h: Record<string, string> = {
      'x-opencode-session': 'ses_abcdefgh12345678',
      'x-opencode-session-id': 'ses_abcdefgh12345678',
    }
    const r = zenPreflightReasons(h, ZEN_URL)
    expect(r.some((x) => x.includes('User-Agent'))).toBe(true)
  })

  test('无会话 → 点名会话（矩阵 G/H/I：有无 UA 都 403）', () => {
    for (const ua of ['', 'opencode/1.19.0', 'opencode/1.18.29']) {
      const h: Record<string, string> = ua === '' ? {} : { 'User-Agent': ua }
      const r = zenPreflightReasons(h, ZEN_URL)
      expect(r.some((x) => x.includes('x-opencode-session'))).toBe(true)
    }
  })

  test('孪生头缺失或不一致 → 点名（矩阵 B/J：两种都 403）', () => {
    const base: Record<string, string> = {
      'User-Agent': 'opencode/1.19.0',
      'x-opencode-session': 'ses_abcdefgh12345678',
    }
    expect(zenPreflightReasons(base, ZEN_URL).some((x) => x.includes('孪生头'))).toBe(true)
    const mismatch = { ...base, 'x-opencode-session-id': 'ses_0000000000000000' }
    expect(zenPreflightReasons(mismatch, ZEN_URL).some((x) => x.includes('孪生头'))).toBe(true)
  })

  test('旧 UA（≤1.18.29）不要求孪生头：体检不因缺它报错（矩阵 D：无孪生头也 200）', () => {
    const h: Record<string, string> = {
      'User-Agent': 'opencode/1.18.29',
      'x-opencode-session': 'ses_abcdefgh12345678',
    }
    // 体检只校验「有就必需同值」，不把「旧 UA 缺孪生头」当成不满足项：
    // 实测该组合 200，报出来会让用户去修一个不存在的毛病。
    expect(zenPreflightReasons(h, ZEN_URL)).toEqual([])
  })

  test('废弃的 /zen 路径必须单独点名（矩阵 A：指纹全对也恒 403）', () => {
    const h: Record<string, string> = {
      'User-Agent': 'opencode/1.19.0',
      'x-opencode-session': 'ses_abcdefgh12345678',
      'x-opencode-session-id': 'ses_abcdefgh12345678',
    }
    const r = zenPreflightReasons(h, 'https://opencode.ai/zen/v1')
    expect(r.some((x) => x.includes('/zen'))).toBe(true)
    expect(r.some((x) => x.includes('/inference'))).toBe(true)
  })

  test('非 zen 上游不体检（任一原因都不产出）', () => {
    expect(zenPreflightReasons({}, 'https://api.example.com/v1')).toEqual([])
  })
})

// 孪生头实测语义（矩阵 B/C/D/J）：**写出去时恒与 session 同值**，
// 而「旧 UA + 缺孪生头」这个组合在当前代码下到达不了（zenHeadersWithFingerprint
// 总是成对写）。这里锁住的是「不会出现不一致」这个不变量，而不是一条分支。
describe('applyZenFingerprint 写出的孪生头恒与 session 同值（矩阵 B/C/J）', () => {
  const SID = 'ses_0b20f9fceffeSFZUUtZpYDSXKH'

  test('UA=1.19.0 + 只有 session → 写出同值孪生头（矩阵 C 的形态）', () => {
    const h: Record<string, string> = {
      'User-Agent': 'opencode/1.19.0',
      'x-opencode-session': SID,
    }
    applyZenFingerprint(h, undefined, true)
    expect(h['x-opencode-session-id']).toBe(SID)
  })

  test('旧 UA 也成对写出（实测该组合 200：矩阵 D 不是靠"不写"通过的）', () => {
    const h: Record<string, string> = {
      'User-Agent': 'opencode/1.18.29',
      'x-opencode-session': SID,
    }
    applyZenFingerprint(h, undefined, true)
    expect(h['x-opencode-session-id']).toBe(SID)
  })

  test('孪生头已存在但与 session 不一致 → 校正为同值（矩阵 J：不一致即 403）', () => {
    const h: Record<string, string> = {
      'User-Agent': 'opencode/1.19.0',
      'x-opencode-session': SID,
      'x-opencode-session-id': 'ses_000000000ffeSFZUUtZpYDSXKH',
    }
    applyZenFingerprint(h, undefined, true)
    expect(h['x-opencode-session-id']).toBe(SID)
  })
})
