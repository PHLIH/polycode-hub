// 系统代理解析：网关常由 launchd/systemd 拉起，进程里没有 *_proxy 环境变量，
// 而下载用全局 fetch 只认环境变量——在这类机器上直连 github.com 会超时，
// 但浏览器走系统代理是通的。故 darwin 从 scutil --proxy 读、windows 从注册表
// Internet Settings 读系统代理，其余平台回落环境变量。
//
// Windows 这一段是后补的真实缺陷：早先只有 darwin 分支，于是同一台 Clash、
// 同一个网络，macOS 装得上而 Windows 永远装不上——因为 Windows 上进程环境里
// 没有 HTTPS_PROXY，代码就判定「直连」了。
//
// 注意偏差：Node 全局 fetch 不走代理（既不读 *_proxy 环境变量，也不读
// 系统代理）。本模块提供「解析代理地址 → 造出走代理的 fetch」的完整链路，
// 调用方（CLI install/ensure、管理面 ensure）把造好的 fetch 注入
// Sidecar.install/ensureReady 即可。代理实现复用项目已有依赖 undici 的
// ProxyAgent（与 router/upstream 转发面同源，不新增依赖）。

import { execFileSync } from 'node:child_process'
import { fetch as undiciFetch, ProxyAgent, Response as UndiciResponse } from 'undici'
import type { FetchLike } from './sidecar.ts'

export interface ProxyURL {
  scheme: 'http' | 'socks5'
  host: string // host:port
}

// parseScutilProxy 从 `scutil --proxy` 输出解析系统代理，优先级 HTTPS → HTTP → SOCKS。
// 输出形如 "  HTTPSProxy : 127.0.0.1"（键值都以 " : " 分隔）。无启用代理返回 null。
export function parseScutilProxy(out: string): ProxyURL | null {
  const kv = new Map<string, string>()
  for (const line of out.split('\n')) {
    const i = line.indexOf(':')
    if (i < 0) continue
    kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
  }
  const enabled = (k: string): boolean => kv.get(k) === '1'
  const hostPort = (hostK: string, portK: string): string => {
    const h = kv.get(hostK) ?? ''
    const p = kv.get(portK) ?? ''
    if (h === '' || p === '') return ''
    // 对齐 net.JoinHostPort：IPv6 主机加方括号
    return h.includes(':') ? `[${h}]:${p}` : `${h}:${p}`
  }
  if (enabled('HTTPSEnable')) {
    const hp = hostPort('HTTPSProxy', 'HTTPSPort')
    if (hp !== '') return { scheme: 'http', host: hp }
  }
  if (enabled('HTTPEnable')) {
    const hp = hostPort('HTTPProxy', 'HTTPPort')
    if (hp !== '') return { scheme: 'http', host: hp }
  }
  if (enabled('SOCKSEnable')) {
    const hp = hostPort('SOCKSProxy', 'SOCKSPort')
    if (hp !== '') {
      // 与 Go 一致：仅当端口可解析为数字才采用（net.SplitHostPort + Atoi）
      const port = hp.slice(hp.lastIndexOf(':') + 1)
      if (/^\d+$/.test(port)) return { scheme: 'socks5', host: hp }
    }
  }
  return null
}

// parseWinProxySetting 解析 Windows 的 Internet Settings 代理配置。
//
// 两个值来自注册表 HKCU\...\Internet Settings：
//   ProxyEnable = 0x1（DWORD）
//   ProxyServer = "http=127.0.0.1:7897;https=127.0.0.1:7897" 或单值 "127.0.0.1:7897"
//
// ProxyServer 的两种形态都要认：分协议形态（键值对，用 `=` 分隔、`;` 连接）
// 和单值形态（整个串就是一个 host:port）。分协议时优先 https（下载目标恒为
// https://…），其次 http；socks 单独认出来，交给调用方决定是否回落并告警——
// 这是「用户在 Clash 里勾了 socks 混合端口、代码却静默直连」的那条差异。
export function parseWinProxySetting(enable: unknown, server: unknown): ProxyURL | null {
  const on = String(enable ?? '').trim()
  // REG_DWORD 经 reg query 出来是 0x1；测试里也会直接给 1。
  if (on !== '1' && on.toLowerCase() !== '0x1') return null
  const raw = String(server ?? '').trim()
  if (raw === '') return null
  // 分协议形态：出现 `xxx=` 才按键值对解析，否则整串当作 host:port。
  if (/[a-z]+\s*=/i.test(raw)) {
    const kv = new Map<string, string>()
    for (const part of raw.split(';')) {
      const i = part.indexOf('=')
      if (i < 0) continue
      kv.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim())
    }
    // 优先 https，其次 http（两者都是 undici ProxyAgent 支持的 http 隧道形态）
    for (const key of ['https', 'http']) {
      const hp = kv.get(key) ?? ''
      if (hp !== '') return { scheme: 'http', host: hp }
    }
    const socks = kv.get('socks') ?? ''
    if (socks !== '') return { scheme: 'socks5', host: socks }
    return null
  }
  return { scheme: 'http', host: raw }
}

