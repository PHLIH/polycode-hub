// 自动签到的**时区决策**：把「现在该不该签、算不算新的一天」收敛到这个纯模块。
//
// 为什么单独一个文件：时区逻辑是全仓最容易写错又最难发现出错的地方。
// 服务器与用户可能不同时区、不同日期（UTC 02:00 = 北京时间 10:00，UTC 与
// 本地日不是同一天）；一旦用 UTC 判「今天已签」，用户在北京 00:30 看到的
// 就是「今天已签到」而实际上那是昨天的记录——他的今天没签到。
// 所以：
//   · 判据一律用**本地日历日**（YYYY-MM-DD，来自 Date 的本地 getter）；
//   · 「今天/明天」的边界取本地 04:00（CHECKIN_DAY_CUTOFF_HOUR）——很多人
//     凌晨还没睡，0 点整就跨天会让手动补签与自动签到撞成两条记录。
//     04:00 之前算「上一个自然日」，之后算新的一天。
//   · 比较是「同一天」判定，不关心具体时刻——不存在「一天之内重复签」。
//
// 纯函数、无副作用、无 I/O：定时器（cli）与测试都调它，行为只有这一份定义。

// 跨天边界：本地时间 [00:00, 04:00) 归上一个自然日。
export const CHECKIN_DAY_CUTOFF_HOUR = 4

// 本地日历日键（server 与前端同口径：YYYY-MM-DD）。
// 注意这里**不能**用 toISOString().slice(0,10)：那是 UTC 日，与用户感知的
// 日历日不是一回事（见文件头）。
export function localDayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

// 自动签到的「逻辑日」：本地 04:00 之前仍算前一天。
// 例：10-13 03:30 → 10-12；10-13 04:00 → 10-13。
export function checkinDayKey(d: Date): string {
  const shifted = new Date(d.getTime())
  if (shifted.getHours() < CHECKIN_DAY_CUTOFF_HOUR) shifted.setDate(shifted.getDate() - 1)
  return localDayKey(shifted)
}

// 上次签到记录是否属于「当前逻辑日」（逻辑日不同 = 需要重新签）。
// lastAt 空/不可解析时返回 false（没有记录 = 没签过 = 该签）。
export function signedToday(
  lastAt: string | undefined, now: Date,
  dayOf: (d: Date) => string = checkinDayKey,
): boolean {
  if (!lastAt) return false
  const t = new Date(lastAt)
  if (Number.isNaN(t.getTime())) return false
  return dayOf(t) === dayOf(now)
}

// 距离上次签到尝试过了多久（毫秒）。lastAt 空/不可解析 → Infinity（= 已经等够了）。
// 定时器用它做「失败后缓一阵再重试」的节流：不引入额外计数器，
// 单个时间戳就能表达「同一逻辑日内多久没动静了」。
export function msSinceCheckin(lastAt: string | undefined, now: Date): number {
  if (!lastAt) return Number.POSITIVE_INFINITY
  const t = new Date(lastAt)
  if (Number.isNaN(t.getTime())) return Number.POSITIVE_INFINITY
  return now.getTime() - t.getTime()
}

// 下一个「逻辑日切换时刻」（本地 04:00）的延时毫秒数，> 0。
// 定时器按它对齐到跨天边界，不用固定 24h 轮询——那样每天会漂移，
// 且用户可能在恰好跨天的那一刻看到「今天没签」。
export function msUntilNextCheckinDay(now: Date): number {
  const next = new Date(now.getTime())
  next.setHours(CHECKIN_DAY_CUTOFF_HOUR, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}
