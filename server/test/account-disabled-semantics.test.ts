// 回归：账号「测试通过」不得静默改写操作者设的 disabled，也不得被热重载撤销。
//
// 现场（本机 wb-1）：管理面点「测试」→ 通过、健康度显示 ok，但 Harness 请求永远轮不到它。
// 原因是两处语义混淆叠加：
//   1. markResult 成功分支无条件把池内 status 置 available（连 disabled 也一起推翻）；
//   2. persister 里 disabled 不是显式分支，写回时会被算成「恢复」而落盘成 available，
//      于是操作者没点过「启用」，号却被自动放出来了——反之亦然，状态在两个方向上漂移。
//
// 这里锁死三条不变量：
//   A. disabled + 测试成功 → 仍是 disabled（只有显式 reset 能解），但 fails/冷却清零；
//   B. available + 测试成功 → available（正常恢复路径不受影响）；
//   C. 一次 syncAccounts（任何管理面写入都会触发）之后，disabled 不被惩罚态覆盖。

import { describe, expect, test } from 'vitest'
import { AccountPool } from '../src/pool/account.ts'
import { accountEffectiveStatus, type Account } from '../src/model/index.ts'

const NOW = new Date('2026-09-13T12:00:00Z')
const acct = (over: Partial<Account> & { id: string }): Account => ({
  providerId: 1, credential: {}, status: 'available', fails: 0, ...over,
})

// 复刻 cli.ts 里的回写规则：惩罚回写不许改写 disabled；显式重置可以解。
function mkPool(initial: Account[]) {
  const db = new Map(initial.map((a) => [a.id, { ...a }]))
  const writePenalty = (a: Account) => {
    const cur = db.get(a.id)!
    const next = { ...cur, fails: a.fails, cooldownUntil: a.cooldownUntil }
    if (cur.status === 'disabled') next.status = 'disabled'
    else if (a.status === 'exhausted') next.status = 'exhausted'
    else if (cur.status === 'exhausted' && a.status === 'available') next.status = 'available'
    db.set(a.id, next)
  }
  const writeReset = (a: Account) => {
    const cur = db.get(a.id)!
    db.set(a.id, { ...cur, status: a.status, fails: a.fails, cooldownUntil: a.cooldownUntil })
  }
  const pool = new AccountPool(initial, writePenalty, writeReset)
  return { pool, db }
}

describe('账号 disabled 语义：测试通过不得静默启用', () => {
  test('A. disabled + 测试成功 → 仍 disabled，但连败与冷却清零', () => {
    const { pool, db } = mkPool([
      acct({ id: 'wb-1', status: 'disabled', fails: 1 }),
    ])
    pool.markResult('wb-1', true, 0, NOW)

    // 池内：仍是 disabled——成功不能推翻操作者意图
    const a = pool.snapshot()[0]!
    expect(a.status).toBe('disabled')
    // 但测试确实起到了「验证」作用：连败清零
    expect(a.fails).toBe(0)
    expect(a.cooldownUntil).toBeUndefined()
    // DB 里也仍是 disabled（这是本 bug 的核心：不许漂移成 available）
    expect(db.get('wb-1')!.status).toBe('disabled')
  })

  test('A1b. disabled + 测试成功：fails 清零必须落盘（否则重启后池内/DB 分叉）', () => {
    const { pool, db } = mkPool([acct({ id: 'wb-1', status: 'disabled', fails: 6 })])
    pool.markResult('wb-1', true, 0, NOW)
    // 关键：落盘的 fails 也要归零，不能留在 DB 里等重启时读回来
    expect(db.get('wb-1')!.fails).toBe(0)
    expect(db.get('wb-1')!.status).toBe('disabled')
    // 重启等价于用 DB 重建池，此时不该又冒出连败计数
    const restarted = new AccountPool([...db.values()].map((a) => ({ ...a })))
    expect(restarted.snapshot()[0]!.fails).toBe(0)
    expect(restarted.snapshot()[0]!.status).toBe('disabled')
  })

  test('A2. disabled 账号不参与轮询（Harness 走的就是 pick 这条路）', () => {
    const { pool } = mkPool([
      acct({ id: 'wb-1', status: 'disabled' }),
      acct({ id: 'wb-2', status: 'available' }),
    ])
    // 即使 wb-1 刚测试通过，也只是它自己不被推翻；可用者仍是 wb-2
    pool.markResult('wb-1', true, 0, NOW)
    expect(pool.pick(1, NOW).id).toBe('wb-2')
  })

  test('B. available + 测试成功 → available（正常恢复路径不受影响）', () => {
    const { pool, db } = mkPool([
      acct({ id: 'a', status: 'cooldown', fails: 5, cooldownUntil: new Date(NOW.getTime() + 600_000) }),
    ])
    pool.markResult('a', true, 0, NOW)
    const a = pool.snapshot()[0]!
    expect(a.status).toBe('available')
    expect(a.fails).toBe(0)
    // 冷却是对号入座的惩罚，DB 里也应被清掉
    expect(db.get('a')!.cooldownUntil).toBeUndefined()
  })

  test('C. 惩罚回写后一次 syncAccounts：disabled 不被撤销', () => {
    const { pool, db } = mkPool([acct({ id: 'wb-1', status: 'disabled', fails: 1 })])
    // 有人在管理面改了别的东西 → syncStores → syncAccounts 全量同步
    pool.markResult('wb-1', true, 0, NOW)
    pool.syncAccounts([...db.values()].map((a) => ({ ...a })))

    const a = pool.snapshot()[0]!
    expect(a.status).toBe('disabled')
    expect(accountEffectiveStatus(a, NOW)).toBe('disabled')
  })

  test('C2. 显式重置（操作者点「重置」）是唯一能解除 disabled 的自动路径', () => {
    const { pool, db } = mkPool([acct({ id: 'wb-1', status: 'disabled', fails: 2 })])
    expect(pool.resetAccount('wb-1')).toBe(true)
    expect(pool.snapshot()[0]!.status).toBe('available')
    // 落盘也放开——否则重载后又变回 disabled，正是本 bug 的复发形态
    expect(db.get('wb-1')!.status).toBe('available')
    pool.syncAccounts([...db.values()].map((a) => ({ ...a })))
    expect(pool.snapshot()[0]!.status).toBe('available')
  })

  test('C3. 惩罚性的 exhausted 仍会覆盖 available（回归保护，别修坏原语义）', () => {
    const { pool, db } = mkPool([acct({ id: 'a', status: 'available' })])
    pool.markResult('a', false, 600_000, NOW, 'quota')
    expect(pool.snapshot()[0]!.status).toBe('exhausted')
    expect(db.get('a')!.status).toBe('exhausted')
    // 且它不会因为一次 syncAccounts 就自己好了
    pool.syncAccounts([...db.values()].map((a) => ({ ...a })))
    expect(pool.snapshot()[0]!.status).toBe('exhausted')
  })

  test('C4. exhausted + 成功 → 回到 available 并落盘（原语义保持）', () => {
    const { pool, db } = mkPool([acct({ id: 'a', status: 'exhausted', fails: 1 })])
    pool.markResult('a', true, 0, NOW)
    expect(pool.snapshot()[0]!.status).toBe('available')
    expect(db.get('a')!.status).toBe('available')
  })
})
