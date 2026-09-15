// 账号池（对齐 Go internal/pool/account.go）：
// 同一批上游账号的平滑加权轮询与冷却。IP 池默认仅 direct（Provider 接口扩展点），不在本包实现。

import { accountEffectiveStatus, type Account, type AccountStatus } from '../model/index.ts'

// 惩罚状态（fails/cooldownUntil）落盘钩子：cli 注入，把池内惩罚写回 admin_accounts。
// 只写惩罚字段——status 的真相源是管理面（DB），池内 cooldown 不能覆盖它。
export type Persister = (a: Account) => void
const noPersist: Persister = () => {}

// 该源无可用账号（全部冷却/禁用/不存在）的哨兵错误。
export class ErrNoAccount extends Error {
  constructor() { super('pool: no available account') }
}

export class AccountPool {
  // 同源账号的轮询与冷却：pick/pickFrom 只给可用者，markResult 按 kind 惩罚，
  // 冷却到期自动复位。惩罚经 Persister 落盘（cli 注入写回 admin_accounts）。
  private accounts: Account[]
  private rr = new Map<string, number>() // sourceID → 上次选中的下标（轮询计数）
  // 惩罚状态回写存储（fails/cooldownUntil）。未注入则不落盘（测试/只读场景照旧）。
  private persist: Persister = noPersist

  constructor(accounts: Account[], persist: Persister = noPersist) {
    this.accounts = accounts.map((a) => ({ ...a }))
    this.persist = persist
  }

  // 报告该源是否配置了账号（哪怕全部冷却）：
  // 供调度区分「无账号 → 走 Provider 凭据」与「有账号但全冷却 → 跳过该源」。
  hasFor(sourceID: string): boolean {
    return this.accounts.some((a) => a.sourceId === sourceID)
  }

  // 轮询返回 sourceID 下一个可用账号（同源均分流量）。
  // 跳过 disabled/exhausted/冷却未到期者；冷却到期自动复位。
  // 无可用账号时抛 ErrNoAccount（调度器据此换源/报错，不静默等待）。
  pick(sourceID: string, now: Date): Account {
    const eligible = this.eligible(this.accounts.filter((a) => a.sourceId === sourceID), now)
    if (eligible.length === 0) throw new ErrNoAccount()
    const idx = (this.rr.get(sourceID) ?? -1) + 1
    this.rr.set(sourceID, idx % eligible.length)
    const best = eligible[idx % eligible.length]!
    best.lastUsed = now
    return { ...best }
  }

  // 按 id 白名单轮询（Provider.accountIds 绑定用）：
  // 与 pick 同语义（冷却到期自动复位、跳过不可用、无可用抛 ErrNoAccount）。
  // 名单为空/全不存在/全不可用 → 抛哨兵（调度器据此换源/报错，不静默等待）。
  pickFrom(ids: string[], now: Date): Account {
    const want = new Set(ids)
    const eligible = this.eligible(this.accounts.filter((a) => want.has(a.id)), now)
    if (eligible.length === 0) throw new ErrNoAccount()
    // 轮询键按白名单内容稳定，避免不同白名单互相抢计数。
    const key = `ids:${[...want].sort().join(',')}`
    const idx = (this.rr.get(key) ?? -1) + 1
    this.rr.set(key, idx % eligible.length)
    const best = eligible[idx % eligible.length]!
    best.lastUsed = now
    return { ...best }
  }

  // 回传账号使用结果：失败则 fails++ 并按原因惩罚（落盘）；成功则连败清零、惩罚全清
  // （账号能跑通即证明恢复）。成功仅在真有惩罚时落盘（无惩罚只更新 lastUsed，避免白写盘）。
  //
  // 惩罚分两档，区别在「会不会自己好」：
  //   exhausted（额度用尽）：上游明说没额度了，等下去也不会好 → 不设 cooldownUntil，
  //     只认人工「重置」或一次成功的「测试」。避免每 10 分钟爬起来再撞一次墙。
  //   cooldown（限流/鉴权/网络/其他）：临时故障，到点自动复位。
  markResult(id: string, ok: boolean, cooldownMs: number, now: Date, kind = ''): void {
    const a = this.accounts.find((x) => x.id === id)
    if (!a) return
    if (ok) {
      // 只在真有惩罚时写：避免每次成功都白落一次盘。
      if (a.status !== 'available' || a.fails !== 0) {
        a.status = 'available'
        a.cooldownUntil = undefined
        a.fails = 0
        this.persist(a)
      }
      a.lastUsed = now
      return
    }
    a.fails++
    if (kind === 'quota') {
      // 额度用尽：停在 exhausted，不设到期时间（重置/测试成功才回来）。
      a.status = 'exhausted'
      a.cooldownUntil = undefined
    } else if (cooldownMs > 0) {
      a.status = 'cooldown'
      a.cooldownUntil = new Date(now.getTime() + cooldownMs)
    }
    this.persist(a)
  }

