// 账号池（对齐 Go internal/pool/account.go）：
// 同源账号的加权轮询与冷却。IP 池默认仅 direct（Provider 接口扩展点），不在本包实现。

import { accountEffectiveStatus, type Account, type AccountStatus } from '../model/index.ts'

// 惩罚状态（fails/cooldownUntil）落盘钩子：cli 注入，把池内惩罚写回 admin_accounts。
// 只写惩罚字段——status 的真相源是管理面（DB），池内 cooldown 不能覆盖它。
export type Persister = (a: Account) => void
const noPersist: Persister = () => {}

// 显式重置（操作者点「重置」/「启用」）落盘钩子：与 Persister 分开，因为语义不同——
// 普通惩罚回写绝不允许改写操作者设的 disabled，而显式重置必须能解除它。
// 分开成两个回调而不是共用 Persister 加标志位：行为差异显式写在类型里，不靠隐式状态。
export type ResetPersister = (a: Account) => void

// 该源无可用账号（全部冷却/禁用/不存在）的哨兵错误。
export class ErrNoAccount extends Error {
  constructor() { super('pool: no available account') }
}

export class AccountPool {
  // 同 Provider 账号的加权轮询与冷却：pick 只给可用者，markResult 按 kind 惩罚，
  // 冷却到期自动复位。惩罚经 Persister 落盘（cli 注入写回 admin_accounts）。
  private accounts: Account[]
  private rr = new Map<number, number>() // providerId → 加权轮询计数（单调递增，总权重取模）
  // 惩罚状态回写存储（fails/cooldownUntil）。未注入则不落盘（测试/只读场景照旧）。
  private persist: Persister = noPersist
  // 显式重置回写（允许解除 disabled）。未注入则退化为 persist。
  private persistReset: ResetPersister = noPersist

  constructor(accounts: Account[], persist: Persister = noPersist, persistReset: ResetPersister = persist) {
    this.accounts = accounts.map((a) => ({ ...a }))
    this.persist = persist
    this.persistReset = persistReset
  }

  // 报告该 Provider 是否配置了账号（哪怕全部冷却）：
  // 供调度区分「无账号 → 走 Provider 凭据」与「有账号但全冷却 → 跳过该 Provider」。
  hasFor(providerId: number): boolean {
    return this.accounts.some((a) => a.providerId === providerId)
  }

  // 加权轮询返回该 Provider 下一个可用账号（权重按 Account.weight，缺省/<=0 按 1）。
  // 跳过 disabled/exhausted/冷却未到期者；冷却到期自动复位。
  // 关/失效的账号不在 eligible 里，分母是可用者的权重和——自动重算，不用手动调。
  // 无可用账号时抛 ErrNoAccount（调度器据此换 Provider/报错，不静默等待）。
  pick(providerId: number, now: Date): Account {
    const eligible = this.eligible(this.accounts.filter((a) => a.providerId === providerId), now)
    if (eligible.length === 0) throw new ErrNoAccount()
    const total = eligible.reduce((s, a) => s + weightOf(a), 0)
    const idx = (this.rr.get(providerId) ?? -1) + 1
    this.rr.set(providerId, idx)
    let slot = idx % total
    for (const a of eligible) {
      slot -= weightOf(a)
      if (slot < 0) {
        a.lastUsed = now
        return { ...a }
      }
    }
    // total>0 时必在循环内返回；兜底取首个（防整除边界）
    const first = eligible[0]!
    first.lastUsed = now
    return { ...first }
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
      // 人工停用（disabled）是操作者意图，成功也不能推翻：只有显式「启用」才解开。
      // 没有这道闸，一次成功就把操作者刚关掉的号重新拉进轮询。
      // 但惩罚仍要清并落盘——「测试」是人工验证手段，已验证可用就不该再顶着连败计数；
      // 不落盘的话重启后又把陈年 fails 读回来（池内 0 / DB 6 的分叉）。
      if (a.status === 'disabled') {
        a.fails = 0
        a.cooldownUntil = undefined
        a.lastUsed = now
        this.persist(a)
        return
      }
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
    // 显式重置是操作者意图，允许解除 disabled——走 persistReset（普通 persist 不放行）。
    this.persistReset(a)
    return true
  }
}

// 权重归一：缺省/非数字/<=0 按 1 处理；小数向下取整到 1（权重是份数，不是比例）。
function weightOf(a: Account): number {
  const w = a.weight
  if (typeof w !== 'number' || !Number.isFinite(w)) return 1
  return Math.max(1, Math.floor(w))
}
