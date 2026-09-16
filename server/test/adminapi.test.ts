// 管理面 REST 移植测试（行为锚点对齐 Go internal/adminapi/*_test.go）。
// 契约冻结源：web/src/api.js（路径/方法/形状一字不差）。

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createAdminApi } from '../src/adminapi/index.ts'
import { MemoryAccountStore, MemoryEgressStore, MemoryProviderStore } from '../src/adminapi/store.ts'
import { usageStatsSource } from '../src/adminapi/stats.ts'
import { Store } from '../src/usage/store.ts'
import type { Breakdown } from '../src/usage/store.ts'
import type { UsageLog } from '../src/model/index.ts'
import type {
  AccountProber, AccountResetter, AccountRuntime, DiscoverSource, Finding, ModelProbe, ProviderModelLister,
  ProviderModelProber, ProviderProber, StatsSource,
} from '../src/adminapi/types.ts'
import type { ModelList, ProbeResult } from '../src/gateway/probe.ts'
import type { Account, Provider } from '../src/model/index.ts'

// ---- 桩件 ----

class StubProber implements ProviderProber {
  constructor(readonly res: ProbeResult) {}
  probeProvider(): Promise<ProbeResult> | ProbeResult { return this.res }
}

class StubLister implements ProviderModelLister {
  constructor(
    private list: ModelList = { models: [], source: '' },
    private err = '',
  ) {}
  listProviderModels(): Promise<ModelList> {
    if (this.err) return Promise.reject(new Error(this.err))
    return Promise.resolve(this.list)
  }
}

class StubModelProber implements ProviderModelProber {
  constructor(readonly res: ModelProbe[]) {}
  probeModels(): Promise<ModelProbe[]> { return Promise.resolve(this.res) }
}

class StubDiscover implements DiscoverSource {
  constructor(readonly findings: Finding[]) {}
  scan(): Finding[] { return this.findings }
}

class StubResetter implements AccountResetter {
  calls: string[] = []
  constructor(readonly ret: boolean) {}
  resetAccount(id: string): boolean { this.calls.push(id); return this.ret }
}

const stubStats: StatsSource = {
  summarize: () => ({
    requests: 5,
    tokens: {
      inputTokens: 100, outputTokens: 200, cacheReadTokens: 0,
      cacheCreationTokens: 0, reasoningTokens: 0, totalTokens: 300,
    },
    errors: 1,
  }),
  breakdown: () => Promise.resolve({
    totals: {
      requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, reasoningTokens: 0, totalTokens: 0, errors: 0, cacheHitRate: 0,
    },
    daily: [], byModel: [],
  }),
}

// ---- 装配 ----

// 便捷构造：填齐 Provider 必填字段
const mkProvider = (over: Partial<Provider> & Pick<Provider, 'id'>): Provider => {
  const p: Provider = {
    id: over.id, sourceId: 'z', displayName: '', accessKind: 'official', risk: 'low',
    stability: 'stable', api: '', baseUrl: '', credential: {}, enabled: true,
    priority: 0, models: [],
  }
  for (const [k, v] of Object.entries(over)) {
    if (k !== 'id') (p as unknown as Record<string, unknown>)[k] = v
  }
  return p
}

const providerBody = {
  id: 'p1', sourceId: 's', displayName: 'P1', accessKind: 'official', risk: 'low',
  stability: 'stable', api: 'anthropic-messages', baseUrl: 'https://gw.example.com',
  credential: { apiKeyEnv: 'K' }, enabled: true, priority: 1,
}

interface BuildOpts {
  key?: string
  egresses?: { id: string; kind: string; addr: string }[]
  providers?: Provider[]
  accounts?: Account[]
  stats?: StatsSource
  discover?: DiscoverSource
  resetter?: AccountResetter
  accountRuntime?: AccountRuntime
  accountProber?: AccountProber
  prober?: ProviderProber
  lister?: ProviderModelLister
  modelProber?: ProviderModelProber
  notify?: () => void
  sidecar?: Hono
  projects?: Hono
}

function build(o: BuildOpts = {}): Hono {
  return createAdminApi({
    adminKey: o.key ?? 'secret',
    egresses: o.egresses && (() => { const st = new MemoryEgressStore(); for (const e of o.egresses) st.put(e); return st })(),
    providers: new MemoryProviderStore(o.providers),
    accounts: new MemoryAccountStore(o.accounts),
    stats: o.stats ?? stubStats,
    discover: o.discover,
    resetter: o.resetter,
    accountRuntime: o.accountRuntime,
    accountProber: o.accountProber,
    prober: o.prober,
    lister: o.lister,
    modelProber: o.modelProber,
    notify: o.notify,
    sidecar: o.sidecar,
    projects: o.projects,
  })
}

type CallOpts = { key?: string; bearer?: string; body?: unknown }

function caller(app: Hono) {
  return async (method: string, path: string, o: CallOpts = {}): Promise<Response> => {
    const headers: Record<string, string> = {}
    if (o.key) headers['X-Admin-Key'] = o.key
    if (o.bearer) headers['Authorization'] = `Bearer ${o.bearer}`
    return app.request(path, {
      method,
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    })
  }
}

// cwd 隔离（quick-import / import-account 的凭据文件写在相对路径 config/credentials/ 下）
let workdir: string
beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'polycode-adminapi-'))
})
afterAll(() => rmSync(workdir, { recursive: true, force: true }))
let prevCwd = ''
afterEach(() => {
  if (prevCwd) {
    process.chdir(prevCwd)
    prevCwd = ''
  }
})
function isolateCwd(): string {
  prevCwd = process.cwd()
  const dir = mkdtempSync(join(tmpdir(), 'polycode-adminapi-cwd-'))
  process.chdir(dir)
  return dir
}

function makeAuthFile(nickname: string): { tokenPath: string; token: string } {
  const token = `hdr.${Buffer.from(JSON.stringify({ n: nickname })).toString('base64url')}.sig`
  const tokenPath = join(workdir, `wb-${nickname}.info`)
  writeFileSync(tokenPath, JSON.stringify({
    auth: { accessToken: token, tokenType: 'Bearer' },
    account: { uid: `uid-${nickname}`, nickname, type: 'personal' },
  }))
  return { tokenPath, token }
}

const readyProvider = (id: string): Provider => ({
  id, sourceId: 's', displayName: 'D', accessKind: 'session-reuse', risk: 'medium',
  riskNote: 'n', stability: 'beta', api: 'openai-completions',
  baseUrl: 'https://x.example.com/v2', enabled: true, priority: 0, models: [],
  credential: {},
})

// ---- 鉴权 ----

describe('鉴权（对齐 Go TestAuth/TestAuthOpenMode）', () => {
  test('key 为空 = 裸跑放行', async () => {
    const app = build({ key: '' })
    const call = caller(app)
    expect((await call('GET', '/admin/api/providers')).status).toBe(200)
    expect((await call('POST', '/admin/api/providers', { body: providerBody })).status).toBe(201)
    expect((await call('GET', '/admin/api/stats')).status).toBe(200)
  })

  test('有 key 时：无 key 401 / 错 key 401 / X-Admin-Key 200 / Bearer 200', async () => {
    const app = build()
    const call = caller(app)
    const no = await call('GET', '/admin/api/providers')
    expect(no.status).toBe(401)
    const errBody = await no.json() as { error: { type: string; message: string } }
    expect(errBody.error.type).toBe('authentication_error')
    expect(errBody.error.message).toBe('管理口令无效')
    expect((await call('GET', '/admin/api/providers', { key: 'wrong' })).status).toBe(401)
    expect((await call('GET', '/admin/api/providers', { key: 'secret' })).status).toBe(200)
    expect((await call('GET', '/admin/api/providers', { bearer: 'secret' })).status).toBe(200)
  })
})

// ---- providers CRUD ----

