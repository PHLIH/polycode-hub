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
// 上游免费档只认「官方客户端样子」的请求（否则 403 FreeTierError）：
//   User-Agent：官方客户端的真串（三段式 opencode/<ver> ai-sdk/… runtime/…，
//     版本号随官方发版变）
//   x-session-id / x-session-affinity：官方客户端会话 ID（ses_…）
// 2026-09 前用的 x-opencode-client/project/request/session 四件套现在是毒头——
// 带了必回 403（"can only be used from within OpenCode"），真机抓包确认官方
// 客户端根本不发这四个头。
//
// 网关是通用项目，不内置任何版本号、不伪造 UA，只做「诚实透传 + 配置兜底」：
//   UA 缺省时的补位优先级（已配的不覆盖——显式配置优先于隐式透传）：
//     1. Provider 静态头里的 User-Agent（运维自己抓包取的真串；删掉即回到透传）；
//     2. 客户端透传：opencode 做客户端时它的真 UA 直达上游
//        （见 proxy.sessionHintFromHeaders，来什么透什么，网关不改写）；
//     3. ZEN_UA 环境变量（项目级默认，同样由运维提供真串）；
//     4. 全都没有——如实不发，不编版本号。403 时按 FreeTierError 指引去配真串。
//   注意 UA 与会话头的优先级是反的（会话是 透传 > 静态）：会话的静态值会过期，
//   活的永远比配的真；UA 的静态值是运维抓包 curated 的，客户端带来的反而可能是
//   curl/Cherry Studio 之类非官方串——静态优先能保住配好的指纹不被冲掉。
//   注入安全：透传/配置的 UA 只收单行可打印 ASCII（防 CR/LF 头注入），
//   超长（>512）截断；会话 token 仍走 validSessionToken 白名单（非法不写头）。
//
// 会话 ID 必须来自一次真实的官方客户端运行（`opencode run --print-logs` 输出的
// created id=ses_…），跨模型、跨端点可复用；本地随机编一个通不过。
// opencode 自己做客户端时网关直接透传它的会话头（见 proxy.sessionHintFromHeaders），
// 其他客户端则用 Provider 静态头里的那一份；都没有就不硬凑。

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

function isZenUpstream(baseUrl: string): boolean {
  try {
    const h = new URL(baseUrl).hostname.toLowerCase()
    return h === 'opencode.ai' || h.endsWith('.opencode.ai')
  } catch {
    return false
  }
}

// 大小写不敏感的头查找（fetch 头名不敏感，但这里操作的是普通对象）。
function findHeaderKey(h: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase()
  for (const k of Object.keys(h)) if (k.toLowerCase() === want) return k
  return undefined
}

function validSessionToken(s: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(s)
}

// zen 指纹校准（导出供测试）：去毒头、落实会话头（透传 > 静态）；
// UA 缺省时补位（静态头已配的不动——显式配置优先；缺时按 透传 > ZEN_UA 补，
// 全无则不发），拒绝伪造版本。
// zen=true（即 opencode.ai 上游）才补位——非 zen 上游缺 UA 就是缺，不碰。
// 去毒头不限 host：x-opencode-* 是本网关早期逆向的臆测头，官方客户端从不发送，
// 发给任何上游都没有意义，只会触发 zen 系网关的免费档拒绝。
// envUA 是 ZEN_UA 的可注入替身（测试用，生产走 process.env.ZEN_UA）：
// 传了（哪怕空串）就用它，不再读环境——测试不碰运行环境。
export function applyZenFingerprint(
  h: Record<string, string>, session?: SessionHint, zen = true, envUA?: string,
): void {
  for (const n of ['x-opencode-client', 'x-opencode-project', 'x-opencode-request', 'x-opencode-session']) {
    const k = findHeaderKey(h, n)
    if (k !== undefined) delete h[k]
  }
  // UA 补位：Provider 静态头已配的不动（buildHeaders 里静态头先落头，
  // 显式配置优先）；缺时按 透传 > ZEN_UA 补；全都没有就不发（不编版本号）。
  if (zen && findHeaderKey(h, 'user-agent') === undefined) {
    const ua = sanitizeUA(session?.userAgent) ?? sanitizeUA(envUA ?? process.env.ZEN_UA)
    if (ua !== undefined) h['User-Agent'] = ua
  }
  const staticId = findHeaderKey(h, 'x-session-id') !== undefined
    ? (h[findHeaderKey(h, 'x-session-id')!] ?? '').trim() : ''
  const sid = (session?.id ?? '').trim() || staticId
  if (!validSessionToken(sid)) return // 无可用会话：不硬凑，失败信息更干净
  const aff = (session?.affinity ?? '').trim()
  const affKey = findHeaderKey(h, 'x-session-affinity')
  const sidKey = findHeaderKey(h, 'x-session-id')
  if (sidKey !== undefined) h[sidKey] = sid
  else h['x-session-id'] = sid
  const affVal = validSessionToken(aff) ? aff : sid
  if (affKey !== undefined) h[affKey] = affVal
  else h['x-session-affinity'] = affVal
}

