// 管理面 API 客户端：admin_key 存 localStorage，每次请求带 X-Admin-Key。
const KEY = 'polycode-hub-admin-key'

export function getKey() { return localStorage.getItem(KEY) || '' }
export function setKey(v) { localStorage.setItem(KEY, v) }
export function clearKey() { localStorage.removeItem(KEY) }

export class AuthError extends Error {}

// 主动取消（用户点了「取消识别」）：不是故障，调用方不该弹错误 toast。
export class AbortError extends Error {}

// req：opts.timeoutMs 到点自动中断；opts.signal 允许调用方主动取消。
// 没有超时的 fetch 会一直挂着——探测类接口后端最坏要跑十几分钟，
// 前端按钮就永远停在「…」且无法退出（真实缺陷：识别卡死）。
async function req(method, path, body, opts = {}) {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (opts.signal) {
    if (opts.signal.aborted) throw new AbortError('已取消')
    opts.signal.addEventListener('abort', onAbort, { once: true })
  }
  let timedOut = false
  const timer = opts.timeoutMs
    ? setTimeout(() => { timedOut = true; ctrl.abort() }, opts.timeoutMs)
    : null
  let resp
  try {
    resp = await fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': getKey()
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal
    })
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new AbortError(timedOut ? `请求超时（${Math.round(opts.timeoutMs / 1000)}s）` : '已取消')
    }
    throw e
  } finally {
    if (timer) clearTimeout(timer)
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
  }
  if (resp.status === 401) throw new AuthError('管理口令无效')
  const text = await resp.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!resp.ok) {
    const msg = data && data.error && (data.error.message || data.error.type) || `HTTP ${resp.status}`
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
    err.data = data // 409 冲突等场景需要原始载荷（如 {conflict:{...}}）
    throw err
  }
  return data
}

// 列表端点兼容数组或 {providers:[]}/{accounts:[]} 两种包裹形态
function unwrapList(data, field) {
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data[field])) return data[field]
  return []
}

