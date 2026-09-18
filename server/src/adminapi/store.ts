// 管理面存储：Provider/Account 的 CRUD（对齐 Go internal/adminapi/store_sqlite.go）。
// admin.db 两表：admin_providers / admin_accounts（id TEXT PRIMARY KEY + data TEXT JSON blob），
// schema 与 Go 版完全一致，可互开对方写出的库。内存实现供测试与缺省装配。

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'
// node:sqlite 经 createRequire 加载（vite-node 不认识该内置模块，见 usage/store.ts）。
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
import type { Account, Model, Provider } from '../model/index.ts'

export interface ProviderStore {
  list(): Provider[]
  // 按内部 id 定位（改名不影响）。
  get(providerId: number): Provider | undefined
  // 按对外名查（路由解析前缀、判重）。
  getByName(name: string): Provider | undefined
  // providerId 为 0 = 新建（存储层分配并回填）。
  put(p: Provider): void
  delete(providerId: number): boolean
}

export interface AccountStore {
  list(): Account[]
  get(id: string): Account | undefined
  put(a: Account): void
  delete(id: string): boolean
}

// cloneProvider 是所有读写经过的咽喉点：这里顺带把模型对象收敛到 Model 的合法字段。
//
// 为什么必须在存储层做（而不是只靠 parse.ts 的入参收敛）：
// Model 接口没有 providerId 字段，但历史写入（早期夹具/迁移/某次 PATCH 把整条旧对象
// 带回）把 `providerId: ""` 塞进了 models，之后每次 PATCH 都会把这条脏对象原样写回，
// **永远洗不掉**——实测 6 个 Provider 的模型全带这个字段，其中 senseaudio 37 条全中。
// 入参收敛管不到"已经在库里的"，只有存储层的读/写都过一遍才能自愈。
// 白名单与 parse.ts 的 parseModel 保持一致；新增 Model 字段时两处都要加。
function cleanModel(m: Model): Model {
  const out: Model = { id: m.id, manual: m.manual === true, enabled: m.enabled === true }
  if (typeof m.displayName === 'string') out.displayName = m.displayName
  if (typeof m.note === 'string' && m.note !== '') out.note = m.note
  if (typeof m.egress === 'string' && m.egress !== '') out.egress = m.egress
  // 高档位下限：只收 (0, 200000] 正整数值（防脏数据；键大小写由写入入口收敛，
  // 非法整体由 providerValidate 点名）。白名单与 parse.ts 的 parseModel 保持一致。
  if (m.reasoningMinTokens !== undefined && m.reasoningMinTokens !== null && typeof m.reasoningMinTokens === 'object' && !Array.isArray(m.reasoningMinTokens)) {
    const norm: Record<string, number> = {}
    for (const [k, val] of Object.entries(m.reasoningMinTokens)) {
      if (typeof val === 'number' && Number.isSafeInteger(val) && val > 0 && val <= 200000) {
        norm[k.trim().toLowerCase()] = val
      }
    }
    if (Object.keys(norm).length > 0) out.reasoningMinTokens = norm
  }
  if (typeof m.contextWindow === 'number') out.contextWindow = m.contextWindow
  if (typeof m.maxOutputTokens === 'number') out.maxOutputTokens = m.maxOutputTokens
  if (Array.isArray(m.input) && m.input.length > 0) out.input = [...m.input]
  if (typeof m.api === 'string' && m.api !== '') out.api = m.api
  return out
}

function cloneProvider(p: Provider): Provider {
  return { ...p, models: (p.models ?? []).map(cleanModel) }
}

// ---- 内存实现（并发安全：JS 单线程，方法内无 await 即原子）----

export class MemoryProviderStore implements ProviderStore {
  private m = new Map<number, Provider>()
  private seq = 0

  constructor(seed?: Provider[]) {
    for (const p of seed ?? []) {
      const q = cloneProvider(p)
      if (!(q.providerId > 0)) q.providerId = ++this.seq
      else this.seq = Math.max(this.seq, q.providerId)
      this.m.set(q.providerId, q)
    }
  }

  list(): Provider[] {
    return [...this.m.values()].map(cloneProvider)
  }

  getByName(name: string): Provider | undefined {
    const hits = [...this.m.values()].filter((p) => p.name === name)
    if (hits.length === 0) return undefined
    hits.sort((a, b) => (a.state === 'deleted' ? 1 : 0) - (b.state === 'deleted' ? 1 : 0)
      || b.providerId - a.providerId)
    return cloneProvider(hits[0]!)
  }

  get(providerId: number): Provider | undefined {
    const p = this.m.get(providerId)
    return p ? cloneProvider(p) : undefined
  }

