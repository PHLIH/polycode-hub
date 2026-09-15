// 移植锚点：internal/projects/store_test.go / process_test.go / manager_test.go
// 进程 supervision 用 node/sh 真实短命/长驻子进程验证；afterAll 统一清理不留孤儿。

import { afterAll, describe, expect, test, vi } from 'vitest'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type AddressInfo } from 'node:net'
import { spawn } from 'node:child_process'
import { Store, newID, type Project, type Service } from '../src/projects/store.ts'
import { validateProject } from '../src/adminapi/projects_app.ts'
import { Manager, isConflictError } from '../src/projects/manager.ts'
import {
  augmentedPath,
  freePort,
  killPort,
  killTree,
  netstatOwner,
  pidAlive,
  portBusy,
  portOwner,
  portPids,
  shellCommand,
  startDetached,
} from '../src/projects/process.ts'

const makeTemp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })

// 占住 127.0.0.1 随机端口
async function listenRandom(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  return { server, port }
}

// 造一个确定已死的 pid
async function deadPid(): Promise<number> {
  const c = spawn('true')
  await new Promise<void>((resolve) => { c.on('close', () => resolve()) })
  return c.pid ?? 0
}

// —— Store（store_test.go）

describe('Store 定义/状态持久化', () => {
  test('round-trip（含中文名与全部服务字段）', () => {
    const dir = makeTemp('polycode-pstore-')
    try {
      const s = new Store(dir)
      const input: Project[] = [{
        id: 'p-ab12cd34',
        name: '博客',
        services: [{
          name: 'backend', dir: '/tmp/b/server', cmd: 'npm run dev',
          port: 3000, portEnv: 'PORT', maxRuntimeHours: 8,
        }],
      }]
      s.save(input)
      const got = s.load()
      expect(got.length).toBe(1)
      expect(got[0]?.id).toBe('p-ab12cd34')
      expect(got[0]?.name).toBe('博客')
      const svc = got[0]?.services[0]
      expect(svc?.port).toBe(3000)
      expect(svc?.portEnv).toBe('PORT')
      expect(svc?.maxRuntimeHours).toBe(8)
      expect(svc?.cmd).toBe('npm run dev')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('缺失容错 / 损坏报错', () => {
    const dir = makeTemp('polycode-pstore2-')
    try {
      const s = new Store(dir)
      expect(s.load()).toEqual([]) // 缺失 → 空表
      writeFileSync(join(dir, 'projects.json'), '{garbage', { mode: 0o600 })
      expect(() => s.load()).toThrow(/解析失败/) // 损坏 → 报错（防静默覆盖用户定义）
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('状态 round-trip（pid/startedAt/portOverride）', () => {
    const dir = makeTemp('polycode-pstore3-')
    try {
      const s = new Store(dir)
      const started = new Date('2026-09-13T08:30:00+08:00')
      const input = new Map([['p-1/backend', { pid: 123, startedAt: started.toISOString(), portOverride: 3001 }]])
      s.saveState(input)
      const got = s.loadState()
      expect(got.size).toBe(1)
      expect(got.get('p-1/backend')?.pid).toBe(123)
      expect(got.get('p-1/backend')?.portOverride).toBe(3001)
      expect(got.get('p-1/backend')?.startedAt).toBe(started.toISOString())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('logPath 与 newID', () => {
    const s = new Store(makeTemp('polycode-pstore4-'))
    expect(s.logPath('p-1', 'backend')).toBe(join(s.dir, 'logs', 'p-1-backend.log'))
    const id = newID()
    expect(id.length).toBe('p-'.length + 16)
    expect(id.startsWith('p-')).toBe(true)
    expect(newID()).not.toBe(id)
  })
})

// —— 进程 supervision（process_test.go）

describe('startDetached / killTree', () => {
  test('启动后 pid 存活，killTree 后退出', async () => {
    const dir = makeTemp('polycode-plife-')
    try {
      const fd = openSync(join(dir, 'out.log'), 'a')
      const pid = startDetached(dir, 'sleep 30', [], fd)
      expect(pid).toBeGreaterThan(0)
      expect(pidAlive(pid)).toBe(true)
      await killTree(pid)
      await vi.waitUntil(() => !pidAlive(pid), { timeout: 6000, interval: 50 })
      expect(pidAlive(pid)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  test('走 shell -c：工作目录 + env 注入 + shell 语法', async () => {
    const dir = makeTemp('polycode-penv-')
    try {
      const fd = openSync(join(dir, 'out.log'), 'a')
      const pid = startDetached(dir, 'pwd > out2.log; echo $FOO >> out2.log', ['FOO=bar42'], fd)
      await vi.waitUntil(() => {
        try { return readFileSync(join(dir, 'out2.log'), 'utf8').length > 0 } catch { return false }
      }, { timeout: 5000, interval: 50 })
      // macOS 的 tmp 在 /private/var 下
      const real = realpathSync(dir)
      expect(readFileSync(join(dir, 'out2.log'), 'utf8')).toBe(real + '\nbar42\n')
      await killTree(pid)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  test('pidAlive 对死 pid / 非法 pid 为 false', async () => {
    expect(pidAlive(0)).toBe(false)
    expect(pidAlive(-1)).toBe(false)
    expect(pidAlive(await deadPid())).toBe(false)
  })

  test('shellCommand 平台分支', () => {
    expect(shellCommand('win32')).toEqual({ shell: 'cmd', flag: '/c' })
    expect(shellCommand('linux')).toEqual({ shell: 'sh', flag: '-c' })
    expect(shellCommand('darwin')).toEqual({ shell: 'sh', flag: '-c' })
  })

  // 回归：网关以 launchd/service 身份运行时继承到的 PATH 极简（常只有
  // /usr/bin:/bin），npm/node/dsh 全部找不到，用户被迫在命令里手写
  // `export PATH=/Users/xxx/node/bin:$PATH; npm run dev`。augmentedPath 必须
  // 把标准安装位置补回来，且不抢占用户已有顺序。
  test('augmentedPath 补全工具目录且不抢占原有顺序', () => {
    const p = augmentedPath('/usr/bin:/bin')
    const parts = p.split(':')
    // 原有条目顺序不变、仍在最前
    expect(parts.slice(0, 2)).toEqual(['/usr/bin', '/bin'])
    // 常见安装位置被补进来
    expect(parts.length).toBeGreaterThan(2)
    if (process.platform !== 'win32') {
      expect(parts).toContain('/opt/homebrew/bin')
      expect(parts).toContain('/usr/local/bin')
      const home = process.env.HOME
      if (home) expect(parts).toContain(`${home}/.local/bin`)
    }
    // 去重：重复调用/重复给同一目录不产生重复项
    expect(new Set(parts).size).toBe(parts.length)
    expect(augmentedPath(p)).toBe(p)
  })

  // 回归：dir 留空不再报「未配置工作目录」，回落到进程 cwd。
  // 强制三填会逼用户填 "-" 这种假占位符，比留空更糟。
  test('dir 留空 = 进程 cwd，不再拒绝启动', async () => {
    const dir = makeTemp('polycode-pcwd-')
    try {
      const store = new Store(dir)
      const p: Project = {
        id: newID(), name: 'cwd-proj',
        // dir 故意留空 + cmd 输出 cwd 到日志
        services: [{ name: 'svc', dir: '', cmd: 'pwd', port: 0 }],
      }
      store.save([p])
      const m = new Manager(store)
      const conflict = await m.startService(p.id, 'svc', 0)
      expect(conflict).toBeNull()
      const log = store.logPath(p.id, 'svc')
      await vi.waitUntil(() => {
        try { return readFileSync(log, 'utf8').includes('/') } catch { return false }
      }, { timeout: 5000, interval: 50 })
      expect(readFileSync(log, 'utf8')).toContain(process.cwd())
      await m.stopService(p.id, 'svc')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  // 回归：dir 显式填了却不存在 → 仍然报错（留空合法 ≠ 乱填合法）
  test('dir 填了但不存在仍报错', async () => {
    const dir = makeTemp('polycode-pbad-')
    try {
      const store = new Store(dir)
      const p: Project = {
        id: newID(), name: 'bad-proj',
        services: [{ name: 'svc', dir: join(dir, 'nope'), cmd: 'echo hi', port: 0 }],
      }
      store.save([p])
      const m = new Manager(store)
      await expect(m.startService(p.id, 'svc', 0)).rejects.toThrow(/工作目录不可用/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})

describe('端口探测', () => {
  test('PortBusy / FreePort', async () => {
    const { server, port } = await listenRandom()
    try {
      expect(await portBusy(port)).toBe(true)
      const free = await freePort(port + 1)
      expect(await portBusy(free)).toBe(false)
      expect(await freePort(port)).toBeGreaterThan(port) // 跳过被占端口
    } finally {
      server.close()
    }
  })

  test('PortOwner 找到监听者（lsof）', async () => {
    const { server, port } = await listenRandom()
    try {
      const owner = await portOwner(port)
      expect(owner).not.toBe('')
    } finally {
      server.close()
    }
  })

  test('netstatOwner 纯解析（windows 分支单元级）', async () => {
    const out = '  Proto  Local Address          Foreign Address        State           PID\n' +
      '  TCP    127.0.0.1:12345        0.0.0.0:0              LISTENING       4321\n'
    // tasklist 在 darwin 上不存在 → 退化返回 pid（与 Go 行为一致）
    expect(await netstatOwner(out, 12345)).toBe('4321')
    expect(await netstatOwner(out, 9999)).toBe('')
  })

  test('portPids 找到监听者；killPort 空闲端口抛错', async () => {
    const { server, port } = await listenRandom()
    try {
      const pids = await portPids(port)
      expect(pids.length).toBeGreaterThan(0)
      expect(pids.every((p) => Number.isInteger(p) && p > 0)).toBe(true)
      // 空闲端口杀不得：明确抛「未被占用」
      const free = await freePort(port + 1)
      await expect(killPort(free)).rejects.toThrow(/未被占用/)
    } finally {
      server.close()
    }
  })

  test('killPort 停掉外部监听进程（真杀）', async () => {
    // 另起子进程监听随机端口：killPort 要能停掉它（不是杀测试进程自己）
    const child = spawn(process.execPath, ['-e',
      `require("net").createServer().listen(0,"127.0.0.1",function(){console.log(this.address().port)})`],
      { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    const port: number = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('子进程未上报端口')), 5000)
      child.stdout!.on('data', (d: Buffer) => {
        out += d.toString()
        const n = Number(out.trim().split('\n').pop())
        if (Number.isInteger(n) && n > 0) { clearTimeout(t); resolve(n) }
      })
    })
    try {
      expect(await portBusy(port)).toBe(true)
      const r = await killPort(port)
      expect(r.killed.length).toBeGreaterThan(0)
      expect(r.killed).not.toContain(process.pid)
      await vi.waitUntil(async () => !(await portBusy(port)), { timeout: 5000, interval: 50 })
    } finally {
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
    }
  }, 15_000)
})

// —— Manager 启停编排（manager_test.go）

const managers: Manager[] = []
function newTestManager(): Manager {
  const m = new Manager(new Store(makeTemp('polycode-pmgr-')))
  managers.push(m)
  return m
}
function addProject(m: Manager, svc: Service): string {
  const p: Project = { id: newID(), name: '测试项目', services: [svc] }
  m.store.save([p])
  return p.id
}

afterAll(async () => {
  // 确保不留孤儿进程
  for (const m of managers) {
    for (const st of m.state.values()) {
      if (st.pid > 0 && pidAlive(st.pid)) await killTree(st.pid)
    }
  }
})

describe('Manager 服务启停', () => {
  test('StartService → Running → StopService 清状态', async () => {
    const m = newTestManager()
    const id = addProject(m, { name: 'sleeper', dir: makeTemp('polycode-pmgrd-'), cmd: 'sleep 30', port: 0 })
    expect(await m.startService(id, 'sleeper', 0)).toBeNull()
    const v = await m.view(id, 'sleeper')
    expect(v?.running).toBe(true)
    expect((v?.pid ?? 0) > 0).toBe(true)
    expect(v?.uptime).not.toBe('')

    await m.stopService(id, 'sleeper')
    expect((await m.view(id, 'sleeper'))?.running).toBe(false)
    expect(m.state.has(id + '/sleeper')).toBe(false)
  }, 15_000)

  test('重复启动报「已在运行」', async () => {
    const m = newTestManager()
    const id = addProject(m, { name: 's', dir: makeTemp('polycode-pmgrd2-'), cmd: 'sleep 30', port: 0 })
    await m.startService(id, 's', 0)
    await expect(m.startService(id, 's', 0)).rejects.toThrow(/已在运行/)
    await m.stopService(id, 's')
  }, 15_000)

  test('端口被占 → ConflictError{Port, Remappable, Suggested>taken}；同意映射后记账', async () => {
    const m = newTestManager()
    const { server, port: taken } = await listenRandom()
    try {
      const id = addProject(m, {
        name: 'env-svc', dir: makeTemp('polycode-pmgrd3-'), cmd: 'sleep 30', port: taken, portEnv: 'TEST_PORT',
      })
      const err = await m.startService(id, 'env-svc', 0)
      expect(isConflictError(err)).toBe(true)
      if (!isConflictError(err)) throw new Error('expected ConflictError')
      expect(err.port).toBe(taken)
      expect(err.remappable).toBe(true)
      expect(err.suggested).toBeGreaterThan(taken)
      expect(err.message).toContain(`端口 ${taken} 已被占用`)
      server.close()

      // 用户同意映射 → 带 override 启动成功，PortOverride 记账
      expect(await m.startService(id, 'env-svc', err.suggested)).toBeNull()
      const v = await m.view(id, 'env-svc')
      expect(v?.running || v?.starting).toBe(true)
      expect(v?.portOverride).toBe(err.suggested)
      await m.stopService(id, 'env-svc')
    } finally {
      server.close()
    }
  }, 15_000)

  test('未声明 portEnv → Remappable=false', async () => {
    const m = newTestManager()
    const { server, port: taken } = await listenRandom()
    try {
      const id = addProject(m, { name: 'fixed', dir: makeTemp('polycode-pmgrd4-'), cmd: 'sleep 30', port: taken })
      const err = await m.startService(id, 'fixed', 0)
      expect(isConflictError(err)).toBe(true)
      if (isConflictError(err)) expect(err.remappable).toBe(false)
    } finally {
      server.close()
    }
  })

  test('RestartService 换 pid', async () => {
    const m = newTestManager()
    const id = addProject(m, { name: 's', dir: makeTemp('polycode-pmgrd5-'), cmd: 'sleep 30', port: 0 })
    await m.startService(id, 's', 0)
    const oldPid = (await m.view(id, 's'))?.pid
    expect(await m.restartService(id, 's')).toBeNull()
    const v = await m.view(id, 's')
    expect(v?.running).toBe(true)
    expect(v?.pid).not.toBe(oldPid)
    await m.stopService(id, 's')
  }, 20_000)

  test('Sweep：超时自动停（pid 清零留便签）', async () => {
    const m = newTestManager()
    const id = addProject(m, {
      name: 'exp', dir: makeTemp('polycode-pmgrd6-'), cmd: 'sleep 30', port: 0, maxRuntimeHours: 1,
    })
    await m.startService(id, 'exp', 0)
    const key = id + '/exp'
    // 把 StartedAt 拨回 2 小时前
    const st = m.state.get(key)
    if (st) { st.startedAt = new Date(Date.now() - 2 * 3600e3).toISOString(); m.state.set(key, st) }
    await m.sweep()
    const v = await m.view(id, 'exp')
    expect(v?.running).toBe(false)
    expect(v?.autoStopped).toBe(true)
    expect(v?.exitNote).toContain('已自动关闭')
    expect(m.state.get(key)?.pid ?? 0).toBe(0)
  }, 15_000)

  test('Sweep：死进程清 pid 留退出说明', async () => {
    const m = newTestManager()
    const id = addProject(m, { name: 'dead', dir: makeTemp('polycode-pmgrd7-'), cmd: 'true', port: 0 })
    await m.startService(id, 'dead', 0)
    const key = id + '/dead'
    const pid = m.state.get(key)?.pid ?? 0
    await vi.waitUntil(() => !pidAlive(pid), { timeout: 5000, interval: 50 })
    await m.sweep()
    const v = await m.view(id, 'dead')
    expect(v?.running).toBe(false)
    expect(v?.exitNote).toBe('进程已退出')
  }, 15_000)

  test('Reminders：未设上限但连跑超阈值进提醒', async () => {
    const m = newTestManager()
    const id = addProject(m, { name: 'longrun', dir: makeTemp('polycode-pmgrd8-'), cmd: 'sleep 30', port: 0 })
    await m.startService(id, 'longrun', 0)
    expect(await m.reminders(24 * 3600e3)).toEqual([])
    const key = id + '/longrun'
    const st = m.state.get(key)
    if (st) { st.startedAt = new Date(Date.now() - 25 * 3600e3).toISOString(); m.state.set(key, st) }
    const got = await m.reminders(24 * 3600e3)
    expect(got.length).toBe(1)
    expect(got[0]?.id).toBe(id)
    await m.stopService(id, 'longrun')
  }, 15_000)

  test('StartProject 收集冲突但不阻断其余服务；StopProject 全停', async () => {
    const m = newTestManager()
    const { server, port: taken } = await listenRandom()
    try {
      const p: Project = {
        id: newID(), name: '多服务', services: [
          { name: 'a', dir: makeTemp('polycode-pmgrd9a-'), cmd: 'sleep 30', port: 0 },
          { name: 'b', dir: makeTemp('polycode-pmgrd9b-'), cmd: 'sleep 30', port: taken },
        ],
      }
      m.store.save([p])
      const cfs = await m.startProject(p.id)
      expect(cfs.length).toBe(1)
      expect(cfs[0]?.port).toBe(taken)
      expect((await m.view(p.id, 'a'))?.running).toBe(true)
      await m.stopProject(p.id)
      expect(m.state.has(p.id + '/a')).toBe(false)
    } finally {
      server.close()
    }
  }, 20_000)

  test('NewManager 清理孤儿状态（pid 已死的记录）', async () => {
    const dir = makeTemp('polycode-pmgrorphan-')
    try {
      const store = new Store(dir)
      const dead = await deadPid()
      store.saveState(new Map([['p-1/s', { pid: dead, startedAt: new Date().toISOString() }]]))
      const m = new Manager(store)
      expect(m.state.size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('工作目录缺失时报错；日志落盘带启动分隔', async () => {
    const m = newTestManager()
    const id = addProject(m, { name: 'nodir', dir: join(makeTemp('polycode-pmgrd10-'), 'nope'), cmd: 'true', port: 0 })
    await expect(m.startService(id, 'nodir', 0)).rejects.toThrow(/工作目录不可用/)
    // 正常启动写日志分隔
    const dir = makeTemp('polycode-pmgrd11-')
    const id2 = addProject(m, { name: 'logged', dir, cmd: 'true', port: 0 })
    await m.startService(id2, 'logged', 0)
    const log = readFileSync(m.store.logPath(id2, 'logged'), 'utf8')
    expect(log).toContain(' 启动 ——')
    closeSync(openSync(join(dir, 'probe'), 'a')) // dir 仍可写（无害探活）
    expect(existsSync(join(dir, 'probe'))).toBe(true)
  }, 15_000)
})

// 外部占用的服务（非本管理器启动）也要在 UI 上说清楚。
// 背景：用户在终端手起网关（npx tsx … serve），项目页一直显示「未启动」，
// 看起来像服务挂了，实际 3000 端口好好的——只是管理器没记过 pid。
describe('外部占用端口：状态如实反映，不是一句「未启动」', () => {
  test('无 pid 记录但端口被占 → portBusyByOther=true，且不谎报 running', async () => {
    const { server, port } = await listenRandom()
    try {
      const m = newTestManager()
      const id = addProject(m, { name: 'ext', dir: makeTemp('polycode-ext-'), cmd: 'sleep 30', port })
      const v = await m.view(id, 'ext')
      // 关键：不是 running（管理器没启动它，无法停止/重启）
      expect(v?.running).toBe(false)
      // 但要点明端口被别人占着，避免用户以为服务挂了
      expect(v?.portBusyByOther).toBe(true)
    } finally {
      await new Promise<void>((r) => { server.close(() => r()) })
    }
  })

  test('端口空闲且无 pid 记录 → 真的是没启动，不打占用标记', async () => {
    const { server, port } = await listenRandom()
    await new Promise<void>((r) => { server.close(() => r()) })
    await sleep(50) // 等端口释放
    const m = newTestManager()
    const id = addProject(m, { name: 'idle', dir: makeTemp('polycode-idle-'), cmd: 'sleep 30', port })
    const v = await m.view(id, 'idle')
    expect(v?.running).toBe(false)
    expect(v?.portBusyByOther).toBe(false)
  })

  test('自己启动的服务不标为外部占用', async () => {
    const m = newTestManager()
    const id = addProject(m, { name: 'own', dir: makeTemp('polycode-own-'), cmd: 'sleep 30', port: 0 })
    await m.startService(id, 'own', 0)
    const v = await m.view(id, 'own')
    expect(v?.running).toBe(true)
    expect(v?.portBusyByOther).toBe(false)
    await m.stopService(id, 'own')
  }, 15_000)

  test('port=0 的服务不探端口（没有端口可探）', async () => {
    const m = newTestManager()
    const id = addProject(m, { name: 'nop', dir: makeTemp('polycode-nop-'), cmd: 'sleep 30', port: 0 })
    const v = await m.view(id, 'nop')
    expect(v?.portBusyByOther).toBe(false)
  })
})

// —— 定义校验（放宽后：只拦真跑不起来的）——
// 回归背景：原先强制 name+dir+cmd 三填，用户为了过校验把 dir 填成 "-"
// 这种假占位符，比留空更糟。现在只强制项目名、至少一个服务、服务名非空且唯一。
describe('validateProject', () => {
  const svc = (o: Partial<Service> = {}): Service => ({ name: 'svc', dir: '', cmd: 'echo hi', port: 0, ...o })
  const proj = (o: Partial<Project> = {}): Project => ({ id: 'p-1', name: 'proj', services: [svc()], ...o })

  test('合法：dir 留空通过（不再要求三填）', () => {
    expect(validateProject(proj())).toBeUndefined()
  })

  test('项目名为空 → 报错', () => {
    expect(validateProject(proj({ name: '' }))).toMatch(/项目名/)
  })

  test('没有服务 → 报错', () => {
    expect(validateProject(proj({ services: [] }))).toMatch(/至少配置一个服务/)
  })

  test('服务名为空 → 报错', () => {
    expect(validateProject(proj({ services: [svc({ name: '' })] }))).toMatch(/服务名不能为空/)
  })

  test('服务名重复 → 报错', () => {
    expect(validateProject(proj({ services: [svc(), svc()] }))).toMatch(/服务名重复/)
  })

  test('cmd 留空放行到启动时才拦（校验不越权替运行期判断）', () => {
    expect(validateProject(proj({ services: [svc({ cmd: '' })] }))).toBeUndefined()
  })
})
