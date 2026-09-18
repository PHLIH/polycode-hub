// 通用上游调用器（对齐 Go internal/router/upstream.go）。
//
// 换源闸门（硬约束）：stream() 抛错时必然尚未有任何字节送达 client，调度器可安全换源；
// 返回 ReadableStream 后任何失败只能透传，禁止换源。

import { spawn } from 'node:child_process'
// 上游请求统一走 undici 包的 fetch（而非全局 fetch）：per-request dispatcher 需要
// 与 ProxyAgent 同源——npm undici 与 Node 内置 undici 是两代协议，跨包传 dispatcher 会
// 报 invalid onRequestStart（实测）。版本自洽后按 Provider 分流出口才成立。
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { getOutbound, kindForStatus, UpstreamError, UPSTREAM,
  type IrRequest, type Protocol } from '../ir/index.ts'
import { autoProtocol, forgetProtocol, rememberProtocol,
  capabilitiesFrom, credentialResolve, dynamicHeadersTimeout,
  findHeaderKey, isZenBaseUrl, mintZenRequestId, validZenToken, zenHeadersWithFingerprint,
  parseZenSessionPool, writeZenSessionPool,
  ZEN_REQUEST_HEADER, ZEN_SESSION_HEADER, ZEN_SESSION_POOL_HEADER,
  type Capabilities, type DynamicHeadersSpec, type Provider } from '../model/index.ts'

// egress 定义 → 代理 URI（EGRESS-SPIKE §4 方案 A）。
// v1 支持 http/https 代理（undici ProxyAgent 语义；socks5 不支持，Clash 等混合端口直接用 http://）。
export function egressProxyURI(e: { id: string; kind: string; addr: string }): string {
  if (e.kind === 'http') return `http://${e.addr}`
  if (e.kind === 'https') return `https://${e.addr}`
  throw new Error(`egress kind "${e.kind}" 暂不支持（v1 仅 http/https；socks5 服务请用其混合 http 端口）`)
}

// Node fetch 的非标准扩展：per-request dispatcher（undici）。
// 类型用 unknown：undici 包与 Node 内置 undici-types 是两套不兼容的 Dispatcher 类型，
// 运行时是同一实现；import type 反而制造双包类型冲突。
type FetchInit = RequestInit & { dispatcher?: unknown }

export interface UpstreamOpts {
  // 环境变量查找（可注入便于测试）
  credLookup?: (name: string) => [string, boolean]
  // 关闭协议自动回退：只按解析到的协议打一次（协议探测用，避免自动回退掩盖真相）
  noAutoProtocol?: boolean
  // 出口代理表：egress id → 代理 URI。Provider.egress 引用 id 走对应 dispatcher，未引用 = 直连。
  egresses?: Record<string, string>
}

type Lookup = (name: string) => [string, boolean]

const defaultLookup: Lookup = (name) =>
  process.env[name] === undefined ? ['', false] : [process.env[name]!, true]

// ---- OpenCode Zen 反代指纹 ----
//
// 上游免费档只认「官方客户端样子」的请求（否则 403 FreeTierError）。
// 2026-09-18 真机取证（覆盖官方 baseURL 的本地日志端点，抓官方客户端发出的原文）：
//   User-Agent: opencode/<ver> ai-sdk/provider-utils/<ver> runtime/bun/<ver>
//   Authorization: Bearer public
//   x-opencode-client: cli
//   x-opencode-project: global（或该目录的 hex projectID）
//   x-opencode-request: msg_<24位>（一次会话内稳定）
//   x-opencode-session: ses_<…>（本次运行的真实会话）
// 真客户端不发 x-session-id / x-session-affinity（ai-sdk 给别的上游用的）。
//
// 历史教训：网关曾把四件套当“毒头”删掉（臆测官方不发），与真机行为完全相反；
// 上游 2026-09 要求 x-opencode-session 后全量 403。现在按取证原样发送。
//
// 网关是通用项目，不内置任何版本号、不伪造 UA，只做「网关权威 + 配置兜底」：
//   UA 取值（客户端透传的 UA 永不采用，一律以网关自己的为准）：
//     1. Provider 静态头里的 User-Agent（运维自己抓包取的真串；指纹刷新流程
//        在版本变化时自动续写，见 discover.zen_refresh；删掉即回到 ZEN_UA）；
//     2. ZEN_UA 环境变量（项目级默认，同样由运维提供真串）；
//     3. 全都没有——如实不发，不编版本号。403 时按 FreeTierError 指引去配真串。
//   会话取值（静态 x-opencode-session > 旧 x-session-id 晋升，客户端透传忽略）：
//     1. Provider 静态头里的 x-opencode-session（指纹刷新流程自动续写）；
//     2. 旧版静态 x-session-id（历史配置里存的 ses_ 值，直接晋升沿用）。
//   为什么忽略客户端透传：第三方 harness 也会发自家的 x-session-id（如 ZCode
//   的 UUID），上游根本不认识，照透则百分百 403（2026-09-18 实测）。网关算定
//   的指纹不容上游（客户端）覆盖，来什么请求都用网关自己这一套头发出去。
//   x-opencode-request：静态值优先（真机一次会话内稳定）；缺时现铸一个
//     （mintZenRequestId，格式与观测一致；唯一性有收益，时间绑定则听天由命）。
//   x-opencode-client/project：静态优先，缺省 cli/global。
//   注入安全：透传/配置的 UA 只收单行可打印 ASCII（防 CR/LF 头注入），
//   超长（>512）截断；会话 token 仍走 validZenToken 白名单（非法不写头）。
//
// 会话 ID 必须来自一次真实的官方客户端运行（本地日志自动识别，
// 见 discover.discoverOpenCodeFingerprint；过期由指纹刷新流程续写）；
// 本地随机编一个通不过。