  put(p: Provider): void {
    const q = cloneProvider(p)
    // 只有「安全正整数」才算已有 id；其余（0 / 负数 / NaN / Infinity / 小数）一律当新建分配。
    // 以前写的是 `!(id > 0)`：NaN 恰好被这条收住（NaN > 0 === false），但 Infinity > 0
    // 为真，会被当成合法 key 存进 Map（此后 get(Infinity) 能命中），负数则被静默改写。
    if (!(Number.isSafeInteger(q.providerId) && q.providerId > 0)) q.providerId = ++this.seq
    this.m.set(q.providerId, q)
    p.providerId = q.providerId
  }

  delete(providerId: number): boolean {
    return this.m.delete(providerId)
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

// 打开（不存在则创建并建表），并做前向迁移。
//
// admin_providers 的形状（2026-09-16 起）：
//   provider_id INTEGER PRIMARY KEY AUTOINCREMENT —— 内部唯一标识，永不变
//   name        TEXT NOT NULL                    —— 对外名（模型 ID 前缀），可改
//   state       TEXT NOT NULL                    —— active / paused / deleted（见 model 层）
//   data        TEXT NOT NULL                    —— 其余字段的 JSON
// 为什么把 name 从主键降级成普通列：主键一旦承载业务名，「改名」就等于换身份，
// 账号归属、用量归因、客户端里配的模型 ID 全部断裂。id 与名字必须分开。
async function openAdminDB(path: string): Promise<DB> {
  const dir = dirname(path)
  if (dir && dir !== '.') mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(path)
  // 与 Go 同口径：WAL + 繁忙等待
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA busy_timeout=5000')
  for (const ddl of [
    `CREATE TABLE IF NOT EXISTS admin_accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS admin_egresses (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
  ]) {
    db.exec(ddl)
  }
  migrateProviders(db)
  migrateAccounts(db)
  return db
}

// 账号的 providerId：早期存「Provider 名」（字符串），现在存内部数字 id。
// 名字→id 的权威来源是同一张库里的 admin_providers；查不到的（Provider 早已
// 物理删除）标 -1，账号仍能列出，只是不再参与轮询（pool 按 id 匹配不到）。
export function migrateAccounts(db: DB): void {
  const cols = db.prepare('PRAGMA table_info(admin_accounts)').all() as { name: string }[]
  if (cols.length === 0) return
  const rows = db.prepare('SELECT id, data FROM admin_accounts').all() as unknown as
    { id: string; data: string }[]
  const idByName = new Map<string, number>()
  for (const r of db.prepare('SELECT provider_id, name FROM admin_providers').all() as unknown as
    { provider_id: number; name: string }[]) {
    idByName.set(r.name, r.provider_id)
  }
  const upd = db.prepare('UPDATE admin_accounts SET data = ? WHERE id = ?')
  for (const r of rows) {
    const a = parseRow<{ providerId?: unknown; sourceId?: unknown }>(r.data)
    if (!a) continue
    if (typeof a.providerId === 'number') continue // 已是新形状（幂等）
    // 归属字段的历史沿革：sourceId（最老，抽象的「源」名）→ providerId 字符串
    // （= Provider 名）→ providerId 数字。两种旧形态都存的是「名字」，都要查表换 id。
    // 只认新字段名会让最老的数据静默变成 -1（账号从此不参与轮询），必须两个都读。
    const name = typeof a.providerId === 'string' ? a.providerId
      : typeof a.sourceId === 'string' ? a.sourceId : ''
    delete a.sourceId
    a.providerId = name === '' ? -1 : (idByName.get(name) ?? -1)
    upd.run(JSON.stringify(a), r.id)
  }
}

// 老库（admin_providers(id TEXT PRIMARY KEY, data)）→ 新形状。幂等：已是新形状则跳过。
//
// 搬迁规则：
//   provider_id 由 AUTOINCREMENT 分配（按老 id 排序，保证稳定）
//   name        = 老 id
//   state       = 老 data.enabled ? 'active' : 'paused'
//   data        = 老 JSON 去掉 id/enabled（其余字段原样保留）
export function migrateProviders(db: DB): void {
  const cols = db.prepare('PRAGMA table_info(admin_providers)').all() as { name: string }[]
  if (cols.length === 0) {
    db.exec(`CREATE TABLE admin_providers (
      provider_id INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      state       TEXT NOT NULL,
      data        TEXT NOT NULL)`)
    return
  }
  if (cols.some((c) => c.name === 'provider_id')) return // 已是新形状
  const rows = db.prepare('SELECT id, data FROM admin_providers ORDER BY id')
    .all() as unknown as { id: string; data: string }[]
  db.exec('BEGIN')
  try {
    db.exec(`CREATE TABLE admin_providers_new (
      provider_id INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      state       TEXT NOT NULL,
      data        TEXT NOT NULL)`)
    const ins = db.prepare(
      'INSERT INTO admin_providers_new (name, state, data) VALUES (?, ?, ?)')
    for (const r of rows) {
      const raw = parseRow<Record<string, unknown>>(r.data) ?? {}
      const state = raw.enabled === false ? 'paused' : 'active'
      delete raw.id
      delete raw.enabled
      ins.run(r.id, state, JSON.stringify(raw))
    }
    db.exec('DROP TABLE admin_providers')
    db.exec('ALTER TABLE admin_providers_new RENAME TO admin_providers')
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
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

  private rowToProvider(r: { provider_id: number; name: string; state: string; data: string }): Provider | undefined {
    const body = parseRow<Omit<Provider, 'providerId' | 'name' | 'state'>>(r.data)
    if (!body) return undefined
    // 必须同样过一遍 cleanModel：SQLite 路径不经过 cloneProvider，
    // 只在内存实现里收敛会让真实库的脏字段（models[].providerId）永远洗不掉。
    const p = { ...body, providerId: r.provider_id, name: r.name, state: r.state as Provider['state'] }
    return { ...p, models: (p.models ?? []).map(cleanModel) }
  }

  list(): Provider[] {
    const rows = this.db.prepare(
      `SELECT provider_id, name, state, data FROM admin_providers ORDER BY provider_id`)
      .all() as unknown as { provider_id: number; name: string; state: string; data: string }[]
    const out: Provider[] = []
    for (const r of rows) {
      const p = this.rowToProvider(r)
      if (p) out.push(p)
    }
    return out
  }

  get(providerId: number): Provider | undefined {
    // NaN / 非整数绝不进 SQL：node:sqlite 对 NaN 绑定的行为没有保证（可能直接抛错，
    // 而调用方大多没有 try/catch，会冒泡成 500——「不存在的 Provider」应当是 404）。
    // 内存实现里 Map.get(NaN) 恰好安全，两条路径的行为差异正是这个守卫要抹平的。
    if (!(Number.isSafeInteger(providerId) && providerId > 0)) return undefined
    const row = this.db.prepare(
      `SELECT provider_id, name, state, data FROM admin_providers WHERE provider_id = ?`)
      .get(providerId) as unknown as
      { provider_id: number; name: string; state: string; data: string } | undefined
    return row ? this.rowToProvider(row) : undefined
  }

  // 按名字查——路由解析模型 ID 前缀、发现页判重都走它。
  // 同名可能有历史的 deleted 行，取「非 deleted 优先，其次 provider_id 最大」。
  getByName(name: string): Provider | undefined {
    const row = this.db.prepare(
      `SELECT provider_id, name, state, data FROM admin_providers WHERE name = ?
       ORDER BY (state = 'deleted') ASC, provider_id DESC LIMIT 1`)
      .get(name) as unknown as
      { provider_id: number; name: string; state: string; data: string } | undefined
    return row ? this.rowToProvider(row) : undefined
  }

  // 写回：providerId 为 0 表示新建（由 AUTOINCREMENT 分配并回填）。
  put(p: Provider): void {
    const { name, state, ...body } = p
    const json = JSON.stringify(body)
    // 与内存实现同口径：只有安全正整数算已有 id，其余（0/负/NaN/Infinity/小数）当新建。
    // 判据必须是 isSafeInteger 而不只是 `> 0`：Infinity > 0 为真，会被当合法主键写进
    // AUTOINCREMENT 列（那里存得下，但此后任何按 id 的查找都对不上）。
    const providerId = Number.isSafeInteger(p.providerId) && p.providerId > 0 ? p.providerId : 0
    if (providerId > 0) {
      // upsert：带 id 写入时，行不存在也要落库。
      // 只用 UPDATE 的话，调用方（配置播种/夹具预置固定 id）会静默丢失写入——
      // 老实现以 id 作主键时是 UPSERT 语义，这个差别曾让一批"预置 Provider"变成 no-op。
      this.db.prepare(
        `INSERT INTO admin_providers (provider_id, name, state, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET name = excluded.name,
           state = excluded.state, data = excluded.data`)
        .run(providerId, name, state, json)
      return
    }
    const res = this.db.prepare(
      `INSERT INTO admin_providers (name, state, data) VALUES (?, ?, ?)`)
      .run(name, state, json)
    p.providerId = Number(res.lastInsertRowid)
  }

  delete(providerId: number): boolean {
    const res = this.db.prepare(`DELETE FROM admin_providers WHERE provider_id = ?`).run(providerId)
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
