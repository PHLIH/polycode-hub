// 管理面 REST（/admin/api/*，对齐 Go internal/adminapi/api.go）。
// 鉴权 withAuth（X-Admin-Key 或 Bearer；key 空 = 本机裸跑放行）；错误形状 {error:{type,message}}。
// 依赖注入：prober/lister/modelProber/resetter/discover/stats 未接线时对应端点 501
// （discover 列表例外：返回空列表，对齐 Go）；sidecar/projects 以 Hono 子应用注入。

import { Hono, type Context } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { ERR, validProtocol } from '../ir/index.ts'
import { providerValidate, accountHealth, type Account, type Model, type Provider } from '../model/index.ts'
import type { ProbeResult } from '../gateway/probe.ts'
import { MemoryAccountStore, MemoryProviderStore, type AccountStore, type EgressStore, type ProviderStore } from './store.ts'
import { isObj, parseAccount, parseCredential, parseProvider } from './parse.ts'
import { registerDiscoverRoutes } from './discover_api.ts'
import type {
  AccountProber, AccountResetter, AccountRuntime, ChangeNotifier, DiscoverSource, ModelList,
  ProviderModelLister, ProviderModelProber, ProviderProber,
  StatsSource,
} from './types.ts'
export type { ModelList }

// ---- 依赖装配 ----

export interface AdminApiDeps {
  adminKey: string
  egresses?: EgressStore
  providers?: ProviderStore
  accounts?: AccountStore
  stats?: StatsSource
  discover?: DiscoverSource
  resetter?: AccountResetter
  // 账号池运行时快照（冷却/连败不在 DB 里，列表页靠它显示真实状态）
  accountRuntime?: AccountRuntime
  accountProber?: AccountProber
  prober?: ProviderProber
  lister?: ProviderModelLister
  modelProber?: ProviderModelProber
  builtinIDs?: string[]
  notify?: ChangeNotifier
  sidecar?: Hono
  projects?: Hono
}

// PATCH 白名单（只读字段出现即 400；ID 永久不可改；credential 只收引用）。
const PROVIDER_PATCH_ALLOW = new Set([
  'enabled', 'priority', 'streamOnly', 'displayName', 'riskNote',
  'credential', 'models', 'probeModel', 'egress', 'accountIds',
])

const ACCOUNT_PATCH_ALLOW = new Set(['status', 'displayName', 'credential'])

// ---- 小件 ----

type C = Context

function ok(c: C, status: 200 | 201 | 409 | 501 | 502, v?: unknown): Response {
  return c.json(v ?? {}, status)
}

function errRes(c: C, status: 400 | 401 | 403 | 404 | 409 | 500 | 501 | 502, typ: string, msg: string): Response {
  return c.json({ error: { type: typ, message: msg } }, status)
}

// 恒时比较（防时序攻击；对齐 Go subtle.ConstantTimeCompare 的判定语义）。
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab) // 长度不同也做一次比较，抹平时序
    return false
  }
  return timingSafeEqual(ab, bb)
}

async function jsonBody(c: C): Promise<unknown> {
  return c.req.json().catch(() => undefined)
}

interface CapsPatch {
  input?: string[]
  contextWindow?: number
  maxOutputTokens?: number
}

interface PatchModel {
  id: string
  protocol: string
  caps?: CapsPatch
}

// patchModel 兼容 "glm-5" 与 {"id":"glm-5", protocol?, caps?} 两种写法。
function parsePatchModels(v: unknown): PatchModel[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: PatchModel[] = []
  for (const item of v) {
    if (typeof item === 'string') {
      out.push({ id: item, protocol: '' })
      continue
    }
    if (!isObj(item) || typeof item.id !== 'string') return undefined
    const pm: PatchModel = { id: item.id, protocol: '' }
    if (typeof item.protocol === 'string' && validProtocol(item.protocol)) pm.protocol = item.protocol
    if (isObj(item.caps)) {
      const caps: CapsPatch = {}
      const input = item.caps.input
      if (Array.isArray(input) && input.length > 0 && input.every((x) => typeof x === 'string')) {
        caps.input = input as string[]
      }
      if (typeof item.caps.contextWindow === 'number') caps.contextWindow = item.caps.contextWindow
      if (typeof item.caps.maxOutputTokens === 'number') caps.maxOutputTokens = item.caps.maxOutputTokens
      pm.caps = caps
    }
    out.push(pm)
  }
  return out
}

