// WorkBuddy 自动签到值守（定时器）。
//
// 与 sidecar/guard.ts 同构：定时器 unref 不拖住进程退出、可注入以便测试、
// 连续失败不无脑重试。差别在于本守护的动作一天只该发生一次，所以不做
// 「失败就立刻重试」——重试由**下一轮 tick** 负责（见下），且必须跨过当天。
//
// 为什么按「下次跨天时刻」调度而不是 setInterval(24h)（两个真实理由）：
//   1. 漂移：固定 24h 会随进程启动时刻漂移，长期偏到凌晨/深夜；
//   2. 跨天错位：用户可能在跨天那一刻正好在看页面，固定间隔会让当天的
//      记录迟迟不出现。对齐到本地 04:00 边界（CHECKIN_DAY_CUTOFF_HOUR）
//      后，「新的一天」一到就签，页面刷新即可见到结果。
//
// 失败语义（明确写死，避免以后写成「瞎报成功」）：
//   · 成功类结果（accepted / already_checked_in）→ 当天完成，不再重试；
//   · not_available（上游明确答复「活动未开启/已过期」）→ 当天也不再试。
//     重试不可能变好（活动开关不归我们），但明天可能就开了，所以只是当天作罢。
//   · fail（上游超时/未知响应）→ 当天**有限重试**：至少间隔 RETRY_AFTER_MS 再看一次。
//     签到没有幂等键，密集重试等于对上游连打，且「未确认」的语义本来就要求人去
//     客户端核对（与手动签到的提示一致）；但完全不重试也不行——一次网络抖动就
//     让当天白等，用户第二天才会发现没签上。所以：缓一阵再看，最多看一次左右。
//   · unauthorized / invalid（登录态失效/凭据变更）→ 人工动作，当天不再自动重试。
//     重试不可能自己变好，只会用废 token 反复打上游（288 次/天）。
//
// 并发：串行遍历账号，一个签完再下一个。签到是低频管理动作，串行换来的是
// 可预期的上游压力与简单的日志顺序；并发只会在「一堆账号同时打同一个上游」时
// 更容易触发限流。

import type { Account } from '../model/index.ts'
import { signedToday, checkinDayKey, msSinceCheckin, msUntilNextCheckinDay } from './checkin_schedule.ts'

// fail 之后多久才再看一次（同一逻辑日内）。30 分钟是个折中：
// 网络抖动/上游抽风会自愈，而 5 分钟的轮询周期不会在半小时内重复打 6 次。
// 上限：每个逻辑日最多 2~3 次真实调用（首次 + 缓一阵后的复查）。
export const RETRY_AFTER_MS = 30 * 60_000

// 单账号的签到结果（与 adminapi 的 /auto-checkin 响应同形状）。
export interface CheckinOutcome {
  status:
    | 'accepted' | 'already_checked_in' | 'not_available'
    | 'invalid' | 'unauthorized' | 'fail' | 'skipped'
  message: string
}

export interface AutoCheckinOptions {
  // 账号来源（读时从存储层现取，不要缓存快照：用户在页面上的开关改动要立刻生效）。
  listAccounts: () => Account[]
  // 执行一次签到（走进程内 HTTP：POST /admin/api/accounts/:id/auto-checkin）。
  // 返回 undefined = 端点没接通（本进程没装定时器或路由不对），按失败记录。
  run: (id: string) => Promise<CheckinOutcome | undefined>
  // 探针间隔（决定「跨天边界后多久内会签」与失败重试的检查频率）。默认 5 分钟。
  // 为什么不干脆睡到下一次跨天：sleep 时长在笔记本合盖/待机后会失准，
  // 固定短间隔的轮询天然自愈（每次 tick 都重新问「今天签了吗」）。
  intervalMs?: number
  // fail 之后同一逻辑日内的重试间隔（默认 RETRY_AFTER_MS）。
  retryAfterMs?: number
  // 注入以便测试与可观测（默认 console.log 一行）。
  log?: (msg: string) => void
  // 当前时间源（测试用）。
  now?: () => Date
}

export class AutoCheckin {
  private readonly listAccounts: () => Account[]
  private readonly run: (id: string) => Promise<CheckinOutcome | undefined>
  private readonly intervalMs: number
  private readonly retryAfterMs: number
  private readonly log: (msg: string) => void
  private readonly now: () => Date
  private ticking = false

  constructor(opts: AutoCheckinOptions) {
    this.listAccounts = opts.listAccounts
    this.run = opts.run
    this.intervalMs = opts.intervalMs ?? 5 * 60_000
    this.retryAfterMs = opts.retryAfterMs ?? RETRY_AFTER_MS
    this.log = opts.log ?? ((m) => console.log(m))
    this.now = opts.now ?? (() => new Date())
  }