// ---- Zen 免费档 agent 体裁保底 ----
//
// 2026-09-18 真机取证 + 在线二分（`opencode-echo` 本地陷阱抓真机原文，
// 进程内复打逐变量排除）：FreeTierError 的另一半开关在请求体——上游要求
// 请求长得像真正的 agent 回合，缺一不可：
//   1. tools 声明里必须同时含 `read` 与 `bash`（按 function 名判定；schema
//      内容不校验，空 parameters 照过；10 个假名工具 / 单个真名 / read+write
//      等组合全部 403，只有含 read+bash 的集合返回 2xx）；
//   2. tool_choice 必须显式出现（有工具无 choice 照样 403）；
//   3. 必须流式（stream:false 即使体裁全对也 403，chat 与 responses 同此）。
// 头/UA/会话/TLS（Bun 1.3.14 内嵌栈）/请求体形状逐项对齐后仍 403，
// 唯独补上 read+bash+choice 当次转 200——体裁是独立判定维度。
//
// 落点：Upstream 发往 zen 前统一补（转发与探针同一入口，见 ensureZenAgentShape）。
// 开销：缺时才补，最多两个空 schema 工具（~30 input tokens）+ choice auto；
// 已带的不动、不覆盖、不改名。另：非流式在 streamWith 内一并提升为流式发出
// （见上），客户端语义不变——体裁与流式两道闸门由网关全兜，缺一即 403。
//
// 残留风险（已评估，P≈0）：tool_choice:auto 下模型几乎不会点名调这两个
// 垫片工具（实测 0 次）；万一调了，透传给客户端按普通 tool_call 处理，
// 与上游调了客户端未声明工具的既有语义一致，不在网关内自作主张多轮续跑
// （那会烧 token，违背最小消耗原则）。

// 体裁保底要求的工具名（子集语义：缺哪个补哪个，不碰已有的）。
export const ZEN_FLOOR_TOOL_NAMES = ['read', 'bash'] as const

// 垫片工具的最小形态（与取证时通过的那次一致：名 + 一句话描述 + 空对象 schema）。
function zenFloorTool(name: string): { name: string; description: string; inputSchema: unknown } {
  return { name, description: `${name} file operation.`, inputSchema: { type: 'object', properties: {} } }
}

// zen 上游发包前落实 agent 体裁（纯函数：不改入参，缺时返回补齐后的浅拷贝）。
// 非 zen 原样返回（同一引用，便于调用方与测试判定“没动过”）。
// 取舍（显式决策）：即使调用方 toolChoice 为 none 也照补 read/bash——zen 免费档
// 本来就要 agent 体裁，不补必 403；这里优先保可用，none 语义在 zen 路径下让位。
export function ensureZenAgentShape(req: IrRequest, baseUrl: string): IrRequest {
  if (!isZenUpstream(baseUrl)) return req
  const names = new Set((req.tools ?? []).map((t) => t.name))
  const missing = ZEN_FLOOR_TOOL_NAMES.filter((n) => !names.has(n))
  if (missing.length === 0 && req.toolChoice !== undefined) return req
  return {
    ...req,
    tools: [...(req.tools ?? []), ...missing.map(zenFloorTool)],
    ...(req.toolChoice !== undefined ? {} : { toolChoice: { mode: 'auto' as const } }),
  }
}

// 单行可打印 ASCII 才配做 UA（防 CR/LF 头注入）；超长截断到 512。
// 空/含控制字符/含非 ASCII → undefined（调用方视为无可用 UA，不硬凑）。
export function sanitizeUA(s: string | undefined): string | undefined {
  if (!s) return undefined
  const t = s.trim()
  if (t === '') return undefined
  if (/[\r\n]/.test(t)) return undefined
  if (!/^[\x20-\x7E]+$/.test(t)) return undefined
  return t.length > 512 ? t.slice(0, 512) : t
}

// client 透传/静态配置的会话提示：id 缺省时 affinity 取 id（真机行为：两者同值）。
// userAgent 是客户端原样带来的 UA（proxy.sessionHintFromHeaders 透传，
// 来什么透什么，网关不判断是不是 opencode）；落头前由 sanitizeUA 把关。
export interface SessionHint {
  id?: string
  affinity?: string
  userAgent?: string
}

// zen 判定见 model.isZenBaseUrl（唯一定义，避免两处漂移）。
const isZenUpstream = isZenBaseUrl

// 大小写不敏感的头查找与会话白名单见 model（唯一定义，避免两处漂移）。

// zen 指纹校准（导出供测试）：落实 x-opencode-* 四件套（静态 x-opencode-session
// > 旧 x-session-id 晋升）与 x-session-id/affinity（恒跟 sid）；
// UA 缺省时补位（静态头已配的不动——显式配置优先；缺时用 ZEN_UA，
// 全无则不发），拒绝伪造版本。客户端透传一律忽略（网关权威）。
// zen=true（即 opencode.ai 上游）才动——非 zen 上游原样不动。
// 注意：x-opencode-* 一律保留（真客户端本来就发这些；删掉才会 403）。
// envUA 是 ZEN_UA 的可注入替身（测试用，生产走 process.env.ZEN_UA）：
// 传了（哪怕空串）就用它，不再读环境——测试不碰运行环境。
//
// 网关权威原则（2026-09-18 定案）：指纹与身份类头一律以网关自己的配置为准，
// 客户端透传的会话/AFFINITY/UA 一概不采用——第三方 harness 自带的会话 ID
// （如 ZCode 的 UUID）上游根本不认识，之前按“透传优先”照单转发导致百分百 403。
// 上游（客户端）来的请求也必须用网关自己的头与指纹，不得覆盖网关算定值。
// session 参数保留（签名兼容），内容不再读取。
export function applyZenFingerprint(
  h: Record<string, string>, session?: SessionHint, zen = true, envUA?: string,
): void {
  void session
  // UA 补位：Provider 静态头已配的不动（显式配置优先）；缺时用 ZEN_UA；
  // 全都没有就不发（不编版本号）。客户端 UA 永不采用。
  if (zen && findHeaderKey(h, 'user-agent') === undefined) {
    const ua = sanitizeUA(envUA ?? process.env.ZEN_UA)
    if (ua !== undefined) h['User-Agent'] = ua
  }
  if (!zen) return
  // 会话取值：静态 x-opencode-session > 旧 x-session-id（晋升沿用）。
  // 客户端透传一律忽略（见上）。
  const staticZen = findHeaderKey(h, ZEN_SESSION_HEADER) !== undefined
    ? (h[findHeaderKey(h, ZEN_SESSION_HEADER)!] ?? '').trim() : ''
  const legacySid = findHeaderKey(h, 'x-session-id') !== undefined
    ? (h[findHeaderKey(h, 'x-session-id')!] ?? '').trim() : ''
  const sid = validZenToken(staticZen) ? staticZen
    : validZenToken(legacySid) ? legacySid : ''
  // request 取值：静态优先；缺了现铸（真机一次会话内稳定，网关侧持久化由刷新流程做，
  // 这里只保证每次发出的请求都带一个合法值）。
  let rid = findHeaderKey(h, ZEN_REQUEST_HEADER) !== undefined
    ? (h[findHeaderKey(h, ZEN_REQUEST_HEADER)!] ?? '').trim() : ''
  if (!validZenToken(rid)) rid = mintZenRequestId()
  if (sid !== '') zenHeadersWithFingerprint(h, sid, rid)
  // 旧 x-session-id/affinity 行为保留（既有配置与未知工具链可能依赖；真客户端虽不发，
  // 实测多带不影响 403 判定——403 只与四件套缺失有关）。
  if (!validZenToken(sid)) return // 无可用会话：不硬凑，失败信息更干净
  // affinity 恒跟 sid（真机两者同值；客户端 affinity 同会话一样不采用）。
  const affKey = findHeaderKey(h, 'x-session-affinity')
  const sidKey = findHeaderKey(h, 'x-session-id')
  if (sidKey !== undefined) h[sidKey] = sid
  else h['x-session-id'] = sid
  if (affKey !== undefined) h[affKey] = sid
  else h['x-session-affinity'] = sid
}

