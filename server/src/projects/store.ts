// 本地项目管理器：手动录入项目/服务，一键启停、端口冲突检测
// 与经用户同意的端口映射、最长运行时长自动关闭。与代理链路完全解耦。
// 移植自 Go internal/projects/store.go。

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

// Service 是项目内一个可启动的服务（如前端、后端）。
export interface Service {
  name: string
  dir: string
  cmd: string
  port: number // 0 = 非网络服务，跳过端口检测
  portEnv?: string // 端口映射方式（环境变量名）；缺省 = 端口写死
  maxRuntimeHours?: number // 0/缺省 = 不自动关闭
}

// Project 是一张卡片。
export interface Project {
  id: string
  name: string
  services: Service[]
}

// ServiceState 是一个服务的运行时状态（与定义分离，可随时清）。
export interface ServiceState {
  pid: number
  startedAt: string // ISO 时间戳
  portOverride?: number // 用户同意映射后的实际端口，缺省 = 未映射
  autoStopped?: boolean
  exitNote?: string
}

// newID 生成 p- 前缀随机 ID。
export function newID(): string {
  return 'p-' + randomBytes(8).toString('hex')
}

// Store 管定义（projects.json）、运行状态（projects-state.json）与日志目录。
export class Store {
  readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  // 日志文件路径。projectID/service 都会拼进文件名，**必须**先收敛：
  // 这两个值一个来自 URL 路径参数、一个来自 query（projects_app.ts handleLogs），
  // 未净化时 `service=../../../../etc/passwd` 会让 join 直接跳出 logs/ 目录，
  // 落到 /etc/passwd.log——GET 可读任意 .log，DELETE 更会把它 truncate 成 0 字节。
  // 收敛口径与 newID() 一致（只留 [A-Za-z0-9._-]），并把连续点折成单点，
  // 避免 ".." 这类看着像上级目录的名字（同 adminapi/credentialPathFor 的做法）。
  // 收敛后仍做一次「必须留在 logs/ 内」的断言，防将来有人改坏上面的字符集。
  logPath(projectID: string, service: string): string {
    const safe = (s: string): string =>
      s.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '')
    const logsDir = resolve(this.dir, 'logs')
    const file = resolve(logsDir, `${safe(projectID)}-${safe(service)}.log`)
    // 兜底断言：收敛逻辑若被改坏，这里宁可报错也不要读/删到目录外的文件。
    if (!file.startsWith(logsDir + sep)) {
      throw new Error(`projects: 非法日志路径 id=${projectID} service=${service}`)
    }
    return file
  }

  // load 读定义。文件缺失 → 空表（不报错）；损坏 → 报错
  // （不能静默当空表：后续 save 会把用户的定义覆盖掉）。
  load(): Project[] {
    let raw: string
    try {
      raw = readFileSync(this.projectsFile(), 'utf8')
    } catch {
      return [] // 不存在 = 空
    }
    let v: unknown
    try {
      v = JSON.parse(raw)
    } catch (e) {
      throw new Error(`projects: ${basename(this.projectsFile())} 解析失败: ${(e as Error).message}`)
    }
    if (!Array.isArray(v)) {
      throw new Error(`projects: ${basename(this.projectsFile())} 解析失败: 须为数组`)
    }
    return v as Project[]
  }

  // save 写定义（临时文件 + rename，防半写）。
  save(ps: Project[]): void {
    writeJSON(this.projectsFile(), ps)
  }

  // loadState 读运行状态。缺失/损坏 → 空表（与 Go 一致：状态损坏可容忍，
  // 只影响运行时记账，不影响用户数据）。
  loadState(): Map<string, ServiceState> {
    let v: unknown
    try {
      v = JSON.parse(readFileSync(this.stateFile(), 'utf8'))
    } catch {
      return new Map()
    }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return new Map()
    return new Map(Object.entries(v as Record<string, ServiceState>))
  }

  // saveState 写运行状态。
  saveState(m: Map<string, ServiceState>): void {
    writeJSON(this.stateFile(), Object.fromEntries(m))
  }

  private projectsFile(): string {
    return join(this.dir, 'projects.json')
  }

  private stateFile(): string {
    return join(this.dir, 'projects-state.json')
  }
}

function writeJSON(path: string, v: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
}