describe('providers CRUD（对齐 Go TestProviderCRUD/PatchReadonly/Validation）', () => {
  test('全流程：空列表→创建→重复409→列表→PATCH→删→再删404', async () => {
    const call = caller(build())
    const empty = await call('GET', '/admin/api/providers', { key: 'secret' })
    expect(empty.status).toBe(200)
    expect(((await empty.json()) as { providers: unknown[] }).providers).toEqual([])

    const created = await call('POST', '/admin/api/providers', { key: 'secret', body: providerBody })
    expect(created.status).toBe(201)
    const p = await created.json() as Provider
    expect(p.id).toBe('p1')
    expect(p.models).toEqual([]) // Go: nil models → []

    expect((await call('POST', '/admin/api/providers', { key: 'secret', body: providerBody })).status).toBe(409)

    const list = await call('GET', '/admin/api/providers', { key: 'secret' })
    expect(((await list.json()) as { providers: unknown[] }).providers).toHaveLength(1)

    const patched = await call('PATCH', '/admin/api/providers/p1', {
      key: 'secret', body: { enabled: false, riskNote: '降级' },
    })
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as Provider).enabled).toBe(false)

    expect((await call('DELETE', '/admin/api/providers/p1', { key: 'secret' })).status).toBe(204)
    expect((await call('DELETE', '/admin/api/providers/p1', { key: 'secret' })).status).toBe(404)
  })

  test('PATCH 只读字段 400（id/api/sourceId）', async () => {
    const call = caller(build())
    await call('POST', '/admin/api/providers', { key: 'secret', body: providerBody })
    for (const patch of [{ id: 'p2' }, { api: 'openai-completions' }, { sourceId: 's2' }]) {
      const res = await call('PATCH', '/admin/api/providers/p1', { key: 'secret', body: patch })
      expect(res.status).toBe(400)
    }
  })

  test('POST 校验：非法 api 点名 / 高风险无 riskNote / 非法 id', async () => {
    const call = caller(build())
    const badAPI = await call('POST', '/admin/api/providers', {
      key: 'secret',
      body: { ...providerBody, api: 'nope' },
    })
    expect(badAPI.status).toBe(400)
    expect(((await badAPI.json()) as { error: { message: string } }).error.message).toContain('nope')

    const noNote = await call('POST', '/admin/api/providers', {
      key: 'secret',
      body: { ...providerBody, accessKind: 'reverse', risk: 'high', riskNote: undefined },
    })
    expect(noNote.status).toBe(400)

    const badID = await call('POST', '/admin/api/providers', {
      key: 'secret', body: { ...providerBody, id: 'Bad_ID' },
    })
    expect(badID.status).toBe(400)
  })

  test('模型采用只增不减：已有元数据保留，缺的追加为可用（对齐 Go TestProvidersPatchModelsMerge）', async () => {
    const keep = mkProvider({
      id: 'pz',
      models: [{ id: 'keep', providerId: 'pz', manual: true, enabled: true }],
    })
    const call = caller(build({ providers: [keep] }))
    const res = await call('PATCH', '/admin/api/providers/pz', {
      key: 'secret', body: { models: ['keep', 'new1', { id: 'new2' }] },
    })
    expect(res.status).toBe(200)
    const got = (await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)).providers[0]!
    const byID = new Map(got.models.map((m) => [m.id, m]))
    expect(got.models).toHaveLength(3)
    expect(byID.get('keep')!.manual).toBe(true)
    expect(byID.get('new1')!.enabled).toBe(true)
    expect(byID.get('new2')!.enabled).toBe(true)
  })

  test('PATCH models 可带 protocol/caps 一并写入', async () => {
    const keep = mkProvider({
      id: 'pz',
      models: [{ id: 'm1', providerId: 'pz', manual: false, enabled: true }],
    })
    const call = caller(build({ providers: [keep] }))
    await call('PATCH', '/admin/api/providers/pz', {
      key: 'secret',
      body: { models: [{ id: 'm1', protocol: 'openai-responses', caps: { input: ['text', 'image'], contextWindow: 128000, maxOutputTokens: 8192 } }] },
    })
    const got = (await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)).providers[0]!
    expect(got.models[0]!.api).toBe('openai-responses')
    expect(got.models[0]!.input).toEqual(['text', 'image'])
    expect(got.models[0]!.contextWindow).toBe(128000)
    expect(got.models[0]!.maxOutputTokens).toBe(8192)
  })

  test('响应只含凭据引用，无明文字段（对齐 Go TestCredentialNoPlaintext）', async () => {
    const call = caller(build())
    await call('POST', '/admin/api/providers', {
      key: 'secret',
      body: { ...providerBody, credential: { apiKeyEnv: 'SUPERKEY' } },
    })
    const body = await call('GET', '/admin/api/providers', { key: 'secret' }).then((r) => r.text())
    for (const leaked of ['api_key', '"apiKey"', 'secret', 'passwd', 'password', 'apiSecret']) {
      expect(body).not.toContain(leaked)
    }
    expect(body).toContain('apiKeyEnv')
  })

  test('accountIds 白名单已删除：PATCH 出现即 400（只读）', async () => {
    const call = caller(build({
      accounts: [
        { id: 'a1', sourceId: 's', credential: {}, status: 'available', fails: 0 },
      ],
    }))
    await call('POST', '/admin/api/providers', { key: 'secret', body: providerBody })
    // 白名单字段不再接受：只读字段出现即 400
    expect((await call('PATCH', '/admin/api/providers/p1', {
      key: 'secret', body: { accountIds: ['a1'] },
    })).status).toBe(400)
  })

  test('POST 创建带 accountIds：未知字段忽略，照常 201（不存）', async () => {
    const call = caller(build({
      accounts: [
        { id: 'a1', sourceId: 's', credential: {}, status: 'available', fails: 0 },
      ],
    }))
    const res = await call('POST', '/admin/api/providers', {
      key: 'secret', body: { ...providerBody, id: 'pz', accountIds: ['a1'] },
    })
    expect(res.status).toBe(201)
    const got = (await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)).providers.find((p) => p.id === 'pz')!
    expect((got as unknown as Record<string, unknown>).accountIds).toBeUndefined()
  })

  test('账号权重 weight：PATCH 可设；非法值 400', async () => {
    const call = caller(build({
      accounts: [
        { id: 'a1', sourceId: 's', credential: {}, status: 'available', fails: 0 },
      ],
    }))
    expect((await call('PATCH', '/admin/api/accounts/a1', {
      key: 'secret', body: { weight: 3 },
    })).status).toBe(200)
    const got = (await call('GET', '/admin/api/accounts', { key: 'secret' })
      .then((r) => r.json() as Promise<{ accounts: Account[] }>)).accounts[0]!
    expect(got.weight).toBe(3)
    // 非法值：0/负数/非数字
    for (const bad of [0, -1, 'x', NaN]) {
      expect((await call('PATCH', '/admin/api/accounts/a1', {
        key: 'secret', body: { weight: bad },
      })).status).toBe(400)
    }
  })
})

// 内置 Provider 概念已移除：Provider 一律由发现/导入或手填生成，都可删。
// （原「内置三源不可删、重启补回」的保护与前端「内置」标签一并删掉。）
describe('Provider 可删（内置概念已移除）', () => {
  test('配置文件种进来的 Provider 也照常可删 204', async () => {
    const wb = mkProvider({ id: 'wb-direct', sourceId: 'workbuddy' })
    const acme = mkProvider({ id: 'acme', sourceId: 'acme' })
    const call = caller(build({ providers: [wb, acme] }))
    expect((await call('DELETE', '/admin/api/providers/wb-direct', { key: 'secret' })).status).toBe(204)
    expect((await call('DELETE', '/admin/api/providers/acme', { key: 'secret' })).status).toBe(204)
    const list = await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)
    expect(list.providers).toHaveLength(0)
  })
})

// ---- accounts ----