// 瞬时重试的时间预算：只有在 fetch 起点 5s 内就失败才值得同条件再打一次。
// 快 500/快拒连多是抖动；慢失败说明上游真在挣扎（或连接挂起），重试只会翻倍等待。
export const TRANSIENT_RETRY_BUDGET_MS = 5000

// ---- Zen 会话池轮换（2026-09-18 实测：免费档限流按 x-opencode-session 算） ----
//
// 取证：同一会话连打十轮 xhigh 必 429（rate_limit_exceeded），而本机 opencode
// 开多个窗口（每窗口新会话）一点事没有；换会话立刻恢复。结论：限流维度是会话
// 而不是 IP（出口同为 clash 代理）。
//
// 策略：会话池（discover 写进 x-polycode-session-pool）做 429 触发式轮换。
// 注意不是逐请求预防性轮换：每请求都换会话只会把所有会话的配额窗口同时打满，
// 还破坏上游按会话的亲和性；正确做法是首打用主会话（池首 = 最新），
// 撞 429 才在本请求副本内换下一个重打（最多 min(池长,4) 个不同会话）。
// 池只有 1 个会话时行为等同旧版（不轮换，429 原样上报）。
const zenPoolCursor = new Map<number, number>()

// 取 Provider 的会话池（无池返回空数组）。池头由 discover/zen_refresh 写。
export function zenSessionPoolOf(p: Provider): string[] {
  return parseZenSessionPool(p.headers ?? {})
}

// 池轮换游标（保留供潜在的预防性轮换用；当前转发路径不用它——
// 429 重试在请求副本内顺序推进，见 streamWith 的 shiftLocal）。
// 无池返回 undefined。
export function nextZenSession(p: Provider): string | undefined {
  const pool = zenSessionPoolOf(p)
  if (pool.length === 0) return undefined
  const i = zenPoolCursor.get(p.providerId) ?? 0
  zenPoolCursor.set(p.providerId, (i + 1) % pool.length)
  return pool[i % pool.length]
}

// 测试用：清空轮换游标（避免用例间串状态）。
export function resetZenPoolCursor(): void {
  zenPoolCursor.clear()
}

// 把指定会话提到池首：同请求的 headers 副本内部轮换用，不写回库里那份。
// 调用方须保证 h 是本请求自有副本（deep copy），禁止传库内 Provider.headers 原引用，
// 否则一次 429 重试会污染调度器里的 Provider 与所有在途请求。
export function shiftZenSessionHeaders(
  h: Record<string, string>, pool: string[], sid: string,
): void {
  if (!validZenToken(sid)) return
  // 只认池内会话：轮换器给的值必定来自池；池外的值说明是脏输入，不塞进去
  // （凭空的会话 ID 上游不认识，塞了只会 403）。
  if (pool.length === 0 || !pool.includes(sid)) return
  const merged = [sid, ...pool.filter((s) => s !== sid)]
  writeZenSessionPool(h, merged)
  const sk = findHeaderKey(h, ZEN_SESSION_HEADER)
  if (sk !== undefined) h[sk] = sid
  else h[ZEN_SESSION_HEADER] = sid
}

// 旧签名兼容（测试用）：只动传进来的 Provider.headers，不写库。
// 注意：并发转发路径禁止用它（见 shiftZenSessionHeaders），只留给单线程测试。
export function shiftZenSession(p: Provider, sid: string): void {
  const h = p.headers
  if (!h) return
  shiftZenSessionHeaders(h, parseZenSessionPool(h), sid)
}

// 429 换会话重试的次数上限（池里有几个会话就最多试几个，但设硬上限防打爆）。
const ZEN_POOL_RETRY_MAX = 4

export class Upstream {
  // 上游调用器：协议解析/自动探测、动态头铸币、出口代理分流、模型目录拉取。
  // 无状态（除 dispatcher 缓存与 autoProtocol 进程内记忆）；失败一律抛 UpstreamError。
  // 注意：对外仍是“按 irReq.stream 语义调用”，但落线一律流式——非流式请求在
  // streamWith/streamWithTimeout 内被提升为流式发出，由 proxy.forward 收齐拼包。
  // 这样残缺的非流式端点（workbuddy 404、zen 免费档 403）对客户端全部透明。
  private credLookup: Lookup
  private noAutoProtocol: boolean
  private egresses: Record<string, string>
  private dispatchers = new Map<string, unknown>()

