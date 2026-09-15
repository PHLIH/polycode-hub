// Manager 编排服务启停与巡检。移植自 Go internal/projects/manager.go。
// store 里的定义由外部（API 层）增删改。

import { statSync } from 'node:fs'

import { Store, type Project, type Service, type ServiceState } from './store.ts'
import { killTree, openLog, pidAlive, portBusy, freePort, portOwner, startDetached } from './process.ts'

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
      // 没有 pid 记录 = 不是我们启动的。但端口可能被别人占着（用户手起的），
      // 此时「未启动」是误导——探一下端口，如实标注。
      // 只在这种情况探：有 pid 时状态已明确，不必为每个服务都跑一次 lsof。
      v.portBusyByOther = s.port > 0 ? await portBusy(s.port) : false
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
    if (!st || st.pid <= 0) return
    try {
      await killTree(st.pid)
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
  runSweeper(intervalMs: number): () => void {
    const t = setInterval(() => { void this.sweep() }, intervalMs)
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
