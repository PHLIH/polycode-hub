<script setup>
import { ref, computed, onMounted, reactive, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, AbortError } from '../api.js'

const list = ref([])
const err = ref('')
const dialog = ref(false)
const editing = ref(null) // null=新建；对象=编辑
const busy = ref(false)

// 连通测试弹窗
const testDlg = ref(false)
const testing = ref(false)
const testRes = ref(null)
const testTarget = ref(null)

// 获取模型弹窗
const modelsDlg = ref(false)
const fetching = ref(false)
const fetchErr = ref('')
const fetched = ref([])
// 出口选项：顶层 egresses 定义（管理面可写，见 api.putEgress；config/apps.yaml 只作启动播种）
// + 现有 Provider 在用的引用兜底
const declaredEgresses = ref([])
const egressOptions = computed(() => {
  const seen = new Map()
  for (const e of declaredEgresses.value) seen.set(e.id, e)
  for (const p of list.value) if (p.egress) seen.set(p.egress, { id: p.egress, kind: 'http', addr: '' })
  return [...seen.values()]
})
const fetchedSource = ref('')
const declaredProtocols = ref({}) // 模型 ID → 上游声明的协议
const declaredCaps = ref({})      // 模型 ID → 上游声明的能力（input/ctx/out）
const freeModels = ref(new Set())  // 免费档模型 ID（命名约定启发式）
const onlyFree = ref(false)        // 只看免费档
const picked = ref([])
const modelsTarget = ref(null)

// —— 展开行的模型面板（对外暴露清单）——
// exposedModels 是「模型」按钮里勾选的那批模型——唯一的真相源。
// 展开行展示它、测试下拉取它、/v1/models 也只列它：三处必须同一份集合。
// 未勾选的模型（上游拉回来但没勾）不属于 exposed，不在这里出现。
const exposedModels = (p) => (p && p.models ? p.models.filter(m => m.enabled) : [])

const APIS = [
  { v: '', hint: '不确定就选这个：转发时自动逐个试，探到能用的协议就记住（新增外部 API 推荐）' },
  { v: 'anthropic-messages', hint: 'baseURL 不含 /v1，网关拼 /v1/messages' },
  { v: 'openai-completions', hint: 'baseURL 含 /v1，网关拼 chat/completions' },
  { v: 'openai-responses', hint: 'baseURL 含 /v1，网关拼 responses' }
]
const KINDS = ['official', 'session-reuse', 'simulated-login', 'reverse']
const RISKS = ['low', 'medium', 'high']
const STAB = ['stable', 'beta', 'experimental']

const form = reactive({
  id: '', sourceId: '', displayName: '', api: 'anthropic-messages',
  baseURL: '', accessKind: 'official', risk: 'low', riskNote: '',
  stability: 'stable', credentialEnv: '', enabled: true, modelsText: '', streamOnly: false
})

async function load() {
  try {
    ;[list.value, declaredEgresses.value] = await Promise.all([api.providers(), api.egresses()])
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

// ZCode 本地引擎（sidecar）也进一键面板：没装→一键安装（下载+配置+启动），装了→一键启动
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
    id: '', sourceId: 'default', displayName: '', api: '',
    baseURL: '', accessKind: 'official', risk: 'low', riskNote: '',
    stability: 'stable', credentialEnv: '', enabled: true, modelsText: '', streamOnly: false, egress: ''
  })
  editing.value = null
  dialog.value = true
}

function openEdit(p) {
  Object.assign(form, {
    id: p.id, sourceId: p.sourceId, displayName: p.displayName || '', api: p.api,
    baseURL: p.baseUrl, accessKind: p.accessKind, risk: p.risk, riskNote: p.riskNote || '',
    stability: p.stability, credentialEnv: (p.credential && p.credential.apiKeyEnv) || '',
    enabled: !!p.enabled, modelsText: '', streamOnly: !!p.streamOnly,
    egress: p.egress || ''
  })
  editing.value = p
  dialog.value = true
}

function parseModelsText() {
  return form.modelsText.split('\n').map(s => s.trim()).filter(Boolean)
}

async function save() {
  if (!form.id) { ElMessage.warning('Provider ID 必填（小写字母/数字/连字符，保存后不可改）'); return }
  if (!form.baseURL) { ElMessage.warning('baseURL 必填'); return }
  if ((form.risk === 'medium' || form.risk === 'high') && !form.riskNote) {
    ElMessage.warning('中/高风险必须填写风险说明（riskNote），使用者要在界面上看到')
    return
  }
  busy.value = true
  try {
    if (editing.value) {
      const patch = {
        displayName: form.displayName, enabled: form.enabled,
        riskNote: form.riskNote, streamOnly: form.streamOnly
      }
      const extra = parseModelsText()
      if (extra.length) patch.models = extra
      await api.updateProvider(form.id, patch)
    } else {
      await api.createProvider({
        id: form.id, sourceId: form.sourceId, displayName: form.displayName,
        api: form.api, baseUrl: form.baseURL, accessKind: form.accessKind,
        risk: form.risk, riskNote: form.riskNote, stability: form.stability,
        credential: form.credentialEnv ? { apiKeyEnv: form.credentialEnv } : {},
        egress: form.egress || '',
        enabled: form.enabled,
        models: parseModelsText().map(id => ({ id, enabled: true }))
      })
    }
    dialog.value = false
    ElMessage.success('已保存')
    load()
  } catch (e) {
    ElMessage.error(e.message)
  } finally { busy.value = false }
}

async function toggle(p) {
  try { await api.updateProvider(p.id, { enabled: !p.enabled }); load() }
  catch (e) { ElMessage.error(e.message) }
}

// 测试弹框没候选时的引导：直接带到模型弹框
function goPickModels() {
  testDlg.value = false
  if (testTarget.value) openModels(testTarget.value)
}

// Clash 出口快捷配置：本地场景基本只需要一个 Clash 混合端口
const clashDlg = ref(false)
const clashPort = ref('7897')
const clashBusy = ref(false)
const hasClash = computed(() => declaredEgresses.value.some(e => e.id === 'clash'))

