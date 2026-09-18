// Zen 会话池健康管理（2026-09-18 落地）。
//
// 背景：zen 免费档限流按 x-opencode-session 算（不是 IP），单个会话跑量必被
// 429。网关把本机 opencode 全部真实会话收进池轮换（见 discover/zen_refresh）。
// 本模块负责「怎么轮」与「坏了怎么办」两件事：
//
// 1) 轮询游标：每个请求从游标位置取首打会话，取完前移——16 个会话均摊，
//    不会有任何一个被反复打满（旧实现每请求都从池首开始，池首永远挨打）。
// 2) 失败淘汰：网络抖动/上游 5xx 按「15s 窗口内累计 3 次」淘汰该会话，
//    并从本机日志补一个没进过池的新会话进来，保持池容量。
//
// 错误分流（用户拍板）：
//   · 配额（RATE_LIMIT/QUOTA）→ 换会话重试，不计失败（会话没坏，只是窗口满了）；
//   · 网络抖动 / 上游 5xx   → 计失败，可能触发淘汰；
//   · API 问题（AUTH/FINGERPRINT/REGION/BAD_REQUEST）→ 立刻抛出，不重试不淘汰
//     （模型下线、地区限制、凭据失效要尽快让用户知道；换会话也救不了）。
//
// 状态全在内存（进程内）：重启归零，库里头不受影响。淘汰只影响本次运行。

import { findHeaderKey, validZenToken, ZEN_POOL_MAX, ZEN_SESSION_POOL_HEADER } from '../model/index.ts'

// 失败窗口：15s 内累计 3 次即淘汰。超过 15s 未再失败则计数重置。
export const ZEN_FAIL_WINDOW_MS = 15_000

// 淘汰阈值：窗口内第 3 次失败即淘汰。
export const ZEN_FAIL_THRESHOLD = 3

// 淘汰黑名单 TTL：坏会话冷却 30 分钟后，若刷新后的库池里还有它则重纳。
// 太短则坏会话反复回来，太长则池被打空后长期缩水；30 分钟是折中，可调。
export const ZEN_EVICT_TTL_MS = 30 * 60_000

// 单会话失败记录：次数 + 本窗口首次失败时间。
interface FailRecord {
  count: number
  firstAt: number
}

// 每个 Provider 的池运行时状态。
interface PoolState {
  cursor: number // 轮询游标：下一个首打会话的下标
  fails: Map<string, FailRecord> // 会话 → 失败记录
  evicted: Map<string, number> // 已被淘汰的会话 → 淘汰时刻（TTL 后可重纳）
  active: string[] // 当前池内容（可能因淘汰/补位与库里头不一致）
}

const states = new Map<number, PoolState>()

function stateOf(providerId: number): PoolState {
  let s = states.get(providerId)
  if (!s) {
    s = { cursor: 0, fails: new Map(), evicted: new Map(), active: [] }
    states.set(providerId, s)
  }
  return s
}

// 淘汰是否过期：TTL 后黑名单失效，会话可重纳（调用方须传 now，便于测试）。
function evictExpired(s: PoolState, sid: string, now: number): boolean {
  const at = s.evicted.get(sid)
  if (at === undefined) return false
  if (now - at < ZEN_EVICT_TTL_MS) return true // 仍在冷却
  s.evicted.delete(sid) // 到期：放出来
  return false
}

// 用库里的池初始化/同步运行时状态（池内容变化时以库为准，保留已有失败记录）。
// now 仅用于淘汰 TTL 判定（默认 Date.now，测试可注入）。
export function syncZenPool(providerId: number, pool: string[], now = Date.now()): PoolState {
  const s = stateOf(providerId)
  const alive = (sid: string) => !evictExpired(s, sid, now)
  if (s.active.length === 0) {
    // 首次：以库里的池为起点（冷却中的淘汰不复活，见 evicted）。
    s.active = pool.filter(alive)
    if (s.active.length > ZEN_POOL_MAX) s.active = s.active.slice(0, ZEN_POOL_MAX)
    return s
  }
  // 库里头有变化（刷新写入了新池）：
  //   · 库里新增且没被淘汰过 → 并进来；
  //   · 运行时里有、库里没有的 → 剔除（除非它已被淘汰，那本来就该不在）。
  const libSet = new Set(pool)
  const merged = s.active.filter((sid) => libSet.has(sid))
  for (const sid of pool) {
    if (!merged.includes(sid) && alive(sid)) merged.push(sid)
  }
  s.active = merged.length > ZEN_POOL_MAX ? merged.slice(0, ZEN_POOL_MAX) : merged
  if (s.active.length === 0) {
    s.active = pool.filter(alive).slice(0, ZEN_POOL_MAX)
  }
  if (s.active.length > 0) s.cursor = s.cursor % s.active.length
  else s.cursor = 0
  return s
}

// 取本轮的首打会话并按游标前移（真正的轮询）。
// 返回 undefined 表示池已空（全部被淘汰且无补位）——调用方禁用轮换、按原会话路径走，
// 绝不得回退到库内 primary（active 为空时库里剩的多半正是刚淘汰的）。
export function takeNextZenSession(providerId: number, pool: string[], now = Date.now()): string | undefined {
  const s = syncZenPool(providerId, pool, now)
  if (s.active.length === 0) return undefined
  const sid = s.active[s.cursor % s.active.length]
  s.cursor = (s.cursor + 1) % s.active.length
  return sid
}

