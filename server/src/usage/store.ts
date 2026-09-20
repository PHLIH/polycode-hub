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
//   v4 → v5（2026-09-19，CACHE-SEMANTICS）：加 sem 列（'subset' | 'separate'），
//     标记该行三桶的计量语义。OpenAI 系 input 已含缓存命中（subset）；Anthropic 系
//     input 只算未命中部分，三桶互斥（separate）。聚合公式按行内 sem 分流，
//     不再一刀切 subset——那曾把 zcode 系（anthropic 协议）的命中率算成 1117%。
//   迁移模式：建表 DDL 恒为最新形态；旧库按 user_version 判断，缺列则 ALTER，
//   迁移必须幂等（重复打开不重复迁）。

import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'
// node:sqlite 是 Node 22.13+ 新内置模块；经 createRequire 加载以绕开 vite-node
// 的模块解析（它不认识该内置模块，会把 "node:sqlite" 当 npm 包 "sqlite" 找）。
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
import type { UsageLog, UsageStatus } from '../model/index.ts'

const SCHEMA_VERSION = 5

// 缓存语义。与 ir/types.ts 的 CacheSemantics 同词汇，此处独立声明避免
// usage 层反向依赖 ir（model → ir 已是依赖边，store 只依赖 model）。
export type CacheSem = 'subset' | 'separate'

export interface Summary {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  reasoningTokens: number
  totalTokens: number
  errors: number
  // 输入侧总量 = 命中率分母：subset 行是 input 本身；separate 行是三桶之和
  // （input+read+creation）。inputTokens 只存「未命中」部分的 separate 行在此
  // 才显出真实输入量。openai-completions 等老调用点若没带 sem，则与 input 相等。
  inputSideTokens: number
}

