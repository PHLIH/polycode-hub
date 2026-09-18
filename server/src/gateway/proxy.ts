// 三协议入站端点的统一转发流程（对齐 Go internal/gateway/proxy.go）：
//   client 请求 --入站编解码器--> IR --调度(风险/预检)--> 上游调用(换源闸门)
//     --出站编解码器解析--> IR 事件 --入站编解码器序列化--> client SSE

import { timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'
import type { Hono } from 'hono'
import {
  ERR, accuracyWorst, getInbound, getOutbound, irError, UpstreamError, UPSTREAM,
  type Block, type InboundCodec, type IrError, type IrResponse, type OutboundCodec,
  type Protocol, type StopReason, type StreamEvent, type Usage,
} from '../ir/index.ts'
import { resolveProtocol, estimateRequestTokens, type Scheduler, type Upstream, type SessionHint } from '../router/index.ts'
import type { AccountPool } from '../pool/account.ts'
import { accountEffectiveStatus, type Account, type Provider, type UsageLog, type UsageStatus } from '../model/index.ts'
import {
  DEFAULT_FIRST_BYTE_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, type Config,
} from '../config/index.ts'

export interface UsageSink {
  insertLog(l: UsageLog): Promise<void> | void
}

// 指纹刷新器（cli 注入）：上游报 FINGERPRINT（免费档指纹被拒）时，去本机重扫
// opencode 日志里的新鲜会话并写回 Provider，返回刷新后的 Provider（供重试一次），
// 或 null（本地也没有新鲜指纹——用户很久没打开过客户端，只能重新登录，无可刷新）。
// 返回 null 时不重试，原错直接返回并照常冷却。
export type FingerprintRefresher = (pv: Provider) => Promise<Provider | null>

// 失败分类 → 账号冷却时长（限流 1min、耗尽 10min、鉴权/指纹/地区 30min、其他 30s）。
// 指纹缺失与鉴权同类：不配好 UA/会话就永远 403，30s 冷却只会让它反复爬起来空撞。
// 地区限制（REGION）同理：挂上 egress 之前都白试。
export function cooldownFor(kind: string): number {
  if (kind === UPSTREAM.RATE_LIMIT) return 60_000
  if (kind === UPSTREAM.QUOTA) return 600_000
  if (kind === UPSTREAM.AUTH || kind === UPSTREAM.FINGERPRINT || kind === UPSTREAM.REGION) return 1_800_000
  return 30_000
}

let reqCounter = 0
export function requestID(): string {
  return `req-${Date.now()}-${++reqCounter}`
}

export function bearerMatch(authHeader: string | undefined, key: string): boolean {
  const prefix = 'Bearer '
  if (!authHeader || !authHeader.startsWith(prefix) || authHeader.length <= prefix.length) return false
  const got = Buffer.from(authHeader.slice(prefix.length))
  const want = Buffer.from(key)
  if (got.length !== want.length) return false
  return timingSafeEqual(got, want)
}

// 客户端指纹透传（zen 免费档指纹的一部分）：会话头 + UA 原样带给上游。
// opencode 发出的每个请求都带 x-session-id/x-session-affinity（同值 ses_…），
// 网关原样递给上游，上游才认这是"官方客户端内部"流量；它的 UA 本来就是真串，
// 透传即指纹，无需网关伪造。非 opencode 客户端不带会话头时 hint 为 undefined，
// 上游侧回退到 Provider 静态头里的那一份。
// 通用原则：来什么透什么，网关不判断、不改写、不伪造（UA 的合法性由
// upstream.sanitizeUA 在落头前把关，防 CR/LF 注入）。
// id 只收字母数字/下划线/连字符（≤128）：透传的是上游鉴别依据，不收脏值；
// UA 无会话时也照透（opencode 客户端的 UA 本身就是有效指纹的一部分）。
export function sessionHintFromHeaders(get: (name: string) => string | undefined): SessionHint | undefined {
  const id = (get('x-session-id') ?? '').trim()
  const ua = (get('user-agent') ?? '').trim()
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    // 无可用会话：只剩 UA 可透时也返回（调用方按会话/UA 各自决定用不用）。
    return ua !== '' ? { userAgent: ua } : undefined
  }
  const aff = (get('x-session-affinity') ?? '').trim()
  const hint: SessionHint = { id, affinity: /^[A-Za-z0-9_-]{1,128}$/.test(aff) ? aff : id }
  if (ua !== '') hint.userAgent = ua
  return hint
}

