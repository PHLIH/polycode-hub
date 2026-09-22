import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { Proxy, noCandidateMessage, sessionHintFromHeaders, mapUpstreamError, collectStreamResponse } from '../src/gateway/proxy.ts'
import { UpstreamError, UPSTREAM, getOutbound } from '../src/ir/index.ts'
import { DEFAULT_FIRST_BYTE_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../src/config/index.ts'
import { Scheduler } from '../src/router/scheduler.ts'
import { Upstream } from '../src/router/upstream.ts'
import { AccountPool } from '../src/pool/account.ts'
import type { Config } from '../src/config/index.ts'
import type { UsageLog } from '../src/model/index.ts'
import '../src/codec/anthropicmessages.ts'
import '../src/codec/openaicompletions.ts'
import '../src/codec/openairesponses.ts'

// 内存用量池（UsageSink 测试替身）
class MemUsage {
  rows: UsageLog[] = []
  async insertLog(l: UsageLog) { this.rows.push({ ...l }) }
}

let up: Server // 上游模拟
let upBase = ''
const upstreamMode: Record<string, (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: string) => void> = {}

beforeAll(async () => {
  up = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString() })
    req.on('end', () => {
      const mode = req.headers['x-mode'] as string
      ;(upstreamMode[mode] ?? ((_, r) => { r.writeHead(404); r.end() }))(req, res, raw)
    })
  })
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r))
  upBase = `http://127.0.0.1:${(up.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => up.close(() => r())))

// 上游行为：openai-completions 协议，SSE 出字
upstreamMode.sse = (_q, res, body) => {
  if (body.includes('"bad"')) { // 请求体含坏标记 → 上游 500（首字节前，可换源）
    res.writeHead(500); res.end('upstream boom'); return
  }
  let stream = true
  try { stream = (JSON.parse(body) as { stream?: boolean }).stream === true } catch { /* 保持流式 */ }
  if (!stream) { // 非流式请求回 JSON 完整体
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 'c1', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write('data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"he"}}]}\n\n')
  res.write('data: {"id":"c1","choices":[{"index":0,"delta":{"content":"llo"}}]}\n\n')
  res.write('data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n')
  res.write('data: [DONE]\n\n')
  res.end()
}

// 首字节前直接 500（换源闸门测试用）
upstreamMode.boom = (_q, res) => { res.writeHead(500); res.end('upstream boom') }

// HTTP 200 但流内是 error 事件（上游 200+错误体形态；闸门已过，透传 + 记失败账）
upstreamMode.streamerror = (_q, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write('data: {"type":"error","error":{"type":"rate_limit_error","message":"[1113] Insufficient balance."}}\n\n')
  res.end()
}

// 第一次请求 401（硬错误：不触发协议自动回退），之后走 sse 成功（账号池换号测试用）
let flip = 0
upstreamMode.flip = (req, res, body) => {
  if (flip++ === 0) { res.writeHead(401); res.end('auth dead'); return }
  upstreamMode.sse!(req, res, body)
}

// 捕获发往上游的请求体（推理预设测试用），行为同 sse（非流式回 JSON）
let lastUpstreamBody = ''
upstreamMode.capture = (req, res, body) => {
  lastUpstreamBody = body
  upstreamMode.sse!(req, res, body)
}

const cfg = (over?: Partial<Config['gateway']>): Config => ({
  gateway: {
    host: '127.0.0.1', port: 0, adminKey: '', gatewayKey: '', defaultModel: '',
    riskMax: 'high', precheckContext: false,
    firstByteTimeoutMs: DEFAULT_FIRST_BYTE_TIMEOUT_MS,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    ...over,
  },
  dataDir: 'data', egresses: [], providers: [], accounts: [],
})

// Provider 夹具：providerId 是内部数字 id（第一个 Provider 为 1，第二个为 2），
// name 是对外名（模型 ID 前缀 name/modelId）。
const provider = (over: Record<string, unknown>) => ({
  providerId: 1, name: 'p1', displayName: '', accessKind: 'official', risk: 'low',
  stability: 'stable', api: 'openai-completions', baseUrl: upBase, credential: {},
  headers: {}, state: 'active', priority: 0, models: [], ...over,
} as never)

const anthropicRequest = (over: Record<string, unknown> = {}) => ({
  model: 'glm-4.6', max_tokens: 64, stream: true,
  messages: [{ role: 'user', content: 'hi' }], ...over,
})

function buildApp(opts: {
  cfg?: Config
  providers?: unknown[]
  pool?: AccountPool
  usage?: MemUsage
  upstream?: Upstream
} = {}): { app: Hono; usage: MemUsage } {
  const usage = opts.usage ?? new MemUsage()
  const cfgv = opts.cfg ?? cfg()
  const sched = new Scheduler((opts.providers ?? [provider({ headers: { 'x-mode': 'sse' } })]) as never[], 'high')
  const px = new Proxy(cfgv, sched, opts.upstream ?? new Upstream(), usage)
  if (opts.pool) px.setAccountPool(opts.pool)
  const app = new Hono()
  px.registerRoutes(app)
  return { app, usage }
}

describe('POST /v1/messages 流式转发（anthropic 入站 × openai-completions 出站）', () => {
  test('SSE 出字 + usage 记账（缓存字段独立、首字延迟）', async () => {
    const { app, usage } = buildApp()
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(anthropicRequest()),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    // IR 事件被 anthropic 入站编解码器序列化回 Anthropic SSE 形态
    expect(text).toContain('event: message_start')
    expect(text).toContain('"text_delta"')
    expect(text).toContain('"type":"message_delta"')
    expect(text).toContain('"stop_reason":"end_turn"')
    // 记账：message_start 带输入侧，message_delta 带输出侧。
    // MemUsage 是直存替身（不经 Store 口径）：总量由 Store.insertLog 落库时统一口径，
    // 此处只断言分量（input/output），总量不断言（逐事件 merge 时语义未知，早算必错一边）。
    const ul = usage.rows[0]!
    expect(ul.status).toBe('ok')
    expect(ul.stream).toBe(true)
    expect(ul.inputTokens).toBe(3)
    expect(ul.outputTokens).toBe(2)
    expect(ul.firstTokenMs).toBeGreaterThanOrEqual(0)
    // 对齐 Go：openai 系流事件不带 accuracy（零值），merge 不触发，落库 unknown
    expect(ul.accuracy).toBe('unknown')
  })

  test('非流式请求整体转换', async () => {
    const { app, usage } = buildApp()
    const res = await app.request('/v1/messages', {
      method: 'POST', body: JSON.stringify(anthropicRequest({ stream: false })),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { content: { text: string }[]; stop_reason: string }
    expect(body.content[0]!.text).toBe('hello')
    expect(body.stop_reason).toBe('end_turn')
    expect(usage.rows[0]!.stream).toBe(false)
  })

  test('裸路径别名 /chat/completions 走同一处理器', async () => {
    const { app } = buildApp()
    const res = await app.request('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'glm-4.6', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('[DONE]')
  })

  test('流内 error 事件：透传给 client + 记 upstream_error（HTTP 200 但上游报错）', async () => {
    const { app, usage } = buildApp({
      providers: [provider({ api: 'anthropic-messages', headers: { 'x-mode': 'streamerror' } })],
    })
    const res = await app.request('/v1/messages', { method: 'POST', body: JSON.stringify(anthropicRequest()) })
    expect(res.status).toBe(200)
    await res.text()
    const ul = usage.rows.at(-1)!
    expect(ul.status).toBe('upstream_error')
    expect(ul.errorKind).toBe('rate_limit')
  })

  test('GET /v1/models 返回 name/modelId 限定名目录', async () => {
    const { app } = buildApp({ providers: [provider({ models: [{ id: 'glm-4.6', manual: false, enabled: true }] })] })
    const res = await app.request('/v1/models')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { id: string; object: string; owned_by: string }[] }
    // 前缀是 Provider 的 name（客户端从 /v1/models 拿到什么就填什么）
    expect(body.data).toEqual([{ id: 'p1/glm-4.6', object: 'model', owned_by: 'p1' }])
  })
})

describe('客户端推理档位透传（端到端）', () => {
  const chatBody = (over: Record<string, unknown> = {}) => ({
    model: 'p1/m1', stream: false,
    messages: [{ role: 'user', content: 'hi' }], ...over,
  })
  const pv = (modelOver: Record<string, unknown>) => provider({
    headers: { 'x-mode': 'capture' },
    models: [{ id: 'm1', manual: false, enabled: true, ...modelOver }],
  })

  test('跟随客户端透传（没传就不发）', async () => {
    const { app } = buildApp({ providers: [pv({})] })
    const res = await app.request('/v1/chat/completions', {
      method: 'POST', body: JSON.stringify(chatBody({ reasoning_effort: 'high' })),
    })
    expect(res.status).toBe(200)
    await res.json()
    expect(JSON.parse(lastUpstreamBody).reasoning_effort).toBe('high')

    const res2 = await app.request('/v1/chat/completions', {
      method: 'POST', body: JSON.stringify(chatBody()),
    })
    expect(res2.status).toBe(200)
    await res2.json()
    expect(JSON.parse(lastUpstreamBody)).not.toHaveProperty('reasoning_effort')
  })

  test('模型推理等级预设：配了就强制覆盖客户端档位；follow/未配置透传', async () => {
    // 预设 high：客户端发的 xhigh 被替换，客户端没发也注入
    const { app } = buildApp({ providers: [pv({ reasoningEffort: 'high' })] })
    const r1 = await app.request('/v1/chat/completions', {
      method: 'POST', body: JSON.stringify(chatBody({ reasoning_effort: 'xhigh' })),
    })
    expect(r1.status).toBe(200)
    await r1.json()
    expect(JSON.parse(lastUpstreamBody).reasoning_effort).toBe('high')

    const r2 = await app.request('/v1/chat/completions', {
      method: 'POST', body: JSON.stringify(chatBody()),
    })
    expect(r2.status).toBe(200)
    await r2.json()
    expect(JSON.parse(lastUpstreamBody).reasoning_effort).toBe('high')

    // follow（跟随上游）= 透传：客户端发什么发什么，没发不发
    const { app: app2 } = buildApp({ providers: [pv({ reasoningEffort: 'follow' })] })
    const r3 = await app2.request('/v1/chat/completions', {
      method: 'POST', body: JSON.stringify(chatBody({ reasoning_effort: 'max' })),
    })
    expect(r3.status).toBe(200)
    await r3.json()
    expect(JSON.parse(lastUpstreamBody).reasoning_effort).toBe('max')
    const r4 = await app2.request('/v1/chat/completions', {
      method: 'POST', body: JSON.stringify(chatBody()),
    })
    expect(r4.status).toBe(200)
    await r4.json()
    expect(JSON.parse(lastUpstreamBody)).not.toHaveProperty('reasoning_effort')
  })

  test('档位预算上限：按生效档位压超限 maxTokens，只压不抬', async () => {
    const { app } = buildApp({ providers: [pv({ reasoningMaxTokens: { xhigh: 65536, high: 32768 } })] })
    // xhigh + 超限预算 → 压到 65536
    const r1 = await app.request('/v1/chat/completions', {
      method: 'POST', body: JSON.stringify(chatBody({ reasoning_effort: 'xhigh', max_tokens: 200000 })),
    })
    expect(r1.status).toBe(200)
    await r1.json()
    expect(JSON.parse(lastUpstreamBody).max_tokens).toBe(65536)
    // xhigh + 低于上限 → 不动
    const r2 = await app.request('/v1/chat/completions', {
      method: 'POST', body: JSON.stringify(chatBody({ reasoning_effort: 'xhigh', max_tokens: 1024 })),
    })
    expect(r2.status).toBe(200)
    await r2.json()
    expect(JSON.parse(lastUpstreamBody).max_tokens).toBe(1024)
    // 键没命中的档位不动
    const r3 = await app.request('/v1/chat/completions', {
      method: 'POST', body: JSON.stringify(chatBody({ reasoning_effort: 'low', max_tokens: 999999 })),
    })
    expect(r3.status).toBe(200)
    await r3.json()
    expect(JSON.parse(lastUpstreamBody).max_tokens).toBe(999999)
  })

  test('预设与上限叠加：先覆盖档位，再按覆盖后的档位压预算', async () => {
    const { app } = buildApp({ providers: [pv({ reasoningEffort: 'high', reasoningMaxTokens: { high: 32768 } })] })
    // 客户端发 xhigh + 大预算：档位被覆盖成 high，预算按 high 的上限压
    const r1 = await app.request('/v1/chat/completions', {
      method: 'POST', body: JSON.stringify(chatBody({ reasoning_effort: 'xhigh', max_tokens: 100000 })),
    })
    expect(r1.status).toBe(200)
    await r1.json()
    const up = JSON.parse(lastUpstreamBody)
    expect(up.reasoning_effort).toBe('high')
    expect(up.max_tokens).toBe(32768)
  })
})

describe('换源闸门（端到端）', () => {
  test('首字节前失败（500）→ 自动换下一个候选 Provider', async () => {
    const { app, usage } = buildApp({
      providers: [provider({ name: 'bad', headers: { 'x-mode': 'boom' } }), provider({ name: 'good', providerId: 2, headers: { 'x-mode': 'sse' } })],
    })
    const res = await app.request('/v1/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest()),
    })
    expect(res.status).toBe(200) // good 顶上
    expect((await res.text())).toContain('message_start')
    // 失败 Provider 不记成功账；成功记账 providerId=2（good）
    expect(usage.rows.map((r) => r.providerId)).toEqual([2])
  })

  test('全部候选失败 → 映射规范错误（429/401/529/500）+ 失败记账', async () => {
    const { app, usage } = buildApp({ providers: [provider({ name: 'only', headers: { 'x-mode': 'boom' } })] })
    const res = await app.request('/v1/messages', {
      method: 'POST', body: JSON.stringify(anthropicRequest({ model: 'only/glm-4.6' })),
    })
    expect(res.status).toBe(500) // upstream server → api_error
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe('api_error')
    expect(usage.rows[0]!.status).toBe('upstream_error')
    expect(usage.rows[0]!.errorKind).toBe('server') // 失败原因落库（ACCOUNT-HEALTH）
  })

  test('账号池：同源多账号失败换号，冷却后跳过', async () => {
    const pool = new AccountPool([
      { id: 'a-bad', providerId: 1, credential: {}, status: 'available', fails: 0 },
      { id: 'a-good', providerId: 1, credential: {}, status: 'available', fails: 0 },
    ])
    const { app, usage } = buildApp({
      pool,
      providers: [provider({ headers: { 'x-mode': 'flip' } })],
    })
    // 上游首个请求 401 → a-bad 冷却 → 换 a-good 重试成功
    const res = await app.request('/v1/messages', {
      method: 'POST',
      body: JSON.stringify(anthropicRequest()),
    })
    expect(res.status).toBe(200)
    await res.text() // 消费响应流：流式记账在读完后落盘
    const good = usage.rows.find((r) => r.status === 'ok')!
    expect(good.accountId).toBe('a-good')
    expect(pool.snapshot().find((a) => a.id === 'a-bad')!.fails).toBe(1)
  })

  test('账号轮换：4 个账号前 3 个坏 → 第 4 个必须被试到（上界=账号数）', async () => {
    // 回归锚点：旧代码上界取 cands.length + 1（候选 Provider 数），单 Provider
    // 时上界为 2——5 个号只试 2 个，第 3 个起的好号根本没被问过。
    // 只对前三次请求 401，第四次起放行（上游按 x-mode=flip 走本 handler）
    let n = 0
    upstreamMode.flip = (_q, res) => {
      n++
      if (n <= 3) { res.writeHead(401); res.end('nope'); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\n')
      res.write('data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    }
    const pool = new AccountPool([
      { id: 'b1', providerId: 1, credential: {}, status: 'available', fails: 0 },
      { id: 'b2', providerId: 1, credential: {}, status: 'available', fails: 0 },
      { id: 'b3', providerId: 1, credential: {}, status: 'available', fails: 0 },
      { id: 'b4', providerId: 1, credential: {}, status: 'available', fails: 0 },
    ])
    const { app, usage } = buildApp({
      providers: [provider({ headers: { 'x-mode': 'flip' } })],
      pool,
    })
    const res = await app.request('/v1/messages', { method: 'POST', body: JSON.stringify(anthropicRequest()) })
    expect(res.status).toBe(200)
    await res.text() // 消费流
    const ok = usage.rows.find((r) => r.status === 'ok')!
    expect(ok.accountId).toBe('b4') // 第 4 个号被试到并成功（旧代码上界 2，必失败）
  })

  test('账号池全失败：兜底账归因到最后尝试的账号 + errorKind', async () => {
    upstreamMode.unauth = (_q, res) => { res.writeHead(401); res.end('nope') }
    const pool = new AccountPool([
      { id: 'z1', providerId: 1, credential: {}, status: 'available', fails: 0 },
      { id: 'z2', providerId: 1, credential: {}, status: 'available', fails: 0 },
    ])
    const { app, usage } = buildApp({
      providers: [provider({ headers: { 'x-mode': 'unauth' } })],
      pool,
    })
    const res = await app.request('/v1/messages', { method: 'POST', body: JSON.stringify(anthropicRequest()) })
    expect(res.status).toBe(401)
    await res.text()
    const ul = usage.rows.at(-1)!
    expect(ul.status).toBe('upstream_error')
    expect(ul.errorKind).toBe('auth')
    expect(ul.accountId).toBe('z2') // 最后一次尝试的账号
    expect(pool.snapshot().every((a) => a.status === 'cooldown')).toBe(true)
  })

  test('限流错误冷却账号 1 分钟（cooldownFor）', async () => {
    upstreamMode.ratelimit = (_q, res) => { res.writeHead(429); res.end('{"error":"rate"}') }
    const pool = new AccountPool([{ id: 'a1', providerId: 1, credential: {}, status: 'available', fails: 0 }])
    const { app, usage } = buildApp({
      providers: [provider({ headers: { 'x-mode': 'ratelimit' } })],
      pool,
    })
    await app.request('/v1/messages', { method: 'POST', body: JSON.stringify(anthropicRequest()) })
    const a = pool.snapshot()[0]!
    expect(a.status).toBe('cooldown')
    expect(a.cooldownUntil!.getTime()).toBeGreaterThanOrEqual(Date.now() + 55_000)
    // 兜底记账带失败原因
    await new Promise((r) => setTimeout(r, 10))
    const fail = usage.rows.at(-1)!
    expect(fail.errorKind).toBe('rate_limit')
  })
})

describe('指定账号头 x-polycode-account（不轮询、不回退）', () => {
  const pinnedProviders = () => [provider({ headers: { 'x-mode': 'sse' } })]
  const pinnedPool = () => new AccountPool([
    { id: 'a1', providerId: 1, credential: {}, status: 'available', fails: 0 },
    { id: 'a2', providerId: 1, credential: {}, status: 'available', fails: 0 },
  ])
  const pinnedBody = () => anthropicRequest()

  test('指定 a2：走 a2 记账，不轮询到 a1（连续两次都落 a2）', async () => {
    const { app, usage } = buildApp({ providers: pinnedProviders(), pool: pinnedPool() })
    for (let i = 0; i < 2; i++) {
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'x-polycode-account': 'a2' },
        body: JSON.stringify(pinnedBody()),
      })
      expect(res.status).toBe(200)
      await res.text() // 消费流：流式记账在读完后落盘
    }
    expect(usage.rows.map((r) => r.accountId)).toEqual(['a2', 'a2'])
  })

  test('账号不存在 → 404，不向上游发请求、不记账', async () => {
    const { app, usage } = buildApp({ providers: pinnedProviders(), pool: pinnedPool() })
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'x-polycode-account': 'nope' },
      body: JSON.stringify(pinnedBody()),
    })
    expect(res.status).toBe(404)
    expect(usage.rows.length).toBe(0)
  })

  test('归属不匹配（a1 属 #1，模型限定 p2）→ 400，不偷偷换号', async () => {
    const { app } = buildApp({
      providers: [provider({ name: 'p1' }), provider({ name: 'p2', providerId: 2 })],
      pool: pinnedPool(),
    })
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'x-polycode-account': 'a1' },
      body: JSON.stringify(anthropicRequest({ model: 'p2/m' })),
    })
    expect(res.status).toBe(400)
  })

  test('冷却中账号 → 429，不偷偷换号', async () => {
    const pool = pinnedPool()
    pool.markResult('a2', false, 60_000, new Date())
    const { app, usage } = buildApp({ providers: pinnedProviders(), pool })
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'x-polycode-account': 'a2' },
      body: JSON.stringify(pinnedBody()),
    })
    expect(res.status).toBe(429)
    expect(usage.rows.length).toBe(0)
    // 没换号：a1 仍可用且 fails 为 0（没被碰过）
    expect(pool.snapshot().find((a) => a.id === 'a1')!.fails).toBe(0)
  })

  test('指定账号上游失败 → 透出错误且记账归因该账号（不换号）', async () => {
    upstreamMode.always500 = (_q, res) => { res.writeHead(500); res.end('boom') }
    const { app, usage } = buildApp({
      providers: [provider({ headers: { 'x-mode': 'always500' } })],
      pool: pinnedPool(),
    })
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'x-polycode-account': 'a1' },
      body: JSON.stringify(pinnedBody()),
    })
    expect(res.status).toBe(500)
    await res.text()
    // 失败账归因指定账号；另一个账号没被碰过
    expect(usage.rows.at(-1)!.accountId).toBe('a1')
  })

  test('不带头时行为不变：仍轮询（a1/a2 交替）', async () => {
    const { app, usage } = buildApp({ providers: pinnedProviders(), pool: pinnedPool() })
    for (let i = 0; i < 2; i++) {
      const res = await app.request('/v1/messages', {
        method: 'POST', body: JSON.stringify(pinnedBody()),
      })
      expect(res.status).toBe(200)
      await res.text()
    }
    expect(usage.rows.map((r) => r.accountId)).toEqual(['a1', 'a2'])
  })

  test('显式指定账号不受任何 Provider 配置约束（白名单已删除）', async () => {
    const { app, usage } = buildApp({ providers: pinnedProviders(), pool: pinnedPool() })
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'x-polycode-account': 'a2' },
      body: JSON.stringify(pinnedBody()),
    })
    expect(res.status).toBe(200)
    await res.text()
    expect(usage.rows.map((r) => r.accountId)).toEqual(['a2'])
  })
})

describe('网关自身鉴权', () => {
  test('gateway_key 缺失 → 401 authentication_error', async () => {
    const { app } = buildApp({ cfg: cfg({ gatewayKey: 'sekret' }) })
    const res = await app.request('/v1/messages', { method: 'POST', body: JSON.stringify(anthropicRequest()) })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe('authentication_error')
  })

  test('Bearer 正确 → 放行', async () => {
    const { app } = buildApp({ cfg: cfg({ gatewayKey: 'sekret' }) })
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer sekret' },
      body: JSON.stringify(anthropicRequest()),
    })
    expect(res.status).toBe(200)
  })
})

describe('默认模型与错误形状', () => {
  test('model 为空时填 default_model', async () => {
    const { app } = buildApp({ cfg: cfg({ defaultModel: 'glm-4.6' }) })
    const res = await app.request('/v1/messages', {
      method: 'POST', body: JSON.stringify(anthropicRequest({ model: undefined })),
    })
    expect(res.status).toBe(200)
  })

  test('无候选 Provider → 404 not_found_error', async () => {
    const { app } = buildApp({ providers: [] })
    const res = await app.request('/v1/messages', { method: 'POST', body: JSON.stringify(anthropicRequest()) })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe('not_found_error')
  })

  test('非法 JSON → 400 invalid_request_error', async () => {
    const { app } = buildApp()
    const res = await app.request('/v1/messages', { method: 'POST', body: '{oops' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe('invalid_request_error')
  })
})

describe('模型级 egress（EGRESS-SPIKE §7 粒度拍板：精确到模型）', () => {
  test('模型声明的 egress 覆盖 Provider 级（Provider 指向未配置出口，覆盖不生效则必败）', async () => {
    const { app } = buildApp({
      upstream: new Upstream({ egresses: { ok: upBase } }),
      providers: [provider({
        headers: { 'x-mode': 'sse' },
        egress: 'missing',
        models: [{ id: 'glm-4.6', manual: true, enabled: true, egress: 'ok' }],
      })],
    })
    const res = await app.request('/v1/messages', {
      method: 'POST', body: JSON.stringify(anthropicRequest()),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('llo')
  })
})

describe('GET /health（technical-design §3.2 契约）', () => {
  test('返回 {ok:true, apps:N} —— N 为参与路由中的上游数', async () => {
    const { app } = buildApp({
      providers: [
        provider({ headers: { 'x-mode': 'sse' } }),
        provider({ headers: { 'x-mode': 'sse' }, name: 'p2', providerId: 2 }),
      ],
    })
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; apps: number }
    expect(body.ok).toBe(true)
    expect(body.apps).toBe(2)
  })

  test('非 active 的 Provider 不计入 apps（监控看到的是真能用的数量）', async () => {
    const paused = provider({ headers: { 'x-mode': 'sse' }, name: 'p2', providerId: 2, state: 'paused' })
    const deleted = provider({ headers: { 'x-mode': 'sse' }, name: 'p3', providerId: 3, state: 'deleted' })
    const { app } = buildApp({ providers: [provider({ headers: { 'x-mode': 'sse' } }), paused, deleted] })
    const body = await (await app.request('/health')).json() as { apps: number }
    expect(body.apps).toBe(1)
  })
})

// 上游挂住不返回：网关必须自己掐断，不能陪着一起挂。
//
// 真实缺陷（2026-09-14，用户报「opencode 模型都不能用，一直卡住，不报错也不成功」）：
// 转发路径 upstream.stream() → reader.read() 全程没有超时。上游接受连接后
// 不回数据（免费档被限速/排队时常见，实测 mimo-v2.5-free 有 83 秒的请求），
// 客户端就只能干等——不报错、不成功、也无法判断该重试还是该放弃。
// 探测路径有 streamWithTimeout，转发路径却漏了，这里补齐。
upstreamMode.stall = (_q, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write(': keep-alive\n\n') // 只有注释行，永远不出真实事件，也不结束
  // 故意不 res.end()
}

describe('上游挂住不返回：必须掐断而不是无限等', () => {
  test('首字节前挂住 → 在有限时间内返回错误，而不是永远 pending', async () => {
    const { app } = buildApp({
      providers: [provider({ headers: { 'x-mode': 'stall' } })],
      // 把首字节超时压到 300ms，测试别真等 60 秒
      cfg: cfg({ firstByteTimeoutMs: 300 }),
    })
    const t0 = Date.now()
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(anthropicRequest()),
    })
    const ms = Date.now() - t0
    // 不能挂：必须给出结果
    expect(ms).toBeLessThan(5000)
    expect(res.status).toBeGreaterThanOrEqual(400)
    const text = await res.text()
    expect(text).toMatch(/timeout|超时|upstream/i)
  })

  test('正常流不受影响（超时只打挂住的，不误伤慢的）', async () => {
    const { app } = buildApp({
      providers: [provider({ headers: { 'x-mode': 'sse' } })],
      cfg: cfg({ firstByteTimeoutMs: 300 }),
    })
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(anthropicRequest()),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('message_stop')
  })
})

// ---- 候选为空的诊断文案（用户按提示能不能找到原因）----

describe('noCandidateMessage：诊断要说出真实原因', () => {
  const mk = (over: Record<string, unknown>) => ({
    providerId: 5, name: 'wb', state: 'active', displayName: '', accessKind: 'official',
    risk: 'low', stability: 'stable', api: '', baseUrl: 'https://x', credential: {},
    priority: 0, models: [{ id: 'hy4', manual: false, enabled: true }], ...over,
  }) as never

  // 回归（真实踩坑）：workbuddy 是 streamOnly，非流式请求被
  // `!stream && p.streamOnly` 排除，旧文案却说「没有声明模型」——
  // 用户照着去核对模型列表永远查不出所以然（模型明明列在 /v1/models 里）。
  test('streamOnly 的 Provider 在非流式调用下要点名"只支持流式"', () => {
    const ps = [mk({ streamOnly: true })]
    const msg = noCandidateMessage('wb/hy4', ps, false)
    expect(msg).toContain('只支持流式')
    expect(msg).toContain('stream:true')
    // 不该再误导成「没有声明模型」
    expect(msg).not.toContain('没有声明模型')
  })

  test('同 Provider 混合时（部分 streamOnly）保留原诊断并附带流式提示', () => {
    const ps = [mk({ streamOnly: true, providerId: 1 }), mk({ streamOnly: false, providerId: 2 })]
    const msg = noCandidateMessage('wb/nope', ps, false)
    expect(msg).toContain('没有声明模型')
    expect(msg).toContain('只支持流式')
  })

  test('流式调用下不冒出流式提示（原因不成立就不该提）', () => {
    const msg = noCandidateMessage('wb/hy4', [mk({ streamOnly: true })], true)
    expect(msg).toContain('没有声明模型')
    expect(msg).not.toContain('只支持流式')
  })

  test('已删除 / 已暂停 / 未知前缀各自点名', () => {
    expect(noCandidateMessage('wb/hy4', [mk({ state: 'deleted' })])).toContain('已删除')
    expect(noCandidateMessage('wb/hy4', [mk({ state: 'paused' })])).toContain('已暂停')
    expect(noCandidateMessage('zz/hy4', [mk({})])).toContain('未知的 Provider 前缀')
  })
})

describe('sessionHintFromHeaders（客户端指纹透传，zen 指纹）', () => {
  const get = (m: Record<string, string>) => (n: string) => m[n]
  test('会话双头同值透传；缺 affinity 时跟 id；UA 一并透传', () => {
    expect(sessionHintFromHeaders(get({ 'x-session-id': 'ses_a', 'x-session-affinity': 'ses_a' })))
      .toEqual({ id: 'ses_a', affinity: 'ses_a' })
    expect(sessionHintFromHeaders(get({ 'x-session-id': 'ses_a' })))
      .toEqual({ id: 'ses_a', affinity: 'ses_a' })
    expect(sessionHintFromHeaders(get({
      'x-session-id': 'ses_a', 'user-agent': 'opencode/1.2.3 live',
    }))).toEqual({ id: 'ses_a', affinity: 'ses_a', userAgent: 'opencode/1.2.3 live' })
  })
  test('无会话但有 UA：照透 UA（网关不判断、落头前 sanitize）', () => {
    expect(sessionHintFromHeaders(get({ 'user-agent': 'opencode/1.2.3 live' })))
      .toEqual({ userAgent: 'opencode/1.2.3 live' })
  })
  test('全无 / 会话脏值且无 UA → undefined（不透传垃圾）', () => {
    expect(sessionHintFromHeaders(get({}))).toBeUndefined()
    expect(sessionHintFromHeaders(get({ 'x-session-id': 'has space!' }))).toBeUndefined()
    expect(sessionHintFromHeaders(get({ 'x-session-id': '' }))).toBeUndefined()
  })
})

describe('mapUpstreamError：推理参数 400（按“发过档位”触发，不猜文本语言）', () => {
  const bad = (msg: string) => new UpstreamError(400, UPSTREAM.BAD_REQUEST, msg)

  test('发过档位 + bad_request → 附档位指引（中英文报错都一样）', () => {
    const en = mapUpstreamError(bad("reasoning_effort 'minimal' is not supported"), 'minimal')
    expect(en.type).toBe('api_error')
    expect(en.httpStatus).toBe(500)
    expect(en.message).toContain('推理强度')
    const zh = mapUpstreamError(bad('不支持的推理档位'), 'high')
    expect(zh.message).toContain('推理强度')
  })

  test('没发过档位 → 不带指引（别狼来了）', () => {
    const e = mapUpstreamError(bad("reasoning_effort 'minimal' is not supported"))
    expect(e.message).not.toContain('推理强度')
    const e2 = mapUpstreamError(bad('404 Route Not Found'), '')
    expect(e2.message).not.toContain('推理强度')
  })

  test('其它 kind 不受影响', () => {
    expect(mapUpstreamError(new UpstreamError(429, UPSTREAM.RATE_LIMIT, 'slow')).type).toBe('rate_limit_error')
    // 限流即使发过档位也不指引：病因是限流不是档位
    expect(mapUpstreamError(new UpstreamError(429, UPSTREAM.RATE_LIMIT, 'slow'), 'high').message)
      .not.toContain('推理强度')
    expect(mapUpstreamError(undefined).message).toBe('无可用上游')
  })
})

describe('mapUpstreamError：指纹拒绝指引含体裁说明（2026-09-18 取证）', () => {
  // zen 免费档的拒绝有两半开关：指纹头 + agent 体裁（read/bash 工具声明 +
  // tool_choice，且须流式）。网关转发时已自动补工具声明，非流式则在内部改走
  // 流式上游并拼包返回——指引如实说明这两点，不再要求客户端改流式。
  test('FINGERPRINT 指引保留刷新入口，并点名体裁与拼包', () => {
    const e = mapUpstreamError(new UpstreamError(403, UPSTREAM.FINGERPRINT, 'free tier'))
    expect(e.type).toBe('authentication_error')
    expect(e.httpStatus).toBe(401)
    expect(e.message).toContain('refresh-fingerprint')
    expect(e.message).toContain('read/bash')
    expect(e.message).toContain('拼包')
  })
})

describe('collectStreamResponse：SSE 收齐拼单包（非流式兜底）', () => {
  const enc = new TextEncoder()
  const B = (s: string) => enc.encode(s)
  const streamOf = (chunks: string[]) => new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(B(s))
      c.close()
    },
  })
  const out = () => getOutbound('openai-completions')

  test('文本分片拼接 + 用量合并 + stopReason', async () => {
    const rc = streamOf([
      'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"he"}}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"llo"}}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ])
    const resp = await collectStreamResponse(out(), rc)
    expect(resp.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(resp.stopReason).toBe('end_turn')
    expect(resp.usage.inputTokens).toBe(3)
    expect(resp.usage.outputTokens).toBe(2)
    expect(resp.id).toBe('c1')
  })

  test('tool_use 跨块 JSON 拼装', async () => {
    const rc = streamOf([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"t1","type":"function","function":{"name":"read","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"p\\":"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ])
    const resp = await collectStreamResponse(out(), rc)
    expect(resp.stopReason).toBe('tool_use')
    expect(resp.content).toEqual([{ type: 'tool_use', id: 't1', name: 'read', input: { p: 1 } }])
  })

  test('流内 error 事件：有好内容则跳过坏行照回，无内容才抛错', async () => {
    // openai 解析器把“非法 JSON 行”转成 error 事件（合法 JSON 的错误包络无 choices，直接忽略）。
    const badThenGood = streamOf([
      'data: {not json}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ])
    const resp = await collectStreamResponse(out(), badThenGood)
    expect(resp.content).toEqual([{ type: 'text', text: 'hi' }])
    const onlyBad = streamOf(['data: {not json}\n\n', 'data: [DONE]\n\n'])
    await expect(collectStreamResponse(out(), onlyBad)).rejects.toThrow('合法 JSON')
  })

  test('空流返回空内容（不断言）', async () => {
    const resp = await collectStreamResponse(out(), streamOf(['data: [DONE]\n\n']))
    expect(resp.content).toEqual([])
    expect(resp.usage.accuracy).toBe('unknown')
  })

  // 回归：上游发完 2xx 响应头就挂住（免费额度上游常见）。没有这两道闸，
  // reader.read() 永远 pending：连接、reader、usage 记账全部悬挂。
  test('上游从不吐块：首字节闸掐断并抛 UpstreamError(网络)', async () => {
    const hang = new ReadableStream<Uint8Array>({ start() { /* 永不 enqueue、永不 close */ } })
    let caught: unknown
    try {
      await collectStreamResponse(out(), hang, { firstByteTimeoutMs: 30, idleTimeoutMs: 60_000 })
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(UpstreamError)
    expect((caught as UpstreamError).kind).toBe(UPSTREAM.NETWORK)
    expect((caught as UpstreamError).message).toContain('首字节')
  })

  test('上游吐一块后挂住：静默闸掐断并抛 UpstreamError(网络)', async () => {
    const oneThenHang = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(B('data: [DONE]\n\n')) /* 之后永不 close */ },
    })
    let caught: unknown
    try {
      await collectStreamResponse(out(), oneThenHang, { firstByteTimeoutMs: 60_000, idleTimeoutMs: 30 })
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(UpstreamError)
    expect((caught as UpstreamError).kind).toBe(UPSTREAM.NETWORK)
    expect((caught as UpstreamError).message).toContain('静默超时')
  })
})

describe('非流式客户端经内部流式上游拼包返回（全源生效）', () => {
  test('上游收到 stream:true，客户端拿到单包 JSON + stream=false 记账', async () => {
    const { app, usage } = buildApp({
      providers: [provider({ headers: { 'x-mode': 'capture' } })],
    })
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'p1/m1', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    // 网关内部改走流式：桩服务看到的必须是 stream:true（否则回的是 JSON 整包，拼包无意义）
    expect(JSON.parse(lastUpstreamBody).stream).toBe(true)
    const body = (await res.json()) as { choices: { message: { content: string } }[] }
    expect(body.choices[0]!.message.content).toBe('hello')
    // 记账仍按客户端形态：stream=false
    expect(usage.rows[0]!.stream).toBe(false)
    expect(usage.rows[0]!.status).toBe('ok')
  })
})
