// ZCode plan 通道 sidecar（TriDefender/zcode-proxy）的即插即用管理。
//
// 合规边界（NOTICE.md 已登记）：该工具无 LICENSE（默认保留所有权利），polycode-hub
// 不分发、不捆绑、不复制其代码——本包只做「下载官方 release → 生成安全配置 →
// 进程管理」的胶水。移植自 Go internal/sidecar/sidecar.go（不含无调用者的
// stdinLine / PingSidecar，grep 确认无生产使用点）。

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const releaseAPI = 'https://api.github.com/repos/TriDefender/zcode-api/releases/latest'

// 下载来源白名单。装下来的二进制会被 chmod 0700 并 spawn 执行——
// 等于以网关自身权限运行任意代码，所以「从哪下」必须收死：
//   · 强制 https（防明文 MITM 替换）
//   · host 只认 GitHub 自己的域名（api.github.com 返回的 browser_download_url
//     实际指向 objects.githubusercontent.com 或 github.com 的 release 路径）
// 上游若被投毒/账号被盗，白名单挡不住，但能挡住「把 url 指向别处」这一类。
const DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
  'api.github.com',
])

// 校验下载地址：非 https、非法 URL、或 host 不在白名单一律拒绝。
// 返回空串表示通过，否则返回拒绝原因。
export function checkDownloadURL(raw: string): string {
  if (raw === '') return '下载地址为空'
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return `下载地址不是合法 URL: ${raw}`
  }
  if (u.protocol !== 'https:') {
    return `下载地址必须用 https（拒绝 ${u.protocol}//）: ${raw}`
  }
  if (!DOWNLOAD_HOSTS.has(u.hostname)) {
    return `下载地址 host 不在白名单（${u.hostname}）: ${raw}`
  }
  return ''
}

// 计算 buffer 的 sha256（十六进制小写）。
export function sha256Hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

export interface ReleaseAsset {
  name: string
  url: string // browser_download_url
  size: number
  // digest 是 GitHub 在 release asset 上提供的校验和，形如 "sha256:abc…"。
  // 2025 年起的 API 才带，老 release 可能为空串——为空即表示上游没给，
  // 此时 install 只能退回「白名单 + 告警放行」。
  digest: string
}

export interface ReleaseInfo {
  tagName: string
  assets: ReleaseAsset[]
}

export type FetchLike = typeof fetch

// SidecarPhase 是 ensureReady 全流程的阶段名。管理台把它直接渲染成
// 「查询版本 → 下载 → 校验并落盘 → 生成配置 → 启动引擎」这排步骤，
// 否则 66MB 的下载 + 最长 45 秒的启动等待全挤在一个「安装中」里，用户
// 无法判断到底卡在哪一步（真实缺陷：页面只能一直转）。
export type SidecarPhase = 'resolving' | 'downloading' | 'verifying' | 'configuring' | 'starting'

// SidecarCancelledError 表示用户主动取消（不是失败）。调用方据此把作业标记为
// 「已取消」而不是「出错」——否则一次正常的取消会在页面上留一条红色报错，
// 用户以为坏了。
export class SidecarCancelledError extends Error {
  constructor(msg = '已取消') {
    super(msg)
    this.name = 'SidecarCancelledError'
  }
}

// throwIfCancelled 是可中断点上的统一检查。半成品 .part **刻意保留**：
// 下次安装能接着传，用户取消不等于把已下的几十 MB 也一起扔掉。
function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new SidecarCancelledError()
}

export interface SidecarProgress {
  phase: SidecarPhase
  // received/total 只在 downloading 阶段有意义（已收字节 / Content-Length，
  // 上游未给 Content-Length 时 total 为 0，调用方据此降级成不确定进度条）。
  received: number
  total: number
}

export type ProgressFn = (p: SidecarProgress) => void

export interface InstallOptions {
  fetch?: FetchLike
  // goos 用 Go 口径（darwin/linux/windows）；缺省取 process.platform 并经
  // normalizeGOOS 归一（Windows 上是 win32 → windows）。传 "win32" 也可以，
  // 归一这一步是幂等的。
  goos?: string
  arch?: string // 默认 process.arch
  // expectedSha256 期望的二进制摘要（十六进制，大小写不敏感）。
  // 给了就强制比对，不一致直接拒绝安装（不落地、不执行）；没给则自动采用
  // release API 的 asset.digest（2025 年起 GitHub 已提供，见 install 内注释）。
  expectedSha256?: string
  // allowUntrusted 显式豁免「未提供摘要」这一条（白名单与 https 仍然强制）。
  // 默认 false：宁可让用户显式确认，也不静默接受一个未经校验的可执行文件。
  allowUntrusted?: boolean
  // onProgress 阶段与字节进度回调（可选）。只读用途，抛出会被忽略。
  onProgress?: ProgressFn
  // sleep 是重试之间的等待（测试注入成即时返回，避免真等几十秒）。
  // 缺省 500ms×次数 的退避，上限 5s。
  sleep?: (ms: number) => Promise<void>
  // proxySource 本次下载所用出口的描述（如 'egress-auto:clash'），仅用于日志。
  // opts.fetch 是**已经包好代理**的 fetch；代理连续零推进时改用全局 fetch
  // （直连）重试——见 install 内的零推进回退。
  proxySource?: string
  // signal 用于取消：用户点「取消」时置为 aborted，下载循环在**每个可中断点**
  // 检查并立刻抛出 SidecarCancelledError。
  //
  // 真实缺陷（用户报告「现在下载中是无法暂停和取消的，那不是一坨屎」）：以前
  // 一旦开始下载就只有等它跑完 60 轮重试或杀掉整个进程，中间没有任何出口。
  signal?: AbortSignal
}

export interface EnsureReadyOptions {
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  // onProgress 透传给 install，并补上 configuring / starting 两个阶段。
  onProgress?: ProgressFn
  // proxySource 透传给 install：本次出口的描述（'direct' 表示没走代理）。
  // 下载连续零推进时据此决定「换直连」还是「已无路可换」，见 install。
  proxySource?: string
  // signal 取消：透传给 install，并在 configuring/starting 这些阶段边界上检查，
  // 让「取消」在下载之外的阶段也能立刻生效。
  signal?: AbortSignal
}

export interface UninstallResult {
  binary?: string
  credKey?: string
  workDirData?: string[]
}

export interface SidecarOptions {
  binDir?: string // 默认 ~/.polycode-hub/bin
  dataDir?: string // 默认 ~/.zcode-proxy
  port?: string // 默认 8080
  workDir?: string // sidecar 工作目录（含其 config.yaml）
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })

// wrapProgress 把可选回调包成「绝不抛出」的形式：进度上报是旁路，
// 不能因为它自己出错就打断一次真实的安装。
function wrapProgress(fn?: ProgressFn): ProgressFn {
  if (fn === undefined) return () => {}
  return (p) => { try { fn(p) } catch { /* 旁路失败不影响安装 */ } }
}

// contentLength 读 Content-Length（缺失/非法/非正值一律回 0）。
function contentLength(res: Response): number {
  const raw = res.headers?.get?.('content-length') ?? ''
  const n = Number.parseInt(raw, 10)
  return Number.isInteger(n) && n > 0 ? n : 0
}

