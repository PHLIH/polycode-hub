<script setup>
import { ref, computed, onMounted, reactive } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api.js'
import ProviderCard from './ProviderCard.vue'

const list = ref([])
const err = ref('')
const dialog = ref(false)
const editing = ref(null) // null=新建；对象=编辑
const busy = ref(false)

// 正在测试的 Provider id（结果就地显示在卡片里，不再开弹框）
const testing = ref('')
const testRes = ref({}) // providerId → {ok, latencyMs, model, text, error}

// 出口选项：顶层 egresses 定义（管理面可写，见 api.putEgress；config/apps.yaml 只作启动播种）
// + 现有 Provider 在用的引用兜底
const declaredEgresses = ref([])
const egressOptions = computed(() => {
  const seen = new Map()
  for (const e of declaredEgresses.value) seen.set(e.id, e)
  for (const p of list.value) if (p.state !== 'deleted' && p.egress) seen.set(p.egress, { id: p.egress, kind: 'http', addr: '' })
  return [...seen.values()]
})

// 获取模型弹窗
const modelsDlg = ref(false)
const fetching = ref(false)
const fetchErr = ref('')
const fetched = ref([])
const fetchedSource = ref('')
const declaredProtocols = ref({}) // 模型 ID → 上游声明的协议
const declaredCaps = ref({})      // 模型 ID → 上游声明的能力（input/ctx/out）
const freeModels = ref(new Set())  // 免费档模型 ID（命名约定启发式）
const onlyFree = ref(false)        // 只看免费档
const picked = ref([])
const modelsTarget = ref(null)

// exposedModels 是「模型」按钮里勾选的那批模型——唯一的真相源。
// 卡片展示它、测试下拉取它、/v1/models 也只列它：三处必须同一份集合。
// 列表只显示「还在用」的 Provider（active / paused）。
// deleted 是软删标记：行留在库里只为历史用量归因能回溯到 providerId，
// **不是**给用户看的条目。以前不过滤，删掉的那条仍以卡片形式留在页面上，
// 带着开关和删除按钮 —— 用户点完删除看到它还杵在那儿，完全就是"只关了个开关"。
const visibleProviders = computed(() => (list.value || []).filter(p => p.state !== 'deleted'))
// 已删除的行：不在主列表里，但给一个折叠区能看到/清理，否则它们永远堆在库里且用户无感。
const deletedProviders = computed(() => (list.value || []).filter(p => p.state === 'deleted'))
const deletedOpen = ref(false)

// 彻底清理已删记录：物理删掉那一行。
// 代价是它的历史用量归因会退回「未知来源」——所以必须二次确认，且默认不做。
async function purge(p) {
  try {
    await ElMessageBox.confirm(
      `彻底清理已删除的「${p.name}」（#${p.providerId}）？\n\n`
      + `这条记录会从库里物理删除，无法恢复。\n`
      + `代价：它过去的用量记录仍在，但归因会显示为「未知来源」（认不出是哪个 Provider 了）。`,
      '彻底清理', { type: 'warning', confirmButtonText: '彻底清理', dangerouslyUseHTMLString: false })
  } catch { return }
  try {
    await api.purgeProvider(p.providerId)
    ElMessage.success(`已彻底清理 #${p.providerId}`)
    load()
  } catch (e) { ElMessage.error(e.message) }
}

const exposedModels = (p) => (p && p.models ? p.models.filter(m => m.enabled) : [])

const APIS = [
  { v: '', hint: '不确定就选这个：转发时自动逐个试，探到能用的协议就记住（新增外部 API 推荐）' },
  { v: 'anthropic-messages', hint: 'baseURL 不含 /v1，网关拼 /v1/messages' },
  { v: 'openai-completions', hint: 'baseURL 含 /v1，网关拼 chat/completions' },
  { v: 'openai-responses', hint: 'baseURL 含 /v1，网关拼 responses' }
]
const KINDS = [
  { v: 'official', hint: '官方开放 API，凭 key 直连' },
  { v: 'session-reuse', hint: '复用现有客户端登录态（走你的订阅额度）' },
  { v: 'simulated-login', hint: '模拟登录取票，稳定性随上游变化' },
  { v: 'reverse', hint: '第三方反向代理，风险与封号可能由对方承担' }
]
const RISKS = [
  { v: 'low', hint: '官方渠道或明文许可' },
  { v: 'medium', hint: '可能违反上游条款，需写清风险说明' },
  { v: 'high', hint: '明确违规或高封号概率，需写清风险说明' }
]
const STAB = [
  { v: 'stable', hint: '可放心放进默认路由' },
  { v: 'beta', hint: '能跑，接口可能变' },
  { v: 'experimental', hint: '随时可能失效，不建议作为唯一来源' }
]

const form = reactive({
  name: '', displayName: '', api: 'anthropic-messages',
  baseURL: '', accessKind: 'official', risk: 'low', riskNote: '',
  stability: 'stable', credentialEnv: '', state: 'active',
  modelsText: '', streamOnly: false, egress: '',
  // 凭据输入语义（真实缺陷修复）：'key' = 直接粘 API Key 本体，后端落成凭据文件；
  // 'env' = 填环境变量名（老语义）。默认 'key' —— 用户点开这个框就是想填 Key，
  // 而 Key 本体与环境变量名在字符形状上无法区分（atr_xxx 两种都合法），
  // 所以必须由界面显式声明，不能靠后端猜。
  credentialKind: 'key'
})

// 高级选项默认折叠：稳定性/只走流式/手填模型都是配一次就不再动的。
const advOpen = ref(false)

// advSummary：折叠时用一行说明当前值，否则"收起来了"等于"看不见了"。
// 只列非默认值——全默认时说"默认"，比列一排 stable/official/low 更有信息量。
const advSummary = computed(() => {
  const parts = []
  if (form.accessKind !== 'official') parts.push(`接入 ${form.accessKind}`)
  if (form.risk !== 'low') parts.push(`风险 ${form.risk}`)
  if (form.stability !== 'stable') parts.push(form.stability)
  if (form.streamOnly) parts.push('只走流式')
  if (form.egress) parts.push(`出口 ${form.egress}`)
  const n = form.modelsText.split('\n').map(s => s.trim()).filter(Boolean).length
  if (n) parts.push(`手填模型 ${n}`)
  return parts.length ? parts.join(' · ') : '默认'
})