// 记一次失败，返回是否达到淘汰阈值（达到则已从 active 剔除并加入 evicted）。
// 规则：15s 窗口内累计；超窗重置为 1 并刷新时间戳。
// pool 是库内池快照：先同步再记账——调用方可能没走过 takeNextZenSession
// （例如首个请求就失败），此时 active 还是空的，不同步会把淘汰记在空池上。
export function recordZenFailure(providerId: number, sid: string, now = Date.now(), pool: string[] = []): boolean {
  // now 全链透传：sync 内的 TTL 判定必须用同一时钟，否则测试时钟
  // （如 t0=1e6）记的淘汰会被 Date.now() 当场判过期、当场重纳。
  const s = pool.length > 0 ? syncZenPool(providerId, pool, now) : stateOf(providerId)
  const rec = s.fails.get(sid)
  if (!rec || now - rec.firstAt > ZEN_FAIL_WINDOW_MS) {
    s.fails.set(sid, { count: 1, firstAt: now })
    return false
  }
  rec.count++
  if (rec.count < ZEN_FAIL_THRESHOLD) return false
  // 达阈值：淘汰该会话，清掉它的失败记录。
  s.fails.delete(sid)
  s.evicted.set(sid, now)
  const i = s.active.indexOf(sid)
  if (i >= 0) {
    s.active.splice(i, 1)
    if (s.active.length > 0) s.cursor = s.cursor % s.active.length
    else s.cursor = 0
  }
  return true
}

// 成功一次即清掉该会话的失败记录（避免「偶尔抖一下」攒成淘汰）。
export function recordZenSuccess(providerId: number, sid: string): void {
  stateOf(providerId).fails.delete(sid)
}

// 补位：从候选里取一个没进过池、也没被淘汰过的会话记到运行时；
// 调用方须把它写透到库（writer 钩子），否则下次 sync 会按“库里没有”剔除。
// 返回补进来的会话（无候选返回 undefined）。候选由调用方（discover 层）提供。
// pool 是库内池快照（先同步，保证 active 与库里一致），候选里已在池内的跳过。
export function refillZenPool(providerId: number, candidates: string[], pool: string[] = [], now = Date.now()): string | undefined {
  const s = pool.length > 0 ? syncZenPool(providerId, pool, now) : stateOf(providerId)
  const seen = new Set(s.active)
  for (const raw of candidates) {
    const sid = (raw ?? '').trim()
    // 脏候选直接跳过：白名单不过、已在池内、冷却中淘汰，都不收
    // （ACTIVE 与库内池都不过长：sync 已按 ZEN_POOL_MAX 截断，这里补位同样守上限）。
    if (!validZenToken(sid) || seen.has(sid)) continue
    if (evictExpired(s, sid, now)) continue
    if (s.active.length >= ZEN_POOL_MAX) return undefined
    s.active.push(sid)
    seen.add(sid)
    return sid
  }
  return undefined
}

// 补位写透到库：把运行时 active（含新补位）写回库内池头，保持两者一致。
// 返回是否写过。writer 由调用方（cli 层）提供：读库内 Provider、改 headers、put + syncStores。
// 写不回库的补位下次 sync 会被剔除（A-P0-2），所以调用失败必须打日志告警。
export function flushZenPoolToLib(
  providerId: number,
  writer: (sessions: string[]) => boolean,
): boolean {
  const s = stateOf(providerId)
  if (s.active.length === 0) return false
  return writer([...s.active])
}

// 把运行时 active 落成池头字符串（writer 钩子装配用）。
export function zenPoolHeaderValue(sessions: string[]): string {
  return sessions.filter((x) => validZenToken(x)).slice(0, ZEN_POOL_MAX).join(',')
}

// 运行时可用池长（active 长；调用前先 sync，保证与库里一致）。
// 上限按它算（A-P1-6）：库长会把已淘汰的也算进去，高估可用数。
export function zenPoolActiveLen(providerId: number, pool: string[], now = Date.now()): number {
  return syncZenPool(providerId, pool, now).active.length
}

// 该会话当前是否可用（不在冷却黑名单内；TTL 到期懒清理）。
export function zenSessionUsable(providerId: number, sid: string, now = Date.now()): boolean {
  return !evictExpired(stateOf(providerId), sid, now)
}

// 空池/全淘汰回退守卫：picked 为 undefined 时调用方禁用轮换（见 upstream），
// 本函数供测试断言“淘汰会话不会被重拨”。
export function zenUsableSessions(providerId: number, pool: string[], now = Date.now()): string[] {
  const s = syncZenPool(providerId, pool, now)
  return s.active.filter((sid) => zenSessionUsable(providerId, sid, now))
}

// 观测用：当前池内容与失败计数快照（诊断/测试）。
export function zenPoolSnapshot(providerId: number): { active: string[]; cursor: number; fails: Record<string, number>; evicted: string[] } {
  const s = stateOf(providerId)
  const fails: Record<string, number> = {}
  for (const [sid, rec] of s.fails) fails[sid] = rec.count
  return { active: [...s.active], cursor: s.cursor, fails, evicted: [...s.evicted.keys()] }
}

// 测试用：清空全部运行时状态。
export function resetZenPoolState(): void {
  states.clear()
}