// readBodyWithProgress 读完响应体并上报字节进度。
//
// 以前这里是一句 `Buffer.from(await res.arrayBuffer())`：66MB 一次性吞完，
// 中间没有任何可观测点，管理台的「安装中…」只能一直转。改成流式累加后可
// 以边收边报，语义完全等价（同样是完整 buffer，同样交给后面的 sha256 校验）；
// 响应体不可流式读取时（测试替身/老实现）回退到原来的 arrayBuffer 路径。
//
// base / onChunk 是为断点续传加的：base 是本次请求之前已经落盘的字节数
// （进度上报要把它算进去，否则续传一次进度条就从 0 重新爬），onChunk 让调用方
// 能把每一段新数据**立刻追加进半成品文件**，中断时已收到的部分才不会白丢。
async function readBodyWithProgress(
  res: Response,
  fallbackTotal: number,
  notify: ProgressFn,
  base = 0,
  onChunk?: (chunk: Buffer) => void,
  signal?: AbortSignal,
): Promise<Buffer> {
  const body = res.body
  if (body === null || body === undefined || typeof body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer())
    onChunk?.(buf)
    // 这条路径拿不到 Content-Range（老实现/测试替身），总数就用「已收 + 本段」，
    // 与流式路径的口径一致：进度上报永远是「本次之前 + 本次收到」。
    notify({ phase: 'downloading', received: base + buf.length, total: base + buf.length })
    return buf
  }
  // 总数按可信度取：Content-Range 的总长最准 → 本次 Content-Length 加上已收的
  // base（续传时它只是剩余长度）→ release API 报的 size 兜底（代理丢头时唯一来源）。
  const len = contentLength(res)
  const total = contentRangeTotal(res) || (len > 0 ? len + base : 0) || fallbackTotal
  const reader = body.getReader()
  // 取消必须能打断**正在传输的流**。这里的坑很具体：`reader.cancel()` 只是停止
  // 「消费」，不会拆掉底层 socket——实测从 3MB 处取消，仍要等 60 秒把剩余 84MB
  // 灌完才会返回。真正能立刻停下来的是把 signal 交给 fetch（undici 会拆除连接），
  // 见 install 里的 `{ headers, signal }`。这里仍保留监听，用于兜住
  // 「fetch 未被传入 signal」的调用路径（如测试替身）。
  const onAbort = (): void => {
    // reader.cancel() 返回 promise，必须接住它的拒绝：abort 期间这个 promise 会以
    // AbortError 拒绝，不接就是进程级 unhandledRejection（实测直接崩掉 node）。
    try { reader.cancel().catch(() => {}) } catch { /* 流可能已关闭 */ }
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  const chunks: Buffer[] = []
  let received = 0
  let lastAt = 0
  notify({ phase: 'downloading', received: base, total })
  try {
    for (;;) {
      if (signal?.aborted === true) throw new SidecarCancelledError()
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      const chunk = Buffer.from(value)
      chunks.push(chunk)
      onChunk?.(chunk)
      received += chunk.length
      // 节流到 200ms：66MB 会切成上千个 chunk，逐块回调会把管理台刷爆
      // （前端本来也只按 1s 轮询，中间态没有意义）。
      const now = Date.now()
      if (now - lastAt >= 200) {
        lastAt = now
        notify({ phase: 'downloading', received: base + received, total })
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  notify({ phase: 'downloading', received: base + received, total })
  return Buffer.concat(chunks)
}

// contentRangeTotal 解析 206 响应的 `Content-Range: bytes 0-99/91351040`，取总数。
// 续传时 Content-Length 只剩剩余长度，拿它当总数会画出「快满了其实才一半」的假进度。
export function contentRangeTotal(res: Response): number {
  const raw = res.headers?.get?.('content-range') ?? ''
  const m = /\/(\d+)\s*$/.exec(raw)
  const n = m ? Number.parseInt(m[1] ?? '', 10) : 0
  return Number.isInteger(n) && n > 0 ? n : 0
}

// partPath 是「半成品」文件的路径：下载中途的数据先落这里，下完再 rename 成正式
// 二进制。放在磁盘而不是内存，是为了让断电/关页面/进程被杀之后还能接着下——
// 87MB 的 Windows 产物在当前网络下实测约 20 秒就被 ECONNRESET 掐断一次，
// 只重试不续传的话每次都要从 0 再来，永远下不完（真实缺陷：Windows 装不上）。
export function partPath(dest: string): string {
  return dest + '.part'
}

// sleepMsg 是下载重试之间的等待：既要做节流（连打 60 次请求会被上游限流），
// 也要把「正在重试、已保住多少」播报出去。没有这句播报，续传在界面上表现为
// 进度条原地不动，用户依然只能看到一个像是卡死的页面。
async function sleepMsg(
  opts: InstallOptions,
  attempt: number,
  have: number,
  notify: ProgressFn,
  total: number,
): Promise<void> {
  const wait = Math.min(500 * attempt, 5000) // 退避，但别让用户干等太久
  notify({ phase: 'downloading', received: have, total })
  await (opts.sleep ?? sleep)(wait)
}

// assetName 返回当前平台的 release 资产名（与上游命名约定对齐）。
//
// 注意 goos 用的是 **Go 的口径**（darwin/linux/windows），不是 Node 的
// process.platform（后者 Windows 上是 "win32"）。两者必须经 normalizeGOOS
// 转换后再进来——历史缺陷：install() 直接把 process.platform 传进来，
// Windows 上得 "win32"，落到 default 返回空串，于是抛「平台 win32/x64
// 无预编译产物」——Windows 从来就装不上，且与网络/代理无关。
export function assetName(goos: string, arch: string): string {
  switch (goos) {
    case 'darwin': return 'zcode-proxy-darwin-' + arch
    case 'linux': return 'zcode-proxy-linux-' + arch
    // Windows 只有单一构建（release 里就一个 zcode-proxy.exe，不带架构后缀），
    // 故不拼 arch；arm64 Windows 也能跑该 x64 产物（系统自带仿真）。
    case 'windows': return 'zcode-proxy.exe'
    default: return ''
  }
}

// normalizeGOOS 把 Node 的 process.platform 归一到 Go 的 GOOS 口径。
// win32 → windows（其余同名）；无法识别的原样返回，由 assetName 的 default
// 分支给出「无预编译产物」的明确报错（不在这里提前抛，保持单一判定点）。
export function normalizeGOOS(platform: string): string {
  return platform === 'win32' ? 'windows' : platform
}

// localName 返回二进制**落到本地磁盘后**应叫的文件名。
//
// 与 assetName 的区别是这一层才负责「扩展名」：release 资产名在 POSIX 上
// 本来就等于本地名（zcode-proxy-darwin-arm64），但 Windows 上是 zcode-proxy.exe。
// 历史缺陷：装上一步只归一了 goos，dest/findBinary/uninstall 仍硬编码
// 'zcode-proxy'，于是 Windows 上落地的是一个**没有 .exe 后缀**的 87MB 文件——
// spawn 与 taskkill /IM 都不认它，表现为「装得上但起不来、也杀不掉」。
//
// goos 用 Go 口径（与 assetName 同源），传入前先过 normalizeGOOS。
export function localName(goos: string): string {
  return goos === 'windows' ? 'zcode-proxy.exe' : 'zcode-proxy'
}

// randomKey 生成 24 字节 hex 随机 proxyApiKey。
function randomKey(): string {
  return 'sk-local-' + randomBytes(24).toString('hex')
}

// portLineRe 匹配 config.yaml 的 port 行（对齐 Go regexp `(?m)^(\s*port:\s*)(\d+)(\s*)$`）。
const portLineRe = /^([ \t]*port:[ \t]*)(\d+)([ \t]*)$/gm

// validatePort 校验端口文本（1024-65535）。
export function validatePort(port: string): void {
  const n = Number(port)
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error(`端口须为 1024-65535 的数字，got ${JSON.stringify(port)}`)
  }
}

// killSidecarSpec 返回按进程名匹配杀掉 sidecar 的命令（仅本用户进程）。
// darwin/linux 用 pgrep；windows 用 taskkill（对齐 Go build tag 分支）。
export function killSidecarSpec(platform: string): { cmd: string; args: string[] } {
  if (platform === 'win32') {
    return { cmd: 'taskkill', args: ['/F', '/IM', 'zcode-proxy.exe'] }
  }
  return { cmd: 'pgrep', args: ['-f', 'zcode-proxy.*--cli serve'] }
}

// FETCH_ERR_HINTS 把传输层错误码翻译成一句能照着做的分诊建议。
// 这些码来自实测（2026-09-19，经 Clash 与死端口各跑一遍得到的 cause 形态）。
const FETCH_ERR_HINTS: Record<string, string> = {
  ECONNRESET: '代理能连上但连接被重置——多半是代理自身或其上游节点已失效（订阅过期/节点挂掉），请换节点后重试',
  ECONNREFUSED: '代理端口没人监听——确认代理进程在跑，且出口配置里的 host:port 写对了',
  ENOTFOUND: '域名解析失败——检查 DNS，或代理的分流规则是否把该域名丢给了不存在的出口',
  EAI_AGAIN: 'DNS 临时解析失败——稍后重试，或检查网络/DNS 服务',
  ETIMEDOUT: '连接超时——网络或代理不可达',
  EPROTO: 'TLS 握手失败——代理可能在做明文拦截，或该出口不支持 CONNECT 隧道',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书校验失败——链路里可能有中间人代理（自签证书）',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 证书是自签的——链路里可能有中间人代理',
}

// describeFetchError 把 undici 那句无信息的 `fetch failed` 还原成可诊断的一句话。
//
// Node/undici 的 fetch 在传输层失败时只抛 `TypeError: fetch failed`，真正的原因
// 藏在 error.cause 里。实测形态（四种故障在界面上长得一模一样，用户无从下手）：
//   · 节点失效   depth0=TypeError/fetch failed, depth1.code=ECONNRESET
//   · 代理没起   depth0=TypeError/fetch failed, depth1.code=ECONNREFUSED
//   · DNS 失败   depth0=TypeError/fetch failed, depth1.code=ENOTFOUND
//   · 超时       depth0=TimeoutError（**没有 cause**，得靠 name 判）
// 所以这里同时看 cause 链与 error.name，再按 code 附一句分诊建议。
// 沿链最多走 4 层，防自引用导致的死循环。
export function describeFetchError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const name = e instanceof Error ? e.name : ''
  let cur: unknown = (e as { cause?: unknown } | null)?.cause
  let code = ''
  let detail = ''
  for (let i = 0; i < 4 && cur !== undefined && cur !== null; i++) {
    const c = cur as { code?: unknown; message?: unknown; cause?: unknown }
    if (code === '' && typeof c.code === 'string' && c.code !== '') code = c.code
    if (detail === '' && typeof c.message === 'string' && c.message !== '') detail = c.message
    cur = c.cause
  }
  // 超时没有 cause.code，只能认 name
  const hint = FETCH_ERR_HINTS[code] ?? (name === 'TimeoutError' ? '连接超时——网络或代理不可达' : '')
  const bits = [msg]
  if (code !== '') bits.push(code)
  if (detail !== '' && detail !== msg) bits.push(detail)
  const head = bits.join(' —— ')
  return hint === '' ? head : `${head}。${hint}`
}

// latest 查询上游最新 release 信息。
// latestRelease 查最新 release。proxySource 非 'direct' 时，一旦代理把请求打回
// （ECONNRESET 等），自动用直连再试一次。
//
// 真实缺陷（用户报告「为什么卡在这里半分多钟」，后台实为 resolving 阶段失败）：
// 配的代理活着但连不上游，连接被立刻重置，而这里是**单次尝试、失败即终止**——
// 一条本可绕过的代理故障，直接把整个安装判了死刑。实测同一时刻直连是通的。
export async function latestRelease(
  fetchImpl: FetchLike = fetch,
  proxySource = '',
  signal?: AbortSignal,
): Promise<ReleaseInfo> {
  const viaProxy = proxySource !== '' && proxySource !== 'direct'
  const init = { headers: { Accept: 'application/vnd.github+json' }, ...(signal !== undefined ? { signal } : {}) }
  // 先重试代理本身几次，再考虑换直连。
  //
  // 更正（我先前写错了，实测打脸）：这里原来只试一次代理就跳直连，注释还写着
  // 「立刻重试只会拿到同样的结果」——**这是错的**。实测代理冷启动要失败 1~4 次
  // （每次仅 ~140ms），重试第 5 次就稳定成功，而且代理比直连快 53 倍
  // （2.67 MB/s vs 0.05 MB/s）。试一次就放弃等于把最快的那条路丢掉。
  const PROXY_TRIES = viaProxy ? 6 : 1
  let lastProxyErr: unknown
  let res: Response | null = null
  for (let i = 0; i < PROXY_TRIES && res === null; i++) {
    try {
      res = await fetchImpl(releaseAPI, init)
    } catch (e) {
      lastProxyErr = e
      if (signal?.aborted === true) throw new SidecarCancelledError()
    }
  }
  if (res === null) {
    if (viaProxy) {
      try {
        res = await fetch(releaseAPI, init)
        console.warn(`sidecar: 出口 ${proxySource} 重试 ${PROXY_TRIES} 次仍不可用（${describeFetchError(lastProxyErr)}），已改用直连查询 release。`)
      } catch (e2) {
        throw new Error(`sidecar: 查询 release 失败 —— 代理与直连均不通（代理：${describeFetchError(lastProxyErr)}；直连：${describeFetchError(e2)}）`)
      }
    } else {
      // 不包这一层的话，代理层故障会原样冒泡成「就绪失败: fetch failed」——
      // 用户只知道失败了，不知道是节点挂了还是端口写错了。
      throw new Error(`sidecar: 查询 release 失败 —— ${describeFetchError(lastProxyErr)}`)
    }
  }
  if (res.status !== 200) {
    throw new Error(`sidecar: 查询 release 失败: http ${res.status}`)
  }
  const raw = JSON.parse(await res.text()) as {
    tag_name?: string
    assets?: { name?: string; browser_download_url?: string; size?: number; digest?: string }[]
  }
  return {
    tagName: raw.tag_name ?? '',
    assets: (raw.assets ?? []).map((a) => ({
      name: a.name ?? '',
      url: a.browser_download_url ?? '',
      size: a.size ?? 0,
      digest: a.digest ?? '',
    })),
  }
}

// logTailHint 与 startupFailureHint 同源，但只看**本次启动新增**的日志
// （from 之后的部分）。早退场景下必须这么切：日志是追加写的，历史失败会一直
// 留在文件里，读全量很容易拿上一次的 Not logged in 去解释这一次的端口冲突。
export function logTailHint(sidecarDir: string, logPath?: string, from?: number): string {
  const p = logPath ?? join(sidecarDir, 'logs', 'sidecar.log')
  let fresh = ''
  try {
    const all = readFileSync(p, 'utf8')
    fresh = (from !== undefined && from > 0 && from <= all.length) ? all.slice(from) : all
  } catch {
    return ''
  }
  return hintOfText(fresh)
}

// 引擎支持的登录 provider，取自它自己的 usage：
//   Usage: zcode-proxy auth login <zai|bigmodel> [--import] [--paste]
//
// 真实缺陷（用户问「现在的登入是不是只支持 z.ai」）：网页登录此前把 'zai'
// 硬编码在两处 spawn 里，而 bigmodel 同样受引擎支持、授权页是 bigmodel.cn。
// 用 bigmodel 账号的用户在页面上根本登录不了——自动导入那条路却又是遍历两个
// provider 的，两边口径不一致。
export const AUTH_PROVIDERS = ['zai', 'bigmodel'] as const
export type AuthProvider = (typeof AUTH_PROVIDERS)[number]

// authURLRe 从引擎 stdout 里抓授权链接。
//
// 两种 provider 的 URL 形态**完全不同**，不能只认 oauth/authorize：
//   zai:      https://chat.z.ai/api/oauth/authorize?client_id=…
//   bigmodel: https://bigmodel.cn/login?appId=zcode&redirect=…&state=…
// 只匹配 oauth/authorize 的话，bigmodel 那条永远抓不到，表现为「点了登录没反应」。
export const authURLRe =
  /https:\/\/[^\s"'<>]*(?:oauth\/authorize|bigmodel\.cn\/login)[^\s"'<>]*/

// runQuiet 跑一条命令并只回退出码（吞掉输出，用于「试一试能不能行」这类调用）。
// 超时兜底：导入是本机读文件，正常是毫秒级；卡住说明引擎状态异常，不能拖住启动。
function runQuiet(bin: string, args: string[], cwd: string): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: 'ignore', ...(process.platform === 'win32' ? { windowsHide: true } : {}) })
    const t = setTimeout(() => { try { child.kill() } catch { /* 已经退了 */ } resolve(1) }, 10_000)
    child.on('error', () => { clearTimeout(t); resolve(1) })
    child.on('close', (code) => { clearTimeout(t); resolve(code ?? 1) })
  })
}

