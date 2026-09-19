// sidecar 保活守护。
//
// 为什么需要它（真实故障，2026-09-19 取证）：
//   ZCode 本地引擎（zcode-proxy，127.0.0.1:8080）会因外部 SIGTERM 停掉
//   （管理台「停止」/改端口重启/卸载，或另一个网关实例的动作——
//    killSidecarSpec 用 `pgrep -f 'zcode-proxy.*--cli serve'` 匹配本用户**所有**
//    sidecar），而网关**没有任何机制把它拉回来**：sidecar 的启动只有
//    「管理台点启动/安装」和「CLI 手动」三条人工路径。
//   实测：引擎停下后连查 70 秒，running 恒为 false，永不恢复。
//
// 更糟的是故障被静默掩盖：config 的 default_model 指向另一个也声明了
// 同名模型的 Provider（senseaudio），sidecar 一死，请求就悄悄切过去并
// 返回 200——用户只感觉「用着用着不对了」，看不到一条明确报错。
//
// 本模块负责第一半（把它拉回来）；第二半（把降级讲清楚）在 state 里如实
// 暴露「是否在降级」，由管理台与日志呈现。
//
// 设计要点：
//   · 只探活 + 重启，**绝不**碰下载/安装（那是人工动作，有自己的进度与确认）。
//   · 连续 N 次失败才动手，避免上游/探活抖动导致误重启（重启本身有代价：
//     正在流式输出的请求会被打断）。
//   · 重启有冷却与次数上限：引擎如果是**配置性**启动失败（端口被别的进程占、
//     二进制缺失、未登录），无脑重试只会刷日志并反复拉起失败进程。
//   · 定时器 unref，不拖住进程退出（与 projects manager 的 runSweeper 同口径）。

import type { Sidecar } from './sidecar.ts'

export type GuardState = 'ok' | 'recovering' | 'failed' | 'disabled'

export interface GuardStatus {
  // state：ok=引擎在；recovering=正在尝试拉起；failed=连续尝试后仍起不来（需人工）；
  //        disabled=未启用（未安装 / 未配置）。
  state: GuardState
  // 连续探活失败次数（成功即清零）。
  misses: number
  // 已尝试重启次数（进程生命周期内累计）。
  restarts: number
  // 最近一次成功探活时间（0 = 从未成功）。
  lastOK: number
  // 最近一次重启尝试时间（0 = 从未）。
  lastAttempt: number
  // 最近一次错误（给人看的一句话；空 = 无）。
  lastError: string
}

export interface SidecarGuardOptions {
  // 探活间隔。默认 20 秒——引擎停止到被拉起之间用户至多等这么久，
  // 又不至于把探活本身变成负担。
  intervalMs?: number
  // 连续失败多少次才重启。默认 2：一次失败可能是探活抖动（引擎正忙/瞬时
  // 不接受连接），两次仍不通基本可以判定它真的没了。
  failThreshold?: number
  // 连续失败达到上限后，主动停手并置 failed（等人处理），避免无脑重试。
  // 默认 5 次重启尝试。
  maxRestarts?: number
  // 是否启用。未安装引擎时不应反复尝试拉起（会刷日志）。
  enabled?: () => boolean
  // 注入以便测试与可观测（默认 console）。
  log?: (msg: string) => void
}

// SidecarGuard 周期探活并在引擎掉线时把它拉回来。
export class SidecarGuard {
  private readonly svc: Sidecar
  private readonly intervalMs: number
  private readonly failThreshold: number
  private readonly maxRestarts: number
  private readonly enabled: () => boolean
  private readonly log: (msg: string) => void
  private st: GuardStatus = {
    state: 'disabled', misses: 0, restarts: 0, lastOK: 0, lastAttempt: 0, lastError: '',
  }
  // busy：防止上一轮探活/重启还没结束就叠加下一轮（重启最长等 45 秒，
  // 而 intervalMs 是 20 秒——不加这个锁会并发拉起多个引擎）。
  private busy = false

  constructor(svc: Sidecar, opts: SidecarGuardOptions = {}) {
    this.svc = svc
    this.intervalMs = opts.intervalMs ?? 20_000
    this.failThreshold = opts.failThreshold ?? 2
    this.maxRestarts = opts.maxRestarts ?? 5
    this.enabled = opts.enabled ?? (() => true)
    this.log = opts.log ?? ((m) => console.log(m))
  }

  status(): GuardStatus {
    return { ...this.st }
  }

  // tick 跑一轮检查。返回本轮是否触发了重启（供测试断言）。
  //
  // 刻意把「一轮」暴露成公开方法：测试可以直接调它，不必等真实定时器——
  // 保活逻辑的正确性（阈值、冷却、上限）不该被时序不确定性盖住。
  async tick(): Promise<boolean> {
    if (this.busy) return false
    if (!this.enabled()) {
      this.st.state = 'disabled'
      return false
    }
    this.busy = true
    try {
      const up = await this.svc.running()
      if (up) {
        const wasDown = this.st.state === 'recovering'
        this.st.state = 'ok'
        this.st.misses = 0
        this.st.lastOK = Date.now()
        if (wasDown) this.log('sidecar: 保活确认引擎已恢复（/health 200）')
        // 恢复后清零重启计数：那是「连续失败」的额度，不是终身配额。
        this.st.restarts = 0
        this.st.lastError = ''
        return false
      }
      this.st.misses++
      this.log(`sidecar: 保活探活失败（第 ${this.st.misses}/${this.failThreshold} 次）`)
      if (this.st.misses < this.failThreshold) return false
      // 连续失败达标 → 尝试拉起。
      if (this.st.restarts >= this.maxRestarts) {
        if (this.st.state !== 'failed') {
          this.st.state = 'failed'
          this.st.lastError = `连续 ${this.maxRestarts} 次重启仍未恢复，已停止自动重试（需人工排查：${this.st.lastError || '见 sidecar 日志'}）`
          this.log(`sidecar: ${this.st.lastError}`)
        }
        return false
      }
      this.st.state = 'recovering'
      this.st.restarts++
      this.st.lastAttempt = Date.now()
      this.log(`sidecar: 引擎不在（连续 ${this.st.misses} 次探活失败），自动拉起（第 ${this.st.restarts}/${this.maxRestarts} 次）…`)
      try {
        await this.svc.start(this.svc.workDir)
        // start 内部已 waitHealthy；成功即视为恢复。
        this.st.state = 'ok'
        this.st.misses = 0
        this.st.lastOK = Date.now()
        this.st.lastError = ''
        // 额度在这里就要清零，不能等「下一次成功探活」。
        // 踩过的坑：只在探活分支清零的话，重启成功但计数仍停在 maxRestarts，
        // 引擎下一次掉线时会先撞上 `restarts >= maxRestarts` 而直接放弃——
        // 表现为「第二次故障永久不再恢复」，正是本守护要消灭的现象。
        this.st.restarts = 0
        this.log('sidecar: 已自动拉起并探活通过')
      } catch (e) {
        this.st.lastError = (e as Error).message
        // 拉不起来时把**真实原因**留下来：start 会把日志尾部的引擎报错
        // 包进 message（未登录/端口被占/二进制缺失），这是排查的唯一线索。
        this.log(`sidecar: 自动拉起失败 —— ${this.st.lastError}`)
        this.st.state = 'recovering'
      }
      return true
    } finally {
      this.busy = false
    }
  }

  // run 启动周期守护，返回取消函数（与 projects manager 的 runSweeper 同形）。
  run(): () => void {
    const t = setInterval(() => { void this.tick() }, this.intervalMs)
    t.unref?.()
    return () => { clearInterval(t) }
  }
}