// buildCredential：把「用户填的凭据输入 + 语义」交给后端处理。
//
// 为什么不在这里拼 apiKeyEnv/apiKeyFile：
//   'key' 语义下 Key 要落成凭据文件（0600），写文件、路径收敛、防穿越都在后端做，
//   前端碰不到明文落盘逻辑，也就不会出现"前端猜错语义 → 存成变量名 → 上游 401"。
// 返回 null 表示用户没填（不覆盖已有引用，文件型 Key 不会被空表单清掉）。
function buildCredential() {
  const v = form.credentialEnv.trim()
  return v ? { credentialInput: v, credentialKind: form.credentialKind } : null
}

async function load() {
  try {
    // egresses 单独兜底：出口只是 Provider 的一个可选绑定项，它挂了不该拖垮整页。
    // 以前两者共用一个 Promise.all 且都没 catch，egresses 一次 501/网络错
    // 就让 err 有值 → 整页显示「加载失败」+ 卡片一条不剩，
    // 而 providers 请求其实已经成功了（用户看到的是"Provider 全没了"）。
    ;[list.value, declaredEgresses.value] = await Promise.all([
      api.providers(),
      api.egresses().catch(() => []),
    ])
    err.value = ''
  } catch (e) { err.value = e.message }
}
onMounted(load)

// ---- 一键导入：发现到的 harness 一键「采用 Provider + 账号入池」，不用看文档 ----
const findings = ref([])
const qiBusy = ref('')
const QI_STATUS = { ready: '可采用', expired: '登录态过期', missing: '未安装', unknown: '待确认', unreachable: '不可达' }

async function loadFindings() {
  try { findings.value = await api.discover() } catch { findings.value = [] }
}
onMounted(loadFindings)

// ZCode 本地引擎（sidecar）也进一键面板：没装→一键安装，装了→一键启动
const sc = ref(null)
async function loadSidecar() {
  try { sc.value = await api.sidecarStatus() } catch { sc.value = null }
}
onMounted(loadSidecar)

const scDetail = computed(() => {
  if (!sc.value) return '状态获取失败'
  if (sc.value.running) return `运行于 127.0.0.1:${sc.value.port}，免费 plan 通道经此供给`
  if (sc.value.installed) return '已安装，未运行'
  return '未安装 —— 一键下载官方引擎并生成安全配置（免费 plan 通道）'
})

async function scQuickReady() {
  qiBusy.value = 'sidecar'
  try {
    await api.sidecarAction('ensure') // 装（若缺）→ 配（若缺）→ 起（若停）
    ElMessage.success('ZCode 本地引擎已就绪')
    await Promise.all([loadSidecar(), loadFindings()])
  } catch (e) { ElMessage.error(e.message) } finally { qiBusy.value = '' }
}

async function quickImport(f) {
  qiBusy.value = f.key
  try {
    const r = await api.quickImport(f.key)
    let msg = `Provider ${r.created ? '已创建' : '已存在'}`
    if (r.imported) msg += `，${r.imported} 个账号已入池`
    if (r.skipped) msg += `，${r.skipped} 个已在池中跳过`
    ElMessage.success(`${f.harness}：${msg}`)
    ;(r.warnings || []).forEach(w => ElMessage.warning(w, { duration: 6000 }))
    await Promise.all([load(), loadFindings()])
  } catch (e) { ElMessage.error(e.message) } finally { qiBusy.value = '' }
}

function openCreate() {
  Object.assign(form, {
    name: '', displayName: '', api: '',
    baseURL: '', accessKind: 'official', risk: 'low', riskNote: '',
    stability: 'stable', credentialEnv: '', state: 'active',
    modelsText: '', streamOnly: false, egress: '', credentialKind: 'key'
  })
  advOpen.value = false
  editing.value = null
  dialog.value = true
}

// openEdit：API Key 一栏只回显「引用来源」。
// 文件型引用（一键导入/粘贴 Key 生成的）不回显路径也不提供编辑入口——
// 用户不关心 Key 存在哪个文件，但也不能让它在保存时被悄悄清掉。
// 输入框留空 = 不改凭据；要换 Key 就重新粘一个（语义切回 'key'）。
function openEdit(p) {
  const c = (p && p.credential) || {}
  Object.assign(form, {
    name: p.name, displayName: p.displayName || '', api: p.api,
    baseURL: p.baseUrl, accessKind: p.accessKind, risk: p.risk, riskNote: p.riskNote || '',
    stability: p.stability, credentialEnv: c.apiKeyEnv || '',
    state: p.state === 'active' ? 'active' : 'paused', modelsText: '', streamOnly: !!p.streamOnly,
    egress: p.egress || '', credentialKind: 'key'
  })
  editing.value = p
  advOpen.value = false
  dialog.value = true
}

// usesKeyFile：该 Provider 的 Key 来自文件（一键导入生成的都是这种）。
const usesKeyFile = computed(() =>
  !!(editing.value && editing.value.credential && editing.value.credential.apiKeyFile))

function parseModelsText() {
  return form.modelsText.split('\n').map(s => s.trim()).filter(Boolean)
}