  constructor(opts: UpstreamOpts = {}) {
    this.credLookup = opts.credLookup ?? defaultLookup
    this.noAutoProtocol = opts.noAutoProtocol ?? false
    this.egresses = opts.egresses ?? {}
  }

  // 出口代理表热更新（管理面增删 egress 后调用）：换表并丢弃旧 dispatcher 缓存。
  setEgresses(map: Record<string, string>): void {
    this.egresses = map
    this.dispatchers.clear()
  }

  // 按 Provider.egress 选取 dispatcher（懒建缓存；未声明 = 直连 undefined）。
  private dispatcherFor(p: Provider): unknown {
    if (!p.egress) return undefined
    let d = this.dispatchers.get(p.egress)
    if (!d) {
      const uri = this.egresses[p.egress]
      if (!uri) throw new UpstreamError(0, UPSTREAM.NETWORK, `egress "${p.egress}" 未配置（顶层 egresses 缺失）`)
      d = new ProxyAgent(uri)
      this.dispatchers.set(p.egress, d)
    }
    return d
  }

  private fetch(url: string, init: FetchInit): Promise<Response> {
    return undiciFetch(url, init as never) as unknown as Promise<Response>
  }

  // 派生一个共享凭据查找与出口表的实例（探测用：关掉协议自动回退，观察单协议真实结果）。
  // egresses 必须一并继承：探测路径也走 Provider.egress，丢了会报「egress 未配置」
  // 而真实转发却正常（探测按钮真实缺陷）。
  withOpts(over: Partial<UpstreamOpts>): Upstream {
    // credLookup 必须可被覆盖（`over.credLookup ?? this.credLookup`）：
    // 旧写法硬继承 this.credLookup，传进来的 lookup 被静默丢弃——调用方以为
    // 换成了自己的凭据解析，实际仍走原实例的（zen 公共 key 探针因此恒报
    // 「环境变量 ZEN_KEY 未设置」的假阴性）。
    const derived = new Upstream({
      credLookup: over.credLookup ?? this.credLookup,
      noAutoProtocol: over.noAutoProtocol ?? this.noAutoProtocol,
      egresses: over.egresses ?? this.egresses,
    })
    return derived
  }

  // 向上游发起流式请求。非 2xx / 网络错误 → 抛 UpstreamError（首字节前，可换源）；
  // 2xx → 返回响应 body 流（此后不可换源）。
  // 协议解析顺序：模型级 api → 缓存的事实协议 → Provider 默认 api；
  // 三者皆无时逐个试候选协议，首个成功者被记住。
  // session：opencode 做客户端时的会话透传（缺省用 Provider 静态头）。
  async stream(p: Provider, irReq: IrRequest, session?: SessionHint): Promise<ReadableStream<Uint8Array>> {
    const [proto, known] = resolveProtocol(p, irReq.model)
    if (this.noAutoProtocol) {
      if (!known) {
        throw new UpstreamError(0, UPSTREAM.BAD_REQUEST, '协议未定且已关闭自动回退，无法发请求')
      }
      return this.streamWith(p, irReq, proto, session)
    }
    let lastErr: unknown
    if (known) {
      try {
        return await this.streamWith(p, irReq, proto, session)
      } catch (err) {
        if (!shouldTryOtherProtocol(err)) throw err
        forgetProtocol(p.name, irReq.model) // 记住的协议失效 → 丢掉并重探
        lastErr = err
      }
    }
    for (const cand of probeOrder(proto)) {
      try {
        const s = await this.streamWith(p, irReq, cand, session)
        rememberProtocol(p.name, irReq.model, cand)
        return s
      } catch (err) {
        lastErr = err
        if (!shouldTryOtherProtocol(err)) throw err // 凭据/请求侧硬错误：换协议无意义
      }
    }
    throw lastErr ?? new UpstreamError(0, UPSTREAM.UNKNOWN, '没有可用协议')
  }

