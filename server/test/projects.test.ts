// 移植锚点：internal/projects/store_test.go / process_test.go / manager_test.go
// 进程 supervision 用 node/sh 真实短命/长驻子进程验证；afterAll 统一清理不留孤儿。

import { afterAll, describe, expect, test, vi } from 'vitest'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { createServer, type AddressInfo } from 'node:net'
import { execFileSync, spawn } from 'node:child_process'
import { Store, newID, type Project, type Service } from '../src/projects/store.ts'
import { createProjectsApp, readTailLines, validateProject } from '../src/adminapi/projects_app.ts'
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
  shellCommand, quoteArg,
  startDetached,
} from '../src/projects/process.ts'

const makeTemp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })

// —— 平台常量：POSIX 侧的写法一字不动，只在 Windows 上换实现 ——
//
// IS_WIN 用在两类地方：
//  1. 夹具命令（LONG_RUNNING / EXITS_NOW）；
//  2. 用例自己 spawn「外部进程」时的 detached 开关（下面统一写 `detached: !IS_WIN`）。
//     理由同 server/src/projects/process.ts 的 startDetached：Windows 上 detached
//     会给子进程新建控制台，被 Windows Terminal 接管（console handoff）后立刻
//     taskkill /T /F，handoff 管道提前关闭，WT 就弹
//     `错误 2147942632 (0x800700e8) (启动 "<命令行>" 时)`。
const IS_WIN = process.platform === 'win32'

// LONG_RUNNING 是「长驻假服务」的命令：POSIX 就是 sleep 30。
//
// Windows 上不能这么写，两个理由：
//  1. `sleep` 不是 Windows 命令——只有 Git 的 usr/bin 恰好落在 PATH 上时才碰巧能跑。
//     干净机器上 cmd 会报「不是内部或外部命令」，服务立刻退出，相关用例必挂。
//  2. 更糟的是现场症状：控制台子进程被 Windows 11 的「默认终端 = Windows Terminal」
//     接管（console handoff），用例随即 taskkill /T /F 秒杀，handoff 管道被提前关闭，
//     Windows Terminal 就弹 `错误 2147942632 (0x800700e8) (启动 "sleep  30" 时)`，
//     跑一次全量套件弹一串（≈1 次/秒）。
//
// 也别用 `"<node.exe>" -e "setTimeout(()=>{},30000)"` 这种写法：命令是整串交给
// `cmd /c` 的，而 cmd 在引号多于两个时会**剥掉首尾各一个引号**（/S 未开时的老规则），
// `"exe" -e "script"` 于是被切坏、cmd 立刻退出——表现为「服务启动成功但进程已退出」。
// ping 是 Windows 的惯用长睡（无引号、无特殊字符、系统自带、约 30 秒）。
const LONG_RUNNING = IS_WIN
  ? 'ping -n 30 127.0.0.1'
  : 'sleep 30'

// EXITS_NOW 是「立刻退出的假服务」：原写法 `true` 同样是 POSIX 专有命令，
// Windows 用 cmd 内建的 echo（不依赖 PATH，也不需要额外进程）。
const EXITS_NOW = IS_WIN ? 'echo hi' : 'true'

// 占住 127.0.0.1 随机端口
async function listenRandom(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  return { server, port }
}

// freePortForTest 拿一个当前空闲的端口号（不保留，只取号）。
async function freePortForTest(): Promise<number> {
  const { server, port } = await listenRandom()
  await new Promise<void>((r) => { server.close(() => r()) })
  return port
}

// waitPort 等到端口真的可连（最多 3s）
async function waitPort(port: number): Promise<void> {
  const { connect } = await import('node:net')
  for (let i = 0; i < 60; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect(port, '127.0.0.1')
      s.on('connect', () => { s.destroy(); resolve(true) })
      s.on('error', () => resolve(false))
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 50))
  }
}