  // 哪些账号此刻该签。判据（全部现取，不缓存：用户刚在页面上打开开关，下一轮就该生效）：
  //   1. 开关打开 + WorkBuddy 来源（两版都签）；
  //   2. 当天（逻辑日）还没成功签过；
  //   3. 没成功的那次尝试不能太频繁（同一逻辑日内至少隔 retryAfterMs）。
  //      哪些失败值得再试：见文件头的失败语义——fail 才重试，invalid/unauthorized 不试。
  //
  // 第 3 条不是可选项：没有它，一个登录态失效的账号会在每轮 tick（5 分钟）
  // 反复打上游，一天 288 次，而且每次都得到同样的 401。
  due(now: Date = this.now()): Account[] {
    return this.listAccounts().filter((a) => {
      if (a.autoCheckin !== true) return false
      const src = a.importSource ?? ''
      if (src !== 'workbuddy' && src !== 'workbuddy-ai') return false // 非 WorkBuddy 账号没有签到端点
      const ok = a.lastCheckinResult === 'accepted' || a.lastCheckinResult === 'already_checked_in'
        || a.lastCheckinResult === 'not_available'      // 凭据指纹变了（重新登录导入）→ 无论上次结果如何都该用新登录态再试一次。
      // 这条**必须排在「当天已完成」之前**：否则用户重新登录后要等到明天才生效。
      // 重试后 markCheckin 会把指纹对齐，不会每轮重复打。
      const credFresh = a.workbuddyTokenHash !== undefined && a.lastCheckinTokenHash !== a.workbuddyTokenHash
      if (credFresh) return true
      if (ok && signedToday(a.lastCheckinAt, now)) return false
      // 没签过（或跨天）→ 该签；当天失败过 → 按节流再看一次；
      // invalid/unauthorized → 当天不再自动重试（人工动作）。
      if (!signedToday(a.lastCheckinAt, now)) return true
      if (a.lastCheckinResult === 'fail') {
        return msSinceCheckin(a.lastCheckinAt, now) >= this.retryAfterMs
      }
      return false
    })
  }

  // 跑一轮：对每个 due 账号串行签一次。返回本轮小结（测试与日志用）。
  //
  // 重入保护（ticking）：一次 tick 可能因为上游慢而跨过下一个 interval，
  // 没这个闸会出现同一轮并发两遍。
  async tick(now: Date = this.now()): Promise<{ checked: number; ok: number; failed: number }> {
    if (this.ticking) return { checked: 0, ok: 0, failed: 0 }
    this.ticking = true
    const stats = { checked: 0, ok: 0, failed: 0 }
    try {
      const due = this.due(now)
      for (const a of due) {
        stats.checked++
        let out: CheckinOutcome | undefined
        try {
          out = await this.run(a.id)
        } catch (e) {
          out = { status: 'fail', message: `签到调用失败：${(e as Error).message}` }
        }
        if (!out) {
          this.log(`自动签到 ${a.id}: 失败（/auto-checkin 端点没有响应，检查路由是否接线）`)
          stats.failed++
          continue
        }
        if (out.status === 'accepted' || out.status === 'already_checked_in') {
          stats.ok++
          this.log(`自动签到 ${a.id}: ${out.message}（逻辑日 ${checkinDayKey(now)}）`)
        } else if (out.status === 'not_available') {
          // 活动没开：当天算「已处理」，不算失败——否则日志与计数会把
          // 「上游今天没这个活动」长期报成一个故障。
          stats.ok++
          this.log(`自动签到 ${a.id}: 今天不可签（${out.message}）；当天不再尝试`)
        } else if (out.status === 'skipped') {
          this.log(`自动签到 ${a.id}: 跳过（${out.message}）`)
        } else {
          stats.failed++
          const manual = out.status === 'unauthorized' || out.status === 'invalid'
          this.log(`自动签到 ${a.id}: 失败（${out.message}）` + (manual
            ? '；需人工处理（重新登录/核对身份），当天不再自动重试'
            : `；${Math.round(this.retryAfterMs / 60_000)} 分钟后复查一次`))
        }
      }
    } finally {
      this.ticking = false
    }
    return stats
  }

  // 起定时器。返回取消函数（用于优雅退出）。
  // unref：进程退出时不因它而挂住（与 projects runSweeper / sidecar guard 同口径）。
  run_timer(): () => void {
    const t = setInterval(() => { void this.tick() }, this.intervalMs)
    t.unref?.()
    return () => { clearInterval(t) }
  }
}

// 供日志/界面显示：距离下一个逻辑日还有多久（人话）。
export function describeNextWindow(now: Date): string {
  const ms = msUntilNextCheckinDay(now)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.round((ms % 3_600_000) / 60_000)
  return h > 0 ? `${h} 小时 ${m} 分后` : `${m} 分钟后`
}