async function save() {
  if (!form.name) { ElMessage.warning('名称必填（小写字母/数字/连字符；它同时是模型 ID 的前缀）'); return }
  if (!form.baseURL) { ElMessage.warning('baseURL 必填'); return }

  if ((form.risk === 'medium' || form.risk === 'high') && !form.riskNote) {
    // 风险栏在折叠区里：只弹 toast 的话，用户看不到该改哪个框。
    // 自动展开高级选项，让出错的字段当场可见。
    advOpen.value = true
    ElMessage.warning('中/高风险必须填写风险说明（riskNote），使用者要在界面上看到')
    return
  }
  busy.value = true
  try {
    const cred = buildCredential()
    if (editing.value) {
      const patch = {
        // 改名与换 baseUrl 都走 PATCH（providerId 不变，引用不断）
        name: form.name, baseUrl: form.baseURL,
        displayName: form.displayName, state: form.state,
        riskNote: form.riskNote, streamOnly: form.streamOnly,
        stability: form.stability, accessKind: form.accessKind, risk: form.risk,
        api: form.api,
      }
      const extra = parseModelsText()
      if (extra.length) patch.models = extra
      // 只有用户确实填了才写回凭据。留空 = 不动原有引用：
      // 文件型引用（一键导入生成的）不能被空表单覆盖掉。
      // cred 带的是 {credentialInput, credentialKind}，由后端按语义落文件/存变量名。
      if (cred) Object.assign(patch, cred)
      await api.updateProvider(editing.value.providerId, patch)
    } else {
      await api.createProvider({
        name: form.name, displayName: form.displayName,
        api: form.api, baseUrl: form.baseURL, accessKind: form.accessKind,
        risk: form.risk, riskNote: form.riskNote, stability: form.stability,
        credential: {},
        egress: form.egress || '',
        state: form.state,
        models: parseModelsText().map(id => ({ id, enabled: true })),
        ...(cred || {})
      })
    }
    dialog.value = false
    ElMessage.success('已保存')
    load()
  } catch (e) {
    ElMessage.error(e.message)
  } finally { busy.value = false }
}

// 测试：结果就地落到卡片上（弹框换成了卡片内的一条结果条）
async function test(p) {
  testing.value = p.providerId
  try {
    testRes.value = { ...testRes.value, [p.providerId]: await api.testProvider(p.providerId) }
  } catch (e) {
    testRes.value = { ...testRes.value, [p.providerId]: { ok: false, error: e.message } }
  } finally {
    testing.value = ''
  }
}

async function remove(p) {
  try {
    await ElMessageBox.confirm(
      `删除 Provider「${p.name}」（#${p.providerId}）？\n\n`
      + `· 它将立刻从列表和路由里消失，用 ${p.name}/xxx 调用的客户端会收到明确报错\n`
      + `· 历史用量归因会保留（仍能看到它过去用掉多少），所以库里会留一条 deleted 记录\n`
      + `· 名字被释放，可以再建一个同名 Provider（会拿到新的 #id）\n\n`
      + `这条已删记录可在页面底部「已删除」区查看和彻底清理。`,
      '确认删除', { type: 'warning', dangerouslyUseHTMLString: false })
  } catch { return }
  try {
    await api.deleteProvider(p.providerId)
    ElMessage.success(`已删除「${p.name}」（历史用量归因保留）`)
    load()
  }
  catch (e) { ElMessage.error(e.message) }
}

function apiHint(v) {
  const h = APIS.find(a => a.v === (v || '')) || KINDS.find(k => k.v === v)
    || RISKS.find(r => r.v === v) || STAB.find(s => s.v === v)
  return h ? h.hint : ''
}

// 协议显示名：空值 = 自动识别（新增 Provider 的推荐选项）
// 括号里是拼在 baseURL 后面的操作路径（requestPath，见 server/src/ir/codec.ts 约定）。
function apiLabel(v) {
  if (!v) return '自动识别（推荐）'
  if (v === 'anthropic-messages') return 'anthropic-messages（+ /v1/messages）'
  if (v === 'openai-completions') return 'openai-completions（+ chat/completions）'
  if (v === 'openai-responses') return 'openai-responses（+ responses）'
  return v
}

// Clash 出口快捷配置：本地场景基本只需要一个 Clash 混合端口
const clashDlg = ref(false)
const clashPort = ref('7897')
const clashBusy = ref(false)
const hasClash = computed(() => declaredEgresses.value.some(e => e.id === 'clash'))

// clashAddr：顶部入口按钮旁的 chip 常驻显示当前生效的出口地址——配置结果不该只在弹框里可见。
const clashAddr = computed(() => {
  const e = declaredEgresses.value.find(x => x.id === 'clash')
  return e ? e.addr : ''
})

// clashPortOf：状态 chip 只展示端口（地址太长，头部放不下整串）。
function clashPortOf(addr) {
  return (addr || '').split(':').pop() || ''
}

// modelsUsingClash：有多少个模型真的把流量切到了 clash。
// 底部状态条已删（与顶部入口重复），这个数字改在弹框引导里说——配置完知道有没有生效。
const modelsUsingClash = computed(() => {
  let n = 0
  for (const p of list.value) {
    for (const m of (p.models || [])) if (m.egress === 'clash') n++
  }
  return n
})

function openClash() {
  const cur = declaredEgresses.value.find(e => e.id === 'clash')
  clashPort.value = cur ? (cur.addr.split(':').pop() || '7897') : '7897'
  clashDlg.value = true
}

async function saveClash() {
  const port = Number(clashPort.value)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    ElMessage.warning('端口必须是 1–65535 的数字'); return
  }
  clashBusy.value = true
  try {
    await api.putEgress('clash', 'http', `127.0.0.1:${port}`)
    ElMessage.success(`clash 出口已保存：127.0.0.1:${port}（即时生效）`)
    clashDlg.value = false
    await load()
  } catch (e) { ElMessage.error(e.message) } finally { clashBusy.value = false }
}

async function removeClash() {
  clashBusy.value = true
  try {
    await api.deleteEgress('clash')
    ElMessage.success('clash 出口已删除，引用它的模型/Provider 回到直连')
    clashDlg.value = false
    await load()
  } catch (e) { ElMessage.error(e.message) } finally { clashBusy.value = false }
}

// refreshTarget 从服务端取该 Provider 的最新状态（含扫描写回的模型协议），
// 使弹窗展示已知协议而不是「继承默认」。
async function refreshTarget(id) {
  try {
    const fresh = await api.providers()
    const found = (fresh || []).find(x => x.providerId === id)
    if (!found) return
    modelsTarget.value = found
    // 就地更新列表里那一行：换掉对象即可（key 稳定，卡片展开态不丢）
    const i = list.value.findIndex(x => x.providerId === id)
    if (i >= 0) list.value.splice(i, 1, found)
  } catch { /* 拉不到就用旧快照 */ }
}