// winSystemProxy 读 Windows 的系统代理（登录用户级 Internet Settings）。
//
// 为什么必须有这一段：darwin 一直能从 scutil 读到系统代理，Windows 却完全没读——
// 于是「同一个 Clash，Mac 上装得上、Windows 上永远装不上」。实测（2026-09-19）
// Windows 上系统代理开着（ProxyEnable=1，ProxyServer=http=127.0.0.1:7897;…），
// 而代码只看环境变量 HTTPS_PROXY，Node 进程里没有 → 判定「直连」→ github 超时/
// 被重置。用户看到的就是「Mac 能下，Windows 下不来」。
//
// 只读不写；reg.exe 不存在或键缺失一律当作「没配代理」返回 null。
export function readWinSystemProxy(): ProxyURL | null {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', timeout: 3000, windowsHide: true },
    )
    const get = (name: string): string => {
      for (const line of out.split('\n')) {
        const t = line.trim()
        if (!t.startsWith(name)) continue
        const cols = t.split(/\s{2,}/)
        if (cols.length >= 3) return cols[2]!.trim()
      }
      return ''
    }
    return parseWinProxySetting(get('ProxyEnable'), get('ProxyServer'))
  } catch {
    return null
  }
}

// envProxyURL 从环境变量取代理（对齐 Go http.ProxyFromEnvironment 的 HTTPS 语义，
// 下载目标固定是 https://api.github.com，故只看 HTTPS/ALL）。
function envProxyURL(): ProxyURL | null {
  const raw = process.env.HTTPS_PROXY ?? process.env.https_proxy
    ?? process.env.ALL_PROXY ?? process.env.all_proxy ?? ''
  if (raw === '') return null
  try {
    const u = new URL(raw)
    const scheme = u.protocol.replace(':', '')
    if (scheme !== 'http' && scheme !== 'socks5') return null
    return { scheme, host: u.host }
  } catch {
    return null
  }
}

// ghProxyURL 访问 GitHub（release 查询与引擎下载）用的代理解析：
// darwin 走 scutil、windows 走注册表（都是「系统代理」，进程里没有环境变量时
// 唯一能读到真相的地方），其余平台只看环境变量。
export function ghProxyURL(now?: () => ProxyURL | null): ProxyURL | null {
  const read = now ?? readSystemProxyOnce
  if (process.platform === 'darwin' || process.platform === 'win32') {
    const p = read()
    if (p !== null) return p
  }
  return envProxyURL()
}

let sysProxyCache: ProxyURL | null | undefined
function readSystemProxyOnce(): ProxyURL | null {
  if (sysProxyCache !== undefined) return sysProxyCache
  sysProxyCache = readSystemProxy()
  return sysProxyCache
}

function readSystemProxy(): ProxyURL | null {
  if (process.platform === 'darwin') return readScutil()
  if (process.platform === 'win32') return readWinSystemProxy()
  return null
}

function readScutil(): ProxyURL | null {
  if (process.platform !== 'darwin') return null
  try {
    const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 })
    return parseScutilProxy(out)
  } catch {
    return null
  }
}

// —— 下载用代理（复用项目 egress 配置，不写死地址）——
//
// 具体优先级见下方 resolveSidecarDownloadFetch（唯一的决议入口）：
// 显式 --proxy → 显式 egress id → Provider 的 egress 引用 → 仅一项时自动采用
// → HTTPS_PROXY 环境变量 → darwin scutil / windows 注册表读系统代理 → 直连。
//
// 只接受 http/https（与 router/upstream.egressProxyURI 同口径：undici
// ProxyAgent 不支持 socks5；Clash 类混合端口用其 http 端口）。
// 除「显式指定的 egress id」外，任一来源无效都静默往下走（不抛错）——
// 下载失败由 install/ensureReady 的重试兜底，不该因一行脏配置整个炸掉。
export function proxyURLToURI(p: ProxyURL): string | null {
  if (p.scheme !== 'http') return null
  if (p.host === '') return null
  try {
    const u = new URL(`http://${p.host}`)
    if (u.host === '') return null
    return `http://${u.host}`
  } catch {
    return null
  }
}

