// 用量统计 SQLite 持久化（对齐 Go internal/usage/store.go 语义；node:sqlite 零原生依赖）。
// 硬规则：cacheRead/cacheCreation 独立字段存储，绝不混入 input；
// accuracy 原样保存（估算值仅展示不可计费）；P0 不记金额。
//
// schema 版本（PRAGMA user_version，前向迁移）：
//   v1 → v2（2026-09-13，ACCOUNT-HEALTH）：加 error_kind 列（失败原因分类）。
//   v2 → v3（2026-09-16，去 sourceId）：删掉 source_id 列（它与 provider_id 恒等，
//     是「源」这个已删概念的残留）。SQLite 的 DROP COLUMN 支持有限，用重建表迁移。
//   v3 → v4（2026-09-16，Provider 身份拆分）：provider_id 由「Provider 名」改为
//     数字内部 id（Provider.providerId），并新增 provider_name 快照列供归因展示——
//     名字才是用户的心智单位，删除后重建同名不该在归因表里裂成两行。
//   迁移模式：建表 DDL 恒为最新形态；旧库按 user_version 判断，缺列则 ALTER，
//   迁移必须幂等（重复打开不重复迁）。

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'
// node:sqlite 是 Node 22.13+ 新内置模块；经 createRequire 加载以绕开 vite-node
// 的模块解析（它不认识该内置模块，会把 "node:sqlite" 当 npm 包 "sqlite" 找）。
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
import type { UsageLog, UsageStatus } from '../model/index.ts'

const SCHEMA_VERSION = 4

export interface Summary {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  reasoningTokens: number
  totalTokens: number
  errors: number
}

export interface DailyPoint {
  day: string // YYYY-MM-DD（本地时区）
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  errors: number
}

export interface ModelPoint {
  providerId: number
  modelId: string
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  // 缓存写入（prompt caching 的"存进缓存"部分）。只有 anthropic-messages 上游会报，
  // OpenAI 系恒 0 = 「上游没给」而非「真的没写」。与 totals 同口径，供表格加合核对。
  cacheCreationTokens: number
  totalTokens: number
  errors: number
  // 该模型的缓存命中率 = 缓存读取 / 总输入（见 hitRate）。
  // 无输入侧流量为 null（显示 —，不假装 0）。
  cacheHitRate: number | null
  // TPS（DSH 口径，P2）：总输出 / 总「生成段」耗时（tok/s）。
  // 守卫：status='ok' AND stream=1 AND first_token_ms>0 AND latency_ms>first_token_ms。
  // 无样本时 avgTps/avgTtftMs 为 null（缺数据不产出 0.0，前端显示 —）。
  avgTps: number | null
  avgTtftMs: number | null
  sampled: number
}

export interface Breakdown {
  totals: Summary & { cacheHitRate: number }
  daily: DailyPoint[]
  byModel: ModelPoint[]
}

// 账号维度用量（ACCOUNT-HEALTH §3.4）：哪个号被限额，一眼认出来。
export interface ModelUsage {
  modelId: string
  requests: number
  errors: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface AccountUsage {
  // 空 account_id = Provider 级凭据，单独成组（诚实表达，不隐藏）。
  accountId: string
  requests: number
  errors: number
  errorRate: number // errors / requests
  byKind: Record<string, number> // quota / rate_limit / auth / …
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  lastErrorAt?: Date
  lastErrorKind?: string
  models: ModelUsage[]
}

export class Store {
  // 用量落盘与聚合：insertLog 按上游 wire 口径（input + output）求 total；
  // summarize/breakdown/accountBreakdown 读时重算总量（不读存量列，历史脏行不污染口径）。
  private db: InstanceType<typeof DatabaseSync>

  private constructor(db: InstanceType<typeof DatabaseSync>) { this.db = db }

  // 打开（不存在则创建并建表）。自动建父目录；旧库按 user_version 前向迁移。
  static async open(path: string): Promise<Store> {
    const dir = dirname(path)
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(path)
    // WAL + 繁忙等待：单进程并发写不报 database is locked
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA busy_timeout=5000')
    db.exec('PRAGMA foreign_keys=ON')
    db.exec(`CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      provider_id INTEGER NOT NULL,
      provider_name TEXT NOT NULL DEFAULT '',
      account_id TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      accuracy TEXT NOT NULL DEFAULT '',
      latency_ms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT '',
      egress_id TEXT NOT NULL DEFAULT '',
      node_id TEXT NOT NULL DEFAULT '',
      stream INTEGER NOT NULL DEFAULT 0,
      first_token_ms INTEGER NOT NULL DEFAULT 0,
      error_kind TEXT NOT NULL DEFAULT ''
    )`)
    migrate(db)
    return new Store(db)
  }

