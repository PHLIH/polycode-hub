// 账号冷却的持久化往返（round-trip）回归。
//
// 真实缺陷（扫描实证，P1）：Account 落盘是整对象 JSON.stringify，cooldownUntil
// （类型上 Date）读回后是 **string**；而池内三处比较裸写 `now > a.cooldownUntil`
// （Date > string 恒 false）——冷却到期永远判不出来。账号被限流一次、网关
// 一重启就永久停在 cooldown，只能人工点重置；cli.ts 注释却写着「重启后照认」。
//
// 为什么既有测试没抓到：account-disabled-semantics.test.ts 的持久化替身用
// Map 存**对象引用**，从不经过 JSON round-trip。本文件用**真实 SQLite 库**
// 走完整的「落盘 → 读回 → 建池 → 时间流逝 → pick 放行」链路，堵住这个盲区。

import { describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQLiteAccountStore } from '../src/adminapi/store.ts'
import { AccountPool } from '../src/pool/account.ts'
import { accountEffectiveStatus, type Account } from '../src/model/index.ts'

async function makeStore(dir: string): Promise<SQLiteAccountStore> {
  return SQLiteAccountStore.open(join(dir, 'admin.db'))
}

const acct = (over: Partial<Account> & { id: string }): Account => ({
  providerId: 1, credential: {}, status: 'available', fails: 0, ...over,
})

describe('账号冷却持久化往返', () => {
  test('落盘 → 读回：cooldownUntil 仍是 Date（不是 string）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'polycode-acct-rt-'))
    try {
      const store = await makeStore(dir)
      const until = new Date('2026-09-19T16:00:00Z')
      store.put(acct({ id: 'a1', status: 'cooldown', cooldownUntil: until }))
      const back = store.get('a1')!
      expect(back).toBeDefined()
      // 修复前这里是 string —— 池内 `now > cooldownUntil` 恒 false 的根因
      expect(back.cooldownUntil).toBeInstanceOf(Date)
      expect((back.cooldownUntil as Date).getTime()).toBe(until.getTime())
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('限流 → 重启（读库建池）→ 冷却到期 → pick 能放行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'polycode-acct-rt2-'))
    try {
      const store = await makeStore(dir)
      // 第一次运行：账号被限流，惩罚落盘
      const past = new Date(Date.now() - 60_000) // 已过期 1 分钟
      store.put(acct({ id: 'a1', status: 'cooldown', cooldownUntil: past }))
      store.close()

      // "重启"：重新打开库、按读回的数据建池（生产 cli.ts 的路径）
      const store2 = await makeStore(dir)
      const pool = new AccountPool(store2.list())
      // 修复前：pick 抛 no available account（Date > string 恒 false）
      const picked = pool.pick(1, new Date())
      expect(picked?.id).toBe('a1')
      expect(picked?.status).toBe('available')
      store2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('string 型 cooldownUntil（旁路构造）也能被判到期', () => {
    // 防御层：即使持久层 revive 漏了某个旁路（管理面 parse、旧库、测试替身），
    // 池内比较也按数值化语义工作。
    const a = acct({ id: 's1', status: 'cooldown' })
    // 模拟 JSON round-trip 产物：直接塞 string
    ;(a as unknown as { cooldownUntil: string }).cooldownUntil =
      new Date(Date.now() - 60_000).toISOString()
    expect(accountEffectiveStatus(a, new Date())).toBe('available')
  })

  test('未到期的冷却不放行（string 形态同样正确）', () => {
    const a = acct({ id: 's2', status: 'cooldown' })
    ;(a as unknown as { cooldownUntil: string }).cooldownUntil =
      new Date(Date.now() + 60_000).toISOString()
    expect(accountEffectiveStatus(a, new Date())).toBe('cooldown')
  })
})
