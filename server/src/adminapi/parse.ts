// 请求体 → 实体的收敛解析：Go 用 json.Unmarshal 进零值结构体，TS strict 下
// 显式按字段收敛（缺省 = Go 零值语义），未知形状不炸、校验交给 providerValidate。

import type {
  Account, AccountStatus, CredentialRef, DynamicHeadersSpec, Model, Provider,
} from '../model/index.ts'

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((x): x is string => typeof x === 'string')
  return out.length > 0 ? out : undefined
}

export function parseCredential(v: unknown): CredentialRef {
  if (!isObj(v)) return {}
  const out: CredentialRef = {}
  if (typeof v.apiKeyEnv === 'string') out.apiKeyEnv = v.apiKeyEnv
  if (typeof v.apiKeyFile === 'string') out.apiKeyFile = v.apiKeyFile
  return out
}

function parseModel(v: unknown): Model | undefined {
  if (!isObj(v) || typeof v.id !== 'string' || v.id === '') return undefined
  const m: Model = {
    id: v.id,
    manual: v.manual === true,
    enabled: v.enabled === true,
  }
  if (typeof v.displayName === 'string') m.displayName = v.displayName
  if (typeof v.note === 'string' && v.note !== '') m.note = v.note
  if (typeof v.egress === 'string' && v.egress !== '') m.egress = v.egress
  // 推理预设只去首尾空格：大小写原样保留，非法值（超长）原样保留，
  // 由 providerValidate 点名报错，不静默吞掉。
  if (typeof v.reasoningEffort === 'string' && v.reasoningEffort.trim() !== '') {
    m.reasoningEffort = v.reasoningEffort.trim()
  }
  if (typeof v.contextWindow === 'number') m.contextWindow = v.contextWindow
  if (typeof v.maxOutputTokens === 'number') m.maxOutputTokens = v.maxOutputTokens
  const input = strArr(v.input)
  if (input) m.input = input
  if (typeof v.api === 'string' && v.api !== '') m.api = v.api
  return m
}

export function parseProvider(raw: unknown): Provider {
  const o = isObj(raw) ? raw : {}
  const p: Provider = {
    // providerId=0 → 新建（存储层分配）；name 是对外名，可改。
    providerId: num(o.providerId),
    name: str(o.name),
    // 兼容旧客户端的 enabled 布尔：true→active，false→paused。
    state: (str(o.state) || (o.enabled === false ? 'paused' : 'active')) as Provider['state'],
    displayName: str(o.displayName),
    accessKind: str(o.accessKind) as Provider['accessKind'],
    risk: str(o.risk) as Provider['risk'],
    stability: str(o.stability) as Provider['stability'],
    api: str(o.api), // 空 = 自动探测
    baseUrl: str(o.baseUrl),
    credential: parseCredential(o.credential),
    priority: num(o.priority),
    models: Array.isArray(o.models)
      ? o.models.map(parseModel).filter((m): m is Model => m !== undefined)
      : [],
  }
  if (typeof o.riskNote === 'string') p.riskNote = o.riskNote
  if (typeof o.probeModel === 'string') p.probeModel = o.probeModel
  if (o.streamOnly === true) p.streamOnly = true
  const tags = strArr(o.tags)
  if (tags) p.tags = tags
  if (isObj(o.headers)) {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(o.headers)) {
      if (typeof v === 'string') headers[k] = v
    }
    if (Object.keys(headers).length > 0) p.headers = headers
  }
  if (isObj(o.dynamicHeaders) && typeof o.dynamicHeaders.command === 'string') {
    const d = o.dynamicHeaders
    const spec: DynamicHeadersSpec = { command: o.dynamicHeaders.command }
    const args = strArr(d.args)
    if (args) spec.args = args
    if (typeof d.timeoutMs === 'number') spec.timeoutMs = d.timeoutMs
    const retryOn = strArr(d.retryOn)
    if (retryOn) spec.retryOn = retryOn
    p.dynamicHeaders = spec
  }
  return p
}

function parseDate(v: unknown): Date | undefined {
  return typeof v === 'string' && v !== '' ? new Date(v) : undefined
}

export function parseAccount(raw: unknown): Account {
  const o = isObj(raw) ? raw : {}
  const a: Account = {
    id: str(o.id),
    providerId: num(o.providerId),
    credential: parseCredential(o.credential),
    status: str(o.status) as AccountStatus,
    fails: num(o.fails),
  }
  if (typeof o.displayName === 'string') a.displayName = o.displayName
  if (typeof o.weight === 'number' && Number.isFinite(o.weight) && o.weight > 0) {
    a.weight = Math.floor(o.weight)
  }
  const cooldownUntil = parseDate(o.cooldownUntil)
  if (cooldownUntil) a.cooldownUntil = cooldownUntil
  const lastUsed = parseDate(o.lastUsed)
  if (lastUsed) a.lastUsed = lastUsed
  return a
}
