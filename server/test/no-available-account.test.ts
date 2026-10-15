// 「该源配了账号，但全部不可用」的回归（真实用户反馈，2026-10-15）。
//
// 场景：WorkBuddy 这类「登录态复用」Provider 的 credential 是草稿占位
// apiKeyEnv='WB_TOKEN'（进程里根本没有这个变量），真正的凭据在账号池里。
// 账号池的号一旦全部冷却/耗尽/被停用，旧实现会：
//   · 探针：静默回落到 Provider 级占位凭据 → 报「环境变量 WB_TOKEN 未设置」；
//   · 转发：用 hasFor() 判定（只问「有没有账号」）→ 既不打上游也不换源，
//     客户端只拿到一句无信息的 500。
// 两者都把用户引向「去重配凭据」，而真实动作在账号页（重置/换号）。
//
// 本文件同时把「账号池无可用账号」的文案钉死：它必须点名 provider、账号数与
// 各自的不可用原因——只说「无可用账号」等于没说（看不出是没导入还是被打光了）。

import { describe, expect, test } from 'vitest'
import { Hono } from 'hono'
import { AccountPool, accountStatusLabel, accountUnavailableSummary, noAvailableAccountMessage } from '../src/pool/account.ts'
import { Probe } from '../src/gateway/probe.ts'
import { Proxy, mapUpstreamError } from '../src/gateway/proxy.ts'
import { Scheduler } from '../src/router/scheduler.ts'
import { Upstream } from '../src/router/upstream.ts'
import { missingCredentialMessage } from '../src/router/upstream.ts'
import { UpstreamError, UPSTREAM } from '../src/ir/index.ts'
import type { Account, Provider, UsageLog } from '../src/model/index.ts'
import { startOneShot } from './helpers/one-shot-server.ts'
import '../src/codec/anthropicmessages.ts'
import '../src/codec/openaicompletions.ts'
import '../src/codec/openairesponses.ts'

// ---- 夹具 ----

// WorkBuddy 形状的 Provider：凭据是占位环境变量引用，模型已勾选一个。
const wbProvider = (base: string): Provider => ({
  providerId: 24, name: 'workbuddy-ai', state: 'active',
  displayName: 'WorkBuddy（自动发现·海外版）', accessKind: 'session-reuse', risk: 'medium',
  riskNote: '', stability: 'beta', api: 'openai-completions', baseUrl: base,
  credential: { apiKeyEnv: 'WB_TOKEN' }, headers: { 'X-Domain': 'www.workbuddy.ai' },
  streamOnly: true, priority: 1,
  models: [{ id: 'deepseek-v4.1-flash', manual: false, enabled: true, api: 'openai-completions' }],
})

const wbAccount = (over: Partial<Account> = {}): Account => ({
  id: 'workbuddy-ai-1', providerId: 24, displayName: 'liz816339@gmail.com',
  credential: { apiKeyFile: 'config/credentials/workbuddy-ai-1-jwt' },
  status: 'available', fails: 7, ...over,
})

// 上游桩：记录命中；按 mode 决定行为。命中数必须为 0 的用例靠它证明「没打出去」。
async function stubUpstream(mode: 'ok' | 'never' = 'ok') {
  const hits: string[] = []
  const { server, base } = await startOneShot((req, res) => {
    hits.push(String(req.headers.authorization ?? '-'))
    if (mode === 'never') { res.writeHead(500); res.end('不该被打到'); return }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"pong"}}]}\n\n')
    res.write('data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  return { hits, base, close: () => new Promise<void>((r) => server.close(() => r())) }
}

// WB_TOKEN 未设置的凭据查找（defaultLookup 之外显式注入，测试不依赖真实环境变量）。
const noCred = new Upstream({ credLookup: () => ['', false], noAutoProtocol: true })

// ---- 文案与摘要（单一真相源）----

