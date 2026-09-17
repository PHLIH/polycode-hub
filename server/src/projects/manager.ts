// serviceSignatures 从服务定义里提取「命令行特征串」，用于认出外部拉起的同一服务。
//
// 取启动命令里够具体的片段（脚本路径 / 入口文件），而不是整个命令：
// 实际命令行往往被包了一层（`node --require .../preflight.cjs ... server/src/cli.ts serve`），
// 整串比不可能相等。太短的串（如 `npm`）会撞名，所以少于 4 字符的片段丢弃。
// sameDir 判两个目录是否同一个，先各自 realpath 消掉符号链接差异。
// realpath 失败（路径不存在等）退回字面量比较。
function sameDir(a: string, b: string): boolean {
  const ra = realpathOr(a)
  const rb = realpathOr(b)
  return ra === rb
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

export function serviceSignatures(s: Service): string[] {
  const out = new Set<string>()
  const cmd = (s.cmd ?? '').trim()
  if (cmd !== '') {
    for (const part of cmd.split(/\s+/)) {
      // 只收像「文件路径/脚本名」的片段（含 / 或 . 的），跳过 run/start/-p 这类参数
      if (part.length >= 4 && /[./]/.test(part) && !part.startsWith('-')) out.add(part)
    }
  }
  // 服务名本身也收：`npm start` 这类命令没有可辨识路径，只能靠名称兜底
  if (s.name.length >= 4) out.add(s.name)
  return [...out]
}

// Manager 编排服务启停与巡检。移植自 Go internal/projects/manager.go。
// store 里的定义由外部（API 层）增删改。

import { realpathSync, statSync } from 'node:fs'

import { Store, type Project, type Service, type ServiceState } from './store.ts'
import {
  killTree, openLog, pidAlive, portBusy, freePort, portOwner, portPids, processCmdline,
  processCwd, startDetached,
} from './process.ts'

// ConflictError 表示启动因端口被占而中止。remappable=true 时前端应征询
// 用户是否映射到 suggested 端口（仅 portEnv 已声明的服务）。
export class ConflictError extends Error {
  readonly port: number
  readonly owner: string
  readonly suggested: number
  readonly remappable: boolean

  constructor(port: number, owner: string, suggested: number, remappable: boolean) {
    super(`端口 ${port} 已被占用` + (owner !== '' ? `（${owner}）` : ''))
    this.name = 'ConflictError'
    this.port = port
    this.owner = owner
    this.suggested = suggested
    this.remappable = remappable
  }
}

export function isConflictError(e: unknown): e is ConflictError {
  return e instanceof ConflictError
}

// ServiceView = 服务定义 + 实时运行状态（UI 一行）。
export type ServiceView = Service & {
  running: boolean
  starting: boolean // pid 活着但端口还没起来
  pid?: number
  startedAt?: string
  uptime?: string
  portOverride?: number
  autoStopped?: boolean
  exitNote?: string
  // 端口被「非本管理器启动」的进程占着：服务其实在跑（可能是手起的），
  // 但我们没有 pid，停止/重启不了。UI 要说清楚，否则用户看到「未启动」
  // 会以为服务挂了。
  portBusyByOther?: boolean
  // 端口占用者被认出「就是本服务的进程，只是由外部命令（如 update.sh / 手动 npm start）
  // 拉起的」——此时服务确实在跑，且我们可以接管它（拿到 pid 就能停/重启）。
  // 与 portBusyByOther 互斥：认出来就不再是"别人的"。
  adopted?: boolean
}

// ProjectView = 项目定义 + 各服务实时状态（UI 一张卡片）。
export type ProjectView = Project & {
  services: ServiceView[]
}

export interface ManagerOptions {
  // now 可被测试替换（巡检到期判定用）。
  now?: () => Date
}

// Manager 编排服务启停与巡检。
export class Manager {
  readonly store: Store
  // state 运行时状态，key: projectID/serviceName。
  // 公开供测试拨动 StartedAt / afterAll 清理（Go 测试直接触达 m.state，同理）。
  readonly state: Map<string, ServiceState>
  private readonly now: () => Date

  // 装配并清理孤儿状态（pid 已死的记录直接清掉）。
  constructor(store: Store, opts: ManagerOptions = {}) {
    this.store = store
    this.now = opts.now ?? (() => new Date())
    this.state = store.loadState()
    for (const [key, st] of this.state) {
      if (st.pid > 0 && !pidAlive(st.pid)) {
        this.state.delete(key)
      }
    }
    this.saveState()
  }

  private key(projectID: string, service: string): string {
    return `${projectID}/${service}`
  }

  // claimPortOwner 判断「占着端口的那个进程是不是本服务」。
  //
  // 为什么需要它：服务可能不是本管理器拉起的——update.sh 与手动 `npm start` 都用
  // nohup 直接起进程，不写 state。于是管理台既停不掉它（没有 pid），也起不来
  // （端口被占），而占着端口的恰恰是它自己：用户看到「端口被自己占用不能停」。
  //
  // 判据按可靠性排序，任一成立即认领（宁可不认也不误认——误认会让用户停掉无关进程）：
  //   1. 端口上恰好只有一个监听进程（多个 = 情况不明，交回给用户判断）
  //   2. 【主判据】进程 cwd == 服务配置的 dir。这是最可靠的一条：
  //      服务在哪跑是确定的，而命令行会被 npm/tsx/shell 层层包装改形
  //      （`npm start` 实际起的是 `node bin/polycode-hub.mjs serve`，命令行毫无共同片段）。
  //   3. 【兜底】命令行里出现服务特征串（无 dir 可依时用）。
  //
  // 返回认领到的 pid；认不出返回 0。
  private async claimPortOwner(s: Service, port: number): Promise<number> {
    if (port <= 0) return 0
    const pids = await portPids(port)
    if (pids.length !== 1) return 0 // 多个监听者：不猜
    const pid = pids[0]!
    // 注意：pid 完全可能是「管理器自己」——polycode-hub 的管理台就跑在网关进程里，
    // 而那个网关正是它自己项目列表里的一项。这不是异常，恰恰是最需要认出的场景：
    // 用户从 Projects 页看到"端口被占用、停不掉"，占端口的其实是当前这个进程。
    // 认领它（就能显示"运行中·外部启动"），但**停止要单独拦**（见 stopService），
    // 否则点一下「停止」会把正在服务这个请求的进程杀掉。

    const wantDir = (s.dir ?? '').trim()
    if (wantDir !== '' && wantDir !== '-') {
      const cwd = await processCwd(pid)
      // 两边都归一化再比：macOS 的 /tmp、/var 是符号链接，lsof 返回解析后的真实路径
      // （/private/tmp/...），直接用配置里的字面量比会永远不相等。
      if (cwd !== '') return sameDir(cwd, wantDir) ? pid : 0 // 有 dir 就按 dir 判
    }

    // 没有可用 dir：退回命令行特征串（保守，要求命中且是解释器起的）
    const cmd = await processCmdline(pid)
    if (cmd === '') return 0
    const needles = serviceSignatures(s)
    if (needles.length === 0) return 0
    if (!/\b(node|npm|npx|tsx|bun|deno|python|python3|uvicorn|go)\b/.test(cmd)) return 0
    return needles.some((n) => cmd.includes(n)) ? pid : 0
  }

  private saveState(): void {
    try {
      this.store.saveState(this.state)
    } catch (e) {
      console.error('projects: 状态落盘失败:', e)
    }
  }

  // find 定位项目与服务。
  private find(projectID: string, service: string): { project: Project; svc: Service } | null {
    let ps: Project[]
    try {
      ps = this.store.load()
    } catch {
      return null
    }
    for (const p of ps) {
      if (p.id !== projectID) continue
      for (const s of p.services) {
        if (s.name === service) return { project: p, svc: s }
      }
    }
    return null
  }

  // list 返回全部项目的实时视图。
  async list(): Promise<ProjectView[]> {
    let ps: Project[]
    try {
      ps = this.store.load()
    } catch (e) {
      console.error('projects: 载入定义失败:', e)
      return []
    }
    const out: ProjectView[] = []
    for (const p of ps) {
      const services: ServiceView[] = []
      for (const s of p.services) {
        services.push(await this.viewOf(p.id, s))
      }
      out.push({ ...p, services })
    }
    return out
  }

  // view 单服务视图；不存在返回 null。
  async view(projectID: string, service: string): Promise<ServiceView | null> {
    const found = this.find(projectID, service)
    if (!found) return null
    return this.viewOf(projectID, found.svc)
  }

  private async viewOf(projectID: string, s: Service): Promise<ServiceView> {
    const v: ServiceView = { ...s, running: false, starting: false }
    const st = this.state.get(this.key(projectID, s.name))
    if (!st) {
      // 没有 pid 记录 = 不是本管理器启动的。两种可能，必须分开报：
      //   a) 占端口的就是本服务（update.sh / 手动 npm start 拉的）→ 认领它，
      //      这样服务显示"在跑"且能停能重启。否则用户会看到"未启动"却停不掉
      //      ——因为启动时报"端口被自己占用"，陷入死结。
      //   b) 真的是别的进程 → 如实标 portBusyByOther，让用户判断。
      // 只在无 pid 记录时探（有记录时状态已明确，不必为每个服务跑 lsof）。
      if (s.port > 0) {
        const claimed = await this.claimPortOwner(s, s.port)
        if (claimed > 0) {
          v.adopted = true
          v.running = true
          v.pid = claimed
          return v
        }
        v.portBusyByOther = await portBusy(s.port)
      } else {
        v.portBusyByOther = false // 没有端口可探：明确"不适用"，与"探过且没人占"区分开
      }
      return v
    }
    v.pid = st.pid
    v.startedAt = st.startedAt
    v.portBusyByOther = false // 有 pid 记录 = 我们自己起的，不算外部占用
    if (st.portOverride !== undefined) v.portOverride = st.portOverride
    if (st.autoStopped) v.autoStopped = true
    if (st.exitNote !== undefined) v.exitNote = st.exitNote
    if (st.pid <= 0) return v // 自动停止/已退出的便签，只剩标记
    if (!pidAlive(st.pid)) {
      v.exitNote = '进程已退出'
      return v
    }
    const port = st.portOverride ?? 0
    const effective = port !== 0 ? port : s.port
    if (effective > 0 && !(await portBusy(effective))) {
      v.starting = true // 进程在但端口未就绪
    } else {
      v.running = true
      const d = this.now().getTime() - Date.parse(st.startedAt)
      if (d < 60_000) {
        v.uptime = `${Math.floor(d / 1000)}秒`
      } else if (d < 3_600_000) {
        v.uptime = `${Math.floor(d / 60_000)}分钟`
      } else {
        v.uptime = `${(d / 3_600_000).toFixed(1)}小时`
      }
    }
    return v
  }

  // startService 启动单服务。portOverride>0 表示用户已同意映射到该端口。
  // 端口被占且未同意映射 → 返回 ConflictError（API 转 409）；其他错误抛出。
  async startService(projectID: string, service: string, portOverride: number): Promise<ConflictError | null> {
    const found = this.find(projectID, service)
    if (!found) throw new Error('projects: 项目或服务不存在')
    const { svc: s } = found
    const key = this.key(projectID, service)
    const existing = this.state.get(key)
    if (existing && existing.pid > 0 && pidAlive(existing.pid)) {
      throw new Error('projects: 服务已在运行')
    }

    let port = s.port
    if (portOverride > 0) port = portOverride
    if (port > 0 && (await portBusy(port))) {
      // 端口占着，但如果是本服务自己的进程（外部命令拉起的），这不是冲突而是
      // "已经在跑"——报冲突会让用户以为要改端口，其实只需要接管/停止即可。
      const claimed = await this.claimPortOwner(s, port)
      if (claimed > 0) {
        throw new Error('projects: 服务已在运行（由外部命令启动，可直接停止或重启）')
      }
      return new ConflictError(
        port,
        await portOwner(port),
        await freePort(port + 1),
        s.portEnv !== undefined && s.portEnv !== '',
      )
    }
    // dir 缺省 = 网关进程 cwd。留空是合法配置（不强制三填），不是错误；
    // 只有显式填了却不可用才算错。
    const dir = s.dir === '' || s.dir === '-' ? process.cwd() : s.dir
    try {
      statSync(dir)
    } catch {
      throw new Error(`projects: 工作目录不可用: ${s.dir}`)
    }
    const cmd = s.cmd.trim()
    if (cmd === '') throw new Error('projects: 启动命令为空')
    const logFd = openLog(this.store.logPath(projectID, s.name), this.now)

    const env: string[] = []
    if (s.portEnv !== undefined && s.portEnv !== '' && portOverride > 0) {
      env.push(`${s.portEnv}=${portOverride}`)
    }
    const pid = startDetached(dir, cmd, env, logFd)
    this.state.set(key, {
      pid,
      startedAt: this.now().toISOString(),
      ...(portOverride > 0 ? { portOverride } : {}),
    })
    this.saveState()
    return null
  }

  // stopService 停止单服务（未在运行则幂等成功）。
  async stopService(projectID: string, service: string): Promise<void> {
    const key = this.key(projectID, service)
    const st = this.state.get(key)
    let pid = st && st.pid > 0 ? st.pid : 0
    // 自己起的进程是 setsid 组长，可以按进程组杀（连带它的子孙）；
    // 认领来的外部进程不保证是组长，只能杀它自己 —— 否则 kill(-pid) 会打向
    // 它的整个进程组，可能是网关自己的组或用户的 shell 组。
    let ownGroup = pid > 0
    if (pid === 0) {
      // 没有 state = 不是本管理器起的。但占端口的可能就是本服务（外部命令拉的），
      // 认出它才能停——否则这里静默 return，用户看到的是"点了停止没反应"，
      // 而启动又报"端口被自己占用"，彻底卡死。
      const found = this.find(projectID, service)
      if (!found) return
      pid = await this.claimPortOwner(found.svc, found.svc.port)
      if (pid === 0) return
      ownGroup = false
    }
    // 拦「停止自己」：管理台就跑在网关进程里，而网关正是项目列表里的一项。
    // 杀掉自己会让这个请求拿不到响应（用户看到的是请求挂死，不是"已停止"），
    // 而且网关没有守护进程，不会再起来——一次误点等于永久宕机。
    // 想停它请用 ./update.sh（先起新的再切）或在终端操作。
    if (pid === process.pid) {
      throw new Error(
        'projects: 不能从这里停止正在提供管理台的进程本身（会立刻失联且不会自动重启）。'
        + '请用 ./update.sh 重启，或在终端里操作。')
    }
    try {
      await killTree(pid, 5000, ownGroup)
    } catch (e) {
      throw new Error(`projects: 停止失败: ${(e as Error).message}`)
    }
    this.state.delete(key)
    this.saveState()
  }

  // restartService = stop + start（映射需重新征询，冲突语义同 start）。
  async restartService(projectID: string, service: string): Promise<ConflictError | null> {
    await this.stopService(projectID, service)
    return this.startService(projectID, service, 0)
  }

  // startProject 启动项目全部服务，冲突不阻断其余服务的启动。
  async startProject(id: string): Promise<ConflictError[]> {
    let ps: Project[]
    try {
      ps = this.store.load()
    } catch {
      return []
    }
    const conflicts: ConflictError[] = []
    for (const p of ps) {
      if (p.id !== id) continue
      for (const s of p.services) {
        try {
          const c = await this.startService(p.id, s.name, 0)
          if (c !== null) conflicts.push(c)
          // 其他错误（目录缺失等）跳过该服务，UI 展示服务状态即可
        } catch { /* 跳过该服务 */ }
      }
    }
    return conflicts
  }

  // stopProject 停止项目全部服务。
  async stopProject(id: string): Promise<void> {
    const ps = this.store.load()
    for (const p of ps) {
      if (p.id !== id) continue
      for (const s of p.services) {
        await this.stopService(p.id, s.name)
      }
    }
  }

  // sweep 巡检一轮：超时自动停（保留便签标记）、死进程清状态。
  async sweep(): Promise<void> {
    let ps: Project[]
    try {
      ps = this.store.load()
    } catch {
      return
    }
    const now = this.now()
    for (const p of ps) {
      for (const s of p.services) {
        const key = this.key(p.id, s.name)
        const st = this.state.get(key)
        if (!st || st.pid <= 0) continue
        if (!pidAlive(st.pid)) {
          // 正常退出：清掉 pid 留便签，卡片显示「已退出」直到下次启动
          this.state.set(key, { pid: 0, startedAt: st.startedAt, exitNote: '进程已退出' })
          this.saveState()
          continue
        }
        const maxHours = s.maxRuntimeHours ?? 0
        if (maxHours > 0 && now.getTime() - Date.parse(st.startedAt) > maxHours * 3_600_000) {
          try {
            await killTree(st.pid)
          } catch (e) {
            console.error(`projects: 自动停止 ${key} 失败:`, e)
            continue
          }
          // 保留便签（PID 清零）：卡片显示「已自动关闭」直到下次启动
          this.state.set(key, {
            pid: 0,
            startedAt: st.startedAt,
            autoStopped: true,
            exitNote: `已达最长运行 ${maxHours} 小时，已自动关闭`,
          })
          this.saveState()
          console.error(`projects: ${key} 运行超 ${maxHours}h，已自动关闭`)
        }
      }
    }
  }

  // runSweeper 周期巡检，返回取消函数（对齐 Go RunSweeper(ctx, interval)）。
  // cli.ts 用它启动巡检并在退出时取消；定时器已 unref，不会拖住进程退出。
  runSweeper(intervalMs: number): () => void {
    const t = setInterval(() => { void this.sweep() }, intervalMs)
    t.unref?.()
    return () => { clearInterval(t) }
  }

  // reminders 返回「未设上限但已连续运行超阈值」的项目（仅提醒不关闭）。
  async reminders(thresholdMs: number): Promise<ProjectView[]> {
    let ps: Project[]
    try {
      ps = this.store.load()
    } catch {
      return []
    }
    const out: ProjectView[] = []
    for (const p of ps) {
      const services: ServiceView[] = []
      let hit = false
      for (const s of p.services) {
        const v = await this.viewOf(p.id, s)
        const startedAt = v.startedAt !== undefined ? Date.parse(v.startedAt) : NaN
        if ((s.maxRuntimeHours ?? 0) === 0 && v.running && !Number.isNaN(startedAt) &&
            this.now().getTime() - startedAt > thresholdMs) {
          hit = true
        }
        services.push(v)
      }
      if (hit) out.push({ ...p, services })
    }
    return out
  }
}
