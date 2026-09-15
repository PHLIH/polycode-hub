// admin.db 存取 round-trip（对齐 Go store_sqlite_test.go）：
// schema 与 Go 完全一致（admin_providers/admin_accounts，id TEXT PK + data TEXT JSON），
// 能打开 Go 版写出的库。

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
import {
  MemoryAccountStore, MemoryProviderStore, SQLiteAccountStore, SQLiteProviderStore,
  seedAccountsIfEmpty, seedProvidersIfEmpty,
} from '../src/adminapi/store.ts'
import type { Account, Provider } from '../src/model/index.ts'

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'polycode-adminstore-')) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const provider: Provider = {
  id: 'p1', sourceId: 's', displayName: '', accessKind: 'official', risk: 'low', stability: 'stable',
  api: 'anthropic-messages', baseUrl: 'https://x', enabled: true, priority: 0,
  credential: { apiKeyEnv: 'K' },
  models: [{ id: 'm', providerId: 'p1', enabled: true, manual: false }],
}

const account: Account = {
  id: 'a1', sourceId: 's', status: 'available', fails: 0, credential: {},
}

describe('SQLite 存储（admin.db 两表 + 内存实现）', () => {
  test('落盘→重开→可查；两类存储同库共存；删除返回布尔', async () => {
    const path = join(dir, 'admin.db')
    const ps = await SQLiteProviderStore.open(path)
    ps.put(provider)
    const as = await SQLiteAccountStore.open(path)
    as.put(account)

    // 重开：数据都在
    const ps2 = await SQLiteProviderStore.open(path)
    const got = ps2.get('p1')
    expect(got).toBeDefined()
    expect(got!.credential.apiKeyEnv).toBe('K')
    expect(got!.models).toEqual([{ id: 'm', providerId: 'p1', enabled: true, manual: false }])
    const as2 = await SQLiteAccountStore.open(path)
    const gotA = as2.get('a1')
    expect(gotA).toBeDefined()
    expect(ps2.list()).toHaveLength(1)

    expect(ps2.delete('p1')).toBe(true)
    expect(as2.delete('a1')).toBe(true)
    expect(ps2.get('p1')).toBeUndefined()
    expect(ps2.delete('p1')).toBe(false)
    ps.close(); as.close(); ps2.close(); as2.close()
  })

  test('内存实现：seed + CRUD（测试用）', () => {
    const seed: Provider = { ...provider }
    const ps = new MemoryProviderStore([seed])
    expect(ps.get('p1')).toBeDefined()
    expect(ps.list()).toHaveLength(1)
    // 返回的是副本：改返回值不影响存储
    ps.get('p1')!.models.push({ id: 'x', providerId: 'p1', manual: false, enabled: true })
    expect(ps.get('p1')!.models).toHaveLength(1)
    ps.put({ ...seed, displayName: '改' })
    expect(ps.get('p1')!.displayName).toBe('改')
    expect(ps.delete('p1')).toBe(true)
    expect(ps.delete('p1')).toBe(false)

    const as = new MemoryAccountStore([account])
    expect(as.delete('a1')).toBe(true)
  })

  test('仅空库播种；非空不覆盖运行时变更', async () => {
    const path = join(dir, 'seed.db')
    const ps = await SQLiteProviderStore.open(path)
    const seed: Provider = { ...provider, id: 'seed' }
    await seedProvidersIfEmpty(ps, [seed])
    expect(ps.get('seed')).toBeDefined()
    ps.put({ ...seed, displayName: '改过' })
    await seedProvidersIfEmpty(ps, [seed])
    expect(ps.get('seed')!.displayName).toBe('改过')

    const as = await SQLiteAccountStore.open(path)
    await seedAccountsIfEmpty(as, [account])
    expect(as.get('a1')).toBeDefined()
    as.put({ ...account, displayName: '改过' })
    await seedAccountsIfEmpty(as, [account])
    expect(as.get('a1')!.displayName).toBe('改过')
    ps.close(); as.close()
  })

  test('能打开 Go 版写出的库（同 DDL + Go json blob）', async () => {
    const path = join(dir, 'go-written.db')
    // 按 Go store_sqlite.go 的 DDL 建库并写入 Go 版序列化的行
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode=WAL')
    db.exec(`CREATE TABLE IF NOT EXISTS admin_providers (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
    db.exec(`CREATE TABLE IF NOT EXISTS admin_accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
    db.prepare(`INSERT INTO admin_providers (id, data) VALUES (?, ?)`).run(
      'go-p', JSON.stringify({
        id: 'go-p', sourceId: 'go-s', accessKind: 'official', risk: 'low', stability: 'stable',
        api: 'openai-completions', baseUrl: 'https://go.example.com', enabled: true,
        priority: 1, credential: { apiKeyEnv: 'GO_KEY' },
        models: [{ id: 'gm', providerId: 'go-p', enabled: true, manual: false }],
      }),
    )
    db.prepare(`INSERT INTO admin_accounts (id, data) VALUES (?, ?)`).run(
      'go-a', JSON.stringify({ id: 'go-a', sourceId: 'go-s', status: 'available', fails: 0, credential: {} }),
    )
    db.close()

    const ps = await SQLiteProviderStore.open(path)
    const p = ps.get('go-p')
    expect(p).toBeDefined()
    expect(p!.sourceId).toBe('go-s')
    expect(p!.credential.apiKeyEnv).toBe('GO_KEY')
    expect(p!.models[0]!.id).toBe('gm')
    const as = await SQLiteAccountStore.open(path)
    expect(as.get('go-a')!.status).toBe('available')
    ps.close(); as.close()
  })
})

// 删账号只是把 admin_accounts 里的那一行去掉，绝不级联删 usage_logs：
// 首页 Dashboard 的 token/请求/热力图/按模型归因读的全是 usage_logs（按 provider_id
// 聚合，不 JOIN 账号表），account_id 只是日志行里的一个字符串。若哪天把删除实现成
// 级联清理，「删个号历史用量就没了」是用户数据的静默丢失。
describe('删账号不得动用量历史（首页预览数据）', () => {
  test('删除账号后 breakdown 合计与归因完全不变', async () => {
    const { Store } = await import('../src/usage/store.ts')
    const base = join(dir, 'del-no-cascade')
    const us = await Store.open(join(base, 'usage.db'))
    const as = await SQLiteAccountStore.open(join(base, 'admin.db'))

    as.put({ id: 'wb-1', sourceId: 'workbuddy', status: 'available', fails: 0, credential: {} })
    const log = (ts: Date) => ({
      id: 0, ts, requestId: 'r', sourceId: 'workbuddy', providerId: 'wb-auto',
      accountId: 'wb-1', modelId: 'hy3-preview', stream: true,
      inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0,
      reasoningTokens: 0, totalTokens: 300, accuracy: 'exact' as const,
      latencyMs: 100, status: 'ok' as const,
    })
    const since = new Date(Date.now() - 86400_000)
    await us.insertLog(log(new Date()))
    await us.insertLog(log(new Date()))
    const before = await us.breakdown(since)
    expect(before.totals.totalTokens).toBe(600)

    expect(await as.delete('wb-1')).toBe(true)
    expect(as.list()).toHaveLength(0) // 账号确实没了

    const after = await us.breakdown(since)
    expect(after.totals).toEqual(before.totals) // 首页合计纹丝不动
    expect(after.byModel).toEqual(before.byModel) // 归因也完整保留
    us.close(); as.close()
  })
})