async function openModels(p) {
  modelsTarget.value = p
  fetched.value = []
  picked.value = []
  fetchErr.value = ''
  fetching.value = true
  modelsDlg.value = true
  try {
    // 先取最新 Provider：协议可能已被扫描探到并写回，用旧快照会显示成「继承默认」。
    await refreshTarget(p.providerId)
    const res = await api.fetchProviderModels(p.providerId)
    const ids = res.models || []
    fetched.value = ids
    fetchedSource.value = res.source || ''
    declaredProtocols.value = res.protocols || {}
    declaredCaps.value = res.caps || {}
    freeModels.value = new Set(res.free || [])
    // 勾选态 = 该 Provider 当前已暴露的模型。绝不预勾未采用的模型：
    // 打开弹框就自动勾一堆，再点「保存」会把这些全部对外暴露。
    picked.value = exposedModels(p).map(m => m.id)
    if (!ids.length) fetchErr.value = '上游返回空列表，请手填模型。'
  } catch (e) {
    fetchErr.value = e.message
  } finally {
    fetching.value = false
  }
}

const handModels = ref('')
const handOpen = ref(false)

// freeHint：解释「免费」标记的来源与局限：
// 上游不在列表里标价格，只能按命名约定（-free / contributor / trial）启发式判断；
// 复用登录态的源（workbuddy/zcode）整体走的是你的订阅额度，命名里自然没有 free 字样。
const freeHint = computed(() => {
  if (freeModels.value.size > 0) {
    return '「免费」按模型命名约定（-free / contributor / trial）自动识别，上游不提供价格字段；勾选框可自行调整。'
  }
  const k = modelsTarget.value && modelsTarget.value.accessKind
  if (k === 'session-reuse') {
    return '该源复用你的登录态额度，模型名里不带 free 标记，因此这里不标注免费；可用性请以扫描结果为准。'
  }
  return '本次列表里没有命名带 free/contributor/trial 的模型；可用性请以扫描结果为准。'
})

// sourceHint：说明模型列表从哪来，让「这是自动发现的还是配置里的」一目了然。
const sourceHint = computed(() => {
  const n = fetched.value.length
  switch (fetchedSource.value) {
    case 'upstream':
      return `刚从 ${modelsTarget.value.baseUrl}/models 实时拉取（${n} 个），不是写死的。`
    case 'client-trace':
      return `从本机客户端痕迹自动发现（${n} 个）：客户端实际用过的模型，上游无列表接口。`
    case 'client-trace+local-config':
      return `痕迹发现 + 本地配置合并（${n} 个）：痕迹自动跟上新模型，配置兜底。`
    default:
      return `本地配置中获取（${n} 个，上游无列表接口）。`
  }
})

const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']

// visibleModels 按「只看免费」开关 + 搜索关键字过滤
const modelQ = ref('')
const visibleModels = computed(() => {
  let ids = fetched.value
  if (onlyFree.value) ids = ids.filter(id => freeModels.value.has(id))
  const kw = modelQ.value.trim().toLowerCase()
  if (kw) ids = ids.filter(id => id.toLowerCase().includes(kw))
  return ids
})

function isFree(id) { return freeModels.value.has(id) }

// ctxLabel：上下文长度展示（来源=上游声明 caps 或本地配置 models[]）
function capsOf(id) {
  const c = declaredCaps.value[id]
  if (c && c.input && c.input.length) return c
  const m = (modelsTarget.value && modelsTarget.value.models || []).find(x => x.id === id)
  if (m && m.input && m.input.length) return { input: m.input, contextWindow: m.contextWindow }
  return null
}
function ctxLabel(id) {
  const c = capsOf(id)
  if (!c || !c.contextWindow) return ''
  const n = c.contextWindow
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + 'M ctx'
  if (n >= 1000) return Math.round(n / 1000) + 'k ctx'
  return n + ' ctx'
}

async function appendHandModels() {
  // 每行一个 ID，可选 ":协议" 后缀（如 glm-5.3-flash:openai-responses）。
  // 不带协议的交给扫描自动识别。
  const entries = handModels.value.split('\n').map(s => s.trim()).filter(Boolean).map(line => {
    const i = line.lastIndexOf(':')
    if (i > 0 && PROTOCOLS.includes(line.slice(i + 1))) {
      return { id: line.slice(0, i).trim(), protocol: line.slice(i + 1) }
    }
    return { id: line }
  }).filter(e => e.id)
  if (!entries.length) { ElMessage.warning('先每行写一个模型 ID'); return }
  try {
    await api.updateProvider(modelsTarget.value.providerId, { models: entries })
    ElMessage.success(`已追加 ${entries.length} 个模型`)
    handModels.value = ''
    await refreshTarget(modelsTarget.value.providerId)
    const res = await api.fetchProviderModels(modelsTarget.value.providerId)
    fetched.value = res.models || []
    declaredProtocols.value = res.protocols || {}
    // 手填追加后同样只勾「已暴露的」，不预勾新加的
    picked.value = exposedModels(modelsTarget.value).map(m => m.id)
    load()
  } catch (e) { ElMessage.error(e.message) }
}

async function adoptModels() {
  const target = modelsTarget.value
  if (!target) return
  try {
    // 勾选态就是要暴露的集合：先按勾选写 enabled，再补上游声明的新模型。
    // 后端 PATCH models 只增不减，所以「取消勾选」必须显式调 enabled 接口关掉，
    // 否则取消勾选后模型仍在对外暴露（用户以为去掉的其实还在）。
    const before = exposedModels(target)
    const want = new Set(picked.value)
    const toOff = before.filter(m => !want.has(m.id))
    const toOn = (target.models || []).filter(m => want.has(m.id) && !m.enabled)
    for (const m of toOff) await api.updateProviderModelEnabled(target.providerId, m.id, false)
    for (const m of toOn) await api.updateProviderModelEnabled(target.providerId, m.id, true)

    // 勾选里还没采用的（上游新模型）走 PATCH models 追加，顺带写入声明的协议/能力
    const known = new Set((target.models || []).map(m => m.id))
    const fresh = picked.value.filter(id => !known.has(id))
    if (fresh.length) {
      const models = fresh.map(id => ({
        id, protocol: declaredProtocols.value[id] || '', caps: declaredCaps.value[id] || null
      }))
      await api.updateProvider(target.providerId, { models })
    }

    const n = picked.value.length
    const offN = toOff.length
    ElMessage.success(offN ? `已保存：暴露 ${n} 个（关闭 ${offN} 个）` : `已保存：暴露 ${n} 个模型`)
    modelsDlg.value = false
    await load()
  } catch (e) { ElMessage.error(e.message) }
}
</script>