// startupFailureHint 读引擎日志尾部，把已知的启动失败原因翻译成一句能照做的
// 中文建议。返回空串表示日志里没有可识别的线索（调用方退回「启动超时」）。
//
// 为什么值得单独做：引擎自己的报错是英文且面向终端（`Not logged in. Run:
// zcode-proxy auth login zai`），而用户是在网页上点「一键启动」的——他既不知道
// 要去哪看日志，也未必认得出这条信息就是根因。实测最常撞上的就是「没登录」。
export function startupFailureHint(sidecarDir: string): string {
  let tail = ''
  try {
    const all = readFileSync(join(sidecarDir, 'logs', 'sidecar.log'), 'utf8')
    // 只看尾部：日志是追加写的，历史失败会一直留在前面，读全量容易被旧错误误导。
    tail = all.slice(-4096)
  } catch {
    return ''
  }
  return hintOfText(tail)
}

// hintOfText 是「日志文本 → 可照做的中文建议」的唯一判定点（两个入口共用）。
function hintOfText(tail: string): string {
  if (tail === '') return ''
  // 未登录：引擎启动即退出，日志里是唯一线索。必须把「怎么做」写清楚——
  // 这条是 Windows 上「老是启动失败」的头号原因。
  if (/not logged in/i.test(tail)) {
    return '引擎未登录（日志：Not logged in）。先完成一次授权登录再启动：'
      + '在终端跑 `polycode-hub zcode sidecar login`（会拉起浏览器 OAuth）。'
  }
  if (/address already in use|bind: address already/i.test(tail)) {
    return '端口已被占用。改一个端口，或先停掉占用它的程序。'
  }
  if (/permission denied|access is denied/i.test(tail)) {
    return '二进制没有执行权限（或被安全软件拦截）。'
  }
  // 兜底：把最后一行原始日志带出来，总比只说「超时」有用。
  const lastLine = tail.trimEnd().split('\n').pop() ?? ''
  return lastLine.trim() === '' ? '' : `引擎日志最后一行：${lastLine.trim()}`
}

// Sidecar 是 zcode-proxy 本地实例的管理句柄。
export class Sidecar {
  binDir: string // 二进制安装目录（~/.polycode-hub/bin）
  dataDir: string // sidecar 凭据/配置目录（~/.zcode-proxy）
  credKey: string // 网关侧凭据引用文件路径（config/credentials/zcode-proxy-key）
  port: string
  // binName 是本地二进制文件名（Windows 带 .exe，其余不带）。
  // install / findBinary / uninstall 三处必须共用同一个口径——历史上各自
  // 硬编码 'zcode-proxy'，Windows 上装出来的是无后缀文件，spawn 起不来。
  binName: string
  // workDir 是 sidecar 工作目录（含其 config.yaml 与可选的本地二进制）。
  // findBinary 查找顺序：workDir/<binName> → sidecarDir/<binName> → binDir/<binName>。
  workDir: string