  // 用指定协议打一次上游。有动态头时最多打两次：首调失败且为换 token 信号 → 重铸再打一次。
  //
  // 网关内部一律用流式打上游（所有 Provider 生效，不止 zen）：部分上游的非流式
  // 端点残缺或直接拒单（如 workbuddy 报 11101/404、zen 免费档非流式恒 403），
  // 而流式端点人人都有；非流式客户端由 proxy.forward 把 SSE 收齐拼成单包返回，
  // 客户端看到的仍是非流式（见 forward 非流式分支与 collectStreamResponse）。
  //
  // 另：网络异常与 5xx 同条件重试一次（抖动与过载常见）。4xx 是确定性拒绝
  // （鉴权/指纹/地区/坏请求），重试只浪费 token，直接抛。
  private async streamWith(p: Provider, irReq: IrRequest, proto: Protocol, session?: SessionHint): Promise<ReadableStream<Uint8Array>> {
    // upReq 是真正上游的请求：流式固定 true（客户端要非流式也先流式拿回来再拼）。
    const upReq: IrRequest = irReq.stream ? irReq : { ...irReq, stream: true }
    let body: Uint8Array
    let path: string
    try {
      const codec = getOutbound(proto)
      // zen 免费档要 agent 体裁才放行（缺 read/bash 工具声明或 tool_choice 即 403，
      // 与指纹头无关的独立判定）：这里统一补，转发侧无需逐个操心。
      body = codec.serializeRequest(ensureZenAgentShape(upReq, p.baseUrl))
      path = codec.requestPath()
    } catch (err) {
      if (err instanceof UpstreamError) throw err
      throw new UpstreamError(0, UPSTREAM.BAD_REQUEST, `序列化上游请求失败: ${(err as Error).message}`)
    }

    const url = buildRequestURL(p.baseUrl, path)
    const attempts = p.dynamicHeaders ? 2 : 1
    // 瞬时故障同条件重试一次（各 attempt 共享一次额度，不占用动态头重铸次数）：
    // 连接被重置/超时与 Console 过载 500 常见，重打一次常能过去。
    // 但只给“快失败”重试：慢 500（≥5s才回）说明上游真在挣扎，重试只是把
    // 用户的等待翻倍，直接抛让客户端早失败早重试。判定点见每次 fetch 起点。
    let transientRetried = false
    const retryTransient = async (): Promise<boolean> => {
      if (transientRetried) return false
      transientRetried = true
      await new Promise<void>((r) => setTimeout(r, 500))
      return true
    }
    // 会话池 429 轮换（仅 zen）：限流按会话算，换一个就恢复。
    // 池快照（请求级深拷贝）：游标 + 池内顺序全在本地副本上推进，
    // 库内 Provider.headers 与其他在途请求一律不动（并发隔离）。
    // 池在头里（x-polycode-session-pool），游标进程内自增，等效 opencode 多窗口。
    const zenPool = isZenUpstream(p.baseUrl) ? zenSessionPoolOf(p) : []
    const zenHeaders: Record<string, string> | null = zenPool.length > 1 ? { ...(p.headers ?? {}) } : null
    // 已试过的会话（按首打快照顺序）：首打用池首主会话，重试只取没试过的，
    // 同一会话绝不打第二遍（它刚回 429，立刻重打是浪费额度）。
    const zenTriedSet = new Set<string>()
    let zenTried = 0
    // 内存轮换（本请求副本内）：按首打快照顺序取下一个没试过的会话，
    // 提池首并同步 x-opencode-session。用副本内自己的顺序推进，
    // 不碰进程游标、不碰库内 Provider（并发隔离）。
    const shiftLocal = (): string | undefined => {
      if (!zenHeaders) return undefined
      const pool = parseZenSessionPool(zenHeaders)
      const next = zenPool.find((s) => pool.includes(s) && !zenTriedSet.has(s))
      if (!next) return undefined
      zenTriedSet.add(next)
      zenTried++
      shiftZenSessionHeaders(zenHeaders, pool, next)
      return next
    }
    for (let a = 0; a < attempts; a++) {
      // 本次 fetch 用的 Provider 视图：429 轮换中（已换过会话）用副本，否则用原件。
      // 副本 headers 已深拷贝，buildHeaders 再怎么合并也不会污染库内那份。
      const view: Provider = zenHeaders && zenTried > 0 ? { ...p, headers: zenHeaders } : p
      // 首打会话记入已试集：重试时跳过它（刚 429 的会话不打第二遍）。
      if (zenHeaders && zenTried === 0) {
        const first = parseZenSessionPool(zenHeaders)[0]
        if (first) zenTriedSet.add(first)
      }
      let dyn: Record<string, string> | null = null
      if (p.dynamicHeaders) {
        try {
          dyn = await mintDynamicHeaders(p.dynamicHeaders)
        } catch (err) {
          throw new UpstreamError(0, UPSTREAM.NETWORK, (err as Error).message)
        }
      }
      const t0 = Date.now()
      // 快失败（5s 内）才值得重试一次；慢失败直接抛（见上）。
      const retryable = async (): Promise<boolean> =>
        Date.now() - t0 < TRANSIENT_RETRY_BUDGET_MS && retryTransient()
      let resp: Response
      try {
        resp = await this.fetch(url, {
          method: 'POST',
          headers: this.buildHeaders(view, upReq.stream, dyn, proto, session),
          body: body as never, // Node fetch 接受 Uint8Array；类型侧缺 DOM BodyInit
          dispatcher: this.dispatcherFor(p) as never,
        })
      } catch (err) {
        if (err instanceof UpstreamError) throw err // 凭据缺失等本地错误：原样上报，别降级成 network
        if (await retryable()) { a--; continue } // 连接级抖动：同条件再打一次
        throw new UpstreamError(0, UPSTREAM.NETWORK, (err as Error).message)
      }
      if (resp.status >= 200 && resp.status <= 299) {
        return resp.body! // 已到首字节：此后不可换源
      }
      const text = await resp.text() // text() 已消费 body，无需再 cancel
      console.warn(`[upstream] POST ${url} -> ${resp.status} (${ue2s(resp.status, text)})`)
      const ue = new UpstreamError(resp.status, classifyUpstreamError(resp.status, text), summarizeUpstreamBody(text))
      // 429 且池里还有没试过的会话：换会话重打（限流按会话算，换一个就恢复）。
      // 不占用 transient 额度——这是与 500 抖动不同维度的重试。
      // 边界：首打 1 个 + 最多 min(池长, ZEN_POOL_RETRY_MAX) - 1 次换会话，
      // 同一会话不打第二遍（shiftLocal 按已试集过滤）。
      if (ue.kind === UPSTREAM.RATE_LIMIT && zenHeaders && zenTriedSet.size < Math.min(zenPool.length, ZEN_POOL_RETRY_MAX)) {
        const next = shiftLocal()
        if (next) {
          console.warn(`[zen-pool] 429 换会话重试（第 ${zenTried} 次）：${next.slice(0, 16)}…`)
          a-- // 不消耗 attempts
          continue
        }
      }
      if ((ue.kind === UPSTREAM.SERVER || ue.kind === UPSTREAM.NETWORK) && await retryable()) {
        a-- // 快失败的过载 500 系：同条件再打一次（动态头重铸次数不受影响）
        continue
      }
      // 换 token 信号看原文全文：提炼只留人话 + 业务码，散落在其它字段的标记会丢。
      if (a === 0 && p.dynamicHeaders && needsRemint(text, p.dynamicHeaders.retryOn)) {
        continue // 换 token 信号：重铸一次
      }
      throw ue
    }
    throw new UpstreamError(0, UPSTREAM.UNKNOWN, 'unreachable')
  }