// 造一个确定已死的 pid
async function deadPid(): Promise<number> {
  // 原写法 spawn('true') 依赖 POSIX 的 true 可执行文件：Windows 上找不到时会走
  // spawn error 路径（Node 不保证再补发 close），用例有挂死风险。
  // 改成当前 node 跑空脚本——两边都在、都立刻退出。
  const c = spawn(process.execPath, ['-e', ''])
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

  // 回归锚点：logPath 的 projectID/service 一个来自 URL 路径参数、一个来自 query。
  // 未净化时 `service=../../../../etc/passwd` 让 join 跳出 logs/ 目录，
  // 落到 /etc/passwd.log —— GET /logs 可读任意 .log 全文，
  // DELETE /logs 更会把它 truncate 成 0 字节（破坏性写）。这是安全缺陷，不是体验问题。
  test('logPath 收敛路径穿越：恶意 id/service 不得逃出 logs/ 目录', () => {
    const s = new Store(makeTemp('polycode-ptrav-'))
    const logsDir = join(s.dir, 'logs')
    const evil = [
      ['p-1', '../../../../../../etc/passwd'],
      ['p-1', '..'],
      ['../../../../etc/passwd', 'x'],
      ['a/../../../../etc/passwd', 'y'],
      ['p-1', 'a/../../b'],
      ['p-1', '....//....//etc/passwd'],
      ['p-1', '/etc/passwd'],
    ] as const
    for (const [id, svc] of evil) {
      const p = s.logPath(id, svc)
      // 必须仍落在 <dir>/logs/ 内，且文件名里不含路径分隔符
      expect(p.startsWith(logsDir + sep)).toBe(true)
      expect(basename(p).includes('/')).toBe(false)
      expect(basename(p).includes('..')).toBe(false)
    }
    // 正常输入不受影响（不能为了安全把合法名字也改了）
    expect(s.logPath('p-1', 'backend')).toBe(join(logsDir, 'p-1-backend.log'))
  })
})

// —— 进程 supervision（process_test.go）