  constructor(credKey: string, opts: SidecarOptions = {}) {
    const home = homedir()
    this.binDir = opts.binDir ?? join(home, '.polycode-hub', 'bin')
    this.dataDir = opts.dataDir ?? join(home, '.zcode-proxy')
    this.credKey = credKey
    this.port = opts.port ?? '8080'
    this.binName = localName(normalizeGOOS(process.platform))
    this.workDir = opts.workDir ?? ''
  }

  // —— 下载安装 ——

  // install 下载官方 release 二进制到 binDir（0700）。已存在时跳过（force 强制重装）。
  async install(force = false, opts: InstallOptions = {}): Promise<string> {
    // process.platform 是 Node 口径（Windows = "win32"），assetName 要的是 Go 口径
    // （"windows"）——必须归一，否则 Windows 恒抛「无预编译产物」。
    const goos = normalizeGOOS(opts.goos ?? process.platform)
    const arch = opts.arch ?? process.arch
    const name = assetName(goos, arch)
    if (name === '') {
      throw new Error(`sidecar: 平台 ${goos}/${arch} 无预编译产物（可从源码构建）`)
    }
    // dest 用本地口径（Windows 带 .exe）：资产名与本地名在 POSIX 上一致，
    // 在 Windows 上都指向 zcode-proxy.exe，但绝不能再写死 'zcode-proxy'——
    // 那样 Windows 落地的是无后缀文件，spawn/taskkill 都不认。
    const dest = join(this.binDir, localName(goos))
    if (!force) {
      try {
        if (statSync(dest).size > 0) return dest // 已安装
      } catch { /* 不存在 → 下载 */ }
    }
    const notify = wrapProgress(opts.onProgress)
    // 查询 release 也要走网络（同样经代理），在弱网下这一步就可能卡几十秒。
    // 先报出来，用户才分得清「卡在查版本」还是「卡在下载」。
    notify({ phase: 'resolving', received: 0, total: 0 })
    // 起点就检查一次：用户可能在点「安装」的瞬间又点了「取消」，
    // 这时连 release 查询都不该发出去。
    throwIfCancelled(opts.signal)
    const info = await latestRelease(opts.fetch ?? fetch, opts.proxySource ?? '', opts.signal)
    const asset = info.assets.find((a) => a.name === name)
    if (!asset) {
      throw new Error(`sidecar: release ${info.tagName} 无资产 ${name}`)
    }
    mkdirSync(this.binDir, { recursive: true, mode: 0o755 })
    // 落地前先验来源：这个文件接下来会被 chmod 0700 并 spawn 执行，
    // 「从哪下」必须先收死（https + host 白名单），否则一个被篡改的
    // browser_download_url 就等于任意代码执行。
    const urlErr = checkDownloadURL(asset.url)
    if (urlErr !== '') throw new Error(`sidecar: 拒绝下载 —— ${urlErr}`)
    // —— 下载：断点续传 + 重试 ——
    //
    // 这一段是本文件里最容易被网络打败的地方。87MB 的 Windows 产物实测在当前
    // 网络下约 20 秒就被 ECONNRESET 掐断一次；旧实现每次重试都从 0 重下，
    // 于是「断了重下、重下又断」，用户看到的是一条永远爬不到头的进度条。
    // 现在：已收到的字节立刻追加进 <dest>.part，断了就带着 Range 头接着下，
    // 只补剩下那一段。GitHub release 资产实测支持 Range（206 + accept-ranges）。
    const part = partPath(dest)
    let received = 0
    try { received = statSync(part).size } catch { received = 0 }
    // 续传前必须确认这个半成品就是**本次这个资产**的下半截。
    // 只守 received >= asset.size 只能挡住「半成品更大」一个方向；磁盘上残留的
    // **旧版本**半成品比新包小时，会带着 Range 把新版本字节追加到旧数据后面，拼出
    // 一个长度恰好等于 asset.size 的「缝合怪」——长度校验照样通过，随后被 chmod
    // 0700 并执行。所以把来源（tag + 资产名 + 大小 + digest）记在 .part 旁边，
    // 对不上就整包重下。
    const partMeta = part + '.meta'
    const wantSource = JSON.stringify({
      tag: info.tagName, name, size: asset.size, digest: asset.digest ?? '',
    })
    let sourceMatches = false
    if (received > 0) {
      try { sourceMatches = readFileSync(partMeta, 'utf8') === wantSource } catch { sourceMatches = false }
    }
    if (received > 0 && !sourceMatches) {
      // 来源对不上（旧版本残留 / 换了资产 / 没有元数据）：不能续传，删掉重下。
      try { unlinkSync(part) } catch { /* 本来就不在 */ }
      received = 0
    }
    if (received > 0 && asset.size > 0 && received >= asset.size) {
      // 半成品已经不小了：上一轮其实下完了（只是没来得及 rename）。
      // 删掉后进入校验，让 sha256 做最终裁判。
      try { unlinkSync(part) } catch { /* 本来就不在 */ }
      received = 0
    }
    // 记下来源，供本轮中断后下一次续传核对（写失败不影响下载本身）。
    try { writeFileSync(partMeta, wantSource, { mode: 0o600 }) } catch { /* 尽力而为 */ }
    notify({ phase: 'downloading', received, total: asset.size })

    let lastErr: unknown = new Error('sidecar: 未尝试下载')
    // 重试上限只是防死循环的兜底，不是「试几次就算了」：只要每轮能推进若干
    // 字节，60 次足以覆盖 87MB（实测单次能撑约 20 秒）。
    //
    // 但「每轮推进 0 字节」是完全不同的故障：出口不通时，重试 60 次也只会得到
    // 60 次同样的 ECONNRESET——用户看到的就是「进度一直 0%，卡几分钟」。
    // 真实缺陷（用户报告「为什么卡在这里半分多钟」）：配的代理活着但**前几次连接
    // 会被立刻重置**（实测冷启动要失败 1~4 次、每次约 140ms，之后完全稳定），
    // 而直连其实是通的。
    //
    // 更正（我先前把这里判错了，用户实测打脸）：我一度以为「代理是坏的」，据此把
    // 阈值设成 3 轮就换直连。实测这对代理是**灾难**——冷启动正好要 4 次左右，
    // 第 3 轮就放弃等于永远用不上代理：
    //     经代理 2.67 MB/s  vs  直连 0.05 MB/s（慢 53 倍）
    // 用户的困惑「切不切代理都一个样」正是这个 bug 造成的：不管配不配代理，
    // 最后都掉到那条 0.05 MB/s 的直连上。
    //
    // 所以阈值必须**明显大于冷启动窗口**，且冷启动失败很快（~140ms），多试几次
    // 几乎不花时间。20 轮 × 140ms ≈ 3 秒，换来的是 53 倍速度，这笔账很划算。
    const ZERO_PROGRESS_LIMIT = 20
    let zeroProgressRounds = 0
    // 上一轮发起请求时磁盘上的 .part 大小；-1 = 还没发过请求。
    // 「本轮是否推进」= 这一轮开跑时磁盘比上一轮开跑时多了字节。
    // 历史缺陷（推送前子代理审查抓到的 P0）：这里一度写成 have === 0 才计数——
    // have 是磁盘存量不是本轮增量，只要用户暂停过一次留下非空 .part，出口死了
    // 也永远凑不满计数，回退形同虚设（正是该功能宣称要解决的场景）；且计数器
    // 从不在「有推进」时清零，冷启动窗口攒下的计数会错误地带进后半程。
    let prevHave = -1
    const MAX_ATTEMPTS = 60
    // 双向回退：代理不通→直连，直连不通→代理。用户要求「连不上自动换，反过来
    // 也一样，都报错就抛异常」。以前只做了代理→直连单向，所以「配了 direct 而
    // 直连恰好不通、代理其实能用」的场景只会一直报错，永远不换。
    // 起点：**调用方注入的 fetch 优先**。opts.fetch 就是本次要用的那条路——
    // 它可能是包了代理的，也可能是测试注入的替身。只有在调用方明确说
    // 「没走代理」（proxySource 缺失或 'direct'）**且**没注入 fetch 时，才用全局 fetch。
    //
    // 历史踩坑（本次改动引入又修掉）：这里一度写成
    //   usingDirect ? fetch : (opts.fetch ?? fetch)
    // 于是 proxySource 未声明时直接丢掉注入的 fetch，测试替身被绕开、真去连了网络
    // （症状：单测里冒出真实 http 404）。判定「能不能换路」要看 proxySource，
    // 但「当前用哪个 fetch」必须始终尊重调用方注入。
    // 起点用哪条路，由 proxySource 决定，而不是由「有没有注入 fetch」决定：
    // proxySource === 'direct' 就该真的直连。这里一度让 opts.fetch 无条件优先，
    // 于是「声明 direct、但调用方把包了代理的 fetch 也传了进来」时，直接跑去用了
    // 代理——声明与实际行为不符，双向回退的第一跳就错了（实测 directTries=0、
    // proxyTries=1，直连一次都没试）。注入的 fetch 作为「另一条路」留着换。
    //
    // 例外：调用方完全没声明 proxySource 时，尊重注入的 fetch（测试替身、
    // 自定义客户端都靠这条），否则会把替身绕开、真去连网络。
    const proxyFetch = opts.fetch
    const declared = opts.proxySource
    const useInjected = declared === undefined
    let usingDirect = useInjected ? true : declared === 'direct'
    // 能换的另一条路：声明 direct 时是注入的代理 fetch；声明代理时是全局直连。
    const canSwap = useInjected ? false : true
    let swapped = false
    let fetchImpl = usingDirect ? fetch : (proxyFetch ?? fetch)
    if (useInjected && proxyFetch !== undefined) fetchImpl = proxyFetch
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // 取消检查：用户可能在等待/传输之间任意时刻点取消。
      throwIfCancelled(opts.signal)
      // 每轮都以**磁盘上的 part** 为准，而不是内存里的计数：上一轮写进去的
      // 字节就是这一轮的续传起点，中途被杀掉留下的半成品也能接上。
      let have = 0
      try { have = statSync(part).size } catch { have = 0 }
      // 已经攒够了就没必要再发请求：拿 Range: bytes=<总长>- 去问，服务端只会
      // 回一个空段或 416。直接判定完成，交给下面的 sha256 校验做最终裁判。
      if (asset.size > 0 && have >= asset.size) { lastErr = undefined; break }
      // —— 零推进记账 + 双向回退 ——
      // 放在轮首（而不是某个 catch 里）是因为它必须覆盖**所有**零推进路径：
      // fetch 抛错、http 5xx、200 短响应、读流中断——共同点是磁盘一字节没涨，
      // 下一轮都会走到这里，一处记账就够了。
      if (have > prevHave) {
        zeroProgressRounds = 0 // 有推进：重新计冷启动窗口
      } else if (prevHave >= 0) {
        zeroProgressRounds++ // 与上一轮持平：上一轮零推进（首轮没有可比对象，不计）
      }
      prevHave = have
      if (!swapped && canSwap && zeroProgressRounds >= ZERO_PROGRESS_LIMIT) {
        swapped = true
        zeroProgressRounds = 0
        // 换到另一条路：代理↔直连。
        if (usingDirect) {
          // 直连不通 → 换代理。注意 proxyFetch 可能就是全局 fetch 本身
          //（调用方声明 direct 且没配任何代理出口时，决议层 proxiedFetch(null)
          // 直接返回全局 fetch）——换它等于没换，必须识别出来如实告警，
          // 而不是打一条「已改用代理」的假日志（子代理审查抓到的 P1）。
          if (proxyFetch !== undefined && proxyFetch !== fetch) {
            usingDirect = false
            fetchImpl = proxyFetch
            console.warn(
              `sidecar: 直连连续 ${ZERO_PROGRESS_LIMIT} 轮零字节推进，` +
              `**本次下载改用代理重试**。`)
          } else {
            console.warn(
              `sidecar: 直连连续 ${ZERO_PROGRESS_LIMIT} 轮零字节推进，且没有可切换的代理出口。` +
              `请检查网络，或配置 egress / HTTPS_PROXY。`)
          }
        } else {
          // 代理不通 → 全局 fetch（真直连）。
          usingDirect = true
          fetchImpl = fetch
          console.warn(
            `sidecar: 出口 ${declared ?? 'proxy'} 连续 ${ZERO_PROGRESS_LIMIT} 轮零字节推进，` +
            `**本次下载改用直连重试**——若直连也不通，请检查网络与代理设置。`)
        }
        notify({ phase: 'downloading', received: have, total: asset.size })
        continue
      }
      const headers: Record<string, string> = have > 0 ? { Range: `bytes=${have}-` } : {}
      let res: Response
      try {
        // signal 交给 fetch 本身：undici 会立刻拆除连接，取消才能在 1~2 秒内生效。
        // 仅靠上层循环检查是不够的——请求/读流期间不会回到循环顶部。
        res = await fetchImpl(asset.url, {
          headers,
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        })
      } catch (e) {
        // 取消导致的 fetch 中断不能被当成网络故障去重试（否则取消形同虚设）。
        if (opts.signal?.aborted === true) throw new SidecarCancelledError()
        // 同 latestRelease：把 undici 的 `fetch failed` 还原成可诊断的一句话，
        // 否则代理层故障只能给用户一个「就绪失败: fetch failed」。
        lastErr = new Error(`sidecar: 下载 ${name} 失败 —— ${describeFetchError(e)}`)
        await sleepMsg(opts, attempt, have, notify, asset.size)
        continue
      }
      // 200 = 服务端忽略了 Range（或本地没有半成品）→ 从头覆盖写；206 = 续传。
      if (res.status !== 200 && res.status !== 206) {
        lastErr = new Error(`sidecar: 下载失败: http ${res.status}`)
        // 4xx 基本不是网络抖动（404 资产没了 / 403 被限流），重试无意义。
        if (res.status >= 400 && res.status < 500) throw lastErr
        await sleepMsg(opts, attempt, have, notify, asset.size)
        continue
      }
      // 只有 206 才是真续传。若服务端回 200（不支持 Range 的镜像/代理），
      // 必须 'w' 截断重写——用 'a' 会把两遍数据拼在一起，产生一个错位的文件。
      const resumeFrom = res.status === 206 ? have : 0
      // 显式给 0o700：这个 .part 是「即将被 chmod 0700 并执行的二进制」的下半截，
      // 不应该在整个下载期间（以及暂停后长期驻留期间）对同机其他用户可读。
      // 不给 mode 会按 umask 落成 0644——收紧权限的 chmod 发生在下载**之后**，
      // 中间这段窗口就白开了（对比 projects/process.ts 的 openLog 用 0o600）。
      const fd = openSync(part, resumeFrom > 0 ? 'a' : 'w', 0o700)
      try {
        // 边收边写盘：中断时已收到的部分留在 part 里，下一轮接着下。
        await readBodyWithProgress(res, asset.size, notify, resumeFrom, (chunk) => {
          writeSync(fd, chunk)
        }, opts.signal)
      } catch (e) {
        // 读流中途被重置（ECONNRESET 最常见的形态）：已写进 part 的字节保留，
        // 绝不清空——清空等于把进度条打回 0，这正是旧实现装不上的原因。
        closeSync(fd)
        // 取消要立刻向上抛，不能被当成「网络中断」再走一次退避重试——
        // 那样用户点了取消还会看到它继续重连，取消形同虚设。
        if (e instanceof SidecarCancelledError || opts.signal?.aborted === true) {
          throw new SidecarCancelledError()
        }
        let kept = 0
        try { kept = statSync(part).size } catch { kept = 0 }
        // 关键：**中断可能发生在一段已经读完的时候**。若 part 已经攒够了总长度，
        // 这次「错误」其实只是收尾时被掐断，数据本身是完整的——必须在这里就
        // 判定成功并跳出。少了这一步，下一轮会拿 Range: bytes=<总长>- 去请求，
        // 服务端回一段又断，于是无限重试到耗尽次数（实测 20MB 用例里第 5 轮起
        // Range 就卡在文件总长上，空转到 60 次才报错）。
        if (asset.size > 0 && kept >= asset.size) {
          lastErr = undefined
          break
        }
        lastErr = new Error(`sidecar: 下载 ${name} 中断 —— ${describeFetchError(e)}`)
        await sleepMsg(opts, attempt, kept, notify, asset.size)
        continue
      }
      closeSync(fd)
      // 完整性看「落盘后的总长度」，而不是这一轮读到的长度：续传时后者更小。
      let onDisk = 0
      try { onDisk = statSync(part).size } catch { onDisk = 0 }
      if (asset.size > 0 && onDisk < asset.size) {
        lastErr = new Error(`sidecar: 下载不完整（${onDisk}/${asset.size} 字节）`)
        await sleepMsg(opts, attempt, onDisk, notify, asset.size)
        continue
      }
      lastErr = undefined
      break
    }
    if (lastErr !== undefined) throw lastErr
    // sha256 从落盘的文件读：续传时内存里只有最后一段，磁盘上才是完整数据。
    const buf = readFileSync(part)
    notify({ phase: 'verifying', received: buf.length, total: buf.length })