  // 按协议设置鉴权与必要头（传输层知识，不属于 IR 消息边界）。
  // 顺序：静态自定义头 → 动态铸币头（覆盖同名静态）→ 内建鉴权/协议头（优先级最高，防覆盖）。
  //
  // 凭据解析失败一律抛错、绝不「省略 Authorization 照发」：issue #1 实测——空 WB_TOKEN
  // 打到腾讯 Copilot 前的 APISIX，被拦成一段 HTML 401，UI 原样显示成「上游鉴权失败」，
  // 用户完全看不出是自己没配凭据。宁可本地报错，也不打这种必然失败还误导人的上游请求。
  private buildHeaders(
    p: Provider, stream: boolean, dyn: Record<string, string> | null, proto: Protocol,
    session?: SessionHint,
  ): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (stream) h['Accept'] = 'text/event-stream'
    for (const [k, v] of Object.entries(p.headers ?? {})) h[k] = v
    for (const [k, v] of Object.entries(dyn ?? {})) h[k] = v
    // 内网池头永不上 wire：轮换只在网关内存里做，上游只需要单个 x-opencode-session。
    // （位置：静态/动态头合并之后、指纹校准之前——动态铸币也不得把池头带回来。）
    { const pk = findHeaderKey(h, ZEN_SESSION_POOL_HEADER); if (pk !== undefined) delete h[pk] }
    // zen 指纹校准必须在鉴权头落定前做：它只动 UA/会话类头，不碰 Authorization。
    applyZenFingerprint(h, session, isZenUpstream(p.baseUrl))
    let key = ''
    if (p.credential.apiKeyEnv || p.credential.apiKeyFile) {
      const [v, ok] = credentialResolve(p.credential, this.credLookup)
      if (!ok) throw new UpstreamError(0, UPSTREAM.AUTH, missingCredentialMessage(p))
      key = v
    }
    if (proto === 'anthropic-messages') {
      if (key) {
        h['x-api-key'] = key
        h['Authorization'] = `Bearer ${key}` // 兼容只认 Bearer 的 Anthropic 兼容网关
      }
      h['anthropic-version'] = '2023-06-01'
    } else if (key) {
      h['Authorization'] = `Bearer ${key}`
    }
    return h
  }

  // 拉取上游模型目录，并解析上游声明的 protocols 与能力口径（解析宽容）。
  async fetchModelsWithProtocols(p: Provider): Promise<
    [string[], Record<string, Protocol>, Record<string, Capabilities>]
  > {
    const url = joinURL(p.baseUrl, 'models')
    let dyn: Record<string, string> | null = null
    if (p.dynamicHeaders) dyn = await mintDynamicHeaders(p.dynamicHeaders)
    let resp: Response
    try {
      resp = await this.fetch(url, { headers: this.buildHeaders(p, false, dyn, p.api), dispatcher: this.dispatcherFor(p) as never })
    } catch (err) {
      if (err instanceof UpstreamError) throw err // 凭据缺失等本地错误：原样上报，别降级成 network
      throw new UpstreamError(0, UPSTREAM.NETWORK, (err as Error).message)
    }
    if (resp.status < 200 || resp.status > 299) {
      const text = await resp.text().catch(() => '') // 消费掉响应体，避免连接悬挂
      throw new UpstreamError(resp.status, classifyUpstreamError(resp.status, text),
        `上游不支持模型列表（GET ${url} 返回 ${resp.status}），请手填模型 ID`)
    }
    let wire: {
      data?: { id?: string; protocols?: string[]; modalities?: { input?: string[] }; input?: string[]; limit?: { context?: number; output?: number } }[]
      models?: unknown
    }
    try {
      wire = (await resp.json()) as typeof wire
    } catch {
      throw new UpstreamError(0, UPSTREAM.BAD_REQUEST, '模型列表不是合法 JSON，请手填模型 ID')
    }
    const ids: string[] = []
    const declared: Record<string, Protocol> = {}
    const caps: Record<string, Capabilities> = {}
    for (const d of wire.data ?? []) {
      if (!d.id) continue
      ids.push(d.id)
      const proto = pickDeclaredProtocol(d.protocols ?? [])
      if (proto) declared[d.id] = proto
      const c = capabilitiesFrom(d.modalities?.input ?? [], d.input ?? [], d.limit?.context ?? 0, d.limit?.output ?? 0)
      if (c) caps[d.id] = c
    }
    ids.push(...parseModelList(wire.models))
    if (ids.length === 0) {
      throw new UpstreamError(0, UPSTREAM.BAD_REQUEST, '模型列表为空（data/models 均无可用 ID），请手填模型 ID')
    }
    return [ids, declared, caps]
  }

  // 只要 ID 列表（兼容既有调用）。
  async fetchModels(p: Provider): Promise<string[]> {
    const [ids] = await this.fetchModelsWithProtocols(p)
    return ids
  }

  // 带超时信号的单次流式请求（探测用）。语义同 stream()，但由外部 signal 控制超时。
  // 同样内部一律流式（见 streamWith）：探针本就只发 stream:true，此处只是把形态钉死。
  async streamWithTimeout(
    p: Provider, irReq: import('../ir/index.ts').IrRequest, signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const [proto, known] = resolveProtocol(p, irReq.model)
    if (!known) throw new UpstreamError(0, UPSTREAM.BAD_REQUEST, '协议未定，无法发请求')
    // upReq 是真正上游的请求：流式固定 true。
    const upReq: import('../ir/index.ts').IrRequest = irReq.stream ? irReq : { ...irReq, stream: true }
    let body: Uint8Array
    let path: string
    try {
      const codec = getOutbound(proto)
      // 探测路径同样走体裁保底：探针本就是极简 `hi`，不补则 zen 恒 403，
      // 会把「体裁不对」误报成「源不可用」（与 streamWith 同语义，见 ensureZenAgentShape）。
      body = codec.serializeRequest(ensureZenAgentShape(upReq, p.baseUrl))
      path = codec.requestPath()
    } catch (err) {
      throw new UpstreamError(0, UPSTREAM.BAD_REQUEST, `序列化上游请求失败: ${(err as Error).message}`)
    }
    let resp: Response
    try {
      resp = await this.fetch(buildRequestURL(p.baseUrl, path), {
        method: 'POST',
        headers: this.buildHeaders(p, upReq.stream, null, proto),
        body: body as never,
        signal,
        dispatcher: this.dispatcherFor(p) as never,
      })
    } catch (err) {
      if (err instanceof UpstreamError) throw err // 凭据缺失等本地错误：原样上报，别降级成 network
      throw new UpstreamError(0, UPSTREAM.NETWORK, (err as Error).message)
    }
    if (resp.status >= 200 && resp.status <= 299) return resp.body!
    // resp.text() 已消费 body（此时 cancel() 会抛 ERR_INVALID_STATE 并崩掉进程——真实环境教训）
    const text = await resp.text()
    throw new UpstreamError(resp.status, classifyUpstreamError(resp.status, text), summarizeUpstreamBody(text))
  }
}

