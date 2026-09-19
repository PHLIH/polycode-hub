// 移植自 Go internal/projects/process.go + process_unix.go + process_windows.go。
// 跨平台进程处理：detach 启动（posix setsid / windows 新进程组）、进程组终止、
// 端口探测与占用者识别。

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readdirSync, writeSync } from 'node:fs'
import { delimiter, dirname } from 'node:path'
import net from 'node:net'

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })

// shellCommand 返回执行 shell 命令用的 shell 与旗标（windows 用 cmd /c）。
export function shellCommand(platform: string = process.platform): { shell: string; flag: string } {
  if (platform === 'win32') return { shell: 'cmd', flag: '/c' }
  return { shell: 'sh', flag: '-c' }
}

// 常见工具目录：网关常以 launchd/service 身份运行，继承到的 PATH 极简
// （常见只有 /usr/bin:/bin），npm / node / dsh / cargo 一概找不到。用户被迫
// 在启动命令里手写 `export PATH=/Users/xxx/node/bin:$PATH; npm run dev`——
// 路径写死换台机器就废。这里把标准安装位置补进去，命令即可写成语义化的
// `npm run dev`。放在 PATH 末尾（追加不抢占），不覆盖用户自己的优先级。
function fallbackPaths(): string[] {
  if (process.platform === 'win32') return []
  const home = process.env.HOME || ''
  const out = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']
  if (home) {
    out.push(`${home}/.local/bin`, `${home}/.bun/bin`, `${home}/.cargo/bin`)
    // nvm 装的 node：取最新一个版本目录
    try {
      const base = `${home}/.nvm/versions/node`
      const vs = readdirSync(base).sort()
      const last = vs[vs.length - 1]
      if (last) out.push(`${base}/${last}/bin`)
    } catch { /* 没装 nvm */ }
  }
  // 网关自己 node 所在目录（本项目按 /Projects/node/bin 这类非标准路径装的）
  const exeDir = dirname(process.execPath)
  if (exeDir) out.push(exeDir)
  return out
}

// augmentedPath 把 fallbackPaths 追加到当前 PATH 之后（去重，保持原顺序优先）。
//
// 分隔符必须用 path.delimiter（POSIX ':' / Windows ';'），不能写死 ':'。
// 写死 ':' 在 Windows 上会把 `C:\a;C:\b` 按冒号切成 ['C','\a;C','\b']——驱动器
// 盘符里的冒号也被当成分隔符。当前 fallbackPaths() 在 Windows 上返回空数组，
// 切开再拼回去恰好等于原串，所以**症状被掩盖**；一旦给 Windows 补上工具目录，
// 就会产出被切碎的 PATH。这里提前按正确口径写。
export function augmentedPath(base = process.env.PATH || ''): string {
  const parts = base.split(delimiter).filter((p) => p !== '')
  for (const p of fallbackPaths()) {
    if (!parts.includes(p)) parts.push(p)
  }
  return parts.join(delimiter)
}

// startDetached 以 shell 执行 cmd（工作目录 dir、追加环境 env），输出进 logFd，
// 进程脱离网关生命周期（父进程退出不影响子进程）。返回子进程 pid。
export function startDetached(dir: string, shellCmd: string, env: string[], logFd: number): number {
  const { shell, flag } = shellCommand()
  const envObj: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) envObj[k] = v
  }
  envObj['PATH'] = augmentedPath()
  for (const kv of env) {
    const i = kv.indexOf('=')
    if (i > 0) envObj[kv.slice(0, i)] = kv.slice(i + 1)
  }
  // spawn 会**同步抛错**（cwd 不存在 → ENOENT），此时下面的 closeSync 根本执行不到，
  // logFd 就泄漏了（反复启动失败会累积 fd）。用 try/finally 保证任何路径都关掉。
  let child: ChildProcess
  try {
    child = spawn(shell, [flag, shellCmd], {
      cwd: dir,
      env: envObj,
      // detached：posix 新会话（setsid，子进程成为组长，整组可杀）。
      //
      // Windows 上**必须**关掉它：Node 的 detached 在 Windows 上是给子进程
      // 「自己的控制台窗口」（CREATE_NEW_CONSOLE），而默认终端被设成 Windows
      // Terminal 的机器会把新控制台接管走（console handoff），窗口标题就是那条
      // 命令行；紧接着的 taskkill /T /F 让 handoff 管道提前关闭，WT 便弹
      // `错误 2147942632 (0x800700e8) (启动 "<命令行>" 时)`——每起一次服务弹一次。
      // 实测（cmd /c ping -n 30）：detached:true → 新建 conhost + OpenConsole 接管；
      // detached:false + windowsHide:true → 连控制台都不建，全程无窗口、无弹窗。
      // Windows 上不需要靠 detached「脱离父进程」：父进程退出不会杀子进程
      // （Node 不建 Job Object），而 killTree 走 taskkill /PID /T，也不依赖进程组。
      detached: process.platform !== 'win32',
      stdio: ['ignore', logFd, logFd],
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    })
  } finally {
    try { closeSync(logFd) } catch { /* 已关闭 */ } // 子进程已复制 fd
  }
  child.unref()
  child.on('error', () => { /* 启动失败由 pid 探活兜底 */ })
  return child.pid ?? 0
}

