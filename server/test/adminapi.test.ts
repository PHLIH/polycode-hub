// 管理面 REST 移植测试（行为锚点对齐 Go internal/adminapi/*_test.go）。
// 契约冻结源：web/src/api.js（路径/方法/形状一字不差）。

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { workbuddyTokenHash } from '../src/adminapi/discover_api.ts'
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

// 便捷构造：填齐 Provider 必填字段。
// 夹具：name 是对外名（可改）；providerId 给固定正数——0 是「由存储层分配」的哨兵，
// 多个夹具都用 0 会在内存 store 里被分配成不同 id、或被 put 的 UPDATE 语义静默吞掉。
const mkProvider = (over: Partial<Provider> & Pick<Provider, 'name'>): Provider => {
  const p: Provider = {
    providerId: 0, name: over.name, state: 'active', displayName: '', accessKind: 'official',
    risk: 'low', stability: 'stable', api: '', baseUrl: '', credential: {},
    priority: 0, models: [],
  }
  for (const [k, v] of Object.entries(over)) {
    if (k !== 'name') (p as unknown as Record<string, unknown>)[k] = v
  }
  return p
}

// 固定数字 providerId 的夹具（同一 build() 里放多个 Provider 时用它）。
let fixtureSeq = 100
const mkProviderFixed = (
  over: Partial<Provider> & Pick<Provider, 'name'>,
): Provider => ({ ...mkProvider(over), providerId: over.providerId ?? ++fixtureSeq })

const providerBody = {
  name: 'p1', displayName: 'P1', accessKind: 'official', risk: 'low',
  stability: 'stable', api: 'anthropic-messages', baseUrl: 'https://gw.example.com',
  credential: { apiKeyEnv: 'K' }, state: 'active', priority: 1,
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
  workbuddyCheckinFetch?: typeof fetch
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
    workbuddyCheckinFetch: o.workbuddyCheckinFetch,
  })
}

type CallOpts = { key?: string; bearer?: string; body?: unknown }

function caller(app: Hono) {
  return async (method: string, path: string, o: CallOpts = {}): Promise<Response> => {
    const headers: Record<string, string> = {}
    if (o.key) headers['X-Admin-Key'] = o.key
    if (o.bearer) headers['Authorization'] = `Bearer ${o.bearer}`
    // 账号按 Provider 名归属（建号时校验存在性）。账号用例的夹具一律 providerName:'s'，
    // 这里在真正要建号前惰性补建一个名为 s 的 Provider——用 ensure 而不是预置，
    // 是为了不污染 provider 用例（它们断言的是 provider 列表本身，比如"空列表"）。
    await ensureAccountOwner(app, method, path, o)
    return app.request(path, {
      method,
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    })
  }
}

// 前置补齐：POST /admin/api/accounts 时若没有该归属名的 Provider，先建一个。
// 归属已从「Provider 名」改成「Provider.providerId（数字）」：接口收 providerName
// （用户心智单位）后解析成数字 id 存下，所以这里按名字查/建。
// 显式传了 providers 的用例不受影响（已有同名就不补）。
async function ensureAccountOwner(
  app: Hono, method: string, path: string, o: CallOpts,
): Promise<void> {
  if (method !== 'POST' || path !== '/admin/api/accounts') return
  const body = o.body
  if (typeof body !== 'object' || body === null) return
  const raw = body as Record<string, unknown>
  // 归属写法：新名 providerName（字符串名）；providerId 已是数字，不需要补建。
  const want = raw.providerName ?? (typeof raw.sourceId === 'string' ? raw.sourceId : '')
  if (typeof want !== 'string' || want === '') return
  const headers: Record<string, string> = {}
  if (o.key) headers['X-Admin-Key'] = o.key
  if (o.bearer) headers['Authorization'] = `Bearer ${o.bearer}`
  let providers: Provider[] = []
  try {
    const resp = await app.request('/admin/api/providers', { headers })
    providers = ((await resp.json()) as { providers?: Provider[] }).providers ?? []
  } catch { providers = [] }
  // list() 含 deleted 行：只有非 deleted 的同名行才算已有归属。
  if (providers.some((p) => p.name === want && p.state !== 'deleted')) return
  await app.request('/admin/api/providers', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...mkProvider({ name: want }),
      baseUrl: 'https://fixture.example.com/v1', // providerValidate 要求非空
    }),
  })
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