// 把最后一个上游错误映射为对 client 的规范错误。
// sentEffort：这次转发实际发给上游的推理档位（客户端透传的）。
// bad_request 且发过档位时，档位不在上游枚举里是头号嫌疑，直接点名——
// 按“发过什么”触发，不按报错文本关键字猜，任何语言的上游报错都适用。
const REASONING_PRESET_HINT = '（本次请求带了推理强度档位，疑似不在上游枚举里）'
export function mapUpstreamError(ue: UpstreamError | undefined, sentEffort?: string): IrError {
  if (!ue) return irError(ERR.API, '无可用上游')
  switch (ue.kind) {
    case UPSTREAM.RATE_LIMIT: return irError(ERR.RATE_LIMIT, '所有上游限流: ' + ue.message)
    case UPSTREAM.AUTH: return irError(ERR.AUTHENTICATION, '上游鉴权失败: ' + ue.message)
    case UPSTREAM.QUOTA: return irError(ERR.RATE_LIMIT, '上游额度耗尽: ' + ue.message)
    case UPSTREAM.NETWORK: return irError(ERR.OVERLOADED, '上游不可达: ' + ue.message)
    // 指纹缺失不是「上游故障」而是「本地没配」：必须给可执行动作，
    // 否则用户只拿到一句英文 403，不知道该去 Provider 头里配什么。
    case UPSTREAM.FINGERPRINT: return irError(ERR.AUTHENTICATION,
      '上游只接受官方客户端指纹（免费档限制）: ' + ue.message
      + '；先在本机跑一次 opencode（如 opencode run "hi"）产生新鲜会话，再调 POST /admin/api/providers/:pid/refresh-fingerprint 自动续上（或在 Provider 头里手填真实 x-opencode-session，会话过期后需重填；客户端自带的会话/UA 头网关一律忽略，只用网关静态配置）'
      + '；另：zen 免费档要求流式 agent 体裁（含 read/bash 工具声明 + tool_choice），网关转发时已自动补工具声明，非流式调用则在内部改走流式上游并拼包返回，无需客户端配合')
    // 地区限制同理：不是「模型没了」也不是「Key 错了」，而是出口 IP 不在可用地区。
    // 不给这句指引，用户会以为模型下线了。
    case UPSTREAM.REGION: return irError(ERR.AUTHENTICATION,
      '该模型在当前出口地区不可用: ' + ue.message
      + '；可给该 Provider（或其下这个模型）配置 egress 出口代理后重试')
    default: {
      const hint = ue.kind === UPSTREAM.BAD_REQUEST && (sentEffort ?? '').trim() !== ''
        ? REASONING_PRESET_HINT
        : ''
      return irError(ERR.API, '上游错误: ' + ue.message + hint)
    }
  }
}

// 按字段级「最新优先」把流事件中的 usage 合并进用量记录。
// totalTokens 不在此逐事件重算：落库时 Store.insertLog 按上游 wire 口径统一求和。
export function mergeStreamUsage(ul: UsageLog, ev: StreamEvent): void {
  const u = ev.usage
  if (!u) return
  if ((u.inputTokens ?? 0) > 0) ul.inputTokens = u.inputTokens!
  if (u.outputTokens > 0) ul.outputTokens = u.outputTokens
  if ((u.cacheReadTokens ?? 0) > 0) ul.cacheReadTokens = u.cacheReadTokens!
  if ((u.cacheCreationTokens ?? 0) > 0) ul.cacheCreationTokens = u.cacheCreationTokens!
  if ((u.reasoningTokens ?? 0) > 0) ul.reasoningTokens = u.reasoningTokens!
  if (u.accuracy) ul.accuracy = accuracyWorst(ul.accuracy as typeof u.accuracy, u.accuracy)
}

