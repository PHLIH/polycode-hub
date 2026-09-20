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

import type { Sidecar, SidecarProbe } from './sidecar.ts'
import { isPortInUseError } from './sidecar.ts'

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
  // 最近一次探活的三态结果（up/hung/down）。页面据此把「卡死」与「没启动」
  // 分开讲——两者的处置不同，合并成一句「已停止」会误导用户。
  probe: SidecarProbe
  // 已自动清场（杀掉卡死/占端口的旧进程）的次数，供页面与日志如实呈现。
  reaped: number
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
  // failed 之后是否自动回到 recovering 再试一轮。默认 true。
  //
  // 为什么默认要「复活」（真实故障，2026-09-19 取证）：failed 原本是**终局**
  // ——守护一旦放弃就再也不动手，哪怕后来端口空了、引擎本可以起来。实测那台
  // 机器上「引擎真死了、8080 空着也没人拉」整整持续到人工干预。念念不忘初衷：
  // 守护的目的是「尽量别让用户发现引擎不在」，彻底躺平违背这个目的。
  // 注意它不等于取消 maxRestarts：只是给额度一个**冷却后的重置**，而不是
  // 无限重试。
  autoResumeAfter?: number
  // 是否启用。未安装引擎时不应反复尝试拉起（会刷日志）。
  enabled?: () => boolean
  // 注入以便测试与可观测（默认 console）。
  log?: (msg: string) => void
}

// FAILED_COOLDOWN_MS 是置 failed 之后等多久再试一轮。默认 2 分钟：
// 短到用户在页面上点完「停止」就能等到它自己恢复，长到不会对一个
// 「转瞬即逝的抖动」反复折腾。
const FAILED_COOLDOWN_MS = 120_000

// SidecarGuard 周期探活并在引擎掉线时把它拉回来。
export class SidecarGuard {
  private readonly svc: Sidecar
  private readonly intervalMs: number
  private readonly failThreshold: number
  private readonly maxRestarts: number
  private readonly enabled: () => boolean
  private readonly log: (msg: string) => void
  private st: GuardStatus = {
    state: 'disabled', misses: 0, restarts: 0, lastOK: 0, lastAttempt: 0,
    lastError: '', probe: 'down', reaped: 0,
  }
  // busy：防止上一轮探活/重启还没结束就叠加下一轮（重启最长等 45 秒，
  // 而 intervalMs 是 20 秒——不加这个锁会并发拉起多个引擎）。
  private busy = false
  private readonly autoResumeAfter: number

  constructor(svc: Sidecar, opts: SidecarGuardOptions = {}) {
    this.svc = svc
    this.intervalMs = opts.intervalMs ?? 20_000
    this.failThreshold = opts.failThreshold ?? 2
    this.maxRestarts = opts.maxRestarts ?? 5
    this.autoResumeAfter = opts.autoResumeAfter ?? FAILED_COOLDOWN_MS
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
      // 三态探活，而不是一个布尔：hung（端口在监听但 /health 不通）意味着
      // **旧进程还活着**，直接拉新进程必然 EADDRINUSE——这正是本次故障里
      // 守护连试 5 次、每次都撞同一个错的根因。
      const probe = typeof this.svc.probe === 'function'
        ? await this.svc.probe()
        : ((await this.svc.running()) ? 'up' : 'down')
      this.st.probe = probe
      if (probe === 'up') {
        const wasDown = this.st.state === 'recovering' || this.st.state === 'failed'
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
      if (probe === 'hung') {
        // 卡死与「没了」要分开说：页面与日志都要能看出「是僵死进程占着端口」。
        this.log(`sidecar: 保活探活失败（第 ${this.st.misses}/${this.failThreshold} 次）——端口仍在监听但 /health 无响应（引擎卡死）`)
      } else {
        this.log(`sidecar: 保活探活失败（第 ${this.st.misses}/${this.failThreshold} 次）`)
      }
      if (this.st.misses < this.failThreshold) return false
      // 连续失败达标 → 尝试拉起。
      //
      // failed 不是终局：冷却到期后重置额度再试一轮。此前 failed 一旦置上就
      // 永不回头，实测出现过「引擎已死、端口空着、守护却躺平」的长时间
      // 不可恢复——与「尽量别让用户发现引擎不在」这个初衷相反。
      if (this.st.state === 'failed'
        && Date.now() - this.st.lastAttempt >= this.autoResumeAfter) {
        this.log('sidecar: 已过冷却期，重置重启额度后再试一轮')
        this.st.restarts = 0
        this.st.state = 'recovering'
      }
      if (this.st.restarts >= this.maxRestarts) {
        if (this.st.state !== 'failed') {
          this.st.state = 'failed'
          this.st.lastError = `连续 ${this.maxRestarts} 次重启仍未恢复，暂停自动重试（${Math.round(this.autoResumeAfter / 1000)} 秒后会再试；如需立即处理：${this.st.lastError || '见 sidecar 日志'}）`
          this.log(`sidecar: ${this.st.lastError}`)
        }
        return false
      }
      this.st.state = 'recovering'
      this.st.restarts++
      this.st.lastAttempt = Date.now()
      this.log(`sidecar: 引擎不在（连续 ${this.st.misses} 次探活失败，状态 ${probe}），自动拉起（第 ${this.st.restarts}/${this.maxRestarts} 次）…`)
      try {
        // 关键：拉起前先清场。
        //
        // hung 与「上次启动报端口被占」这两种情况下，端口上有**另一个**
        // zcode-proxy 进程（可能是不服务的僵死进程）。此时 spawn 新实例
        // 只有一种结果：bind 失败 → EADDRINUSE → 立即退出。老实现从不杀它，
        // 于是 5 次重启是 5 次注定失败，日志里落下 18 次相同的崩溃栈。
        if (probe === 'hung') {
          this.log('sidecar: 引擎卡死（端口被占），先停止旧进程再拉起…')
          await this.svc.stopAll()
          this.st.reaped++
        }
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
        // 端口被占：这一轮失败不是「引擎起不来」，而是「有人占着端口」。
        // 下一轮先杀掉它再拉——否则同样的错会一直重复到用满额度。
        if (isPortInUseError(e)) {
          this.log('sidecar: 失败原因是端口被占，下一轮将先清场再拉起')
          this.st.reaped++
          try { await this.svc.stopAll() } catch { /* 清场失败由下一轮继续处理 */ }
        }
        this.st.state = 'recovering'
      }
      return true
    } finally {
      this.busy = false
    }
  }

  // reset 让人工介入后立刻恢复自动保活（页面「重置保活」按钮 / CLI 调用）。
  //
  // 为什么需要：failed 的冷却是给「无人值守」用的；用户一旦手动清理过现场
  // （比如自己 kill 掉僵死进程），不该再让他干等两分钟。
  reset(): void {
    this.st.restarts = 0
    this.st.misses = 0
    this.st.lastError = ''
    this.st.state = 'recovering'
    this.log('sidecar: 保活守护已重置（人工介入后重新计数）')
  }

  // run 启动周期守护，返回取消函数（与 projects manager 的 runSweeper 同形）。
  run(): () => void {
    const t = setInterval(() => { void this.tick() }, this.intervalMs)
    t.unref?.()
    return () => { clearInterval(t) }
  }
}