// clashAddr：状态条常驻显示当前生效的出口地址——配置结果不该只在弹框里可见。
const clashAddr = computed(() => {
  const e = declaredEgresses.value.find(x => x.id === 'clash')
  return e ? e.addr : ''
})

// modelsUsingClash：有多少个模型真的把流量切到了 clash（状态条据此说人话）。
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

async function remove(p) {
  try {
    await ElMessageBox.confirm(`删除 Provider「${p.id}」？引用它的配置会失效。`, '确认删除', { type: 'warning' })
  } catch { return }
  try { await api.deleteProvider(p.id); ElMessage.success('已删除'); load() }
  catch (e) { ElMessage.error(e.message) }
}

function apiHint(v) {
  const h = APIS.find(a => a.v === (v || ''))
  return h ? h.hint : ''
}

// 协议显示名：空值 = 自动识别（新增 Provider 的推荐选项）
function apiLabel(v) {
  return v ? v : '自动识别（推荐）'
}

// 内置标记已移除：Provider 一律由发现/导入或手填生成，都可在界面上删除。

async function test(p) {
  testTarget.value = p
  probeModel.value = p.probeModel || ''
  testRes.value = null
  testing.value = true
  testDlg.value = true
  // 测试候选 = 「模型」按钮里勾选的那批（与展开行、/v1/models 同一份集合）。
  // 一个都没勾 → 下拉为空，弹框里提示去「模型」勾选。
  probeOptions.value = exposedModels(p).map(m => m.id)
  try {
    testRes.value = await api.testProvider(p.id)
  } catch (e) {
    testRes.value = { ok: false, error: e.message }
  } finally {
    testing.value = false
  }
}

const probeModel = ref('')
const probeOptions = ref([])

async function saveProbeModel() {
  try {
    await api.updateProvider(testTarget.value.id, { probeModel: probeModel.value.trim() })
    testTarget.value.probeModel = probeModel.value.trim()
    test(testTarget.value)
  } catch (e) { ElMessage.error(e.message) }
}