// 把上游 SSE 流收齐拼成单个 IR 响应（导出供测试）。
//
// 背景：网关内部一律用流式打上游（见 Upstream.streamWith），非流式客户端的
// 请求也要先以流式拿回来——这里负责把事件流折叠回单包，再走既有的
// serializeResponse 回给客户端。客户端看到的仍是非流式，拼包对它透明。
//
// 语义：文本/思考增量按块拼接；tool_use 块的 arguments 分片拼完后整体 parse
// （非法 JSON 容忍为空，与 codec.parseArgs 一致）；用量按字段级最新优先合并；
// 空流返回空内容（不断言，调用方按既有语义记账）。
// 上游以 error 事件半路失败时抛错（调用方按上游错误记账，不伪造 200 空包）。
// 注意是“空包才抛”：流中偶发的坏行（某 chunk 非法 JSON）只跳过，继续收后面
// 的好内容——与流式透传“坏帧透传 + 好内容照出”对齐；全程无内容才说明整条流
// 不可用，此时抛第一个错误（调用方记 upstream_error）。
export async function collectStreamResponse(
  out: OutboundCodec, rc: ReadableStream<Uint8Array>,
): Promise<IrResponse> {
  const sp = out.newStreamParser()
  const blocks = new Map<number, Block>()
  const order: number[] = []
  const jsonAcc = new Map<number, string>() // tool_use 块的 arguments 分片
  let usage: Usage = { outputTokens: 0, accuracy: 'unknown' }
  let stopReason: StopReason | undefined
  let firstStreamError: string | undefined // 全程无内容时才抛它（见上）
  let id: string | undefined
  let model: string | undefined
  let created: number | undefined
  const open = (idx: number, block: Block): Block => {
    let b = blocks.get(idx)
    if (!b) {
      b = { ...block }
      blocks.set(idx, b)
      order.push(idx)
      if (b.type === 'tool_use') jsonAcc.set(idx, '')
    }
    return b
  }
  const mergeUsage = (u: StreamEvent['usage']): void => {
    if (!u) return
    if ((u.inputTokens ?? 0) > 0) usage.inputTokens = u.inputTokens
    if (u.outputTokens > 0) usage.outputTokens = u.outputTokens
    if ((u.cacheReadTokens ?? 0) > 0) usage.cacheReadTokens = u.cacheReadTokens
    if ((u.cacheCreationTokens ?? 0) > 0) usage.cacheCreationTokens = u.cacheCreationTokens
    if ((u.reasoningTokens ?? 0) > 0) usage.reasoningTokens = u.reasoningTokens
    if (u.accuracy) usage.accuracy = accuracyWorst(usage.accuracy, u.accuracy)
  }
  const feed = (evs: StreamEvent[]): void => {
    for (const ev of evs) {
      const idx = ev.index ?? 0
      switch (ev.type) {
        case 'message_start':
          if (ev.id) id = ev.id
          if (ev.model) model = ev.model
          if (ev.created) created = ev.created
          mergeUsage(ev.usage)
          break
        case 'content_block_start':
          if (ev.block) open(idx, ev.block)
          break
        case 'content_block_delta': {
          const d = ev.delta
          if (!d) break
          if (d.kind === 'text' || d.kind === 'thinking') {
            const b = open(idx, { type: d.kind === 'text' ? 'text' : 'thinking' })
            b.text = (b.text ?? '') + (d.text ?? '')
          } else if (d.kind === 'tool_json') {
            open(idx, { type: 'tool_use' })
            jsonAcc.set(idx, (jsonAcc.get(idx) ?? '') + (d.partialJson ?? ''))
          }
          break
        }
        case 'content_block_stop': {
          const b = blocks.get(idx)
          if (b?.type === 'tool_use') {
            const raw = (jsonAcc.get(idx) ?? '').trim()
            if (raw !== '') {
              try {
                b.input = JSON.parse(raw) as unknown
              } catch { /* 非法 arguments 容忍为空 */ }
            }
          }
          break
        }
        case 'message_delta':
          if (ev.stopReason !== undefined) stopReason ??= ev.stopReason
          mergeUsage(ev.usage)
          break
        case 'message_stop':
        case 'ping':
          break
        case 'error':
          // 坏行跳过继续收（对齐流式透传）；无内容可回时才抛，见函数注释。
          firstStreamError ??= ev.error ? ev.error.message : '上游流内错误'
          break
      }
    }
  }
  const reader = rc.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) feed(sp.feed(value))
  }
  feed(sp.finish())
  if (order.length === 0 && firstStreamError !== undefined) {
    throw new UpstreamError(0, UPSTREAM.SERVER, firstStreamError)
  }
  return {
    content: order.map((i) => blocks.get(i)!),
    ...(stopReason !== undefined ? { stopReason } : {}),
    usage,
    ...(id !== undefined ? { id } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(created !== undefined ? { created } : {}),
  }
}

function fillUsage(ul: UsageLog, u: NonNullable<StreamEvent['usage']>): void {
  ul.inputTokens = u.inputTokens ?? 0
  ul.outputTokens = u.outputTokens
  ul.cacheReadTokens = u.cacheReadTokens ?? 0
  ul.cacheCreationTokens = u.cacheCreationTokens ?? 0
  ul.reasoningTokens = u.reasoningTokens ?? 0
  ul.accuracy = u.accuracy
}

function writeIrError(inb: InboundCodec, e: IrError): Response {
  return writeIrErrorStatus(inb, e, e.httpStatus)
}

function writeIrErrorStatus(inb: InboundCodec, e: IrError, status: number): Response {
  let body: Uint8Array
  try {
    body = inb.serializeError(e)
  } catch {
    return Response.json({ error: { type: e.type, message: e.message } }, { status })
  }
  return new Response(body as never, { status, headers: { 'Content-Type': 'application/json' } })
}

interface LockedUpstream {
  stream: ReadableStream<Uint8Array>
  provider: Provider
  acctId: string
}

