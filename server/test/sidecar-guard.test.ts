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

// fakeSidecar 记录 running/start 的调用，并按脚本给出探活结果与启动成败。
function fakeSidecar(script: {
  running?: () => Promise<boolean> | boolean
  start?: () => Promise<void> | void
}): { svc: Sidecar; calls: { running: number; start: number; workDirSeen: string } } {
  const calls = { running: 0, start: 0, workDirSeen: '' }
  const svc = {
    workDir: '/tmp/does-not-matter',
    async running(): Promise<boolean> {
      calls.running++
      return await (script.running?.() ?? false)
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
})