describe('账号不可用的人话（status 标签 / 摘要 / 整句）', () => {
  const NOW = new Date('2026-10-15T10:00:00Z')
  const at = (over: Partial<Account>) => ({
    providerId: 24, credential: {}, fails: 0, ...over,
  } as Account)

  test('标签覆盖四种状态；未知值原样返回（将来新增枚举时不会被吞掉）', () => {
    expect(accountStatusLabel('available')).toBe('可用')
    expect(accountStatusLabel('cooldown')).toBe('冷却中')
    expect(accountStatusLabel('exhausted')).toBe('额度用尽')
    expect(accountStatusLabel('disabled')).toBe('已停用')
    expect(accountStatusLabel('wat' as never)).toBe('wat')
  })

  test('摘要顺序固定、与传入顺序无关；数量累加；冷却到期不算不可用', () => {
    const cool = at({ id: 'c', status: 'cooldown', cooldownUntil: new Date(NOW.getTime() + 60_000) })
    const exh = at({ id: 'e', status: 'exhausted' })
    const dis = at({ id: 'd', status: 'disabled' })
    expect(accountUnavailableSummary([cool, exh, dis], NOW)).toBe('冷却中 1、额度用尽 1、已停用 1')
    // 顺序无关：同一池子必须永远产出同一句话，否则两次排障记录没法对比
    expect(accountUnavailableSummary([dis, exh, cool], NOW)).toBe('冷却中 1、额度用尽 1、已停用 1')
    expect(accountUnavailableSummary([cool, { ...cool, id: 'c2' }], NOW)).toBe('冷却中 2')
    // 冷却已过期 = 已恢复，不能算进不可用
    expect(accountUnavailableSummary(
      [at({ id: 'r', status: 'cooldown', cooldownUntil: new Date(NOW.getTime() - 1) })], NOW)).toBe('')
    expect(accountUnavailableSummary([at({ id: 'a', status: 'available' })], NOW)).toBe('')
    expect(accountUnavailableSummary([], NOW)).toBe('')
  })

  test('整句点名 provider、账号数与各自原因', () => {
    const msg = noAvailableAccountMessage('workbuddy-ai', [
      at({ id: 'a', status: 'exhausted' }), at({ id: 'b', status: 'disabled' }),
    ], NOW)
    expect(msg).toContain('账号池无可用账号')
    expect(msg).toContain('provider=workbuddy-ai')
    expect(msg).toContain('名下 2 个账号全部不可用')
    expect(msg).toContain('额度用尽 1、已停用 1')
  })
})

describe('AccountPool：可用账号数会触发冷却到期复位（与 pick 同语义）', () => {
  const NOW = new Date('2026-10-15T10:00:00Z')
  const acct = (over: Partial<Account> & { id: string }): Account => ({
    providerId: 24, credential: {}, status: 'available', fails: 0, ...over,
  })

  test('只数该 Provider 的可用账号；不可用的一个都不算', () => {
    const pool = new AccountPool([
      acct({ id: 'a' }),
      acct({ id: 'b', status: 'cooldown', cooldownUntil: new Date(NOW.getTime() + 60_000) }),
      acct({ id: 'c', status: 'exhausted' }),
      acct({ id: 'd', status: 'disabled' }),
      acct({ id: 'other', providerId: 28 }), // 别的源的号不该被算进来
    ])
    expect(pool.eligibleAccountCount(24, NOW)).toBe(1)
    expect(pool.eligibleAccountCount(28, NOW)).toBe(1)
    // 关键对照：hasFor=true（配了账号）≠ 能用。这正是旧实现误判的根源。
    expect(pool.hasFor(24)).toBe(true)
    expect(pool.countFor(24)).toBe(4)
    expect(pool.eligibleAccountCount(999, NOW)).toBe(0)
  })

  test('冷却到期的号在计数时自动复位并落盘（持久层不会留下过期惩罚）', () => {
    const persisted: string[] = []
    const pool = new AccountPool(
      [acct({ id: 'r', status: 'cooldown', cooldownUntil: new Date(NOW.getTime() - 1) })],
      (a) => persisted.push(a.id),
    )
    expect(pool.eligibleAccountCount(24, NOW)).toBe(1)
    expect(pool.snapshot()[0]!.status).toBe('available')
    expect(pool.snapshot()[0]!.cooldownUntil).toBeUndefined()
    expect(persisted).toContain('r')
  })
})

// ---- 转发侧 ----

class MemUsage {
  rows: UsageLog[] = []
  async insertLog(l: UsageLog) { this.rows.push({ ...l }) }
}

