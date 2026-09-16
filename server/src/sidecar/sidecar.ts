// ZCode plan 通道 sidecar（TriDefender/zcode-proxy）的即插即用管理。
//
// 合规边界（NOTICE.md 已登记）：该工具无 LICENSE（默认保留所有权利），polycode-hub
// 不分发、不捆绑、不复制其代码——本包只做「下载官方 release → 生成安全配置 →
// 进程管理」的胶水。移植自 Go internal/sidecar/sidecar.go（不含无调用者的
// stdinLine / PingSidecar，grep 确认无生产使用点）。

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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
}

export interface ReleaseInfo {
  tagName: string
  assets: ReleaseAsset[]
}

export type FetchLike = typeof fetch

export interface InstallOptions {
  fetch?: FetchLike
  goos?: string // 默认 process.platform
  arch?: string // 默认 process.arch
  // expectedSha256 期望的二进制摘要（十六进制，大小写不敏感）。
  // GitHub release API 不提供 digest，所以只能由调用方/配置文件给出；
  // 给了就强制比对，不一致直接拒绝安装（不落地、不执行）。
  expectedSha256?: string
  // allowUntrusted 显式豁免「未提供摘要」这一条（白名单与 https 仍然强制）。
  // 默认 false：宁可让用户显式确认，也不静默接受一个未经校验的可执行文件。
  allowUntrusted?: boolean
}

export interface EnsureReadyOptions {
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
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

// assetName 返回当前平台的 release 资产名（与上游命名约定对齐）。
export function assetName(goos: string, arch: string): string {
  switch (goos) {
    case 'darwin': return 'zcode-proxy-darwin-' + arch
    case 'linux': return 'zcode-proxy-linux-' + arch
    case 'windows': return 'zcode-proxy.exe'
    default: return ''
  }
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

// latest 查询上游最新 release 信息。
export async function latestRelease(fetchImpl: FetchLike = fetch): Promise<ReleaseInfo> {
  const res = await fetchImpl(releaseAPI, { headers: { Accept: 'application/vnd.github+json' } })
  if (res.status !== 200) {
    throw new Error(`sidecar: 查询 release 失败: http ${res.status}`)
  }
  const raw = JSON.parse(await res.text()) as {
    tag_name?: string
    assets?: { name?: string; browser_download_url?: string; size?: number }[]
  }
  return {
    tagName: raw.tag_name ?? '',
    assets: (raw.assets ?? []).map((a) => ({
      name: a.name ?? '',
      url: a.browser_download_url ?? '',
      size: a.size ?? 0,
    })),
  }
}

// Sidecar 是 zcode-proxy 本地实例的管理句柄。
export class Sidecar {
  binDir: string // 二进制安装目录（~/.polycode-hub/bin）
  dataDir: string // sidecar 凭据/配置目录（~/.zcode-proxy）
  credKey: string // 网关侧凭据引用文件路径（config/credentials/zcode-proxy-key）
  port: string
  // workDir 是 sidecar 工作目录（含其 config.yaml 与可选的本地二进制）。
  // findBinary 查找顺序：workDir/zcode-proxy → sidecarDir/zcode-proxy → binDir/zcode-proxy。
  workDir: string

  constructor(credKey: string, opts: SidecarOptions = {}) {
    const home = homedir()
    this.binDir = opts.binDir ?? join(home, '.polycode-hub', 'bin')
    this.dataDir = opts.dataDir ?? join(home, '.zcode-proxy')
    this.credKey = credKey
    this.port = opts.port ?? '8080'
    this.workDir = opts.workDir ?? ''
  }

  // —— 下载安装 ——

  // install 下载官方 release 二进制到 binDir（0700）。已存在时跳过（force 强制重装）。
  async install(force = false, opts: InstallOptions = {}): Promise<string> {
    const goos = opts.goos ?? process.platform
    const arch = opts.arch ?? process.arch
    const name = assetName(goos, arch)
    if (name === '') {
      throw new Error(`sidecar: 平台 ${goos}/${arch} 无预编译产物（可从源码构建）`)
    }
    const dest = join(this.binDir, 'zcode-proxy')
    if (!force) {
      try {
        if (statSync(dest).size > 0) return dest // 已安装
      } catch { /* 不存在 → 下载 */ }
    }
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
    const res = await (opts.fetch ?? fetch)(asset.url)
    if (res.status !== 200) {
      throw new Error(`sidecar: 下载失败: http ${res.status}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())

    // 完整性校验：摘要给了就必须对上（不符直接拒绝，不落地）。
    // 没给摘要时，GitHub release API 本身也不提供 digest——我们无法凭空验证，
    // 所以默认放行但**显式告警**；调用方可用 expectedSha256 强制收紧，
    // 或用 allowUntrusted:false 把「未校验」升级成硬错误。
    const want = (opts.expectedSha256 ?? '').trim().toLowerCase()
    if (want !== '') {
      const got = sha256Hex(buf)
      if (got !== want) {
        throw new Error(
          `sidecar: 摘要不匹配，已拒绝安装（期望 ${want}，实际 ${got}）。` +
          `可能是下载被篡改或上游重新打包，请核对 release 说明后重试。`)
      }
    } else if (opts.allowUntrusted === false) {
      throw new Error('sidecar: 未提供 expectedSha256，已按 allowUntrusted=false 拒绝安装')
    } else {
      console.warn(
        `sidecar: 警告 —— ${name} 未提供 sha256 校验（上游 API 不返回 digest），` +
        `仅校验了来源 https + host 白名单；二进制将以本机权限执行。`)
    }

    // 临时文件 + rename，防半写；0700 仅本用户可执行
    const tmp = dest + '.tmp'
    writeFileSync(tmp, buf, { mode: 0o700 })
    renameSync(tmp, dest)
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
  findBinary(sidecarDir: string): string {
    const cands = [
      join(this.workDir, 'zcode-proxy'),
      join(sidecarDir, 'zcode-proxy'),
      join(this.binDir, 'zcode-proxy'),
    ]
    for (const c of cands) {
      try {
        if (statSync(c).size > 0) return c
      } catch { /* 下一个候选 */ }
    }
    throw new Error(`sidecar: 未安装（先 install，或把 zcode-proxy 二进制放到 ${sidecarDir}）`)
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
    // 下载走 GitHub，经代理的网络时常抖动（EOF/超时）：重试 3 次，间隔 2s。
    const doze = opts.sleep ?? sleep
    let err: unknown = new Error('sidecar: 未尝试安装')
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.install(false, { fetch: opts.fetch })
        err = undefined
        break
      } catch (e) {
        err = e
        await doze(2000)
      }
    }
    if (err !== undefined) throw err
    const cfgPath = join(sidecarDir, 'config.yaml')
    try {
      statSync(cfgPath)
    } catch {
      this.setupConfig(sidecarDir)
    }
    if (!(await this.running())) {
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
    // 二进制（两处候选都清）
    for (const c of [join(this.workDir, 'zcode-proxy'), join(this.binDir, 'zcode-proxy')]) {
      try {
        unlinkSync(c)
        if (res.binary === undefined) res.binary = c
      } catch { /* 本来就不在 */ }
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