// 候选为空的诊断文案。
//
// 用户最容易踩的坑是「Provider 改名 / 删除后，客户端里还配着旧前缀」——那时泛泛
// 说一句「无可用 Provider」等于没说：用户手里明明有个能用的 Provider，却不知道
// 该改哪里。所以这里按前缀逐个查证，把真实原因点名（包括"这个名字属于已删除的
// Provider"），并给出下一步动作。
export function noCandidateMessage(modelRef: string, providers: Provider[], stream = true): string {
  const i = modelRef.indexOf('/')
  const prefix = i > 0 ? modelRef.slice(0, i) : ''
  const bare = i > 0 ? modelRef.slice(i + 1) : modelRef
  if (prefix === '') {
    if (providers.length === 0) return `模型 ${modelRef} 无可用 Provider（还没有配置任何 Provider）`
    return `模型 ${modelRef} 无可用 Provider：没有哪个来源声明了它`
      + `（到 Providers 页拉取上游模型列表并勾选采用）`
  }
  const sameName = providers.filter((p) => p.name === prefix)
  const byState = (st: Provider['state']) => sameName.filter((p) => p.state === st)
  const ids = (ps: Provider[]) => ps.map((p) => `#${p.providerId}`).join('、')
  const active = byState('active')
  if (active.length > 0) {
    // 「只支持流式」必须单独点名：这种情况模型是**声明了且已勾选**的，
    // 用户照着「没有声明模型」去核对模型列表永远查不出所以然——
    // 真实原因是当前请求没带 stream，被 `!stream && p.streamOnly` 排除了。
    // 实测：workbuddy 是 streamOnly，非流式请求报"没有声明模型"，
    // 加 stream:true 立刻正常返回。
    const streamOnly = active.filter((p) => p.streamOnly)
    if (!stream && streamOnly.length > 0 && streamOnly.length === active.length) {
      return `Provider「${prefix}」（${ids(streamOnly)}）只支持流式请求，`
        + `而这次是非流式调用（stream=false）。请在客户端开启流式（stream:true）后重试。`
    }
    const onlyStreamMismatch = !stream && streamOnly.length > 0
    return `Provider「${prefix}」（${ids(active)}）没有声明模型 ${bare}`
      + `（或该项未勾选采用；也可能被风险上限/上下文预检排除`
      + `${onlyStreamMismatch ? '；该 Provider 同时只支持流式请求' : ''}）`
  }
  const deleted = byState('deleted')
  if (deleted.length > 0) {
    return `Provider「${prefix}」已删除（${ids(deleted)}），前缀 ${prefix}/ 已失效。`
      + `若刚重建了同名来源，请确认它已启用；否则用 GET /v1/models 查当前可用的模型 ID`
  }
  const paused = byState('paused')
  if (paused.length > 0) {
    return `Provider「${prefix}」已暂停（${ids(paused)}），到 Providers 页打开开关即可恢复`
  }
  return `未知的 Provider 前缀「${prefix}」（请求的模型：${modelRef}）。`
    + `用 GET /v1/models 查看当前可用的模型 ID`
}

export class Proxy {
  // 转发门面：入站编解码 → 调度换源 → 上游流 → 出站解析 → SSE 回写。
  // 单例常驻（构造时注入 cfg/sched/up/usage；账号池经 setAccountPool 后挂）。
  // 失败语义：首字节前可换源（serve 内 attempt 循环），首字节后只透传（forward 内）。
  private cfg: Config
  private sched: Scheduler
  private up: Upstream
  private usage: UsageSink | null
  private accounts: AccountPool | null = null
  private fingerprintRefresher: FingerprintRefresher | null = null

  constructor(cfg: Config, sched: Scheduler, up: Upstream, usage: UsageSink | null) {
    this.cfg = cfg
    this.sched = sched
    this.up = up
    this.usage = usage
    // 超时守卫兜底：配置可能来自手写对象（测试/嵌入），未必走过 applyDefaults。
    // 缺了会让 setTimeout(undefined) 立刻触发 → 正常请求被误杀。
    if (!(cfg.gateway.firstByteTimeoutMs > 0)) cfg.gateway.firstByteTimeoutMs = DEFAULT_FIRST_BYTE_TIMEOUT_MS
    if (!(cfg.gateway.streamIdleTimeoutMs > 0)) cfg.gateway.streamIdleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS
  }

  setAccountPool(ap: AccountPool): void {
    this.accounts = ap
  }

  // 指纹自愈钩子（cli 注入，见 FingerprintRefresher）：未注入时行为不变。
  setFingerprintRefresher(f: FingerprintRefresher | null): void {
    this.fingerprintRefresher = f
  }

  // 三个入站端点 + OpenAI 兼容的模型发现挂到 app（含裸路径别名）。
  registerRoutes(app: Hono): void {
    const h = (p: Protocol) => (c: Context) => this.serve(c, p)
    app.post('/v1/messages', h('anthropic-messages'))
    app.post('/v1/chat/completions', h('openai-completions'))
    app.post('/v1/responses', h('openai-responses'))
    // 裸路径别名：Base URL 填到端口根的客户端（Cherry Studio / DeepSeek Harness 类）
    app.post('/chat/completions', h('openai-completions'))
    app.post('/responses', h('openai-responses'))
    app.get('/v1/models', (c) => this.handleModels(c))
    app.get('/models', (c) => this.handleModels(c))
    // 健康检查（technical-design §3.2）：{ok:true, apps:N}。
    // 不鉴权：监控/探活不该先拿到 gateway_key；也不泄露 provider 名等内部信息。
    app.get('/health', (c) => this.handleHealth(c))
  }

  // handleHealth：apps 只数启用中的 Provider —— 监控要看的是"真能用的有几个"。
  private handleHealth(c: Context): Response {
    const apps = this.sched.providers().filter((p) => p.state === 'active').length
    return c.json({ ok: true, apps })
  }

  // 返回可用模型目录（OpenAI {"data":[{id}]} 形态，id 为限定名 providerId/modelId）。
  private handleModels(c: Context): Response {
    const key = this.cfg.gateway.gatewayKey
    if (key && !bearerMatch(c.req.header('authorization'), key)) {
      return Response.json({ error: { message: 'missing or invalid gateway key', type: 'authentication_error' } }, { status: 401 })
    }
    const out: { id: string; object: string; owned_by: string }[] = []
    for (const p of this.sched.providers()) {
      if (p.state !== 'active') continue
      for (const m of p.models) {
        if (m.enabled) out.push({ id: `${p.name}/${m.id}`, object: 'model', owned_by: p.name })
      }
    }
    return Response.json({ object: 'list', data: out })
  }