function buildProxy(base: string, pool: AccountPool, usage: MemUsage, upstream = noCred) {
  const cfg = {
    gateway: {
      host: '127.0.0.1', port: 0, adminKey: '', gatewayKey: '', defaultModel: '',
      riskMax: 'high', precheckContext: false,
      firstByteTimeoutMs: 5000, streamIdleTimeoutMs: 5000,
    },
    dataDir: 'data', egresses: [], providers: [], accounts: [],
  } as never
  const px = new Proxy(cfg, new Scheduler([wbProvider(base)], 'high'), upstream, usage)
  px.setAccountPool(pool)
  const app = new Hono()
  px.registerRoutes(app)
  return app
}

const chatRequest = () => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'workbuddy-ai/deepseek-v4.1-flash', stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  }),
})

describe('转发：账号全不可用时如实报因，而不是沉默的 500', () => {
  test('三个号分别冷却/耗尽/停用 → 报「账号池无可用账号」，一个字节都不发上游', async () => {
    const stub = await stubUpstream('never')
    try {
      const pool = new AccountPool([
        wbAccount({ id: 'a', status: 'cooldown', cooldownUntil: new Date(Date.now() + 600_000) }),
        wbAccount({ id: 'b', status: 'exhausted' }),
        wbAccount({ id: 'c', status: 'disabled' }),
      ])
      const usage = new MemUsage()
      const res = await buildProxy(stub.base, pool, usage).request('/v1/chat/completions', chatRequest())
      const body = await res.text()
      expect(body).toContain('账号池无可用账号')
      expect(body).toContain('workbuddy-ai')
      expect(body).toContain('冷却中 1、额度用尽 1、已停用 1')
      // 绝不能回落报「没配凭据」：那会把用户推去重装/重导出 token
      expect(body).not.toContain('WB_TOKEN')
      expect(body).not.toContain('上游错误: ')
      expect(stub.hits).toHaveLength(0)
      // 失败账要能按原因归类（用量页/排障靠它），且不把锅甩给某个号
      const ul = usage.rows.at(-1)!
      expect(ul.status).toBe('upstream_error')
      expect(ul.errorKind).toBe(UPSTREAM.NO_ACCOUNT)
      expect(ul.accountId).toBe('')
      // 账号的惩罚态不被这次失败污染（不是号错了，是本地没有可用号）
      expect(pool.snapshot().map((a) => a.status)).toEqual(['cooldown', 'exhausted', 'disabled'])
    } finally {
      await stub.close()
    }
  })

  test('对照：池里没有该 Provider 的账号 → 仍走 Provider 级凭据（行为不变）', async () => {
    const stub = await stubUpstream('never')
    try {
      const res = await buildProxy(stub.base, new AccountPool([]), new MemUsage())
        .request('/v1/chat/completions', chatRequest())
      const body = await res.text()
      expect(body).toContain('WB_TOKEN') // 真的没配凭据，就该这么说
      expect(body).not.toContain('账号池无可用账号')
      expect(stub.hits).toHaveLength(0)
    } finally {
      await stub.close()
    }
  })

  test('对照：有可用账号 → 正常转发（修复不能挡住正常路径）', async () => {
    const stub = await stubUpstream('ok')
    try {
      const pool = new AccountPool([wbAccount({ status: 'available' })])
      const res = await buildProxy(stub.base, pool, new MemUsage()).request('/v1/chat/completions', chatRequest())
      expect(res.status).toBe(200)
      await res.text()
      expect(stub.hits).toHaveLength(1)
    } finally {
      await stub.close()
    }
  })

  test('mapUpstreamError：no_account 归 api_error（不是 401 鉴权），且不带「上游错误:」前缀', () => {
    const ir = mapUpstreamError(new UpstreamError(0, UPSTREAM.NO_ACCOUNT, '账号池无可用账号 provider=x'))
    expect(ir.type).toBe('api_error')
    expect(ir.message).toBe('账号池无可用账号 provider=x')
    expect(ir.message).not.toContain('上游鉴权失败')
  })
})

// ---- 探针侧 ----