export const api = {
  stats: () => req('GET', '/admin/api/stats'),
  // 概览页接入区用：{authRequired, defaultModel}。只暴露是否要鉴权，不下发 key 本体。
  gatewayInfo: async () => {
    const data = await req('GET', '/admin/api/gateway')
    return { authRequired: !!(data && data.authRequired), defaultModel: (data && data.defaultModel) || '' }
  },
  // 区间语义（TIME-RANGE-FILTER）：range = {days} 或 {since, until}（YYYY-MM-DD 本地日历日）
  breakdown: (range = {}) => {
    const q = new URLSearchParams()
    if (typeof range === 'number') { q.set('days', String(range)) }
    else {
      if (range.days != null) q.set('days', String(range.days))
      if (range.since) q.set('since', range.since)
      if (range.until) q.set('until', range.until)
      if (range.accountId) q.set('account_id', range.accountId)
    }
    return req('GET', `/admin/api/breakdown?${q}`)
  },
  // 账号维度用量与健康（ACCOUNT-HEALTH）：
  // [{accountId, requests, errors, errorRate, byKind, lastErrorKind, models,...}]
  usageAccounts: async (range = {}) => {
    const q = new URLSearchParams()
    if (range.days != null) q.set('days', String(range.days))
    if (range.since) q.set('since', range.since)
    if (range.until) q.set('until', range.until)
    const data = await req('GET', `/admin/api/usage/accounts?${q}`)
    return (data && data.accounts) || []
  },
  providers: async () => unwrapList(await req('GET', '/admin/api/providers'), 'providers'),
  createProvider: (p) => req('POST', '/admin/api/providers', p),
  // 路径参数是 Provider 的内部 id（数字）；name 可改，id 不变。
  updateProvider: (pid, patch) => req('PATCH', `/admin/api/providers/${encodeURIComponent(pid)}`, patch),
  deleteProvider: (pid) => req('DELETE', `/admin/api/providers/${encodeURIComponent(pid)}`),
  // 彻底清理已删除的 Provider（物理删行）。DELETE 是软删、行会永久留在库里，
  // 这个端点给用户一个真的清干净的出口（代价：历史用量归因退回「未知来源」）。
  purgeProvider: (pid) => req('DELETE', `/admin/api/providers/${encodeURIComponent(pid)}/purge`),
  // 凭证明文按需查看（列表只下发引用，明文走这个显式端点）。
  providerCredential: (pid) => req('GET', `/admin/api/providers/${encodeURIComponent(pid)}/credential`),
  testProvider: (pid) => req('POST', `/admin/api/providers/${encodeURIComponent(pid)}/test`),
  // Zen 指纹刷新：读本机新鲜会话写回静态头（自动续期）；本地无新鲜会话时
  // 返回 {updated:false, next}，需先跑一次客户端再点（长闲置必须重取）。
  // 手动刷新可能读日志+写库，60s 超时兜底（与其他写操作同口径），避免按钮卡死。
  refreshFingerprint: (pid) => req('POST', `/admin/api/providers/${encodeURIComponent(pid)}/refresh-fingerprint`, undefined, { timeoutMs: 60000 }),
  fetchProviderModels: async (pid) => {
    const data = await req('GET', `/admin/api/providers/${encodeURIComponent(pid)}/models`)
    if (Array.isArray(data)) return { models: data, source: '', protocols: {}, caps: {}, free: [] }
    return {
      models: (data && data.models) || [],
      source: (data && data.source) || '',
      protocols: (data && data.protocols) || {},
      caps: (data && data.caps) || {},
      free: (data && data.free) || []
    }
  },
  // 改单个模型的协议（空字符串 = 继承 Provider 默认）
  updateProviderModelProtocol: (pid, modelId, protocol) =>
    req('PUT', `/admin/api/providers/${encodeURIComponent(pid)}/models/${encodeURIComponent(modelId)}/protocol`, { protocol }),
  // 账号权重：PATCH /admin/api/accounts/:id {weight}（正整数，默认 1）
  updateAccountWeight: (id, weight) =>
    req('PATCH', `/admin/api/accounts/${encodeURIComponent(id)}`, { weight }),
  // 改单个模型的出口代理（空字符串 = 继承 Provider 默认）
  updateProviderModelEgress: (pid, modelId, egress) =>
    req('PUT', `/admin/api/providers/${encodeURIComponent(pid)}/models/${encodeURIComponent(modelId)}/egress`, { egress }),
  // 改单个模型的高档位最低预算（只管 xhigh/max；{} = 清掉整张映射）
  updateProviderModelReasoningMinTokens: (pid, modelId, reasoningMinTokens) =>
    req('PUT', `/admin/api/providers/${encodeURIComponent(pid)}/models/${encodeURIComponent(modelId)}/reasoning-min-tokens`, { reasoningMinTokens }),
  // 开关单个模型：对外暴露（/v1/models）、路由、测试候选都以它为准
  updateProviderModelEnabled: (pid, modelId, enabled) =>
    req('PUT', `/admin/api/providers/${encodeURIComponent(pid)}/models/${encodeURIComponent(modelId)}/enabled`, { enabled }),
  // 删单个模型（手填错的/上游下架的）。PATCH models 只增不减，删除只能走这里。
  deleteProviderModel: (pid, modelId) =>
    req('DELETE', `/admin/api/providers/${encodeURIComponent(pid)}/models/${encodeURIComponent(modelId)}`),
  // 模型备注：一句话运维知识（如「23 点后才免费」）。空串 = 清掉。
  updateProviderModelNote: (pid, modelId, note) =>
    req('PUT', `/admin/api/providers/${encodeURIComponent(pid)}/models/${encodeURIComponent(modelId)}/note`, { note }),
  // 出口代理 CRUD（顶层定义，Provider/模型的 egress 引用这里的 id）
  putEgress: (id, kind, addr) =>
    req('PUT', `/admin/api/egresses/${encodeURIComponent(id)}`, { kind, addr }),
  deleteEgress: (id) => req('DELETE', `/admin/api/egresses/${encodeURIComponent(id)}`),
  // 顶层出口定义（config/apps.yaml egresses 落库后的真相源；模型级/Provider 级绑定的下拉数据源）
  egresses: async () => {
    const data = await req('GET', '/admin/api/egresses')
    return (data && data.egresses) || []
  },
  scanProviderModels: async (pid, models, opts = {}) => {
    // 识别/扫描会真的打上游，慢是正常的——给足超时，但要能取消（opts.signal）。
    const data = await req('POST', `/admin/api/providers/${encodeURIComponent(pid)}/scan`,
      { models: models || [] }, { timeoutMs: 120000, ...opts })
    return (data && data.results) || []
  },
  accounts: async () => unwrapList(await req('GET', '/admin/api/accounts'), 'accounts'),
  createAccount: (a) => req('POST', '/admin/api/accounts', a),
  importDiscoveredAccount: (b) => req('POST', '/admin/api/discover/import-account', b),
  sidecarStatus: () => req('GET', '/admin/api/sidecar'),
  sidecarAction: (action) => req('POST', `/admin/api/sidecar/${action}`),
  sidecarUninstall: (query) => req('POST', `/admin/api/sidecar/uninstall${query}`),
  sidecarPort: (port) => req('POST', '/admin/api/sidecar/port', { port }),
  sidecarEndpoint: (body) => req('POST', '/admin/api/sidecar/endpoint', body),
  updateAccount: (id, patch) => req('PATCH', `/admin/api/accounts/${encodeURIComponent(id)}`, patch),
  deleteAccount: (id) => req('DELETE', `/admin/api/accounts/${encodeURIComponent(id)}`),
  // 账号凭证明文按需查看（与 Provider 同口径）。
  accountCredential: (id) => req('GET', `/admin/api/accounts/${encodeURIComponent(id)}/credential`),
  // 账号测试：用该账号凭据打一次真实请求；model 空 = 由后端挑默认模型。
  testAccount: (id, model) => req('POST', `/admin/api/accounts/${encodeURIComponent(id)}/test`, { model: model || '' }),
  // 重置惩罚（零上游成本）：只清连败与冷却，不探活。
  recheckAccount: (id) => req('POST', `/admin/api/accounts/${encodeURIComponent(id)}/recheck`),
  checkinAccount: (id) => req('POST', `/admin/api/accounts/${encodeURIComponent(id)}/checkin`, {}, { timeoutMs: 20000 }),
  // refresh=true 强制实时探测（用户点「重新扫描」）；默认读后端缓存。
  // zen 的联网验证上游固有 2~8 秒（响应头就慢），页面加载时干等体验很差。
  discover: async (refresh = false) => {
    const data = await req('GET', `/admin/api/discover${refresh ? '?refresh=1' : ''}`)
    return Array.isArray(data) ? data : (data && data.findings) || []
  },
  // 一键导入要等后端「采用+入池+模型自动扫描」，慢是正常的，但必须给上限
  // （没超时的 fetch 挂住，按钮永远停在「导入中…」，用户只能刷新页面——provider
  //  其实早已落库，这正是「导入后没显示、刷新才有」的体感来源之一）。60s 足够。
  quickImport: (key) => req('POST', '/admin/api/discover/quick-import', { key }, { timeoutMs: 60000 }),
  adopt: (key, id) => req('POST', '/admin/api/discover/adopt', id ? { key, id } : { key }),
  // —— 本地项目管理器（与代理无关的独立板块） ——
  projects: async () => {
    const data = await req('GET', '/admin/api/projects')
    return (data && data.projects) || []
  },
  createProject: (p) => req('POST', '/admin/api/projects', p),
  updateProject: (id, p) => req('PUT', `/admin/api/projects/${encodeURIComponent(id)}`, p),
  deleteProject: (id) => req('DELETE', `/admin/api/projects/${encodeURIComponent(id)}`),
  projectAction: (id, action) => req('POST', `/admin/api/projects/${encodeURIComponent(id)}/${action}`),
  projectServiceAction: (id, sid, action, body) =>
    req('POST', `/admin/api/projects/${encodeURIComponent(id)}/services/${encodeURIComponent(sid)}/${action}`, body),
  projectLogs: (id, sid, tail = 1000) =>
    req('GET', `/admin/api/projects/${encodeURIComponent(id)}/logs?service=${encodeURIComponent(sid)}&tail=${tail}`),
  clearProjectLogs: (id, sid) =>
    req('DELETE', `/admin/api/projects/${encodeURIComponent(id)}/logs?service=${encodeURIComponent(sid)}`),
  projectReminders: async () => {
    const data = await req('GET', '/admin/api/projects/reminders')
    return (data && data.projects) || []
  },
  // 端口占用查询：{port, busy, owner}
  portOwner: (port) =>
    req('GET', `/admin/api/projects/port-owner?port=${encodeURIComponent(port)}`),
  // 停掉占用端口的外部进程：二次确认由调用方弹窗完成，这里恒带 confirm=true
  killPort: (port) =>
    req('POST', '/admin/api/projects/port-kill', { port, confirm: true }),
  // 在系统中打开目录（Finder/文件管理器）
  openProjectDir: (dir) => req('POST', '/admin/api/projects/open', { dir }),
  // 目录浏览：path 为空=根（win32 返回盘符），返回 {path, parent, dirs[]}
  browseProjectDir: async (path = '') => {
    const q = new URLSearchParams()
    if (path) q.set('path', path)
    return req('GET', `/admin/api/projects/browse?${q}`)
  },
  // README 列表：递归 3 层，返回 {dir, readmes:[{path,size}]}
  projectReadmes: async (dir) => {
    const q = new URLSearchParams()
    q.set('dir', dir)
    return req('GET', `/admin/api/projects/readmes?${q}`)
  },
  // 网关 default_model（AI 录入的模型下拉默认值；空串=没配，前端回落列表首个）
  projectDefaultModel: async () => {
    const data = await req('GET', '/admin/api/projects/default-model')
    return (data && data.model) || ''
  },
  // AI 直填：后端读README拼prompt调网关模型，返回 {json, readmeFound}；失败502前端降级复制。
  // 要等模型生成，给足超时（否则按钮永远停在「填写中…」）。
  aiFillProject: (body, opts = {}) =>
    req('POST', '/admin/api/projects/ai-fill', body, { timeoutMs: 120000, ...opts }),
  // 网关模型目录（AI 直填的模型下拉用）
  gatewayModels: async () => {
    const data = await req('GET', '/v1/models')
    return (data && data.data) || []
  }
}