// normalizeProxyURI 收敛调用方传进来的代理地址（egress 解出的 URI / --proxy /
// 环境变量）：http/https 放行（认证信息原样保留，undici ProxyAgent 支持
// user:pass@host 形态；path/query 丢掉——代理地址不应带路径），其余
// （socks5/空串/非法 URL）返回 null 表示「不用代理，直连」。
export function normalizeProxyURI(raw: string): string | null {
  const s = (raw ?? '').trim()
  if (s === '') return null
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.host === '') return null
    const auth = u.username !== '' ? `${u.username}${u.password !== '' ? `:${u.password}` : ''}@` : ''
    return `${u.protocol}//${auth}${u.host}`
  } catch {
    return null
  }
}

// maskProxyURI 脱敏代理 URI（日志/接口回显用）：密码位打码，保留用户名与 host。
// 无密码时原样返回（host:port 本来就不是秘密，管理台 egress 列表明文可查）。
export function maskProxyURI(uri: string | null): string {
  if (!uri) return 'direct'
  try {
    const u = new URL(uri)
    if (u.password !== '') u.password = '***'
    const auth = u.username !== '' ? `${u.username}${u.password !== '' ? `:${u.password}` : ''}@` : ''
    return `${u.protocol}//${auth}${u.host}`
  } catch {
    return 'invalid'
  }
}

// proxiedFetch 按代理 URI 造 fetch：有代理 → 走 undici ProxyAgent 的 fetch
//（与转发面同源，避免 npm undici 与 Node 内置 undici 跨包传 dispatcher 报
// invalid onRequestStart）；无代理 → 全局 fetch（直连）。
//
// 连接池作用域（此前漏掉的缺陷）：旧实现在这里 new 一个 ProxyAgent 交给返回的
// fetch 反复用，**用完从不 close**。进程是长驻的（serve 常驻、CLI 一个进程跑完
// 整个 ensure），管理台每测一次代理、每走一次带 egress 的下载就漏一个连接池——
// fd 与 socket 缓慢累积，跑得越久漏得越多。现在改为**每次 HTTP 交换独立造一个
// agent，并在这次交换彻底完成后关掉**（见 proxiedExchange）。不能整个 fetch
// 共用一个池再挑时机关：返回的 fetch 会被调很多次（release 查询 6 次重试、下载
// 60 轮续传重试），共用一个池就永远说不清「哪一刻之后彻底没人用了」，又会退回
// 从不关的老路。
export function proxiedFetch(proxyURI: string | null): FetchLike {
  if (!proxyURI) return fetch
  return ((url: string | URL | Request, init?: RequestInit) =>
    proxiedExchange(proxyURI, url, init)) as unknown as FetchLike
}

// 模块级注册表：兜住「拿到 Response 后既不读也不 cancel、直接丢弃」的路径——
// 本仓库确有这种写法（sidecar 下载循环对非 200/206 直接 continue、latestRelease
// 对 4xx 直接 throw，都不碰 body）。这条路没有任何事件可挂，只剩 GC：token 与
// 响应一起变成垃圾时补一次关池。正常关闭会走 unregister，不会重复触发。
const abandonedAgentCloser = new FinalizationRegistry<ProxyAgent>((agent) => {
  void agent.close().catch(() => { /* 已关/正在关 */ })
})