describe('accounts CRUD（对齐 Go TestAccountCRUD）', () => {
  test('全流程 + PATCH 白名单', async () => {
    const call = caller(build())
    const a = { id: 'a1', sourceId: 's', displayName: '主号', credential: { apiKeyEnv: 'JWT' } }
    const created = await call('POST', '/admin/api/accounts', { key: 'secret', body: a })
    expect(created.status).toBe(201)
    const ac = await created.json() as Account
    expect(ac.status).toBe('available') // 默认 available

    expect((await call('POST', '/admin/api/accounts', { key: 'secret', body: a })).status).toBe(409)

    const patched = await call('PATCH', '/admin/api/accounts/a1', {
      key: 'secret', body: { status: 'disabled' },
    })
    expect(patched.status).toBe(200)

    expect((await call('PATCH', '/admin/api/accounts/a1', { key: 'secret', body: { id: 'a2' } })).status).toBe(400)
    expect((await call('PATCH', '/admin/api/accounts/a1', { key: 'secret', body: { status: 'bogus' } })).status).toBe(400)
    expect((await call('DELETE', '/admin/api/accounts/a1', { key: 'secret' })).status).toBe(204)
  })

  test('缺 id/sourceId 400；非法 status 400', async () => {
    const call = caller(build())
    expect((await call('POST', '/admin/api/accounts', { key: 'secret', body: { id: 'x' } })).status).toBe(400)
    expect((await call('POST', '/admin/api/accounts', { key: 'secret', body: { id: 'a2', sourceId: 's' } })).status).toBe(201)
    expect((await call('POST', '/admin/api/accounts', {
      key: 'secret', body: { id: 'a3', sourceId: 's', status: 'cooldown' },
    })).status).toBe(400)
  })

  // 接入方式与风险等级随认知更新，管理面要能改（UI 把它们收进「高级选项」）。
  test('PATCH accessKind/risk：合法值写入，非法值 400', async () => {
    const call = caller(build())
    await call('POST', '/admin/api/providers', { key: 'secret', body: providerBody })
    const res = await call('PATCH', '/admin/api/providers/p1', {
      key: 'secret', body: { accessKind: 'reverse', risk: 'medium', riskNote: '第三方反代，可能封号' },
    })
    expect(res.status).toBe(200)
    const got = (await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)).providers[0]!
    expect(got.accessKind).toBe('reverse')
    expect(got.risk).toBe('medium')

    expect((await call('PATCH', '/admin/api/providers/p1', {
      key: 'secret', body: { accessKind: 'telepathy' },
    })).status).toBe(400)
    expect((await call('PATCH', '/admin/api/providers/p1', {
      key: 'secret', body: { risk: 'catastrophic' },
    })).status).toBe(400)
  })

  // 中/高风险必须带风险说明，否则使用者看不到风险提示（与 providerValidate 同一约束）。
  test('PATCH risk=high 但无 riskNote：拒绝，且不改动已有风险等级', async () => {
    const call = caller(build())
    await call('POST', '/admin/api/providers', { key: 'secret', body: providerBody })
    expect((await call('PATCH', '/admin/api/providers/p1', {
      key: 'secret', body: { risk: 'high' },
    })).status).toBe(400)
    const got = (await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)).providers[0]!
    expect(got.risk).toBe('low')
  })

  // 跨字段组合绕过：risk 与 riskNote 单看都合法，合起来违反「高风险必须有说明」。
  // 逐字段 setter 拦不住这种，收尾的 providerValidate 必须兜住。
  test('PATCH 同时清空 riskNote 并提高风险：拒绝（跨字段约束）', async () => {
    const call = caller(build())
    await call('POST', '/admin/api/providers', {
      key: 'secret',
      body: { ...providerBody, risk: 'medium', riskNote: '原本有说明' },
    })
    const res = await call('PATCH', '/admin/api/providers/p1', {
      key: 'secret', body: { risk: 'high', riskNote: '' },
    })
    expect(res.status).toBe(400)
    const got = (await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)).providers[0]!
    expect(got.risk).toBe('medium')
    expect(got.riskNote).toBe('原本有说明')
  })

  test('变更通知：增删改各一次×两类 = 6（对齐 Go TestChangeNotifier）', async () => {
    let n = 0
    const call = caller(build({ notify: () => { n++ } }))
    await call('POST', '/admin/api/providers', { key: 'secret', body: providerBody })
    await call('PATCH', '/admin/api/providers/p1', { key: 'secret', body: { credential: { apiKeyEnv: 'NEW_ENV' } } })
    await call('DELETE', '/admin/api/providers/p1', { key: 'secret' })
    await call('POST', '/admin/api/accounts', { key: 'secret', body: { id: 'a1', sourceId: 's' } })
    await call('PATCH', '/admin/api/accounts/a1', { key: 'secret', body: { credential: { apiKeyFile: '/tmp/k' } } })
    await call('DELETE', '/admin/api/accounts/a1', { key: 'secret' })
    expect(n).toBe(6)
  })

  // 稳定性在管理面可改（UI 把它收进「高级选项」，但收起来也要能存住）。
  test('PATCH stability：合法值写入，非法值 400', async () => {
    const call = caller(build())
    await call('POST', '/admin/api/providers', { key: 'secret', body: providerBody })
    const okRes = await call('PATCH', '/admin/api/providers/p1', {
      key: 'secret', body: { stability: 'experimental' },
    })
    expect(okRes.status).toBe(200)
    expect((await okRes.json() as { stability: string }).stability).toBe('experimental')
    // 非法值必须拒绝，且不污染已有值
    expect((await call('PATCH', '/admin/api/providers/p1', {
      key: 'secret', body: { stability: 'flaky' },
    })).status).toBe(400)
    const got = (await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)).providers[0]!
    expect(got.stability).toBe('experimental')
  })

  // 前端表单不再暴露 apiKeyFile（用户不关心 Key 存哪个文件），
  // 但一键导入生成的 Provider 全靠它取 Key：不带 credential 的 PATCH 必须原样保留。
  test('PATCH 不带 credential：文件型 Key 引用不被清空（前端表单不覆盖）', async () => {
    const call = caller(build())
    await call('POST', '/admin/api/providers', {
      key: 'secret',
      body: { ...providerBody, credential: { apiKeyFile: 'config/credentials/acme-key' } },
    })
    await call('PATCH', '/admin/api/providers/p1', {
      key: 'secret', body: { displayName: '改名', stability: 'beta', streamOnly: true },
    })
    const got = (await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)).providers[0]!
    expect(got.credential.apiKeyFile).toBe('config/credentials/acme-key')
    expect(got.displayName).toBe('改名')
  })
})

describe('账号列表带运行时状态（冷却/连败不在 DB 里）', () => {
  const accts = [{ id: 'a1', sourceId: 's', credential: {}, status: 'available' as const, fails: 0 }]

  test('池内冷却覆盖 DB 的 available，并显示真实连败数', async () => {
    const until = new Date(Date.now() + 60_000)
    const call = caller(build({
      accounts: accts,
      accountRuntime: { runtime: () => ({ status: 'cooldown', fails: 4, cooldownUntil: until }) },
    }))
    const body = await (await call('GET', '/admin/api/accounts', { key: 'secret' })).json() as { accounts: Account[] }
    expect(body.accounts[0]!.status).toBe('cooldown')
    expect(body.accounts[0]!.fails).toBe(4)
    // JSON 一趟后是字符串（前端 new Date(...) 即可）
    expect(new Date(body.accounts[0]!.cooldownUntil as unknown as string)).toEqual(until)
  })

  test('过期冷却不显示为冷却中（避免 UI 撒谎）', async () => {
    const call = caller(build({
      accounts: accts,
      accountRuntime: { runtime: () => ({ status: 'cooldown', fails: 4, cooldownUntil: new Date(Date.now() - 1000) }) },
    }))
    const body = await (await call('GET', '/admin/api/accounts', { key: 'secret' })).json() as { accounts: Account[] }
    expect(body.accounts[0]!.status).toBe('available')
    expect(body.accounts[0]!.cooldownUntil).toBeUndefined()
  })

  test('未接运行时：退化为 DB 状态（不炸）', async () => {
    const call = caller(build({ accounts: accts }))
    const body = await (await call('GET', '/admin/api/accounts', { key: 'secret' })).json() as { accounts: Account[] }
    expect(body.accounts[0]!.status).toBe('available')
    expect(body.accounts[0]!.fails).toBe(0)
  })

  // 健康度由后端算好下发：前端不再复制阈值常量（改阈值只改 model 层一处）。
  test('列表带 health：连败达阈值 → warn；冷却 → warn；停用 → bad', async () => {
    const cases: [number, string, string][] = [
      [0, 'available', 'ok'],
      [2, 'available', 'ok'], // 阈值前一档仍绿
      [3, 'available', 'warn'],
    ]
    for (const [fails, status, want] of cases) {
      const call = caller(build({
        accounts: accts,
        accountRuntime: { runtime: () => ({ status, fails }) },
      }))
      const body = await (await call('GET', '/admin/api/accounts', { key: 'secret' })).json() as { accounts: { health?: string }[] }
      expect(body.accounts[0]!.health).toBe(want)
    }
    // 冷却中 → warn
    const cool = caller(build({
      accounts: accts,
      accountRuntime: { runtime: () => ({ status: 'cooldown', fails: 0, cooldownUntil: new Date(Date.now() + 60_000) }) },
    }))
    const cb = await (await cool('GET', '/admin/api/accounts', { key: 'secret' })).json() as { accounts: { health?: string }[] }
    expect(cb.accounts[0]!.health).toBe('warn')
    // 停用 → bad（未接运行时也要有 health）
    const dis = caller(build({ accounts: [{ id: 'a1', sourceId: 's', credential: {}, status: 'disabled' as const, fails: 0 }] }))
    const db = await (await dis('GET', '/admin/api/accounts', { key: 'secret' })).json() as { accounts: { health?: string }[] }
    expect(db.accounts[0]!.health).toBe('bad')
  })
})