// refreshTarget 从服务端取该 Provider 的最新状态（含扫描写回的模型协议），
// 使弹窗展示已知协议而不是「继承默认」。
async function refreshTarget(id) {
  try {
    const fresh = await api.providers()
    const found = (fresh || []).find(x => x.id === id)
    if (!found) return
    modelsTarget.value = found
    // 就地更新表格那一行：换掉对象即可（row-key 保证展开态不丢）。
    // 注意别写 const list = ... —— 那会遮蔽外层的 list，改动永远落不到表格上。
    const i = list.value.findIndex(x => x.id === id)
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
    await refreshTarget(p.id)
    const res = await api.fetchProviderModels(p.id)
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

// 可用性实测结果，按 providerId/模型ID 存（keyOf）。识别入口在表格行内下拉里。
const scanRes = ref({}) // { 'provider/模型': {ok, latencyMs, error, protocol} }

// 模型协议：探到的结果即事实，也允许手工纠正（写入 models[].api）。
const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']

// 协议/出口/识别现在都在表格行内下拉里操作，作用对象是「某个 Provider 的某个模型」，
// 所以要按 providerId+模型 定位（keyOf），不能再用弹框里那个单一 modelsTarget。
const keyOf = (p, modelID) => `${p.id}/${modelID}`

function modelOf(p, modelID) {
  return ((p && p.models) || []).find(x => x.id === modelID)
}

// protoValue 下拉框当前值：Provider 上已落的协议优先（扫描写回/手工改），
// 其次用上游本次声明的协议兜底（还没采用时也能显示）。
function protoValue(p, modelID) {
  const m = modelOf(p, modelID)
  if (m && m.api) return m.api
  if (declaredProtocols.value[modelID]) return declaredProtocols.value[modelID]
  return ''
}

// protoPlaceholder 下拉框空值时的占位：识别失败显示原因摘要，未测提示点识别。
function protoPlaceholder(p, modelID) {
  const r = scanRes.value[keyOf(p, modelID)]
  if (r && !r.ok) {
    const e = r.error || ''
    if (e.includes('429')) return '限流，稍后再试'
    if (e.includes('401')) return '需 API key'
    if (e.includes('country')) return '地区限制'
    return '不可用'
  }
  return '未测'
}

// 模型级出口代理（'' = 直连）；被地域锁的单个模型走代理，同 Provider 其余模型直连。
function egressValue(p, modelID) {
  const m = modelOf(p, modelID)
  return (m && m.egress) || ''
}

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

// displayNameOf：sourceId（技术标识）→ 人类可读名。模型限定名 source/model 的前缀用它。
function displayNameOf(sourceId) {
  const p = list.value.find(x => x.sourceId === sourceId)
  return (p && p.displayName) || sourceId
}

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

// detectOne 就地识别单个模型的协议：复用扫描接口（只传该模型），
// 探到即写回并更新行内显示；失败显示最后一次错误的摘要。
// 识别是真打上游，慢则几十秒——按钮在探测中变成「取消」，点了立即中断。
const detecting = ref({}) // providerId/模型ID → true（探测中）
const detectCtrl = {} // providerId/模型ID → AbortController

async function detectOne(p, modelID) {
  const k = keyOf(p, modelID)
  if (detecting.value[k]) { // 再点一次 = 取消
    detectCtrl[k]?.abort()
    return
  }
  const ctrl = new AbortController()
  detectCtrl[k] = ctrl
  detecting.value[k] = true
  try {
    const rs = await api.scanProviderModels(p.id, [modelID], { signal: ctrl.signal })
    const r = rs && rs[0]
    if (!r) throw new Error('无结果')
    scanRes.value[k] = r // 行内 tag 立即反映结果
    if (r.ok) {
      // 协议已写回服务端；把值同步到本地行，行内下拉立刻显示结果
      const m = modelOf(p, modelID)
      if (m && r.protocol) m.api = r.protocol
    } else {
      ElMessage.error(`${modelID}：${(r.error || '').slice(0, 60)}`)
    }
  } catch (e) {
    // 主动取消不报错（用户自己按的），超时/失败才说
    if (e instanceof AbortError) {
      if (e.message.includes('超时')) ElMessage.warning(`${modelID}：${e.message}`)
    } else {
      ElMessage.error(`识别失败：${e.message}`)
    }
  } finally {
    delete detectCtrl[k]
    delete detecting.value[k]
    detecting.value = { ...detecting.value } // 触发响应式更新
  }
}

// 就地回填行内模型：改完立刻反映在下拉上，不用整表重拉
function patchRowModel(p, modelID, key, val) {
  const m = modelOf(p, modelID)
  if (!m) return
  if (val) m[key] = val
  else delete m[key]
}

async function setModelProtocol(p, modelID, proto) {
  try {
    await api.updateProviderModelProtocol(p.id, modelID, proto)
    patchRowModel(p, modelID, 'api', proto)
    ElMessage.success(`${modelID} → ${proto || '继承 Provider 默认'}`)
  } catch (e) { ElMessage.error(e.message) }
}

async function setModelEgress(p, modelID, eg) {
  try {
    await api.updateProviderModelEgress(p.id, modelID, eg)
    patchRowModel(p, modelID, 'egress', eg)
    ElMessage.success(`${modelID} 出口 → ${eg || '直连'}`)
  } catch (e) { ElMessage.error(e.message) }
}

// 删除单个模型：手填错的/上游已下架的得能摘掉（PATCH models 只增不减）。
async function removeModel(p, modelID) {
  try {
    await ElMessageBox.confirm(`从「${p.id}」删除模型 ${modelID}？`, '确认删除', { type: 'warning' })
  } catch { return }
  try {
    await api.deleteProviderModel(p.id, modelID)
    ElMessage.success(`已删除 ${modelID}`)
    await load()
  } catch (e) { ElMessage.error(e.message) }
}

// —— 模型备注：一句话运维知识（「23 点后才免费，白天用会扣额度」这种）——
// 行内只放一个图标，hover 看全文；点图标就地编辑。
const noteEdit = ref('') // keyOf(p,model) → 正在编辑
const noteDraft = ref('')

function startNote(p, modelID) {
  const k = keyOf(p, modelID)
  noteEdit.value = k
  noteDraft.value = modelOf(p, modelID)?.note || ''
  // 下一帧聚焦：输入框是 v-if 出来的，同步 focus 拿不到元素
  nextTick(() => document.getElementById('note-' + k)?.focus())
}

async function saveNote(p, modelID) {
  const k = keyOf(p, modelID)
  const m = modelOf(p, modelID)
  if (!m) return
  const note = noteDraft.value.trim()
  if (note === (m.note || '')) { noteEdit.value = ''; return } // 没改就不打接口
  try {
    await api.updateProviderModelNote(p.id, modelID, note)
    patchRowModel(p, modelID, 'note', note)
    noteEdit.value = ''
    ElMessage.success(note ? '备注已保存' : '备注已清除')
  } catch (e) { ElMessage.error(e.message) }
}

// —— Provider 绑定账号白名单 ——
// 同 sourceId 的账号才可选；空 = 不限（全部轮询）。保存走 PATCH accountIds。
const allAccounts = ref([])
async function loadAccounts() {
  try { allAccounts.value = await api.accounts() } catch { allAccounts.value = [] }
}
onMounted(loadAccounts)
function accountsOf(p) {
  return allAccounts.value.filter(a => a.sourceId === p.sourceId)
}
function bindLabel(p) {
  const ids = (p && p.accountIds) || []
  if (!ids.length) return '全部轮询'
  return `绑定 ${ids.length} 个`
}
async function setBindAccounts(p, ids) {
  try {
    await api.updateProviderAccounts(p.id, ids || [])
    if (!ids || !ids.length) delete p.accountIds
    else p.accountIds = [...ids]
    ElMessage.success(ids && ids.length ? `${p.id} 只走 ${ids.join('、')}` : `${p.id} 回到全部轮询`)
  } catch (e) { ElMessage.error(e.message) }
}

// 指定账号弹框（操作列入口）：与展开行下拉同一数据源，弹框更显眼。
const bindDlg = ref(false)
const bindTarget = ref(null)
const bindPicked = ref([])
function openBind(p) {
  bindTarget.value = p
  bindPicked.value = [...((p && p.accountIds) || [])]
  bindDlg.value = true
}
async function saveBind() {
  if (!bindTarget.value) { bindDlg.value = false; return }
  await setBindAccounts(bindTarget.value, bindPicked.value)
  bindDlg.value = false
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
    await api.updateProvider(modelsTarget.value.id, { models: entries })
    ElMessage.success(`已追加 ${entries.length} 个模型`)
    handModels.value = ''
    await refreshTarget(modelsTarget.value.id)
    const res = await api.fetchProviderModels(modelsTarget.value.id)
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
    for (const m of toOff) await api.updateProviderModelEnabled(target.id, m.id, false)
    for (const m of toOn) await api.updateProviderModelEnabled(target.id, m.id, true)

    // 勾选里还没采用的（上游新模型）走 PATCH models 追加，顺带写入声明的协议/能力
    const known = new Set((target.models || []).map(m => m.id))
    const fresh = picked.value.filter(id => !known.has(id))
    if (fresh.length) {
      const models = fresh.map(id => ({
        id, protocol: declaredProtocols.value[id] || '', caps: declaredCaps.value[id] || null
      }))
      await api.updateProvider(target.id, { models })
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
  <header class="page-head">
    <h2>Provider</h2>
    <p class="sub">workbuddy / zcode / opencode 三源内置（删了重启会按配置文件补回）。这里只管别家 API。</p>
    <div class="actions">
      <button class="btn" @click="openCreate">添加外部 API</button>
    </div>
  </header>

  <p v-if="err" class="err">加载失败：{{ err }}</p>

  <section class="panel qi">
    <div class="panel-head">
      <h3>一键导入</h3>
      <span class="dim qi-sub">点一下就完成采用 + 账号入池，不用看文档</span>
    </div>
    <p v-if="!findings.length" class="dim">本机没有发现可导入的 harness（装过并登录过的才会出现在这里）。</p>
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
        <span class="dot" :class="f.adoptedProviderId ? 'ok' : (f.status === 'ready' ? '' : (f.status === 'missing' ? '' : 'warn'))" />
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

  <!-- 出口代理状态条：低频设置项，从标题区移下来常驻显示——
       配置结果（端口/绑定数）不该只在弹框里可见。 -->
  <section class="egress-bar" :class="{ on: hasClash }">
    <span class="eg-label">出口代理</span>
    <template v-if="hasClash">
      <span class="eg-name num">clash</span>
      <span class="eg-addr num">http://{{ clashAddr }}</span>
      <span class="status-chip ok"><span class="dot ok" />已启用</span>
      <span class="dim eg-note">
        {{ modelsUsingClash ? `${modelsUsingClash} 个模型走此代理，其余直连` : '尚无模型绑定它——到「模型」弹框里给被地域锁的模型切出口' }}
      </span>
    </template>
    <template v-else>
      <span class="status-chip"><span class="dot" />未配置</span>
      <span class="dim eg-note">全部直连。只给被地域锁的模型挂代理时再来配。</span>
    </template>
    <button class="btn ghost eg-btn" @click="openClash">{{ hasClash ? '配置' : '配置 Clash 出口' }}</button>
  </section>

  <!-- row-key 必须给：load() 会用新对象替换 list，没有稳定 key 时 el-table
       认不出"还是同一行"，展开态与行内状态全被重置（测试完模型列表自己收起来）。 -->
  <el-table :data="list" row-key="id" style="width:100%">
    <el-table-column type="expand" width="36">
      <template #header>
        <span class="th-exp" title="展开查看该 Provider 已勾选的模型"></span>
      </template>
      <template #default="{ row }">
        <!-- 行内下拉：只列「模型」按钮里勾选的那批，可在此直接改协议/出口。
             勾选入口收在「模型」按钮里（那里才看得到上游全量目录）。 -->
        <div class="mp">
          <!-- 指定账号：空 = 该源全部轮询；勾选 = 只走这几个账号（调度+请求头都约束） -->
          <div class="bind-row">
            <span class="bind-label">指定账号</span>
            <el-select :model-value="(row.accountIds || [])" multiple collapse-tags
              collapse-tags-tooltip clearable placeholder="全部轮询（不限）" class="bind-sel"
              @change="v => setBindAccounts(row, v)">
              <el-option v-for="a in accountsOf(row)" :key="a.id" :value="a.id" :label="a.id" />
            </el-select>
            <span class="dim bind-hint">{{ bindLabel(row) }}</span>
          </div>
          <template v-if="exposedModels(row).length">
            <div class="mp-list">
              <div v-for="m in exposedModels(row)" :key="m.id" class="mp-row">
                <span class="mp-id-cell">
                  <span class="mp-id num">{{ m.id }}</span>
                  <!-- 备注：按钮常态可见（不再 hover 才现身）；全文用 el-tooltip 立即弹出，
                       不用原生 title —— 原生 title 要悬停 1~2 秒才显示，像卡住了。 -->
                  <input v-if="noteEdit === keyOf(row, m.id)" :id="'note-' + keyOf(row, m.id)"
                    v-model="noteDraft" class="note-input" maxlength="200"
                    placeholder="如「23 点后才免费」"
                    @keyup.enter="saveNote(row, m.id)" @keyup.esc="noteEdit = ''" @blur="saveNote(row, m.id)">
                  <el-tooltip v-else-if="m.note" :content="m.note" placement="top" :show-after="0">
                    <button class="note-btn has" @click="startNote(row, m.id)">备注</button>
                  </el-tooltip>
                  <el-tooltip v-else content="加一句备注（如「23 点后才免费，白天用会扣额度」）"
                    placement="top" :show-after="0">
                    <button class="note-btn" @click="startNote(row, m.id)">＋备注</button>
                  </el-tooltip>
                </span>
                <span class="mp-tags">
                  <el-select :model-value="protoValue(row, m.id)" size="small" class="mp-sel"
                    :placeholder="protoPlaceholder(row, m.id)" clearable filterable
                    @change="v => setModelProtocol(row, m.id, v)">
                    <el-option v-for="pp in PROTOCOLS" :key="pp" :value="pp" :label="pp" />
                  </el-select>
                  <el-select :model-value="egressValue(row, m.id)" size="small" class="mp-sel"
                    placeholder="直连" clearable
                    @change="v => setModelEgress(row, m.id, v)">
                    <el-option v-for="e in egressOptions" :key="e.id" :value="e.id" :label="'⇄ ' + e.id" />
                  </el-select>
                  <button class="md-detect" :class="{ busy: detecting[keyOf(row, m.id)] }"
                    :title="detecting[keyOf(row, m.id)] ? '正在打上游探测，点此取消' : '探测这个模型的协议与可用性'"
                    @click="detectOne(row, m.id)">{{ detecting[keyOf(row, m.id)] ? '取消' : '识别' }}</button>
                  <button class="md-del" title="从该 Provider 删除这个模型（手填错的/上游下架的）"
                    @click="removeModel(row, m.id)">删除</button>
                  <span v-if="scanRes[keyOf(row, m.id)]" class="mp-scan"
                    :class="scanRes[keyOf(row, m.id)].ok ? 'ok' : 'bad'"
                    :title="scanRes[keyOf(row, m.id)].error || ''">
                    {{ scanRes[keyOf(row, m.id)].ok ? '✓ ' + (scanRes[keyOf(row, m.id)].latencyMs || '') + 'ms' : '✗ 不通' }}
                  </span>
                </span>
              </div>
            </div>
          </template>
          <!-- 没点过「模型」按钮 = 一个都没勾 = 对外不暴露任何模型 -->
          <p v-else class="dim mp-empty">
            还没有勾选任何模型——点右侧「模型」按钮从上游目录勾选，勾中的才会对外暴露。
          </p>
        </div>
      </template>
    </el-table-column>
    <el-table-column label="名称" min-width="200">
      <template #default="{ row }">
        <div class="name-cell">
          <span class="p-name">{{ row.displayName || row.id }}</span>
        </div>
        <div class="p-id">ID: {{ row.id }}</div>
      </template>
    </el-table-column>
    <el-table-column label="协议" min-width="150">
      <template #default="{ row }">
        <span :class="{ dim: !row.api }">{{ row.api || '自动识别' }}</span>
        <span v-if="row.streamOnly" class="so-tag" title="上游只支持流式，非流式请求会跳过此源">只流式</span>
      </template>
    </el-table-column>
    <el-table-column label="账号" min-width="140">
      <template #default="{ row }">
        <span v-if="(row.accountIds || []).length" class="bind-chip num" :title="'只走：' + row.accountIds.join('、')">
          绑定 {{ row.accountIds.length }} 个
        </span>
        <span v-else class="dim">全部轮询</span>
      </template>
    </el-table-column>
    <el-table-column label="baseURL" min-width="220">
      <template #default="{ row }"><span class="ph-url dim">{{ row.baseUrl }}</span></template>
    </el-table-column>
    <el-table-column label="启用" width="90">
      <template #default="{ row }">
        <el-switch :model-value="row.enabled" @change="toggle(row)" />
      </template>
    </el-table-column>
    <el-table-column label="操作" width="260">
      <template #default="{ row }">
        <button class="linklike" @click="test(row)">测试</button>
        <button class="linklike" @click="openModels(row)">模型</button>
        <button class="linklike" @click="openBind(row)">指定账号</button>
        <button class="linklike" @click="openEdit(row)">编辑</button>
        <button class="linklike danger" @click="remove(row)">删除</button>
      </template>
    </el-table-column>
  </el-table>

  <el-dialog v-model="bindDlg" :title="`指定账号 · ${bindTarget ? bindTarget.id : ''}`" width="480px">
    <p class="dim bind-note">空 = 该源全部账号轮询；勾选 = 只走这几个账号（默认路由与请求头指定都约束）。</p>
    <el-select :model-value="bindPicked" multiple collapse-tags collapse-tags-tooltip
      clearable placeholder="全部轮询（不限）" style="width:100%" @change="v => bindPicked = v || []">
      <el-option v-for="a in (bindTarget ? accountsOf(bindTarget) : [])" :key="a.id" :value="a.id" :label="a.id" />
    </el-select>
    <p v-if="bindTarget && !accountsOf(bindTarget).length" class="dim bind-note">该源下还没有账号，先去账号池添加。</p>
    <template #footer>
      <button class="btn ghost" @click="bindDlg = false">取消</button>
      <button class="btn" @click="saveBind">保存</button>
    </template>
  </el-dialog>

  <el-dialog v-model="clashDlg" title="Clash 出口" width="480px">
    <el-form label-width="90px">
      <el-form-item label="混合端口">
        <el-input v-model="clashPort" class="num" placeholder="7897" style="width:160px" />
        <div class="field-hint">Clash / Clash Verge 的 HTTP 混合代理端口，默认 7897（Clash「设置 → 端口」里能看到）。</div>
      </el-form-item>
    </el-form>
    <div class="clash-guide">
      <p>保存后定义一个名为 <span class="num">clash</span> 的出口（http://127.0.0.1:端口），立即生效。</p>
      <p>然后到 Provider 行的「模型」弹框，把被地域锁的模型（如 muse-spark）的出口下拉切到 <span class="num">⇄ clash</span>——只有它走代理，同 Provider 其它模型保持直连。别把整个 Provider 都绑上去。</p>
    </div>
    <template #footer>
      <button v-if="hasClash" class="btn ghost" @click="removeClash">删除出口</button>
      <button class="btn ghost" @click="clashDlg = false">取消</button>
      <button class="btn" :disabled="clashBusy" @click="saveClash">保存</button>
    </template>
  </el-dialog>

  <el-dialog v-model="dialog" :title="editing ? '编辑 Provider' : '添加外部 API'" width="560px">
    <el-form label-width="110px">
      <el-form-item label="ID">
        <el-input v-model="form.id" :disabled="!!editing" placeholder="如 acme-vllm（保存后不可改）" />
      </el-form-item>
      <el-form-item label="Source">
        <el-input v-model="form.sourceId" :disabled="!!editing" placeholder="归属的上游源 ID" />
      </el-form-item>
      <el-form-item label="显示名"><el-input v-model="form.displayName" /></el-form-item>
      <el-form-item label="协议">
        <el-select v-model="form.api" :disabled="!!editing" style="width:100%">
          <el-option v-for="a in APIS" :key="a.v || 'auto'" :value="a.v" :label="apiLabel(a.v)" />
        </el-select>
        <div class="field-hint">{{ apiHint(form.api) }}</div>
      </el-form-item>
      <el-form-item label="baseURL">
        <el-input v-model="form.baseURL" placeholder="停在操作路径之前" />
      </el-form-item>
      <el-form-item label="接入方式">
        <el-select v-model="form.accessKind" style="width:100%">
          <el-option v-for="k in KINDS" :key="k" :value="k" :label="k" />
        </el-select>
      </el-form-item>
      <el-form-item label="风险">
        <el-select v-model="form.risk" style="width:120px">
          <el-option v-for="r in RISKS" :key="r" :value="r" :label="r" />
        </el-select>
        <el-input v-model="form.riskNote" placeholder="风险说明（中/高风险必填，UI 可见）" style="flex:1" />
      </el-form-item>
      <el-form-item label="凭据">
        <el-input v-model="form.credentialEnv" placeholder="环境变量名（如 ACME_KEY），明文不落盘" />
      </el-form-item>
      <el-form-item label="稳定性">
        <el-select v-model="form.stability" style="width:160px">
          <el-option v-for="s in STAB" :key="s" :value="s" :label="s" />
        </el-select>
      </el-form-item>
      <el-form-item label="出口代理">
        <el-select v-model="form.egress" clearable placeholder="直连（默认）" style="width:100%">
          <el-option v-for="e in egressOptions" :key="e.id" :label="`${e.id}（${e.kind}://${e.addr}）`" :value="e.id" />
        </el-select>
        <div class="dim" style="font-size:11px">被地域锁的模型走代理出口；其余 Provider 保持直连（顶层 egresses 在 config/apps.yaml 定义）。</div>
      </el-form-item>
      <el-form-item label="只走流式">
        <el-switch v-model="form.streamOnly" />
        <div class="field-hint">上游不支持非流式时勾上（如 WorkBuddy 报 11101/404），调度会跳过非流式请求，不再白撞一次。</div>
      </el-form-item>
      <el-form-item label="模型">
        <el-input v-model="form.modelsText" type="textarea" :rows="3"
          :placeholder="editing ? '追加模型 ID（每行一个，已有不受影响）' : '模型 ID（每行一个）'" />
      </el-form-item>
      <el-form-item label="启用"><el-switch v-model="form.enabled" /></el-form-item>
    </el-form>
    <template #footer>
      <button class="btn ghost" @click="dialog = false">取消</button>
      <button class="btn" :disabled="busy" @click="save">保存</button>
    </template>
  </el-dialog>

  <el-dialog v-model="testDlg" :title="`测试 ${testTarget ? testTarget.id : ''}`" width="520px">
    <el-form-item label="测试模型" label-width="80px">
      <el-select v-if="probeOptions.length" v-model="probeModel" filterable allow-create
        default-first-option clearable placeholder="默认取第一个启用模型" size="small" style="width:100%"
        @change="saveProbeModel">
        <el-option v-for="id in probeOptions" :key="id" :value="id" :label="id" />
      </el-select>
      <div v-else class="no-models">
        <p class="nm-title">还没有勾选模型</p>
        <p class="nm-body">
          这个 Provider 在「模型」按钮里一个都没勾，测试没有对象。<br>
          去「模型」按钮勾选后，这些模型会同时出现在下拉里、对外暴露并参与路由。
        </p>
        <button class="btn" @click="goPickModels">去「模型」勾选</button>
      </div>
      <div v-if="probeOptions.length" class="field-hint">
        候选就是「模型」按钮里勾选的那 <span class="num">{{ probeOptions.length }}</span> 个；留空则取第一个。
      </div>
    </el-form-item>
    <p v-if="testing" class="dim">正在打一次最小真实请求（hi，最多 90 秒）…</p>
    <div v-else-if="testRes && testRes.ok" class="test-ok">
      <p><span class="dot ok"></span>打通，用模型
        <template v-for="(seg, gi) in (testRes.model || '').split('/')" :key="gi">
          <span v-if="gi === 0" class="ph-src">{{ displayNameOf(seg) }}</span>
          <span v-else class="ph-id">/{{ seg }}</span>
        </template>，首字延迟 <span class="num">{{ testRes.latencyMs }}ms</span></p>
      <pre class="test-text">{{ testRes.text || '（无文本回显，但连接与鉴权正常）' }}</pre>
    </div>
    <div v-else-if="testRes" class="err">
      <p><span class="dot bad"></span>失败</p>
      <pre class="test-text">{{ testRes.error }}</pre>
    </div>
    <template #footer>
      <button class="btn ghost" @click="testDlg = false">关闭</button>
      <button class="btn" :disabled="testing" @click="test(testTarget)">重测</button>
    </template>
  </el-dialog>

  <el-dialog v-model="modelsDlg" width="760px" class="models-dlg" :show-close="false">
    <template #header>
      <div class="md-head">
        <span class="md-title">获取模型</span>
        <span class="md-target num">{{ modelsTarget ? modelsTarget.id : '' }}</span>
        <button class="md-close" @click="modelsDlg = false">✕</button>
      </div>
    </template>

    <p v-if="fetching" class="dim md-note">正在问上游要模型列表…</p>

    <div v-else-if="fetchErr" class="md-note">
      <p class="err">{{ fetchErr }}</p>
      <p class="sub">拉不到列表也能用手填兜底（每行一个，追加已有不受影响）：</p>
      <el-input v-model="handModels" type="textarea" :rows="3" placeholder="每行一个模型 ID" />
      <div style="margin-top:8px;text-align:right"><button class="btn" @click="appendHandModels">追加手填</button></div>
    </div>

    <template v-else>
      <p class="md-source">{{ sourceHint }}　<span class="num">{{ fetched.length }}</span> 个 · <span class="free-dot" />免费 <span class="num">{{ freeModels.size }}</span></p>

      <div class="md-toolbar">
        <input v-model="modelQ" class="md-search" placeholder="过滤模型 ID…">
        <button class="md-tool" @click="picked = [...visibleModels]">全选{{ onlyFree ? '免费' : '' }}</button>
        <button class="md-tool" @click="picked = []">清空</button>
        <button class="md-tool" :class="{ on: onlyFree }" @click="onlyFree = !onlyFree">免费</button>
      </div>

      <!-- 这里只做勾选。协议/出口/识别在表格行内下拉里操作（已勾选的模型才需要）。 -->
      <div class="md-list">
        <label v-for="id in visibleModels" :key="id" class="md-row" :class="{ picked: picked.includes(id) }">
          <input type="checkbox" :value="id" v-model="picked" class="md-check">
          <span class="md-id num">{{ id }}</span>
          <span class="md-tags">
            <span v-if="isFree(id)" class="md-tag free" title="命名含 free/contributor/trial">免费</span>
            <span v-if="ctxLabel(id)" class="md-tag ctx" :title="'上下文 ' + ctxLabel(id)">{{ ctxLabel(id) }}</span>
          </span>
        </label>
        <p v-if="!visibleModels.length" class="dim md-note">没有匹配的模型。</p>
      </div>

      <p class="md-foot-note">
        勾选即对外暴露；协议与出口到表格里展开该 Provider 调整。
      </p>

      <div class="hand-block">
        <button class="hand-toggle" @click="handOpen = !handOpen">
          <span class="hand-caret" :class="{ open: handOpen }" />手动填写模型
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
        <span class="md-picked">已选 <span class="num">{{ picked.length }}</span> 个</span>
        <div class="md-actions">
          <button class="btn ghost" @click="modelsDlg = false">取消</button>
          <button v-if="!fetchErr" class="btn" @click="adoptModels">保存（暴露 {{ picked.length }} 个）</button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.page-head { margin-bottom: 16px; }
.page-head h2 { margin: 0 0 4px; font-size: 18px; }
.sub { color: var(--dim); margin: 0 0 10px; font-size: 12px; }
.actions { margin-bottom: 12px; }
.btn {
  background: var(--accent); color: #0b1119; border: 0; border-radius: 6px;
  padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer;
}
.btn.ghost { background: transparent; color: var(--dim); border: 1px solid var(--line); }
/* .linklike 基础样式已上收 styles.css */
.dim { color: var(--dim); }
.err { color: var(--bad); }

/* ---- 一键导入面板 ---- */
.qi { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; }
.panel-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 10px; }
.panel-head h3 { margin: 0; font-size: 14px; }
.qi-sub { font-size: 12px; }
.qi-list { display: flex; flex-direction: column; }
.qi-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line); }
.qi-row:last-child { border-bottom: 0; }
.qi-name { font-weight: 600; flex: none; }
.qi-detail { font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qi-action { flex: none; display: flex; align-items: center; gap: 8px; }
.qi-hint { font-size: 12px; }
.note-mark {
  margin-left: 6px; color: var(--dim); font-size: 11px; cursor: help;
  border: 1px solid var(--line); border-radius: 50%; padding: 0 4px;
}
.field-hint { color: var(--dim); font-size: 11px; line-height: 1.5; padding-top: 2px; }
.test-ok { font-size: 13px; }
.test-text {
  font-family: var(--mono); font-size: 12px; background: var(--bg, #10151c);
  border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px;
  white-space: pre-wrap; word-break: break-all; margin: 8px 0 0;
}
.model-pick { display: flex; flex-direction: column; gap: 4px; max-height: 320px; overflow: auto; }
.pick-bar { display: flex; gap: 8px; margin: 4px 0 8px; }
.proto-sel { margin-left: 8px; width: 190px; }
.proto-sel.failed :deep(.el-input__wrapper) { box-shadow: 0 0 0 1px var(--bad) inset; }
.proto-sel.failed :deep(.el-select__placeholder) { color: var(--bad); }
.ctx-tag { margin-left: 4px; font-size: 11px; color: var(--dim); }
.free-tag {
  margin-left: 6px; font-size: 11px; padding: 0 6px; border-radius: 999px;
  background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok);
  border: 1px solid color-mix(in srgb, var(--ok) 40%, transparent);
}
.linklike.active { color: var(--ok); font-weight: 600; }
.detect-btn { margin-left: 6px; font-size: 11px; white-space: nowrap; }
.hand-block { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); }
.hand-toggle {
  display: inline-flex; align-items: center; gap: 8px; border: 0; background: none;
  color: var(--dim); font-size: 12px; cursor: pointer; padding: 2px 0;
}
.hand-toggle:hover { color: var(--text); }
/* CSS 画的展开箭头，不依赖字体字形 */
.hand-caret {
  width: 0; height: 0; border-top: 4px solid transparent; border-bottom: 4px solid transparent;
  border-left: 6px solid currentColor; transition: transform .15s ease;
}
.hand-caret.open { transform: rotate(90deg); }
.hand-actions { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.name-cell { display: flex; align-items: center; }
.p-name { font-weight: 600; }
.ph-src { font-weight: 600; }
.p-id { font-size: 11px; color: var(--dim); font-family: var(--mono); margin-top: 1px; }
.so-tag {
  margin-left: 6px; font-size: 10px; padding: 0 5px; border-radius: 999px;
  border: 1px solid var(--line); color: var(--dim);
}
.status-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dim); }
.status-chip .dot { margin-right: 0; }