// ---- 装配入口 ----

export function createAdminApi(deps: AdminApiDeps): Hono {
  const providers = deps.providers ?? new MemoryProviderStore()
  const accounts = deps.accounts ?? new MemoryAccountStore()
  const builtin = new Set(deps.builtinIDs ?? [])
  const changed: ChangeNotifier = () => deps.notify?.()

  const markBuiltin = (p: Provider): Provider => ({ ...p, builtin: builtin.has(p.id) })

  const app = new Hono()

  // withAuth：key 为空 = 裸跑放行；否则 X-Admin-Key 或 Bearer。
  app.use('*', async (c, next) => {
    if (deps.adminKey === '') return next()
    let got = c.req.header('X-Admin-Key') ?? ''
    if (got === '') {
      const authz = c.req.header('Authorization') ?? ''
      got = authz.startsWith('Bearer ') ? authz.slice(7) : authz
    }
    if (!safeEqual(got, deps.adminKey)) {
      return errRes(c, 401, ERR.AUTHENTICATION, '管理口令无效')
    }
    await next()
  })

  // ---- providers ----

  // 顶层出口列表 + CRUD：Provider/模型 egress 绑定的数据源。config/apps.yaml 里的定义由 cli 启动时种进库。
  app.get('/admin/api/egresses', (c) => ok(c, 200, { egresses: deps.egresses?.list() ?? [] }))
  app.put('/admin/api/egresses/:id', async (c) => {
    if (!deps.egresses) return errRes(c, 501, ERR.API, 'egress 存储未接线')
    const id = c.req.param('id')
    if (!id) return errRes(c, 400, ERR.INVALID_REQUEST, 'egress id 不能为空')
    const body = await jsonBody(c)
    if (!isObj(body) || typeof body.kind !== 'string' || typeof body.addr !== 'string' || body.addr === '') {
      return errRes(c, 400, ERR.INVALID_REQUEST, '请求体须为 {"kind": "http"|"https", "addr": "host:port"}')
    }
    if (body.kind !== 'http' && body.kind !== 'https') {
      return errRes(c, 400, ERR.INVALID_REQUEST, 'kind 只支持 http / https（Clash 混合端口用 http）')
    }
    const e = { id, kind: body.kind, addr: body.addr }
    deps.egresses.put(e)
    changed()
    return ok(c, 200, e)
  })
  app.delete('/admin/api/egresses/:id', (c) => {
    if (!deps.egresses) return errRes(c, 501, ERR.API, 'egress 存储未接线')
    if (!deps.egresses.delete(c.req.param('id'))) {
      return errRes(c, 404, ERR.NOT_FOUND, `egress ${c.req.param('id')} 不存在`)
    }
    changed()
    return ok(c, 200, { deleted: true })
  })

  app.get('/admin/api/providers', (c) => {
    return ok(c, 200, { providers: providers.list().map(markBuiltin) })
  })

  app.post('/admin/api/providers', async (c) => {
    const raw = await jsonBody(c)
    if (raw === undefined) return errRes(c, 400, ERR.INVALID_REQUEST, '请求体不是合法 JSON')
    const p = parseProvider(raw)
    const verr = providerValidate(p)
    if (verr) return errRes(c, 400, ERR.INVALID_REQUEST, verr)
    if (p.accountIds && p.accountIds.length > 0) {
      for (const id of p.accountIds) {
        const a = accounts.get(id)
        if (!a) return errRes(c, 400, ERR.INVALID_REQUEST, `accountIds 引用了不存在的账号 ${id}`)
        if (a.sourceId !== p.sourceId) {
          return errRes(c, 400, ERR.INVALID_REQUEST, `accountIds 账号 ${id} 归属源 ${a.sourceId}，与 Provider 源 ${p.sourceId} 不一致`)
        }
      }
    }
    if (providers.get(p.id)) {
      return errRes(c, 409, ERR.INVALID_REQUEST, `provider ${p.id} 已存在`)
    }
    providers.put(p)
    changed()
    return ok(c, 201, p)
  })

  app.patch('/admin/api/providers/:id', async (c) => {
    const id = c.req.param('id')
    const p = providers.get(id)
    if (!p) return errRes(c, 404, ERR.NOT_FOUND, `provider ${id} 不存在`)
    const patch = await jsonBody(c)
    if (!isObj(patch)) return errRes(c, 400, ERR.INVALID_REQUEST, '请求体不是合法 JSON')
    for (const k of Object.keys(patch)) {
      if (!PROVIDER_PATCH_ALLOW.has(k)) {
        return errRes(c, 400, ERR.INVALID_REQUEST, `字段 ${k} 只读（改名/换协议 = 新建 + 删旧）`)
      }
    }
    if ('models' in patch) {
      // 模型采用：只增不减。已有 ID 不删（元数据保留），但补协议与能力（上游新声明的以本次为准）。
      const ids = parsePatchModels(patch.models)
      if (!ids) return errRes(c, 400, ERR.INVALID_REQUEST, 'models 须为 ["id"] 或 [{"id"}]')
      const have = new Set(p.models.map((m) => m.id))
      for (const input of ids) {
        if (input.id === '') continue
        const existing = p.models.find((m) => m.id === input.id)
        if (existing) {
          // 已存在：补协议与能力（上游新声明的以本次为准），不动其他元数据。
          if (input.protocol && existing.api !== input.protocol) existing.api = input.protocol
          if (input.caps) {
            if (input.caps.input && input.caps.input.length > 0) existing.input = input.caps.input
            if ((input.caps.contextWindow ?? 0) > 0) existing.contextWindow = input.caps.contextWindow
            if ((input.caps.maxOutputTokens ?? 0) > 0) existing.maxOutputTokens = input.caps.maxOutputTokens
          }
          continue
        }
        have.add(input.id)
        const nm: Model = { id: input.id, providerId: p.id, enabled: true, manual: false }
        if (input.protocol) nm.api = input.protocol
        if (input.caps) {
          nm.input = input.caps.input
          nm.contextWindow = input.caps.contextWindow
          nm.maxOutputTokens = input.caps.maxOutputTokens
        }
        p.models.push(nm)
      }
    }
    const setters: Record<string, (v: unknown) => boolean> = {
      enabled: (v) => {
        if (typeof v !== 'boolean') return false
        p.enabled = v
        return true
      },
      priority: (v) => {
        if (typeof v !== 'number') return false
        p.priority = v
        return true
      },
      streamOnly: (v) => {
        if (typeof v !== 'boolean') return false
        p.streamOnly = v
        return true
      },
      displayName: (v) => {
        if (typeof v !== 'string') return false
        p.displayName = v
        return true
      },
      riskNote: (v) => {
        if (typeof v !== 'string') return false
        p.riskNote = v
        return true
      },
      credential: (v) => {
        if (!isObj(v)) return false
        p.credential = parseCredential(v)
        return true
      },
      probeModel: (v) => {
        if (typeof v !== 'string') return false
        p.probeModel = v
        return true
      },
      egress: (v) => {
        // 空 = 清除引用（回到直连）；非空字符串 = 出口 id（存在性由调度侧兜底校验）
        if (typeof v !== 'string') return false
        if (v === '') delete p.egress
        else p.egress = v
        return true
      },
      accountIds: (v) => {
        // 白名单：空数组 = 不限（清除绑定）；非空逐个校验存在性与同源。
        if (!Array.isArray(v)) return false
        for (const id of v) {
          if (typeof id !== 'string' || id === '') return false
          const a = accounts.get(id)
          if (!a) return false
          if (a.sourceId !== p.sourceId) return false
        }
        if (v.length === 0) delete p.accountIds
        else p.accountIds = [...v] as string[]
        return true
      },
    }
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'models') continue
      const set = setters[k]
      if (!set) continue
      if (!set(v)) return errRes(c, 400, ERR.INVALID_REQUEST, `字段 ${k} 类型错误`)
    }
    providers.put(p)
    changed()
    return ok(c, 200, markBuiltin(p))
  })

  app.delete('/admin/api/providers/:id', (c) => {
    const id = c.req.param('id')
    if (builtin.has(id)) {
      return errRes(c, 403, ERR.INVALID_REQUEST, '内置 Provider 不可删（按配置文件固定），停用请用开关')
    }
    if (!providers.delete(id)) {
      return errRes(c, 404, ERR.NOT_FOUND, 'provider 不存在')
    }
    changed()
    return c.body(null, 204)
  })

  // ---- accounts ----

  // 列表：DB 记录 + 池内运行时（冷却/连败）。没有池子时退化为纯 DB 状态。
  // 运行时与 DB 冲突时以运行时为准——池子才是真正在调度的那个对象。
  app.get('/admin/api/accounts', (c) => {
    const now = new Date()
    const rows = accounts.list().map((a) => {
      const rt = deps.accountRuntime?.runtime(a.id)
      if (!rt) return { ...a, health: accountHealth(a, now) }
      const merged = { ...a, status: (rt.status || a.status) as Account['status'], fails: rt.fails }
      if (rt.cooldownUntil) merged.cooldownUntil = rt.cooldownUntil
      // 冷却已过期：不显示"冷却中"，直接复位（与 pick 同语义，避免 UI 撒谎）。
      if (merged.status === 'cooldown' && merged.cooldownUntil && now > merged.cooldownUntil) {
        merged.status = 'available'
        delete merged.cooldownUntil
      }
      // 健康度由后端算好下发：阈值只在 model 层定义一处，前端不必复制常量。
      return { ...merged, health: accountHealth(merged, now) }
    })
    return ok(c, 200, { accounts: rows })
  })

  app.post('/admin/api/accounts', async (c) => {
    const raw = await jsonBody(c)
    if (raw === undefined) return errRes(c, 400, ERR.INVALID_REQUEST, '请求体不是合法 JSON')
    const ac = parseAccount(raw)
    if (ac.id === '' || ac.sourceId === '') {
      return errRes(c, 400, ERR.INVALID_REQUEST, 'id 与 sourceId 必填')
    }
    if (!ac.status) ac.status = 'available'
    if (ac.status !== 'available' && ac.status !== 'disabled') {
      return errRes(c, 400, ERR.INVALID_REQUEST, '新建账号 status 只允许 available/disabled')
    }
    if (accounts.get(ac.id)) {
      return errRes(c, 409, ERR.INVALID_REQUEST, `account ${ac.id} 已存在`)
    }
    accounts.put(ac)
    changed()
    return ok(c, 201, ac)
  })

  app.patch('/admin/api/accounts/:id', async (c) => {
    const id = c.req.param('id')
    const ac = accounts.get(id)
    if (!ac) return errRes(c, 404, ERR.NOT_FOUND, `account ${id} 不存在`)
    const patch = await jsonBody(c)
    if (!isObj(patch)) return errRes(c, 400, ERR.INVALID_REQUEST, '请求体不是合法 JSON')
    for (const k of Object.keys(patch)) {
      if (!ACCOUNT_PATCH_ALLOW.has(k)) {
        return errRes(c, 400, ERR.INVALID_REQUEST, `字段 ${k} 只读`)
      }
    }
    if ('status' in patch) {
      const s = patch.status
      if (typeof s !== 'string') return errRes(c, 400, ERR.INVALID_REQUEST, 'status 非法')
      if (s !== 'available' && s !== 'disabled') {
        return errRes(c, 400, ERR.INVALID_REQUEST, 'status 只允许 available/disabled')
      }
      ac.status = s
    }
    const setters: Record<string, (v: unknown) => boolean> = {
      displayName: (v) => {
        if (typeof v !== 'string') return false
        ac.displayName = v
        return true
      },
      credential: (v) => {
        if (!isObj(v)) return false
        ac.credential = parseCredential(v)
        return true
      },
    }
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'status') continue
      const set = setters[k]
      if (!set) continue
      if (!set(v)) return errRes(c, 400, ERR.INVALID_REQUEST, `字段 ${k} 类型错误`)
    }
    accounts.put(ac)
    changed()
    return ok(c, 200, ac)
  })

  app.delete('/admin/api/accounts/:id', (c) => {
    if (!accounts.delete(c.req.param('id'))) {
      return errRes(c, 404, ERR.NOT_FOUND, 'account 不存在')
    }
    changed()
    return c.body(null, 204)
  })

  // 人工恢复键：只清调度侧惩罚，不探活（零上游成本）。
  app.post('/admin/api/accounts/:id/recheck', (c) => {
    const id = c.req.param('id')
    if (!accounts.get(id)) return errRes(c, 404, ERR.NOT_FOUND, `account ${id} 不存在`)
    const reset = deps.resetter ? deps.resetter.resetAccount(id) : false
    return ok(c, 200, {
      id,
      reset,
      message: '已清除调度惩罚，下一次真实请求即验证；仍 401 则继续冷却并记 ERROR',
    })
  })

  // 账号测试：用该账号的凭据打一次真实请求（模型缺省取源上第一个启用的）。
  // 有上游成本，与「重置」分开：重置零成本，测试是人工验证。
  app.post('/admin/api/accounts/:id/test', async (c) => {
    const id = c.req.param('id')
    if (!accounts.get(id)) return errRes(c, 404, ERR.NOT_FOUND, `account ${id} 不存在`)
    if (!deps.accountProber) return errRes(c, 501, ERR.API, '账号测试未接线')
    const body = await jsonBody(c)
    const model = isObj(body) && typeof body.model === 'string' ? body.model : ''
    const res: ProbeResult = await deps.accountProber.probeAccount(id, model)
    return ok(c, 200, res)
  })

  // ---- stats ----

  app.get('/admin/api/stats', async (c) => {
    if (!deps.stats) return errRes(c, 501, ERR.API, '统计未接线')
    try {
      return ok(c, 200, await deps.stats.summarize(new Date(0)))
    } catch (e) {
      return errRes(c, 500, ERR.API, '统计失败: ' + (e as Error).message)
    }
  })

  // 仪表盘聚合：days 查询参数限定回溯天数（默认 365，够画一年热力图）。
  // 显式 since/until 优先于 days（TIME-RANGE-FILTER §3.2）：
  //   since/until 支持 ISO 时间戳或 YYYY-MM-DD（本地日历日；until 日期含当日 → 次日 00:00，
  //   与 daily 的 localtime 分组口径一致）。非法值忽略，回落 days 路径。
  // account_id 非空 = 只统计该账号（ACCOUNT-HEALTH：详情页复用本端点）。
  const parseDateParam = (v: string | null | undefined): Date | undefined => {
    if (!v) return undefined
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const [y, m, d] = v.split('-').map(Number)
      return new Date(y!, m! - 1, d!)
    }
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : new Date(t)
  }
  const parseRange = (q: URLSearchParams): { since: Date; until?: Date } => {
    let days = 365
    const v = q.get('days')
    if (v !== undefined && v !== '') {
      const n = Number(v)
      if (Number.isInteger(n) && n > 0 && n <= 3650) days = n
    }
    const since = parseDateParam(q.get('since')) ?? new Date(Date.now() - days * 86_400_000)
    // until 日期形式含当日：加一天使区间右开边界落在次日 00:00
    let until = parseDateParam(q.get('until'))
    if (until && /^\d{4}-\d{2}-\d{2}$/.test(q.get('until')!)) {
      until = new Date(until.getTime() + 86_400_000)
    }
    return { since, until }
  }

  app.get('/admin/api/breakdown', async (c) => {
    if (!deps.stats) return errRes(c, 501, ERR.API, '统计未接线')
    const { since, until } = parseRange(c.req.raw ? new URL(c.req.url).searchParams : new URLSearchParams())
    const accountId = c.req.query('account_id') ?? ''
    try {
      return ok(c, 200, await deps.stats.breakdown(since, until, accountId))
    } catch (e) {
      return errRes(c, 500, ERR.API, '聚合失败: ' + (e as Error).message)
    }
  })

  // 账号维度用量列表（ACCOUNT-HEALTH §3.5）：GET /admin/api/usage/accounts?days=90&since&until
  app.get('/admin/api/usage/accounts', async (c) => {
    if (!deps.stats?.accountBreakdown) return errRes(c, 501, ERR.API, '统计未接线')
    const { since, until } = parseRange(new URL(c.req.url).searchParams)
    try {
      return ok(c, 200, { accounts: await deps.stats.accountBreakdown(since, until) })
    } catch (e) {
      return errRes(c, 500, ERR.API, '聚合失败: ' + (e as Error).message)
    }
  })

  // ---- 发现 + 一键采用（discover_api.ts）----
  registerDiscoverRoutes(app, { providers, accounts, changed, discover: deps.discover })

  // ---- Provider 测试 / 模型发现 / 扫描 ----

  app.post('/admin/api/providers/:id/test', async (c) => {
    if (!deps.prober) return errRes(c, 501, ERR.API, 'Provider 测试未接线')
    const res: ProbeResult = await deps.prober.probeProvider(c.req.param('id'))
    return ok(c, 200, res)
  })

  // 批量实测候选模型；探到的协议写回模型目录（探测结果即事实，下次转发直达）。
  app.post('/admin/api/providers/:id/scan', async (c) => {
    if (!deps.modelProber) return errRes(c, 501, ERR.API, '批量模型扫描未接线')
    const id = c.req.param('id')
    const body = await jsonBody(c)
    const models = isObj(body) && Array.isArray(body.models)
      ? body.models.filter((x): x is string => typeof x === 'string')
      : []
    const results = await deps.modelProber.probeModels(id, models)
    const p = providers.get(id)
    if (p) {
      let mut = false
      for (const r of results) {
        if (!r.ok || !r.protocol) continue
        const m = p.models.find((x) => x.id === r.model)
        if (m && m.api !== r.protocol) {
          m.api = r.protocol
          mut = true
        }
      }
      if (mut) {
        providers.put(p)
        changed()
      }
    }
    return ok(c, 200, { results })
  })

  // 手工指定某模型的协议（空 = 继承 Provider 默认）；扫描自动写入，此端点是纠偏入口。
  app.put('/admin/api/providers/:id/models/:model/protocol', async (c) => {
    const id = c.req.param('id')
    const modelID = c.req.param('model')
    const p = providers.get(id)
    if (!p) return errRes(c, 404, ERR.NOT_FOUND, `provider ${id} 不存在`)
    const body = await jsonBody(c)
    if (!isObj(body)) return errRes(c, 400, ERR.INVALID_REQUEST, '请求体不是合法 JSON')
    const protocol = typeof body.protocol === 'string' ? body.protocol : ''
    if (protocol !== '' && !validProtocol(protocol)) {
      return errRes(c, 400, ERR.INVALID_REQUEST,
        'protocol 只允许 openai-completions / openai-responses / anthropic-messages，或空字符串表示继承')
    }
    const m = p.models.find((x) => x.id === modelID)
    if (!m) return errRes(c, 404, ERR.NOT_FOUND, `provider ${id} 下没有模型 ${modelID}`)
    if (protocol === '') delete m.api
    else m.api = protocol
    providers.put(p)
    changed()
    return ok(c, 200, m)
  })

  // 手工指定某模型的出口代理（空 = 继承 Provider 默认）；引用顶层 egresses 的 id。
  app.put('/admin/api/providers/:id/models/:model/egress', async (c) => {
    const id = c.req.param('id')
    const modelID = c.req.param('model')
    const p = providers.get(id)
    if (!p) return errRes(c, 404, ERR.NOT_FOUND, `provider ${id} 不存在`)
    const body = await jsonBody(c)
    if (!isObj(body)) return errRes(c, 400, ERR.INVALID_REQUEST, '请求体不是合法 JSON')
    const egress = typeof body.egress === 'string' ? body.egress : ''
    const m = p.models.find((x) => x.id === modelID)
    if (!m) return errRes(c, 404, ERR.NOT_FOUND, `provider ${id} 下没有模型 ${modelID}`)
    if (egress === '') delete m.egress
    else m.egress = egress
    providers.put(p)
    changed()
    return ok(c, 200, m)
  })

  // 模型备注：一句话运维知识（如「23 点后才免费，白天用会扣额度」）。
  // 空串 = 删掉该字段，不留空值。与 displayName 分工不同：那是"叫什么"，这是"要注意什么"。
  app.put('/admin/api/providers/:id/models/:model/note', async (c) => {
    const id = c.req.param('id')
    const modelID = c.req.param('model')
    const p = providers.get(id)
    if (!p) return errRes(c, 404, ERR.NOT_FOUND, `provider ${id} 不存在`)
    const body = await jsonBody(c)
    if (!isObj(body) || typeof body.note !== 'string') {
      return errRes(c, 400, ERR.INVALID_REQUEST, '请求体须为 {"note": string}')
    }
    const m = p.models.find((x) => x.id === modelID)
    if (!m) return errRes(c, 404, ERR.NOT_FOUND, `provider ${id} 下没有模型 ${modelID}`)
    // 限长：这是一行提示，不是文档（前端也是单行输入）。
    const note = body.note.trim().slice(0, 200)
    if (note === '') delete m.note
    else m.note = note
    providers.put(p)
    changed()
    return ok(c, 200, m)
  })

  // 开关单个模型的启用：对外暴露（/v1/models）、路由匹配、测试候选都以它为准。
  app.put('/admin/api/providers/:id/models/:model/enabled', async (c) => {
    const id = c.req.param('id')
    const modelID = c.req.param('model')
    const p = providers.get(id)
    if (!p) return errRes(c, 404, ERR.NOT_FOUND, `provider ${id} 不存在`)
    const body = await jsonBody(c)
    if (!isObj(body) || typeof body.enabled !== 'boolean') {
      return errRes(c, 400, ERR.INVALID_REQUEST, '请求体须为 {"enabled": boolean}')
    }
    const m = p.models.find((x) => x.id === modelID)
    if (!m) return errRes(c, 404, ERR.NOT_FOUND, `provider ${id} 下没有模型 ${modelID}`)
    m.enabled = body.enabled
    providers.put(p)
    changed()
    return ok(c, 200, m)
  })

  // 删除单个模型：手填错的/上游已下架的，得能摘掉。
  // PATCH models 是「只增不减」，所以删除必须是独立端点（否则手填的模型永远删不掉）。
  app.delete('/admin/api/providers/:id/models/:model', (c) => {
    const id = c.req.param('id')
    const modelID = c.req.param('model')
    const p = providers.get(id)
    if (!p) return errRes(c, 404, ERR.NOT_FOUND, `provider ${id} 不存在`)
    const i = p.models.findIndex((x) => x.id === modelID)
    if (i < 0) return errRes(c, 404, ERR.NOT_FOUND, `provider ${id} 下没有模型 ${modelID}`)
    p.models.splice(i, 1)
    providers.put(p)
    changed()
    return c.body(null, 204)
  })

  // 拉取上游模型目录；listler 报错时 502（前端引导手填）。
  app.get('/admin/api/providers/:id/models', async (c) => {
    const lister: ProviderModelLister | undefined = deps.lister
    if (!lister) return errRes(c, 501, ERR.API, '模型发现未接线')
    let list: ModelList
    try {
      list = await lister.listProviderModels(c.req.param('id'))
    } catch (e) {
      return errRes(c, 502, ERR.API, (e as Error).message)
    }
    return ok(c, 200, list)
  })

  // ---- sidecar / projects ----

  if (deps.sidecar) {
    app.route('/admin/api/sidecar', deps.sidecar)
  } else {
    app.get('/admin/api/sidecar', (c) => errRes(c, 501, ERR.API, 'sidecar 管理未接线'))
    app.post('/admin/api/sidecar/:action', (c) => errRes(c, 501, ERR.API, 'sidecar 管理未接线'))
  }

  app.route('/admin/api/projects', deps.projects ?? stub501App('项目管理未接线'))

  return app
}

// 未接线的服务路由组：整组 501（路由与鉴权仍齐）。
function stub501App(message: string): Hono {
  const sub = new Hono()
  sub.all('*', (c) => errRes(c, 501, ERR.API, message))
  return sub
}

// 供子模块共享的装配上下文。
export interface AdminCtx {
  providers: ProviderStore
  accounts: AccountStore
  changed: ChangeNotifier
  discover?: DiscoverSource
}

export type { Account, Provider }