// 发现页的「采用草稿」：providerId=0 = 尚未入库（采用时由存储层分配）。
const readyProvider = (name: string): Provider => ({
  providerId: 0, name, state: 'active', displayName: 'D', accessKind: 'session-reuse',
  risk: 'medium',
  riskNote: 'n', stability: 'beta', api: 'openai-completions',
  baseUrl: 'https://x.example.com/v2', priority: 0, models: [],
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
    expect(p.name).toBe('p1')
    expect(p.providerId).toBeGreaterThan(0) // 由存储层分配
    expect(p.state).toBe('active')
    expect(p.models).toEqual([]) // Go: nil models → []

    // 重名规则：与 active/paused 同名 → 409（名字被占用）
    expect((await call('POST', '/admin/api/providers', { key: 'secret', body: providerBody })).status).toBe(409)

    const list = await call('GET', '/admin/api/providers', { key: 'secret' })
    expect(((await list.json()) as { providers: unknown[] }).providers).toHaveLength(1)

    // 路由参数是数字 providerId（不是名字）
    const patched = await call('PATCH', `/admin/api/providers/${p.providerId}`, {
      key: 'secret', body: { enabled: false, riskNote: '降级' },
    })
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as Provider).state).toBe('paused') // enabled:false → paused

    // 删除 = 软删（state='deleted'）：行仍在，但再删就 404（已删除的行不算「存在」？见下）
    expect((await call('DELETE', `/admin/api/providers/${p.providerId}`, { key: 'secret' })).status).toBe(204)
    const afterDel = (await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)).providers
    expect(afterDel).toHaveLength(1)
    expect(afterDel[0]!.state).toBe('deleted')
    // 软删是幂等可重复的：行还在，所以再删仍 204（不是老语义的 404）
    expect((await call('DELETE', `/admin/api/providers/${p.providerId}`, { key: 'secret' })).status).toBe(204)
    // 未知 providerId 才 404
    expect((await call('DELETE', '/admin/api/providers/99999', { key: 'secret' })).status).toBe(404)
  })

  // 回归：软删的行会**永久堆在库里**（历史用量靠 providerId 回溯，不能随手物理删），
  // 而它又不出现在主列表里 —— 用户既看不到也管不了。purge 给一个真的清干净的出口，
  // 但必须只允许删已经 deleted 的行，否则等于绕过"先删除"的保护。
  test('purge：只能彻底清理已删除的行；在用的一律 400', async () => {
    const call = caller(build())
    const created = await call('POST', '/admin/api/providers', { key: 'secret', body: providerBody })
    const p = await created.json() as Provider

    // 正在用 → 拒绝（不许绕过软删直接把通道抹掉）
    const early = await call('DELETE', `/admin/api/providers/${p.providerId}/purge`, { key: 'secret' })
    expect(early.status).toBe(400)
    expect(await early.json()).toMatchObject({ error: { message: expect.stringContaining('还在使用中') } })
    // 拒绝后行必须还在
    expect((await call('GET', `/admin/api/providers/${p.providerId}/credential`, { key: 'secret' })).status).toBe(200)

    // 先软删 → 再 purge 才允许
    expect((await call('DELETE', `/admin/api/providers/${p.providerId}`, { key: 'secret' })).status).toBe(204)
    expect((await call('DELETE', `/admin/api/providers/${p.providerId}/purge`, { key: 'secret' })).status).toBe(204)
    // 物理删除后彻底消失（连软删行都不在）
    const left = (await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)).providers
    expect(left.find((x) => x.providerId === p.providerId)).toBeUndefined()
    // 再 purge 同一条 → 404
    expect((await call('DELETE', `/admin/api/providers/${p.providerId}/purge`, { key: 'secret' })).status).toBe(404)
    // 非法 pid → 404（与其余 :pid 路由同口径）
    expect((await call('DELETE', '/admin/api/providers/abc/purge', { key: 'secret' })).status).toBe(404)
  })

  test('重名规则：与 deleted 同名可复用（拿到新 providerId）', async () => {
    const call = caller(build())
    const first = await call('POST', '/admin/api/providers', { key: 'secret', body: providerBody })
    const p1 = await first.json() as Provider
    await call('DELETE', `/admin/api/providers/${p1.providerId}`, { key: 'secret' })

    // deleted 不占名：同名可以再建，且是新的 providerId（历史用量仍能按老 id 回溯）
    const again = await call('POST', '/admin/api/providers', { key: 'secret', body: providerBody })
    expect(again.status).toBe(201)
    const p2 = await again.json() as Provider
    expect(p2.providerId).not.toBe(p1.providerId)
    expect(p2.state).toBe('active')

    // paused 占名：改成 paused 后同名再建 → 409
    await call('PATCH', `/admin/api/providers/${p2.providerId}`, { key: 'secret', body: { state: 'paused' } })
    expect((await call('POST', '/admin/api/providers', { key: 'secret', body: providerBody })).status).toBe(409)
  })

  // 历史背景：PROVIDER_PATCH_ALLOW 曾漏掉 'name' 与 'state'，导致改名/改状态被
  // 白名单拦成 400、紧随其后的改名分支与 setters.state 变成死代码，前端改名也是断的。
  // 现已修复（见 api.ts:54-60 白名单，'name' / 'state' / 'enabled' 均在列），
  // 下面两条断言 200 就是这条修复的护栏。
  // 核心能力：改名只动 name，providerId 与所有引用（账号归属、用量归因）都不动。
  // 这条断言是「改名不再需要删了重建」的护栏——删了重建会换 providerId 并让旧客户端失效。
  test('PATCH 改 name / state：改名后 providerId 与账号归属不变', async () => {
    const call = caller(build())
    await call('POST', '/admin/api/providers', { key: 'secret', body: providerBody })
    const before = (await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)).providers[0]!
    // 账号先挂上去：归属存的是数字 providerId，与名字无关
    expect((await call('POST', '/admin/api/accounts', {
      key: 'secret', body: { id: 'a-rn', providerName: 'p1' },
    })).status).toBe(201)
    const acct = (await call('GET', '/admin/api/accounts', { key: 'secret' })
      .then((r) => r.json() as Promise<{ accounts: Account[] }>)).accounts[0]!
    expect(acct.providerId).toBe(before.providerId)

    // 改名：200，且 providerId 不变（账号归属存的是 id，所以自动跟着走）
    const renamed = await call('PATCH', `/admin/api/providers/${before.providerId}`, {
      key: 'secret', body: { name: 'p1-renamed' },
    })
    expect(renamed.status).toBe(200)
    expect((await renamed.json() as Provider).name).toBe('p1-renamed')
    // 新状态字段：200，三态可直接切
    const paused = await call('PATCH', `/admin/api/providers/${before.providerId}`, {
      key: 'secret', body: { state: 'paused' },
    })
    expect(paused.status).toBe(200)
    expect((await paused.json() as Provider).state).toBe('paused')
    await call('PATCH', `/admin/api/providers/${before.providerId}`, {
      key: 'secret', body: { state: 'active' },
    })

    // 兼容路径 enabled 在白名单里：true→active，false→paused（新状态机本身是对的）
    const off = await call('PATCH', `/admin/api/providers/${before.providerId}`, {
      key: 'secret', body: { enabled: false },
    })
    expect(off.status).toBe(200)
    expect((await off.json() as Provider).state).toBe('paused')
    const on = await call('PATCH', `/admin/api/providers/${before.providerId}`, {
      key: 'secret', body: { enabled: true },
    })
    expect((await on.json() as Provider).state).toBe('active')

    // 改过 name，但 providerId 一步没动；账号归属依然指着同一个数字 id
    const after = (await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)).providers[0]!
    expect(after.name).toBe('p1-renamed')
    expect(after.providerId).toBe(before.providerId)
    expect((await call('GET', '/admin/api/accounts', { key: 'secret' })
      .then((r) => r.json() as Promise<{ accounts: Account[] }>)).accounts[0]!.providerId)
      .toBe(before.providerId) // 归属跟着走，不用迁移
  })

  test('重名规则（按名字）：active/paused 占名，deleted 释放', async () => {
    const call = caller(build())
    const created = await call('POST', '/admin/api/providers', { key: 'secret', body: providerBody })
    const pid = (await created.json() as Provider).providerId
    // 建同名的第二个 → 409（名字被 p1 占着）
    const dup = await call('POST', '/admin/api/providers', { key: 'secret', body: providerBody })
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as { error: { message: string } }).error.message)
      .toContain('已被占用')
    // paused 也占名：关掉开关不算释放名字
    await call('PATCH', `/admin/api/providers/${pid}`, { key: 'secret', body: { enabled: false } })
    expect((await call('POST', '/admin/api/providers', { key: 'secret', body: providerBody })).status).toBe(409)
    // 软删后名字释放：同名可再建并拿到新 providerId
    await call('DELETE', `/admin/api/providers/${pid}`, { key: 'secret' })
    const again = await call('POST', '/admin/api/providers', { key: 'secret', body: providerBody })
    expect(again.status).toBe(201)
    expect(((await again.json()) as Provider).providerId).not.toBe(pid)
  })

  test('PATCH 只读字段 400（providerId/id/sourceId）；api 放开可编辑', async () => {
    const call = caller(build())
    const created = await call('POST', '/admin/api/providers', { key: 'secret', body: providerBody })
    const pid = (await created.json() as Provider).providerId
    for (const patch of [{ providerId: 2 }, { id: 'p2' }, { sourceId: 's2' }]) {
      const res = await call('PATCH', `/admin/api/providers/${pid}`, { key: 'secret', body: patch })
      expect(res.status).toBe(400)
    }
    // api 可改：合法值写入并返回；非法值 400
    const okRes = await call('PATCH', `/admin/api/providers/${pid}`, {
      key: 'secret', body: { api: 'openai-completions' },
    })
    expect(okRes.status).toBe(200)
    const got = (await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)).providers[0]!
    expect(got.api).toBe('openai-completions')
    expect((await call('PATCH', `/admin/api/providers/${pid}`, {
      key: 'secret', body: { api: 'nope' },
    })).status).toBe(400)
  })

  test('POST 校验：非法 api 点名 / 高风险无 riskNote / 非法 name', async () => {
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

    const badName = await call('POST', '/admin/api/providers', {
      key: 'secret', body: { ...providerBody, name: 'Bad_ID' },
    })
    expect(badName.status).toBe(400)
    expect(((await badName.json()) as { error: { message: string } }).error.message)
      .toContain('只允许小写字母/数字/连字符')
  })

  test('模型采用只增不减：已有元数据保留，缺的追加为可用（对齐 Go TestProvidersPatchModelsMerge）', async () => {
    const keep = mkProviderFixed({
      name: 'pz',
      models: [{ id: 'keep', manual: true, enabled: true }],
    })
    const call = caller(build({ providers: [keep] }))
    const res = await call('PATCH', `/admin/api/providers/${keep.providerId}`, {
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
    const keep = mkProviderFixed({
      name: 'pz',
      models: [{ id: 'm1', manual: false, enabled: true }],
    })
    const call = caller(build({ providers: [keep] }))
    await call('PATCH', `/admin/api/providers/${keep.providerId}`, {
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

  test('凭证明文按需查看：列表不泄漏，显式端点返回明文/缺失提示', async () => {
    process.env.PCH_TEST_CRED_VIEW = 'sk-view-me'
    try {
      const pEnv = mkProviderFixed({ name: 'p-env', credential: { apiKeyEnv: 'PCH_TEST_CRED_VIEW' } })
      const call = caller(build({
        providers: [pEnv],
        accounts: [
          { id: 'a-env', providerId: pEnv.providerId, credential: { apiKeyEnv: 'PCH_TEST_CRED_VIEW' }, status: 'available', fails: 0 },
          { id: 'a-miss', providerId: pEnv.providerId, credential: { apiKeyEnv: 'PCH_TEST_CRED_MISSING_X' }, status: 'available', fails: 0 },
        ],
      }))
      // 列表仍只下发引用：明文不在列表里
      const listBody = await call('GET', '/admin/api/providers', { key: 'secret' }).then((r) => r.text())
      expect(listBody).not.toContain('sk-view-me')
      // Provider 显式端点：路径参数是数字 providerId
      const got = await call('GET', `/admin/api/providers/${pEnv.providerId}/credential`, { key: 'secret' })
        .then((r) => r.json() as Promise<{ source: string; present: boolean; value: string; hint: string }>)
      expect(got.present).toBe(true)
      expect(got.value).toBe('sk-view-me')
      expect(got.source).toContain('PCH_TEST_CRED_VIEW')
      // Account 显式端点：命中返回明文；缺失给 hint 不给 value
      const agot = await call('GET', '/admin/api/accounts/a-env/credential', { key: 'secret' })
        .then((r) => r.json() as Promise<{ present: boolean; value: string }>)
      expect(agot.present).toBe(true)
      expect(agot.value).toBe('sk-view-me')
      const miss = await call('GET', '/admin/api/accounts/a-miss/credential', { key: 'secret' })
        .then((r) => r.json() as Promise<{ present: boolean; value: string; hint: string }>)
      expect(miss.present).toBe(false)
      expect(miss.value).toBe('')
      expect(miss.hint).toContain('PCH_TEST_CRED_MISSING_X')
      // 不存在 404；无鉴权 401
      expect((await call('GET', '/admin/api/providers/99999/credential', { key: 'secret' })).status).toBe(404)
      expect((await call('GET', `/admin/api/providers/${pEnv.providerId}/credential`)).status).toBe(401)
    } finally {
      delete process.env.PCH_TEST_CRED_VIEW
    }
  })

  test('accountIds 白名单已删除：PATCH 出现即 400（只读）', async () => {
    const p1 = mkProviderFixed({ name: 'p1x' })
    const call = caller(build({
      providers: [p1],
      accounts: [
        { id: 'a1', providerId: p1.providerId, credential: {}, status: 'available', fails: 0 },
      ],
    }))
    // 白名单字段不再接受：只读字段出现即 400
    expect((await call('PATCH', `/admin/api/providers/${p1.providerId}`, {
      key: 'secret', body: { accountIds: ['a1'] },
    })).status).toBe(400)
  })

  // 真实缺陷（用户实测）：管理台「API Key」框语义是环境变量名，但用户就是把 Key 粘进去。
  // 粘完保存 → apiKeyEnv 存下 Key 本体 → 网关当变量名找不到 → 请求不带 Authorization
  // → 上游 401，报错还是「环境变量 atr_xxx 未设置」，用户完全看不出问题在哪。
  //
  // 注意判别方式：实测 atr_EXAMPLE0000000000000000000000abcd 这类 Key（36 位、全为
  // [A-Za-z0-9_]）与环境变量名的字符集完全重合——靠形状猜必然误判，因此由界面显式
  // 声明 credentialKind='key'。这里锚定的就是这个契约。
  test('粘 Key 本体（credentialKind=key）：落凭据文件，而不是当成变量名', async () => {
    const dir = isolateCwd()
    const call = caller(build())
    const pasted = 'atr_EXAMPLE0000000000000000000000abcd'
    const res = await call('POST', '/admin/api/providers', {
      key: 'secret',
      body: { ...providerBody, name: 'atria', credentialInput: pasted, credentialKind: 'key' },
    })
    expect(res.status).toBe(201)
    const got = await res.json() as Provider
    // 关键：没有把 Key 本体塞进 apiKeyEnv
    expect(got.credential.apiKeyEnv).toBeUndefined()
    expect(got.credential.apiKeyFile).toBe('config/credentials/provider-atria-key')
    // Key 真落到了文件里，且 0600
    const file = join(dir, 'config', 'credentials', 'provider-atria-key')
    expect(readFileSync(file, 'utf8')).toBe(pasted)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('credentialKind=env：环境变量名原语义，不落文件', async () => {
    const dir = isolateCwd()
    const call = caller(build())
    const res = await call('POST', '/admin/api/providers', {
      key: 'secret',
      body: { ...providerBody, name: 'acme', credentialInput: 'ACME_API_KEY', credentialKind: 'env' },
    })
    expect(res.status).toBe(201)
    const got = await res.json() as Provider
    expect(got.credential.apiKeyEnv).toBe('ACME_API_KEY')
    expect(got.credential.apiKeyFile).toBeUndefined()
    expect(existsSync(join(dir, 'config', 'credentials', 'provider-acme-key'))).toBe(false)
  })

  // 老客户端/裸调 API 不带 credentialKind：维持历史语义（当环境变量名），绝不静默改写。
  test('未声明 credentialKind：回落历史行为 = 环境变量名', async () => {
    const call = caller(build())
    const res = await call('POST', '/admin/api/providers', {
      key: 'secret',
      body: { ...providerBody, name: 'legacy', credentialInput: 'LEGACY_KEY' },
    })
    expect(res.status).toBe(201)
    const got = await res.json() as Provider
    expect(got.credential.apiKeyEnv).toBe('LEGACY_KEY')
    expect(got.credential.apiKeyFile).toBeUndefined()
  })

  test('留空 = 不声明凭据（不覆盖显式传入的 credential）', async () => {
    const call = caller(build())
    // providerBody 自带 credential{apiKeyEnv:'K'}：credentialInput 为空串时不得动它
    await call('POST', '/admin/api/providers', {
      key: 'secret',
      body: { ...providerBody, name: 'keep', credentialInput: '' },
    })
    const got = (await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)).providers.find((p) => p.name === 'keep')!
    expect(got.credential.apiKeyEnv).toBe('K')
    expect(got.credential.apiKeyFile).toBeUndefined()
  })

  test('PATCH credentialInput：粘 Key 换掉旧引用；空串不动原引用', async () => {
    const dir = isolateCwd()
    const sw = mkProviderFixed({ name: 'sw', credential: { apiKeyEnv: 'OLD_ENV' } })
    const call = caller(build({ providers: [sw] }))
    const newKey = 'sk-new-pasted-key-1234567890'
    expect((await call('PATCH', `/admin/api/providers/${sw.providerId}`, {
      key: 'secret', body: { credentialInput: newKey, credentialKind: 'key' },
    })).status).toBe(200)
    let got = (await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)).providers[0]!
    expect(got.credential.apiKeyEnv).toBeUndefined()
    expect(readFileSync(join(dir, got.credential.apiKeyFile!), 'utf8')).toBe(newKey)
    // 空串：不动已有的文件引用
    expect((await call('PATCH', `/admin/api/providers/${sw.providerId}`, {
      key: 'secret', body: { credentialInput: '   ', credentialKind: 'key' },
    })).status).toBe(200)
    got = (await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)).providers[0]!
    expect(got.credential.apiKeyFile).toBe('config/credentials/provider-sw-key')
  })

  test('账号侧同口径：粘 Key 也落凭据文件', async () => {
    const dir = isolateCwd()
    const call = caller(build())
    const pasted = 'sk-acct-pasted-abcdefghijklmnop'
    const res = await call('POST', '/admin/api/accounts', {
      key: 'secret',
      body: { id: 'a-paste', providerName: 's', credentialInput: pasted, credentialKind: 'key' },
    })
    expect(res.status).toBe(201)
    const ac = await res.json() as Account
    expect(ac.credential.apiKeyEnv).toBeUndefined()
    expect(ac.credential.apiKeyFile).toBe('config/credentials/account-a-paste-key')
    expect(readFileSync(join(dir, ac.credential.apiKeyFile!), 'utf8')).toBe(pasted)
  })

  test('路径穿越：id 里的 .. / 不会被写进凭据文件路径', async () => {
    const dir = isolateCwd()
    const call = caller(build())
    const res = await call('POST', '/admin/api/accounts', {
      key: 'secret',
      body: { id: '../evil', providerName: 's', credentialInput: 'sk-aaaaaaaaaaaaaaaaaaaa', credentialKind: 'key' },
    })
    expect(res.status).toBe(201)
    const ac = await res.json() as Account
    // id 里的非法字符被收敛，路径仍在 config/credentials/ 下
    expect(ac.credential.apiKeyFile!.startsWith('config/credentials/')).toBe(true)
    expect(ac.credential.apiKeyFile).not.toContain('..')
    const written = readdirSync(join(dir, 'config', 'credentials'))
    expect(written.some((f) => f.includes('evil'))).toBe(true)
    expect(existsSync(join(dir, 'evil'))).toBe(false)
  })

  test('POST 创建带 accountIds：未知字段忽略，照常 201（不存）', async () => {
    const pz = mkProviderFixed({ name: 'pz' })
    const call = caller(build({
      providers: [pz],
      accounts: [
        { id: 'a1', providerId: pz.providerId, credential: {}, status: 'available', fails: 0 },
      ],
    }))
    const res = await call('POST', '/admin/api/providers', {
      key: 'secret', body: { ...providerBody, name: 'pz2', accountIds: ['a1'] },
    })
    expect(res.status).toBe(201)
    const got = (await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)).providers.find((p) => p.name === 'pz2')!
    expect((got as unknown as Record<string, unknown>).accountIds).toBeUndefined()
  })

  test('账号权重 weight：PATCH 可设；非法值 400', async () => {
    const aw = mkProviderFixed({ name: 's' })
    const call = caller(build({
      providers: [aw],
      accounts: [
        { id: 'a1', providerId: aw.providerId, credential: {}, status: 'available', fails: 0 },
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
  test('配置文件种进来的 Provider 也照常可删 204（软删：行保留为 deleted）', async () => {
    const wb = mkProviderFixed({ name: 'wb-direct' })
    const acme = mkProviderFixed({ name: 'acme' })
    const call = caller(build({ providers: [wb, acme] }))
    expect((await call('DELETE', `/admin/api/providers/${wb.providerId}`, { key: 'secret' })).status).toBe(204)
    expect((await call('DELETE', `/admin/api/providers/${acme.providerId}`, { key: 'secret' })).status).toBe(204)
    const list = await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)
    // list() 返回所有行（含 deleted）：软删不丢数据，历史用量仍能按 providerId 回溯
    expect(list.providers).toHaveLength(2)
    expect(list.providers.every((p) => p.state === 'deleted')).toBe(true)
    // deleted 的名字被释放：同名可再建（拿到新 providerId）
    expect((await call('POST', '/admin/api/providers', {
      key: 'secret', body: { ...providerBody, name: 'acme' },
    })).status).toBe(201)
  })
})

// ---- accounts ----

describe('accounts CRUD（对齐 Go TestAccountCRUD）', () => {
  test('全流程 + PATCH 白名单', async () => {
    const call = caller(build())
    const a = { id: 'a1', providerName: 's', displayName: '主号', credential: { apiKeyEnv: 'JWT' } }
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
    expect((await call('POST', '/admin/api/accounts', { key: 'secret', body: { id: 'a2', providerName: 's' } })).status).toBe(201)
    expect((await call('POST', '/admin/api/accounts', {
      key: 'secret', body: { id: 'a3', providerName: 's', status: 'cooldown' },
    })).status).toBe(400)
  })

  // 账号「归属 Provider」现在会校验存在性（用户反馈：以前随便填一个源名也能存进去，
  // 结果账号永远 pick 不到，轮询不生效却看不出原因）。
  test('归属 Provider 不存在：400 并点名该填什么', async () => {
    const atria = mkProviderFixed({ name: 'atria' })
    const call = caller(build({ providers: [atria] }))
    const res = await call('POST', '/admin/api/accounts', {
      key: 'secret', body: { id: 'a-x', providerName: '不存在的源' },
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message)
      .toContain('不存在的源')
    // 对得上就放行（按 Provider 名解析成数字 providerId 存下）
    const ok = await call('POST', '/admin/api/accounts', {
      key: 'secret', body: { id: 'a-ok', providerName: 'atria' },
    })
    expect(ok.status).toBe(201)
    expect((await ok.json() as Account).providerId).toBe(atria.providerId)
  })

  test('归属也接受数字 providerId；指向已删除的 Provider → 400', async () => {
    const zen = mkProviderFixed({ name: 'zen-chat' })
    const call = caller(build({ providers: [zen] }))
    expect((await call('POST', '/admin/api/accounts', {
      key: 'secret', body: { id: 'a-1', providerId: zen.providerId },
    })).status).toBe(201)
    // 已软删的 Provider 不算有效归属
    await call('DELETE', `/admin/api/providers/${zen.providerId}`, { key: 'secret' })
    const res = await call('POST', '/admin/api/accounts', {
      key: 'secret', body: { id: 'a-2', providerId: zen.providerId },
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message)
      .toContain('不存在或已删除')
  })

  // 重名直接拒（用户要求：重名就提示，不许悄悄覆盖）。
  test('账号重名：409 且提示换名字，不覆盖已有账号', async () => {
    const call = caller(build())
    const body = { id: 'dup', providerName: 's', displayName: '第一个' }
    expect((await call('POST', '/admin/api/accounts', { key: 'secret', body })).status).toBe(201)
    const again = await call('POST', '/admin/api/accounts', {
      key: 'secret', body: { ...body, displayName: '第二个' },
    })
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: { message: string } }).error.message)
      .toContain('已存在')
    // 原账号没被改动
    const got = (await call('GET', '/admin/api/accounts', { key: 'secret' })
      .then((r) => r.json() as Promise<{ accounts: Account[] }>)).accounts[0]!
    expect(got.displayName).toBe('第一个')
  })

  // 接入方式与风险等级随认知更新，管理面要能改（UI 把它们收进「高级选项」）。
  test('PATCH accessKind/risk：合法值写入，非法值 400', async () => {
    const call = caller(build())
    const pid = ((await (await call('POST', '/admin/api/providers', {
      key: 'secret', body: providerBody,
    })).json()) as Provider).providerId
    const res = await call('PATCH', `/admin/api/providers/${pid}`, {
      key: 'secret', body: { accessKind: 'reverse', risk: 'medium', riskNote: '第三方反代，可能封号' },
    })
    expect(res.status).toBe(200)
    const got = (await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)).providers[0]!
    expect(got.accessKind).toBe('reverse')
    expect(got.risk).toBe('medium')

    expect((await call('PATCH', `/admin/api/providers/${pid}`, {
      key: 'secret', body: { accessKind: 'telepathy' },
    })).status).toBe(400)
    expect((await call('PATCH', `/admin/api/providers/${pid}`, {
      key: 'secret', body: { risk: 'catastrophic' },
    })).status).toBe(400)
    // 未知 providerId → 404
    expect((await call('PATCH', '/admin/api/providers/99999', {
      key: 'secret', body: { accessKind: 'reverse' },
    })).status).toBe(404)
  })

  // 中/高风险必须带风险说明，否则使用者看不到风险提示（与 providerValidate 同一约束）。
  test('PATCH risk=high 但无 riskNote：拒绝，且不改动已有风险等级', async () => {
    const call = caller(build())
    const pid = ((await (await call('POST', '/admin/api/providers', {
      key: 'secret', body: providerBody,
    })).json()) as Provider).providerId
    expect((await call('PATCH', `/admin/api/providers/${pid}`, {
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
    const pid = ((await (await call('POST', '/admin/api/providers', {
      key: 'secret',
      body: { ...providerBody, risk: 'medium', riskNote: '原本有说明' },
    })).json()) as Provider).providerId
    const res = await call('PATCH', `/admin/api/providers/${pid}`, {
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
    // 预置归属 Provider（账号按 Provider 名归属）：夹具补齐若走 HTTP 会多算一次 notify，
    // 这个用例只关心业务操作本身的 6 次通知，所以归属提前放好。
    const s0 = mkProviderFixed({ name: 's' })
    const call = caller(build({
      providers: [s0],
      notify: () => { n++ },
    }))
    const pid = ((await (await call('POST', '/admin/api/providers', {
      key: 'secret', body: providerBody,
    })).json()) as Provider).providerId
    await call('PATCH', `/admin/api/providers/${pid}`, { key: 'secret', body: { credential: { apiKeyEnv: 'NEW_ENV' } } })
    await call('DELETE', `/admin/api/providers/${pid}`, { key: 'secret' })
    await call('POST', '/admin/api/accounts', { key: 'secret', body: { id: 'a1', providerName: 's' } })
    await call('PATCH', '/admin/api/accounts/a1', { key: 'secret', body: { credential: { apiKeyFile: '/tmp/k' } } })
    await call('DELETE', '/admin/api/accounts/a1', { key: 'secret' })
    expect(n).toBe(6)
  })

  // 稳定性在管理面可改（UI 把它收进「高级选项」，但收起来也要能存住）。
  test('PATCH stability：合法值写入，非法值 400', async () => {
    const call = caller(build())
    const pid = ((await (await call('POST', '/admin/api/providers', {
      key: 'secret', body: providerBody,
    })).json()) as Provider).providerId
    const okRes = await call('PATCH', `/admin/api/providers/${pid}`, {
      key: 'secret', body: { stability: 'experimental' },
    })
    expect(okRes.status).toBe(200)
    expect((await okRes.json() as { stability: string }).stability).toBe('experimental')
    // 非法值必须拒绝，且不污染已有值
    expect((await call('PATCH', `/admin/api/providers/${pid}`, {
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
    const pid = ((await (await call('POST', '/admin/api/providers', {
      key: 'secret',
      body: { ...providerBody, credential: { apiKeyFile: 'config/credentials/acme-key' } },
    })).json()) as Provider).providerId
    await call('PATCH', `/admin/api/providers/${pid}`, {
      key: 'secret', body: { displayName: '改名', stability: 'beta', streamOnly: true },
    })
    const got = (await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)).providers[0]!
    expect(got.credential.apiKeyFile).toBe('config/credentials/acme-key')
    expect(got.displayName).toBe('改名')
  })
})

describe('账号列表带运行时状态（冷却/连败不在 DB 里）', () => {
  // 账号归属 = 数字 providerId；这些用例不查 Provider 表，给个固定正数即可。
  const accts = [{ id: 'a1', providerId: 1, credential: {}, status: 'available' as const, fails: 0 }]

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
    const dis = caller(build({ accounts: [{ id: 'a1', providerId: 1, credential: {}, status: 'disabled' as const, fails: 0 }] }))
    const db = await (await dis('GET', '/admin/api/accounts', { key: 'secret' })).json() as { accounts: { health?: string }[] }
    expect(db.accounts[0]!.health).toBe('bad')
  })
})

describe('账号测试端点（指定账号打真实请求）', () => {
  const accts = [{ id: 'a1', providerId: 1, credential: {}, status: 'available' as const, fails: 0 }]

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
    const call = caller(build({ resetter: rs, accounts: [{ id: 'a1', providerId: 1, credential: {}, status: 'available', fails: 0 }] }))
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
  test('test：打通回显文本；不存在 404；未接线 501', async () => {
    // 夹具必须预置 provider 1：探测类端点现在先查库再打上游，
    // 「不存在的 Provider」应当是 404，而不是 200 + {ok:false}。
    const p1 = mkProvider({ name: 'p1', providerId: 1 })
    const ok = caller(build({
      providers: [p1],
      prober: new StubProber({ ok: true, model: 'zcode/glm-5', text: 'hi', latencyMs: 320 }),
    }))
    const res = await ok('POST', '/admin/api/providers/1/test', { key: 'secret' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, text: 'hi', latencyMs: 320 })

    // 回归：不存在 / 非法 pid 曾返回 200 + {ok:false,error:"provider #NaN 不存在"}
    const missing = await ok('POST', '/admin/api/providers/99999/test', { key: 'secret' })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { message: 'provider #99999 不存在' } })

    const unwired = caller(build())
    expect((await unwired('POST', '/admin/api/providers/1/test', { key: 'secret' })).status).toBe(501)
  })

  test('models：透出上游列表；不存在 404；listler 报错 502；未接线 501', async () => {
    const list: ModelList = { models: ['glm-5', 'glm-6'], source: 'upstream' }
    const p1 = mkProvider({ name: 'p1', providerId: 1 })
    const wired = caller(build({ providers: [p1], lister: new StubLister(list) }))
    const res = await wired('GET', '/admin/api/providers/1/models', { key: 'secret' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ models: ['glm-5', 'glm-6'], source: 'upstream' })

    // 「上游挂了」= 502，「没有这个 Provider」= 404：两者必须分得开，
    // 否则前端只能把不存在的 Provider 提示成"拉不到列表，请手填模型"。
    const err = caller(build({ providers: [p1], lister: new StubLister(undefined, '上游不支持模型列表') }))
    expect((await err('GET', '/admin/api/providers/1/models', { key: 'secret' })).status).toBe(502)

    const missing = caller(build({ lister: new StubLister(list) }))
    const missRes = await missing('GET', '/admin/api/providers/99999/models', { key: 'secret' })
    expect(missRes.status).toBe(404)
    expect(await missRes.json()).toMatchObject({ error: { message: 'provider #99999 不存在' } })

    const unwired = caller(build())
    expect((await unwired('GET', '/admin/api/providers/1/models', { key: 'secret' })).status).toBe(501)
  })

  test('非法 pid（NaN/undefined/非整数）：一律 404 且原样回显，不落到存储层', async () => {
    // 回归锚点：前端误传 .id 时曾打出 /providers/undefined/...，后端 Number() 化后
    // 变成 NaN 继续往下传，报错成了「provider #NaN 不存在」，排查时看不出是谁传错了。
    const call = caller(build({
      providers: [mkProvider({ name: 'p1', providerId: 1 })],
      prober: new StubProber({ ok: true, text: 'x' }),
      lister: new StubLister({ models: ['m'], source: 'upstream' }),
      modelProber: new StubModelProber([]),
    }))
    for (const raw of ['abc', 'undefined', 'NaN', '0', '-1', '5.5']) {
      const r = await call('GET', `/admin/api/providers/${raw}/models`, { key: 'secret' })
      expect(r.status).toBe(404)
      // 必须回显原始串（而不是 Number 后的 NaN）：这是排查"谁传错了"的唯一线索
      expect(await r.json()).toMatchObject({ error: { message: `provider #${raw} 不存在` } })
    }
    // 合法但不存在：同样是 404
    expect((await call('GET', '/admin/api/providers/99999/models', { key: 'secret' })).status).toBe(404)
  })

  test('scan：回传结果并把探到的协议写回模型目录', async () => {
    const p = mkProviderFixed({
      name: 'pz',
      models: [
        { id: 'm1', manual: false, enabled: true, api: 'anthropic-messages' },
        { id: 'm2', manual: false, enabled: true, api: 'anthropic-messages' },
      ],
    })
    p.models = p.models.map((m) => ({ ...m, providerId: p.providerId }))
    const call = caller(build({
      providers: [p],
      modelProber: new StubModelProber([
        { model: 'm1', ok: true, protocol: 'openai-completions', text: 'hey', latencyMs: 42 },
        { model: 'm2', ok: false, error: 'http 503' },
      ]),
    }))
    const res = await call('POST', `/admin/api/providers/${p.providerId}/scan`, {
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
    const p = mkProviderFixed({ name: 'pz' })
    const unwired = caller(build({ providers: [p] }))
    expect((await unwired('POST', `/admin/api/providers/${p.providerId}/scan`, { key: 'secret' })).status).toBe(501)

    const empty = caller(build({
      providers: [p],
      modelProber: new StubModelProber([{ model: '', ok: false, error: '没有可测模型' }]),
    }))
    const res = await empty('POST', `/admin/api/providers/${p.providerId}/scan`, { key: 'secret', body: {} })
    expect(res.status).toBe(200)
  })

  test('protocol 端点：设置 / 继承 / 非法 / 双 404', async () => {
    const p = mkProviderFixed({
      name: 'pz', api: 'anthropic-messages',
      models: [{ id: 'm1', manual: false, enabled: true }],
    })
    p.models = p.models.map((m) => ({ ...m, providerId: p.providerId }))
    const call = caller(build({ providers: [p] }))
    const set = await call('PUT', `/admin/api/providers/${p.providerId}/models/m1/protocol`, {
      key: 'secret', body: { protocol: 'openai-responses' },
    })
    expect(set.status).toBe(200)
    expect(((await set.json()) as { api?: string }).api).toBe('openai-responses')

    const inherit = await call('PUT', `/admin/api/providers/${p.providerId}/models/m1/protocol`, {
      key: 'secret', body: { protocol: '' },
    })
    expect(inherit.status).toBe(200)
    expect((await inherit.json() as { api?: string }).api).toBeUndefined() // 空 = 继承 Provider 默认

    expect((await call('PUT', `/admin/api/providers/${p.providerId}/models/m1/protocol`, {
      key: 'secret', body: { protocol: 'nope' },
    })).status).toBe(400)
    expect((await call('PUT', '/admin/api/providers/99999/models/m1/protocol', {
      key: 'secret', body: { protocol: '' },
    })).status).toBe(404)
    expect((await call('PUT', `/admin/api/providers/${p.providerId}/models/nope/protocol`, {
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
        id: 0, ts: new Date(), requestId: 'r', providerId: 1, providerName: 'p',
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
  function discoverAPI(over: { providers?: Provider[]; lister?: ProviderModelLister } = {}): { call: ReturnType<typeof caller> } {
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
    const adopted = await first.json() as Provider
    expect(adopted.name).toBe('wb-auto')
    expect(adopted.providerId).toBeGreaterThan(0) // 采用时由存储层分配

    const second = await call('POST', '/admin/api/discover/adopt', { key: 'secret', body: { key: 'workbuddy' } })
    expect(second.status).toBe(200)
    expect(((await second.json()) as Provider).providerId).toBe(adopted.providerId) // 幂等：同一条

    expect((await call('POST', '/admin/api/discover/adopt', { key: 'secret', body: { key: 'zcode' } })).status).toBe(400)
    expect((await call('POST', '/admin/api/discover/adopt', { key: 'secret', body: { key: 'nope' } })).status).toBe(404)
    expect((await call('POST', '/admin/api/discover/adopt', { key: 'secret', body: { key: 'workbuddy', name: 'Bad_ID' } })).status).toBe(400)
  })

  // 「一键导入」必须真的一键可用（2026-09-17 实测新用户路径发现）：
  // 草稿不再预填猜的模型名（曾写死 hy3-preview：用户按真实名 hy4-preview 调用 404，
  // 而那个占位名有时上游还认、调用居然出字，用户以为配好了——比 404 更误导）。
  // 代价是目录为空 → 用户拿真名调用仍 404，还得自己知道去点「扫描可用性」。
  // 所以导入时自动扫一次补全。
  test('adopt：目录为空时自动扫一次真实模型写回', async () => {
    const lister = new StubLister({ models: ['m1', 'm2', 'm3'], source: 'upstream' })
    const { call } = discoverAPI({ lister })
    const res = await call('POST', '/admin/api/discover/adopt', { key: 'secret', body: { key: 'workbuddy' } })
    const p = await res.json() as Provider
    expect(p.models.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(p.models.every((m) => m.enabled)).toBe(true)
  })

  test('adopt：扫描失败不让导入失败，改为给可执行指引', async () => {
    const { call } = discoverAPI({ lister: new StubLister({ models: [], source: '' }, 'boom') })
    const res = await call('POST', '/admin/api/discover/adopt', { key: 'secret', body: { key: 'workbuddy' } })
    expect(res.status).toBe(201) // 扫描是尽力而为：失败不该让采用动作整体失败
    const b = await res.json() as { models: unknown[]; warnings?: string[] }
    expect(b.models).toHaveLength(0)
    expect(b.warnings?.some((w) => w.includes('扫描可用性'))).toBe(true)
  })

  test('adopt：已有模型目录不被自动扫描覆盖（尊重用户手工维护）', async () => {
    const keep = { ...readyProvider('wb-auto'), models: [{ id: 'mine', manual: true, enabled: true }] }
    const findings: Finding[] = [{ key: 'workbuddy', harness: 'WB', status: 'ready', detail: 't', suggestedProvider: keep }]
    const app = build({ discover: new StubDiscover(findings), lister: new StubLister({ models: ['other'], source: 'upstream' }) })
    const res = await caller(app)('POST', '/admin/api/discover/adopt', { key: 'secret', body: { key: 'workbuddy' } })
    const p = await res.json() as Provider
    expect(p.models.map((m) => m.id)).toEqual(['mine'])
  })

  test('adopt 自定义 name 覆盖建议名', async () => {
    const { call } = discoverAPI()
    const res = await call('POST', '/admin/api/discover/adopt', { key: 'secret', body: { key: 'workbuddy', name: 'my-wb' } })
    expect(res.status).toBe(201)
    expect(((await res.json()) as Provider).name).toBe('my-wb')
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
      suggestedProvider: { ...readyProvider('wb-auto'), credential: { apiKeyEnv: 'WB_TOKEN' } },
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

  // 回归锚点：adopt 里 providers.put(p) 必须在 importSuggestedAccounts 之前。
  // providerId 是在 put 里由存储层分配并回填 p.providerId 的；以前 put 放在最后，
  // 导入账号时拿到的还是 0 → 账号带着 providerId=0 落库。而 pool/router 一律用
  // `a.providerId === providerId` 严格相等匹配（pool/account.ts、proxy.ts、probe.ts），
  // 0 永远命不中，一键导入的账号因此根本不参与轮询——表面上"导入成功"，实际是死账号。
  test('adopt 导入的账号归属到真实 providerId（不能是 0）', async () => {
    isolateCwd()
    const alive = makeAuthFile('主号')
    const findings: Finding[] = [{
      key: 'workbuddy', harness: 'WB', status: 'ready', detail: '',
      suggestedProvider: { ...readyProvider('wb-auto'), credential: { apiKeyEnv: 'WB_TOKEN' } },
      suggestedAccounts: [{ nickname: '主号', uid: 'u1', alive: true, tokenPath: alive.tokenPath }],
    }]
    const call = caller(build({ discover: new StubDiscover(findings) }))
    const res = await call('POST', '/admin/api/discover/adopt', { key: 'secret', body: { key: 'workbuddy' } })
    expect(res.status).toBe(201)
    const adopted = (await res.json()) as Provider
    expect(adopted.providerId).toBeGreaterThan(0)

    const accts = await call('GET', '/admin/api/accounts', { key: 'secret' })
      .then((r) => r.json() as Promise<{ accounts: Account[] }>)
    expect(accts.accounts).toHaveLength(1)
    // 核心断言：账号归属必须等于采用出来的 Provider，而不是 0
    expect(accts.accounts[0]!.providerId).toBe(adopted.providerId)
    expect(accts.accounts[0]!.providerId).toBeGreaterThan(0)

    // 且这个 id 必须真能命中 Provider（0 命不中任何一行）
    const ps = await call('GET', '/admin/api/providers', { key: 'secret' })
      .then((r) => r.json() as Promise<{ providers: Provider[] }>)
    expect(ps.providers.some((p) => p.providerId === accts.accounts[0]!.providerId)).toBe(true)
  })

  test('adopt 幂等：重复采用不再重复建账号', async () => {
    isolateCwd()
    const alive = makeAuthFile('主号')
    const findings: Finding[] = [{
      key: 'workbuddy', harness: 'WB', status: 'ready', detail: '',
      suggestedProvider: { ...readyProvider('wb-auto'), credential: { apiKeyEnv: 'WB_TOKEN' } },
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

  test('已接管的登录态标出 adoptedProviderId（判据 = 草稿 Provider id 已在库中）', async () => {
    const findings: Finding[] = [
      { key: 'workbuddy', harness: 'WB', status: 'ready', detail: '', suggestedProvider: readyProvider('wb-auto') },
      { key: 'opencode-zen', harness: 'Zen', status: 'ready', detail: '', suggestedProvider: readyProvider('zen-auto') },
    ]
    // 库里只有 wb-auto：它已接管；zen-auto 没有 → 未接管
    const wbAuto = mkProviderFixed({ name: 'wb-auto' })
    const call = caller(build({
      discover: new StubDiscover(findings),
      providers: [wbAuto],
    }))
    const list = await call('GET', '/admin/api/discover', { key: 'secret' })
      .then((r) => r.json() as Promise<{ findings: Finding[] }>)
    // adoptedProviderId 现在是数字 providerId（报真实行 id，前端据此定位/删除）
    expect(list.findings.find((f) => f.key === 'workbuddy')!.adoptedProviderId).toBe(wbAuto.providerId)
    expect(list.findings.find((f) => f.key === 'opencode-zen')!.adoptedProviderId).toBeUndefined()
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
        suggestedProvider: readyProvider('zen-auto'),
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
    const imported = await res.json() as { provider: Provider }
    expect(imported.provider.name).toBe('zen-auto')
    expect(imported.provider.providerId).toBeGreaterThan(0)
  })

  test('库里的 Provider id 与草稿一致才报「已接管」，且报的是真实行 id', async () => {
    // 用户把自动发现建的 zen-auto 改名/重建成了 zen：id 不同 → 视为未接管，
    // 「一键导入」保持可用（否则导入入口被永久锁死，用户既导不进来也无处可删）。
    const findings: Finding[] = [
      {
        key: 'opencode-zen', harness: 'Zen', status: 'ready', detail: '',
        suggestedProvider: readyProvider('zen-auto'),
      },
    ]
    const call = caller(build({
      discover: new StubDiscover(findings),
      providers: [mkProviderFixed({ name: 'zen' })],
    }))
    const list = await call('GET', '/admin/api/discover', { key: 'secret' })
      .then((r) => r.json() as Promise<{ findings: Finding[] }>)
    expect(list.findings.find((x) => x.key === 'opencode-zen')!.adoptedProviderId).toBeUndefined()
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
    // 导入账号要挂到「已接管该 harness 的 Provider」上：先把它建好。
    const wb = mkProviderFixed({ name: 'workbuddy' })
    const call = caller(build({ discover: new StubDiscover([findingWith(tokenPath)]), providers: [wb] }))
    const res = await call('POST', '/admin/api/discover/import-account', {
      key: 'secret',
      body: { key: 'workbuddy', tokenPath, accountId: 'wb-x', displayName: '副号A', credentialFile: 'config/credentials/wb-jwt-x' },
    })

    expect(res.status).toBe(201)
    const acct = await res.json() as Account
    expect(acct.id).toBe('wb-x')
    expect(acct.providerId).toBe(wb.providerId) // 归属 = 接管该 harness 的 Provider（数字 id）
    expect(acct.credential.apiKeyFile).toBe('config/credentials/wb-jwt-x')
    const credPath = join(process.cwd(), 'config', 'credentials', 'wb-jwt-x')
    expect(readFileSync(credPath, 'utf8')).toBe(token)
    expect(statSync(credPath).mode & 0o777).toBe(0o600)
    // 单账号导入同样打来源标记：账号页「签到」（自动登录）按钮只认它，
    // 不打标 = 导进来也点不了签到（此前只有 quick-import 打标）。
    expect(acct.importSource).toBe('workbuddy')
    expect(acct.workbuddyUid).toBe('uid-副号A')
    expect(acct.workbuddyTokenHash).toBe(workbuddyTokenHash(token))
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
    const wb2 = mkProviderFixed({ name: 'workbuddy' })
    const call = caller(build({ discover: new StubDiscover([findingWith(tokenPath)]), providers: [wb2] }))
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

// quick-import / checkin 共用的发现项夹具（key=workbuddy，草稿名 wb-auto）。
const qf = (accounts: { nickname: string; tokenPath: string; alive: boolean }[]): Finding => ({
  key: 'workbuddy', harness: 'WB', status: 'ready', detail: '',
  suggestedProvider: readyProvider('wb-auto'),
  suggestedAccounts: accounts.map((a) => ({ nickname: a.nickname, alive: a.alive, tokenPath: a.tokenPath })),
})

describe('discover/quick-import（对齐 Go quickimport_test.go）', () => {
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
    expect(out.provider.name).toBe('wb-auto')
    expect(out.provider.providerId).toBeGreaterThan(0)
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

  test('一键导入写入 workbuddy 来源标记与 UID，重导入刷新指纹', async () => {
    isolateCwd()
    const a = makeAuthFile('主号')
    const call = caller(build({ discover: new StubDiscover([
      qf([{ nickname: '主号', tokenPath: a.tokenPath, alive: true }]),
    ]) }))
    const res = await call('POST', '/admin/api/discover/quick-import', { key: 'secret', body: { key: 'workbuddy' } })
    expect(res.status).toBe(200)
    const list = await call('GET', '/admin/api/accounts', { key: 'secret' })
    const rows = ((await list.json()) as { accounts: Account[] }).accounts
    expect(rows).toHaveLength(1)
    expect(rows[0]!.importSource).toBe('workbuddy')
    expect(rows[0]!.workbuddyUid).toBe('uid-主号')
    expect(rows[0]!.workbuddyTokenHash).toBe(workbuddyTokenHash(a.token))
    // token 轮换后重新扫描导入：标记与 UID 原位刷新
    const raw = JSON.parse(readFileSync(a.tokenPath, 'utf8')) as { auth: { accessToken: string } }
    raw.auth.accessToken += '-v2'
    writeFileSync(a.tokenPath, JSON.stringify(raw))
    await call('POST', '/admin/api/discover/quick-import', { key: 'secret', body: { key: 'workbuddy' } })
    const list2 = await call('GET', '/admin/api/accounts', { key: 'secret' })
    const rows2 = ((await list2.json()) as { accounts: Account[] }).accounts
    expect(rows2).toHaveLength(1)
    expect(rows2[0]!.workbuddyTokenHash).toBe(workbuddyTokenHash(raw.auth.accessToken))
  })

  test('手工建的账号无来源标记；PATCH/POST 不允许伪造 importSource', async () => {
    isolateCwd()
    const a = makeAuthFile('主号')
    const call = caller(build({ discover: new StubDiscover([
      qf([{ nickname: '主号', tokenPath: a.tokenPath, alive: true }]),
    ]) }))
    // 同名昵称的手工账号：不会被误打标记
    const mk = await call('POST', '/admin/api/accounts', {
      key: 'secret', body: { id: 'manual', providerName: 'wb-auto', displayName: '主号', credential: {} },
    })
    expect(mk.status).toBe(201)
    await call('POST', '/admin/api/discover/quick-import', { key: 'secret', body: { key: 'workbuddy' } })
    const list = await call('GET', '/admin/api/accounts', { key: 'secret' })
    const rows = ((await list.json()) as { accounts: Account[] }).accounts
    const manual = rows.find((x) => x.id === 'manual')
    expect(manual).toBeDefined()
    expect(manual!.importSource).toBeUndefined()
    expect(manual!.workbuddyUid).toBeUndefined()
    const patched = await call('PATCH', '/admin/api/accounts/manual', {
      key: 'secret', body: { importSource: 'workbuddy', workbuddyUid: 'x' },
    })
    expect(patched.status).toBe(400)
    const posted = await call('POST', '/admin/api/accounts', {
      key: 'secret', body: { id: 'fake', providerName: 'wb-auto', importSource: 'workbuddy', credential: {} },
    })
    expect(posted.status).toBe(400)
  })

  test('zen 未配 ZEN_KEY：公共 key 自动落凭据文件；已配则不动', async () => {
    isolateCwd()
    const prev = process.env.ZEN_KEY
    delete process.env.ZEN_KEY
    try {
      const zen = { ...readyProvider('zen'), credential: { apiKeyEnv: 'ZEN_KEY' } }
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
      const zen2 = { ...readyProvider('zen2'), credential: { apiKeyEnv: 'ZEN_KEY' } }
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

// ---- accounts/checkin（WorkBuddy 自动登录：账号页「签到」按钮，只认一键导入账号） ----

describe('accounts/checkin（WorkBuddy 签到，上游调用经 workbuddyCheckinFetch 注入桩）', () => {
  const TOKEN = 'wb-checkin-token'
  // 真实 WorkBuddy uid 是 36 位 ASCII（UUID 形态，见登录态 account.uid）；
  // checkin 把它放进 X-User-Id 请求头，含中文/空格的 uid 发不出去，接口会 400 拒收——
  // 所以夹具必须用 ASCII uid，不能像 makeAuthFile 那样拿中文昵称拼 uid。
  const UID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
  const ENV = 'WB_CHECKIN_TEST_TOKEN'
  // 一键导入形态的账号：importSource + uid + token 指纹三件套齐（按钮只给这种账号显示）。
  const wbAccount = (wbProviderId: number, over: Partial<Account> = {}): Account => ({
    id: 'wb-1', providerId: wbProviderId, displayName: '主号',
    credential: { apiKeyEnv: ENV }, status: 'available', fails: 0,
    importSource: 'workbuddy', workbuddyUid: UID, workbuddyTokenHash: workbuddyTokenHash(TOKEN),
    ...over,
  })
  const jsonFetch = (status: number, body: unknown, capture?: { url?: string; init?: RequestInit }): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      if (capture && typeof url === 'string') { capture.url = url; capture.init = init }
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
  const withEnv = async (fn: () => Promise<void>): Promise<void> => {
    const prev = process.env[ENV]
    process.env[ENV] = TOKEN
    try { await fn() } finally {
      if (prev === undefined) delete process.env[ENV]
      else process.env[ENV] = prev
    }
  }

  test('签到成功：200 accepted，且带上导入登录态的 Authorization/X-User-Id', async () => {
    await withEnv(async () => {
      const wb = mkProviderFixed({ name: 'wb-auto' })
      const capture: { url?: string; init?: RequestInit } = {}
      const call = caller(build({
        providers: [wb], accounts: [wbAccount(wb.providerId)],
        workbuddyCheckinFetch: jsonFetch(200, { code: 0, msg: 'OK' }, capture),
      }))
      const res = await call('POST', '/admin/api/accounts/wb-1/checkin', { key: 'secret' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ status: 'accepted', message: 'WorkBuddy 已接受本次签到请求' })
      expect(capture.url).toBe('https://copilot.tencent.com/billing/meter/daily-checkin')
      const headers = capture.init?.headers as Record<string, string>
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`)
      expect(headers['X-User-Id']).toBe(UID)
    })
  })

  test('今天已签到：上游 400/code 10001 → 200 already_checked_in', async () => {
    await withEnv(async () => {
      const wb = mkProviderFixed({ name: 'wb-auto' })
      const call = caller(build({
        providers: [wb], accounts: [wbAccount(wb.providerId)],
        workbuddyCheckinFetch: jsonFetch(400, { code: 10001, msg: '今天已签到，请明天再来' }),
      }))
      const res = await call('POST', '/admin/api/accounts/wb-1/checkin', { key: 'secret' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ status: 'already_checked_in', message: '今天已签到，请明天再来' })
    })
  })

  test('门禁：未知账号 404；非一键导入账号 400；凭据变更 400；登录态失效 502', async () => {
    await withEnv(async () => {
      const wb = mkProviderFixed({ name: 'wb-auto' })
      const manual: Account = {
        id: 'manual', providerId: wb.providerId, displayName: '手建',
        credential: { apiKeyEnv: ENV }, status: 'available', fails: 0,
      }
      const stale = wbAccount(wb.providerId, {
        id: 'wb-stale', workbuddyTokenHash: workbuddyTokenHash('rotated-elsewhere'),
      })
      const call = caller(build({
        providers: [wb], accounts: [wbAccount(wb.providerId), manual, stale],
        workbuddyCheckinFetch: jsonFetch(401, { code: 401, msg: 'unauthorized' }),
      }))
      expect((await call('POST', '/admin/api/accounts/nope/checkin', { key: 'secret' })).status).toBe(404)
      const nonWb = await call('POST', '/admin/api/accounts/manual/checkin', { key: 'secret' })
      expect(nonWb.status).toBe(400)
      expect(((await nonWb.json()) as { error: { message: string } }).error.message).toContain('仅支持一键导入')
      const changed = await call('POST', '/admin/api/accounts/wb-stale/checkin', { key: 'secret' })
      expect(changed.status).toBe(400)
      expect(((await changed.json()) as { error: { message: string } }).error.message).toContain('凭据缺失或已变更')
      // token 指纹对上才会走到上游：401/403 转 502 并指引重新登录导入。
      const expired = await call('POST', '/admin/api/accounts/wb-1/checkin', { key: 'secret' })
      expect(expired.status).toBe(502)
      expect(((await expired.json()) as { error: { message: string } }).error.message).toContain('重新登录')
    })
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
describe('PUT /admin/api/providers/:pid/models/:model/note（模型备注）', () => {
  const mk = (): Provider => {
    const p = mkProviderFixed({
      name: 'pz', api: 'anthropic-messages',
      models: [{ id: 'm1', manual: false, enabled: true }],
    })
    p.models = p.models.map((m) => ({ ...m, providerId: p.providerId }))
    return p
  }

  test('写入/覆盖/清空备注；空串 = 删掉该字段', async () => {
    const pz = mk()
    const call = caller(build({ providers: [pz] }))
    const set = await call('PUT', `/admin/api/providers/${pz.providerId}/models/m1/note`, {
      key: 'secret', body: { note: '23 点后才免费，白天用会扣额度' },
    })
    expect(set.status).toBe(200)
    expect(((await set.json()) as { note?: string }).note).toBe('23 点后才免费，白天用会扣额度')

    // 覆盖
    await call('PUT', `/admin/api/providers/${pz.providerId}/models/m1/note`, {
      key: 'secret', body: { note: '已确认全天免费' },
    })
    const list = await (await call('GET', '/admin/api/providers', { key: 'secret' })).json() as { providers: Provider[] }
    expect(list.providers[0]!.models[0]!.note).toBe('已确认全天免费')

    // 清空 → 字段消失（不是留个空串）
    const clear = await call('PUT', `/admin/api/providers/${pz.providerId}/models/m1/note`, {
      key: 'secret', body: { note: '' },
    })
    expect(clear.status).toBe(200)
    const after = await (await call('GET', '/admin/api/providers', { key: 'secret' })).json() as { providers: Provider[] }
    expect(after.providers[0]!.models[0]!.note).toBeUndefined()
  })

  test('触发变更通知（调度热重载）；404 与非法请求体', async () => {
    let n = 0
    const pz = mk()
    const call = caller(build({ providers: [pz], notify: () => { n++ } }))
    await call('PUT', `/admin/api/providers/${pz.providerId}/models/m1/note`, { key: 'secret', body: { note: 'x' } })
    expect(n).toBe(1)
    expect((await call('PUT', `/admin/api/providers/${pz.providerId}/models/m1/note`, {
      key: 'secret', body: { note: 123 },
    })).status).toBe(400)
    expect((await call('PUT', `/admin/api/providers/${pz.providerId}/models/nope/note`, {
      key: 'secret', body: { note: 'x' },
    })).status).toBe(404)
    expect((await call('PUT', '/admin/api/providers/99999/models/m1/note', {
      key: 'secret', body: { note: 'x' },
    })).status).toBe(404)
  })

  test('备注不影响模型其它字段（改完协议/出口还在）', async () => {
    const pz = mk()
    const call = caller(build({ providers: [pz] }))
    await call('PUT', `/admin/api/providers/${pz.providerId}/models/m1/protocol`, {
      key: 'secret', body: { protocol: 'openai-responses' },
    })
    await call('PUT', `/admin/api/providers/${pz.providerId}/models/m1/note`, {
      key: 'secret', body: { note: '备' },
    })
    const list = await (await call('GET', '/admin/api/providers', { key: 'secret' })).json() as { providers: Provider[] }
    const m = list.providers[0]!.models[0]!
    expect(m.api).toBe('openai-responses')
    expect(m.note).toBe('备')
  })
})

describe('PUT /admin/api/providers/:pid/models/:model/reasoning-effort（模型推理强度预设）', () => {
  const mk = (): Provider => {
    const p = mkProviderFixed({
      name: 'pz', api: 'openai-completions',
      models: [{ id: 'm1', manual: false, enabled: true }],
    })
    p.models = p.models.map((m) => ({ ...m, providerId: p.providerId }))
    return p
  }

  test('写入/覆盖/清空预设；空串 = 删掉该字段（跟随客户端）', async () => {
    const pz = mk()
    const call = caller(build({ providers: [pz] }))
    const set = await call('PUT', `/admin/api/providers/${pz.providerId}/models/m1/reasoning-effort`, {
      key: 'secret', body: { reasoningEffort: ' high ' },
    })
    expect(set.status).toBe(200)
    // 只去首尾空格，大小写与拼写原样保留（各家档位名不通用，网关不改写）
    expect(((await set.json()) as { reasoningEffort?: string }).reasoningEffort).toBe('high')

    // 网关自定义拼写不被拦
    const custom = await call('PUT', `/admin/api/providers/${pz.providerId}/models/m1/reasoning-effort`, {
      key: 'secret', body: { reasoningEffort: 'ultra' },
    })
    expect(custom.status).toBe(200)
    const list = await (await call('GET', '/admin/api/providers', { key: 'secret' })).json() as { providers: Provider[] }
    expect(list.providers[0]!.models[0]!.reasoningEffort).toBe('ultra')

    // 清空 → 字段消失（不是留个空串）
    const clear = await call('PUT', `/admin/api/providers/${pz.providerId}/models/m1/reasoning-effort`, {
      key: 'secret', body: { reasoningEffort: '' },
    })
    expect(clear.status).toBe(200)
    const after = await (await call('GET', '/admin/api/providers', { key: 'secret' })).json() as { providers: Provider[] }
    expect(after.providers[0]!.models[0]!.reasoningEffort).toBeUndefined()
  })

  test('超长 400；未知模型/provider 404；非法请求体 400', async () => {
    const pz = mk()
    const call = caller(build({ providers: [pz] }))
    expect((await call('PUT', `/admin/api/providers/${pz.providerId}/models/m1/reasoning-effort`, {
      key: 'secret', body: { reasoningEffort: 'x'.repeat(33) },
    })).status).toBe(400)
    expect((await call('PUT', `/admin/api/providers/${pz.providerId}/models/m1/reasoning-effort`, {
      key: 'secret', body: {},
    })).status).toBe(400)
    expect((await call('PUT', `/admin/api/providers/${pz.providerId}/models/nope/reasoning-effort`, {
      key: 'secret', body: { reasoningEffort: 'high' },
    })).status).toBe(404)
    expect((await call('PUT', '/admin/api/providers/99999/models/m1/reasoning-effort', {
      key: 'secret', body: { reasoningEffort: 'high' },
    })).status).toBe(404)
  })
})

describe('PUT /admin/api/providers/:pid/models/:model/enabled（对外暴露开关）', () => {
  test('开关模型启用；404 与非法请求体', async () => {
    const p = mkProviderFixed({
      name: 'pz', api: 'anthropic-messages',
      models: [
        { id: 'm1', manual: false, enabled: true },
        { id: 'm2', manual: false, enabled: true },
      ],
    })
    p.models = p.models.map((m) => ({ ...m, providerId: p.providerId }))
    const call = caller(build({ providers: [p] }))

    const off = await call('PUT', `/admin/api/providers/${p.providerId}/models/m2/enabled`, {
      key: 'secret', body: { enabled: false },
    })
    expect(off.status).toBe(200)
    expect(((await off.json()) as { enabled: boolean }).enabled).toBe(false)

    const on = await call('PUT', `/admin/api/providers/${p.providerId}/models/m2/enabled`, {
      key: 'secret', body: { enabled: true },
    })
    expect(on.status).toBe(200)
    expect(((await on.json()) as { enabled: boolean }).enabled).toBe(true)

    expect((await call('PUT', `/admin/api/providers/${p.providerId}/models/m2/enabled`, {
      key: 'secret', body: {},
    })).status).toBe(400)
    expect((await call('PUT', `/admin/api/providers/${p.providerId}/models/nope/enabled`, {
      key: 'secret', body: { enabled: true },
    })).status).toBe(404)
    expect((await call('PUT', '/admin/api/providers/99999/models/m1/enabled', {
      key: 'secret', body: { enabled: true },
    })).status).toBe(404)
  })
})

// 手填错的模型得能摘掉：PATCH models 只增不减，所以删除必须独立端点。
describe('DELETE /admin/api/providers/:pid/models/:model（删单个模型）', () => {  test('删掉指定模型，其余不动；未知 provider/模型 404', async () => {
    const p = mkProviderFixed({
      name: 'pz', api: 'anthropic-messages',
      models: [
        { id: 'hand-typed', manual: true, enabled: true },
        { id: 'm2', manual: false, enabled: true },
      ],
    })
    p.models = p.models.map((m) => ({ ...m, providerId: p.providerId }))
    let notified = 0
    const call = caller(build({ providers: [p], notify: () => { notified++ } }))

    const del = await call('DELETE', `/admin/api/providers/${p.providerId}/models/hand-typed`, { key: 'secret' })
    expect(del.status).toBe(204)
    expect(notified).toBe(1) // 触发调度热重载

    const list = await (await call('GET', '/admin/api/providers', { key: 'secret' })).json() as { providers: Provider[] }
    expect(list.providers[0]!.models.map((m) => m.id)).toEqual(['m2'])

    // 重复删 / 未知模型 / 未知 provider
    expect((await call('DELETE', `/admin/api/providers/${p.providerId}/models/hand-typed`, { key: 'secret' })).status).toBe(404)
    expect((await call('DELETE', `/admin/api/providers/${p.providerId}/models/nope`, { key: 'secret' })).status).toBe(404)
    expect((await call('DELETE', '/admin/api/providers/99999/models/m2', { key: 'secret' })).status).toBe(404)
  })

  test('删除后 PATCH models 仍只增不减（删了再加能回来）', async () => {
    const p = mkProviderFixed({
      name: 'pz', api: 'anthropic-messages',
      models: [{ id: 'm1', manual: true, enabled: true }],
    })
    p.models = p.models.map((m) => ({ ...m, providerId: p.providerId }))
    const call = caller(build({ providers: [p] }))
    expect((await call('DELETE', `/admin/api/providers/${p.providerId}/models/m1`, { key: 'secret' })).status).toBe(204)
    const back = await call('PATCH', `/admin/api/providers/${p.providerId}`, { key: 'secret', body: { models: ['m1'] } })
    expect(back.status).toBe(200)
    const list = await (await call('GET', '/admin/api/providers', { key: 'secret' })).json() as { providers: Provider[] }
    expect(list.providers[0]!.models.map((m) => m.id)).toEqual(['m1'])
  })
})