export class Upstream {
  // 上游调用器：协议解析/自动探测、动态头铸币、出口代理分流、模型目录拉取。
  // 无状态（除 dispatcher 缓存与 autoProtocol 进程内记忆）；失败一律抛 UpstreamError。
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
    const derived = new Upstream({
      credLookup: this.credLookup,
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
  private async streamWith(p: Provider, irReq: IrRequest, proto: Protocol, session?: SessionHint): Promise<ReadableStream<Uint8Array>> {
    let body: Uint8Array
    let path: string
    try {
      const codec = getOutbound(proto)
      body = codec.serializeRequest(irReq)
      path = codec.requestPath()
    } catch (err) {
      if (err instanceof UpstreamError) throw err
      throw new UpstreamError(0, UPSTREAM.BAD_REQUEST, `序列化上游请求失败: ${(err as Error).message}`)
    }

    const url = buildRequestURL(p.baseUrl, path)
    const attempts = p.dynamicHeaders ? 2 : 1
    for (let a = 0; a < attempts; a++) {
      let dyn: Record<string, string> | null = null
      if (p.dynamicHeaders) {
        try {
          dyn = await mintDynamicHeaders(p.dynamicHeaders)
        } catch (err) {
          throw new UpstreamError(0, UPSTREAM.NETWORK, (err as Error).message)
        }
      }
      let resp: Response
      try {
        resp = await this.fetch(url, {
          method: 'POST',
          headers: this.buildHeaders(p, irReq.stream, dyn, proto, session),
          body: body as never, // Node fetch 接受 Uint8Array；类型侧缺 DOM BodyInit
          dispatcher: this.dispatcherFor(p) as never,
        })
      } catch (err) {
        if (err instanceof UpstreamError) throw err // 凭据缺失等本地错误：原样上报，别降级成 network
        throw new UpstreamError(0, UPSTREAM.NETWORK, (err as Error).message)
      }
      if (resp.status >= 200 && resp.status <= 299) {
        return resp.body! // 已到首字节：此后不可换源
      }
      const text = await resp.text() // text() 已消费 body，无需再 cancel
      console.warn(`[upstream] POST ${url} -> ${resp.status} (${ue2s(resp.status, text)})`)
      const ue = new UpstreamError(resp.status, classifyUpstreamError(resp.status, text), summarizeUpstreamBody(text))
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
  async streamWithTimeout(
    p: Provider, irReq: import('../ir/index.ts').IrRequest, signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const [proto, known] = resolveProtocol(p, irReq.model)
    if (!known) throw new UpstreamError(0, UPSTREAM.BAD_REQUEST, '协议未定，无法发请求')
    let body: Uint8Array
    let path: string
    try {
      const codec = getOutbound(proto)
      body = codec.serializeRequest(irReq)
      path = codec.requestPath()
    } catch (err) {
      throw new UpstreamError(0, UPSTREAM.BAD_REQUEST, `序列化上游请求失败: ${(err as Error).message}`)
    }
    let resp: Response
    try {
      resp = await this.fetch(buildRequestURL(p.baseUrl, path), {
        method: 'POST',
        headers: this.buildHeaders(p, irReq.stream, null, proto),
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
    // 已确认的两类：
    //   RegionError   —— 地区不可用（换出口代理能解）
    //   FreeTierError —— 免费档只认官方客户端指纹。2026-09-17 实测：
    //     "OpenCode's free tier can only be used from within OpenCode"，
    //     触发条件是缺 x-session-id/affinity 或带了旧的 x-opencode-* 四件套；
    //     指纹对上后匿名 Bearer public 照常用。出路按序：先查会话头透传/
    //     Provider 静态会话是否有效（重收一个 ses_），再考虑换付费档或换上游。
    if (/regionerror|not available in your country/i.test(body)) return UPSTREAM.BAD_REQUEST
    if (/freetiererror|free tier can only be used/i.test(body)) return UPSTREAM.BAD_REQUEST
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