// 凭据解析失败的对外文案：必须点名缺的是哪个变量/文件，并给可执行的下一步。
// 只说「凭据无效」用户仍不知道去哪配；照抄上游 HTML 401 更是误导（issue #1）。
export function missingCredentialMessage(p: Provider): string {
  if (p.credential.apiKeyFile) {
    return `凭据文件读不到 provider=${p.name} file=${p.credential.apiKeyFile}`
      + `（先确认文件存在且可读；Discover「一键导入」会把桌面登录态写入该文件）`
  }
  const env = p.credential.apiKeyEnv ?? ''
  return `环境变量 ${env} 未设置 provider=${p.name}`
    + `（先 export ${env}=... 并重启网关，或到 Providers 点「一键导入」把桌面登录态导入账号池）`
}

// 403 语义细分：上游对「模型不在本端点/本出口」也回 403（实测 zen muse 系 RegionError）。
// 它不是凭据问题——归 auth 会挡死协议自动回退（模型唯一认的端点永远轮不到）。
//
// 429 语义细分：额度用尽和限流都是 429，但恢复方式完全不同。
//   限流（rate_limit）：等一会儿就好 → 短冷却自动复活；
//   额度用尽（quota）：充值/换号前永远不会好 → 长冷却甚至停用，别让它反复爬起空转。
// 只看状态码会把两者混为一谈（workbuddy 实测 429 + code 14018「额度已用尽」）。
const QUOTA_HINT = /额度已用尽|额度不足|余额不足|quota|insufficient[_ ]?quota|exceeded your current quota|billing|欠费|超出配额/i

export function classifyUpstreamError(status: number, body: string): string {
  const kind = kindForStatus(status)
  if (kind === UPSTREAM.AUTH) {
    // 403 不等于「你的 Key 错了」。上游用 403 表达很多策略性拒绝，
    // 归成 auth 会把用户引向错误方向（反复去翻/重置 API Key，而 Key 其实是好的）。
    // 已确认的三类：
    //   RegionError   —— 地区不可用（换出口代理能解）
    //   FreeTierError —— 免费档只认官方客户端指纹，单独归 FINGERPRINT。
    //     2026-09-17 实测："OpenCode's free tier can only be used from within OpenCode"，
    //     触发条件是缺 x-opencode-session 四件套（或会话过期）；旧 x-session-id 仅作晋升兼容输入。
    //     指纹对上后匿名 Bearer public 照常用。
    //     归 auth 会误导用户去翻 API Key（Key 是好的）；归 bad_request 又会被探测
    //     当作「协议路径噪音」压到最低优先级（见 probe.errorRank），真实病因浮不上来。
    //     指纹是「配置缺失」而非「上游故障」：换出口/换协议都无解，必须点名去配。
    // 地区限制：换出口代理即可解，独立归类（见 ir.UPSTREAM.REGION）。
    // 归 bad_request 会让用户以为模型下线了，实际是出口 IP 不在可用地区。
    if (/regionerror|not available in your country/i.test(body)) return UPSTREAM.REGION
    if (/freetiererror|free tier can only be used/i.test(body)) return UPSTREAM.FINGERPRINT
  }
  if (kind === UPSTREAM.RATE_LIMIT && QUOTA_HINT.test(body)) {
    return UPSTREAM.QUOTA
  }
  return kind
}

// 上游错误体提炼（导出供测试）：各家报错字段名不一样（message / msg /
// error.message / error.data.msg / detail……），直接把原文 JSON 怼给用户，
// 前面全是 `upstream bad_request (http 400): {"error":` 这种前缀，真正的
// 原因被挤到省略号后面看不见。这里尽力抽出「人话 + 业务码」，抽不出再回落
// 原文截断。前缀 `upstream <kind> (http <status>)` 保持不动（测试与
// errorRank/issue-1 断言都依赖它），只换冒号后面的部分。
export function summarizeUpstreamBody(text: string): string {
  const t = text.trim()
  if (t === '') return '(上游空响应体)'
  const parsed = tryParseObject(t)
  if (parsed) {
    const msg = firstString(parsed, [
      ['error', 'message'], ['error', 'msg'],
      ['error', 'data', 'msg'], ['error', 'data', 'message'],
      ['message'], ['msg'], ['detail'], ['error', 'detail'],
    ])
    if (msg) {
      const code = firstScalar(parsed, [
        ['error', 'code'], ['error', 'data', 'code'], ['code'],
      ])
      // code 已在消息里出现过就不再缀一次（如 "[1113] Insufficient balance."）。
      const suffix = code !== undefined && !msg.includes(String(code)) ? ` (code ${String(code)})` : ''
      return msg + suffix
    }
  }
  // HTML 错误页（APISIX/网关 404 页）：去标签取正文，issue-1 的教训——整页
  // HTML 怼给用户等于没说，还会把凭据排查带偏。
  if (/<[a-z][\s\S]*>/i.test(t)) {
    const stripped = t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    if (stripped !== '') return truncate(stripped, 200)
  }
  return truncate(t, 200)
}

function tryParseObject(t: string): Record<string, unknown> | undefined {
  if (!t.startsWith('{')) return undefined
  try {
    const v: unknown = JSON.parse(t)
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>
    }
  } catch { /* 非 JSON，走回落 */ }
  return undefined
}