export interface DailyPoint {
  day: string // YYYY-MM-DD（本地时区）
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  // 推理 token（与 Summary/byModel 同口径；daily 此前漏了，逐日推理用量不可见）。
  reasoningTokens: number
  totalTokens: number
  errors: number
  // 输入侧总量（命中率分母口径），同 Summary.inputSideTokens。
  inputSideTokens: number
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
  // 该模型的缓存命中率 = 缓存读取 / 输入侧总量（见 hitRate）。
  // 无输入侧流量为 null（显示 —，不假装 0）。
  cacheHitRate: number | null
  // 输入侧总量（命中率分母口径），同 Summary.inputSideTokens。
  inputSideTokens: number
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
  // 输入侧总量（命中率分母口径），同 Summary.inputSideTokens。
  inputSideTokens: number
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
  // 输入侧总量（命中率分母口径），同 Summary.inputSideTokens。
  inputSideTokens: number
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
    if (dir && dir !== '.') {
      // 0700：库里是凭据性材料（admin.db 有 Provider 完整 headers——zen 免费档
      // 指纹四件套，拿到即等于拿到调用凭据）。mode 对已存在目录不生效，
      // 故再 chmod 一次收紧存量（对齐 credential_file.ts 的写法）。
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { chmodSync(dir, 0o700) } catch { /* 只读盘等场景不致命 */ }
    }
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
      error_kind TEXT NOT NULL DEFAULT '',
      sem TEXT NOT NULL DEFAULT ''
    )`)
    // ts 索引必须在建表后**无条件**创建：它原先只写在「重建表」那个分支里，
    // 于是全新安装的库从来没有这个索引 —— 而 summarize/breakdown/
    // accountBreakdown/recent 全部按 ts 过滤或排序，数据量上来后就是全表扫。
    // IF NOT EXISTS 保证重建分支再建一次也无副作用。
    db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_logs(ts)`)
    migrate(db)
    return new Store(db)
  }

  close(): void {
    this.db.close()
  }

  // 写入一条用量记录。total_tokens = input + output（subset 口径，旧列保留只为
  // 兼容；读路径一律重算，见各聚合查询的 totalExpr）。sem 缺省落 ''（= subset）。
  // 旧库曾有 7 条 account_id='-' 脏数据（历史写入，已整体清空），此处守卫防复发。
  async insertLog(l: UsageLog): Promise<void> {
    const total = Store.totalOf(l.inputTokens, l.outputTokens, l.cacheCreationTokens)
    const accountId = l.accountId === '-' ? '' : (l.accountId ?? '')
    this.db.prepare(`INSERT INTO usage_logs
      (ts, request_id, provider_id, provider_name, account_id, model_id,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       reasoning_tokens, total_tokens, accuracy, latency_ms, status,
       egress_id, node_id, stream, first_token_ms, error_kind, sem)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        l.ts.getTime(), l.requestId, l.providerId, l.providerName, accountId, l.modelId,
        l.inputTokens, l.outputTokens, l.cacheReadTokens, l.cacheCreationTokens,
        l.reasoningTokens, total, l.accuracy, l.latencyMs, l.status,
        l.egressId ?? '', l.nodeId ?? '', l.stream ? 1 : 0, l.firstTokenMs ?? 0, l.errorKind ?? '',
        l.sem === 'separate' ? 'separate' : '',
      )
  }

  // 把「名字」型 provider_id 解析成数字（v3 迁移第二步，见 resolveProviderIds）。
  resolveProviderIds(lookup: (name: string) => number | undefined): number {
    return resolveProviderIds(this.db, lookup)
  }

  // 历史行缓存语义回填（v5 迁移第二步，见 backfillSemantics）。
  backfillSemantics(protocolOf: (providerId: number, modelId: string) => string | undefined): number {
    return backfillSemantics(this.db, protocolOf)
  }

  // 数据库行 → UsageLog。仅本类内部使用（recent/查询都走它），不需要对外暴露。
  private rowToLog(r: Record<string, unknown>): UsageLog {
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
      sem: (r.sem as string) === 'separate' ? 'separate' : 'subset',
    }
  }

  // 按时间倒序返回最近 limit 条。
  // limit 必须钳制：SQLite 里 LIMIT -1 表示**不限量**，负数/NaN/超大值一旦从
  // HTTP 参数透进来就是全表返回（当前无外部入口，但接上 API 即变 DoS）。
  async recent(limit: number): Promise<UsageLog[]> {
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 50
    const rows = this.db.prepare(
      `SELECT * FROM usage_logs ORDER BY ts DESC, id DESC LIMIT ?`,
    ).all(n) as unknown as Record<string, unknown>[]
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
  // 按行内 sem 分流：总量与输入侧逐组按语义重算再汇总（不读存量列，历史脏行不污染口径）。
  async summarize(since: Date, until?: Date, accountId = ''): Promise<Summary> {
    const acct = accountId ? ' AND account_id = @accountId' : ''
    const rows = this.db.prepare(`SELECT
      COUNT(*) AS requests,
      provider_id AS providerId,
      sem AS sem,
      COALESCE(SUM(input_tokens),0) AS inputTokens,
      COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,
      COALESCE(SUM(cache_creation_tokens),0) AS cacheCreationTokens,
      COALESCE(SUM(reasoning_tokens),0) AS reasoningTokens,
      COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END),0) AS errors
      FROM usage_logs WHERE ts >= @since${Store.range(until)}${acct}
      GROUP BY provider_id, sem`).all(this.params(since, until, accountId)) as unknown as
      { requests: number; providerId: number; sem: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; reasoningTokens: number; errors: number }[]
    const sum: Summary = {
      requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, reasoningTokens: 0, totalTokens: 0, errors: 0,
      inputSideTokens: 0,
    }
    for (const r of rows) {
      const sem: CacheSem = r.sem === 'separate' ? 'separate' : 'subset'
      sum.requests += r.requests
      sum.inputTokens += r.inputTokens
      sum.outputTokens += r.outputTokens
      sum.cacheReadTokens += r.cacheReadTokens
      sum.cacheCreationTokens += r.cacheCreationTokens
      sum.reasoningTokens += r.reasoningTokens
      sum.errors += r.errors
      sum.totalTokens += Store.totalOf(r.inputTokens, r.outputTokens, r.cacheCreationTokens, sem, r.cacheReadTokens)
      sum.inputSideTokens += Store.inputSideOf(r.inputTokens, r.cacheReadTokens, r.cacheCreationTokens, sem)
    }
    return sum
  }

  // ---- 总量与命中率（CACHE-SEMANTICS：按行内 sem 分流）----

  // 单行总量 = 上游 wire 总量。
  // subset（OpenAI 系：workbuddy/zen，openai-completions/responses）：
  //   prompt_tokens 已含 cached 全量，wire total = prompt + completion；
  //   cacheCreation（miss）是 prompt 的子集，另加即重复计数
  //   （实抓：prompt=425/cached=320/miss=105 时 wire=435，input+creation+output=540）。
  // separate（Anthropic 系：input/read/creation 三桶互斥，input 只含未命中）：
  //   总量 = input + output + read + creation（对应 ir.usageTotal 的 'separate'）。
  // reasoning 已含于 output，不重复计。
  private static totalOf(
    inputTokens: number, outputTokens: number,
    cacheCreationTokens: number, sem: CacheSem = 'subset',
    cacheReadTokens = 0,
  ): number {
    return sem === 'separate'
      ? inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens
      : inputTokens + outputTokens
  }

  // 命中率 = 缓存读取 / 输入侧总量（用户口径：命中了多少输入）。
  // subset 行输入侧 = input（prompt 已含 cached）；separate 行 = 三桶之和
  // （input 只是未命中部分，直接当分母会把命中率算成 >100% 的荒值）。
  // 无输入返回 null（缺数据不产出 0.0，前端显示 —）。
  // 命中率 = 缓存读取 / 输入侧总量。
  //
  // 两个重载对应两种调用形态，公式必须只有这一份（否则口径藏在两处迟早漂移）：
  //   · 给 (input, read, creation, sem)：按单行语义算分母（separate 时三桶和）。
  //   · 给 (inputSide, read)：分母已由 SQL 按行内 sem 逐行分流求和算好——
  //     同一 (provider, model) 组里可能混着两种 sem 的行，此时单一 sem 无法
  //     表达分母，只能吃聚合值。byModel 走这条（SQL 的 SUM(CASE WHEN sem…））。
  // 分母为 0 返回 null（缺数据不产出 0.0，前端显示 —，不假装零命中）。
  private static hitRate(
    inputOrSide: number, cacheReadTokens: number,
    cacheCreationTokens?: number, sem: CacheSem = 'subset',
  ): number | null {
    const denom = cacheCreationTokens === undefined
      ? inputOrSide // 形态二：inputOrSide 就是已聚合好的输入侧总量
      : (sem === 'separate'
        ? inputOrSide + cacheReadTokens + cacheCreationTokens
        : inputOrSide)
    return denom > 0 ? cacheReadTokens / denom : null
  }

  // 输入侧总量（命中率分母）。separate 行 input 只是未命中部分，真实输入 = 三桶和。
  private static inputSideOf(
    inputTokens: number, cacheReadTokens: number,
    cacheCreationTokens: number, sem: CacheSem = 'subset',
  ): number {
    return sem === 'separate'
      ? inputTokens + cacheReadTokens + cacheCreationTokens
      : inputTokens
  }

  // 仪表盘聚合：区间合计 + 每日序列 + 按模型归因（byModel 按总 token 降序）。
  // accountID 非空时全部分组只统计该账号（ACCOUNT-HEALTH：详情页复用 breakdown）。
  async breakdown(since: Date, until?: Date, accountId = ''): Promise<Breakdown> {
    const sum = await this.summarize(since, until, accountId)
    // 合计命中率 = 总缓存读取 / 输入侧总量。分母按行内 sem 分流（subset 行 input、
    // separate 行三桶和），SQL 一列算完——零命中源自然计入分母（不稀释不行：
    // 旧实现 `if (g.cacheReadTokens === 0) continue` 把零命中源的输入整个丢掉，
    // 分母虚小而命中率虚高）。
    const inputSideExpr = `(CASE WHEN sem = 'separate'
      THEN input_tokens + cache_read_tokens + cache_creation_tokens
      ELSE input_tokens END)`
    const perProv = this.db.prepare(`SELECT
      provider_id AS providerId,
      COALESCE(SUM(${inputSideExpr}),0) AS inputSideTokens
      FROM usage_logs WHERE ts >= @since${Store.range(until)}${accountId ? ' AND account_id = @accountId' : ''}
      GROUP BY provider_id`).all(this.params(since, until, accountId)) as unknown as
      { providerId: number; inputSideTokens: number }[]
    let inputDenom = 0
    for (const g of perProv) inputDenom += g.inputSideTokens
    const cacheHitRate = inputDenom > 0 ? sum.cacheReadTokens / inputDenom : 0
    const acct = accountId ? ' AND account_id = @accountId' : ''
    const p = this.params(since, until, accountId)

    const daily = this.db.prepare(`SELECT
      strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') AS day,
      COUNT(*) AS requests,
      provider_id AS providerId,
      sem AS sem,
      COALESCE(SUM(input_tokens),0) AS inputTokens,
      COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,
      COALESCE(SUM(cache_creation_tokens),0) AS cacheCreationTokens,
      COALESCE(SUM(reasoning_tokens),0) AS reasoningTokens,
      COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END),0) AS errors
      FROM usage_logs WHERE ts >= @since${Store.range(until)}${acct}
      GROUP BY day, provider_id, sem ORDER BY day ASC`)
      .all(p) as unknown as (DailyPoint & { providerId: number; sem: string })[]
    // daily 按 (day, provider, sem) 分开算输入侧与总量再合——总量/分母是逐行
    // 按语义算的，混组求和会算错（separate 行的 read 不能混进 subset 组）。
    const dailyMerged = new Map<string, DailyPoint>()
    for (const r of daily) {
      const sem: CacheSem = r.sem === 'separate' ? 'separate' : 'subset'
      const total = Store.totalOf(r.inputTokens, r.outputTokens, r.cacheCreationTokens, sem, r.cacheReadTokens)
      const inputSide = Store.inputSideOf(r.inputTokens, r.cacheReadTokens, r.cacheCreationTokens, sem)
      const acc = dailyMerged.get(r.day)
      if (!acc) {
        const { providerId: _drop, sem: _sem, ...rest } = r
        dailyMerged.set(r.day, { ...rest, totalTokens: total, inputSideTokens: inputSide })
      } else {
        acc.requests += r.requests
        acc.inputTokens += r.inputTokens
        acc.outputTokens += r.outputTokens
        acc.cacheReadTokens += r.cacheReadTokens
        acc.cacheCreationTokens += r.cacheCreationTokens
        acc.reasoningTokens += r.reasoningTokens
        acc.totalTokens += total
        acc.inputSideTokens += inputSide
        acc.errors += r.errors
      }
    }
    const dailyPoints = [...dailyMerged.values()]

    // TPS 守卫条件（DSH 口径，TPS-METRIC §3.5）：成功 + 流式 + 首字有效 + decode>0。
    // 分子分母同口径，否则错位会算出离谱值；无样本返回 NULL（缺数据不产出 0.0）。
    const guard = `status='ok' AND stream=1 AND first_token_ms > 0 AND latency_ms > first_token_ms`
    // 行内总量表达式：与 Store.totalOf 同语义（subset=input+output；separate 三桶全加）。
    const totalExpr = `(CASE WHEN sem = 'separate'
      THEN input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens
      ELSE input_tokens + output_tokens END)`
    const byModel = this.db.prepare(`SELECT
      provider_id AS providerId, provider_name AS providerName, model_id AS modelId,
      COUNT(*) AS requests,
      COALESCE(SUM(input_tokens),0) AS inputTokens,
      COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,
      COALESCE(SUM(cache_creation_tokens),0) AS cacheCreationTokens,
      COALESCE(SUM(${inputSideExpr}),0) AS inputSideTokens,
      COALESCE(SUM(${totalExpr}),0) AS totalTokens,
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

    // 命中率与 totals 同源（read / 输入侧）；总量已由 SQL 按行内 sem 算准
    // （同一 (provider, model) 内混两种 sem 时逐行取式后再求和，不串桶）。
    for (const m of byModel) {
      m.cacheHitRate = Store.hitRate(m.inputSideTokens, m.cacheReadTokens)
    }
    // byModel 按总量降序：SQL 侧不再 ORDER（总量是 TS 侧重算的，SQL 排不准），
    // 统一由 TS 侧重排。
    byModel.sort((a, b) => b.totalTokens - a.totalTokens)

    return { totals: { ...sum, cacheHitRate }, daily: dailyPoints, byModel }
  }

  // 账号维度聚合（ACCOUNT-HEALTH §3.4）：
  // GROUP BY account_id；ByKind 按 (account_id, error_kind) 二级分组拼装（加新 kind 不改 SQL）；
  // 模型拆分子查询；空 account_id 单独成组（Provider 级凭据，诚实表达不隐藏）。
  // 总量/输入侧按行内 sem 分流，按 (account_id, provider_id[, model_id]) 分组重算再汇总，
  // 避免账号页与仪表盘口径分裂。
  async accountBreakdown(since: Date, until?: Date): Promise<AccountUsage[]> {
    const p = this.params(since, until)
    const range = Store.range(until)

    interface AggRow { accountId: string; providerId: number; sem: string; requests: number; errors: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
    const agg = this.db.prepare(`SELECT
      account_id AS accountId, provider_id AS providerId, sem AS sem,
      COUNT(*) AS requests,
      COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END),0) AS errors,
      COALESCE(SUM(input_tokens),0) AS inputTokens,
      COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,
      COALESCE(SUM(cache_creation_tokens),0) AS cacheCreationTokens
      FROM usage_logs WHERE ts >= @since${range}
      GROUP BY account_id, provider_id, sem`).all(p) as unknown as AggRow[]

    interface ModelAggRow { accountId: string; providerId: number; modelId: string; sem: string; requests: number; errors: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
    const modelAgg = this.db.prepare(`SELECT
      account_id AS accountId, provider_id AS providerId, model_id AS modelId, sem AS sem,
      COUNT(*) AS requests,
      COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END),0) AS errors,
      COALESCE(SUM(input_tokens),0) AS inputTokens,
      COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,
      COALESCE(SUM(cache_creation_tokens),0) AS cacheCreationTokens
      FROM usage_logs WHERE ts >= @since${range}
      GROUP BY account_id, provider_id, model_id, sem`).all(p) as unknown as ModelAggRow[]

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
    interface TotAcc { requests: number; errors: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; totalTokens: number; inputSideTokens: number }
    const totalsMap = new Map<string, TotAcc>()
    const accOf = (id: string): TotAcc => {
      let a = totalsMap.get(id)
      if (!a) { a = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, inputSideTokens: 0 }; totalsMap.set(id, a) }
      return a
    }
    for (const r of agg) {
      const a = accOf(r.accountId)
      const sem: CacheSem = r.sem === 'separate' ? 'separate' : 'subset'
      a.requests += r.requests
      a.errors += r.errors
      a.inputTokens += r.inputTokens
      a.outputTokens += r.outputTokens
      a.cacheReadTokens += r.cacheReadTokens
      a.totalTokens += Store.totalOf(r.inputTokens, r.outputTokens, r.cacheCreationTokens, sem, r.cacheReadTokens)
      a.inputSideTokens += Store.inputSideOf(r.inputTokens, r.cacheReadTokens, r.cacheCreationTokens, sem)
    }
    const modelsMap = new Map<string, ModelUsage[]>()
    for (const m of modelAgg) {
      const arr = modelsMap.get(m.accountId) ?? []
      const sem: CacheSem = m.sem === 'separate' ? 'separate' : 'subset'
      arr.push({
        modelId: m.modelId, requests: m.requests, errors: m.errors,
        inputTokens: m.inputTokens, outputTokens: m.outputTokens,
        totalTokens: Store.totalOf(m.inputTokens, m.outputTokens, m.cacheCreationTokens, sem, m.cacheReadTokens),
        inputSideTokens: Store.inputSideOf(m.inputTokens, m.cacheReadTokens, m.cacheCreationTokens, sem),
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
        inputSideTokens: t.inputSideTokens,
        ...(last ? { lastErrorAt: new Date(last.lastErrorAt), lastErrorKind: last.errorKind } : {}),
        models: (modelsMap.get(accountId) ?? []).sort((a, b) => b.totalTokens - a.totalTokens),
      }
    })
  }
}