// openLog 追加模式打开日志文件，写一行启动分隔，返回 fd（由 startDetached 关闭）。
export function openLog(path: string, now: () => Date = () => new Date()): number {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const fd = openSync(path, 'a', 0o600)
  const d = now()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  writeSync(fd, `\n—— ${ts} 启动 ——\n`)
  return fd
}

// pidAlive 报告 pid 是否存活（信号 0 探测；仅本用户进程可见，EPERM 视为存活）。
export function pidAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function trySignal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig)
    return true
  } catch {
    return false
  }
}

// killTree 终止进程（posix）。windows 用 taskkill /T /F（无优雅宽限语义）。
//
// group 参数区分两种 pid 语义，**不能混**：
//   · group=true  —— pid 来自 startDetached（detached:true，子进程 setsid 成为组长），
//                    发 -pid 能覆盖它拉起的整棵进程树（npm start 底下的 node 等）。
//   · group=false —— pid 是「认领」来的外部进程（claimPortOwner 只保证
//                    「端口上恰好一个监听者 + cwd 匹配」，**不保证它是组长**）。
//                    对非组长 pid 发 kill(-pid) 会打向**它的整个进程组**，
//                    可能是网关自己的组或用户的 shell 组 → 误杀一大片。
// 宽限 graceMs 后仍存活则 KILL（同样遵守 group 语义）。
export async function killTree(pid: number, graceMs = 5000, group = true): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10_000 }, () => resolve())
    })
    return
  }
  if (!pidAlive(pid)) return
  trySignal(pid, 'SIGTERM')
  if (group) trySignal(-pid, 'SIGTERM') // 负 pid = 整个进程组（仅限自启的组长）
  const deadline = Date.now() + graceMs
  while (pidAlive(pid) && Date.now() < deadline) {
    await sleep(100)
  }
  if (pidAlive(pid)) {
    if (group) trySignal(-pid, 'SIGKILL')
    trySignal(pid, 'SIGKILL')
  }
}

// portBusy 探测 127.0.0.1:port 是否被监听。
//
// 非法端口必须先挡掉：net.connect 对 <0 / >65535 / 小数 / NaN 会同步抛
// ERR_SOCKET_BAD_PORT，而 Promise 构造器里的同步抛错会变成 **rejection**。
// 而调用方全都没有 catch（manager.viewOf / startService / freePort / killPort），
// 于是 projects.json 里一个 port:70000 就能让整个项目列表 500。
// 字符串 '8080' 更阴险：不抛错，但 net.connect 把它当 0 处理 → 静默返回 false，
// 端口冲突检测完全失效（服务被判为「端口未就绪」且检测不到占用）。
// 这里统一按「非法端口 = 不是可用端口 = 不忙」处理，并保证只 resolve 不 reject。
export function portBusy(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return Promise.resolve(false)
  return new Promise((resolve) => {
    let socket: net.Socket
    try {
      socket = net.connect({ host: '127.0.0.1', port })
    } catch {
      resolve(false) // 兜底：任何同步抛错都不许逃逸成 rejection
      return
    }
    const done = (busy: boolean): void => {
      socket.destroy()
      resolve(busy)
    }
    socket.setTimeout(500)
    socket.once('connect', () => { done(true) })
    socket.once('timeout', () => { done(false) })
    socket.once('error', () => { done(false) })
  })
}

// freePort 返回从 start 起首个空闲端口（最多试 100 个）。
export async function freePort(start: number): Promise<number> {
  for (let p = start; p < start + 100; p++) {
    if (!(await portBusy(p))) return p
  }
  return start
}

// portOwner 返回占用 port 的进程描述，查不到返回空。
// darwin/linux 用 lsof；windows 用 netstat+tasklist。
export async function portOwner(port: number): Promise<string> {
  if (process.platform === 'win32') {
    const out = await execFileText('netstat', ['-ano', '-p', 'tcp'])
    if (out === '') return ''
    return netstatOwner(out, port)
  }
  const out = await execFileText('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'])
  if (out === '') return ''
  // 首行是表头，第二行起是进程；返回 "pid 名字"（lsof：f[1] 是 PID，f[0] 是 COMMAND）
  for (const line of out.trim().split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f.length >= 2 && f[0] !== undefined && f[1] !== undefined) {
      return `${f[1]} ${f[0]}`
    }
  }
  return ''
}

// netstatPid 从 netstat -ano 输出找监听 port 的 pid（找不到返回空）。
function netstatPid(out: string, port: number): string {
  const suffix = ':' + String(port)
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length >= 5 && f[1] !== 'Local' && (f[1] ?? '').endsWith(suffix) &&
        (f[3] ?? '').toLowerCase() === 'listening') {
      return f[4] ?? ''
    }
  }
  return ''
}

