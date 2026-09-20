// CACHE-SEMANTICS 的端到端口径锚定（真实 SQLite，非 mock）。
//
// 为什么必须实测而不是只看单测：这个功能修的就是一个**聚合口径**缺陷——
// zcode 系（anthropic 协议，input 只含未命中）的命中率曾被算成 1117%，
// 根因是不分语义地用「input 当命中率分母」。修法是给每行打 sem 并按行内
// 语义分流重算。单测覆盖的是公式单元；这条测的是**混合口径聚合**——
// 一个库里同时存在 subset 行和 separate 行时，分母与命中率是否仍正确。
// 这正是当初出事的真实形态（多 Provider 混跑）。

import { describe, expect, test } from 'vitest'
import { createRequire } from 'node:module'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, backfillSemantics } from '../src/usage/store.ts'

function log(over: Record<string, unknown>): Parameters<Store['insertLog']>[0] {
  return {
    id: 0, ts: new Date(), requestId: 'r', providerId: 1, providerName: 'p',
    accountId: '', modelId: 'm', stream: true,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    reasoningTokens: 0, totalTokens: 0, accuracy: 'exact', latencyMs: 100,
    status: 'ok', sem: 'subset',
    ...over,
  } as unknown as Parameters<Store['insertLog']>[0]
}