<template>
  <!-- 出口代理：全页只有顶部这一个入口。配置结果直接写在按钮上，
       底部不再重复一条状态条——同一件事画两遍会被读成两条通道。 -->
  <header class="page-head">
    <div class="head-left">
      <h2>Provider</h2>
      <p class="sub">每一路是一条上游通道。点左侧箭头展开，看它对外暴露了哪些模型。</p>
    </div>
    <div class="head-right">
      <span v-if="hasClash" class="eg-chip" :title="`clash 出口：http://${clashAddr}`">
        <span class="dot ok" />
        <span class="mono">clash</span>
        <span class="mono dim">:{{ clashPortOf(clashAddr) }}</span>
      </span>
      <button class="btn ghost" @click="openClash">{{ hasClash ? '出口代理' : '配置 Clash 出口' }}</button>
      <button class="btn" @click="openCreate">添加外部 API</button>
    </div>
  </header>

  <p v-if="err" class="err">加载失败：{{ err }}</p>

  <section class="qi">
    <div class="panel-head">
      <h3>一键导入</h3>
      <span class="dim qi-sub">点一下就完成采用 + 账号入池，不用看文档</span>
    </div>
    <p v-if="!findings.length" class="dim qi-none">本机没有发现可导入的 harness（装过并登录过的才会出现在这里）。</p>
    <div v-else class="qi-list">
      <div class="qi-row">
        <span class="dot" :class="sc && sc.running ? 'ok' : ''" />
        <span class="qi-name">ZCode 本地引擎</span>
        <span class="dim qi-detail">{{ scDetail }}</span>
        <span class="qi-action">
          <span v-if="sc && sc.running" class="status-chip ok"><span class="dot ok" />运行中</span>
          <button v-else class="btn" :disabled="qiBusy === 'sidecar'" @click="scQuickReady">
            {{ qiBusy === 'sidecar' ? '安装中…（首次需下载）' : (sc && sc.installed ? '一键启动' : '一键安装') }}</button>
        </span>
      </div>
      <div v-for="f in findings" :key="f.key" class="qi-row">
        <span class="dot" :class="f.adoptedProviderId ? 'ok' : (f.status === 'ready' ? '' : 'warn')" />
        <span class="qi-name">{{ f.harness }}</span>
        <span class="dim qi-detail">{{ f.detail || QI_STATUS[f.status] || f.status }}</span>
        <span class="qi-action">
          <span v-if="f.adoptedProviderId" class="status-chip ok"><span class="dot ok" />已导入</span>
          <button v-else-if="f.status === 'ready'" class="btn" :disabled="qiBusy === f.key" @click="quickImport(f)">
            {{ qiBusy === f.key ? '导入中…' : '一键导入' }}</button>
          <span v-else class="dim qi-hint">{{ QI_STATUS[f.status] || f.status }}{{ f.actions && f.actions.length ? '：' + f.actions[0] : '' }}</span>
        </span>
      </div>
    </div>
  </section>

  <div v-if="!visibleProviders.length && !err" class="empty">
    <p class="empty-title">还没有 Provider</p>
    <p class="empty-body">先从上面的一键导入拿本机已登录的 harness，或者手动添加一家外部 API。</p>
    <button class="btn" @click="openCreate">添加外部 API</button>
  </div>

  <ProviderCard v-for="p in visibleProviders" :key="p.providerId" :p="p" :egresses="egressOptions"
    :testing="testing === p.providerId" :test-res="testRes[p.providerId]"
    @test="test" @reload="load" @models="openModels" @edit="openEdit" @remove="remove" />

  <!-- 已删除：软删的行不在主列表里，但会永久留在库中（历史用量靠 providerId 回溯）。
       给一个折叠区让用户看得到、也能真的清掉——否则它们只增不减且完全不可见。 -->
  <section v-if="deletedProviders.length" class="deleted-zone">
    <button class="deleted-head" @click="deletedOpen = !deletedOpen">
      <span class="caret-tri" :class="{ open: deletedOpen }" aria-hidden="true" />
      已删除 {{ deletedProviders.length }} 个（历史用量归因仍在保留）
    </button>
    <div v-if="deletedOpen" class="deleted-body">
      <p class="dim deleted-hint">
        这些记录已不再参与路由。保留它们只为让历史用量能认出是谁用掉的；
        彻底清理后那批用量的来源会显示为「未知来源」。
      </p>
      <div v-for="p in deletedProviders" :key="p.providerId" class="deleted-row">
        <span class="mono pid">#{{ p.providerId }}</span>
        <span class="deleted-name">{{ p.name }}</span>
        <span class="dim">{{ (p.models || []).length }} 个模型</span>
        <span class="grow" />
        <button class="act danger" @click="purge(p)">彻底清理</button>
      </div>
    </div>
  </section>

  <el-dialog v-model="clashDlg" title="Clash 出口" width="480px">
    <el-form label-width="90px">
      <el-form-item label="混合端口">
        <el-input v-model="clashPort" class="num" placeholder="7897" style="width:160px" />
        <div class="field-hint">Clash / Clash Verge 的 HTTP 混合代理端口，默认 7897（Clash「设置 → 端口」里能看到）。</div>
      </el-form-item>
    </el-form>
    <div class="clash-guide">
      <p>保存后定义一个名为 <span class="mono">clash</span> 的出口（http://127.0.0.1:端口），立即生效。</p>
      <p>然后到该 Provider 的「模型」里，把被地域锁的模型（如 muse-spark）的出口切到 <span class="mono">clash</span> —— 只有它走代理，同 Provider 其它模型保持直连。别把整个 Provider 都绑上去。</p>
      <p v-if="hasClash">
        当前 <span class="mono">{{ clashAddr }}</span>：
        <template v-if="modelsUsingClash">已有 {{ modelsUsingClash }} 个模型走此代理，其余直连。</template>
        <template v-else>尚无模型绑定它，全部直连。</template>
      </p>
    </div>
    <template #footer>
      <button v-if="hasClash" class="btn ghost danger" @click="removeClash">删除出口</button>
      <button class="btn ghost" @click="clashDlg = false">取消</button>
      <button class="btn" :disabled="clashBusy" @click="saveClash">保存</button>
    </template>
  </el-dialog>

  <el-dialog v-model="dialog" :title="editing ? '编辑 Provider' : '添加外部 API'" width="560px">
    <el-form label-width="110px">
      <el-form-item label="ID">
        <el-input v-model="form.name" placeholder="如 acme-vllm（模型 ID 前缀：acme-vllm/xxx）" />
        <div class="field-hint">
          对外名——模型 ID 的前缀（<span class="mono">{{ form.name || 'name' }}/模型</span>）、账号归属、发现页判重都用它。
          <template v-if="editing">可以改；改名后旧前缀立即失效，接口会给出明确报错。</template>
        </div>
      </el-form-item>
      <el-form-item label="显示名"><el-input v-model="form.displayName" /></el-form-item>
      <el-form-item label="协议">
        <el-select v-model="form.api" style="width:100%">
          <el-option v-for="a in APIS" :key="a.v || 'auto'" :value="a.v" :label="apiLabel(a.v)" />
        </el-select>
        <div class="field-hint">{{ apiHint(form.api) }}</div>
      </el-form-item>
      <el-form-item label="Base URL">
        <el-input v-model="form.baseURL" class="mono" placeholder="上游 API 根地址，停在操作路径之前" />
        <div class="field-hint">如 https://api.acme.com/v1 —— 不带 /chat/completions、/messages 这类操作路径。</div>
      </el-form-item>
      <el-form-item label="API Key">
        <!-- 真实缺陷修复：以前这里只接受「环境变量名」，但用户看到「API Key」就是粘 Key，
             粘完存成 apiKeyEnv → 网关当变量名找不到 → 上游 401，报错还说「环境变量未设置」。
             Key 本体与变量名在字符形状上无法区分，所以由用户显式选语义，不靠猜。 -->
        <el-radio-group v-model="form.credentialKind" size="small" class="cred-kind">
          <el-radio-button value="key">直接填 Key</el-radio-button>
          <el-radio-button value="env">用环境变量</el-radio-button>
        </el-radio-group>
        <el-input v-model="form.credentialEnv" class="mono" type="password" show-password
          :placeholder="form.credentialKind === 'key'
            ? '粘贴 API Key，如 sk-xxx / atr_xxx（保存后落到 config/credentials/）'
            : '环境变量名，如 ACME_API_KEY'" />
        <div class="field-hint">
          <template v-if="form.credentialKind === 'key'">
            粘进来即可用：保存后写入 <span class="mono">config/credentials/</span>（0600），
            密钥不落数据库、不在列表回显。留空 = 不改动现有凭据。
          </template>
          <template v-else">
            只存引用不存明文：网关每次请求现读该环境变量（改值需重启网关）。
            留空 = 不改动现有凭据。
          </template>
        </div>
        <div v-if="usesKeyFile" class="keyfile-note">
          当前 Key 由密钥文件提供（<span class="mono">{{ editing.credential.apiKeyFile }}</span>）。
          留空即保持不变；重新粘贴一个 Key 或改填环境变量名则以本次为准。
        </div>
      </el-form-item>

      <!-- 高级选项：配一次基本不再动。默认折叠，新增时不必面对一排「不知道填什么」的框。 -->
      <div class="adv">
        <button type="button" class="adv-toggle" @click="advOpen = !advOpen">
          <span class="caret-tri small" :class="{ open: advOpen }" />高级选项
          <span class="dim adv-sum">{{ advSummary }}</span>
        </button>
        <div v-show="advOpen" class="adv-body">
          <el-form-item label="接入方式">
            <el-select v-model="form.accessKind" style="width:100%">
              <el-option v-for="k in KINDS" :key="k.v" :value="k.v" :label="k.v" />
            </el-select>
            <div class="field-hint">{{ apiHint(form.accessKind) }}</div>
          </el-form-item>
          <el-form-item label="风险">
            <el-select v-model="form.risk" style="width:120px">
              <el-option v-for="r in RISKS" :key="r.v" :value="r.v" :label="r.v" />
            </el-select>
            <el-input v-model="form.riskNote" placeholder="风险说明（中/高风险必填，界面上可见）" style="flex:1" />
            <div class="field-hint">{{ apiHint(form.risk) }}</div>
          </el-form-item>
          <el-form-item label="稳定性">
            <el-select v-model="form.stability" style="width:160px">
              <el-option v-for="s in STAB" :key="s.v" :value="s.v" :label="s.v" />
            </el-select>
            <div class="field-hint">{{ apiHint(form.stability) }}</div>
          </el-form-item>
          <el-form-item label="只走流式">
            <el-switch v-model="form.streamOnly" />
            <div class="field-hint">上游不支持非流式时勾上（如 WorkBuddy 报 11101/404），调度会跳过非流式请求，不再白撞一次。</div>
          </el-form-item>
          <el-form-item label="模型">
            <el-input v-model="form.modelsText" type="textarea" :rows="3"
              :placeholder="editing ? '追加模型 ID（每行一个，已有不受影响）' : '模型 ID（每行一个）'" />
            <div class="field-hint">日常用「模型」按钮从上游目录勾选；这里是手填兜底（上游没有列表接口时）。</div>
          </el-form-item>
          <el-form-item label="出口代理">
            <el-select v-model="form.egress" clearable placeholder="直连（默认）" style="width:100%">
              <el-option v-for="e in egressOptions" :key="e.id" :label="`${e.id}（${e.kind}://${e.addr}）`" :value="e.id" />
            </el-select>
            <div class="dim field-hint">被地域锁的模型走代理出口；其余 Provider 保持直连。细粒度到模型可在展开行的下拉里调。</div>
          </el-form-item>
        </div>
      </div>

      <el-form-item label="启用">
        <el-switch :model-value="form.state === 'active'"
          @update:model-value="v => form.state = v ? 'active' : 'paused'" />
      </el-form-item>
    </el-form>
    <template #footer>
      <button class="btn ghost" @click="dialog = false">取消</button>
      <button class="btn" :disabled="busy" @click="save">保存</button>
    </template>
  </el-dialog>

  <el-dialog v-model="modelsDlg" width="760px" class="models-dlg" :show-close="false">
    <template #header>
      <div class="md-head">
        <span class="md-title">模型</span>
        <span class="mono md-target">{{ modelsTarget ? modelsTarget.name : '' }}</span>
        <button class="md-close" @click="modelsDlg = false" aria-label="关闭">✕</button>
      </div>
    </template>

    <p v-if="fetching" class="dim md-note">正在问上游要模型列表…</p>

    <div v-else-if="fetchErr" class="md-note">
      <p class="err">{{ fetchErr }}</p>
      <p class="dim sub">拉不到列表也能用手填兜底（每行一个，追加已有不受影响）：</p>
      <el-input v-model="handModels" type="textarea" :rows="3" placeholder="每行一个模型 ID" />
      <div class="hand-actions"><button class="btn" @click="appendHandModels">追加手填</button></div>
    </div>

    <template v-else>
      <p class="md-source">{{ sourceHint }}　<span class="free-dot" />免费 <span class="mono">{{ freeModels.size }}</span></p>

      <div class="md-toolbar">
        <input v-model="modelQ" class="md-search mono" placeholder="过滤模型 ID…">
        <button class="md-tool" @click="picked = [...visibleModels]">全选{{ onlyFree ? '免费' : '' }}</button>
        <button class="md-tool" @click="picked = []">清空</button>
        <button class="md-tool" :class="{ on: onlyFree }" @click="onlyFree = !onlyFree">免费</button>
      </div>

      <!-- 这里只做勾选。协议/出口/识别在卡片展开行里操作（已勾选的模型才需要）。 -->
      <div class="md-list">
        <label v-for="id in visibleModels" :key="id" class="md-row" :class="{ picked: picked.includes(id) }">
          <input type="checkbox" :value="id" v-model="picked" class="md-check">
          <span class="mono md-id">{{ id }}</span>
          <span class="md-tags">
            <span v-if="isFree(id)" class="md-tag free" title="命名含 free/contributor/trial">免费</span>
            <span v-if="ctxLabel(id)" class="md-tag ctx" :title="'上下文 ' + ctxLabel(id)">{{ ctxLabel(id) }}</span>
          </span>
        </label>
        <p v-if="!visibleModels.length" class="dim md-note">没有匹配的模型。</p>
      </div>

      <p class="md-foot-note">{{ freeHint }}勾选即对外暴露；协议与出口展开该 Provider 后调整。</p>

      <div class="hand-block">
        <button class="hand-toggle" @click="handOpen = !handOpen">
          <span class="caret-tri small" :class="{ open: handOpen }" />手动填写模型
        </button>
        <div v-if="handOpen" class="hand-body">
          <el-input v-model="handModels" type="textarea" :rows="3"
            placeholder="每行一个模型 ID，如 hy4-preview&#10;可带协议：glm-5.3-flash:openai-responses" />
          <div class="hand-actions">
            <button class="btn" @click="appendHandModels">追加手填</button>
            <span class="dim">追加后请在列表里勾选，才会对外暴露</span>
          </div>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="md-footer">
        <span class="md-picked">已选 <span class="mono">{{ picked.length }}</span> 个</span>
        <div class="md-actions">
          <button class="btn ghost" @click="modelsDlg = false">取消</button>
          <button v-if="!fetchErr" class="btn" @click="adoptModels">保存（暴露 {{ picked.length }} 个）</button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.page-head { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 14px; }