// portPids 返回监听 port 的进程 pid 列表（去重；查不到返回空）。
// darwin/linux 用 lsof -t；windows 用 netstat 解析。
export async function portPids(port: number): Promise<number[]> {
  if (process.platform === 'win32') {
    const out = await execFileText('netstat', ['-ano', '-p', 'tcp'])
    if (out === '') return []
    const pid = netstatPid(out, port)
    return pid === '' ? [] : [Number(pid)]
  }
  const out = await execFileText('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
  if (out === '') return []
  const pids: number[] = []
  for (const line of out.trim().split('\n')) {
    const n = Number(line.trim())
    if (Number.isInteger(n) && n > 0 && !pids.includes(n)) pids.push(n)
  }
  return pids
}

// processCmdline 读某个进程的完整命令行（用于判断"这个端口占用者是不是我们自己"）。
// 拿不到（权限/进程已退出/平台不支持）返回空串——调用方按"不认识"处理，绝不猜。
export async function processCmdline(pid: number): Promise<string> {
  if (pid <= 0) return ''
  if (process.platform === 'win32') {
    // wmic 在新版 Windows 已移除，用 PowerShell 的 CIM 查询代替。
    const out = await execFileText('powershell', [
      '-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ])
    return out.trim()
  }
  const out = await execFileText('ps', ['-o', 'command=', '-p', String(pid)])
  return out.trim()
}

// processCwd 读进程的工作目录（认领判据的关键输入：服务配了 dir，进程就在那里跑）。
// 拿不到返回空串。macOS/Linux 用 lsof；Windows 无对应能力，返回空。
export async function processCwd(pid: number): Promise<string> {
  if (pid <= 0 || process.platform === 'win32') return ''
  const out = await execFileText('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
  for (const line of out.split('\n')) {
    if (line.startsWith('n/')) return line.slice(1).trim()
  }
  return ''
}

export interface PortKillResult {
  killed: number[] // 实际停掉的 pid
  owner: string // 占用者描述（portOwner 口径，供前端提示）
  busy: boolean // 停完后端口是否仍被占用（有新进程抢占会是 true）
}

// killPort 停掉监听 port 的外部进程（TERM 等 3s 再 KILL）。
// 自保：pid 含网关自身时跳过自身；全是自身 → 抛错（杀网关等于自杀）。
// 端口空闲 / 查不到占用者 / 无权限时抛错，由 API 层转 4xx/5xx。
export async function killPort(port: number): Promise<PortKillResult> {
  const pids = await portPids(port)
  if (pids.length === 0) {
    if (await portBusy(port)) {
      throw new Error(`端口 ${port} 被占用但查不到占用进程（可能权限不足或非 TCP 监听）`)
    }
    throw new Error(`端口 ${port} 未被占用`)
  }
  const targets = pids.filter((p) => p !== process.pid)
  if (targets.length === 0) {
    throw new Error(`端口 ${port} 由网关自身占用，不能停`)
  }
  const owner = await portOwner(port)
  for (const pid of targets) {
    await killPid(pid)
  }
  return { killed: targets, owner, busy: await portBusy(port) }
}

// killPid 停掉单个外部 pid（非本管理器启动的进程，没有进程组记账，只杀本体）。
async function killPid(pid: number, graceMs = 3000): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10_000 }, () => resolve())
    })
    return
  }
  if (!pidAlive(pid)) return
  if (!trySignal(pid, 'SIGTERM')) {
    if (pidAlive(pid)) throw new Error(`无权限停掉进程 ${pid}（与网关不是同一用户）`)
    return
  }
  const deadline = Date.now() + graceMs
  while (pidAlive(pid) && Date.now() < deadline) {
    await sleep(100)
  }
  if (pidAlive(pid)) trySignal(pid, 'SIGKILL')
}

// netstatOwner 从 netstat -ano 输出找 LISTENING 行的 pid，再查进程名。
//
// 查名失败时**必须**退化成裸 pid：tasklist 在非 Windows 上不存在（execFileText
// 返回空串 → 直接退化），而 Windows 上查不到进程时会打印一条**本地化**提示
// （英文 "INFO: No tasks are running which match..."、中文「信息: 没有运行的
// 任务匹配指定标准。」），且不一定走非零退出码，所以既不能靠 err 判断，也不能
// 靠匹配字面量 'INFO:'——中文环境下那条提示会被整句当成进程名回给用户。
// 判据改为「真正的 CSV 行一定以引号开头」，与语言无关。
export async function netstatOwner(out: string, port: number): Promise<string> {
  const pid = netstatPid(out, port)
  if (pid === '') return ''
  const csv = await execFileText('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
  const trimmed = csv.trim()
  if (trimmed.startsWith('"')) {
    const parts = trimmed.split(`","`)
    const n = (parts[0] ?? '').replace(/^"/, '')
    if (n !== '') return `${n}(${pid})`
  }
  return pid
}

// execFileText 执行命令取 stdout；任何失败（含命令不存在）返回空串。
function execFileText(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
      resolve(err ? '' : stdout)
    })
  })
}