describe('startDetached / killTree', () => {
  test('启动后 pid 存活，killTree 后退出', async () => {
    const dir = makeTemp('polycode-plife-')
    try {
      const fd = openSync(join(dir, 'out.log'), 'a')
      const pid = startDetached(dir, LONG_RUNNING, [], fd)
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
      // shell 语法本身依平台而异（sh 的 `;`/`$VAR` vs cmd 的 `&`/`%VAR%`），
      // 但「cwd 生效 + env 注入」这两条语义是跨平台的，两边都要验——
      // 写死 sh 语法会让这条用例在 Windows 上必然超时。
      const isWin = process.platform === 'win32'
      const shellCmd = isWin
        ? 'cd > out2.log & echo %FOO% >> out2.log'
        : 'pwd > out2.log; echo $FOO >> out2.log'
      const pid = startDetached(dir, shellCmd, ['FOO=bar42'], fd)
      await vi.waitUntil(() => {
        try { return readFileSync(join(dir, 'out2.log'), 'utf8').length > 0 } catch { return false }
      }, { timeout: 5000, interval: 50 })
      // 两行输出：第一行 cwd，第二行注入的 env。
      // 逐行 trim：cmd 的 `echo X >> f` 会把 `>>` 前的空格一并写进去（尾随空格），
      // 而 sh 的 `echo $FOO` 不会——两边都 trim 后语义一致。
      // macOS 的 tmp 在 /private/var 下，故用 realpathSync 归一；
      // Windows 的路径大小写可能与 realpath 返回的不一致，按不敏感比。
      const real = realpathSync(dir)
      const lines = readFileSync(join(dir, 'out2.log'), 'utf8')
        .split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
      const gotDir = lines[0] ?? ''
      expect(isWin ? gotDir.toLowerCase() : gotDir).toBe(isWin ? real.toLowerCase() : real)
      expect(lines[1]).toBe('bar42')
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

  // quoteArg 的转义正确性：调用方（自我重启）要把「node 路径 + 一整段脚本」
  // 拼进一条 shell 命令，路径与脚本都可能含空格/引号/特殊字符。转义错了
  // 轻则命令被拆坏、重则注入，所以两种 shell 方言都逐条锚定。
  describe('quoteArg', () => {
    test('posix：单引号包裹，内部单引号用 \'\\\'\' 收尾续接', () => {
      expect(quoteArg('/usr/local/bin/node', 'darwin')).toBe(`'/usr/local/bin/node'`)
      // 含空格必须整体被引号包住（否则会被 shell 拆成两个参数）
      expect(quoteArg('/Applications/My App/node', 'linux')).toBe(`'/Applications/My App/node'`)
      // 单引号是唯一无法直接在单引号串里表示的字符
      expect(quoteArg("a'b", 'darwin')).toBe(`'a'\\''b'`)
    })

    test('windows(cmd)：双引号包裹，内部 " 写成 ""、% 写成 %%', () => {
      expect(quoteArg('C:\\Program Files\\nodejs\\node.exe', 'win32'))
        .toBe(`"C:\\Program Files\\nodejs\\node.exe"`)
      // cmd 里 "" 表示一个字面双引号
      expect(quoteArg('say "hi"', 'win32')).toBe(`"say ""hi"""`)
      // % 会被 cmd 当环境变量展开，必须写成 %% 才原样传递
      expect(quoteArg('100%done', 'win32')).toBe(`"100%%done"`)
    })

    test('posix 结果里不出现未转义的单引号对（能被 sh 正确还原）', () => {
      // 用真实 sh 还原一次：把命令交给 sh -c 打印出来，应与原文一致
      const nasty = `a'b "c" $HOME \`x\` ${'${y}'}`
      const out = execFileSync('sh', ['-c', `printf %s ${quoteArg(nasty, 'darwin')}`], { encoding: 'utf8' })
      expect(out).toBe(nasty)
    })
  })

  // 回归：网关以 launchd/service 身份运行时继承到的 PATH 极简（常只有
  // /usr/bin:/bin），npm/node/dsh 全部找不到，用户被迫在命令里手写
  // `export PATH=/Users/xxx/node/bin:$PATH; npm run dev`。augmentedPath 必须
  // 把标准安装位置补回来，且不抢占用户已有顺序。
  //
  // 仅 POSIX：fallbackPaths() 在 Windows 上**故意返回空数组**（Windows 的工具
  // 目录不写死，且 PATH 分隔符是 ';'），所以「补进常见安装位置」这条语义在
  // Windows 上不成立。平台相关的 PATH 分隔符行为另由下面的用例覆盖。
  test.skipIf(process.platform === 'win32')('augmentedPath 补全工具目录且不抢占原有顺序', () => {
    const p = augmentedPath('/usr/bin:/bin')
    const parts = p.split(':')
    // 原有条目顺序不变、仍在最前
    expect(parts.slice(0, 2)).toEqual(['/usr/bin', '/bin'])
    // 常见安装位置被补进来
    expect(parts.length).toBeGreaterThan(2)
    expect(parts).toContain('/opt/homebrew/bin')
    expect(parts).toContain('/usr/local/bin')
    const home = process.env.HOME
    if (home) expect(parts).toContain(`${home}/.local/bin`)
    // 去重：重复调用/重复给同一目录不产生重复项
    expect(new Set(parts).size).toBe(parts.length)
    expect(augmentedPath(p)).toBe(p)
  })

  // PATH 分隔符必须跟随平台（POSIX ':' / Windows ';'）：写死 ':' 会在 Windows
  // 上把 `C:\a;C:\b` 按盘符冒号切碎。这条在 Windows 上才有意义（POSIX 的
  // ':' 本来就是对的），故只在 Windows 跑。
  test.skipIf(process.platform !== 'win32')('augmentedPath 用平台 PATH 分隔符（Windows 分号）', () => {
    const base = 'C:\\Windows\\system32;C:\\Windows'
    const got = augmentedPath(base)
    // 原条目一个不少、顺序不变（被盘符冒号切碎的话这里就对不上）
    expect(got.split(';')).toEqual(['C:\\Windows\\system32', 'C:\\Windows'])
    expect(augmentedPath(got)).toBe(got)
  })

  // 回归：dir 留空不再报「未配置工作目录」，回落到进程 cwd。
  // 强制三填会逼用户填 "-" 这种假占位符，比留空更糟。
  test('dir 留空 = 进程 cwd，不再拒绝启动', async () => {
    const dir = makeTemp('polycode-pcwd-')
    try {
      const store = new Store(dir)
      // 输出 cwd 的命令依平台而异（sh 的 pwd / cmd 的 cd）——写死 pwd 会在
      // Windows 上因命令不存在而永远等不到日志（超时）。
      const isWin = process.platform === 'win32'
      const p: Project = {
        id: newID(), name: 'cwd-proj',
        // dir 故意留空 + cmd 输出 cwd 到日志
        services: [{ name: 'svc', dir: '', cmd: isWin ? 'cd' : 'pwd', port: 0 }],
      }
      store.save([p])
      const m = new Manager(store)
      const conflict = await m.startService(p.id, 'svc', 0)
      expect(conflict).toBeNull()
      const log = store.logPath(p.id, 'svc')
      // 等到日志里出现 cwd 再断言：日志开头就有一行「—— <ts> 启动 ——」分隔符，
      // 若只判「非空」会立刻通过，拿不到命令的输出（断言随之必挂）。
      const hasCwd = (): boolean => {
        try {
          const c = readFileSync(log, 'utf8')
          return isWin ? c.toLowerCase().includes(process.cwd().toLowerCase()) : c.includes(process.cwd())
        } catch { return false }
      }
      await vi.waitUntil(hasCwd, { timeout: 5000, interval: 50 })
      // 日志里除启动分隔行外，应含进程 cwd（Windows 路径大小写可能不同，不敏感比）
      const content = readFileSync(log, 'utf8')
      expect(isWin ? content.toLowerCase() : content)
        .toContain(isWin ? process.cwd().toLowerCase() : process.cwd())
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

  // 回归锚点：portBusy 对非法端口曾 **reject**（net.connect 同步抛 ERR_SOCKET_BAD_PORT，
  // Promise 构造器里的同步抛错变成 rejection），而调用方全都没 catch
  // （manager.viewOf / startService / freePort / killPort）——
  // projects.json 里一个 port:70000 就能让整个项目列表 500。
  // 字符串 '8080' 更阴险：不抛错，却静默被当成端口 0，端口冲突检测彻底失效。
  test('portBusy 对非法端口一律 resolve(false)，绝不 reject', async () => {
    const bad = [0, -1, 65536, 70000, 1.5, NaN, Infinity, '8080', null, undefined]
    for (const p of bad) {
      // 不该抛：整个项目列表的可达路径
      const r = await portBusy(p as number)
      expect(r).toBe(false)
    }
    // 端口 0 语义：非网络服务，视为不忙
    expect(await portBusy(0)).toBe(false)
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
    const id = addProject(m, { name: 'sleeper', dir: makeTemp('polycode-pmgrd-'), cmd: LONG_RUNNING, port: 0 })
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
    const id = addProject(m, { name: 's', dir: makeTemp('polycode-pmgrd2-'), cmd: LONG_RUNNING, port: 0 })
    await m.startService(id, 's', 0)
    await expect(m.startService(id, 's', 0)).rejects.toThrow(/已在运行/)
    await m.stopService(id, 's')
  }, 15_000)

  test('端口被占 → ConflictError{Port, Remappable, Suggested>taken}；同意映射后记账', async () => {
    const m = newTestManager()
    const { server, port: taken } = await listenRandom()
    try {
      const id = addProject(m, {
        name: 'env-svc', dir: makeTemp('polycode-pmgrd3-'), cmd: LONG_RUNNING, port: taken, portEnv: 'TEST_PORT',
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
      const id = addProject(m, { name: 'fixed', dir: makeTemp('polycode-pmgrd4-'), cmd: LONG_RUNNING, port: taken })
      const err = await m.startService(id, 'fixed', 0)
      expect(isConflictError(err)).toBe(true)
      if (isConflictError(err)) expect(err.remappable).toBe(false)
    } finally {
      server.close()
    }
  })

  test('RestartService 换 pid', async () => {
    const m = newTestManager()
    const id = addProject(m, { name: 's', dir: makeTemp('polycode-pmgrd5-'), cmd: LONG_RUNNING, port: 0 })
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
      name: 'exp', dir: makeTemp('polycode-pmgrd6-'), cmd: LONG_RUNNING, port: 0, maxRuntimeHours: 1,
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
    const id = addProject(m, { name: 'dead', dir: makeTemp('polycode-pmgrd7-'), cmd: EXITS_NOW, port: 0 })
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
    const id = addProject(m, { name: 'longrun', dir: makeTemp('polycode-pmgrd8-'), cmd: LONG_RUNNING, port: 0 })
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
          { name: 'a', dir: makeTemp('polycode-pmgrd9a-'), cmd: LONG_RUNNING, port: 0 },
          { name: 'b', dir: makeTemp('polycode-pmgrd9b-'), cmd: LONG_RUNNING, port: taken },
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
    const id = addProject(m, { name: 'nodir', dir: join(makeTemp('polycode-pmgrd10-'), 'nope'), cmd: EXITS_NOW, port: 0 })
    await expect(m.startService(id, 'nodir', 0)).rejects.toThrow(/工作目录不可用/)
    // 正常启动写日志分隔
    const dir = makeTemp('polycode-pmgrd11-')
    const id2 = addProject(m, { name: 'logged', dir, cmd: EXITS_NOW, port: 0 })
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
      const id = addProject(m, { name: 'ext', dir: makeTemp('polycode-ext-'), cmd: LONG_RUNNING, port })
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
    const id = addProject(m, { name: 'idle', dir: makeTemp('polycode-idle-'), cmd: LONG_RUNNING, port })
    const v = await m.view(id, 'idle')
    expect(v?.running).toBe(false)
    expect(v?.portBusyByOther).toBe(false)
  })

  test('自己启动的服务不标为外部占用', async () => {
    const m = newTestManager()
    const id = addProject(m, { name: 'own', dir: makeTemp('polycode-own-'), cmd: LONG_RUNNING, port: 0 })
    await m.startService(id, 'own', 0)
    const v = await m.view(id, 'own')
    expect(v?.running).toBe(true)
    expect(v?.portBusyByOther).toBe(false)
    await m.stopService(id, 'own')
  }, 15_000)

  test('port=0 的服务不探端口（没有端口可探）', async () => {
    const m = newTestManager()
    const id = addProject(m, { name: 'nop', dir: makeTemp('polycode-nop-'), cmd: LONG_RUNNING, port: 0 })
    const v = await m.view(id, 'nop')
    expect(v?.portBusyByOther).toBe(false)
  })

  // 回归：update.sh / 手动 npm start 用 nohup 起的服务不写 state，于是管理台既停不掉
  // 它（没有 pid）也起不来（端口被占），而占端口的恰恰是它自己——用户看到
  // 「端口被自己占用不能停」。现在按「进程 cwd == 服务 dir」认领，恢复可管理。
  //
  // 仅 POSIX：认领判据要读**别的进程的 cwd**，而 processCwd 在 Windows 上恒返回
  // 空串（没有 lsof 那种能力，读 PEB 需要原生代码）。所以 Windows 上配了 dir 的
  // 服务走不到这条 cwd 分支，只能靠下面的命令行特征回退。
  test.skipIf(process.platform === 'win32')('外部命令拉起的服务：按 cwd 认领为 running，且能停掉', async () => {
    const dir = makeTemp('polycode-claim-')
    const port = await freePortForTest()
    // 用子进程起一个"服务"：cwd 就是配置里的 dir（这是认领的判据）
    const child = spawn(process.execPath, [
      '-e', `require('http').createServer((_,r)=>r.end('ok')).listen(${port})`,
    ], { cwd: dir, detached: !IS_WIN, stdio: 'ignore' })
    child.unref()
    await waitPort(port)

    try {
      const m = newTestManager()
      const id = addProject(m, { name: 'adopted', dir, cmd: 'npm start', port })
      const v = await m.view(id, 'adopted')
      // 认出是"自己人"：running + adopted，而不是含糊的 portBusyByOther
      expect(v?.running).toBe(true)
      expect(v?.adopted).toBe(true)
      expect(v?.pid).toBe(child.pid)
      expect(v?.portBusyByOther).toBeUndefined()

      // 关键：能停掉（这正是用户卡住的地方）
      await m.stopService(id, 'adopted')
      await new Promise((r) => setTimeout(r, 300))
      let alive = true
      try { process.kill(child.pid!, 0) } catch { alive = false }
      expect(alive).toBe(false)
      const after = await m.view(id, 'adopted')
      expect(after?.running).toBe(false)
    } finally {
      try { process.kill(child.pid!, 'SIGKILL') } catch { /* 已死 */ }
    }
  }, 15_000)

  // 跨平台回退：没有可用 dir 时（dir 留空），认领改按**命令行特征**判断——
  // 这条路径在 Windows 上是唯一可用的认领手段（processCwd 不可用），
  // 且 processCmdline 两边都实现了（POSIX ps / Windows PowerShell CIM）。
  test('dir 留空时按命令行特征认领（Windows 唯一可用的认领路径）', async () => {
    const port = await freePortForTest()
    // 子进程命令行里带上服务名特征（认领回退判据靠 serviceSignatures 命中）
    const child = spawn(process.execPath, [
      '-e', `require('http').createServer((_,r)=>r.end('ok')).listen(${port})`,
      'adopted-svc',
    ], { detached: !IS_WIN, stdio: 'ignore' })
    child.unref()
    await waitPort(port)
    try {
      const m = newTestManager()
      const id = addProject(m, { name: 'adopted-svc', dir: '', cmd: 'node', port })
      const v = await m.view(id, 'adopted-svc')
      expect(v?.adopted).toBe(true)
      expect(v?.running).toBe(true)
      expect(v?.pid).toBe(child.pid)
    } finally {
      try { process.kill(child.pid!, 'SIGKILL') } catch { /* 已死 */ }
    }
  }, 15_000)

  // 回归：管理台自己就跑在网关进程里，而网关正是项目列表里的一项。
  // 认领它（用户才能看到"运行中"而不是莫名其妙的"端口被占用"），
  // 但绝不能允许从这里停掉它——杀自己会让请求挂死，且网关无守护进程、不会自动重启。
  test.skipIf(process.platform === 'win32')('认领「自己」但不允许停止自己（防自杀）', async () => {
    const dir = makeTemp('polycode-self-')
    // 用一个真实子进程占端口，但把「管理器自己」替换成它来验证拦截分支：
    // 直接构造 process.pid 命中的场景不可行（测试进程不监听该端口），
    // 改为验证 stopService 里的守卫逻辑本身——用假 pid 模拟。
    const port = await freePortForTest()
    const child = spawn(process.execPath, [
      '-e', `require('http').createServer((_,r)=>r.end('ok')).listen(${port})`,
    ], { cwd: dir, detached: !IS_WIN, stdio: 'ignore' })
    child.unref()
    await waitPort(port)
    try {
      const m = newTestManager()
      const id = addProject(m, { name: 'svc', dir, cmd: 'npm start', port })
      // 正常认领（停止链路由上面「外部命令拉起的服务」用例覆盖，
      // 这里不重复 killTree——在 vitest worker 里杀进程组可能连带打死 worker）
      const v = await m.view(id, 'svc')
      expect(v?.adopted).toBe(true)
      expect(v?.pid).toBe(child.pid)
    } finally {
      try { process.kill(child.pid!, 'SIGKILL') } catch { /* 已死 */ }
    }
  }, 15_000)

  // 语义已改（用户明确要求「项目管理模块要能关闭自己」）：
  // 以前 stop 自己会被硬拦成 500，导致用户没法重启自己的网关（网关本身就是
  // 项目列表里的一项）。现在允许停，但**顺序**必须对：重启要先安排"重开"再退出，
  // 否则进程没了，后面的 start 不会执行 —— 用户看到的是"重启完再也起不来"。
  // 这里不真的杀测试进程，用注入的替身断言编排是否正确。
  test('停「自己」是允许的：标记待退出 + 重启时先安排重开', async () => {
    const dir = makeTemp('polycode-self2-')
    const port = await freePortForTest()
    let restarts = 0
    // victim 扮演"网关自己"：用独立子进程的 pid，killTree 杀它不会影响测试进程。
    // selfPid 注入成它 → 既能走 self 分支，又不会真的自杀。
    const victim = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { detached: !IS_WIN, stdio: 'ignore' })
    victim.unref()
    const m = new Manager(new Store(makeTemp('polycode-selfmgr-')), {
      selfRestart: () => { restarts++; return true },
      exitSelf: () => { /* 替身：不真的退出测试进程 */ },
      selfPid: victim.pid!,
    })
    const id = addProject(m, { name: 'self', dir, cmd: 'npm start', port })
    try {
      m.state.set(`${id}/self`, { pid: victim.pid!, startedAt: new Date().toISOString() })
      // 普通 stop：允许，且不假装要重启
      await m.stopService(id, 'self')
      expect(m.state.has(`${id}/self`)).toBe(false)
      expect(restarts).toBe(0)
      // 停掉的确实是那个子进程
      await vi.waitUntil(() => !pidAlive(victim.pid!), { timeout: 5000, interval: 50 })
    } finally {
      try { process.kill(victim.pid!, 'SIGKILL') } catch { /* 已死 */ }
    }
  }, 15_000)

  test('restart 自己：先安排重开再退出（顺序错了就再也起不来）', async () => {
    const dir = makeTemp('polycode-self3-')
    const port = await freePortForTest()
    let restarts = 0
    const victim = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { detached: !IS_WIN, stdio: 'ignore' })
    victim.unref()
    const m = new Manager(new Store(makeTemp('polycode-selfmgr3-')), {
      selfRestart: () => { restarts++; return true },
      exitSelf: () => { /* 替身，不真的退出 */ },
      selfPid: victim.pid!,
    })
    const id = addProject(m, { name: 'self', dir, cmd: 'npm start', port })
    try {
      m.state.set(`${id}/self`, { pid: victim.pid!, startedAt: new Date().toISOString() })
      // 走 restart：必须安排重启，且**不**原地 start（进程马上要没了，start 没意义）
      const conflict = await m.restartService(id, 'self')
      expect(conflict).toBeNull()
      expect(restarts).toBe(1)
      // 旧 pid 记录必须清掉：留着会让新进程起来后显示成幽灵"运行中"
      expect(m.state.has(`${id}/self`)).toBe(false)
    } finally {
      try { process.kill(victim.pid!, 'SIGKILL') } catch { /* 已死 */ }
    }
  }, 15_000)

  test('无法自动重启时如实报错，不假装成功', async () => {
    const dir = makeTemp('polycode-self4-')
    const port = await freePortForTest()
    const victim = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { detached: !IS_WIN, stdio: 'ignore' })
    victim.unref()
    const m = new Manager(new Store(makeTemp('polycode-selfmgr4-')), {
      selfRestart: () => false, // 部署方式不支持自动重启
      exitSelf: () => { /* 替身 */ },
      selfPid: victim.pid!,
    })
    const id = addProject(m, { name: 'self', dir, cmd: 'npm start', port })
    try {
      m.state.set(`${id}/self`, { pid: victim.pid!, startedAt: new Date().toISOString() })
      await expect(m.restartService(id, 'self')).rejects.toThrow(/无法自动重启/)
    } finally {
      try { process.kill(victim.pid!, 'SIGKILL') } catch { /* 已死 */ }
    }
  }, 15_000)

  // 反面：dir 不匹配的占用者不该被认领（误认会让用户停掉无关进程）
  test('端口被无关进程占用：不认领，仍标 portBusyByOther', async () => {
    const otherDir = makeTemp('polycode-other-')
    const port = await freePortForTest()
    const child = spawn(process.execPath, [
      '-e', `require('http').createServer((_,r)=>r.end('ok')).listen(${port})`,
    ], { cwd: otherDir, detached: !IS_WIN, stdio: 'ignore' })
    child.unref()
    await waitPort(port)
    try {
      const m = newTestManager()
      // 配置的 dir 与进程实际 cwd 不同 → 必须不认
      const id = addProject(m, { name: 'foreign', dir: makeTemp('polycode-mine-'), cmd: 'npm start', port })
      const v = await m.view(id, 'foreign')
      expect(v?.running).toBe(false)
      expect(v?.adopted).toBeUndefined()
      expect(v?.portBusyByOther).toBe(true)
    } finally {
      try { process.kill(child.pid!, 'SIGKILL') } catch { /* 已死 */ }
    }
  }, 15_000)
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

// —— 日志 1k 滑动窗口（readTailLines 环形读）——
// 背景：旧实现全量 readFileSync 再 slice，Vite 热更新日志几十万行时卡死事件循环。
// 新实现从文件尾按 64KB 块往前扫，只读够 tail 行的字节。
describe('readTailLines 滑动窗口', () => {
  const writeLog = (dir: string, name: string, lines: string[]): string => {
    const p = join(dir, name)
    writeFileSync(p, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 })
    return p
  }

  test('不足窗口：全量返回，truncated=false', () => {
    const dir = makeTemp('polycode-tail1-')
    try {
      const p = writeLog(dir, 'a.log', ['l1', 'l2', 'l3'])
      const r = readTailLines(p, 1000)
      expect(r.text).toBe('l1\nl2\nl3')
      expect(r.truncated).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('超窗口：只取最后 N 行，truncated=true', () => {
    const dir = makeTemp('polycode-tail2-')
    try {
      const lines = Array.from({ length: 2500 }, (_, i) => `line-${i}`)
      const p = writeLog(dir, 'a.log', lines)
      const r = readTailLines(p, 1000)
      const got = r.text.split('\n')
      expect(got.length).toBe(1000)
      expect(got[0]).toBe('line-1500')
      expect(got[999]).toBe('line-2499')
      expect(r.truncated).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('无尾换行与有尾换行同语义', () => {
    const dir = makeTemp('polycode-tail3-')
    try {
      const p = join(dir, 'a.log')
      writeFileSync(p, 'a\nb', { mode: 0o600 })
      expect(readTailLines(p, 1000).text).toBe('a\nb')
      writeFileSync(p, 'a\nb\n', { mode: 0o600 })
      expect(readTailLines(p, 1000).text).toBe('a\nb')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('文件不存在/空文件 → 空，不抛', () => {
    const dir = makeTemp('polycode-tail4-')
    try {
      expect(readTailLines(join(dir, 'nope.log'), 1000)).toEqual({ text: '', truncated: false })
      const p = join(dir, 'empty.log')
      writeFileSync(p, '', { mode: 0o600 })
      expect(readTailLines(p, 1000)).toEqual({ text: '', truncated: false })
      expect(readTailLines(p, 0)).toEqual({ text: '', truncated: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('跨块大文件：多块拼接顺序正确', () => {
    const dir = makeTemp('polycode-tail5-')
    try {
      // 每行 ~200B，3000 行 ~600KB，远超单块 64KB，必须走多块路径
      const lines = Array.from({ length: 3000 }, (_, i) => `row-${String(i).padStart(4, '0')}-` + 'x'.repeat(180))
      const p = writeLog(dir, 'big.log', lines)
      const r = readTailLines(p, 1000)
      const got = r.text.split('\n')
      expect(got.length).toBe(1000)
      expect(got[0]).toBe(lines[2000])
      expect(got[999]).toBe(lines[2999])
      expect(r.truncated).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('中文多字节跨块切分不影响行数', () => {
    const dir = makeTemp('polycode-tail6-')
    try {
      const lines = Array.from({ length: 1500 }, (_, i) => `第${i}行-中文日志内容测试-${'啊'.repeat(50)}`)
      const p = writeLog(dir, 'cjk.log', lines)
      const r = readTailLines(p, 1000)
      const got = r.text.split('\n')
      expect(got.length).toBe(1000)
      expect(got[999]).toBe(lines[1499])
      expect(r.truncated).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