.page-head h2 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
.sub { color: var(--dim); margin: 0; font-size: 12px; }
.head-right { margin-left: auto; display: flex; gap: 8px; flex: none; }
.btn {
  background: var(--accent); color: #0b1119; border: 0; border-radius: var(--r-ctl);
  padding: 7px 15px; font-size: 13px; font-weight: 600; cursor: pointer;
}
.btn.ghost { background: transparent; color: var(--dim); border: 1px solid var(--line); font-weight: 400; }
.btn.ghost:hover { color: var(--text); border-color: var(--dim); }
.btn.ghost.danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
.btn.ghost.danger:hover { border-color: var(--bad); }
.btn:disabled { opacity: .5; cursor: default; }
.dim { color: var(--dim); }
.err { color: var(--bad); font-size: 12px; }
.mono { font-family: var(--mono); }

/* ---- 一键导入 ---- */
.qi { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-box); padding: 14px 16px; margin-bottom: 16px; }
.panel-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px; }
.panel-head h3 { margin: 0; font-size: 13px; font-weight: 600; }
.qi-sub, .qi-none { font-size: 12px; }
.qi-none { margin: 0; }
.qi-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--line); }
.qi-row:first-child { border-top: 0; }
.qi-name { font-weight: 600; flex: none; font-size: 13px; }
.qi-detail { font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qi-action { flex: none; display: flex; align-items: center; gap: 8px; }
.qi-hint { font-size: 12px; }
.status-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dim); }
.status-chip .dot { margin-right: 0; }
.field-hint { color: var(--dim); font-size: 11px; line-height: 1.5; padding-top: 2px; }