  private async serve(c: Context, p: Protocol): Promise<Response> {
    const inb = getInbound(p)() // 入站编解码器带每流状态：每请求独立实例，绝不跨流共享

    // 网关自身鉴权（可选）
    const gatewayKey = this.cfg.gateway.gatewayKey
    if (gatewayKey && !bearerMatch(c.req.header('authorization'), gatewayKey)) {
      return writeIrError(inb, irError(ERR.AUTHENTICATION, 'missing or invalid gateway key'))
    }

    const body = new Uint8Array(await c.req.arrayBuffer())
    let irReq
    try {
      irReq = inb.parseRequest(body)
    } catch (err) {
      return writeIrError(inb, irError(ERR.INVALID_REQUEST, '请求解析失败: ' + (err as Error).message))
    }
    if (!irReq.model) irReq.model = this.cfg.gateway.defaultModel
    // 入站元数据日志（只记元数据、不记消息正文与工具参数）：定位客户端实际发的
    // maxTokens/工具集/档位。body 明文绝不进日志（可能含代码与密钥）。
    console.log(`[inbound] proto=${p} model=${irReq.model} stream=${irReq.stream} maxTokens=${irReq.maxTokens ?? '-'} tools=${(irReq.tools ?? []).map((t) => t.name).join(',') || '-'} toolChoice=${irReq.toolChoice?.mode ?? '-'} reasoning=${irReq.reasoningEffort ?? '-'}`)

    // 预检用粗估（绝不修改请求，绝不截断）
    const estimate = estimateRequestTokens(body)
    const cands = this.sched.pickOrder(irReq.model, estimate, this.cfg.gateway.precheckContext, irReq.stream)
    if (cands.length === 0) {
      return writeIrError(inb, irError(ERR.NOT_FOUND,
        noCandidateMessage(irReq.model, this.sched.providers(), irReq.stream)))
    }
    // 限定名剥前缀：上游只认裸模型名；用量记账按裸名归一。
    const split = this.sched.splitRef(irReq.model)
    if (split.qualified) irReq.model = split.model

    // 指定账号（x-polycode-account）：不轮询、不换号，失败即报错。
    const pinnedId = (c.req.header('x-polycode-account') ?? '').trim()
    // opencode 客户端自带官方会话头：有就透传（zen 指纹），没有就用 Provider 静态配置。
    const session = sessionHintFromHeaders((n) => c.req.header(n))
    // TEMP-DIAG（定案即删）：只记会话来源（透传前缀/静态），不记正文与完整 ID。
    if (process.env.ZEN_DIAG === '1') {
      const cli = (c.req.header('x-session-id') ?? '').trim()
      console.log(`[zen-diag] model=${irReq.model} stream=${irReq.stream} sess=${session?.id ? `passthru:${session.id.slice(0, 12)}` : 'static'} cliSid=${cli !== '' ? cli.slice(0, 12) : '-'}`)
    }
    const start = Date.now()
    if (pinnedId) return this.servePinned(inb, p, irReq, start, pinnedId, cands, session)

    let lastErr: UpstreamError | undefined
    let lastAcctId = '' // 最后尝试的账号（兜底失败账也要归因到账号，ACCOUNT-HEALTH）
    let locked: LockedUpstream | undefined
    // 试过的推理档位（客户端透传的）：全灭且 kind 为 bad_request 时，
    // 档位不在枚举里是头号嫌疑，mapUpstreamError 据此追加指引（按事实触发，不猜文本）。
    let triedEffort = ''
    // 锁定那次实际发出的请求：无改写时就是 irReq 本体。
    let lockedReq = irReq

    // 用指定账号（null = Provider 级凭据）尝试一个候选；成功则锁定（上游 2xx 头已到，
    // 首字节闸门尚未过：forward() 会先等首个真实事件再承诺 200，此后才禁止换源）。
    // 指纹自愈：首错为 FINGERPRINT 且刷新器能给出新鲜会话时，同候选重试一次
    // （用户刚跑过 opencode、网关静态头还没跟上的常见情形）；刷新器返回 null
    // （本地无新鲜指纹）则不重试，原错走正常换源/冷却。
    const attempt = async (pv: Provider, acct: Account | null): Promise<boolean> => {
      const fire = async (base: Provider): Promise<void> => {
        const pvv: Provider = acct ? { ...base, credential: acct.credential } : { ...base } // 账号 JWT 覆盖 Provider 凭据
        const [m] = this.sched.modelOf(base.providerId, irReq.model)
        if (m.egress) pvv.egress = m.egress // 模型级出口覆盖 Provider 级（未声明的模型继承 Provider）
        // 推理档位完全跟随客户端透传：网关不做模型级预设、不抬预算。
        const effReq = irReq
        if ((effReq.reasoningEffort ?? '').trim() !== '') triedEffort = effReq.reasoningEffort!.trim()
        const stream = await this.up.stream(pvv, effReq, session)
        locked = { stream, provider: pvv, acctId: acct?.id ?? '' }
        lockedReq = effReq
      }
      const toUE = (err: unknown): UpstreamError => err instanceof UpstreamError
        ? err
        : new UpstreamError(0, UPSTREAM.UNKNOWN, (err as Error).message)
      try {
        await fire(pv)
        return true
      } catch (err) {
        let ue = toUE(err)
        if (ue.kind === UPSTREAM.FINGERPRINT && this.fingerprintRefresher) {
          let fresh: Provider | null = null
          try {
            fresh = await this.fingerprintRefresher(pv)
          } catch {
            fresh = null
          }
          if (fresh) {
            try {
              await fire(fresh)
              console.log(`指纹已刷新并重试成功 provider=${pv.name} account=${acct?.id ?? '-'}`)
              return true
            } catch (err2) {
              ue = toUE(err2)
            }
          }
        }
        lastErr = ue
        lastAcctId = acct?.id ?? ''
        if (acct) {
          this.accounts!.markResult(acct.id, false, cooldownFor(ue.kind), new Date(), ue.kind)
          if (ue.kind === UPSTREAM.AUTH) {
            console.error(`账号鉴权失败已冷却，疑似凭据过期，请重登后用 POST /admin/api/accounts/{id}/recheck 恢复 account=${acct.id} provider=${pv.name}`)
          }
          if (ue.kind === UPSTREAM.FINGERPRINT) {
            console.error(`指纹被拒且本地无新鲜会话（或重试仍失败），请在本机跑一次 opencode（如 opencode run "hi"）产生新鲜会话，再调刷新指纹接口恢复 provider=${pv.name}`)
          }
        }
        console.warn(`上游失败，尝试换源 provider=${pv.name} account=${acct?.id ?? '-'} kind=${ue.kind} status=${ue.status} err=${ue.message}`)
        return false // 首字节前：允许换源
      }
    }

    for (const pv of cands) {
      if (!this.accounts || !this.accounts.hasFor(pv.providerId)) {
        if (await attempt(pv, null)) break
        continue
      }
      // 同源账号加权轮询；全冷却后结束（有界，不死循环）。
      for (let i = 0; i < cands.length + 1; i++) {
        let acct: Account
        try {
          acct = this.accounts.pick(pv.providerId, new Date())
        } catch {
          break // 全冷却
        }
        if (await attempt(pv, acct)) break
      }
      if (locked) break
    }

    if (locked) return this.forward(inb, p, locked, lockedReq, start)

    // 全部候选失败：记一笔失败账（tokens 为 0）——轮询路径流式失败的兜底落账点
    // （指定账号路径见 servePinned，转发中失败见 forward 的各 logUsage）。
    if (cands.length > 0) {
      const last = cands[cands.length - 1]!
      this.logUsage({
        id: 0, ts: new Date(start), requestId: requestID(),
        providerId: last.providerId, providerName: last.name, modelId: irReq.model, stream: irReq.stream,
        accountId: lastAcctId,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        reasoningTokens: 0, totalTokens: 0, accuracy: 'unknown', latencyMs: 0, status: 'ok',
        errorKind: lastErr?.kind ?? '', // 失败原因（ir.UpstreamError.kind），供账号维度归因
      }, 'upstream_error', Date.now() - start)
    }
    console.error(`全部 Provider 失败 attempts=${cands.length} last=${lastErr?.message ?? '-'}`)
    const irErr = mapUpstreamError(lastErr, triedEffort)
    return writeIrErrorStatus(inb, irErr, irErr.httpStatus)
  }