    // 完整性校验，优先级：显式 expectedSha256 > API 返回的 asset.digest > 告警放行。
    //
    // 早期版本注释断言「GitHub release API 不提供 digest」——**这是错的**。
    // GitHub 2025 起在 release asset 上提供 digest 字段（形如 "sha256:abc…"），
    // 实测 v4.6.7 的 zcode-proxy.exe 就带 sha256:2a351942…。此前因为没读这个
    // 字段，永远走「无摘要 → 放行」，白名单兜底被白白削弱，还会打出误导性的
    // 告警文案。现在自动采用它。
    let want = (opts.expectedSha256 ?? '').trim().toLowerCase()
    if (want.startsWith('sha256:')) want = want.slice('sha256:'.length)
    let wantSrc = want !== '' ? '调用方' : ''
    if (want === '') {
      const fromApi = (asset.digest ?? '').trim().toLowerCase()
      if (fromApi.startsWith('sha256:')) {
        want = fromApi.slice('sha256:'.length)
        wantSrc = 'release API'
      }
    }
    if (want !== '') {
      const got = sha256Hex(buf)
      if (got !== want) {
        // 摘要不符说明这份半成品是坏的（篡改，或代理/镜像串了内容）。
        // 必须删掉：留着它下一次会带着 Range 头从坏数据上接着写，永远修不好。
        try { unlinkSync(part) } catch { /* 本来就不在 */ }
        throw new Error(
          `sidecar: 摘要不匹配，已拒绝安装（期望 ${want}，实际 ${got}，来源 ${wantSrc}）。` +
          `可能是下载被篡改或上游重新打包，请核对 release 说明后重试。`)
      }
    } else if (opts.allowUntrusted === false) {
      try { unlinkSync(part) } catch { /* 本来就不在 */ }
      throw new Error('sidecar: 未提供 expectedSha256 且 release 未带 digest，已按 allowUntrusted=false 拒绝安装')
    } else {
      console.warn(
        `sidecar: 警告 —— ${name} 未提供任何 sha256 校验（调用方未给 expectedSha256，` +
        `release API 也未返回 digest），仅校验了来源 https + host 白名单；二进制将以本机权限执行。`)
    }

