import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { Upstream, joinURL, probeOrder, shouldTryOtherProtocol, resolveProtocol, egressProxyURI, buildRequestURL, classifyUpstreamError, applyZenFingerprint, sanitizeUA, summarizeUpstreamBody, ensureZenAgentShape, ZEN_FLOOR_TOOL_NAMES } from '../src/router/upstream.ts'
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

  test('shouldTryOtherProtocol：5xx/网络/400 可试；凭据/限流硬错误不试', () => {
    const e = (kind: string) => new UpstreamError(0, kind, 'x')
    expect(shouldTryOtherProtocol(e(UPSTREAM.SERVER))).toBe(true)
    expect(shouldTryOtherProtocol(e(UPSTREAM.NETWORK))).toBe(true)
    expect(shouldTryOtherProtocol(e(UPSTREAM.BAD_REQUEST))).toBe(true)
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
  test('x-opencode-* 四件套保留并补全（大小写不敏感，不再删除）', () => {
    const h: Record<string, string> = {
      'x-opencode-client': 'cli', 'X-OpenCode-Project': 'global',
      'x-opencode-request': 'msg_x', 'x-opencode-session': 'ses_x',
      'Content-Type': 'application/json',
    }
    applyZenFingerprint(h, { id: 'ses_real' }, true, '')
    expect(h['x-opencode-session']).toBe('ses_x') // 客户端透传不再覆盖静态
    expect(h['x-opencode-request']).toBe('msg_x') // 静态 request 保留（真机一次会话内稳定）
    expect(h['Content-Type']).toBe('application/json') // 无关头不动
    // 大小写不敏感：X-OpenCode-Project 就地识别，不新增重复键
    expect(Object.keys(h).filter((k) => k.toLowerCase() === 'x-opencode-project')).toHaveLength(1)
  })

  test('旧 x-session-id 晋升为 x-opencode-session；缺 request 则现铸', () => {
    const h: Record<string, string> = { 'x-session-id': 'ses_legacy' }
    applyZenFingerprint(h, undefined, true, '')
    expect(h['x-opencode-session']).toBe('ses_legacy')
    expect(h['x-opencode-request']).toMatch(/^msg_[A-Za-z0-9]{24}$/)
    expect(h['x-opencode-client']).toBe('cli')
    expect(h['x-opencode-project']).toBe('global')
  })

  test('显式配的 client/project 不覆盖；脏会话不硬凑', () => {
    const h: Record<string, string> = {
      'x-opencode-client': 'mine', 'x-opencode-project': 'proj9',
      'x-opencode-session': 'ses_static',
    }
    applyZenFingerprint(h, { id: 'has space!' }, true, '')
    expect(h['x-opencode-session']).toBe('ses_static') // 脏透传回退静态
    expect(h['x-opencode-client']).toBe('mine')
    expect(h['x-opencode-project']).toBe('proj9')
    const h2: Record<string, string> = {}
    applyZenFingerprint(h2, { id: '' }, true, '')
    expect(h2['x-opencode-session']).toBeUndefined()
    expect(h2['x-session-id']).toBeUndefined()
  })

  test('UA 补位：静态优先（已配不动）；缺时用 ZEN_UA；全无不发；客户端 UA 永不采用', () => {
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
    applyZenFingerprint(h3, { id: 'ses_x' }, true, 'opencode/0.0.0 env')
    expect(h3['User-Agent']).toBe('opencode/0.0.0 env')
    // 全都没有：如实不发，不编版本号
    const h4: Record<string, string> = {}
    applyZenFingerprint(h4, { id: 'ses_x' }, true, '')
    expect(h4['User-Agent']).toBeUndefined()
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

  test('会话头：静态为准，affinity 恒跟 sid；客户端透传一律忽略', () => {
    const h1: Record<string, string> = { 'x-session-id': 'ses_static', 'x-session-affinity': 'ses_static' }
    applyZenFingerprint(h1, { id: 'ses_live', affinity: 'ses_live' })
    expect(h1['x-session-id']).toBe('ses_static')
    expect(h1['x-session-affinity']).toBe('ses_static')
    const h2: Record<string, string> = {}
    applyZenFingerprint(h2, { id: 'ses_live' })
    expect(h2['x-session-id']).toBeUndefined()
    expect(h2['x-session-affinity']).toBeUndefined() // 无静态可退：不硬凑
    const h3: Record<string, string> = { 'x-session-id': 'ses_static' }
    applyZenFingerprint(h3) // 无透传：静态保留并补 affinity
    expect(h3['x-session-id']).toBe('ses_static')
    expect(h3['x-session-affinity']).toBe('ses_static')
  })

  test('非法会话值不硬凑：透传脏值时回退静态，静态也脏则不写', () => {
    const h1: Record<string, string> = { 'x-session-id': 'ses_static', 'x-session-affinity': 'ses_static' }
    applyZenFingerprint(h1, { id: 'has space!' })
    expect(h1['x-session-id']).toBe('ses_static')
    const h2: Record<string, string> = {}
    applyZenFingerprint(h2, { id: '' })
    expect(h2['x-session-id']).toBeUndefined()
    expect(h2['x-session-affinity']).toBeUndefined()
  })

  test('非 ses_ 透传直接忽略（第三方 harness 自带会话 ID，如 ZCode 的 UUID）', () => {
    // 真实事故（2026-09-18）：zcode 发 x-session-id: 8a843b90-…（UUID，字符集
    // 恰好过白名单），照透则上游百分百 403。必须回退静态，不得透传陌生会话。
    const h1: Record<string, string> = { 'x-opencode-session': 'ses_static' }
    applyZenFingerprint(h1, { id: '8a843b90-a9c1-4d2e-8f01-xyz123456789', affinity: '8a843b90-a9c1-4d2e-8f01-xyz123456789' })
    expect(h1['x-opencode-session']).toBe('ses_static')
    // affinity 同规则：UUID 不收，跟 sid（真机两者同值）
    expect(h1['x-session-affinity']).toBe('ses_static')
    expect(h1['x-session-id']).toBe('ses_static')
    // 无静态可退：宁可不写会话头，也不把 UUID 发给上游
    const h2: Record<string, string> = {}
    applyZenFingerprint(h2, { id: '8a843b90-a9c1-4d2e-8f01-xyz123456789' })
    expect(h2['x-opencode-session']).toBeUndefined()
    expect(h2['x-session-id']).toBeUndefined()
    expect(h2['x-session-affinity']).toBeUndefined()
  })

  test('ses_ 透传同样忽略（网关权威：只用静态，会话过期走刷新流程）', () => {
    const h: Record<string, string> = { 'x-opencode-session': 'ses_static' }
    applyZenFingerprint(h, { id: 'ses_live123', affinity: 'ses_live123' })
    expect(h['x-opencode-session']).toBe('ses_static')
    expect(h['x-session-affinity']).toBe('ses_static')
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
})