  // 指定账号转发（x-polycode-account）：直接走该账号，失败即报错，
  // 禁止静默回退到轮询（否则用户以为走的是指定账号）。
  // 4xx 语义：账号不存在 → 404；归属 Provider 不匹配 → 400；冷却中 → 429。
  private async servePinned(
    inb: InboundCodec, p: Protocol,
    irReq: import('../ir/index.ts').IrRequest, start: number,
    pinnedId: string, cands: Provider[], session?: SessionHint,
  ): Promise<Response> {
    const acct = this.accounts?.get(pinnedId)
    if (!acct) {
      return writeIrErrorStatus(inb,
        irError(ERR.NOT_FOUND, `指定账号 ${pinnedId} 不存在`), 404)
    }
    const targets = cands.filter((pv) => pv.providerId === acct.providerId)
    if (targets.length === 0) {
      return writeIrErrorStatus(inb, irError(ERR.INVALID_REQUEST,
        `指定账号 ${pinnedId} 归属 Provider #${acct.providerId}，与请求模型可用的 Provider 不匹配（不换号）`), 400)
    }
    if (accountEffectiveStatus(acct, new Date()) !== 'available') {
      return writeIrErrorStatus(inb,
        irError(ERR.RATE_LIMIT, `指定账号 ${pinnedId} 处于 ${acct.status}，不换号`), 429)
    }
    // 同源多个 Provider 命中时取第一个（与轮询路径的候选顺序一致）。
    const pv = targets[0]!
    const pvv: Provider = { ...pv, credential: acct.credential }
    const [m] = this.sched.modelOf(pv.providerId, irReq.model)
    if (m.egress) pvv.egress = m.egress
    const effReq = irReq
    let stream: ReadableStream<Uint8Array>
    try {
      stream = await this.up.stream(pvv, effReq, session)
    } catch (err) {
      const ue = err instanceof UpstreamError
        ? err
        : new UpstreamError(0, UPSTREAM.UNKNOWN, (err as Error).message)
      this.accounts!.markResult(acct.id, false, cooldownFor(ue.kind), new Date(), ue.kind)
      if (ue.kind === UPSTREAM.AUTH) {
        console.error(`账号鉴权失败已冷却，疑似凭据过期，请重登后用 POST /admin/api/accounts/{id}/recheck 恢复 account=${acct.id} provider=${pvv.name}`)
      }
      // 指定账号的失败账：归因该账号（tokens 为 0），不换号。
      this.logUsage({
        id: 0, ts: new Date(start), requestId: requestID(),
        providerId: pv.providerId, providerName: pv.name, modelId: irReq.model, stream: irReq.stream,
        accountId: acct.id,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        reasoningTokens: 0, totalTokens: 0, accuracy: 'unknown', latencyMs: 0, status: 'ok',
        errorKind: ue.kind,
      }, 'upstream_error', Date.now() - start)
      const irErr = mapUpstreamError(ue, effReq.reasoningEffort)
      return writeIrErrorStatus(inb, irErr, irErr.httpStatus)
    }
    return this.forward(inb, p, { stream, provider: pvv, acctId: acct.id }, effReq, start)
  }