describe('账号测试端点（指定账号打真实请求）', () => {
  const accts = [{ id: 'a1', sourceId: 's', credential: {}, status: 'available' as const, fails: 0 }]

  test('200 回显探测结果，并把 model 透传给 prober', async () => {
    const seen: [string, string][] = []
    const call = caller(build({
      accounts: accts,
      accountProber: {
        probeAccount: (id, model) => { seen.push([id, model]); return Promise.resolve({ ok: true, model: 's/glm-4.6', latencyMs: 12 }) },
      },
    }))
    const res = await call('POST', '/admin/api/accounts/a1/test', { key: 'secret', body: { model: 'glm-4.6' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, model: 's/glm-4.6', latencyMs: 12 })
    expect(seen).toEqual([['a1', 'glm-4.6']])
  })

  test('model 缺省：传空串（由 prober 挑默认模型）', async () => {
    const seen: string[] = []
    const call = caller(build({
      accounts: accts,
      accountProber: { probeAccount: (_id, model) => { seen.push(model); return { ok: false, error: 'x' } } },
    }))
    await call('POST', '/admin/api/accounts/a1/test', { key: 'secret' })
    expect(seen).toEqual([''])
  })

  test('未知账号 404；未接线 501', async () => {
    const call = caller(build({
      accounts: accts,
      accountProber: { probeAccount: () => ({ ok: true }) },
    }))
    expect((await call('POST', '/admin/api/accounts/nope/test', { key: 'secret' })).status).toBe(404)
    expect((await caller(build({ accounts: accts }))('POST', '/admin/api/accounts/a1/test', { key: 'secret' })).status).toBe(501)
  })
})

describe('recheck 恢复键（对齐 Go TestAccountRecheck）', () => {
  test('存在则 200 并调 ResetAccount；未知 404；未接线也 200', async () => {
    const rs = new StubResetter(true)
    const call = caller(build({ resetter: rs, accounts: [{ id: 'a1', sourceId: 's', credential: {}, status: 'available', fails: 0 }] }))
    const ok = await call('POST', '/admin/api/accounts/a1/recheck', { key: 'secret' })
    expect(ok.status).toBe(200)
    const body = await ok.json() as { id: string; reset: boolean; message: string }
    expect(body).toEqual({ id: 'a1', reset: true, message: body.message })
    expect(rs.calls).toEqual(['a1'])
    expect((await call('POST', '/admin/api/accounts/nope/recheck', { key: 'secret' })).status).toBe(404)

    const bare = caller(build())
    expect((await bare('POST', '/admin/api/accounts/a1/recheck', { key: 'secret' })).status).toBe(404)
  })
})

// ---- test / models / scan / protocol ----

describe('test/models/scan/protocol 端点（Probe 接口打桩）', () => {
  test('test：打通回显文本；未接线 501', async () => {
    const ok = caller(build({ prober: new StubProber({ ok: true, model: 'zcode/glm-5', text: 'hi', latencyMs: 320 }) }))
    const res = await ok('POST', '/admin/api/providers/pz/test', { key: 'secret' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, text: 'hi', latencyMs: 320 })

    const unwired = caller(build())
    expect((await unwired('POST', '/admin/api/providers/pz/test', { key: 'secret' })).status).toBe(501)
  })

  test('models：透出上游列表；listler 报错 502；未接线 501', async () => {
    const list: ModelList = { models: ['glm-5', 'glm-6'], source: 'upstream' }
    const wired = caller(build({ lister: new StubLister(list) }))
    const res = await wired('GET', '/admin/api/providers/pz/models', { key: 'secret' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ models: ['glm-5', 'glm-6'], source: 'upstream' })

    const err = caller(build({ lister: new StubLister(undefined, '上游不支持模型列表') }))
    expect((await err('GET', '/admin/api/providers/pz/models', { key: 'secret' })).status).toBe(502)

    const unwired = caller(build())
    expect((await unwired('GET', '/admin/api/providers/pz/models', { key: 'secret' })).status).toBe(501)
  })

  test('scan：回传结果并把探到的协议写回模型目录', async () => {
    const p = mkProvider({
      id: 'pz',
      models: [
        { id: 'm1', providerId: 'pz', manual: false, enabled: true, api: 'anthropic-messages' },
        { id: 'm2', providerId: 'pz', manual: false, enabled: true, api: 'anthropic-messages' },
      ],
    })
    const call = caller(build({
      providers: [p],
      modelProber: new StubModelProber([
        { model: 'm1', ok: true, protocol: 'openai-completions', text: 'hey', latencyMs: 42 },
        { model: 'm2', ok: false, error: 'http 503' },
      ]),
    }))
    const res = await call('POST', '/admin/api/providers/pz/scan', {
      key: 'secret', body: { models: ['m1', 'm2'] },
    })
    expect(res.status).toBe(200)
    const { results } = await res.json() as { results: ModelProbe[] }
    expect(results).toHaveLength(2)
    const after = await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)
    const models = new Map(after.providers[0]!.models.map((m) => [m.id, m]))
    expect(models.get('m1')!.api).toBe('openai-completions')
    expect(models.get('m2')!.api).toBe('anthropic-messages') // 失败不改
  })

  test('scan 未接线 501；空 body 用已配置模型（不报错）', async () => {
    const p = mkProvider({ id: 'pz' })
    const unwired = caller(build({ providers: [p] }))
    expect((await unwired('POST', '/admin/api/providers/pz/scan', { key: 'secret' })).status).toBe(501)

    const empty = caller(build({
      providers: [p],
      modelProber: new StubModelProber([{ model: '', ok: false, error: '没有可测模型' }]),
    }))
    const res = await empty('POST', '/admin/api/providers/pz/scan', { key: 'secret', body: {} })
    expect(res.status).toBe(200)
  })

  test('protocol 端点：设置 / 继承 / 非法 / 双 404', async () => {
    const p = mkProvider({
      id: 'pz', api: 'anthropic-messages',
      models: [{ id: 'm1', providerId: 'pz', manual: false, enabled: true }],
    })
    const call = caller(build({ providers: [p] }))
    const set = await call('PUT', '/admin/api/providers/pz/models/m1/protocol', {
      key: 'secret', body: { protocol: 'openai-responses' },
    })
    expect(set.status).toBe(200)
    expect(((await set.json()) as { api?: string }).api).toBe('openai-responses')

    const inherit = await call('PUT', '/admin/api/providers/pz/models/m1/protocol', {
      key: 'secret', body: { protocol: '' },
    })
    expect(inherit.status).toBe(200)
    expect((await inherit.json() as { api?: string }).api).toBeUndefined() // 空 = 继承 Provider 默认

    expect((await call('PUT', '/admin/api/providers/pz/models/m1/protocol', {
      key: 'secret', body: { protocol: 'nope' },
    })).status).toBe(400)
    expect((await call('PUT', '/admin/api/providers/nope/models/m1/protocol', {
      key: 'secret', body: { protocol: '' },
    })).status).toBe(404)
    expect((await call('PUT', '/admin/api/providers/pz/models/nope/protocol', {
      key: 'secret', body: { protocol: '' },
    })).status).toBe(404)
  })
})

// ---- stats / breakdown（真实 usage Store 临时库）----

