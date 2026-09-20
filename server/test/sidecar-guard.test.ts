// sidecar 保活守护的行为锚定。
//
// 背景（真实故障，2026-09-19 取证）：引擎被外部 SIGTERM 停掉后网关**永不**
// 自动恢复——实测连查 70 秒 running 恒为 false。这里把「会自动恢复」以及
// 「不会因为抖动而乱重启」「不会无脑重试到天荒地老」都钉死。
//
// 全部用例直接驱动 tick()，不等真实定时器：保活逻辑的正确性不该被时序
// 不确定性盖住（阈值/冷却/上限都是确定性判断）。

import { describe, expect, test } from 'vitest'
import { SidecarGuard, type GuardStatus } from '../src/sidecar/guard.ts'
import type { Sidecar } from '../src/sidecar/sidecar.ts'

// fakeSidecar 记录 running/start/stopAll 的调用，并按脚本给出探活结果与启动成败。
function fakeSidecar(script: {
  running?: () => Promise<boolean> | boolean
  start?: () => Promise<void> | void
  probe?: () => Promise<'up' | 'hung' | 'down'>
  stopAll?: () => Promise<void> | void
}): { svc: Sidecar; calls: { running: number; start: number; stopAll: number; workDirSeen: string } } {
  const calls = { running: 0, start: 0, stopAll: 0, workDirSeen: '' }
  const svc = {
    workDir: '/tmp/does-not-matter',
    async running(): Promise<boolean> {
      calls.running++
      return await (script.running?.() ?? false)
    },
    async probe(): Promise<'up' | 'hung' | 'down'> {
      // 没有注入 probe 时退回 running：老调用方（只有 running）行为不变
      if (script.probe !== undefined) return await script.probe()
      return (await (script.running?.() ?? false)) ? 'up' : 'down'
    },
    async stopAll(): Promise<void> {
      calls.stopAll++
      await script.stopAll?.()
    },
    async start(dir: string): Promise<void> {
      calls.start++
      calls.workDirSeen = dir
      await script.start?.()
    },
  } as unknown as Sidecar
  return { svc, calls }
}