/* ---- 高级选项：默认折叠，按钮本身就是那一行的标题 ---- */
.adv { margin: 2px 0 14px; padding-top: 12px; border-top: 1px solid var(--line); }
.adv-toggle {
  display: flex; align-items: center; gap: 8px; width: 100%;
  border: 0; background: none; color: var(--text); cursor: pointer;
  font-size: 12.5px; font-weight: 600; padding: 2px 0; text-align: left;
}
.adv-toggle:hover { color: var(--accent); }
.adv-sum { font-weight: 400; font-size: 11.5px; margin-left: auto; }
.adv-body { padding-top: 10px; }
.adv-body :deep(.el-form-item:last-child) { margin-bottom: 0; }
.keyfile-note {
  font-size: 11px; line-height: 1.5; padding-top: 6px; color: var(--accent);
}
.keyfile-note .mono { overflow-wrap: anywhere; }
/* API Key 的语义二选一：先选「填 Key 还是填变量名」，再填内容。
   以前只有一个框、语义写在小字提示里，用户粘了 Key 却被当成变量名（真实缺陷）。 */
.cred-kind { margin-bottom: 8px; }
.cred-kind :deep(.el-radio-button__inner) { font-size: 12px; padding: 5px 14px; }

.empty { border: 1px dashed var(--line); border-radius: var(--r-box); padding: 28px 20px; text-align: center; margin-bottom: 16px; }
.empty-title { margin: 0 0 6px; font-size: 14px; font-weight: 600; }
.empty-body { margin: 0 0 14px; font-size: 12px; color: var(--dim); }

