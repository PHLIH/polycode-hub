// 管理面存储：Provider/Account 的 CRUD（对齐 Go internal/adminapi/store_sqlite.go）。
// admin.db 两表：admin_providers / admin_accounts（id TEXT PRIMARY KEY + data TEXT JSON blob），
// schema 与 Go 版完全一致，可互开对方写出的库。内存实现供测试与缺省装配。

import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'
// node:sqlite 经 createRequire 加载（vite-node 不认识该内置模块，见 usage/store.ts）。
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
import type { Account, Model, Provider } from '../model/index.ts'
import { wbAuxEndpointIdentityHeaders, workBuddyRealmOfBaseUrl } from '../model/index.ts'

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
  // 推理等级预设：小写收敛（应用侧按小写比）。非法值由 providerValidate 点名。
  if (typeof m.reasoningEffort === 'string' && m.reasoningEffort.trim() !== '') {
    out.reasoningEffort = m.reasoningEffort.trim().toLowerCase()
  }
  // 档位预算上限：只收正整数值（防脏数据；键大小写由写入入口收敛）。
  // 白名单与 parse.ts 的 parseModel 保持一致。
  if (m.reasoningMaxTokens !== undefined && m.reasoningMaxTokens !== null && typeof m.reasoningMaxTokens === 'object' && !Array.isArray(m.reasoningMaxTokens)) {
    const norm: Record<string, number> = {}
    for (const [k, val] of Object.entries(m.reasoningMaxTokens)) {
      if (typeof val === 'number' && Number.isSafeInteger(val) && val > 0) {
        norm[k.trim().toLowerCase()] = val
      }
    }
    if (Object.keys(norm).length > 0) out.reasoningMaxTokens = norm
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
  if (dir && dir !== '.') {
      // 0700：库里是凭据性材料（admin.db 有 Provider 完整 headers——zen 免费档
      // 指纹四件套，拿到即等于拿到调用凭据）。mode 对已存在目录不生效，
      // 故再 chmod 一次收紧存量（对齐 credential_file.ts 的写法）。
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch { /* 只读盘等场景不致命 */ }
    }
  const db = new DatabaseSync(path)
  // 与 Go 同口径：WAL + 繁忙等待
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA busy_timeout=5000')
  for (const ddl of [
    `CREATE TABLE IF NOT EXISTS admin_accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS admin_egresses (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
    // 种子账本的标记位：记录「哪些种子账号 id 已经播过种」。
    // 没有它就分不清「这个号从没进过库」和「用户主动删了」——两种情况在
    // admin_accounts 里都是「查不到」，补种逻辑只能二选一：
    //   一律补 → 用户删掉的号每重启一次就复活（实测过的真实回归）；
    //   一律不补 → 配置文件里新加的号永远进不来（就是本次要修的老缺陷）。
    // 所以额外记一笔：播过种的 id 永不再补，删除因此是终态。
    `CREATE TABLE IF NOT EXISTS admin_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
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

// reviveAccountDates 把 JSON round-trip 打扁的 Date 字段还原成 Date。
//
// 为什么必须有（真实缺陷，扫描实证）：Account 落盘是整对象 JSON.stringify，
// cooldownUntil/lastUsed（model/index.ts:292-293 声明为 Date）读回后变成
// **string**。而池与展示层的比较全写成 `now > a.cooldownUntil`（Date > string
// 走 ToPrimitive 后按字符串比，恒为 false）——冷却到期永远判不出来：
// 账号被限流一次，网关一重启就永久停在 cooldown，只能人工点重置。
// cli.ts 的注释还写着"惩罚已落盘，重启后照认"，实现正好反了。
// 根因修在反序列化出口（list/get 两处都过这里），所有比较点不用逐个改；
// 比较点侧的数值化防御由 pool/account.ts 的 asDate 兜底（两道保险）。
function reviveAccountDates(a: Account): Account {
  const revive = (v: unknown): Date | undefined => {
    if (v instanceof Date) return v
    if (typeof v === 'string' && v !== '') {
      const d = new Date(v)
      return Number.isNaN(d.getTime()) ? undefined : d
    }
    return undefined
  }
  const cooldownUntil = revive(a.cooldownUntil)
  const lastUsed = revive(a.lastUsed)
  if (cooldownUntil !== undefined || lastUsed !== undefined) {
    return { ...a, ...(cooldownUntil !== undefined ? { cooldownUntil } : {}), ...(lastUsed !== undefined ? { lastUsed } : {}) }
  }
  return a
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

  // 种子账本（与账号表同一个库，跨重启有效）。cli 播种时用它区分
  // 「从没播过种」与「用户删掉了」——见 seedAccountsIfEmpty 的注释。
  seedLedger(): SeedLedger {
    return new SQLiteSeedLedger(this.db)
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
      if (a) out.push(reviveAccountDates(a))
    }
    return out
  }

  get(id: string): Account | undefined {
    const row = this.db.prepare(`SELECT data FROM admin_accounts WHERE id = ?`)
      .get(id) as unknown as { data: string } | undefined
    if (!row) return undefined
    const a = parseRow<Account>(row.data)
    return a ? reviveAccountDates(a) : undefined
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

// 迁移：把已入库的 WorkBuddy Provider 的「使用端归因头」补齐。
//
// 为什么需要：seedProvidersIfEmpty 只在**空库**时播种，DB 一旦有行就是唯一真相源。
// 所以改了 Provider 草稿模板，**对已存在的行毫无影响** —— 重启会把管理台里
// 手工改过的头打回原样。这是实测踩到的：PATCH 改好后一重启就丢了。
//
// 判定按 baseUrl 的 host（workBuddyRealmOfBaseUrl 唯一定义），不看 Provider 名。
// 只补归因头，**不覆盖其它自定义头**；X-Domain 按版本派生。幂等。
//
// ⚠️ 这组头**不影响计费**（见 discover.wbSuggestedProvider 处的三组对照实测）。
// 它只让上游用量页的「使用端」列显示 WorkBuddy 而非 `-`。
export function migrateWorkBuddyAttributionHeaders(s: ProviderStore): number {
  let fixed = 0
  for (const p of s.list()) {
    if (p.state === 'deleted') continue
    const realm = workBuddyRealmOfBaseUrl(p.baseUrl)
    if (!realm) continue
    const domain = realm === 'ai' ? 'www.workbuddy.ai' : 'copilot.tencent.com'
    const want = { ...wbAuxEndpointIdentityHeaders(), 'X-Domain': domain }
    const cur = p.headers ?? {}
    // 已全部就位 → 跳过（幂等，避免每次启动写库）。
    if (Object.entries(want).every(([k, v]) => cur[k] === v)) continue
    p.headers = { ...cur, ...want }
    s.put(p)
    fixed++
  }
  return fixed
}

// 缺失补种：种子表里有、库里没有、且**从没播过种**的账号补进去。
//
// 为什么不能只认「空库才播种」：账号表一旦有别的渠道（如 workbuddy 先导了几行），
// apps.yaml 里的账号就永远进不来——静默丢失，管理台上看不到，池子里也不轮换。
//
// 为什么不能简单地「缺就补」：账号删除是硬删且没有墓碑，于是「从没进过库」
// 和「用户主动删了」在库里长得一模一样。只看 admin_accounts 的话，补种会把
// 用户明确删掉的号在每次重启时复活（实测复现过）。所以用 admin_meta 里的
// 已播种账本记住播过的 id：播过就不再补，删除是终态。
//
// 该用哪个函数：
//   · seedAccountsIfEmpty —— 需要「删除是终态」的持久化场景（cli 启动、管理面）。
//   · seedAccountsPlain    —— 内存库/测试等没有账本也不该复活的场景。
export function seedAccountsIfEmpty(s: AccountStore, seed: Account[], seen?: SeedLedger): void {
  for (const a of seed) {
    // 播过种的一律跳过（哪怕现在查不到——那是用户删的）。
    if (seen?.has(a.id)) continue
    if (s.get(a.id)) {
      // 库里已有（可能是用户导入后改过），记进账本即可，绝不覆盖。
      seen?.add(a.id)
      continue
    }
    s.put(a)
    seen?.add(a.id)
  }
}

// SeedLedger 记录已播种过的账号 id（落盘，跨重启有效）。
export interface SeedLedger {
  has(id: string): boolean
  add(id: string): void
}

export class SQLiteSeedLedger implements SeedLedger {
  constructor(private readonly db: DB) {}

  private read(): Set<string> {
    const row = this.db.prepare(`SELECT v FROM admin_meta WHERE k = 'seededAccountIds'`).get() as
      { v: string } | undefined
    if (!row) return new Set()
    try {
      const arr: unknown = JSON.parse(row.v)
      return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : new Set()
    } catch {
      return new Set()
    }
  }

  has(id: string): boolean {
    return this.read().has(id)
  }

  add(id: string): void {
    const set = this.read()
    if (set.has(id)) return
    set.add(id)
    this.db.prepare(
      `INSERT INTO admin_meta (k, v) VALUES ('seededAccountIds', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    ).run(JSON.stringify([...set]))
  }
}

// seedAccountsPlain 无账本版本：库里没有就补（用于内存库与单测）。
export function seedAccountsPlain(s: AccountStore, seed: Account[]): void {
  for (const a of seed) {
    if (s.get(a.id)) continue
    s.put(a)
  }
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