describe('SidecarGuard', () => {
  test('引擎在时：state=ok，不重启，且不产生任何 start 调用', async () => {
    const { svc, calls } = fakeSidecar({ running: () => true })
    const g = new SidecarGuard(svc, { log: () => {} })
    await g.tick()
    const st: GuardStatus = g.status()
    expect(st.state).toBe('ok')
    expect(st.misses).toBe(0)
    expect(st.restarts).toBe(0)
    expect(st.lastOK).toBeGreaterThan(0)
    expect(calls.start).toBe(0)
  })

  // 回归（本次故障的核心）：引擎掉线后**必须**被拉回来。
  test('引擎掉线达阈值：自动拉起，恢复后 state=ok', async () => {
    let up = false
    const { svc, calls } = fakeSidecar({
      running: () => up,
      start: () => { up = true }, // 拉起后引擎就活了
    })
    const g = new SidecarGuard(svc, { failThreshold: 2, log: () => {} })

    await g.tick() // 第 1 次失败：未达阈值，不动手
    expect(calls.start).toBe(0)
    expect(g.status().misses).toBe(1)

    const restarted = await g.tick() // 第 2 次失败：达阈值 → 拉起
    expect(restarted).toBe(true)
    expect(calls.start).toBe(1)
    expect(g.status().state).toBe('ok')
    expect(g.status().lastOK).toBeGreaterThan(0)
  })

  // 一次失败就重启是危险的：引擎可能只是瞬时忙/探活抖动，
  // 而重启会打断正在流式输出的请求。
  test('单次失败不触发重启（防抖动误杀）', async () => {
    const { svc, calls } = fakeSidecar({ running: () => false })
    const g = new SidecarGuard(svc, { failThreshold: 3, log: () => {} })
    await g.tick()
    await g.tick()
    expect(calls.start).toBe(0)
    expect(g.status().misses).toBe(2)
    // 尚未达阈值：既没在恢复，也还没放弃
    expect(g.status().state).not.toBe('recovering')
    expect(g.status().state).not.toBe('failed')
  })

  // 配置性启动失败（端口被别的进程占/未登录/二进制缺失）无脑重试只会刷日志，
  // 拉起一个注定失败的进程。达到上限后必须停手并把真实原因留下来等人工。
  test('反复拉不起来：达上限后停手并置 failed，带上真实原因', async () => {
    const { svc, calls } = fakeSidecar({
      running: () => false,
      start: () => { throw new Error('sidecar: 启动失败 —— Not logged in. Run: zcode-proxy auth login zai') },
    })
    const g = new SidecarGuard(svc, { failThreshold: 1, maxRestarts: 3, log: () => {} })

    await g.tick() // 第 1 次尝试
    await g.tick() // 第 2 次
    await g.tick() // 第 3 次 → 用满上限
    expect(calls.start).toBe(3)
    expect(g.status().state).toBe('recovering')

    await g.tick() // 第 4 次：超上限 → 停手
    expect(calls.start).toBe(3) // 不再尝试
    expect(g.status().state).toBe('failed')
    // 真实原因必须留下：这是排查的唯一线索
    expect(g.status().lastError).toContain('Not logged in')
  })

  test('恢复后重启额度清零（额度是"连续失败"，不是终身配额）', async () => {
    let up = false
    const { svc, calls } = fakeSidecar({ running: () => up, start: () => { up = true } })
    const g = new SidecarGuard(svc, { failThreshold: 1, maxRestarts: 1, log: () => {} })
    await g.tick()
    expect(calls.start).toBe(1)
    expect(g.status().state).toBe('ok')
    // 恢复即清零：额度用掉的那一次不该继续占着
    expect(g.status().restarts).toBe(0)

    // 再次掉线：额度已清零，必须还能再拉起一次。
    // 不归零的话这里会撞上 restarts>=maxRestarts 直接置 failed ——
    // 「第二次故障永久不再恢复」，正是本守护要消灭的现象。
    up = false
    await g.tick()
    expect(calls.start).toBe(2)
    expect(g.status().state).toBe('ok')
  })

  test('未安装（enabled=false）：state=disabled，不探活也不拉起', async () => {
    const { svc, calls } = fakeSidecar({ running: () => false })
    const g = new SidecarGuard(svc, { enabled: () => false, log: () => {} })
    await g.tick()
    expect(g.status().state).toBe('disabled')
    expect(calls.running).toBe(0)
    expect(calls.start).toBe(0)
  })

  test('start 用的是 svc.workDir（引擎工作目录不能猜）', async () => {
    const { svc, calls } = fakeSidecar({ running: () => false, start: () => {} })
    const g = new SidecarGuard(svc, { failThreshold: 1, log: () => {} })
    await g.tick()
    expect(calls.workDirSeen).toBe('/tmp/does-not-matter')
  })

  // 重启最长等 45 秒，而探活间隔是 20 秒。没有并发锁会叠加出多个引擎进程。
  test('并发 tick 不会叠加重启（busy 锁）', async () => {
    let release: (() => void) | undefined
    let started = false
    let up = false
    const { svc, calls } = fakeSidecar({
      running: () => up,
      start: () => {
        started = true
        return new Promise<void>((r) => { release = () => { up = true; r() } })
      },
    })
    const g = new SidecarGuard(svc, { failThreshold: 1, log: () => {} })
    const first = g.tick()
    // 等第一个 tick 真正进入 start 再发第二个：直接连发两个的话，
    // 第二个可能在第一个置 busy 之前就跑完，测不到锁（测试自身的竞态）。
    while (!started) await new Promise((r) => setTimeout(r, 0))
    const second = await g.tick() // 应被 busy 挡掉
    expect(second).toBe(false)
    expect(calls.start).toBe(1)
    // 显式断言非空再调用：release 只在闭包里被赋值，TS 会把它收窄成 never。
    expect(release).toBeTypeOf('function')
    release?.()
    await first
    expect(calls.start).toBe(1)
    expect(g.status().state).toBe('ok')
  })

  // —— 卡死（hung）必须先清场再拉起 ——
  //
  // 本次故障的核心（2026-09-19 取证）：引擎没死，是被上游验证码重试风暴
  // 拖成「活着但不服务」——端口照常 LISTEN，/health 永不返回。守护的探活
  // 于是恒为 false，每 20 秒 spawn 一个新进程；新进程 bind 8080 撞上还活着的
  // 旧进程 → EADDRINUSE → 立即退出。日志里 18 次同样的崩溃栈，全是这一个原因。
  // 老实现从头到尾没有杀旧进程的动作，5 次重启是 5 次注定失败。
  test('引擎卡死（端口占着但不服务）：先停止旧进程，再拉起', async () => {
    let up = false
    const { svc, calls } = fakeSidecar({
      probe: () => Promise.resolve(up ? 'up' : 'hung'),
      // 不杀掉旧进程的话 start 必然 EADDRINUSE 失败——把这条因果钉进测试：
      // stopAll 没被调用过就别指望 start 成功。
      start: () => { up = calls.stopAll > 0 },
    })
    const g = new SidecarGuard(svc, { failThreshold: 1, log: () => {} })
    await g.tick()
    expect(calls.stopAll).toBe(1) // 清场发生在 start 之前
    expect(calls.start).toBe(1)
    expect(g.status().state).toBe('ok')
    expect(g.status().reaped).toBe(1)
  })

  test('引擎真的没起（down）：不做无谓清场，直接拉起', async () => {
    let up = false
    const { svc, calls } = fakeSidecar({
      probe: () => Promise.resolve(up ? 'up' : 'down'),
      start: () => { up = true },
    })
    const g = new SidecarGuard(svc, { failThreshold: 1, log: () => {} })
    await g.tick()
    // 没有进程占端口时不该去杀——那会误伤用户自己跑的引擎
    expect(calls.stopAll).toBe(0)
    expect(calls.start).toBe(1)
    expect(g.status().probe).toBe('down')
  })

  test('启动报「端口被占」：当场清场一次，下一轮不再撞同一个错', async () => {
    let reaped = false
    const { svc, calls } = fakeSidecar({
      probe: () => Promise.resolve('down'),
      stopAll: () => { reaped = true },
      start: () => {
        // 清场前必然失败（端口被占），清场之后就能起来
        if (!reaped) throw new Error('sidecar: 启动失败 —— 端口已被占用。先停掉它。')
      },
    })
    const g = new SidecarGuard(svc, { failThreshold: 1, log: () => {} })
    await g.tick()
    expect(calls.start).toBe(1)
    expect(calls.stopAll).toBe(1) // 失败原因是端口被占 → 立即清场
    expect(g.status().lastError).toContain('端口已被占用')
  })

  // failed 曾经是终局：守护一旦放弃就再也不动手。实测出现过「引擎已死、
  // 端口空着、守护却躺平」长时间无人拉起——与「尽量别让用户发现引擎不在」
  // 这个初衷相反。冷却到期后必须能自己再试一轮。
  test('failed 不是终局：冷却到期后重置额度再试（端口空了要能自己起来）', async () => {
    // 前期每次 start 都抛「端口被占」（僵死进程占着端口的那 5 次），
    // 后期清理干净后 start 能成功——模拟人工介入/端口自行释放。
    let cleaned = false
    let up = false
    const { svc, calls } = fakeSidecar({
      probe: () => Promise.resolve(up ? 'up' : 'down'),
      start: () => {
        if (cleaned) { up = true; return }
        throw new Error('sidecar: 启动失败 —— 端口已被占用。')
      },
    })
    const g = new SidecarGuard(svc, {
      failThreshold: 1, maxRestarts: 2, autoResumeAfter: 60_000, log: () => {},
    })
    // 用满额度（maxRestarts=2）：两次尝试后，再一轮才置 failed
    await g.tick()
    await g.tick()
    expect(calls.start).toBe(2)
    expect(g.status().state).toBe('recovering')
    await g.tick() // 超上限 → 停手
    expect(calls.start).toBe(2)
    expect(g.status().state).toBe('failed')

    // 冷却期内：不再动手（这正是 maxRestarts 的意义——不能因为会复活就取消上限）
    await g.tick()
    expect(calls.start).toBe(2)

    // 现场清理好了 + 冷却已过（把 lastAttempt 推回 60 秒前，等价于等了一分钟；
    // 直接改内部状态而不是真 sleep——测的是判据，不是计时器）
    cleaned = true
    ;(g as unknown as { st: { lastAttempt: number } }).st.lastAttempt -= 60_000
    const again = await g.tick()
    expect(again).toBe(true)
    expect(calls.start).toBe(3) // 确实又试了一轮
    expect(g.status().state).toBe('ok')
    expect(g.status().restarts).toBe(0) // 额度已重置
  })

  test('reset 让人介入后立即恢复自动保活（不用干等冷却）', async () => {
    const { svc, calls } = fakeSidecar({
      probe: () => Promise.resolve('down'),
      start: () => { throw new Error('sidecar: 启动失败 —— 引擎未登录') },
    })
    const g = new SidecarGuard(svc, {
      failThreshold: 1, maxRestarts: 1, autoResumeAfter: 10 * 60_000, log: () => {},
    })
    await g.tick()
    await g.tick()
    expect(g.status().state).toBe('failed')
    expect(calls.start).toBe(1)
    // 人工清理过现场后重置：立刻可以再试，不必等满 10 分钟
    g.reset()
    expect(g.status().state).toBe('recovering')
    expect(g.status().restarts).toBe(0)
    await g.tick()
    expect(calls.start).toBe(2)
  })
})