    // 半成品文件此时已是完整的 buf（上面下载循环结束时已核对过总长度），
    // 直接 rename 成正式二进制：原子、不产生半个可执行文件。
    // 0700 仅本用户可执行——part 是同目录内的临时文件，先 chmod 再改名。
    chmodSync(part, 0o700)
    renameSync(part, dest)
    return dest
  }

  // —— 安全配置 ——

  // setupConfig 生成安全配置（127.0.0.1 绑定 + 随机 key + start-plan），
  // 把 key 写进网关凭据文件（0600）。返回 key 供展示。
  // sidecarDir 是 sidecar 的工作目录（含其 config.yaml）。
  setupConfig(sidecarDir: string): string {
    const key = randomKey()
    const cfg = `server:
  port: ${this.port}
  host: "127.0.0.1"

auth:
  proxyApiKey: "${key}"

provider: zai
plan: start-plan

defaultModel: glm-5.3-flash
`
    mkdirSync(sidecarDir, { recursive: true, mode: 0o755 })
    writeFileSync(join(sidecarDir, 'config.yaml'), cfg, { mode: 0o600 })
    // 网关凭据引用
    const dir = dirname(this.credKey)
    if (dir !== '') mkdirSync(dir, { recursive: true, mode: 0o755 })
    writeFileSync(this.credKey, key, { mode: 0o600 })
    return key
  }

  // —— 进程管理 ——

  // setPort 改 sidecar 监听端口：只改写工作目录 config.yaml 的 port 行，
  // 其余配置（含 key 明文）原样保留。仅接受 1024-65535。
  // 注意：本方法会更新 this.port，之后的 running() 探活即打新端口——
  // 「停旧 → setPort → 启新」的顺序由调用方保证。
  setPort(sidecarDir: string, port: string): void {
    validatePort(port)
    const cfgPath = join(sidecarDir, 'config.yaml')
    const data = readFileSync(cfgPath, 'utf8')
    portLineRe.lastIndex = 0
    if (!portLineRe.test(data)) {
      throw new Error('config.yaml 中找不到 port 行')
    }
    portLineRe.lastIndex = 0
    writeFileSync(cfgPath, data.replace(portLineRe, `$1${port}$3`), { mode: 0o600 })
    this.port = port
  }

  // loadPort 从工作目录 config.yaml 恢复端口到 this.port（网关重启后用，
  // 否则探活仍打默认 8080）。文件不存在或没有 port 行时保持默认。
  loadPort(sidecarDir: string): void {
    try {
      const data = readFileSync(join(sidecarDir, 'config.yaml'), 'utf8')
      const m = portLineRe.exec(data)
      const p = m?.[2]
      if (p !== undefined && p !== '') this.port = p
    } catch { /* 缺文件 → 保持默认 */ }
  }

  // start 后台启动 sidecar（分离进程，日志落 sidecarDir/logs）。
  // 查找顺序见 findBinary：workDir（项目内）→ sidecarDir 参数 → binDir（install 默认位置）。
  //
  // needLogin 是启动失败时的自动补救钩子：引擎因未登录而拒绝启动时，先尝试从本机
  // 已有的 ZCode 登录态自动导入（见 tryAutoImportCredentials），成功就不打扰用户。
  // 真实缺陷（用户原话：「既然没登陆就不能自动弹出登录界面吗」）：以前这里只会把
  // 「去终端跑 polycode-hub zcode sidecar login」甩给用户——而多数情况下本机
  // 早就登录过 ZCode，凭据现成放着，程序完全可以自己搞定。
  async start(sidecarDir: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    try {
      await this.startOnce(sidecarDir, opts)
      return
    } catch (e) {
      // 取消不算「启动失败」：既不该触发导入补救，也不能被吞掉。
      if (e instanceof SidecarCancelledError) throw e
      const msg = (e as Error).message
      if (!/not logged in|未登录/i.test(msg)) throw e
      // 未登录：先试自动导入，成了就再起一次。
      const imported = await this.tryAutoImportCredentials(sidecarDir)
      if (!imported) throw e
      console.log(`sidecar: 已自动导入本机 ZCode 登录态（${imported}），重新启动引擎…`)
      await this.startOnce(sidecarDir, opts)
    }
  }

  // tryAutoImportCredentials 从本机已有的 ZCode 登录态导入凭据，返回导入成功的
  // provider 名（都失败则返回空串）。
  //
  // 为什么自动做：引擎的 `auth login <provider> --import` 读的是
  // ~/.zcode/v2/config.json 里 `builtin:<provider>-coding-plan.options.apiKey`。
  // 绝大多数用户早就用 ZCode 客户端登录过，那份凭据是现成的——让用户为此再走一遍
  // 浏览器 OAuth 是纯粹的重复劳动。
  async tryAutoImportCredentials(sidecarDir: string): Promise<string> {
    const bin = this.findBinary(sidecarDir)
    // 顺序有讲究：优先试当前 ZCode 客户端实际登录的那一侧（detectProvider 读
    // active_provider / 已有 apiKey 猜），不行再试另一个——省一次注定失败的导入。
    // 注释曾谎称已按 active_provider 排序、实际却写死 bigmodel 优先（子代理审查
    // 抓到的自相矛盾），现在两者真的对齐了。
    const first = this.detectProvider()
    for (const provider of [first, ...AUTH_PROVIDERS.filter((p) => p !== first)]) {
      try {
        const code = await runQuiet(bin, ['auth', 'login', provider, '--import'], sidecarDir)
        if (code === 0) return provider
      } catch { /* 这个 provider 没得导 → 试下一个 */ }
    }
    return ''
  }

  // detectProvider 猜用户该用哪个 provider 登录，优先免打扰地把默认值选对。
  //
  // 读本机 ZCode 客户端的 config.json：active_provider 指向谁、或哪个 provider
  // 有非空 apiKey，就默认登那个。读不到（没装客户端 / 文件缺失）时回落到 'zai'
  // ——z.ai 是产品主推的入口，且它的授权页最通用。
  //
  // 只是「默认值」而非强制：用户在网页上仍可自行切换 provider。
  detectProvider(): AuthProvider {
    try {
      const p = join(homedir(), '.zcode', 'v2', 'config.json')
      const cfg = JSON.parse(readFileSync(p, 'utf8')) as {
        active_provider?: string
        provider?: Record<string, { options?: { apiKey?: string } }>
      }
      const active = cfg.active_provider ?? ''
      for (const prov of AUTH_PROVIDERS) {
        // active_provider 可能写成 'zai' 或 'builtin:zai-coding-plan'，包含即算命中
        if (active !== '' && active.includes(prov)) return prov
      }
      for (const prov of AUTH_PROVIDERS) {
        const key = cfg.provider?.[`builtin:${prov}-coding-plan`]?.options?.apiKey
        if (typeof key === 'string' && key !== '') return prov
      }
    } catch { /* 没装客户端 / 文件不可读 → 用默认值 */ }
    return 'zai'
  }

  // startOnce 是真正的一次启动尝试（不含自动导入补救）。
  private async startOnce(sidecarDir: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    if (await this.running()) return // 幂等
    const bin = this.findBinary(sidecarDir)
    const logDir = join(sidecarDir, 'logs')
    mkdirSync(logDir, { recursive: true, mode: 0o755 })
    const logPath = join(logDir, 'sidecar.log')
    // 记下启动前的日志长度：之后只读「本次新增的部分」，避免把历史的
    // Not logged in 之类旧错误当成这次的失败原因。
    let logSizeBefore = 0
    try { logSizeBefore = statSync(logPath).size } catch { logSizeBefore = 0 }
    const fd = openSync(logPath, 'a', 0o644)
    const child = spawn(bin, ['--cli', 'serve'], {
      cwd: sidecarDir,
      // detached：posix 新会话（setsid）/ windows 新进程组，脱离父进程生命周期
      detached: true,
      stdio: ['ignore', fd, fd],
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    })
    try { closeSync(fd) } catch { /* 子进程已持副本 */ }
    // 子进程立刻退出 = 它自己拒绝了启动（未登录/端口占用/权限），
    // 这时**没必要再干等 45 秒**：用户实测「点了启动没反应」，其中 45 秒
    // 完全是在等一个已经死掉的进程。捕获退出码，立即带着日志原因失败。
    let earlyExit: number | null = null
    child.on('exit', (code) => { earlyExit = code ?? 0 })
    reap(child)
    await this.waitHealthy(45_000, sidecarDir, () => earlyExit, logPath, logSizeBefore, opts.signal)
  }

  // discardPartial 只删除下载半成品（.part），返回被删掉的字节数。
  // 供「取消」使用：取消是放弃这次下载，不该留一个几十 MB 的半截文件——
  // 留着既占地方，又会让下次安装带着 Range 头从一段来路不明的数据中间接着写。
  //
  // 刻意**只删 .part，绝不动已装好的正式二进制**：取消的是「这次下载」，
  // 不是卸载引擎。误删正式产物会让已装好的引擎凭空消失——那比留下半截文件糟得多。
  discardPartial(sidecarDir: string): number {
    let removed = 0
    const dirs = [this.workDir, sidecarDir, this.binDir]
    for (const dir of dirs) {
      // 空目录必须跳开：join('' , name) 会退化成相对路径，误删进程 cwd 下的文件
      //（与 uninstall 里同一个守卫，两处口径一致）。
      if (dir === '') continue
      // 只清 .part；正式二进制交给 uninstall，职责分离。
      for (const c of [partPath(join(dir, this.binName))]) {
        try {
          const n = statSync(c).size
          unlinkSync(c)
          removed += n
        } catch { /* 本来就不在 */ }
      }
    }
    return removed
  }

  // findBinary 按 workDir → sidecarDir 参数 → binDir 顺序查找 sidecar 二进制。
  // 文件名用 binName（Windows 带 .exe），与 install 落地的名字一致。
  findBinary(sidecarDir: string): string {
    const cands = [
      join(this.workDir, this.binName),
      join(sidecarDir, this.binName),
      join(this.binDir, this.binName),
    ]
    for (const c of cands) {
      try {
        if (statSync(c).size > 0) return c
      } catch { /* 下一个候选 */ }
    }
    throw new Error(`sidecar: 未安装（先 install，或把 ${this.binName} 二进制放到 ${sidecarDir}）`)
  }

  // stop 停止 sidecar（按进程名匹配）。
  async stop(): Promise<void> {
    if (!(await this.running())) return
    const spec = killSidecarSpec(process.platform)
    const out = await new Promise<string>((resolve) => {
      execFile(spec.cmd, spec.args, { encoding: 'utf8', timeout: 10_000 }, (err, stdout) => {
        resolve(err ? '' : stdout) // pgrep 无匹配 = 已停
      })
    })
    for (const line of out.trim().split('\n')) {
      const pid = Number.parseInt(line.trim(), 10)
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 'SIGTERM') } catch { /* 已退出 */ }
      }
    }
  }

  // stopAll 杀掉**所有** zcode-proxy 进程，不管它是否在服务端。
  //
  // 与 stop() 的差别只在「不看 running()」。stop() 只在探活成功时才动手，而
  // running() 只探 127.0.0.1:8080 的 /health——看不见那些**不在服务**的进程。
  // 典型就是登录流程：auth login 要等用户授权 5 分钟，它持有 exe 文件句柄，
  // 但不监听端口。卸载时 Windows 因此报 EPERM「文件被占用」，删不掉。
  async stopAll(): Promise<void> {
    const spec = killSidecarSpec(process.platform)
    const out = await new Promise<string>((resolve) => {
      execFile(spec.cmd, spec.args, { encoding: 'utf8', timeout: 10_000 }, (err, stdout) => {
        resolve(err ? '' : stdout)
      })
    })
    for (const line of out.trim().split('\n')) {
      const pid = Number.parseInt(line.trim(), 10)
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 'SIGTERM') } catch { /* 已退出 */ }
      }
    }
  }

  // running 报告 sidecar 是否在监听并健康。
  // sidecar 开启鉴权后 /health 也要求 key——从 credKey 现读（凭据热轮换即生效）。
  async running(): Promise<boolean> {
    const headers: Record<string, string> = {}
    try {
      headers.Authorization = 'Bearer ' + readFileSync(this.credKey, 'utf8').trim()
    } catch { /* 未配置 key → 不带鉴权头探测 */ }
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/health`, {
        headers,
        signal: AbortSignal.timeout(2000),
      })
      return res.status === 200
    } catch {
      return false
    }
  }

  // status 返回人类可读状态。
  async status(): Promise<string> {
    if (await this.running()) {
      return `running (127.0.0.1:${this.port})`
    }
    try {
      this.findBinary(this.workDir)
      return 'installed, stopped'
    } catch {
      return 'not installed'
    }
  }

  // waitHealthy 等到 /health 200 或超时（日志在 sidecarDir/logs 下看）。
  //
  // 超时时必须把**日志里的真实原因**带出来。真实缺陷（Windows 上表现为
  // 「老是启动失败」）：引擎没登录时会打印 `Not logged in. Run: zcode-proxy
  // auth login zai` 并以退出码 1 立刻退出，而这里只会说「启动超时」——把用户
  // 引向「网络/二进制坏了」的错误方向，真正该做的「跑一次登录」反而看不到。
  private async waitHealthy(
    timeoutMs: number,
    sidecarDir: string,
    exited?: () => number | null,
    logPath?: string,
    logSizeBefore?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.running()) return
      // 取消必须在等待期间就能生效：starting 阶段最长 45 秒，用户点「暂停/取消」
      // 不能干等它跑完（子代理审查抓到的 P1——此前 abort 只在下载循环里被看）。
      // 注意引擎进程本身已经 spawn，无法收回；这里抛出的是「作业已取消」，
      // 引擎随后是否健康由状态页如实反映。
      if (signal?.aborted === true) throw new SidecarCancelledError()
      // 进程已经退了就别等了：它不会自己活过来。立刻带着真实原因失败，
      // 把「45 秒的无反馈干等」压到一两秒。
      const code = exited?.()
      if (code !== null && code !== undefined) {
        const why = logTailHint(sidecarDir, logPath, logSizeBefore)
        throw new Error(
          why === ''
            ? `sidecar: 启动失败（进程立即退出，退出码 ${code}）`
            : `sidecar: 启动失败 —— ${why}`)
      }
      await sleep(500)
    }
    const hint = startupFailureHint(sidecarDir)
    throw new Error(
      hint === ''
        ? `sidecar: 启动超时（查看 ${join(sidecarDir, 'logs')}）`
        : `sidecar: 启动失败 —— ${hint}`)
  }

  // login 拉起引擎的 OAuth 登录。
  //
  // 引擎 4.6.8 起 `auth login` **自己就会打开默认浏览器**（进程内跑
  // `cmd /c start <授权页>`，本机实测确认），并把授权 URL 原样打到 stdout。
  // 所以这里只管 spawn + 透传，**绝不能**再「嗅探到 URL 就替用户开一次」——
  // 早期引擎不自带弹浏览器时那是对的（当时用户报告「点了登录什么都没发生」），
  // 现在引擎行为变了，替开一次就成了 CLI 下「点一次登录弹两个一模一样的授权页」
  // 的直接原因（与网页端 window.open 双开同根，两边是一起修的）。
  // 引擎没有关闭自开的旗标（`--paste` 只作用于 bigmodel 验证码流），唯一一次
  // 打开就交给引擎自己；URL 始终在 stdout 里，复制粘贴这条路永远可用。
  async login(sidecarDir: string, provider: AuthProvider = 'zai'): Promise<void> {
    const bin = this.findBinary(sidecarDir)
    console.log(`即将启动 sidecar 登录流程（${provider}，浏览器 OAuth，登录一次即可）：`)
    const code = await new Promise<number>((resolve) => {
      const child = spawn(bin, ['auth', 'login', provider], {
        cwd: sidecarDir,
        // 全 inherit：开浏览器与打印授权 URL 都是引擎自己的职责，透传即可。
        stdio: 'inherit',
      })
      child.on('error', (e) => {
        console.error(String(e))
        resolve(1)
      })
      child.on('close', (c) => { resolve(c ?? 1) })
    })
    if (code !== 0) throw new Error(`sidecar: 登录流程退出码 ${code}`)
  }

  // beginLogin 启动登录流程并**立刻返回**，不阻塞在「等用户授权」上。
  //
  // 为什么要有这个入口：管理台要在网页上给一个「登录授权」按钮（用户原话：
  // 「为啥不能手动弹出登录界面呢？」）。而 login() 是阻塞的——它会一直等到
  // OAuth 完成（最长 5 分钟）才返回，HTTP 请求不可能挂这么久。
  //
  // 返回两个 promise：
  //   · url  —— 授权链接（抓到即兑现；15 秒抓不到就给空串，避免调用方永久挂起）
  //   · done —— 登录流程的退出码（供后台等待，不阻塞响应）
  //
  // URL 交给前端只是**兜底**：引擎 4.6.8 起自己就会弹默认浏览器（这是唯一一次
  // 打开），前端拿到 URL 只在页面上展示成兜底链接（自动弹出失灵时用户手动点），
  // 绝不能再自动 window.open——那会造成「点一次登录弹两个一模一样的授权页」。
  beginLogin(
    sidecarDir: string,
    provider: AuthProvider = 'zai',
  ): { url: Promise<string>; done: Promise<number>; child: { kill: () => void } } {
    const bin = this.findBinary(sidecarDir)
    const child = spawn(bin, ['auth', 'login', provider], {
      cwd: sidecarDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    })
    let buffered = ''
    let got = false
    let resolveURL: (u: string) => void = () => {}
    const urlP = new Promise<string>((res) => { resolveURL = res })
    // 与 login() 同样的「按整行匹配」：stdout 分块会把 URL 截断，半截 URL
    // 开出来的页面必然授权失败。
    const onData = (buf: Buffer): void => {
      const text = buf.toString()
      process.stdout.write(text)
      buffered += text
      if (got) return
      const nl = buffered.lastIndexOf('\n')
      if (nl < 0) return
      const m = authURLRe.exec(buffered.slice(0, nl))
      if (m === null) return
      got = true
      resolveURL(m[0])
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', (b: Buffer) => { process.stderr.write(b) })
    const done = new Promise<number>((resolve) => {
      child.on('error', () => { if (!got) resolveURL(''); resolve(1) })
      child.on('close', (c) => { if (!got) resolveURL(''); resolve(c ?? 1) })
    })
    // 超时兜底：引擎迟迟不给 URL 时也要让调用方能退出，不能永久挂起请求。
    // URL 提前到手就把竞速定时器清掉，别让一个已经无用的 15 秒定时器悬在事件循环里。
    let urlTimer: ReturnType<typeof setTimeout> | undefined
    const urlWithTimeout = Promise.race([
      urlP,
      new Promise<string>((res) => { urlTimer = setTimeout(() => res(''), 15_000) }),
    ])
    void urlP.then(() => { if (urlTimer !== undefined) clearTimeout(urlTimer) })
    return { url: urlWithTimeout, done, child }
  }

  // ensureReady 是一键入口：装（若缺）→ 配（若缺）→ 起（若停）。
  // sidecarDir 由调用方决定（如 ~/Projects/zcode-proxy）。
  async ensureReady(sidecarDir: string, opts: EnsureReadyOptions = {}): Promise<void> {
    const notify = wrapProgress(opts.onProgress)
    // 下载走 GitHub，经代理的网络时常抖动（EOF/超时）。重试与断点续传都在
    // install 内部（它持有 <dest>.part，续传才有意义）；这里只做「装→配→起」
    // 的编排，不再自己包一层 3 次循环——那层循环会把续传的成果丢掉：
    // 每次重进 install 都从零开始，正是「永远装不完」的由来。
    const doze = opts.sleep ?? sleep
    await this.install(false, { fetch: opts.fetch, onProgress: notify, sleep: doze, proxySource: opts.proxySource, signal: opts.signal })
    // 装完/配置前的取消点：下载可能刚结束用户就点了取消，别白跑剩下的步骤。
    throwIfCancelled(opts.signal)
    notify({ phase: 'configuring', received: 0, total: 0 })
    const cfgPath = join(sidecarDir, 'config.yaml')
    try {
      statSync(cfgPath)
    } catch {
      this.setupConfig(sidecarDir)
    }
    if (!(await this.running())) {
      // 启动最长等 45 秒（waitHealthy）：这一段以前完全不可见，用户看到的是
      // 一个已经静止的「安装中」再卡 45 秒，无法判断是慢还是死。
      // signal 一并传下去：starting 阶段的暂停/取消也要能立刻生效。
      throwIfCancelled(opts.signal)
      notify({ phase: 'starting', received: 0, total: 0 })
      await this.start(sidecarDir, { ...(opts.signal !== undefined ? { signal: opts.signal } : {}) })
    }
  }

  // uninstall 卸载 sidecar：删二进制、网关凭据 key 文件、工作目录里的
  // config.yaml（含 key 明文）与 logs。running 时拒绝（先 stop）。
  // removeWorkDir=false 时保留工作目录的其他数据（登录凭据 ~/.zcode-proxy 不动——
  // 那是用户的 OAuth 身份，删了要重新授权浏览器流程）。
  async uninstall(removeWorkDir: boolean): Promise<UninstallResult> {
    const res: UninstallResult = {}
    if (await this.running()) {
      throw new Error('sidecar 正在运行，先停止再卸载')
    }
    // 除了「在服务端」的引擎，还可能有**别的** zcode-proxy 进程占着二进制：
    // 典型就是登录流程（auth login 要等用户授权 5 分钟，期间它持有 exe 文件句柄）。
    // running() 只探活 8080，看不见这类进程；于是卸载时 Windows 报 EPERM。
    // 卸载的意图是「把这个引擎拿掉」，残留的登录进程没有留着的理由——先停掉。
    await this.stopAll()
    // 二进制（两处候选都清）。Windows 上旧版本可能留下无后缀的 'zcode-proxy'
    // （历史缺陷：dest 硬编码），一并清掉，避免残留一个永远不会被执行的文件。
    // 判据取 this.binName 而非 process.platform：与 install/findBinary 同一口径，
    // 也让「Windows 行为」可以在任意平台上被测试。
    //
    // 空 dir 必须跳过（下面的循环体里有这个守卫，别删）：workDir 未设时
    // join('', name) 会退化成相对路径，unlink 会打向进程 cwd——那不是
    // 「多加一层防御」，是防误删用户文件的必需品。
    const names = this.binName === 'zcode-proxy.exe'
      ? [this.binName, 'zcode-proxy'] // .exe + 历史遗留的无后缀文件
      : [this.binName]
    // 删除失败必须**收集起来**而不是吞掉。真实缺陷（用户报告「点了卸载还是
    // installed」）：Windows 上可执行文件正被占用时 unlinkSync 抛
    // EPERM/EBUSY，原来的 `catch {}` 把它当成「本来就不在」静默跳过——
    // 于是卸载返回成功、二进制原封不动，页面仍然显示 installed。
    // 静默吞异常比报错更糟：用户以为卸了，实际没卸。
    const failures: string[] = []
    for (const dir of [this.workDir, this.binDir]) {
      if (dir === '') continue // workDir 未设时 join 会退化成相对路径，跳开
      for (const n of names) {
        // 半成品也必须清：留着 87MB 的下到一半的文件，既占地方，又会让
        // 下次安装带着 Range 头从一段来路不明的数据中间接着写。
        for (const c of [join(dir, n), partPath(join(dir, n))]) {
          try {
            if (statSync(c).size >= 0) {
              unlinkSync(c)
              if (!c.endsWith('.part') && res.binary === undefined) res.binary = c
            }
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code
            // ENOENT = 本来就不在（预期内，不算失败）；其余都是真失败
            if (code !== 'ENOENT') failures.push(`${c}（${code ?? (e as Error).message}）`)
          }
        }
      }
    }
    if (failures.length > 0) {
      // 最常见的就是「引擎还在跑」：Windows 不允许删正在执行的 exe。
      throw new Error(
        `sidecar: 卸载未能删除以下文件：${failures.join('、')}。` +
        `多半是引擎进程仍占用中 —— 先点「停止」，或在本机结束 zcode-proxy 进程后再卸载。`)
    }
    // 网关凭据 key 文件
    try {
      unlinkSync(this.credKey)
      res.credKey = this.credKey
    } catch { /* 本来就不在 */ }
    // 工作目录里的运行产物：removeWorkDir=true 时整个工作目录清掉
    // （config.yaml 含 key 明文，必须清）；false 只清 key 相关。
    const cfgPath = join(this.workDir, 'config.yaml')
    try {
      unlinkSync(cfgPath)
      ;(res.workDirData ??= []).push(cfgPath)
    } catch { /* 本来就不在 */ }
    if (removeWorkDir) {
      try {
        rmSync(this.workDir, { recursive: true })
        res.workDirData?.push(this.workDir)
      } catch { /* 本来就不在 */ }
    }
    // 端口状态必须一并复位：config.yaml 已经删了，下次 ensureReady 会重新生成，
    // 而 sidecar 找不到端口配置时回落 8080。若这里仍留着旧端口（比如 setPort 到 9090），
    // 网关侧 providers 表里指向 9090 的 baseUrl 就会永久打不通——
    // 表现为「重装后引擎起不来」，但日志里没有任何错误。
    this.port = '8080'
    return res
  }
}

// reap 收割子进程避免僵尸（对齐 Go 的 go func(){ cmd.Wait() }()）。
function reap(child: ChildProcess): void {
  child.unref()
  child.on('error', () => { /* 启动失败由探活超时兜底 */ })
}