  // 已锁定上游后：流式逐事件转发，非流式整体转换（此后绝不能换源）。
  private async forward(
    inb: InboundCodec, proto: Protocol, locked: LockedUpstream,
    irReq: import('../ir/index.ts').IrRequest, start: number,
  ): Promise<Response> {
    const { stream: rc, provider: pv, acctId } = locked

    // 响应解析必须与实际发请求所用的协议一致（自动识别协议在 stream 内已记住）。
    const [got] = resolveProtocol(pv, irReq.model)
    const actualProto = got || proto
    let out
    try {
      out = getOutbound(actualProto)
    } catch (err) {
      return writeIrError(inb, irError(ERR.API, (err as Error).message))
    }

    const ul: UsageLog = {
      id: 0,
      ts: new Date(start),
      requestId: requestID(),
      providerId: pv.providerId, providerName: pv.name,
      accountId: acctId, // 归因到账号（空 = Provider 级凭据）
      modelId: irReq.model,
      stream: irReq.stream,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      reasoningTokens: 0, totalTokens: 0, accuracy: 'unknown', latencyMs: 0, status: 'ok',
    }

    if (!irReq.stream) {
      // 客户端要非流式：上游侧实际是以流式拿回来的（见 Upstream.streamWith），
      // 这里收齐拼成单包再回。所有上游统一走这条路，不止 zen。
      let resp: IrResponse
      try {
        resp = await collectStreamResponse(out, rc)
      } catch (err) {
        this.logUsage(ul, 'upstream_error', Date.now() - start)
        const msg = err instanceof UpstreamError ? err.message : (err as Error).message
        return writeIrError(inb, irError(ERR.API, '上游响应收齐失败: ' + msg))
      }
      let body: Uint8Array
      try {
        body = inb.serializeResponse(resp)
      } catch (err) {
        return writeIrError(inb, irError(ERR.API, '响应序列化失败: ' + (err as Error).message))
      }
      ul.accuracy = resp.usage.accuracy
      fillUsage(ul, resp.usage)
      this.logUsage(ul, 'ok', Date.now() - start)
      return new Response(body as never, { headers: { 'Content-Type': 'application/json' } })
    }

    // ---- 流式：SSE 透传（此时绝不能换源） ----
    // 首字节闸门：先等上游吐出第一个真实事件（或超时），再承诺 200。
    // 不这么做的话，Response 一构造状态码就定死了——上游随后挂住也只能回 200，
    // 客户端看到的是"成功但没内容"，既不能重试也不知道出了事。
    const sp = out.newStreamParser()
    let firstChunk: Uint8Array | null = null
    let pendingEvents: StreamEvent[] = []
    let firstReader: ReadableStreamDefaultReader<Uint8Array> | null = null
    {
      const reader0 = rc.getReader()
      firstReader = reader0
      const timeoutMs = this.cfg.gateway.firstByteTimeoutMs
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => { timedOut = true; resolve('timeout') }, timeoutMs)
      })
      try {
        for (;;) {
          const raced = await Promise.race([
            reader0.read().then((r) => ({ r })),
            timeout,
          ])
          if (raced === 'timeout') break
          const { done, value } = raced.r
          if (done) break
          if (!value) continue
          let evs: StreamEvent[] = []
          try {
            evs = sp.feed(value)
          } catch (ferr) {
            console.warn(`上游流解析异常 provider=${pv.name} err=${(ferr as Error).message}`)
          }
          // 心跳注释行不算首字节：上游可能一直发 `: keep-alive` 却从不给数据。
          if (evs.length > 0) { firstChunk = value; pendingEvents = evs; break }
        }
      } catch (err) {
        void reader0.cancel().catch(() => {})
        if (timer) clearTimeout(timer)
        this.logUsage(ul, 'upstream_error', Date.now() - start)
        return writeIrError(inb, mapUpstreamError(new UpstreamError(0, UPSTREAM.NETWORK, (err as Error).message)))
      }
      if (timer) clearTimeout(timer)
      if (!firstChunk) {
        void reader0.cancel().catch(() => {})
        // 首字节没等到：闸门未过，可以如实报错（换源由上层 attempt 处理）。
        ul.errorKind = timedOut ? UPSTREAM.NETWORK : UPSTREAM.SERVER
        this.logUsage(ul, 'upstream_error', Date.now() - start)
        const msg = timedOut
          ? `上游未在 ${Math.round(timeoutMs / 1000)}s 内返回首字节（已掐断）`
          : '上游未返回任何内容就结束了连接'
        console.warn(`上游首字节失败 provider=${pv.name} account=${acctId || '-'} ${msg}`)
        const irErr = mapUpstreamError(new UpstreamError(0, ul.errorKind, msg))
        return writeIrErrorStatus(inb, irErr, irErr.httpStatus)
      }
      // 闸门已过：首块已在手上，接下来的读取交给下面的流式循环。
    }

    let clientErr = false // client 断开；仍读完上游以记账
    let upErr: Error | undefined // 上游流中断（非 EOF）
    let streamErrKind = '' // 流内 error 事件的原因（上游 200+错误体形态；闸门已过只能透传）
    const readable = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        let firstEvent = false
        const emit = (evs: StreamEvent[]) => {
          for (const ev of evs) {
            if (!firstEvent) {
              firstEvent = true
              ul.firstTokenMs = Date.now() - start
            }
            mergeStreamUsage(ul, ev)
            if (ev.type === 'error' && ev.error) {
              streamErrKind = ev.error.type === ERR.RATE_LIMIT ? 'rate_limit'
                : ev.error.type === ERR.AUTHENTICATION ? 'auth'
                : ev.error.type === ERR.OVERLOADED ? 'network'
                : ev.error.type === ERR.API ? 'server' : 'unknown'
            }
            let frame: Uint8Array
            try {
              frame = inb.serializeEvent(ev)
            } catch (err) {
              console.error(`事件序列化失败 type=${ev.type} err=${(err as Error).message}`)
              continue
            }
            try {
              controller.enqueue(frame)
            } catch {
              clientErr = true // client 已断开；仍读完上游以记账
            }
          }
        }
        const reader = firstReader!
        // 首块已经在闸门阶段读到，先把它吐给 client，再继续读后续。
        emit(pendingEvents)
        // 上游挂住时的自杀开关。没有它，reader.read() 会永远 pending：
        // 客户端不报错也不成功，只能干等（真实缺陷：上游接受连接后不回数据）。
        // 闸门已过，这里只管"流中途长时间没有新字节"。
        let timedOut = false
        let timer: ReturnType<typeof setTimeout> | null = null
        const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null } }
        const arm = () => {
          clearTimer()
          timer = setTimeout(() => {
            timedOut = true
            void reader.cancel(new Error('upstream timeout')).catch(() => {})
          }, this.cfg.gateway.streamIdleTimeoutMs)
        }
        arm()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) {
              let evs: StreamEvent[]
              try {
                evs = sp.feed(value)
              } catch (ferr) {
                console.warn(`上游流解析异常 provider=${pv.name} err=${(ferr as Error).message}`)
                evs = []
              }
              emit(evs)
            }
            arm() // 每收到一段就重置静默计时
          }
        } catch (err) {
          upErr = err as Error
        } finally {
          clearTimer()
        }
        if (timedOut) {
          const secs = Math.round(this.cfg.gateway.streamIdleTimeoutMs / 1000)
          upErr = new Error(`上游流中途静默超时（${secs}s 无新数据）`)
          console.warn(`上游超时掐断 provider=${pv.name} account=${acctId || '-'}`)
        }
        try {
          emit(sp.finish())
        } catch (ferr) {
          console.warn(`上游流收尾解析异常 provider=${pv.name} err=${(ferr as Error).message}`)
        }

        // 上游中途断流：换源闸门已过（首字节已吐），只能补发 error 帧并收尾。
        if (upErr && !clientErr) {
          console.warn(`上游流中断 provider=${pv.name} err=${upErr.message}`)
          emit([
            { type: 'error', error: irError(ERR.API, '上游连接中断: ' + upErr.message) },
            { type: 'message_stop' },
          ])
        }

        const status: UsageStatus =
          upErr || streamErrKind || (clientErr && !ul.firstTokenMs && ul.totalTokens === 0)
            ? 'upstream_error'
            : 'ok'
        if (streamErrKind) ul.errorKind = streamErrKind
        this.logUsage(ul, status, Date.now() - start)
        try {
          controller.close()
        } catch { /* client 已断开 */ }
      },
    })
    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  }

  logUsage(ul: UsageLog, status: UsageStatus, latencyMs: number): void {
    ul.status = status
    ul.latencyMs = latencyMs
    if (!ul.accuracy) ul.accuracy = 'unknown'
    Promise.resolve(this.usage?.insertLog({ ...ul })).catch(
      (err: Error) => console.warn(`用量写入失败 err=${err.message}`))
  }
}