/* ---- 获取模型对话框：终端清单风格（对齐全局「信号面板」语言） ---- */
.md-head { display: flex; align-items: baseline; gap: 10px; }
.md-title { font-size: 15px; font-weight: 600; }
.md-target { font-family: var(--mono); font-size: 12px; color: var(--accent); }
.md-close { margin-left: auto; border: 0; background: none; color: var(--dim); cursor: pointer; font-size: 14px; }
.md-close:hover { color: var(--text); }
.md-source { margin: 0 0 10px; font-size: 12px; color: var(--dim); }
.md-source .num { color: var(--text); }
.free-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); margin: 0 2px 0 6px; }
.md-toolbar { display: flex; gap: 6px; margin-bottom: 8px; align-items: center; }
.md-search {
  flex: 1; background: var(--bg); border: 1px solid var(--line); border-radius: 4px;
  color: var(--text); font-family: var(--mono); font-size: 12px; padding: 5px 8px;
}
.md-search:focus { outline: none; border-color: var(--accent); }
.md-tool {
  border: 1px solid var(--line); background: none; color: var(--dim);
  border-radius: 4px; padding: 5px 10px; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.md-tool:hover { color: var(--text); border-color: var(--dim); }
.md-tool.on { color: var(--accent); border-color: var(--accent); }
.md-list {
  max-height: 52vh; overflow-y: auto; border: 1px solid var(--line);
  border-radius: 6px; background: var(--bg);
}
/* 网格而非 flex：模型名定宽成列，标记（免费/上下文）右对齐成列，
   长名字省略而不是把标记挤走。行高给足，37 行也不串行。 */
.md-row {
  display: grid; grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: center; gap: 12px; padding: 9px 14px;
  border-left: 2px solid transparent; cursor: pointer; font-size: 12.5px;
  border-bottom: 1px solid color-mix(in srgb, var(--line) 40%, transparent);
}
.md-row:last-child { border-bottom: 0; }
.md-row:hover { background: color-mix(in srgb, var(--panel) 55%, var(--bg)); }
.md-row.picked { border-left-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, var(--bg)); }
.md-check { accent-color: var(--accent); margin: 0; width: 15px; height: 15px; }
.md-id { font-family: var(--mono); font-size: 12.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 标记组：定宽右对齐，扫码式竖排对齐 */
.md-tags { display: flex; gap: 6px; align-items: center; flex: none; }
.md-tag {
  flex: none; font-size: 10px; padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--line); color: var(--dim); white-space: nowrap;
}
.md-tag.free { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); }
.md-tag.ctx { font-family: var(--mono); }
/* ---- 出口代理状态条 ---- */
.egress-bar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 9px 14px; margin-bottom: 16px; font-size: 12px;
}
.egress-bar.on { border-color: color-mix(in srgb, var(--ok) 35%, var(--line)); }
.eg-label { color: var(--dim); flex: none; }
.eg-name { font-weight: 600; flex: none; }
.eg-addr { color: var(--dim); flex: none; }
.eg-note { flex: 1; min-width: 200px; }
.eg-btn { flex: none; padding: 4px 12px; font-size: 12px; }

