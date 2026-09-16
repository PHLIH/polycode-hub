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

// Provider 身份 = 数字 providerId（自增，永不变）+ 可变 name。夹具给固定正数 id
// （0 = 「由存储层分配」的哨兵，多个夹具共用 0 会在内存 store 里退化成同一行）。
const provider: Provider = {
  providerId: 1, name: 'p1', state: 'active', displayName: '', accessKind: 'official',
  risk: 'low', stability: 'stable',
  api: 'anthropic-messages', baseUrl: 'https://x', priority: 0,
  credential: { apiKeyEnv: 'K' },
  models: [{ id: 'm', enabled: true, manual: false }],
}

const account: Account = {
  id: 'a1', providerId: 1, status: 'available', fails: 0, credential: {},
}

describe('SQLite 存储（admin.db 两表 + 内存实现）', () => {
  test('落盘→重开→可查；两类存储同库共存；删除返回布尔', async () => {
    const path = join(dir, 'admin.db')
    const ps = await SQLiteProviderStore.open(path)
    // put 对 providerId>0 走 UPDATE：行不存在就等于没写，所以新建时给 0 由存储层分配。
    const row: Provider = { ...provider, providerId: 0 }
    ps.put(row)
    const pid = row.providerId
    expect(pid).toBeGreaterThan(0)
    const as = await SQLiteAccountStore.open(path)
    as.put({ ...account, providerId: pid })

    // 重开：数据都在（按数字 providerId 定位，name 只是可变的对外名）
    const ps2 = await SQLiteProviderStore.open(path)
    const got = ps2.get(pid)
    expect(got).toBeDefined()
    expect(got!.name).toBe('p1')
    expect(got!.credential.apiKeyEnv).toBe('K')
    expect(got!.models).toEqual([{ id: 'm', enabled: true, manual: false }])
    const as2 = await SQLiteAccountStore.open(path)
    const gotA = as2.get('a1')
    expect(gotA).toBeDefined()
    expect(ps2.list()).toHaveLength(1)
    expect(ps2.getByName('p1')!.providerId).toBe(pid)

    expect(ps2.delete(pid)).toBe(true)
    expect(as2.delete('a1')).toBe(true)
    expect(ps2.get(pid)).toBeUndefined()
    expect(ps2.delete(pid)).toBe(false)
    ps.close(); as.close(); ps2.close(); as2.close()
  })

  test('内存实现：seed + CRUD（测试用）', () => {
    const seed: Provider = { ...provider }
    const ps = new MemoryProviderStore([seed])
    expect(ps.get(1)).toBeDefined()
    expect(ps.list()).toHaveLength(1)
    // 返回的是副本：改返回值不影响存储
    ps.get(1)!.models.push({ id: 'x', manual: false, enabled: true })
    expect(ps.get(1)!.models).toHaveLength(1)
    ps.put({ ...seed, displayName: '改' })
    expect(ps.get(1)!.displayName).toBe('改')
    expect(ps.delete(1)).toBe(true)
    expect(ps.delete(1)).toBe(false)

    const as = new MemoryAccountStore([account])
    expect(as.delete('a1')).toBe(true)
  })

  test('仅空库播种；非空不覆盖运行时变更', async () => {
    const path = join(dir, 'seed.db')
    const ps = await SQLiteProviderStore.open(path)
    const seed: Provider = { ...provider, providerId: 0, name: 'seed' }
    await seedProvidersIfEmpty(ps, [seed])
    const pid = seed.providerId
    expect(pid).toBeGreaterThan(0)
    expect(ps.get(pid)).toBeDefined()
    ps.put({ ...seed, displayName: '改过' })
    await seedProvidersIfEmpty(ps, [seed])
    expect(ps.get(pid)!.displayName).toBe('改过')

    const as = await SQLiteAccountStore.open(path)
    await seedAccountsIfEmpty(as, [account])
    expect(as.get('a1')).toBeDefined()
    as.put({ ...account, displayName: '改过' })
    await seedAccountsIfEmpty(as, [account])
    expect(as.get('a1')!.displayName).toBe('改过')
    ps.close(); as.close()
  })

  test('新建（providerId=0）由 AUTOINCREMENT 分配并回填', async () => {
    const path = join(dir, 'autoinc.db')
    const ps = await SQLiteProviderStore.open(path)
    const fresh: Provider = { ...provider, providerId: 0, name: 'fresh' }
    ps.put(fresh)
    expect(fresh.providerId).toBeGreaterThan(0) // 回填到入参对象
    expect(ps.get(fresh.providerId)!.name).toBe('fresh')
    // 再建一个拿到不同的 id
    const fresh2: Provider = { ...provider, providerId: 0, name: 'fresh2' }
    ps.put(fresh2)
    expect(fresh2.providerId).not.toBe(fresh.providerId)
    ps.close()
  })

  test('能打开 Go 版写出的库（老形状 id TEXT PK → 自动迁移）', async () => {
    const path = join(dir, 'go-written.db')
    // 按 Go store_sqlite.go 的旧 DDL 建库并写入旧版序列化的行（id 即名字、enabled 布尔）
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode=WAL')
    db.exec(`CREATE TABLE IF NOT EXISTS admin_providers (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
    db.exec(`CREATE TABLE IF NOT EXISTS admin_accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
    db.prepare(`INSERT INTO admin_providers (id, data) VALUES (?, ?)`).run(
      'go-p', JSON.stringify({
        id: 'go-p', accessKind: 'official', risk: 'low', stability: 'stable',
        api: 'openai-completions', baseUrl: 'https://go.example.com', enabled: true,
        priority: 1, credential: { apiKeyEnv: 'GO_KEY' },
        models: [{ id: 'gm', providerId: 'go-p', enabled: true, manual: false }],
      }),
    )
    db.prepare(`INSERT INTO admin_accounts (id, data) VALUES (?, ?)`).run(
      'go-a', JSON.stringify({ id: 'go-a', providerId: 'go-s', status: 'available', fails: 0, credential: {} }),
    )
    db.close()

    // 迁移规则：name = 老 id，state = 老 enabled ? active : paused，provider_id 自动分配
    const ps = await SQLiteProviderStore.open(path)
    const p = ps.getByName('go-p')
    expect(p).toBeDefined()
    expect(p!.providerId).toBeGreaterThan(0)
    expect(p!.name).toBe('go-p')
    expect(p!.state).toBe('active')
    expect((p as unknown as Record<string, unknown>).enabled).toBeUndefined() // 老字段已删
    expect(p!.credential.apiKeyEnv).toBe('GO_KEY')
    expect(p!.models[0]!.id).toBe('gm')
    const as = await SQLiteAccountStore.open(path)
    expect(as.get('go-a')!.status).toBe('available')
    ps.close(); as.close()
  })

  // 最老的数据形态：账号归属字段叫 sourceId（抽象「源」名），比 providerId 字符串更早。
  // 这个用例是回归护栏——曾经 migrateAccounts 只认 providerId，遇到 sourceId 形态会把
  // 归属静默写成 -1，账号从此永远 pick 不到（加了号却不轮询，且毫无报错）。
  test('最老形态：账号 sourceId → 解析成 Provider 内部 id（不是 -1）', async () => {
    const path = join(dir, 'legacy-sourceid.db')
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode=WAL')
    db.exec(`CREATE TABLE IF NOT EXISTS admin_providers (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
    db.exec(`CREATE TABLE IF NOT EXISTS admin_accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
    db.prepare(`INSERT INTO admin_providers (id, data) VALUES (?, ?)`).run(
      'zen', JSON.stringify({
        id: 'zen', accessKind: 'reverse', risk: 'high', riskNote: 'x',
        stability: 'beta', api: 'openai-completions', baseUrl: 'https://zen.example.com',
        enabled: true, priority: 1, credential: { apiKeyEnv: 'ZEN_KEY' }, models: [],
      }),
    )
    // 账号用 sourceId（最老字段名）指向「zen」
    db.prepare(`INSERT INTO admin_accounts (id, data) VALUES (?, ?)`).run(
      'zen-1', JSON.stringify({
        id: 'zen-1', sourceId: 'zen', status: 'available', fails: 0, credential: {},
      }),
    )
    db.close()

    const ps = await SQLiteProviderStore.open(path)
    const pid = ps.getByName('zen')!.providerId
    const as = await SQLiteAccountStore.open(path)
    const acct = as.get('zen-1')!
    expect(acct.providerId).toBe(pid) // 关键：解析成了真实 id，而不是 -1
    expect(acct.providerId).toBeGreaterThan(0)
    expect((acct as unknown as Record<string, unknown>).sourceId).toBeUndefined() // 老字段已清
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

    as.put({ id: 'wb-1', providerId: 1, status: 'available', fails: 0, credential: {} })
    const log = (ts: Date) => ({
      id: 0, ts, requestId: 'r', providerId: 3, providerName: 'wb-auto',
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
