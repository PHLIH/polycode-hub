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
}

export interface EnsureReadyOptions {
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  // onProgress 透传给 install，并补上 configuring / starting 两个阶段。
  onProgress?: ProgressFn
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
  const chunks: Buffer[] = []
  let received = 0
  let lastAt = 0
  notify({ phase: 'downloading', received: base, total })
  for (;;) {
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
export async function latestRelease(fetchImpl: FetchLike = fetch): Promise<ReleaseInfo> {
  let res: Response
  try {
    res = await fetchImpl(releaseAPI, { headers: { Accept: 'application/vnd.github+json' } })
  } catch (e) {
    // 不包这一层的话，代理层故障会原样冒泡成「就绪失败: fetch failed」——
    // 用户只知道失败了，不知道是节点挂了还是端口写错了。
    throw new Error(`sidecar: 查询 release 失败 —— ${describeFetchError(e)}`)
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
    const info = await latestRelease(opts.fetch ?? fetch)
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
    if (received > 0 && asset.size > 0 && received >= asset.size) {
      // 半成品已经不小了：要么上一轮其实下完了（只是没来得及 rename），
      // 要么上游重新打过包。两种情况下都不要续传——后者会拼出一个坏文件，
      // 前者应当直接进入校验。删掉重下，让 sha256 做最终裁判。
      try { unlinkSync(part) } catch { /* 本来就不在 */ }
      received = 0
    }
    notify({ phase: 'downloading', received, total: asset.size })

    let lastErr: unknown = new Error('sidecar: 未尝试下载')
    // 重试上限只是防死循环的兜底，不是「试几次就算了」：只要每轮能推进若干
    // 字节，60 次足以覆盖 87MB（实测单次能撑约 20 秒）。
    const MAX_ATTEMPTS = 60
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // 每轮都以**磁盘上的 part** 为准，而不是内存里的计数：上一轮写进去的
      // 字节就是这一轮的续传起点，中途被杀掉留下的半成品也能接上。
      let have = 0
      try { have = statSync(part).size } catch { have = 0 }
      // 已经攒够了就没必要再发请求：拿 Range: bytes=<总长>- 去问，服务端只会
      // 回一个空段或 416。直接判定完成，交给下面的 sha256 校验做最终裁判。
      if (asset.size > 0 && have >= asset.size) { lastErr = undefined; break }
      const headers: Record<string, string> = have > 0 ? { Range: `bytes=${have}-` } : {}
      let res: Response
      try {
        res = await (opts.fetch ?? fetch)(asset.url, { headers })
      } catch (e) {
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
      const fd = openSync(part, resumeFrom > 0 ? 'a' : 'w')
      try {
        // 边收边写盘：中断时已收到的部分留在 part 里，下一轮接着下。
        await readBodyWithProgress(res, asset.size, notify, resumeFrom, (chunk) => {
          writeSync(fd, chunk)
        })
      } catch (e) {
        // 读流中途被重置（ECONNRESET 最常见的形态）：已写进 part 的字节保留，
        // 绝不清空——清空等于把进度条打回 0，这正是旧实现装不上的原因。
        closeSync(fd)
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
  async start(sidecarDir: string): Promise<void> {
    if (await this.running()) return // 幂等
    const bin = this.findBinary(sidecarDir)
    const logDir = join(sidecarDir, 'logs')
    mkdirSync(logDir, { recursive: true, mode: 0o755 })
    const fd = openSync(join(logDir, 'sidecar.log'), 'a', 0o644)
    const child = spawn(bin, ['--cli', 'serve'], {
      cwd: sidecarDir,
      // detached：posix 新会话（setsid）/ windows 新进程组，脱离父进程生命周期
      detached: true,
      stdio: ['ignore', fd, fd],
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    })
    try { closeSync(fd) } catch { /* 子进程已持副本 */ }
    reap(child)
    await this.waitHealthy(45_000, sidecarDir)
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
  private async waitHealthy(timeoutMs: number, sidecarDir: string): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.running()) return
      await sleep(500)
    }
    throw new Error(`sidecar: 启动超时（查看 ${join(sidecarDir, 'logs')}）`)
  }

  // login 交互提示：sidecar 的 OAuth 登录需要浏览器，直接把用户引到官方登录命令。
  // （登录是用户与上游工具的交互，polycode-hub 不代持。）
  async login(sidecarDir: string): Promise<void> {
    const bin = this.findBinary(sidecarDir)
    console.log('即将启动 sidecar 登录流程（浏览器 OAuth，登录一次即可）：')
    console.log('  ', bin, 'auth login zai')
    const code = await new Promise<number>((resolve) => {
      const child = spawn(bin, ['auth', 'login', 'zai'], {
        cwd: sidecarDir,
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

  // ensureReady 是一键入口：装（若缺）→ 配（若缺）→ 起（若停）。
  // sidecarDir 由调用方决定（如 ~/Projects/zcode-proxy）。
  async ensureReady(sidecarDir: string, opts: EnsureReadyOptions = {}): Promise<void> {
    const notify = wrapProgress(opts.onProgress)
    // 下载走 GitHub，经代理的网络时常抖动（EOF/超时）。重试与断点续传都在
    // install 内部（它持有 <dest>.part，续传才有意义）；这里只做「装→配→起」
    // 的编排，不再自己包一层 3 次循环——那层循环会把续传的成果丢掉：
    // 每次重进 install 都从零开始，正是「永远装不完」的由来。
    const doze = opts.sleep ?? sleep
    await this.install(false, { fetch: opts.fetch, onProgress: notify, sleep: doze })
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
      notify({ phase: 'starting', received: 0, total: 0 })
      await this.start(sidecarDir)
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
    // 二进制（两处候选都清）。Windows 上旧版本可能留下无后缀的 'zcode-proxy'
    // （历史缺陷：dest 硬编码），一并清掉，避免残留一个永远不会被执行的文件。
    // 判据取 this.binName 而非 process.platform：与 install/findBinary 同一口径，
    // 也让「Windows 行为」可以在任意平台上被测试。
    //
    // 注意不要给 dir 加「空则跳过」的守卫：POSIX 上 names 只有一项，结构与改动前
    // 完全一致（原来也是无条件下 join(workDir, 'zcode-proxy')）。多加守卫会让
    // workDir 未设时的行为发生变化，白白扩大跨平台差异面。
    const names = this.binName === 'zcode-proxy.exe'
      ? [this.binName, 'zcode-proxy'] // .exe + 历史遗留的无后缀文件
      : [this.binName]
    for (const dir of [this.workDir, this.binDir]) {
      for (const n of names) {
        // 半成品也必须清：留着 87MB 的下到一半的文件，既占地方，又会让
        // 下次安装带着 Range 头从一段来路不明的数据中间接着写。
        for (const c of [join(dir, n), partPath(join(dir, n))]) {
          try {
            unlinkSync(c)
            if (!c.endsWith('.part') && res.binary === undefined) res.binary = c
          } catch { /* 本来就不在 */ }
        }
      }
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
