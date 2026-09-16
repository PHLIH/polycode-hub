import { describe, expect, test } from 'vitest'
import { AccountPool } from '../src/pool/account.ts'
import { accountEffectiveStatus, type Account } from '../src/model/index.ts'

const NOW = new Date('2026-09-13T12:00:00Z')
const acct = (over: Partial<Account> & { id: string }): Account => ({
  providerId: 1, credential: {}, status: 'available', fails: 0, ...over,
})

describe('AccountPool（对齐 Go internal/pool/account.go）', () => {
  test('HasFor：有账号（哪怕全冷却）为 true，无账号为 false', () => {
    const pool = new AccountPool([acct({ id: 'a1' })])
    expect(pool.hasFor(1)).toBe(true)
    expect(pool.hasFor(2)).toBe(false)
  })

  test('轮询均分：两个账号交替返回', () => {
    const pool = new AccountPool([acct({ id: 'a' }), acct({ id: 'b' })])
    const seq = [1, 2, 3, 4].map(() => pool.pick(1, NOW)!.id)
    expect(seq).toEqual(['a', 'b', 'a', 'b'])
  })

  test('禁用/耗尽/冷却未到期者被跳过；冷却到期自动复位', () => {
    const pool = new AccountPool([
      acct({ id: 'disabled', providerId: 1, status: 'disabled' }),
      acct({ id: 'exhausted', providerId: 1, status: 'exhausted' }),
      acct({ id: 'cooling', providerId: 1, status: 'cooldown', cooldownUntil: new Date('2026-09-13T13:00:00Z') }),
      acct({ id: 'recovered', providerId: 1, status: 'cooldown', cooldownUntil: new Date('2026-09-13T11:00:00Z') }),
    ])
    expect(pool.pick(1, NOW)!.id).toBe('recovered')
    // 复位后池内状态已改写（读回快照验证）
    expect(pool.snapshot().find((a) => a.id === 'recovered')!.status).toBe('available')
  })

  test('无可用账号抛哨兵错误', () => {
    const pool = new AccountPool([acct({ id: 'x', providerId: 1, status: 'disabled' })])
    expect(() => pool.pick(1, NOW)).toThrow(/no available account/)
  })

  test('markResult：失败 Fails++ 并按冷却时长进入冷却；成功清冷却', () => {
    const pool = new AccountPool([acct({ id: 'a' })])
    pool.markResult('a', false, 60_000, NOW)
    let snap = pool.snapshot()[0]!
    expect(snap.fails).toBe(1)
    expect(snap.status).toBe('cooldown')
    expect(snap.cooldownUntil).toEqual(new Date(NOW.getTime() + 60_000))
    pool.markResult('a', true, 0, NOW)
    snap = pool.snapshot()[0]!
    expect(snap.status).toBe('available')
    expect(snap.cooldownUntil).toBeUndefined()
  })

  test('quota 失败 → exhausted（不设到期时间，不会自己好）', () => {
    const pool = new AccountPool([acct({ id: 'a' })])
    pool.markResult('a', false, 600_000, NOW, 'quota')
    const a = pool.snapshot()[0]!
    expect(a.status).toBe('exhausted')
    expect(a.fails).toBe(1)
    // 关键：没有 cooldownUntil，所以不会被"冷却到期"逻辑放出来
    expect(a.cooldownUntil).toBeUndefined()
    // 时间过去再久也还是 exhausted（对比 cooldown 会自动复位）
    expect(accountEffectiveStatus(a, new Date(NOW.getTime() + 86400_000))).toBe('exhausted')
  })

  test('exhausted 账号不参与轮询，其它账号照常', () => {
    const pool = new AccountPool([acct({ id: 'a' }), acct({ id: 'b' })])
    pool.markResult('a', false, 0, NOW, 'quota')
    expect(pool.snapshot()[0]!.status).toBe('exhausted')
    // 连 pick 4 次都只能是 b（a 已耗尽，且不会自动恢复）
    const seq = [1, 2, 3, 4].map(() => pool.pick(1, NOW).id)
    expect(seq).toEqual(['b', 'b', 'b', 'b'])
  })

  test('exhausted 只认「重置」或成功的测试放行', () => {
    const pool = new AccountPool([acct({ id: 'a' })])
    pool.markResult('a', false, 0, NOW, 'quota')
    expect(pool.snapshot()[0]!.status).toBe('exhausted')
    // 重置（人工确认）：放行
    pool.resetAccount('a')
    expect(pool.snapshot()[0]!.status).toBe('available')
    // 再耗尽一次，这次用"测试成功"放行
    pool.markResult('a', false, 0, NOW, 'quota')
    expect(pool.snapshot()[0]!.status).toBe('exhausted')
    pool.markResult('a', true, 0, NOW)
    const a = pool.snapshot()[0]!
    expect(a.status).toBe('available')
    expect(a.fails).toBe(0)
  })

  test('exhausted 落盘：重启后仍停在耗尽态（不会自己爬起来）', () => {
    const pool = new AccountPool([acct({ id: 'a' })])
    pool.markResult('a', false, 0, NOW, 'quota')
    const persisted = pool.snapshot()
    // 新进程：从落盘结果建池
    const boot = new AccountPool([])
    boot.syncAccounts(persisted.map((x) => ({ ...x, credential: {} })))
    expect(boot.snapshot()[0]!.status).toBe('exhausted')
    expect(() => boot.pick(1, new Date(NOW.getTime() + 86400_000))).toThrow(/no available account/)
  })

  test('非 quota 的失败仍走可自动恢复的 cooldown', () => {
    const pool = new AccountPool([acct({ id: 'a' })])
    pool.markResult('a', false, 60_000, NOW, 'rate_limit')
    const a = pool.snapshot()[0]!
    expect(a.status).toBe('cooldown')
    expect(a.cooldownUntil).toEqual(new Date(NOW.getTime() + 60_000))
    // 到期自动复位
    const later = new Date(NOW.getTime() + 120_000)
    expect(pool.pick(1, later).id).toBe('a')
  })

  test('syncAccounts 热重载：同 ID 惩罚状态保留，消失移除，新增加入', () => {
    const pool = new AccountPool([acct({ id: 'a', fails: 3, status: 'cooldown', cooldownUntil: NOW })])
    pool.syncAccounts([
      acct({ id: 'a', fails: 0, status: 'available' }),
      acct({ id: 'b' }),
    ])
    const snap = pool.snapshot()
    const a = snap.find((x) => x.id === 'a')!
    expect(a.fails).toBe(3)
    expect(a.status).toBe('cooldown')
    expect(snap.map((x) => x.id)).toEqual(['a', 'b'])
  })

  test('syncAccounts：管理面改 available/disabled 即时生效（不被旧惩罚覆盖）', () => {
    // 场景1：管理面停用冷却中的号 → disabled 落盘
    const pool = new AccountPool([acct({ id: 'a', fails: 3, status: 'cooldown', cooldownUntil: NOW })])
    pool.syncAccounts([acct({ id: 'a', fails: 0, status: 'disabled' })])
    expect(pool.snapshot()[0]!.status).toBe('disabled')
    // 场景2：管理面启用被禁的号 → available 落盘
    pool.syncAccounts([acct({ id: 'a', fails: 0, status: 'available' })])
    expect(pool.snapshot()[0]!.status).toBe('available')
    // 场景3：管理面没动（仍 available）→ 池内冷却惩罚保留
    const pool2 = new AccountPool([acct({ id: 'a', fails: 3, status: 'cooldown', cooldownUntil: NOW })])
    pool2.syncAccounts([acct({ id: 'a', fails: 0, status: 'available' })])
    expect(pool2.snapshot()[0]!.status).toBe('cooldown')
    expect(pool2.snapshot()[0]!.fails).toBe(3)
  })

  test('resetAccount：清失败计数与冷却', () => {
    const pool = new AccountPool([acct({ id: 'a', fails: 2, status: 'cooldown' })])
    expect(pool.resetAccount('a')).toBe(true)
    const a = pool.snapshot()[0]!
    expect(a.fails).toBe(0)
    expect(a.status).toBe('available')
    expect(pool.resetAccount('nope')).toBe(false)
  })

  test('惩罚落盘：失败/成功/重置都回写（不落盘则重启即失忆）', () => {
    const writes: { id: string; fails: number; cooldownUntil?: Date }[] = []
    const pool = new AccountPool([acct({ id: 'a' })], (a) => writes.push({ id: a.id, fails: a.fails, cooldownUntil: a.cooldownUntil }))
    pool.markResult('a', false, 60_000, NOW)
    expect(writes).toEqual([{ id: 'a', fails: 1, cooldownUntil: new Date(NOW.getTime() + 60_000) }])
    // 成功：连败清零并清冷却，也要落盘（否则 DB 里留着旧连败数）
    pool.markResult('a', true, 0, NOW)
    expect(writes[1]).toEqual({ id: 'a', fails: 0, cooldownUntil: undefined })
    // 无惩罚的成功不落盘（避免每次请求都写一次）
    expect(writes).toHaveLength(2)
    pool.markResult('a', true, 0, NOW)
    expect(writes).toHaveLength(2)
    // 重置同样落盘
    pool.markResult('a', false, 0, NOW)
    pool.resetAccount('a')
    expect(writes[writes.length - 1]).toEqual({ id: 'a', fails: 0, cooldownUntil: undefined })
  })

  test('连败计数：成功清零（不是只清冷却）', () => {
    const pool = new AccountPool([acct({ id: 'a' })])
    pool.markResult('a', false, 0, NOW)
    pool.markResult('a', false, 0, NOW)
    expect(pool.snapshot()[0]!.fails).toBe(2)
    pool.markResult('a', true, 0, NOW)
    expect(pool.snapshot()[0]!.fails).toBe(0)
  })

  test('冷却到期复位也落盘（否则 DB 里一直挂着过期冷却）', () => {
    const writes: string[] = []
    const pool = new AccountPool(
      [acct({ id: 'a', providerId: 1, status: 'cooldown', cooldownUntil: new Date('2026-09-13T11:00:00Z') })],
      (a) => writes.push(a.id),
    )
    pool.pick(1, NOW)
    expect(writes).toEqual(['a'])
    expect(pool.snapshot()[0]!.cooldownUntil).toBeUndefined()
  })

  test('重启恢复：DB 里未过期的冷却被照认，过期的丢弃', () => {
    const fresh = new Date(Date.now() + 3600_000)
    const stored = [
      acct({ id: 'cool', providerId: 1, status: 'cooldown', fails: 3, cooldownUntil: fresh }),
      acct({ id: 'stale', providerId: 1, status: 'cooldown', fails: 2, cooldownUntil: new Date(Date.now() - 3600_000) }),
    ]
    const pool = new AccountPool([])
    pool.syncAccounts(stored)
    const snap = pool.snapshot()
    expect(snap.find((a) => a.id === 'cool')!.status).toBe('cooldown')
    expect(snap.find((a) => a.id === 'cool')!.fails).toBe(3)
    // 过期冷却：复位成 available（连败数保留，它不清零）
    expect(snap.find((a) => a.id === 'stale')!.status).toBe('available')
    expect(snap.find((a) => a.id === 'stale')!.fails).toBe(2)
  })

  test('get：按 id 取账号（副本）；不存在返回 undefined', () => {
    const pool = new AccountPool([acct({ id: 'a' }), acct({ id: 'b', providerId: 2 })])
    expect(pool.get('a')!.id).toBe('a')
    expect(pool.get('a')!.providerId).toBe(1)
    expect(pool.get('nope')).toBeUndefined()
  })

  test('get：冷却到期自动复位（与 pick 同语义）', () => {
    const pool = new AccountPool([
      acct({ id: 'old', providerId: 1, status: 'cooldown', cooldownUntil: new Date('2026-09-13T11:00:00Z') }),
    ])
    expect(pool.get('old', NOW)!.status).toBe('available')
    expect(pool.snapshot()[0]!.status).toBe('available')
  })

  test('加权轮询：权重 2:1 按 2:1 分配', () => {
    const pool = new AccountPool([acct({ id: 'a', weight: 2 }), acct({ id: 'b', weight: 1 })])
    const seq = [1, 2, 3, 4, 5, 6].map(() => pool.pick(1, NOW)!.id)
    expect(seq).toEqual(['a', 'a', 'b', 'a', 'a', 'b'])
  })

  test('加权轮询：缺省/非法权重按 1 处理', () => {
    const pool = new AccountPool([
      acct({ id: 'a' }),
      acct({ id: 'b', weight: 0 }),
      acct({ id: 'c', weight: -2 }),
      acct({ id: 'd', weight: NaN }),
    ])
    // 四个权重全归一成 1：轮转均分
    const seq = [1, 2, 3, 4].map(() => pool.pick(1, NOW)!.id)
    expect(seq).toEqual(['a', 'b', 'c', 'd'])
  })

  test('加权轮询：关/失效的账号权重自动失效，分母重算', () => {
    const pool = new AccountPool([
      acct({ id: 'a', weight: 10 }),
      acct({ id: 'b', weight: 1 }),
    ])
    // a 权重 10，本来 b 几乎拿不到；a 冷却后 b 全拿
    pool.markResult('a', false, 60_000, NOW, 'rate_limit')
    const seq = [1, 2, 3].map(() => pool.pick(1, NOW).id)
    expect(seq).toEqual(['b', 'b', 'b'])
    // a 冷却到期回来，权重恢复
    const later = new Date(NOW.getTime() + 120_000)
    const seq2 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(() => pool.pick(1, later).id)
    expect(seq2.filter((id) => id === 'b')).toHaveLength(1)
  })

  test('加权轮询：disabled 账号不占权重', () => {
    const pool = new AccountPool([
      acct({ id: 'a', weight: 5, status: 'disabled' }),
      acct({ id: 'b', weight: 1 }),
    ])
    const seq = [1, 2, 3].map(() => pool.pick(1, NOW).id)
    expect(seq).toEqual(['b', 'b', 'b'])
  })
})