function dig(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj
  for (const k of path) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

function firstString(obj: Record<string, unknown>, paths: string[][]): string | undefined {
  for (const p of paths) {
    const v = dig(obj, p)
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return undefined
}

function firstScalar(obj: Record<string, unknown>, paths: string[][]): string | number | undefined {
  for (const p of paths) {
    const v = dig(obj, p)
    if ((typeof v === 'string' && v.trim() !== '') || typeof v === 'number') return v
  }
  return undefined
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s
}

// 简短状态摘要（日志用，不泄漏 body 明文细节）
function ue2s(status: number, body: string): string {
  return body.slice(0, 80).replace(/\s+/g, ' ')
}

// ---- 协议解析与探测 ----

// 解析该请求应使用的协议，并报告是否已知（false = 需要自动探测）。
// 导出供转发侧复用：请求与响应解析必须用同一个协议，否则会解析错。
export function resolveProtocol(p: Provider, modelID: string): [Protocol, boolean] {
  const m = p.models?.find((x) => x.id === modelID)
  if (m?.api) return [m.api, true]
  const fact = autoProtocol(p.name, modelID)
  if (fact) return [fact, true]
  if (p.api) return [p.api, true]
  return ['', false]
}

// 自动探测的候选协议顺序：优先上次解析到的，其余按常见度补全。
export function probeOrder(first: Protocol): Protocol[] {
  const all: Protocol[] = ['openai-completions', 'openai-responses', 'anthropic-messages']
  if (!first) return all
  return [first, ...all.filter((p) => p !== first)]
}

// 是否值得换协议重试：5xx/网络抖/协议路径不匹配（400/404 归入 BAD_REQUEST）可试；
// 401/403 凭据硬错误换协议无意义。
export function shouldTryOtherProtocol(err: unknown): boolean {
  if (!(err instanceof UpstreamError)) return false
  return err.kind === UPSTREAM.SERVER || err.kind === UPSTREAM.NETWORK || err.kind === UPSTREAM.BAD_REQUEST
}

// ---- 动态头铸币（对齐 Go internal/router/dynheaders.go）----
// 约束：绝对路径、不走 shell、超时杀掉、环境继承；值永不进日志。
// 空行/#注释/坏行容忍跳过。

export async function mintDynamicHeaders(spec: DynamicHeadersSpec): Promise<Record<string, string>> {
  if (!spec.command || !spec.command.startsWith('/')) {
    throw new Error(`minter command 必须用绝对路径: "${spec.command}"`)
  }
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(spec.command, spec.args ?? [], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let errText = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), dynamicHeadersTimeout(spec))
    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    child.stderr.on('data', (d: Buffer) => { errText += d.toString() })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`minter 执行失败（exit/timeout），stderr ${errText.length} 字节: exit code ${code}`))
    })
  })
  const out: Record<string, string> = {}
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i <= 0) continue
    const k = line.slice(0, i).trim()
    const v = line.slice(i + 1).trim()
    if (!k || !v) continue
    out[k] = v
  }
  return out
}

// 报告上游失败是否为「换个 token 就可能好」的信号。
// markers 为空用默认集（captcha 闸门 3007/captcha、复用冲突 F008/verify）。
export function needsRemint(snippet: string, markers?: string[]): boolean {
  const ms = markers && markers.length > 0 ? markers : ['3007', 'captcha', 'f008', 'verify']
  const s = snippet.toLowerCase()
  return ms.some((m) => m && s.includes(m.toLowerCase()))
}

// ---- URL 与模型列表 ----

// baseURL 停在操作路径之前；anthropic 路径以 / 开头，openai 系为相对段（坑位 #2）。
export function joinURL(baseURL: string, path: string): string {
  return baseURL.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '')
}

// 按协议拼接真实请求 URL，消除 baseURL 与路径之间的 /v1 重复（真实缺陷回归）。
//
// 冲突来源：baseURL 约定按协议不同——anthropic-messages 停域名根（路径给 "/v1/messages"），
// openai 系停 "/v1"（路径给相对段 "responses"）。但同一个 Provider 可能被三种协议轮流打
// （自动探测/回退），单一 baseURL 无法同时满足两套约定：zen 的 baseUrl 是
// https://opencode.ai/zen/v1（openai 口径），轮到 anthropic-messages 时就拼成
// /zen/v1/v1/messages → 上游回 404 HTML 页。
// 这里只去重结尾的 /v1：openai 系相对路径不受影响，anthropic 路径恢复正确。
export function buildRequestURL(baseURL: string, path: string): string {
  const b = baseURL.replace(/\/+$/, '')
  const p = path.replace(/^\/+/, '')
  const joined = p === 'v1' || p.startsWith('v1/') ? b.replace(/\/v1$/, '') : b
  return joined + '/' + p
}

// 把上游声明的协议名映射为本项目协议；多个候选取最保真的一个
// （anthropic-messages > openai-responses > openai-completions）。
export function pickDeclaredProtocol(names: string[]): Protocol {
  const rank = (p: Protocol): number =>
    p === 'anthropic-messages' ? 3 : p === 'openai-responses' ? 2 : p === 'openai-completions' ? 1 : 0
  const map: Record<string, Protocol> = {
    messages: 'anthropic-messages', message: 'anthropic-messages', anthropic: 'anthropic-messages',
    'anthropic-messages': 'anthropic-messages',
    responses: 'openai-responses', response: 'openai-responses', 'openai-responses': 'openai-responses',
    chat_completions: 'openai-completions', 'chat-completions': 'openai-completions',
    completions: 'openai-completions', 'openai-completions': 'openai-completions',
  }
  let best: Protocol = ''
  for (const n of names) {
    const p = map[n.trim().toLowerCase()]
    if (p && rank(p) > rank(best)) best = p
  }
  return best
}

// 解析 {models} 的数组/对象两种形态，非法元素跳过。
export function parseModelList(raw: unknown): string[] {
  if (raw === null || raw === undefined) return []
  if (Array.isArray(raw)) {
    const ids: string[] = []
    for (const el of raw) {
      if (typeof el === 'string') { if (el) ids.push(el); continue }
      if (el && typeof el === 'object' && typeof (el as { id?: unknown }).id === 'string') {
        if ((el as { id: string }).id) ids.push((el as { id: string }).id)
      }
    }
    return ids
  }
  if (typeof raw === 'object') {
    return Object.keys(raw as Record<string, unknown>).sort()
  }
  return []
}