/* 已删除区：软删行不在主列表里，但得让用户看得到、能清理（否则只增不减且不可见） */
.deleted-zone { margin-top: 18px; border-top: 1px solid var(--line); padding-top: 12px; }
.deleted-head {
  display: flex; align-items: center; gap: 6px; background: none; border: 0; cursor: pointer;
  color: var(--dim); font-size: 12px; padding: 4px 0;
}
.deleted-head:hover { color: var(--text); }
.deleted-body { margin-top: 6px; }
.deleted-hint { font-size: 12px; margin: 0 0 10px; }
.deleted-row {
  display: flex; align-items: center; gap: 10px; padding: 7px 10px;
  border: 1px solid var(--line); border-radius: var(--r-ctl); margin-bottom: 6px;
  font-size: 12px; opacity: .75;
}
.deleted-row .grow { flex: 1; }
.deleted-name { color: var(--text); font-weight: 600; }

/* ---- 出口代理状态 chip（挂在顶部入口按钮旁，全页唯一一处） ---- */
.eg-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 4px 10px; font-size: 12px;
  border: 1px solid color-mix(in srgb, var(--ok) 35%, var(--line));
  border-radius: var(--r-chip); background: color-mix(in srgb, var(--ok) 8%, transparent);
}
.eg-chip .dot { margin-right: 0; }

/* ---- 获取模型弹窗 ---- */
.md-head { display: flex; align-items: baseline; gap: 10px; }
.md-title { font-size: 15px; font-weight: 600; }
.md-target { font-size: 12px; color: var(--accent); }
.md-close { margin-left: auto; border: 0; background: none; color: var(--dim); cursor: pointer; font-size: 14px; }
.md-close:hover { color: var(--text); }
.md-source { margin: 0 0 10px; font-size: 12px; color: var(--dim); }
.free-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); margin: 0 2px 0 6px; }
.md-toolbar { display: flex; gap: 6px; margin-bottom: 8px; align-items: center; }
.md-search {
  flex: 1; background: var(--bg); border: 1px solid var(--line);
  color: var(--text); font-size: 12px; padding: 5px 8px;
}
.md-search:focus { outline: none; border-color: var(--accent); }
.md-tool {
  border: 1px solid var(--line); background: none; color: var(--dim); border-radius: var(--r-ctl);
  padding: 5px 10px; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.md-tool:hover { color: var(--text); border-color: var(--dim); }
.md-tool.on { color: var(--accent); border-color: var(--accent); }
.md-list { max-height: 52vh; overflow-y: auto; border: 1px solid var(--line); border-radius: var(--r-ctl); background: var(--bg); }
/* 网格而非 flex：模型名定宽成列，标记（免费/上下文）右对齐成列 */
.md-row {
  display: grid; grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: center; gap: 12px; padding: 9px 14px;
  border-left: 2px solid transparent; cursor: pointer; font-size: 12.5px;
  border-bottom: 1px solid color-mix(in srgb, var(--line) 40%, transparent);
}
.md-row:last-child { border-bottom: 0; }
.md-row:hover { background: var(--panel); }
.md-row.picked { border-left-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, var(--bg)); }
.md-check { accent-color: var(--accent); margin: 0; width: 15px; height: 15px; }
.md-id { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.md-tags { display: flex; gap: 6px; align-items: center; flex: none; }
.md-tag { flex: none; font-size: 10px; padding: 1px 7px; border-radius: var(--r-chip); border: 1px solid var(--line); color: var(--dim); white-space: nowrap; }
.md-tag.free { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); }
.md-note { font-size: 11.5px; margin: 8px 0; }
.md-foot-note { font-size: 11.5px; color: var(--dim); margin: 10px 0 0; line-height: 1.6; }
.hand-block { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); }
.hand-toggle {
  display: inline-flex; align-items: center; gap: 8px; border: 0; background: none;
  color: var(--dim); font-size: 12px; cursor: pointer; padding: 2px 0;
}
.hand-toggle:hover { color: var(--text); }
/* CSS 画的展开箭头，不依赖字体字形 */
.caret-tri {
  width: 0; height: 0; border-top: 4px solid transparent; border-bottom: 4px solid transparent;
  border-left: 6px solid currentColor; transition: transform .15s ease;
}
.caret-tri.small { border-top-width: 3px; border-bottom-width: 3px; border-left-width: 5px; }
.caret-tri.open { transform: rotate(90deg); }
.hand-actions { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.md-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%; }
.md-picked { font-size: 12.5px; color: var(--dim); flex: none; }
.md-picked .mono { color: var(--text); font-weight: 600; }
.md-actions { display: flex; align-items: center; gap: 10px; flex: none; }
.clash-guide { font-size: 12px; color: var(--dim); display: grid; gap: 6px; }
.clash-guide .mono { color: var(--text); }

@media (max-width: 820px) {
  .page-head { flex-wrap: wrap; }
  .head-right { margin-left: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .caret-tri { transition: none; }
}
</style>