describe('缓存语义（CACHE-SEMANTICS）聚合口径', () => {
  test('subset 与 separate 行混合：命中率不越界、分母按行内语义分流', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'polycode-sem-mix-'))
    try {
      const s = await Store.open(join(dir, 'usage.db'))
      // separate 行（anthropic 系：input 只含未命中，三桶互斥）
      //   input=100(未命中) read=300 creation=50 → 输入侧 = 100+300+50 = 450
      await s.insertLog(log({ providerId: 1, modelId: 'ma',
        inputTokens: 100, cacheReadTokens: 300, cacheCreationTokens: 50, sem: 'separate' }))
      // subset 行（openai 系：input 已含命中）
      //   input=500(内含 400 命中) → 输入侧 = 500
      await s.insertLog(log({ providerId: 2, modelId: 'mo',
        inputTokens: 500, cacheReadTokens: 400, cacheCreationTokens: 0, sem: 'subset' }))

      const b = await s.breakdown(new Date(0))
      // 输入侧合计 = 450 + 500 = 950；缓存读取合计 = 300 + 400 = 700
      expect(b.totals.inputSideTokens).toBe(950)
      expect(b.totals.cacheReadTokens).toBe(700)
      // 700/950 ≈ 73.7%——既不越界，也不是「一刀切 subset」会算出的荒值
      expect(b.totals.cacheHitRate).toBeCloseTo(700 / 950, 6)
      expect(b.totals.cacheHitRate).toBeLessThanOrEqual(1)
      s.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 旧口径（不分语义、一律 input 当分母）会把 separate 行的命中率算成
  // 300/100 = 300%。这条盯着的就是「不许再回到那个荒值」。
  test('纯 separate 行：命中率 = read / (input+read+creation)，不是 read/input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'polycode-sem-sep-'))
    try {
      const s = await Store.open(join(dir, 'usage.db'))
      await s.insertLog(log({ inputTokens: 100, cacheReadTokens: 300, cacheCreationTokens: 50, sem: 'separate' }))
      const b = await s.breakdown(new Date(0))
      expect(b.totals.inputSideTokens).toBe(450)
      expect(b.totals.cacheHitRate).toBeCloseTo(300 / 450, 6) // 66.7%，不是 300%
      s.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 历史行 sem=''（v5 迁移前写的旧数据）必须按 subset 处理，不能当 separate
  // 把三桶加进去——那会把老数据的总量凭空抬高。
  test('遗留行 sem 为空 → 按 subset 口径（不加缓存桶）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'polycode-sem-legacy-'))
    try {
      const s = await Store.open(join(dir, 'usage.db'))
      // 直接写库模拟历史行：sem 列留空（insertLog 会补 'subset'，故不用它）
      s.insertLog(log({ inputTokens: 500, cacheReadTokens: 400, cacheCreationTokens: 0, sem: '' as never }))
      const b = await s.breakdown(new Date(0))
      expect(b.totals.inputSideTokens).toBe(500) // subset：input 就是输入侧
      expect(b.totals.cacheHitRate).toBeCloseTo(400 / 500, 6) // 80%
      s.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// backfillSemantics 的回填计数与幂等性。
//
// 真实缺陷（本次扫描实测发现）：步骤 1 按 Provider 循环时用 `fixed++` 计数，
// 于是返回值是「命中配置的 Provider 个数」；步骤 2/3 却按 SQL 的 changes
// （行数）计。两者单位混在一个返回值里，而 cli.ts 打印的是"N 行已标记"——
// 8 行被回填却显示 2 行（实测），足以让人误判迁移没生效。以下用例盯住：
// 返回值必须是行数，且重复调用必须幂等（第二次为 0）。
describe('backfillSemantics 回填计数与幂等', () => {
  async function seed(): Promise<{ s: Store; dir: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'polycode-sem-bf-'))
    const s = await Store.open(join(dir, 'usage.db'))
    // p1 配 anthropic-messages → separate（5 行）；p2 配 openai → subset（3 行）
    for (let i = 0; i < 5; i++) {
      await s.insertLog(log({ providerId: 1, requestId: 'a' + String(i),
        inputTokens: 100, cacheReadTokens: 300, sem: '' as never }))
    }
    for (let i = 0; i < 3; i++) {
      await s.insertLog(log({ providerId: 2, requestId: 'b' + String(i),
        inputTokens: 500, cacheReadTokens: 400, sem: '' as never }))
    }
    return { s, dir }
  }

  test('回填按行数计（不是 Provider 数），且正确分离 separate/subset', async () => {
    const { s, dir } = await seed()
    try {
      const db = (s as unknown as { db: Parameters<typeof backfillSemantics>[0] }).db
      const n = backfillSemantics(db, (id) => (id === 1 ? 'anthropic-messages' : 'openai-completions'))
      expect(n).toBe(8) // 5 + 3 行，不是 2 个 Provider
      // p1 的 5 行应被标 separate（其 read=300 > input=100，subset 下不可能）
      const rows = db.prepare('SELECT provider_id AS pid, sem FROM usage_logs').all() as
        unknown as { pid: number; sem: string }[]
      expect(rows.filter((r) => r.pid === 1).every((r) => r.sem === 'separate')).toBe(true)
      expect(rows.filter((r) => r.pid === 2).every((r) => r.sem === 'subset')).toBe(true)
      s.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('重复回填幂等：第二次返回 0（不会每次启动都被"标记"一次）', async () => {
    const { s, dir } = await seed()
    try {
      const db = (s as unknown as { db: Parameters<typeof backfillSemantics>[0] }).db
      const lookup = (id: number, _mid?: string): string | undefined =>
        (id === 1 ? 'anthropic-messages' : 'openai-completions')
      const first = backfillSemantics(db, lookup)
      const second = backfillSemantics(db, lookup)
      expect(first).toBe(8)
      expect(second).toBe(0)
      s.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('协议查不到的行 → 启发式兜底（read > input 判 separate）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'polycode-sem-heur-'))
    try {
      const s = await Store.open(join(dir, 'usage.db'))
      // p9 无任何协议配置：read(300) > input(100) → 必是 separate
      await s.insertLog(log({ providerId: 9, inputTokens: 100, cacheReadTokens: 300, sem: '' as never }))
      // p10 无配置且 read(50) <= input(500) → 钉成 subset
      await s.insertLog(log({ providerId: 10, inputTokens: 500, cacheReadTokens: 50, sem: '' as never }))
      const db = (s as unknown as { db: Parameters<typeof backfillSemantics>[0] }).db
      const n = backfillSemantics(db, () => undefined)
      expect(n).toBe(2)
      const rows = db.prepare('SELECT provider_id AS pid, sem FROM usage_logs').all() as
        unknown as { pid: number; sem: string }[]
      expect(rows.find((r) => r.pid === 9)?.sem).toBe('separate')
      expect(rows.find((r) => r.pid === 10)?.sem).toBe('subset')
      s.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// 迁移门禁（P2）：版本号会撒谎。
//
// 真实缺陷（扫描实测）：migrate() 先读 PRAGMA user_version，>=5 就早退，
// 而 ALTER TABLE ADD COLUMN sem 写在早退之后。于是"user_version=5 但缺 sem 列"
// 的库（手改过、半迁移、从别处拷来）会直接放行——随后 6 处读查询硬引用 sem，
// 整个用量页 500。加列是幂等的，必须无条件先做；门禁只该守重建表这类破坏性步骤。
describe('迁移：版本号撒谎时不得放行', () => {
  test('user_version=5 但缺 sem 列 → 重新打开后 summarize 不抛错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'polycode-sem-v5lie-'))
    try {
      const path = join(dir, 'usage.db')
      const s0 = await Store.open(path)
      s0.close()
      // 造一个"版本号撒谎"的库：sem 列被去掉，user_version 谎报 5
      const db = new DatabaseSync(path)
      db.exec('ALTER TABLE usage_logs DROP COLUMN sem')
      db.exec('PRAGMA user_version=5')
      db.close()
      const s = await Store.open(path)
      // 修复前这里抛 no such column: sem（整个用量页 500）
      const r = await s.summarize(new Date(0))
      expect(r.requests).toBe(0)
      s.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('正常库重复打开幂等：不重复加列、不报错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'polycode-sem-idem-'))
    try {
      const path = join(dir, 'usage.db')
      const a = await Store.open(path)
      await a.insertLog(log({ inputTokens: 1, outputTokens: 1 }))
      a.close()
      const b = await Store.open(path)
      const r = await b.summarize(new Date(0))
      expect(r.requests).toBe(1)
      b.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// P1：混合协议源 + 贴错后的纠错。
//
// 真实数据里两条都出现过（扫描器在真实库只读副本上实测）：
//   P1-1 同一 Provider 下三协议混（senseaudio），单键 map 让"最后一个模型"
//        代表整个 Provider，anthropic 模型被整体判成 subset——而转发路径
//        resolveProtocol 是按 modelID 精确解析的，两边口径分裂。
//   P1-2 被贴错的 31 行 read/input ≈ 588×，subset 语义下数学上不可能，
//        却因"只处理 sem=''"而永久错下去。
describe('回填：混合协议源与贴错纠错', () => {
  // P1-1：同 Provider 下 ma 是 anthropic、mo 是 openai，必须分开贴，
  // 不能让其中一个代表整个 Provider。
  test('同一 Provider 下模型级协议不同 → 分别贴 separate/subset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'polycode-sem-mixed-'))
    try {
      const s = await Store.open(join(dir, 'usage.db'))
      // 同一个 providerId=4，两个模型各 3 行
      for (let i = 0; i < 3; i++) {
        await s.insertLog(log({ providerId: 4, modelId: 'ma', requestId: 'x' + String(i), sem: '' as never }))
        await s.insertLog(log({ providerId: 4, modelId: 'mo', requestId: 'y' + String(i), sem: '' as never }))
      }
      const db = (s as unknown as { db: Parameters<typeof backfillSemantics>[0] }).db
      // 只有 ma 声明 anthropic-messages；mo 声明 openai-completions
      const n = backfillSemantics(db, (_pid, mid) =>
        (mid === 'ma' ? 'anthropic-messages' : 'openai-completions'))
      expect(n).toBe(6)
      const rows = db.prepare('SELECT model_id AS mid, sem FROM usage_logs').all() as
        unknown as { mid: string; sem: string }[]
      expect(rows.filter((r) => r.mid === 'ma').every((r) => r.sem === 'separate')).toBe(true)
      expect(rows.filter((r) => r.mid === 'mo').every((r) => r.sem === 'subset')).toBe(true)
      s.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // P1-2：read > input 是 subset 的不变式违背——硬证据优先于配置推断。
  test('已贴 subset 但 read > input 的行 → 纠错为 separate（幂等）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'polycode-sem-fixwrong-'))
    try {
      const s = await Store.open(join(dir, 'usage.db'))
      // 配置说这是 openai（subset），但数据 read=65842 >> input=112 —— 反例
      await s.insertLog(log({ providerId: 11, modelId: 'union-alpha',
        inputTokens: 112, cacheReadTokens: 65842, sem: '' as never }))
      const db = (s as unknown as { db: Parameters<typeof backfillSemantics>[0] }).db
      // 先由配置贴成 subset（模拟旧行为把混合源压扁）
      const first = backfillSemantics(db, () => 'openai-completions')
      const rows1 = db.prepare('SELECT sem FROM usage_logs').all() as unknown as { sem: string }[]
      // 纠错段立刻按硬证据改回 separate
      expect(rows1[0]?.sem).toBe('separate')
      // 幂等：第二次不再命中（已是 separate）
      const second = backfillSemantics(db, () => 'openai-completions')
      expect(second).toBe(0)
      expect(first).toBeGreaterThan(0)
      s.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// 数据目录权限（P2-3）：admin.db/usage.db 所在目录放的是凭据性材料
// （admin.db 存 Provider 完整 headers——zen 免费档指纹四件套），同仓红线是
// 凭据目录 0700。扫描发现 usage/adminapi 两处 mkdirSync 漏了 mode，
// 默认 umask 下建成 0755，同机其他用户可列目录名。
describe('数据目录权限 0700', () => {
  test('Store.open 建出的目录是 0700', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'polycode-perm-u-'))
    try {
      const sub = join(dir, 'data')
      const s = await Store.open(join(sub, 'usage.db'))
      s.close()
      const mode = (statSync(sub).mode & 0o777).toString(8)
      expect(mode).toBe('700')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('已存在的 0755 目录 → 打开时收紧为 0700', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'polycode-perm-u2-'))
    try {
      const sub = join(dir, 'data')
      mkdirSync(sub, { recursive: true, mode: 0o755 })
      expect((statSync(sub).mode & 0o777).toString(8)).toBe('755')
      const s = await Store.open(join(sub, 'usage.db'))
      s.close()
      expect((statSync(sub).mode & 0o777).toString(8)).toBe('700')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('admin 库（openAdminDB）同样收紧：新建 0700 + 存量 0755 → 0700', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'polycode-perm-a-'))
    try {
      const { SQLiteAccountStore } = await import('../src/adminapi/store.ts')
      const sub = join(dir, 'data2')
      const st = await SQLiteAccountStore.open(join(sub, 'admin.db'))
      expect((statSync(sub).mode & 0o777).toString(8)).toBe('700')
      st.close()
      // 存量过宽目录
      const sub2 = join(dir, 'data3')
      mkdirSync(sub2, { recursive: true, mode: 0o755 })
      const st2 = await SQLiteAccountStore.open(join(sub2, 'admin.db'))
      expect((statSync(sub2).mode & 0o777).toString(8)).toBe('700')
      st2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