// 前向迁移。幂等：列已存在则跳过，只推进 user_version。
// 每次迁移都先探测当前列形态，再决定做什么——不假设旧库停在哪一版。
function migrate(db: InstanceType<typeof DatabaseSync>): void {
  // 结构补齐（幂等加列）必须**先于**版本门禁执行：
  // 版本号是会撒谎的——用户手改过库、旧版本写过 user_version 却没加完列、
  // 或从别处拷贝来一个半迁移的库，都会出现「user_version=5 但没有 sem 列」。
  // 而 6 处读查询（summarize/breakdown/accountBreakdown）硬引用 sem，
  // 一旦缺列整个用量页直接 500。加列是幂等的，无条件做零副作用；
  // 真正需要门禁保护的是下面「重建表」这类破坏性步骤。
  // 对照同文件 idx_usage_ts（建表后无条件 CREATE INDEX IF NOT EXISTS）。
  {
    const cols0 = db.prepare('PRAGMA table_info(usage_logs)').all() as { name: string }[]
    const has0 = (n: string) => cols0.some((c) => c.name === n)
    if (!has0('error_kind')) {
      db.exec(`ALTER TABLE usage_logs ADD COLUMN error_kind TEXT NOT NULL DEFAULT ''`)
    }
    if (!has0('sem')) {
      db.exec(`ALTER TABLE usage_logs ADD COLUMN sem TEXT NOT NULL DEFAULT ''`)
    }
  }
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
      // 重建分支的默认值必须与主 CREATE TABLE（"恒最新形态"）一致：写路径虽总
      // 显式给 accuracy/status，但兜底值不一致，读侧对同一行的解读迟早分叉。
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
        accuracy TEXT NOT NULL DEFAULT '',
        latency_ms INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '',
        egress_id TEXT NOT NULL DEFAULT '',
        node_id TEXT NOT NULL DEFAULT '',
        stream INTEGER NOT NULL DEFAULT 0,
        first_token_ms INTEGER NOT NULL DEFAULT 0,
        error_kind TEXT NOT NULL DEFAULT '',
        sem TEXT NOT NULL DEFAULT '')`)
      db.exec(`INSERT INTO usage_logs_new
        (id, ts, request_id, provider_id, provider_name, account_id, model_id,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         reasoning_tokens, total_tokens, accuracy, latency_ms, status,
         egress_id, node_id, stream, first_token_ms, error_kind, sem)
        SELECT id, ts, request_id, 0, ${nameExpr}, account_id, model_id,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         reasoning_tokens, total_tokens, accuracy, latency_ms, status,
         egress_id, node_id, stream, first_token_ms,
         ${has('error_kind') ? 'error_kind' : "''"},
         ${has('sem') ? 'sem' : "''"}
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
  // v5：sem 列（CACHE-SEMANTICS）。v4 及更早的行全部按 subset 口径写的，
  // 先落默认 ''（= subset），Anthropic 历史行由 backfillSemantics 二次回填。
  if (!has('sem')) {
    db.exec(`ALTER TABLE usage_logs ADD COLUMN sem TEXT NOT NULL DEFAULT ''`)
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

// v5 迁移的第二步：给历史行回填缓存语义（CACHE-SEMANTICS）。
// admin.db 的 provider 配置是「provider_id → 协议」的权威来源：模型级/Provider 级
// 声明为 anthropic-messages 的，其历史行是 separate 口径（input 只含未命中）。
// 协议查不到的（Provider 已删且无痕迹）用启发式兜底：subset 行的 read ⊆ input，
// read > input 只可能出自 separate 行（OpenAI 不可能报出超过 prompt 的 cached）。
// 返回回填行数。由 cli 在两边都打开后调用（幂等：只补 sem='' 的行）。
export function backfillSemantics(
  db: InstanceType<typeof DatabaseSync>,
  // 按 (provider, model) 查询——不能只按 provider：同一 Provider 下不同模型
  // 可以声明不同协议（真实数据里 senseaudio 就是 openai-completions /
  // anthropic-messages / openai-responses 三混）。只按 Provider 取一个值，
  // 等于让"最后一个带 api 的模型"代表整个 Provider，混合源的 anthropic 模型
  // 会被整体判成 subset——而转发路径 resolveProtocol 是按 modelID 精确解析的，
  // 两边口径分裂（历史回填与实时转发算出不同语义）。退化规则由调用方决定：
  // 该模型无声明时回落到 Provider 级。
  protocolOf: (providerId: number, modelId: string) => string | undefined,
): number {
  // 1) 按配置分流：该 (Provider, 模型) 声明 anthropic-messages → separate；
  //    声明其它协议 → subset。都没声明的留给启发式。
  const sepKeys: { pid: number; mid: string }[] = []
  const subKeys: { pid: number; mid: string }[] = []
  const keys = (db.prepare(
    `SELECT DISTINCT provider_id AS pid, model_id AS mid FROM usage_logs WHERE sem = '' AND provider_id > 0`)
    .all() as unknown as { pid: number; mid: string }[])
  for (const k of keys) {
    const proto = protocolOf(k.pid, k.mid)
    if (proto === 'anthropic-messages') sepKeys.push(k)
    else if (proto !== undefined) subKeys.push(k)
  }
  let fixed = 0
  const updSep = db.prepare(
    `UPDATE usage_logs SET sem = 'separate' WHERE sem = '' AND provider_id = ? AND model_id = ?`)
  const updSub = db.prepare(
    `UPDATE usage_logs SET sem = 'subset' WHERE sem = '' AND provider_id = ? AND model_id = ?`)
  for (const k of sepKeys) {
    // 统计**行数**而非 Provider/模型组数：一组名下常有成百上千条历史行，
    // 而调用方（cli.ts）把返回值当"多少行被标记"打印。按组计会让用户回填了
    // 几千行却看到"3 行已标记"——日志与实际差三个数量级，足以让人误判回填
    // 没跑。步骤 2/3 本就是按行数计的，这里也必须同口径。
    fixed += Number(updSep.run(k.pid, k.mid).changes)
  }
  for (const k of subKeys) {
    fixed += Number(updSub.run(k.pid, k.mid).changes)
  }
  // 2) 启发式兜底（协议查不到的行 + provider_id 挂着 0/-1 的行）：
  //    read > input 在 subset 语义下不可能（cached 是 prompt 的子集），必是 separate。
  const r = db.prepare(`UPDATE usage_logs SET sem = 'separate'
    WHERE sem = '' AND cache_read_tokens > input_tokens AND input_tokens > 0`).run()
  fixed += Number(r.changes)
  // 2b) 纠错：已标 subset 但 read > input 的行，按上面同一条硬证据就是 separate。
  //
  // 为什么必须纠：subset 的定义就是 cached ⊆ prompt，所以 read > input 在该
  // 语义下**数学上不可能**——这不是启发式，是不变式。真实数据里出现过反例：
  // 某 Provider 被（修复前的 Provider 级粗判）贴成 subset，其下 31 行
  // read/input ≈ 588×（input=112/read=65842）。而原写法只处理 sem='' 的残留
  // 行，贴错一次就永久错（三段 UPDATE 全以 sem='' 为前提，改配置也回不来）。
  //
  // 幂等：条件限定 sem='subset'，改完变 'separate' 即退出条件，第二次为 0。
  const fixWrong = db.prepare(`UPDATE usage_logs SET sem = 'separate'
    WHERE sem = 'subset' AND cache_read_tokens > input_tokens AND input_tokens > 0`).run()
  fixed += Number(fixWrong.changes)
  // 3) 剩余行全部钉成 subset（显式标记，避免每次启动重复扫描）。
  const rest = db.prepare(`UPDATE usage_logs SET sem = 'subset' WHERE sem = ''`).run()
  fixed += Number(rest.changes)
  return fixed
}