// proxiedExchange 执行一次「代理出口 HTTP 交换」：建池 → 请求 → 等这次交换
// 彻底完成 → 关池。**所有路径都要关**，判据是「这次交换还有没有字节在途」：
//   1. fetch 抛错（连不上代理/上游、signal 中止）→ 响应都没成型，没有 body 要
//      管，当场关；
//   2. 响应没有 body（HEAD/204/304）→ 响应头拿到即交换完成，当场关；
//   3. 响应带**流式 body**（release JSON、66MB 引擎下载都在这条路上）→ 绝不能
//      在 body 还在传时关：close() 会把在途连接一起拆掉，下载会截断成半截文件、
//      撞上 sha256 不匹配。所以把 body 包一层透传流，「读完 / 被 cancel /
//      传输出错」任一出口到达（= 再没有字节在途）才关。
async function proxiedExchange(
  proxyURI: string,
  url: string | URL | Request,
  init?: RequestInit,
): Promise<UndiciResponse> {
  const agent = new ProxyAgent(proxyURI)
  // token 由下面的关闭逻辑与 body 包装流共同持有：只要还有人在读这份响应就活着，
  // 响应被整体丢弃（既不读也不 cancel）时才随垃圾一起消失，触发注册表兜底。
  const token = {}
  abandonedAgentCloser.register(token, agent)
  let closed = false
  // 关池只发生一次，且**绝不冒泡**：走到这里时该交换已经结束（或已经出错），
  // 关不掉只是连接池的卫生问题，不该把它变成一次「下载失败」。与本文件其余兜底
  //（读系统代理失败 → 直连）同风格：吞掉，不打扰主流程。
  const closeAgent = async (): Promise<void> => {
    if (closed) return
    closed = true
    abandonedAgentCloser.unregister(token)
    try { await agent.close() } catch { /* 已关/正在关 */ }
  }
  let res: UndiciResponse
  try {
    res = await undiciFetch(url as never, { ...(init as object), dispatcher: agent } as never)
  } catch (e) {
    await closeAgent() // 路径 1：错误路径上也要关
    throw e
  }
  const body = res.body
  if (body === null) {
    await closeAgent() // 路径 2：无 body，响应头拿到即交换完成
    return res
  }
  // 路径 3：流式 body。包一层透传流，把「读完 / 取消 / 出错」翻译成关池时机；
  // 关池用 void 而不 await——流回调里的 close 不该拖慢调用方的下一次 read()。
  const reader = body.getReader()
  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          void closeAgent() // 最后一个字节已交给调用方 → 这次交换彻底完成
        } else {
          controller.enqueue(value)
        }
      } catch (e) {
        void closeAgent() // 传输出错 / 被 signal 中止：交换以异常告终，同样要关
        controller.error(e)
      }
    },
    async cancel(reason) {
      // 调用方放弃（res.body.cancel() / 读到一半取消）：关池与拆底层流两件都要做，
      // 只 cancel 不关就又漏回去了。
      void closeAgent()
      try { await reader.cancel(reason) } catch { /* 底层流可能已关闭 */ }
    },
  })
  // 必须重新包一层 Response：undici 的 text()/arrayBuffer() 读的是**内部** body 流
  //（consumeBody → getInternalState(this).body），只改公开的 res.body 属性骗不过它，
  // 得让包装流成为这份 Response 的本体。代价是 url/redirected 不跟着带过来（构造
  // 出来的 Response 没有这两个字段），本文件调用方（sidecar 的 install/ensure 只看
  // status/headers/body）不用它们。TS 侧 undici 的 BodyInit 没收 ReadableStream
  //（DOM-free 类型的省略），运行时 extractBody 明确支持，故按 as never 过类型。
  return new UndiciResponse(wrapped as never, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

// egressDefToProxyURI 把项目 egress 表的一行（{kind, addr}）转成代理 URI。
// 与 router/upstream.egressProxyURI 同口径（仅 http/https；socks5 返回 null
// 交给调用方回落系统代理/直连，不抛错——下载失败由重试兜底，不应因一行
// 坏配置直接炸掉整个 ensure）。
export function egressDefToProxyURI(e: { id?: string; kind: string; addr: string } | undefined): string | null {
  if (!e) return null
  const kind = (e.kind ?? '').trim().toLowerCase()
  const addr = (e.addr ?? '').trim()
  if (addr === '') return null
  if (kind !== 'http' && kind !== 'https') return null
  return normalizeProxyURI(`${kind}://${addr}`)
}

// —— sidecar 下载代理决议（复用项目 egress 配置，不写死地址）——
//
// 优先级（首个命中即用）：
//   1. explicitProxy（CLI --proxy 显式值，完整 URI）
//   2. egressId（CLI --egress / 管理面 ?egress= 的 id 引用，不存在/不支持直接抛错，
//      让调用方转 400/fatal 点名，而不是静默回落到别的代理）
//   3. providerEgressId（zcode-plan-local Provider 自身的 egress 引用；
//      缺失/无效则跳过继续往下，不抛错——下载不该因 Provider 静态配置的一行
//      脏引用整个炸掉，重试兜底还在）
//   4. egressList 仅一项时自动采用（多用户单 clash 最常见；多项时不猜，
//      交给 env/系统代理，避免把下载送错出口）
//   5. HTTPS_PROXY / ALL_PROXY 环境变量（只认 http/https，与 envProxyURL 同口径）
//   6. 系统代理（darwin scutil / windows 注册表；wantSystem=false 时跳过，纯测试/离线用）
//   7. 直连（返回 proxyURI=null，保持旧行为）
//
// 只接受 http/https（undici ProxyAgent 不支持 socks5；Clash 混合端口用 http）。
export interface SidecarDownloadResolveOpts {
  explicitProxy?: string
  egressId?: string
  providerEgressId?: string
  egressList?: { id: string; kind: string; addr: string }[]
  wantSystem?: boolean // 缺省 true（serve 与 CLI 都自动吃系统代理）
  systemProxy?: () => ProxyURL | null
  env?: Record<string, string | undefined>
}

export interface SidecarDownloadResolution {
  proxyURI: string | null
  // 来源标签（日志/接口回显用，不含敏感信息）：--proxy / egress:<id> /
// provider-egress:<id> / egress-auto:<id> / env:HTTPS_PROXY / system / direct
  source: string
  fetch: FetchLike
}

export function resolveSidecarDownloadFetch(opts: SidecarDownloadResolveOpts = {}): SidecarDownloadResolution {
  const wantSystem = opts.wantSystem !== false
  // 1. CLI --proxy 显式值
  const fromExplicit = normalizeProxyURI(opts.explicitProxy ?? '')
  if (fromExplicit) {
    return { proxyURI: fromExplicit, source: '--proxy', fetch: proxiedFetch(fromExplicit) }
  }
  const list = opts.egressList ?? []
  const byId = new Map(list.map((e) => [e.id, e]))
  // 2. 显式 id 引用（--egress / ?egress=）：必须命中，否则点名抛错
  const wantId = (opts.egressId ?? '').trim()
  if (wantId !== '') {
    const def = byId.get(wantId)
    if (!def) {
      throw new Error(`egress "${wantId}" 不存在（顶层 egresses 未定义，可在管理台 Providers 页配置出口代理）`)
    }
    const uri = egressDefToProxyURI(def)
    if (!uri) {
      throw new Error(`egress "${wantId}" 暂不支持（kind="${def.kind}"，v1 仅 http/https；socks5 服务请用其混合 http 端口）`)
    }
    return { proxyURI: uri, source: `egress:${wantId}`, fetch: proxiedFetch(uri) }
  }
  // 3. Provider 自身的 egress 引用（lenient：无效跳过）
  const providerEgress = (opts.providerEgressId ?? '').trim()
  if (providerEgress !== '') {
    const def = byId.get(providerEgress)
    const uri = def ? egressDefToProxyURI(def) : null
    if (uri) {
      return { proxyURI: uri, source: `provider-egress:${providerEgress}`, fetch: proxiedFetch(uri) }
    }
  }
  // 4. 表里仅一项时自动采用（单 clash 最常见；多项不猜）
  if (list.length === 1) {
    const only = list[0]!
    const uri = egressDefToProxyURI(only)
    if (uri) {
      return { proxyURI: uri, source: `egress-auto:${only.id}`, fetch: proxiedFetch(uri) }
    }
  }
  // 5. 环境变量（HTTPS 语义：只看 HTTPS/ALL，与 envProxyURL 同口径）
  const env = opts.env ?? process.env
  const envRaw = env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy ?? ''
  const fromEnv = normalizeProxyURI(envRaw)
  if (fromEnv) {
    const key = env.HTTPS_PROXY !== undefined ? 'HTTPS_PROXY'
      : env.https_proxy !== undefined ? 'https_proxy'
      : env.ALL_PROXY !== undefined ? 'ALL_PROXY' : 'all_proxy'
    return { proxyURI: fromEnv, source: `env:${key}`, fetch: proxiedFetch(fromEnv) }
  }
  // 6. 系统代理（darwin scutil / windows 注册表；socks5 直接放弃，回落直连）
  if (wantSystem) {
    try {
      const sys = (opts.systemProxy ?? ghProxyURL)()
      if (sys && sys.scheme === 'http') {
        const uri = proxyURLToURI(sys)
        if (uri) return { proxyURI: uri, source: 'system', fetch: proxiedFetch(uri) }
      } else if (sys && sys.scheme === 'socks5') {
        // 不能静默。用户配了 socks5 却拿不到代理，唯一的体外症状是「一直转圈」，
        // 而代码里没有任何痕迹——这正是「有人装得上、有人永远装不上」最难查的
        // 一类差异。明确说清楚落了直连，并把补救办法写出来。
        console.warn(
          `sidecar: 检测到 socks5 代理（${sys.host}），undici ProxyAgent 不支持 socks5，` +
          `本次下载**回落直连**。若下载超时，请改用该代理的 http/https 端口 ` +
          `（如 Clash 的混合端口），或设 HTTPS_PROXY=http://<host:port>。`)
      }
    } catch { /* 读系统代理失败 → 直连 */ }
  }
  // 7. 直连
  return { proxyURI: null, source: 'direct', fetch }
}
