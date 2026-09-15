// 管理面存储：Provider/Account 的 CRUD（对齐 Go internal/adminapi/store_sqlite.go）。
// admin.db 两表：admin_providers / admin_accounts（id TEXT PRIMARY KEY + data TEXT JSON blob），
// schema 与 Go 版完全一致，可互开对方写出的库。内存实现供测试与缺省装配。

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'
// node:sqlite 经 createRequire 加载（vite-node 不认识该内置模块，见 usage/store.ts）。
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
import type { Account, Provider } from '../model/index.ts'

export interface ProviderStore {
  list(): Provider[]
  get(id: string): Provider | undefined
  put(p: Provider): void
  delete(id: string): boolean
}

export interface AccountStore {
  list(): Account[]
  get(id: string): Account | undefined
  put(a: Account): void
  delete(id: string): boolean
}

function cloneProvider(p: Provider): Provider {
  return { ...p, models: p.models.map((m) => ({ ...m })) }
}

// ---- 内存实现（并发安全：JS 单线程，方法内无 await 即原子）----

export class MemoryProviderStore implements ProviderStore {
  private m = new Map<string, Provider>()

  constructor(seed?: Provider[]) {
    for (const p of seed ?? []) this.m.set(p.id, cloneProvider(p))
  }

  list(): Provider[] {
    return [...this.m.values()].map(cloneProvider)
  }

  get(id: string): Provider | undefined {
    const p = this.m.get(id)
    return p ? cloneProvider(p) : undefined
  }

  put(p: Provider): void {
    this.m.set(p.id, cloneProvider(p))
  }

  delete(id: string): boolean {
    return this.m.delete(id)
  }
}

export class MemoryAccountStore implements AccountStore {
  private m = new Map<string, Account>()

  constructor(seed?: Account[]) {
    for (const a of seed ?? []) this.m.set(a.id, { ...a })
  }

  list(): Account[] {
    return [...this.m.values()].map((a) => ({ ...a }))
  }

  get(id: string): Account | undefined {
    const a = this.m.get(id)
    return a ? { ...a } : undefined
  }

  put(a: Account): void {
    this.m.set(a.id, { ...a })
  }

  delete(id: string): boolean {
    return this.m.delete(id)
  }
}

// ---- SQLite 持久化 ----

type DB = InstanceType<typeof DatabaseSync>

// 打开（不存在则创建并建表）。schema 与 Go store_sqlite.go 完全一致。
async function openAdminDB(path: string): Promise<DB> {
  const dir = dirname(path)
  if (dir && dir !== '.') mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(path)
  // 与 Go 同口径：WAL + 繁忙等待
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA busy_timeout=5000')
  for (const ddl of [
    `CREATE TABLE IF NOT EXISTS admin_providers (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS admin_accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS admin_egresses (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
  ]) {
    db.exec(ddl)
  }
  return db
}

function parseRow<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

export class SQLiteProviderStore implements ProviderStore {
  private db: DB
  private constructor(db: DB) { this.db = db }

  static async open(path: string): Promise<SQLiteProviderStore> {
    return new SQLiteProviderStore(await openAdminDB(path))
  }

  close(): void {
    this.db.close()
  }

  list(): Provider[] {
    const rows = this.db.prepare(`SELECT data FROM admin_providers ORDER BY id`)
      .all() as unknown as { data: string }[]
    const out: Provider[] = []
    for (const r of rows) {
      const p = parseRow<Provider>(r.data)
      if (p) out.push(p)
    }
    return out
  }

  get(id: string): Provider | undefined {
    const row = this.db.prepare(`SELECT data FROM admin_providers WHERE id = ?`)
      .get(id) as unknown as { data: string } | undefined
    if (!row) return undefined
    return parseRow<Provider>(row.data)
  }

  put(p: Provider): void {
    this.db.prepare(`INSERT INTO admin_providers (id, data) VALUES (?, ?)
      ON CONFLICT (id) DO UPDATE SET data = excluded.data`).run(p.id, JSON.stringify(p))
  }

  delete(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM admin_providers WHERE id = ?`).run(id)
    return res.changes > 0
  }
}

export class SQLiteAccountStore implements AccountStore {
  private db: DB
  private constructor(db: DB) { this.db = db }

  static async open(path: string): Promise<SQLiteAccountStore> {
    return new SQLiteAccountStore(await openAdminDB(path))
  }

  close(): void {
    this.db.close()
  }

  list(): Account[] {
    const rows = this.db.prepare(`SELECT data FROM admin_accounts ORDER BY id`)
      .all() as unknown as { data: string }[]
    const out: Account[] = []
    for (const r of rows) {
      const a = parseRow<Account>(r.data)
      if (a) out.push(a)
    }
    return out
  }

  get(id: string): Account | undefined {
    const row = this.db.prepare(`SELECT data FROM admin_accounts WHERE id = ?`)
      .get(id) as unknown as { data: string } | undefined
    if (!row) return undefined
    return parseRow<Account>(row.data)
  }

  put(a: Account): void {
    this.db.prepare(`INSERT INTO admin_accounts (id, data) VALUES (?, ?)
      ON CONFLICT (id) DO UPDATE SET data = excluded.data`).run(a.id, JSON.stringify(a))
  }

  delete(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM admin_accounts WHERE id = ?`).run(id)
    return res.changes > 0
  }
}

// ---- 播种（YAML bootstrap）：仅空库时写入，DB 之后是唯一真相源 ----

export function seedProvidersIfEmpty(s: ProviderStore, seed: Provider[]): void {
  if (s.list().length > 0) return
  for (const p of seed) s.put(p)
}

export function seedAccountsIfEmpty(s: AccountStore, seed: Account[]): void {
  if (s.list().length > 0) return
  for (const a of seed) s.put(a)
}

// ---- 出口代理（egress）----

export interface EgressDef {
  id: string
  kind: string
  addr: string
}

export interface EgressStore {
  list(): EgressDef[]
  get(id: string): EgressDef | undefined
  put(e: EgressDef): void
  delete(id: string): boolean
}

export class MemoryEgressStore implements EgressStore {
  private m = new Map<string, EgressDef>()
  list(): EgressDef[] { return [...this.m.values()].map((e) => ({ ...e })) }
  get(id: string): EgressDef | undefined { const e = this.m.get(id); return e ? { ...e } : undefined }
  put(e: EgressDef): void { this.m.set(e.id, { ...e }) }
  delete(id: string): boolean { return this.m.delete(id) }
}

export class SQLiteEgressStore implements EgressStore {
  private db: DB
  private constructor(db: DB) { this.db = db }

  static async open(path: string): Promise<SQLiteEgressStore> {
    const db = await openAdminDB(path)
    return new SQLiteEgressStore(db)
  }

  list(): EgressDef[] {
    const rows = this.db.prepare(`SELECT data FROM admin_egresses ORDER BY id`)
      .all() as unknown as { data: string }[]
    return rows.map((r) => parseRow<EgressDef>(r.data)).filter((e): e is EgressDef => !!e)
  }

  get(id: string): EgressDef | undefined {
    const row = this.db.prepare(`SELECT data FROM admin_egresses WHERE id = ?`)
      .get(id) as unknown as { data: string } | undefined
    return row ? parseRow<EgressDef>(row.data) : undefined
  }

  put(e: EgressDef): void {
    this.db.prepare(`INSERT INTO admin_egresses (id, data) VALUES (?, ?)
      ON CONFLICT (id) DO UPDATE SET data = excluded.data`).run(e.id, JSON.stringify(e))
  }

  delete(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM admin_egresses WHERE id = ?`).run(id)
    return res.changes > 0
  }
}
