// ZCode plan 通道 sidecar（TriDefender/zcode-proxy）的即插即用管理。
//
// 合规边界（NOTICE.md 已登记）：该工具无 LICENSE（默认保留所有权利），polycode-hub
// 不分发、不捆绑、不复制其代码——本包只做「下载官方 release → 生成安全配置 →
// 进程管理」的胶水。移植自 Go internal/sidecar/sidecar.go（不含无调用者的
// stdinLine / PingSidecar，grep 确认无生产使用点）。

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const releaseAPI = 'https://api.github.com/repos/TriDefender/zcode-api/releases/latest'

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
    const res = await (opts.fetch ?? fetch)(asset.url)
    if (res.status !== 200) {
      throw new Error(`sidecar: 下载失败: http ${res.status}`)
    }
    // 临时文件 + rename，防半写；0700 仅本用户可执行
    const tmp = dest + '.tmp'
    writeFileSync(tmp, Buffer.from(await res.arrayBuffer()), { mode: 0o700 })
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
    return res
  }
}

// reap 收割子进程避免僵尸（对齐 Go 的 go func(){ cmd.Wait() }()）。
function reap(child: ChildProcess): void {
  child.unref()
  child.on('error', () => { /* 启动失败由探活超时兜底 */ })
}