/* ---- 展开行：模型暴露面板 ---- */
/* 展开列表头图标：CSS 画三角，不依赖字体里有没有 ▸ 字形 */
.th-exp {
  display: inline-block; width: 0; height: 0; cursor: help; vertical-align: 1px;
  border-top: 4px solid transparent; border-bottom: 4px solid transparent;
  border-left: 6px solid var(--dim);
}
.mp { padding: 2px 10px 10px; }
.bind-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.bind-label { font-size: 12px; color: var(--dim); flex: none; }
.bind-sel { width: 320px; }
.bind-hint { font-size: 11px; }
.bind-chip {
  font-size: 11px; padding: 0 8px; border-radius: 999px; white-space: nowrap;
  color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
}
.mp-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
.mp-count { font-size: 13px; }
.mp-count .num { color: var(--ok); font-weight: 600; }
.mp-hint { font-size: 11px; }
.mp-toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
.mp-search {
  flex: 1; max-width: 280px; background: var(--bg); border: 1px solid var(--line);
  border-radius: 4px; color: var(--text); font-family: var(--mono); font-size: 12px; padding: 4px 8px;
}
.mp-search:focus { outline: none; border-color: var(--accent); }
.mp-tool {
  border: 1px solid var(--line); background: none; color: var(--dim); border-radius: 4px;
  padding: 4px 10px; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.mp-tool:hover:not(:disabled) { color: var(--text); border-color: var(--dim); }
.mp-tool.on { color: var(--accent); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.mp-tool:disabled { opacity: .4; cursor: default; }
/* 模型多时（如 OpenCode Zen 70 个）内部滚动，不把表格撑爆 */
.mp-list { max-height: 260px; overflow-y: auto; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); }
/* 展开区在宽屏下可到 1100px+。用固定列宽而非 flex 撑满，让协议标签对齐成列
   （名字长短不一时不参差），同时标签不会甩到最右侧。 */
/* 两列：模型名定宽 + 行内控件组。列数必须与 .mp-row 的子元素数一致，
   否则名字会落进窄列被截成两三个字符。 */
.mp-row {
  display: grid; grid-template-columns: 320px 1fr;
  align-items: center; gap: 8px; padding: 4px 10px; font-size: 12px;
  max-width: 860px;
  border-bottom: 1px solid color-mix(in srgb, var(--line) 45%, transparent);
}
.mp-row:last-child { border-bottom: 0; }
.mp-row:hover { background: color-mix(in srgb, var(--panel) 60%, var(--bg)); }
/* 模型名定宽列：超长省略，行内控件因此对齐成一列 */
.mp-id { font-size: 12px; color: var(--text); min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 名字 + 备注同占第一列（备注塞进 mp-id 列，避免动 grid 的列数映射） */
.mp-id-cell { display: flex; align-items: center; gap: 6px; min-width: 0; }
/* 备注按钮：常态可见（不靠 hover 显形——那会让人以为按钮不存在）。
   无备注时低调（暗色描边），有备注时高亮，一眼看出哪些模型写了注意事项。 */
.note-btn {
  flex: none; border: 1px solid var(--line); background: none; color: var(--dim);
  border-radius: 4px; padding: 1px 6px; font-size: 11px; cursor: pointer;
  white-space: nowrap;
}
.note-btn:hover { color: var(--accent); border-color: var(--accent); }
.note-btn.has {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
}
.note-btn.has:hover { border-color: var(--accent); }
.note-input {
  flex: 1; min-width: 0; background: var(--bg); color: var(--text);
  border: 1px solid var(--accent); border-radius: 4px; padding: 2px 6px;
  font-size: 11.5px; font-family: inherit;
}
/* 行内控件组：协议 / 出口 / 识别 / 结果 */
.mp-tags { display: flex; gap: 6px; align-items: center; min-width: 0; }
.mp-sel { width: 168px; flex: none; }
.mp-scan { flex: none; font-size: 11px; font-family: var(--mono); }
.mp-scan.ok { color: var(--ok); }
.mp-scan.bad { color: var(--bad); }
.mp-tag { font-size: 10px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--line); color: var(--dim); white-space: nowrap; }
.mp-tag.proto { font-family: var(--mono); }
.mp-tag.egress { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.mp-empty { font-size: 12px; margin: 6px 0; padding: 4px 2px; }
.no-models { font-size: 12px; }
.nm-title { font-weight: 600; margin: 0 0 4px; }
.nm-body { color: var(--dim); font-size: 12px; line-height: 1.6; margin: 0 0 10px; }
.clash-guide { font-size: 12px; color: var(--dim); display: grid; gap: 6px; margin-top: 4px; }
.clash-guide .num { color: var(--text); }
.md-detect { flex: none; border: 1px solid var(--line); background: none; color: var(--dim); border-radius: 4px; padding: 3px 8px; font-size: 11px; cursor: pointer; }
.md-detect:hover { color: var(--accent); border-color: var(--accent); }
/* 探测中：按钮变「取消」并转成警示色——一眼看出可点、且点了是中断 */
.md-detect.busy { color: var(--warn); border-color: var(--warn); }
/* 删除：常态安静，hover 才转红——避免日常误点，又不至于找不着 */
.md-del { flex: none; border: 1px solid var(--line); background: none; color: var(--dim); border-radius: 4px; padding: 3px 8px; font-size: 11px; cursor: pointer; }
.md-del:hover { color: var(--bad); border-color: var(--bad); }
.md-note { font-size: 11px; margin: 8px 0; }
/* 列表下方的一句说明：与列表拉开距离，不与「手动填写」挤在一起 */
.md-foot-note { font-size: 11.5px; color: var(--dim); margin: 10px 0 0; }
/* 页脚内部布局（分隔线与外间距由全局 .el-dialog__footer 提供）：
   「已选」靠左、按钮组靠右，两端分开而不是挤成一坨。 */
.md-footer {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  width: 100%;
}
.md-picked { font-size: 12.5px; color: var(--dim); flex: none; }
.md-picked .num { color: var(--text); font-weight: 600; }
.md-actions { display: flex; align-items: center; gap: 10px; flex: none; }

</style>