describe('stats/breakdown（真实 usage Store）', () => {
  test('形状 {requests, tokens{...}, errors}；未接线 501', async () => {
    const call = caller(build())
    const res = await call('GET', '/admin/api/stats', { key: 'secret' })
    expect(res.status).toBe(200)
    const s = await res.json() as { requests: number; errors: number; tokens: Record<string, number> }
    expect(s.requests).toBe(5)
    expect(s.errors).toBe(1)
    expect(s.tokens.inputTokens).toBe(100)
    expect(s.tokens.outputTokens).toBe(200)
  })

  test('unwired stats → 501', async () => {
    const call = caller(createAdminApi({
      adminKey: 'secret',
      providers: new MemoryProviderStore(),
      accounts: new MemoryAccountStore(),
    }))
    expect((await call('GET', '/admin/api/stats', { key: 'secret' })).status).toBe(501)
    expect((await call('GET', '/admin/api/breakdown', { key: 'secret' })).status).toBe(501)
  })

  test('真实 usage Store：stats 嵌套 tokens 形状；breakdown totals/daily/byModel + days 过滤', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'polycode-adminapi-usage-'))
    try {
      const store = await Store.open(join(dir, 'usage.db'))
      const log = (over: Partial<UsageLog>): UsageLog => ({
        id: 0, ts: new Date(), requestId: 'r', sourceId: 's', providerId: 'p',
        modelId: 'm', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        cacheCreationTokens: 0, reasoningTokens: 0, totalTokens: 0, accuracy: 'exact',
        latencyMs: 5, status: 'ok', stream: false, ...over,
      })
      await store.insertLog(log({
        requestId: 'r1', inputTokens: 10, outputTokens: 20, cacheReadTokens: 5,
        cacheCreationTokens: 3, reasoningTokens: 8,
      }))
      await store.insertLog(log({ requestId: 'r2', status: 'upstream_error', inputTokens: 1 }))
      // 300 天前的旧记录：days=30 应滤掉，默认 365 应含
      await store.insertLog(log({ requestId: 'old', ts: new Date(Date.now() - 300 * 86_400_000) }))

      const call = caller(build({ stats: usageStatsSource(store) }))
      const stats = await call('GET', '/admin/api/stats', { key: 'secret' })
        .then((r) => r.json()) as { requests: number; errors: number; tokens: Record<string, number> }
      expect(stats.requests).toBe(3)
      expect(stats.errors).toBe(1)
      expect(stats.tokens.inputTokens).toBe(11)
      expect(stats.tokens.outputTokens).toBe(20)
      expect(stats.tokens.cacheReadTokens).toBe(5)
      // 上游 wire 口径：r1 input(10)+output(20)=30，r2=1+0=1 → 31
      expect(stats.tokens.totalTokens).toBe(31)

      const bdAll = await call('GET', '/admin/api/breakdown', { key: 'secret' })
        .then((r) => r.json()) as Breakdown
      expect(bdAll.totals.requests).toBe(3)
      expect(bdAll.daily).toHaveLength(2) // 今天 + 400 天前
      expect(bdAll.byModel).toHaveLength(1)
      expect(bdAll.byModel[0]!.modelId).toBe('m')

      const bd30 = await call('GET', '/admin/api/breakdown?days=30', { key: 'secret' })
        .then((r) => r.json()) as Breakdown
      expect(bd30.totals.requests).toBe(2)
      expect(bd30.daily).toHaveLength(1)

      // 非法 days 回落默认 365
      const bdBad = await call('GET', '/admin/api/breakdown?days=abc', { key: 'secret' })
        .then((r) => r.json()) as Breakdown
      expect(bdBad.totals.requests).toBe(3)
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---- discover ----

describe('discover 端点（DiscoverSource 打桩，对齐 Go discover_test.go）', () => {
  function discoverAPI(over: { providers?: Provider[] } = {}): { call: ReturnType<typeof caller> } {
    const findings: Finding[] = [
      { key: 'workbuddy', harness: 'WB', status: 'ready', detail: 'tester', suggestedProvider: readyProvider('wb-auto') },
      { key: 'zcode', harness: 'ZC', status: 'unknown', detail: 'unknown', actions: ['login'] },
    ]
    return { call: caller(build({ discover: new StubDiscover(findings), ...over })) }
  }

  test('列表透出且不含密钥字段名', async () => {
    const { call } = discoverAPI()
    const res = await call('GET', '/admin/api/discover', { key: 'secret' })
    expect(res.status).toBe(200)
    const body = await res.json() as { findings: Finding[] }
    expect(body.findings).toHaveLength(2)
    expect(JSON.stringify(body)).not.toContain('accessToken')
  })

  test('adopt：ready 201 落库；重复 200；未 ready 400；未知 404；非法 id 400', async () => {
    const { call } = discoverAPI()
    const first = await call('POST', '/admin/api/discover/adopt', { key: 'secret', body: { key: 'workbuddy' } })
    expect(first.status).toBe(201)
    expect(((await first.json()) as Provider).id).toBe('wb-auto')

    const second = await call('POST', '/admin/api/discover/adopt', { key: 'secret', body: { key: 'workbuddy' } })
    expect(second.status).toBe(200)
    expect(((await second.json()) as Provider).id).toBe('wb-auto')

    expect((await call('POST', '/admin/api/discover/adopt', { key: 'secret', body: { key: 'zcode' } })).status).toBe(400)
    expect((await call('POST', '/admin/api/discover/adopt', { key: 'secret', body: { key: 'nope' } })).status).toBe(404)
    expect((await call('POST', '/admin/api/discover/adopt', { key: 'secret', body: { key: 'workbuddy', id: 'Bad_ID' } })).status).toBe(400)
  })

  test('adopt 自定义 id 覆盖建议 ID', async () => {
    const { call } = discoverAPI()
    const res = await call('POST', '/admin/api/discover/adopt', { key: 'secret', body: { key: 'workbuddy', id: 'my-wb' } })
    expect(res.status).toBe(201)
    expect(((await res.json()) as Provider).id).toBe('my-wb')
  })

  // issue #1：采用只落了一个 credential.apiKeyEnv='WB_TOKEN' 的 Provider，池子是空的，
  // 进程里也没有 WB_TOKEN → 请求不带 Authorization 打到上游被拦成 HTML 401，
  // 用户看到的却是「上游鉴权失败」。采用必须像一键导入一样把桌面 JWT 一并导入账号池。
  test('adopt 一并导入活登录态入池（死登录态跳过），凭据文件 0600', async () => {
    isolateCwd()
    const alive = makeAuthFile('主号')
    const dead = makeAuthFile('过期号')
    const findings: Finding[] = [{
      key: 'workbuddy', harness: 'WB', status: 'ready', detail: '',
      suggestedProvider: { ...readyProvider('wb-auto'), sourceId: 'workbuddy', credential: { apiKeyEnv: 'WB_TOKEN' } },
      suggestedAccounts: [
        { nickname: '主号', uid: 'u1', alive: true, tokenPath: alive.tokenPath },
        { nickname: '过期号', uid: 'u2', alive: false, tokenPath: dead.tokenPath },
      ],
    }]
    const call = caller(build({ discover: new StubDiscover(findings) }))
    const res = await call('POST', '/admin/api/discover/adopt', { key: 'secret', body: { key: 'workbuddy' } })
    expect(res.status).toBe(201)

    // 账号真的进池了，且凭据文件内容就是桌面 token
    const accts = await call('GET', '/admin/api/accounts', { key: 'secret' })
      .then((r) => r.json() as Promise<{ accounts: Account[] }>)
    expect(accts.accounts).toHaveLength(1)
    expect(accts.accounts[0]!.displayName).toBe('主号')
    const credFile = accts.accounts[0]!.credential.apiKeyFile!
    const credPath = join(process.cwd(), credFile)
    expect(readFileSync(credPath, 'utf8')).toBe(alive.token)
    expect(statSync(credPath).mode & 0o777).toBe(0o600)
  })

  test('adopt 幂等：重复采用不再重复建账号', async () => {
    isolateCwd()
    const alive = makeAuthFile('主号')
    const findings: Finding[] = [{
      key: 'workbuddy', harness: 'WB', status: 'ready', detail: '',
      suggestedProvider: { ...readyProvider('wb-auto'), sourceId: 'workbuddy', credential: { apiKeyEnv: 'WB_TOKEN' } },
      suggestedAccounts: [{ nickname: '主号', uid: 'u1', alive: true, tokenPath: alive.tokenPath }],
    }]
    const call = caller(build({ discover: new StubDiscover(findings) }))
    await call('POST', '/admin/api/discover/adopt', { key: 'secret', body: { key: 'workbuddy' } })
    const again = await call('POST', '/admin/api/discover/adopt', { key: 'secret', body: { key: 'workbuddy' } })
    expect(again.status).toBe(200) // 幂等返回已有 Provider
    const accts = await call('GET', '/admin/api/accounts', { key: 'secret' })
      .then((r) => r.json() as Promise<{ accounts: Account[] }>)
    expect(accts.accounts).toHaveLength(1)
  })

  test('未接线：list 200 空列表；adopt/quick-import/import-account 501', async () => {
    const call = caller(build())
    const list = await call('GET', '/admin/api/discover', { key: 'secret' })
    expect(list.status).toBe(200)
    expect(((await list.json()) as { findings: unknown[] }).findings).toEqual([])
    expect((await call('POST', '/admin/api/discover/adopt', { key: 'secret', body: { key: 'x' } })).status).toBe(501)
    expect((await call('POST', '/admin/api/discover/quick-import', { key: 'secret', body: { key: 'x' } })).status).toBe(501)
    expect((await call('POST', '/admin/api/discover/import-account', {
      key: 'secret', body: { key: 'k', tokenPath: '/t', accountId: 'a', credentialFile: 'config/credentials/c' },
    })).status).toBe(501)
  })

  test('已接管的登录态标出 adoptedProviderId（key 命中与 suggestedProvider.sourceId 命中两条路径）', async () => {
    const findings: Finding[] = [
      { key: 'workbuddy', harness: 'WB', status: 'ready', detail: '', suggestedProvider: readyProvider('wb-auto') },
      { key: 'opencode-zen', harness: 'Zen', status: 'ready', detail: '', suggestedProvider: { ...readyProvider('zen'), sourceId: 'opencode' } },
    ]
    const wb = mkProvider({ id: 'wb-direct', sourceId: 'workbuddy' })
    const oc = mkProvider({ id: 'oc-thing', sourceId: 'opencode' })
    const call = caller(build({ discover: new StubDiscover(findings), providers: [wb, oc] }))
    const list = await call('GET', '/admin/api/discover', { key: 'secret' })
      .then((r) => r.json() as Promise<{ findings: Finding[] }>)
    expect(list.findings.find((f) => f.key === 'workbuddy')!.adoptedProviderId).toBe('wb-direct')
    expect(list.findings.find((f) => f.key === 'opencode-zen')!.adoptedProviderId).toBe('oc-thing')
  })

  // 真实缺陷（用户报「把 opencode 删了，再导入报错，导致 provider 里既看不到
  // opencode 也删不掉，而发现页还显示已导入」）：
  // 删掉 zen-auto 后 config/apps.yaml 里的 zen 仍带 sourceId=opencode，两个后果叠加：
  //   ① 发现页按 sourceId 判「已接管」→ 显示「已导入」，「一键导入」被禁用 → 永远导不进来；
  //   ② 那行 Provider 是配置文件种进来的 zen，用户看到的 id 与发现项草稿 id 不同 → 对不上号。
  // 护栏：已接管只能由真实存在的 Provider 行认定，且必须报出它真正的 id。
  test('删掉 Provider 后：不得再标「已导入」（否则导入入口被永久锁死）', async () => {
    const findings: Finding[] = [
      {
        key: 'opencode-zen', harness: 'Zen', status: 'ready', detail: '',
        suggestedProvider: { ...readyProvider('zen-auto'), sourceId: 'opencode' },
      },
    ]
    // DB 里已没有 sourceId=opencode 的任何 Provider（用户刚删干净）
    const call = caller(build({ discover: new StubDiscover(findings), providers: [] }))
    const list = await call('GET', '/admin/api/discover', { key: 'secret' })
      .then((r) => r.json() as Promise<{ findings: Finding[] }>)
    expect(list.findings.find((x) => x.key === 'opencode-zen')!.adoptedProviderId).toBeUndefined()
    // 且此时一键导入必须真的能建出来（不能被幂等短路成「已导入」）
    const res = await call('POST', '/admin/api/discover/quick-import', { key: 'secret', body: { key: 'opencode-zen' } })
    expect(res.status).toBe(200)
    expect(await call('GET', '/admin/api/providers/' + encodeURIComponent('zen-auto'), { key: 'secret' })).toBeTruthy()
  })

  test('配置里同 sourceId、不同 id 的 Provider：报出真正的接管者 id（用户才知道删哪行）', async () => {
    // config/apps.yaml 种下的是 zen（sourceId=opencode），而发现项草稿 id 是 zen-auto。
    const findings: Finding[] = [
      {
        key: 'opencode-zen', harness: 'Zen', status: 'ready', detail: '',
        suggestedProvider: { ...readyProvider('zen-auto'), sourceId: 'opencode' },
      },
    ]
    const call = caller(build({
      discover: new StubDiscover(findings),
      providers: [mkProvider({ id: 'zen', sourceId: 'opencode' })],
    }))
    const list = await call('GET', '/admin/api/discover', { key: 'secret' })
      .then((r) => r.json() as Promise<{ findings: Finding[] }>)
    expect(list.findings.find((x) => x.key === 'opencode-zen')!.adoptedProviderId).toBe('zen')
  })
})

// ---- import-account ----

describe('discover/import-account（对齐 Go import_account_test.go）', () => {
  const findingWith = (tokenPath: string, alive = true): Finding => ({
    key: 'workbuddy', harness: 'WB', status: 'ready', detail: '',
    suggestedAccounts: [{ nickname: '副号A', alive, tokenPath }],
  })

  test('成功导入：token 服务端落凭据文件（0600）+ 账号入池', async () => {
    isolateCwd()
    const { tokenPath, token } = makeAuthFile('副号A')
    const call = caller(build({ discover: new StubDiscover([findingWith(tokenPath)]) }))
    const res = await call('POST', '/admin/api/discover/import-account', {
      key: 'secret',
      body: { key: 'workbuddy', tokenPath, accountId: 'wb-x', displayName: '副号A', credentialFile: 'config/credentials/wb-jwt-x' },
    })
    expect(res.status).toBe(201)
    const acct = await res.json() as Account
    expect(acct.id).toBe('wb-x')
    expect(acct.sourceId).toBe('workbuddy')
    expect(acct.credential.apiKeyFile).toBe('config/credentials/wb-jwt-x')
    const credPath = join(process.cwd(), 'config', 'credentials', 'wb-jwt-x')
    expect(readFileSync(credPath, 'utf8')).toBe(token)
    expect(statSync(credPath).mode & 0o777).toBe(0o600)
  })

  test('credentialFile 越界一律 400', async () => {
    const { tokenPath } = makeAuthFile('副号A')
    const call = caller(build({ discover: new StubDiscover([findingWith(tokenPath)]) }))
    for (const bad of ['/tmp/evil', '../evil', 'config/credentials/../../evil', 'other/cred', 'config/credentials']) {
      const res = await call('POST', '/admin/api/discover/import-account', {
        key: 'secret',
        body: { key: 'workbuddy', tokenPath: '/etc/passwd', accountId: 'x', displayName: 'x', credentialFile: bad },
      })
      expect(res.status).toBe(400)
    }
  })

  test('tokenPath 不在发现结果内 → 400；过期登录态 → 400；重复 accountId → 409', async () => {
    isolateCwd()
    const { tokenPath } = makeAuthFile('副号A')
    const call = caller(build({ discover: new StubDiscover([findingWith(tokenPath)]) }))
    const body = { key: 'workbuddy', tokenPath: '/etc/passwd', accountId: 'x', displayName: 'x', credentialFile: 'config/credentials/c' }
    expect((await call('POST', '/admin/api/discover/import-account', { key: 'secret', body })).status).toBe(400)

    const dead = await call('POST', '/admin/api/discover/import-account', {
      key: 'secret', body: { ...body, tokenPath, credentialFile: 'config/credentials/c' },
    })
    expect(dead.status).toBe(201)
    expect((await call('POST', '/admin/api/discover/import-account', {
      key: 'secret', body: { ...body, tokenPath, credentialFile: 'config/credentials/c2' },
    })).status).toBe(409)
  })

  test('必填字段缺失 400', async () => {
    const call = caller(build({ discover: new StubDiscover([findingWith('/x')]) }))
    expect((await call('POST', '/admin/api/discover/import-account', {
      key: 'secret', body: { key: 'workbuddy', tokenPath: '/x', accountId: 'a' },
    })).status).toBe(400)
  })
})

// ---- quick-import ----

describe('discover/quick-import（对齐 Go quickimport_test.go）', () => {
  const qf = (accounts: { nickname: string; tokenPath: string; alive: boolean }[]): Finding => ({
    key: 'workbuddy', harness: 'WB', status: 'ready', detail: '',
    suggestedProvider: readyProvider('wb-auto'),
    suggestedAccounts: accounts.map((a) => ({ nickname: a.nickname, alive: a.alive, tokenPath: a.tokenPath })),
  })

  test('一键导入：Provider 入库 + 活账号入池 + 死账号跳过 + 幂等', async () => {
    isolateCwd()
    const a = makeAuthFile('主号')
    const b = makeAuthFile('副号B')
    const dead = makeAuthFile('过期号')
    const call = caller(build({ discover: new StubDiscover([
      qf([
        { nickname: '主号', tokenPath: a.tokenPath, alive: true },
        { nickname: '副号B', tokenPath: b.tokenPath, alive: true },
        { nickname: '过期号', tokenPath: dead.tokenPath, alive: false },
      ]),
    ]) }))

    const res = await call('POST', '/admin/api/discover/quick-import', { key: 'secret', body: { key: 'workbuddy' } })
    expect(res.status).toBe(200)
    const out = await res.json() as { provider: Provider; created: boolean; imported: number; skipped: number }
    expect(out.created).toBe(true)
    expect(out.provider.id).toBe('wb-auto')
    expect(out.imported).toBe(2)
    expect(out.skipped).toBe(0)
    for (const id of ['workbuddy-1', 'workbuddy-2']) {
      const credFile = join(process.cwd(), 'config', 'credentials', `${id}-jwt`)
      expect(statSync(credFile).mode & 0o777).toBe(0o600)
    }

    // 幂等
    const again = await call('POST', '/admin/api/discover/quick-import', { key: 'secret', body: { key: 'workbuddy' } })
    const out2 = await again.json() as typeof out
    expect(out2.created).toBe(false)
    expect(out2.imported).toBe(0)
    expect(out2.skipped).toBe(2)
  })

  test('token 轮换：原位更新凭据，不建重复账号', async () => {
    isolateCwd()
    const a = makeAuthFile('主号')
    const b = makeAuthFile('副号B')
    const call = caller(build({ discover: new StubDiscover([
      qf([
        { nickname: '主号', tokenPath: a.tokenPath, alive: true },
        { nickname: '副号B', tokenPath: b.tokenPath, alive: true },
      ]),
    ]) }))
    await call('POST', '/admin/api/discover/quick-import', { key: 'secret', body: { key: 'workbuddy' } })
    // 轮换主号 token
    const raw = JSON.parse(readFileSync(a.tokenPath, 'utf8')) as { auth: { accessToken: string } }
    const newTok = raw.auth.accessToken + '-rotated'
    raw.auth.accessToken = newTok
    writeFileSync(a.tokenPath, JSON.stringify(raw))
    const res = await call('POST', '/admin/api/discover/quick-import', { key: 'secret', body: { key: 'workbuddy' } })
    const out = await res.json() as { imported: number; skipped: number; warnings?: string[] }
    expect(out.imported).toBe(0)
    expect(out.skipped).toBe(2)
    expect(readFileSync(join(process.cwd(), 'config', 'credentials', 'workbuddy-1-jwt'), 'utf8')).toBe(newTok)
  })

  test('zen 未配 ZEN_KEY：公共 key 自动落凭据文件；已配则不动', async () => {
    isolateCwd()
    const prev = process.env.ZEN_KEY
    delete process.env.ZEN_KEY
    try {
      const zen = { ...readyProvider('zen'), sourceId: 'opencode', credential: { apiKeyEnv: 'ZEN_KEY' } }
      const call = caller(build({ discover: new StubDiscover([
        { key: 'opencode-zen', harness: 'Zen', status: 'ready', detail: '', suggestedProvider: zen },
      ]) }))
      const res = await call('POST', '/admin/api/discover/quick-import', { key: 'secret', body: { key: 'opencode-zen' } })
      expect(res.status).toBe(200)
      const out = await res.json() as { provider: Provider; warnings?: string[] }
      expect(out.provider.credential.apiKeyEnv).toBeUndefined()
      expect(out.provider.credential.apiKeyFile).toBe('config/credentials/zen-key')
      expect(readFileSync(join(process.cwd(), 'config', 'credentials', 'zen-key'), 'utf8')).toBe('public')

      // 环境变量已配置时不得覆盖
      process.env.ZEN_KEY = 'custom'
      const zen2 = { ...readyProvider('zen2'), sourceId: 'opencode', credential: { apiKeyEnv: 'ZEN_KEY' } }
      const call2 = caller(build({ discover: new StubDiscover([
        { key: 'opencode-zen', harness: 'Zen', status: 'ready', detail: '', suggestedProvider: zen2 },
      ]) }))
      const res2 = await call2('POST', '/admin/api/discover/quick-import', { key: 'secret', body: { key: 'opencode-zen' } })
      const out2 = await res2.json() as { provider: Provider }
      expect(out2.provider.credential).toEqual({ apiKeyEnv: 'ZEN_KEY' })
    } finally {
      if (prev === undefined) delete process.env.ZEN_KEY
      else process.env.ZEN_KEY = prev
    }
  })

  test('未就绪 400 带指引且无副作用；未知 key 404；缺 key 400', async () => {
    isolateCwd()
    const call = caller(build({ discover: new StubDiscover([
      { key: 'zcode', harness: 'ZC', status: 'unknown', detail: '', actions: ['先登录'] },
    ]) }))
    const res = await call('POST', '/admin/api/discover/quick-import', { key: 'secret', body: { key: 'zcode' } })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('先登录')
    expect((await call('POST', '/admin/api/discover/quick-import', { key: 'secret', body: { key: 'nope' } })).status).toBe(404)
    expect((await call('POST', '/admin/api/discover/quick-import', { key: 'secret', body: {} })).status).toBe(400)
  })
})

// ---- sidecar / projects ----

describe('sidecar / projects（未接线 501，路由与鉴权齐）', () => {
  test('未接线：sidecar 全部 501、projects 全部 501', async () => {
    const call = caller(build())
    expect((await call('GET', '/admin/api/sidecar', { key: 'secret' })).status).toBe(501)
    expect((await call('POST', '/admin/api/sidecar/start', { key: 'secret' })).status).toBe(501)
    expect((await call('POST', '/admin/api/sidecar/port', { key: 'secret', body: { port: '9090' } })).status).toBe(501)
    for (const [m, p] of [
      ['GET', '/admin/api/projects'], ['POST', '/admin/api/projects'],
      ['GET', '/admin/api/projects/reminders'], ['GET', '/admin/api/projects/port-owner'],
      ['POST', '/admin/api/projects/port-kill'],
      ['PUT', '/admin/api/projects/x'], ['DELETE', '/admin/api/projects/x'],
      ['POST', '/admin/api/projects/x/start'],
      ['POST', '/admin/api/projects/x/services/s/start'],
      ['GET', '/admin/api/projects/x/logs'], ['DELETE', '/admin/api/projects/x/logs'],
    ] as const) {
      expect((await call(m, p, { key: 'secret' })).status).toBe(501)
    }
  })

  test('鉴权仍覆盖 501 端点', async () => {
    const call = caller(build())
    expect((await call('GET', '/admin/api/sidecar')).status).toBe(401)
    expect((await call('GET', '/admin/api/projects')).status).toBe(401)
  })

  test('接线后委托给注入的子应用（auth 先行）', async () => {
    const projects = new Hono()
    projects.get('/', (c) => c.json({ projects: [{ id: 'prj' }] }))
    projects.post('/:id/:action', (c) => c.json({ ok: true, action: c.req.param('action') }))
    const sidecar = new Hono()
    sidecar.get('/', (c) => c.json({ running: true }))
    const call = caller(build({ projects, sidecar }))
    expect((await call('GET', '/admin/api/projects', { key: 'secret' })).status).toBe(200)
    expect(await call('GET', '/admin/api/projects', { key: 'secret' }).then((r) => r.json()))
      .toEqual({ projects: [{ id: 'prj' }] })
    expect((await call('GET', '/admin/api/projects', { bearer: 'secret' })).status).toBe(200)
    expect((await call('POST', '/admin/api/projects/x/start', { key: 'secret' })).status).toBe(200)
    expect((await call('GET', '/admin/api/sidecar', { key: 'secret' })).status).toBe(200)
  })
})

describe('egresses 出口 CRUD（GET/PUT/DELETE，DB 持久化由 store 测试覆盖）', () => {
  test('GET 回传列表；PUT 新增/改端口；非法 kind 400；DELETE 404/成功', async () => {
    const call = caller(build({ egresses: [{ id: 'clash', kind: 'http', addr: '127.0.0.1:7897' }] }))
    const res = await call('GET', '/admin/api/egresses', { key: 'secret' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { egresses: unknown[] }).egresses).toEqual([
      { id: 'clash', kind: 'http', addr: '127.0.0.1:7897' },
    ])

    const put = await call('PUT', '/admin/api/egresses/clash', {
      key: 'secret', body: { kind: 'http', addr: '127.0.0.1:7898' },
    })
    expect(put.status).toBe(200)
    expect(((await put.json()) as { addr: string }).addr).toBe('127.0.0.1:7898')

    expect((await call('PUT', '/admin/api/egresses/x', {
      key: 'secret', body: { kind: 'socks5', addr: '127.0.0.1:7897' },
    })).status).toBe(400)
    expect((await call('PUT', '/admin/api/egresses/x', {
      key: 'secret', body: { kind: 'http', addr: '' },
    })).status).toBe(400)

    expect((await call('DELETE', '/admin/api/egresses/nope', { key: 'secret' })).status).toBe(404)
    expect((await call('DELETE', '/admin/api/egresses/clash', { key: 'secret' })).status).toBe(200)
    expect(((await (await call('GET', '/admin/api/egresses', { key: 'secret' })).json()) as { egresses: unknown[] }).egresses).toEqual([])
  })

  test('未接线：PUT/DELETE 501（GET 空）', async () => {
    const call = caller(build())
    expect((await call('GET', '/admin/api/egresses', { key: 'secret' })).status).toBe(200)
    expect((await call('PUT', '/admin/api/egresses/x', {
      key: 'secret', body: { kind: 'http', addr: '127.0.0.1:1' },
    })).status).toBe(501)
    expect((await call('DELETE', '/admin/api/egresses/x', { key: 'secret' })).status).toBe(501)
  })
})

// 备注：给模型留一句运维知识（如「23 点后才免费」），避免拿付费时段当免费刷。
describe('PUT /admin/api/providers/:id/models/:model/note（模型备注）', () => {
  const mk = () => mkProvider({
    id: 'pz', api: 'anthropic-messages',
    models: [{ id: 'm1', providerId: 'pz', manual: false, enabled: true }],
  })

  test('写入/覆盖/清空备注；空串 = 删掉该字段', async () => {
    const call = caller(build({ providers: [mk()] }))
    const set = await call('PUT', '/admin/api/providers/pz/models/m1/note', {
      key: 'secret', body: { note: '23 点后才免费，白天用会扣额度' },
    })
    expect(set.status).toBe(200)
    expect(((await set.json()) as { note?: string }).note).toBe('23 点后才免费，白天用会扣额度')

    // 覆盖
    await call('PUT', '/admin/api/providers/pz/models/m1/note', {
      key: 'secret', body: { note: '已确认全天免费' },
    })
    const list = await (await call('GET', '/admin/api/providers', { key: 'secret' })).json() as { providers: Provider[] }
    expect(list.providers[0]!.models[0]!.note).toBe('已确认全天免费')

    // 清空 → 字段消失（不是留个空串）
    const clear = await call('PUT', '/admin/api/providers/pz/models/m1/note', {
      key: 'secret', body: { note: '' },
    })
    expect(clear.status).toBe(200)
    const after = await (await call('GET', '/admin/api/providers', { key: 'secret' })).json() as { providers: Provider[] }
    expect(after.providers[0]!.models[0]!.note).toBeUndefined()
  })

  test('触发变更通知（调度热重载）；404 与非法请求体', async () => {
    let n = 0
    const call = caller(build({ providers: [mk()], notify: () => { n++ } }))
    await call('PUT', '/admin/api/providers/pz/models/m1/note', { key: 'secret', body: { note: 'x' } })
    expect(n).toBe(1)
    expect((await call('PUT', '/admin/api/providers/pz/models/m1/note', {
      key: 'secret', body: { note: 123 },
    })).status).toBe(400)
    expect((await call('PUT', '/admin/api/providers/pz/models/nope/note', {
      key: 'secret', body: { note: 'x' },
    })).status).toBe(404)
    expect((await call('PUT', '/admin/api/providers/nope/models/m1/note', {
      key: 'secret', body: { note: 'x' },
    })).status).toBe(404)
  })

  test('备注不影响模型其它字段（改完协议/出口还在）', async () => {
    const call = caller(build({ providers: [mk()] }))
    await call('PUT', '/admin/api/providers/pz/models/m1/protocol', {
      key: 'secret', body: { protocol: 'openai-responses' },
    })
    await call('PUT', '/admin/api/providers/pz/models/m1/note', {
      key: 'secret', body: { note: '备' },
    })
    const list = await (await call('GET', '/admin/api/providers', { key: 'secret' })).json() as { providers: Provider[] }
    const m = list.providers[0]!.models[0]!
    expect(m.api).toBe('openai-responses')
    expect(m.note).toBe('备')
  })
})

describe('PUT /admin/api/providers/:id/models/:model/enabled（对外暴露开关）', () => {
  test('开关模型启用；404 与非法请求体', async () => {
    const p = mkProvider({
      id: 'pz', api: 'anthropic-messages',
      models: [
        { id: 'm1', providerId: 'pz', manual: false, enabled: true },
        { id: 'm2', providerId: 'pz', manual: false, enabled: true },
      ],
    })
    const call = caller(build({ providers: [p] }))

    const off = await call('PUT', '/admin/api/providers/pz/models/m2/enabled', {
      key: 'secret', body: { enabled: false },
    })
    expect(off.status).toBe(200)
    expect(((await off.json()) as { enabled: boolean }).enabled).toBe(false)

    const on = await call('PUT', '/admin/api/providers/pz/models/m2/enabled', {
      key: 'secret', body: { enabled: true },
    })
    expect(on.status).toBe(200)
    expect(((await on.json()) as { enabled: boolean }).enabled).toBe(true)

    expect((await call('PUT', '/admin/api/providers/pz/models/m2/enabled', {
      key: 'secret', body: {},
    })).status).toBe(400)
    expect((await call('PUT', '/admin/api/providers/pz/models/nope/enabled', {
      key: 'secret', body: { enabled: true },
    })).status).toBe(404)
    expect((await call('PUT', '/admin/api/providers/nope/models/m1/enabled', {
      key: 'secret', body: { enabled: true },
    })).status).toBe(404)
  })
})

// 手填错的模型得能摘掉：PATCH models 只增不减，所以删除必须独立端点。
describe('DELETE /admin/api/providers/:id/models/:model（删单个模型）', () => {
  test('删掉指定模型，其余不动；未知 provider/模型 404', async () => {
    const p = mkProvider({
      id: 'pz', api: 'anthropic-messages',
      models: [
        { id: 'hand-typed', providerId: 'pz', manual: true, enabled: true },
        { id: 'm2', providerId: 'pz', manual: false, enabled: true },
      ],
    })
    let notified = 0
    const call = caller(build({ providers: [p], notify: () => { notified++ } }))

    const del = await call('DELETE', '/admin/api/providers/pz/models/hand-typed', { key: 'secret' })
    expect(del.status).toBe(204)
    expect(notified).toBe(1) // 触发调度热重载

    const list = await (await call('GET', '/admin/api/providers', { key: 'secret' })).json() as { providers: Provider[] }
    expect(list.providers[0]!.models.map((m) => m.id)).toEqual(['m2'])

    // 重复删 / 未知模型 / 未知 provider
    expect((await call('DELETE', '/admin/api/providers/pz/models/hand-typed', { key: 'secret' })).status).toBe(404)
    expect((await call('DELETE', '/admin/api/providers/pz/models/nope', { key: 'secret' })).status).toBe(404)
    expect((await call('DELETE', '/admin/api/providers/nope/models/m2', { key: 'secret' })).status).toBe(404)
  })

  test('删除后 PATCH models 仍只增不减（删了再加能回来）', async () => {
    const p = mkProvider({
      id: 'pz', api: 'anthropic-messages',
      models: [{ id: 'm1', providerId: 'pz', manual: true, enabled: true }],
    })
    const call = caller(build({ providers: [p] }))
    expect((await call('DELETE', '/admin/api/providers/pz/models/m1', { key: 'secret' })).status).toBe(204)
    const back = await call('PATCH', '/admin/api/providers/pz', { key: 'secret', body: { models: ['m1'] } })
    expect(back.status).toBe(200)
    const list = await (await call('GET', '/admin/api/providers', { key: 'secret' })).json() as { providers: Provider[] }
    expect(list.providers[0]!.models.map((m) => m.id)).toEqual(['m1'])
  })
})