describe('探针：账号全不可用时绝不回落打占位凭据', () => {
  const mkProbe = (base: string, accounts: Account[], upstream = noCred) =>
    new Probe(new Scheduler([wbProvider(base)], 'high'), upstream, null, new AccountPool(accounts))

  test('exhausted / disabled / cooldown：报账号池真相，不含 WB_TOKEN，不打上游', async () => {
    const stub = await stubUpstream('never')
    try {
      const cases: Array<[Account, string]> = [
        [wbAccount({ status: 'exhausted' }), '额度用尽'],
        [wbAccount({ status: 'disabled' }), '已停用'],
        [wbAccount({ status: 'cooldown', cooldownUntil: new Date(Date.now() + 600_000) }), '冷却中'],
      ]
      for (const [account, label] of cases) {
        const r = await mkProbe(stub.base, [account]).probeProvider(24)
        expect(r.ok, label).toBe(false)
        expect(r.error, label).toContain('账号池无可用账号')
        expect(r.error, label).toContain(label)
        expect(r.error, label).not.toContain('WB_TOKEN')
      }
      expect(stub.hits).toHaveLength(0)
    } finally {
      await stub.close()
    }
  })

  test('对照：池里没有账号 → 仍报环境变量未设置（原来的正确行为）', async () => {
    const stub = await stubUpstream('never')
    try {
      const r = await mkProbe(stub.base, []).probeProvider(24)
      expect(r.ok).toBe(false)
      expect(r.error).toContain('WB_TOKEN')
      expect(r.error).not.toContain('账号池无可用账号')
      expect(stub.hits).toHaveLength(0)
    } finally {
      await stub.close()
    }
  })

  test('对照：有可用账号 → 用它的凭据正常探通', async () => {
    const stub = await stubUpstream('ok')
    try {
      const { mkdtempSync, writeFileSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const dir = mkdtempSync(join(tmpdir(), 'polycode-noacct-'))
      const file = join(dir, 'jwt')
      writeFileSync(file, 'REAL-ACCOUNT-TOKEN')
      const r = await mkProbe(stub.base, [wbAccount({ credential: { apiKeyFile: file } })]).probeProvider(24)
      expect(r.ok).toBe(true)
      expect(stub.hits[0]).toContain('REAL-ACCOUNT-TOKEN')
    } finally {
      await stub.close()
    }
  })

  test('批量扫描：账号全不可用时每个模型都如实报同一原因，且不打上游', async () => {
    const stub = await stubUpstream('never')
    try {
      const models = ['m1', 'm2', 'm3']
      const r = await mkProbe(stub.base, [wbAccount({ status: 'exhausted' })])
        .probeModels(24, models)
      expect(r).toHaveLength(3)
      for (const m of r) {
        expect(m.ok).toBe(false)
        expect(m.error).toContain('账号池无可用账号')
      }
      expect(stub.hits).toHaveLength(0)
    } finally {
      await stub.close()
    }
  })
})

// ---- 凭据文案（upstream.ts）----

describe('凭据缺失文案：账号全不可用时补一句账号池真相', () => {
  const p = wbProvider('https://www.workbuddy.ai/v2')

  test('不传账号（或全可用）→ 文案与历史逐字一致（issue #1 用例在守这条）', () => {
    expect(missingCredentialMessage(p)).toBe(
      '环境变量 WB_TOKEN 未设置 provider=workbuddy-ai'
      + '（先 export WB_TOKEN=... 并重启网关，或到 Providers 点「一键导入」把桌面登录态导入账号池）')
    expect(missingCredentialMessage(p, [])).toBe(missingCredentialMessage(p))
    expect(missingCredentialMessage(p, [wbAccount({ status: 'available' })]))
      .toBe(missingCredentialMessage(p))
  })

  test('全部不可用 → 原动作保留 + 追加账号池真相（两种病因可能并存，不能丢一个）', () => {
    const msg = missingCredentialMessage(p, [
      wbAccount({ id: 'a', status: 'exhausted' }), wbAccount({ id: 'b', status: 'disabled' }),
    ])
    expect(msg).toContain('环境变量 WB_TOKEN 未设置') // 原动作还在
    expect(msg).toContain('该 Provider 名下还有 2 个账号，全部不可用')
    expect(msg).toContain('额度用尽 1、已停用 1')
    expect(msg).toContain('到账号页「重置」或换号后重试')
  })

  test('文件型凭据分支不受影响（那条路与账号池无关）', () => {
    const pf = { ...p, credential: { apiKeyFile: 'config/credentials/x-jwt' } }
    expect(missingCredentialMessage(pf, [wbAccount({ status: 'disabled' })]))
      .toContain('凭据文件读不到')
  })
})