  close(): void {
    this.db.close()
  }

  // 写入一条用量记录。total_tokens = input + output（上游 wire 总量口径）。
  // 旧库曾有 7 条 account_id='-' 脏数据（历史写入，已整体清空），此处守卫防复发。
  async insertLog(l: UsageLog): Promise<void> {
    const total = Store.totalOf(l.inputTokens, l.outputTokens, l.cacheCreationTokens)
    const accountId = l.accountId === '-' ? '' : (l.accountId ?? '')
    this.db.prepare(`INSERT INTO usage_logs
      (ts, request_id, provider_id, provider_name, account_id, model_id,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       reasoning_tokens, total_tokens, accuracy, latency_ms, status,
       egress_id, node_id, stream, first_token_ms, error_kind)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        l.ts.getTime(), l.requestId, l.providerId, l.providerName, accountId, l.modelId,
        l.inputTokens, l.outputTokens, l.cacheReadTokens, l.cacheCreationTokens,
        l.reasoningTokens, total, l.accuracy, l.latencyMs, l.status,
        l.egressId ?? '', l.nodeId ?? '', l.stream ? 1 : 0, l.firstTokenMs ?? 0, l.errorKind ?? '',
      )
  }

  // 把「名字」型 provider_id 解析成数字（v3 迁移第二步，见 resolveProviderIds）。
  resolveProviderIds(lookup: (name: string) => number | undefined): number {
    return resolveProviderIds(this.db, lookup)
  }

  rowToLog(r: Record<string, unknown>): UsageLog {
    return {
      id: r.id as number,
      ts: new Date(r.ts as number),
      requestId: r.request_id as string,
      providerId: r.provider_id as number,
      providerName: (r.provider_name as string) ?? '',
      accountId: r.account_id as string,
      modelId: r.model_id as string,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      cacheReadTokens: r.cache_read_tokens as number,
      cacheCreationTokens: r.cache_creation_tokens as number,
      reasoningTokens: r.reasoning_tokens as number,
      totalTokens: r.total_tokens as number,
      accuracy: r.accuracy as string,
      latencyMs: r.latency_ms as number,
      status: r.status as UsageStatus,
      errorKind: r.error_kind as string,
      egressId: r.egress_id as string,
      nodeId: r.node_id as string,
      stream: (r.stream as number) !== 0,
      firstTokenMs: r.first_token_ms as number,
    }
  }

  // 按时间倒序返回最近 limit 条。
  async recent(limit: number): Promise<UsageLog[]> {
    const rows = this.db.prepare(
      `SELECT * FROM usage_logs ORDER BY ts DESC, id DESC LIMIT ?`,
    ).all(limit) as unknown as Record<string, unknown>[]
    return rows.map((r) => this.rowToLog(r))
  }

  // 区间过滤 SQL 片段：until 为零值/缺省 = 不设上界（向后兼容「至今」）。
  private static range(until?: Date): string {
    return until && until.getTime() > 0 ? ' AND ts < @until' : ''
  }

  private params(since: Date, until?: Date, accountId = ''): Record<string, string | number> {
    const p: Record<string, string | number> = { since: since.getTime() }
    if (until && until.getTime() > 0) p.until = until.getTime()
    if (accountId) p.accountId = accountId
    return p
  }

  // 聚合 since（含）之后、until（不含）之前的请求；accountID 非空时只统计该账号。
  // 总量 = input + output（上游 wire 总量口径），逐组求和再汇总。
  // 总量不读存量 total_tokens 列，一律读时重算——历史脏行（旧公式另加 creation）不再污染口径。
  async summarize(since: Date, until?: Date, accountId = ''): Promise<Summary> {
    const acct = accountId ? ' AND account_id = @accountId' : ''
    const rows = this.db.prepare(`SELECT
      COUNT(*) AS requests,
      provider_id AS providerId,
      COALESCE(SUM(input_tokens),0) AS inputTokens,
      COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,
      COALESCE(SUM(cache_creation_tokens),0) AS cacheCreationTokens,
      COALESCE(SUM(reasoning_tokens),0) AS reasoningTokens,
      COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END),0) AS errors
      FROM usage_logs WHERE ts >= @since${Store.range(until)}${acct}
      GROUP BY provider_id`).all(this.params(since, until, accountId)) as unknown as
      { requests: number; providerId: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; reasoningTokens: number; errors: number }[]
    const sum: Summary = {
      requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, reasoningTokens: 0, totalTokens: 0, errors: 0,
    }
    for (const r of rows) {
      sum.requests += r.requests
      sum.inputTokens += r.inputTokens
      sum.outputTokens += r.outputTokens
      sum.cacheReadTokens += r.cacheReadTokens
      sum.cacheCreationTokens += r.cacheCreationTokens
      sum.reasoningTokens += r.reasoningTokens
      sum.errors += r.errors
      sum.totalTokens += Store.totalOf(r.inputTokens, r.outputTokens, r.cacheCreationTokens)
    }
    return sum
  }

  // ---- 总量与命中率（与命中率同判据）----

  // 单行总量 = 上游 wire 总量：input + output。
  // OpenAI 系（workbuddy/zen，openai-completions/responses）prompt_tokens 已含
  // cached 全量，wire total = prompt + completion；cacheCreation（miss）是 prompt
  // 的子集，另加即重复计数（实抓：prompt=425/cached=320/miss=105 时 wire=435，
  // input+creation+output=540）。Anthropic 系三桶互斥，理论总量应另加 read+creation，
  // 但本机现行流量 100% OpenAI 系（全库无 read>input），YAGNI 不做语义分支；
  // 若日后 Anthropic 流量出现（read>input），再加 protocol 列分支。
  // reasoning 已含于 output，不重复计。
  private static totalOf(
    inputTokens: number, outputTokens: number, _cacheCreationTokens = 0,
  ): number {
    return inputTokens + outputTokens
  }

  // 命中率 = 缓存读取 / 总输入（用户口径：命中了多少输入）。
  // OpenAI 系 input（prompt_tokens）已含 cached → 总输入 = input 本身。
  // 无输入返回 null（缺数据不产出 0.0，前端显示 —）。
  private hitRate(
    inputTokens: number, cacheReadTokens: number, _cacheCreationTokens = 0,
  ): number | null {
    return inputTokens > 0 ? cacheReadTokens / inputTokens : null
  }

  // 仪表盘聚合：区间合计 + 每日序列 + 按模型归因（byModel 按总 token 降序）。
  // accountID 非空时全部分组只统计该账号（ACCOUNT-HEALTH：详情页复用 breakdown）。
  async breakdown(since: Date, until?: Date, accountId = ''): Promise<Breakdown> {
    const sum = await this.summarize(since, until, accountId)
    // 合计命中率 = 总缓存读取 / 总输入。零命中源计入分母（不稀释不行）：
    // 旧实现 `if (g.cacheReadTokens === 0) continue` 把零命中源的输入整个丢掉，
    // 分母虚小而命中率虚高。
    const perProv = this.db.prepare(`SELECT
      provider_id AS providerId,
      COALESCE(SUM(input_tokens),0) AS inputTokens,
      COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens
      FROM usage_logs WHERE ts >= @since${Store.range(until)}${accountId ? ' AND account_id = @accountId' : ''}
      GROUP BY provider_id`).all(this.params(since, until, accountId)) as unknown as
      { providerId: number; inputTokens: number; cacheReadTokens: number }[]
    let hitNum = 0
    let inputDenom = 0
    for (const g of perProv) {
      hitNum += g.cacheReadTokens
      inputDenom += g.inputTokens
    }
    const cacheHitRate = inputDenom > 0 ? hitNum / inputDenom : 0
    const acct = accountId ? ' AND account_id = @accountId' : ''
    const p = this.params(since, until, accountId)

    const daily = this.db.prepare(`SELECT
      strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') AS day,
      COUNT(*) AS requests,
      provider_id AS providerId,
      COALESCE(SUM(input_tokens),0) AS inputTokens,
      COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,
      COALESCE(SUM(cache_creation_tokens),0) AS cacheCreationTokens,
      COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END),0) AS errors
      FROM usage_logs WHERE ts >= @since${Store.range(until)}${acct}
      GROUP BY day, provider_id ORDER BY day ASC`)
      .all(p) as unknown as (DailyPoint & { providerId: number })[]
    // daily 按 (day, provider) 分开算总量再合（总量 = input + output，合起来即对）。
    const dailyMerged = new Map<string, DailyPoint>()
    for (const r of daily) {
      const total = Store.totalOf(r.inputTokens, r.outputTokens, r.cacheCreationTokens)
      const acc = dailyMerged.get(r.day)
      if (!acc) {
        const { providerId: _drop, ...rest } = r
        dailyMerged.set(r.day, { ...rest, totalTokens: total })
      } else {
        acc.requests += r.requests
        acc.inputTokens += r.inputTokens
        acc.outputTokens += r.outputTokens
        acc.cacheReadTokens += r.cacheReadTokens
        acc.cacheCreationTokens += r.cacheCreationTokens
        acc.totalTokens += total
        acc.errors += r.errors
      }
    }
    const dailyPoints = [...dailyMerged.values()]

    // TPS 守卫条件（DSH 口径，TPS-METRIC §3.5）：成功 + 流式 + 首字有效 + decode>0。
    // 分子分母同口径，否则错位会算出离谱值；无样本返回 NULL（缺数据不产出 0.0）。
    const guard = `status='ok' AND stream=1 AND first_token_ms > 0 AND latency_ms > first_token_ms`
    const byModel = this.db.prepare(`SELECT
      provider_id AS providerId, provider_name AS providerName, model_id AS modelId,
      COUNT(*) AS requests,
      COALESCE(SUM(input_tokens),0) AS inputTokens,
      COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,
      COALESCE(SUM(cache_creation_tokens),0) AS cacheCreationTokens,
      COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END),0) AS errors,
      SUM(CASE WHEN ${guard} THEN 1 ELSE 0 END) AS sampled,
      CASE WHEN SUM(CASE WHEN ${guard} THEN 1 ELSE 0 END) > 0
      THEN SUM(CASE WHEN ${guard} THEN output_tokens ELSE 0 END) * 1000.0
           / SUM(CASE WHEN ${guard} THEN latency_ms - first_token_ms ELSE 0 END)
      ELSE NULL END AS avgTps,
      AVG(CASE WHEN first_token_ms > 0 THEN first_token_ms END) AS avgTtftMs
      FROM usage_logs WHERE ts >= @since${Store.range(until)}${acct}
      GROUP BY provider_id, provider_name, model_id`)
      .all(p) as unknown as ModelPoint[]

    // 每行补总量与命中率（与 totals 同源：总量 = input + output，命中率 = read / input）
    for (const m of byModel) {
      m.totalTokens = Store.totalOf(m.inputTokens, m.outputTokens, m.cacheCreationTokens)
      m.cacheHitRate = this.hitRate(m.inputTokens, m.cacheReadTokens, m.cacheCreationTokens)
    }
    // byModel 按总量降序：SQL 侧不再 ORDER（总量是 TS 侧重算的，SQL 排不准），
    // 统一由 TS 侧重排。
    byModel.sort((a, b) => b.totalTokens - a.totalTokens)

    return { totals: { ...sum, cacheHitRate }, daily: dailyPoints, byModel }
  }

  // 账号维度聚合（ACCOUNT-HEALTH §3.4）：
  // GROUP BY account_id；ByKind 按 (account_id, error_kind) 二级分组拼装（加新 kind 不改 SQL）；
  // 模型拆分子查询；空 account_id 单独成组（Provider 级凭据，诚实表达不隐藏）。
  // 总量 = input + output，按 (account_id, provider_id) / (account_id, provider_id, model_id)
  // 分组重算再汇总，避免账号页与仪表盘口径分裂。
  async accountBreakdown(since: Date, until?: Date): Promise<AccountUsage[]> {
    const p = this.params(since, until)
    const range = Store.range(until)

    interface AggRow { accountId: string; providerId: number; requests: number; errors: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
    const agg = this.db.prepare(`SELECT
      account_id AS accountId, provider_id AS providerId,
      COUNT(*) AS requests,
      COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END),0) AS errors,
      COALESCE(SUM(input_tokens),0) AS inputTokens,
      COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,
      COALESCE(SUM(cache_creation_tokens),0) AS cacheCreationTokens
      FROM usage_logs WHERE ts >= @since${range}
      GROUP BY account_id, provider_id`).all(p) as unknown as AggRow[]

    interface ModelAggRow extends AggRow { modelId: string }
    const modelAgg = this.db.prepare(`SELECT
      account_id AS accountId, provider_id AS providerId, model_id AS modelId,
      COUNT(*) AS requests,
      COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END),0) AS errors,
      COALESCE(SUM(input_tokens),0) AS inputTokens,
      COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,
      COALESCE(SUM(cache_creation_tokens),0) AS cacheCreationTokens
      FROM usage_logs WHERE ts >= @since${range}
      GROUP BY account_id, provider_id, model_id`).all(p) as unknown as ModelAggRow[]

    interface KindRow { accountId: string; errorKind: string; n: number }
    const kinds = this.db.prepare(`SELECT
      account_id AS accountId, error_kind AS errorKind, COUNT(*) AS n
      FROM usage_logs WHERE ts >= @since${range} AND status != 'ok' AND error_kind != ''
      GROUP BY account_id, error_kind`).all(p) as unknown as KindRow[]

    // 注意：SQLite 对 GROUP BY 裸列（非聚合列）取哪一行是未定义的，不保证是 MAX(ts) 行。
    // 此处 errorKind 仅作近似展示；要严格的“最近失败原因”须子查询/ORDER BY+LIMIT。
    interface LastErrRow { accountId: string; errorKind: string; lastErrorAt: number }
    const lastErrs = this.db.prepare(`SELECT
      account_id AS accountId, error_kind AS errorKind, MAX(ts) AS lastErrorAt
      FROM usage_logs WHERE ts >= @since${range} AND status != 'ok'
      GROUP BY account_id`).all(p) as unknown as LastErrRow[]

    interface ModelRow { accountId: string; modelId: string; requests: number; errors: number; inputTokens: number; outputTokens: number; totalTokens: number }

    const byKindMap = new Map<string, Record<string, number>>()
    for (const k of kinds) {
      const m = byKindMap.get(k.accountId) ?? {}
      m[k.errorKind] = k.n
      byKindMap.set(k.accountId, m)
    }
    const lastErrMap = new Map(lastErrs.map((e) => [e.accountId, e]))
    interface TotAcc { requests: number; errors: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; totalTokens: number }
    const totalsMap = new Map<string, TotAcc>()
    const accOf = (id: string): TotAcc => {
      let a = totalsMap.get(id)
      if (!a) { a = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 }; totalsMap.set(id, a) }
      return a
    }
    for (const r of agg) {
      const a = accOf(r.accountId)
      a.requests += r.requests
      a.errors += r.errors
      a.inputTokens += r.inputTokens
      a.outputTokens += r.outputTokens
      a.cacheReadTokens += r.cacheReadTokens
      a.totalTokens += Store.totalOf(r.inputTokens, r.outputTokens, r.cacheCreationTokens)
    }
    const modelsMap = new Map<string, ModelUsage[]>()
    for (const m of modelAgg) {
      const arr = modelsMap.get(m.accountId) ?? []
      arr.push({
        modelId: m.modelId, requests: m.requests, errors: m.errors,
        inputTokens: m.inputTokens, outputTokens: m.outputTokens,
        totalTokens: Store.totalOf(m.inputTokens, m.outputTokens, m.cacheCreationTokens),
      })
      modelsMap.set(m.accountId, arr)
    }

    return [...totalsMap].map(([accountId, t]) => {
      const last = lastErrMap.get(accountId)
      return {
        accountId,
        requests: t.requests,
        errors: t.errors,
        errorRate: t.requests > 0 ? t.errors / t.requests : 0,
        byKind: byKindMap.get(accountId) ?? {},
        totalTokens: t.totalTokens,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        cacheReadTokens: t.cacheReadTokens,
        ...(last ? { lastErrorAt: new Date(last.lastErrorAt), lastErrorKind: last.errorKind } : {}),
        models: (modelsMap.get(accountId) ?? []).sort((a, b) => b.totalTokens - a.totalTokens),
      }
    })
  }
}

// 前向迁移。幂等：列已存在则跳过，只推进 user_version。
// 每次迁移都先探测当前列形态，再决定做什么——不假设旧库停在哪一版。
function migrate(db: InstanceType<typeof DatabaseSync>): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (row.user_version >= SCHEMA_VERSION) return
  const cols = db.prepare('PRAGMA table_info(usage_logs)').all() as { name: string }[]
  const has = (n: string) => cols.some((c) => c.name === n)
  // v1 → v2
  if (!has('error_kind')) {
    db.exec(`ALTER TABLE usage_logs ADD COLUMN error_kind TEXT NOT NULL DEFAULT ''`)
  }
  // v3：老库的 provider_id 是「Provider 名」（TEXT），要换成数字内部 id。
  // 名字映射由 admin.db 侧提供（resolveProviderId）；映射不到的（Provider 早被
  // 彻底删掉、连 deleted 行都没了）保留 -1 并留名字快照，归因仍能显示。
  const pidIsText = (db.prepare('PRAGMA table_info(usage_logs)').all() as { name: string; type: string }[])
    .find((c) => c.name === 'provider_id')?.type?.toUpperCase().includes('TEXT') ?? false
  const needsRebuild = has('source_id') || pidIsText || !has('provider_name')
  if (needsRebuild) {
    db.exec('BEGIN')
    try {
      // provider_name 的取值来源，按库龄分三种（写错会静默丢光历史归因）：
      //   已有 provider_name 列       → 直接读它
      //   没有但 provider_id 是 TEXT  → 那是 v1/v2/v3 的「名字」，读 provider_id 列
      //   其余（provider_id 已是数字） → 没有名字可继承，空串
      // 注意第 2 条：v3 库的名字只存在于 provider_id 那一列，且迁移是 DROP+RENAME
      // 不可逆——这里读错就等于把 5576 行历史归因全变成「未知」。
      const nameExpr = has('provider_name') ? 'provider_name' : (pidIsText ? 'provider_id' : "''")
      db.exec(`CREATE TABLE usage_logs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        provider_id INTEGER NOT NULL,
        provider_name TEXT NOT NULL DEFAULT '',
        account_id TEXT NOT NULL DEFAULT '',
        model_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        accuracy TEXT NOT NULL DEFAULT 'unknown',
        latency_ms INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ok',
        egress_id TEXT NOT NULL DEFAULT '',
        node_id TEXT NOT NULL DEFAULT '',
        stream INTEGER NOT NULL DEFAULT 0,
        first_token_ms INTEGER NOT NULL DEFAULT 0,
        error_kind TEXT NOT NULL DEFAULT '')`)
      db.exec(`INSERT INTO usage_logs_new
        (id, ts, request_id, provider_id, provider_name, account_id, model_id,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         reasoning_tokens, total_tokens, accuracy, latency_ms, status,
         egress_id, node_id, stream, first_token_ms, error_kind)
        SELECT id, ts, request_id, 0, ${nameExpr}, account_id, model_id,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         reasoning_tokens, total_tokens, accuracy, latency_ms, status,
         egress_id, node_id, stream, first_token_ms,
         ${has('error_kind') ? 'error_kind' : "''"}
        FROM usage_logs`)
      db.exec('DROP TABLE usage_logs')
      db.exec('ALTER TABLE usage_logs_new RENAME TO usage_logs')
      db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_logs(ts)`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`)
}

// v3 迁移的第二步：把「名字」型 provider_id 解析成数字。
// admin.db 是名字→id 的权威来源；由 cli 在两边都打开后调用。
// 解析不到的（Provider 早已物理不存在）→ -1，并保留 provider_name 供展示。
export function resolveProviderIds(
  db: InstanceType<typeof DatabaseSync>,
  lookup: (name: string) => number | undefined,
): number {
  const rows = db.prepare(
    `SELECT DISTINCT provider_name FROM usage_logs WHERE provider_id = 0 AND provider_name != ''`)
    .all() as unknown as { provider_name: string }[]
  let fixed = 0
  const upd = db.prepare('UPDATE usage_logs SET provider_id = ? WHERE provider_name = ? AND provider_id = 0')
  for (const r of rows) {
    const id = lookup(r.provider_name)
    if (id !== undefined) {
      upd.run(id, r.provider_name)
      fixed++
    }
  }
  // 剩下的（查不到对应 Provider）标记 -1：仍是「未知来源」，但归因行靠 provider_name 显示。
  db.prepare(`UPDATE usage_logs SET provider_id = -1 WHERE provider_id = 0`).run()
  return fixed
}