  // 当前账号快照（深拷贝调用方随意改）。
  snapshot(): Account[] {
    return this.accounts.map((a) => ({ ...a }))
  }

  // 热重载账号列表（Admin 增删改后调用）：惩罚状态按 ID 合并保留，
  // 但管理面改 available/disabled 即时生效（不被旧惩罚覆盖）。
  // status 的真相源是 DB（只存 available/disabled）；cooldown 与 fails 是惩罚，
  // 现已落盘，重启后照认：
  //   新 disabled → 清冷却（停用即时生效）；
  //   旧 disabled + 新 available → 清冷却（启用即时生效）；
  //   其余 → 以池内为准，池内没有则认 DB 里落盘的惩罚。
  syncAccounts(accounts: Account[]): void {
    const keep = new Map(this.accounts.map((a) => [a.id, a]))
    const now = new Date()
    this.accounts = accounts.map((a) => {
      const old = keep.get(a.id)
      // 落盘时进程可能已停了很久：过期的冷却直接复位，不带着陈年惩罚进池。
      const stale = a.status === 'cooldown' && a.cooldownUntil && a.cooldownUntil <= now
      const in_ = stale
        ? { ...a, status: 'available' as AccountStatus, cooldownUntil: undefined }
        : { ...a }
      if (!old) return in_
      in_.fails = old.fails
      in_.lastUsed = old.lastUsed
      if (a.status === 'disabled') return { ...in_, cooldownUntil: undefined }
      if (old.status === 'disabled' && a.status === 'available') return { ...in_, cooldownUntil: undefined }
      // 其余 → 以池内为准（冷却/耗尽不丢）
      return { ...in_, status: old.status, cooldownUntil: old.cooldownUntil }
    })
  }

  // 冷却到期自动复位（写回池内状态并落盘），返回当前真正可用的账号。
  private eligible(accounts: Account[], now: Date): Account[] {
    const out: Account[] = []
    for (const a of accounts) {
      if (a.status === 'cooldown' && a.cooldownUntil && now > a.cooldownUntil) {
        a.status = 'available'
        a.cooldownUntil = undefined
        this.persist(a)
      }
      if (accountEffectiveStatus(a, now) !== 'available') continue
      out.push(a)
    }
    return out
  }

  // 按 id 取账号（指定账号头用）：返回副本，不存在返回 undefined。
  // 注意与 pick 的区别：此处只做冷却到期自动复位，不跳过 disabled/exhausted——
  // 调用方（servePinned）需自行按 accountEffectiveStatus 判定可用性。
  get(id: string, now: Date = new Date()): Account | undefined {
    const a = this.eligibleOne(id, now)
    return a ? { ...a } : undefined
  }

  // 内部用：取池内原对象（不拷贝），冷却到期自动复位。
  private eligibleOne(id: string, now: Date): Account | undefined {
    const a = this.accounts.find((x) => x.id === id)
    if (!a) return undefined
    if (a.status === 'cooldown' && a.cooldownUntil && now > a.cooldownUntil) {
      a.status = 'available'
      a.cooldownUntil = undefined
      this.persist(a)
    }
    return a
  }

  // 人工恢复键（管理面「重置」）：清失败计数与冷却，即时落盘。
  resetAccount(id: string): boolean {
    const a = this.accounts.find((x) => x.id === id)
    if (!a) return false
    a.fails = 0
    a.status = 'available' as AccountStatus
    a.cooldownUntil = undefined
    this.persist(a)
    return true
  }
}
