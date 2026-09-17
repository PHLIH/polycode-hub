<script setup>
import { ref, computed, onMounted, reactive, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api.js'
import { shareOf, shareTitle } from '../share'

const list = ref([])
const providers = ref([]) // 测试按钮的模型下拉源（账号只认同源 Provider 的模型）
const sourceOptions = ref([])
const err = ref('')
// Provider 列表单独的错误态：它加载失败时账号页仍能显示已有账号，
// 但分组名/归属下拉会退化，必须显式告诉用户"是列表没拉到"，而不是伪装成空状态。
const providersErr = ref('')
const dialog = ref(false)
const editing = ref(null)

// 时间胶囊（与概览归因区同款：今天/7/30/自定义短区间）。默认「今天」。
const range = ref({ mode: 'today' })  // {mode:'today'|'7d'|'30d'} 或 {mode:'custom', since, until}
const RANGE_LABELS = { today: '今天', '7d': '近 7 天', '30d': '近 30 天' }
const rangeLabel = computed(() =>
  range.value.mode === 'custom'
    ? `自定义 ${range.value.since.slice(5)}~${range.value.until.slice(5)}`
    : RANGE_LABELS[range.value.mode])
const RANGE_DAYS = { today: 1, '7d': 7, '30d': 30 }
function localDay(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}
const rangeQuery = computed(() => {
  if (range.value.mode === 'custom') return { since: range.value.since, until: range.value.until }
  const end = new Date()
  end.setHours(0, 0, 0, 0)
  const start = new Date(end)
  start.setDate(start.getDate() - ((RANGE_DAYS[range.value.mode] ?? 30) - 1))
  return { since: localDay(start), until: localDay(end) }
})
const pillOpen = ref(false)
const customRange = ref([])
const canApplyCustom = computed(() =>
  Array.isArray(customRange.value) && !!customRange.value[0] && !!customRange.value[1])
const noFuture = (d) => d.getTime() > Date.now()
watch(pillOpen, (open) => {
  if (!open) return
  customRange.value = range.value.mode === 'custom' ? [range.value.since, range.value.until] : []
})
function pick(mode) {
  range.value = { mode }
  pillOpen.value = false
  loadHealth()
}
function applyCustom() {
  const [since, until] = customRange.value || []
  if (!since || !until || until < since) {
    ElMessage.warning('请选择有效的起止日期')
    return
  }
  range.value = { mode: 'custom', since, until }
  pillOpen.value = false
  loadHealth()
}

// 账号健康（ACCOUNT-HEALTH §3.6）： accountId → {requests, errorRate, byKind, lastErrorKind, models}
// 按 accountId join 到账号表；「失败率」是本页核心交互——支持排序。
const health = ref({})
const healthLoading = ref(false)

async function loadHealth() {
  healthLoading.value = true
  try {
    const rows = await api.usageAccounts(rangeQuery.value)
    const map = {}
    for (const r of rows || []) {
      if (!r.accountId) continue // Provider 级 API Key 单独成组，不属于任何具体账号
      map[r.accountId] = r
    }
    health.value = map
  } catch { /* 健康数据失败不阻塞账号表 */ }
  healthLoading.value = false
}

function hOf(row) { return health.value[row.id] }
// 当前区间该账号处理的请求数（含失败账）：裸数字看不出是什么，标题说清楚。
function healthText(row) {
  const h = hOf(row)
  if (!h || !h.requests) return '—'
  return `${fmtN(h.requests)} 次`
}
/** 失败率列：健康数据加载中时不能显示 "—"——那会被读成"这个号没用量"，
 *  而实际是"数据还没到"。用 healthLoading 区分这两种语义。 */
function errRateText(row) {
  const h = hOf(row)
  if (!h || !h.requests) return healthLoading.value ? '…' : ''
  return `失败 ${h.errors || 0} 次 · ${(h.errorRate * 100).toFixed(0)}%`
}
function errRateClass(row) {
  const h = hOf(row)
  if (!h || !h.requests || !h.errorRate) return 'dim'
  return h.errorRate > 0.1 ? 'bad' : 'warn'
}
function byKindParts(row) {
  const h = hOf(row)
  if (!h || !h.requests) return []
  const zh = { quota: '限额', rate_limit: '限流', auth: '鉴权', network: '网络', server: '5xx', bad_request: '请求' }
  return Object.entries(h.byKind).map(([k, n]) => `${zh[k] || k} ${n}`)
}
function fmtN(n) {
  if (n == null) return '0'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}
// 账号展开明细的占比条：与概览归因表同一份口径（相对组内总量，见 share.ts）
function modelShare(a, m) {
  const h = hOf(a)
  return shareOf(h ? h.models : [], m)
}
function modelShareTip(a, m) {
  const h = hOf(a)
  return shareTitle(h ? h.models : [], m)
}

const STATUS = {
  available: { label: '可用', cls: 'ok' },
  cooldown: { label: '冷却', cls: 'warn' },
  exhausted: { label: '耗尽', cls: 'bad' },
  disabled: { label: '禁用', cls: '' }
}

// 状态标识：健康度由后端算好下发（阈值只在后端一处定义，前端不复制常量）。
// 绿=健康可用，琥珀=连败超阈值/冷却中，红=耗尽/停用。
function healthOf(a) {
  if (a.status === 'disabled') return { cls: 'bad', label: '已停用', title: '管理面停用，不参与轮询' }
  if (a.status === 'exhausted') {
    return { cls: 'bad', label: '已耗尽', title: '上游额度已用尽，不会自动恢复：充值/换号后点「测试」验证，或点「重置」手动放行' }
  }
  if (a.status === 'cooldown') {
    const left = a.cooldownUntil ? Math.max(0, Math.round((new Date(a.cooldownUntil) - Date.now()) / 1000)) : 0
    return {
      cls: 'warn', label: '冷却中',
      title: left ? `冷却中，约 ${left}s 后自动恢复（可点「测试」立即验证）` : '冷却中，即将恢复',
    }
  }
  if ((a.health || 'ok') === 'warn') {
    return { cls: 'warn', label: '不稳定', title: `连续失败 ${a.fails || 0} 次，已达告警阈值，点「测试」验证 API Key 是否还有效` }
  }
  return { cls: 'ok', label: '健康', title: '可用，参与轮询' }
}

// ---- 账号测试：用该账号的 API Key 打一次真实请求，结果计入状态 ----
const checkingIn = reactive(new Set())
async function checkin(a) {
  if (checkingIn.has(a.id)) return
  checkingIn.add(a.id)
  try {
    const r = await api.checkinAccount(a.id)
    if (r.status === 'already_checked_in') ElMessage.info(r.message)
    else ElMessage.success(r.message)
  } catch (e) {
    ElMessage.error(`签到失败：${e.message}`)
  } finally {
    checkingIn.delete(a.id)
  }
}

const testing = ref('')
const testModel = ref({}) // accountId → 选中的模型（缺省取该源第一个启用的）

// 该账号能测哪些模型：取同源 Provider 已启用的（与后端 probeAccount 的默认选择同源）。
function modelOptions(a) {
  const ids = new Set()
  for (const p of providers.value) {
    if (p.providerId !== a.providerId) continue
    for (const m of p.models || []) if (m.enabled !== false) ids.add(m.id)
  }
  return [...ids].sort()
}

async function runTest(a) {
  testing.value = a.id
  try {
    const r = await api.testAccount(a.id, testModel.value[a.id] || '')
    if (r.ok) {
      ElMessage.success(`${a.id} 测试通过：${r.model || ''} ${r.latencyMs ? r.latencyMs + 'ms' : ''}`.trim())
    } else {
      ElMessage.error(`${a.id} 测试失败：${r.error || '未知错误'}`)
    }
    await Promise.all([load(), loadHealth()]) // 测完状态会变（连败/冷却），必须重新拉
  } catch (e) {
    ElMessage.error(`测试失败：${e.message}`)
  } finally { testing.value = '' }
}

// 重置：只清连败与冷却（零上游成本）。测试有成本，这个是"我确认它没病"的快捷键。
async function reset(a) {
  try {
    await api.recheckAccount(a.id)
    ElMessage.success(`${a.id} 已重置：连败清零、冷却解除`)
    await load()
  } catch (e) { ElMessage.error(e.message) }
}

const form = reactive({
  id: '', providerName: '', displayName: '', credentialEnv: '',
  // 与 Provider 页同口径：'key' = 粘 Key 本体（后端落凭据文件）；'env' = 环境变量名。
  credentialKind: 'key'
})

async function load() {
  try {
    const [as, ps] = await Promise.all([
      api.accounts(),
      // providers 失败不能静默成 []：那会让分组名退化成数字 id、
      // 「＋添加账号」预填空值、归属下拉变空，把**故障**伪装成「还没有可挂账号的上游源」。
      // 这里保留错误并显式提示，让用户知道是列表没拉到，而不是没配 Provider。
      api.providers().catch((e) => { providersErr.value = e.message; return [] }),
    ])
    list.value = as
    providers.value = ps
    // 归属下拉 = Provider id 列表（账号就是挂在某个 Provider 名下的）。
    // 以前列的是去重后的抽象「源」，还可能出现 default 这种名字，根本不知道挂给了谁。
    sourceOptions.value = ps.map(p => p.name).filter(Boolean).sort()
    err.value = ''
  }
  catch (e) { err.value = e.message }
  loadHealth()
}
onMounted(load)

// 按归属 Provider 分组是本页的结构：账号永远挂在它绑定的 Provider 下面；
// 每组自带的「添加账号」直接预绑定 providerId。组内按失败率降序（运维第一眼：哪个号在出问题）。
const groups = computed(() => {
  // 只看「归属 Provider 还在」的账号：删掉的 Provider 是软删（行留在库里给历史用量
  // 归因用），它名下的账号却会一直留在账号池里 —— 反复「删掉 workbuddy 再一键导入」
  // 就会攒下一堆同身份的旧账号，看起来像很多个号，其实早就不参与轮询了。
  // 已删除渠道的那批不再展示（后端列表也同步过滤，这里是同一口径的兜底）。
  // providersErr 非空 = Provider 列表没拉到，此时不能拿「空集合」去过滤账号
  // （那会把整页账号全隐藏，看起来像账号池空了）。后端已按同一口径过滤，
  // 这里只在拿到 Provider 列表时才兜底。
  const liveIds = new Set(
    providers.value.filter(p => p.state !== 'deleted').map(p => String(p.providerId))
  )
  const bySource = {}
  for (const a of list.value) {
    if (!providersErr.value && !liveIds.has(String(a.providerId))) continue
    ;(bySource[String(a.providerId)] ||= []).push(a)
  }
  // 分组键一律是 providerId 字符串（账号归属本来就是 providerId），显示名经 nameById 映射。
  // 以前这里把 sourceOptions（Provider 名）和 id 字符串混进同一个数组：有账号的分组键是 "3"，
  // 分组头的「＋添加账号」就把 "3" 当 providerName 预填 → 保存 400「没有名为 3 的 Provider」，
  // 同一个 Provider 还会裂��「3」和「orcarouter」两组（一组有账号、一组假空）。
  const keys = new Set(Object.keys(bySource))
  for (const p of providers.value) {
    if (p.state !== 'deleted') keys.add(String(p.providerId))
  }
  const ids = [...keys]
  const cmp = (a, b) =>
    ((hOf(b) || {}).errorRate || 0) - ((hOf(a) || {}).errorRate || 0) ||
    ((hOf(b) || {}).requests || 0) - ((hOf(a) || {}).requests || 0)
  const gs = ids.map(id => ({ id, accounts: (bySource[id] || []).slice().sort(cmp) }))
  // 有账号的源排前面，空源垫底（空源也是邀请：挂个「添加账号」入口）
  return gs.filter(g => g.accounts.length).concat(gs.filter(g => !g.accounts.length))
})

// 当前表单选中的源下面有哪些 Provider：用来提示「账号凭据会接管该源鉴权」。
// 账号与 Provider 同源即互相影响（proxy.ts:203 转发、probe.ts:214 探测都取
// 「同源第一个可用账号」的凭据覆盖 Provider 凭据），所以这个提示不能省：
// 用户在 default 源下随手加个测试账号，就能把已配好的 Provider Key 顶掉。
// 名字 → 内部 id 的映射已不再需要：保存时走 api.createAccount({providerName})，
// 由后端按名字解析成 id（前端不再自己转）。这里曾有一个零引用的 idByName，已删。
// 反向映射 nameById 仍有用（分组头展示、openEdit 回填归属名）。
const nameById = computed(() => {
  const m = new Map()
  for (const p of providers.value) m.set(String(p.providerId), p.name)
  return m
})
const siblingProviders = computed(() => (form.providerName ? [form.providerName] : []))

// 模板用：该分组对应的 Provider 是否存在（分组键就是 Provider id）。
function providersOf(groupKey) {
  const n = nameById.value.get(String(groupKey))
  return n ? [n] : []
}

// 分组头显示名：正常是 Provider 名；归属的 Provider 已被物理删除（providerId = -1）
// 时给人话，而不是把 "-1" 当名字打在标题上。
function groupLabel(key) {
  return nameById.value.get(String(key)) || (String(key) === '-1' ? '（Provider 已删除）' : String(key))
}

// 展开查看健康详情（自绘深色，替代 el-table 的白色展开行）
const expanded = ref('')
function toggleExpand(id) { expanded.value = expanded.value === id ? '' : id }

function openCreate(providerName) {
  Object.assign(form, { id: '', providerName, displayName: '', credentialEnv: '', credentialKind: 'key' })
  editing.value = null
  dialog.value = true
}

function openEdit(a) {
  Object.assign(form, {
    id: a.id, providerName: nameById.value.get(String(a.providerId)) || '', displayName: a.displayName || '',
    credentialEnv: (a.credential && a.credential.apiKeyEnv) || '',
    credentialKind: 'key'
  })
  editing.value = a
  dialog.value = true
}

async function save() {
  if (!form.id) { ElMessage.warning('账号 ID 必填'); return }
  if (!form.providerName) { ElMessage.warning('归属 Provider 必填（选择这个账号挂给谁）'); return }
  // 重名直接拦在本地：后端也会拒（409），但本地提示能立刻指出是哪个名字撞了，
  // 不用等一次往返。
  if (!editing.value && list.value.some(a => a.id === form.id.trim())) {
    ElMessage.warning(`账号 ID「${form.id.trim()}」已存在，换一个名字`)
    return
  }
  try {
    // 凭据输入交给后端按语义处理：'key' 落凭据文件，'env' 存变量名引用。
    // 空 = 不改动现有凭据（编辑时不清掉已配的 Key）。
    const cred = form.credentialEnv.trim()
      ? { credentialInput: form.credentialEnv.trim(), credentialKind: form.credentialKind }
      : {}
    if (editing.value) {
      await api.updateAccount(form.id, { displayName: form.displayName, ...cred })
    } else {
      await api.createAccount({
        id: form.id, providerName: form.providerName, displayName: form.displayName,
        credential: {}, ...cred
      })
    }
    dialog.value = false
    ElMessage.success('已保存')
    load()
  } catch (e) { ElMessage.error(e.message) }
}

async function remove(a) {
  try {
    await ElMessageBox.confirm(`删除账号「${a.id}」？`, '确认删除', { type: 'warning' })
  } catch { return }
  try { await api.deleteAccount(a.id); ElMessage.success('已删除'); load() }
  catch (e) { ElMessage.error(e.message) }
}

// 启用开关：available=参与轮询，disabled=摘除；cooldown/exhausted 是池内惩罚态，
// 开关只在 available/disabled 间切（与后端 PATCH 语义一致）。
function isEnabled(a) { return a.status !== 'disabled' }
async function toggleEnabled(a, on) {
  try {
    await api.updateAccount(a.id, { status: on ? 'available' : 'disabled' })
    a.status = on ? 'available' : 'disabled'
    ElMessage.success(on ? `${a.id} 已启用，参与轮询` : `${a.id} 已停用，不再接请求`)
  } catch (e) { ElMessage.error(e.message); load() }
}

// 权重：同源账号间按权重分配流量（默认 1）。关/失效的账号权重自动失效，
// 分母是可用者的权重和——不用手动重算，后端 pick 按可用者权重加权轮询。
function weightOf(a) { return a.weight && a.weight > 0 ? a.weight : 1 }
async function setWeight(a, v) {
  const w = Math.floor(Number(v))
  if (!Number.isFinite(w) || w <= 0) { ElMessage.warning('权重须为正整数'); load(); return }
  if (w === weightOf(a) && a.weight === w) return // 没改就不打接口
  try {
    await api.updateAccountWeight(a.id, w)
    a.weight = w
    ElMessage.success(`${a.id} 权重 → ${w}`)
  } catch (e) { ElMessage.error(e.message); load() }
}
</script>

<template>
  <header class="page-head">
    <div class="head-row">
      <div>
        <h2>账号池</h2>
        <p class="sub">同一上游源的多账号轮换；耗尽/限流自动冷却并换号。API Key 只存环境变量引用，明文不落盘、不回显。</p>
      </div>
      <!-- 时间胶囊：只管健康数据区间（与概览归因区同款） -->
      <div class="range-pill-wrap">
        <button class="range-pill" :class="{ on: pillOpen }" @click.stop="pillOpen = !pillOpen">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/>
            <path d="M1.5 6.2h13M5 1.2v2.6M11 1.2v2.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
          {{ rangeLabel }}
          <span class="range-caret" aria-hidden="true">▾</span>
        </button>
        <div v-if="pillOpen" class="range-card" @click.stop>
          <div class="range-presets">
            <button v-for="m in ['today', '7d', '30d']" :key="m" class="range-item"
              :class="{ on: range.mode === m }" @click="pick(m)">{{ RANGE_LABELS[m] }}</button>
          </div>
          <div class="range-sep" />
          <div class="range-custom-title">自定义区间</div>
          <el-date-picker v-model="customRange" type="daterange" range-separator="→"
            start-placeholder="开始日期" end-placeholder="结束日期" size="small"
            value-format="YYYY-MM-DD" format="MM-DD" :disabled-date="noFuture"
            @keydown.enter="applyCustom" />
          <div class="range-foot">
            <span class="dim range-hint">含起止当日，最多回看一年</span>
            <button class="range-apply" :disabled="!canApplyCustom" @click="applyCustom">应用</button>
          </div>
        </div>
      </div>
    </div>
  </header>

  <p v-if="err" class="err">加载失败：{{ err }}</p>
  <p v-if="providersErr" class="err">Provider 列表加载失败（账号归属与分组名无法解析）：{{ providersErr }}</p>

  <p v-if="!groups.length" class="empty">
    还没有可挂账号的上游源。先到「Provider」页添加上游源，再回到这里往源下面加账号。
  </p>

  <!-- 账号按归属 Provider 分组：加账号 = 往某个 Provider 下面加，providerId 预绑定 -->
  <section v-for="g in groups" :key="g.id" class="src">
    <header class="src-head">
      <h3>{{ groupLabel(g.id) }}</h3>
      <span v-if="nameById.get(String(g.id))" class="mono pid-h">#{{ g.id }}</span>
      <span class="src-count num">{{ g.accounts.length }} 个账号</span>
      <!-- 名下账号接管该 Provider 鉴权（见 siblingProviders 注释）：有账号时必须说清楚，
           否则用户看到「Provider 配了 Key 却用这个号的钱」完全摸不着头脑。 -->
      <span v-if="g.accounts.length && providersOf(g.id).length" class="src-takeover"
        :title="`名下有可用账号时，账号凭据会覆盖 Provider 自己配的凭据（真实转发与测试走同一条规则）`">
        接管 {{ providersOf(g.id).join('、') }} 的鉴权
      </span>
      <span class="grow"></span>
      <!-- 分组键是 providerId，弹窗要的是 Provider 名：这里显式映射一次。
           查不到名字（Provider 已删除）就留空，让用户在下拉里自己选，不要把 id 当名字填进去。 -->
      <button class="btn" @click="openCreate(nameById.get(String(g.id)) || '')">＋ 添加账号</button>
    </header>

    <p v-if="!g.accounts.length" class="src-empty">这个源下面还没有账号，点「添加账号」把 API Key 挂进来。</p>

    <div v-for="a in g.accounts" :key="a.id" class="acct" :class="{ open: expanded === a.id }">
      <div class="acct-row" @click="toggleExpand(a.id)">
        <span class="chev" :class="{ open: expanded === a.id }">▸</span>
        <span class="dot" :class="healthOf(a).cls" :title="healthOf(a).title"></span>
        <span class="acct-id num">{{ a.id }}</span>
        <span class="acct-name">{{ a.displayName || '—' }}</span>
        <span class="acct-cred num dim" :title="a.credential && a.credential.apiKeyEnv ? 'API Key 环境变量' : ''">
          {{ (a.credential && a.credential.apiKeyEnv) || '—' }}
        </span>
        <span class="acct-health" :class="healthOf(a).cls" :title="healthOf(a).title">{{ healthOf(a).label }}</span>
        <span class="acct-metric num" :title="rangeLabel + '该账号处理的请求数（含失败）'">{{ healthText(a) }}</span>
        <span class="acct-metric num" :class="errRateClass(a)" :title="rangeLabel + '失败次数与失败率'">{{ errRateText(a) }}</span>
        <span class="acct-status">{{ (STATUS[a.status] || {}).label || a.status }}</span>
        <span class="acct-weight" title="同源账号间按权重分配流量（默认 1）；关/失效的账号权重自动失效，不用手动重算">
          <span class="dim">权重</span>
          <el-input-number :model-value="weightOf(a)" :min="1" :max="100" :step="1" size="small"
            class="weight-input" @change="v => setWeight(a, v)" />
        </span>
        <span class="acct-actions" @click.stop>
          <el-switch :model-value="isEnabled(a)" size="small"
            :title="isEnabled(a) ? '启用中：参与轮询，点击停用' : '已停用：不接请求，点击启用'"
            @change="v => toggleEnabled(a, v)" />
          <button v-if="a.importSource === 'workbuddy'" class="linklike"
            :disabled="checkingIn.has(a.id)" @click="checkin(a)"
            title="使用此账号的导入登录态签到一次，不自动重试">
            {{ checkingIn.has(a.id) ? '签到中…' : '签到' }}
          </button>
          <button class="linklike" @click="openEdit(a)">编辑</button>
          <button class="linklike danger" @click="remove(a)">删除</button>
        </span>
      </div>

      <!-- 明细：与概览用量归因表同构（模型/请求/输入/输出/总量/失败+占比条） -->
      <div v-if="expanded === a.id" class="acct-detail">
        <!-- 测试：选模型 → 打一次真实请求。测通即解除冷却、连败归零（人工验证手段）。 -->
        <div class="test-row">
          <el-select v-model="testModel[a.id]" size="small" class="test-sel" clearable filterable
            :placeholder="modelOptions(a).length ? '默认模型' : '该源没有可测模型'">
            <el-option v-for="m in modelOptions(a)" :key="m" :value="m" :label="m" />
          </el-select>
          <button class="btn sm" :disabled="testing === a.id" @click="runTest(a)">
            {{ testing === a.id ? '测试中…' : '测试这个账号' }}
          </button>
          <button class="btn sm ghost" :disabled="testing === a.id" @click="reset(a)"
            title="只清连败与冷却，不发请求">重置</button>
          <span class="dim test-note">
            用该账号的 API Key 打一次真实请求；测通即解除冷却、连败归零，测挂则计一次失败
          </span>
        </div>


        <template v-if="hOf(a) && hOf(a).requests">
          <table class="mattr">
            <thead>
              <tr>
                <th>模型</th>
                <th class="n">请求</th>
                <th class="n">输入</th>
                <th class="n">输出</th>
                <th class="n">总 token</th>
                <th class="n">失败</th>
                <th class="bar-col">占比</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in hOf(a).models" :key="m.modelId">
                <td><span class="model-name">{{ m.modelId }}</span></td>
                <td class="n num">{{ fmtN(m.requests) }}</td>
                <td class="n num">{{ fmtN(m.inputTokens) }}</td>
                <td class="n num">{{ fmtN(m.outputTokens) }}</td>
                <td class="n num strong">{{ fmtN(m.totalTokens) }}</td>
                <td class="n num" :class="{ 'err': m.errors > 0 }">{{ m.errors || '' }}</td>
                <td class="bar-col"><div class="bar" :title="modelShareTip(a, m)"><div class="bar-fill" :style="{ width: (modelShare(a, m) * 100) + '%' }" /></div></td>
              </tr>
            </tbody>
          </table>
        </template>

        <!-- 失败原因分布：后端已下发 byKind（quota/rate_limit/auth/...），
             以前只算了不渲染 —— 排障时"这个号为什么挂"全靠猜。
             放在明细表下方，只在真有失败时出现。 -->
        <div v-if="byKindParts(a).length" class="bykind">
          <span class="dim">失败原因：</span>
          <span v-for="p in byKindParts(a)" :key="p" class="bykind-item">{{ p }}</span>
        </div>
        <span v-else class="dim">{{ rangeLabel }}无用量记录。</span>
      </div>
    </div>
  </section>

  <el-dialog v-model="dialog" :title="editing ? '编辑账号' : '添加账号'" width="480px">
    <el-form label-width="110px">
      <el-form-item label="ID"><el-input v-model="form.id" :disabled="!!editing" placeholder="如 zcode-1" /></el-form-item>
      <el-form-item label="归属 Provider">
        <el-select v-model="form.providerName" :disabled="!!editing || !!form.providerName" style="width:100%"
          filterable :placeholder="sourceOptions.length ? '选择这个账号挂给哪个 Provider' : '先到 Provider 页添加上游'">
          <el-option v-for="s in sourceOptions" :key="s" :label="s" :value="s" />
        </el-select>
        <div class="field-hint">
          账号就是「某个 Provider 的一组可轮换凭据」。归到谁名下，就在谁请求时被轮询用到。
        </div>
      </el-form-item>
      <el-form-item label="显示名"><el-input v-model="form.displayName" /></el-form-item>
      <el-form-item label="API Key">
        <!-- 与 Provider 页同口径：显式选语义，避免把 Key 本体误存成环境变量名。 -->
        <el-radio-group v-model="form.credentialKind" size="small" class="cred-kind">
          <el-radio-button value="key">直接填 Key</el-radio-button>
          <el-radio-button value="env">用环境变量</el-radio-button>
        </el-radio-group>
        <el-input v-model="form.credentialEnv" :disabled="!!editing && form.credentialKind === 'env'"
          class="mono" type="password" show-password
          :placeholder="form.credentialKind === 'key'
            ? '粘贴 API Key（保存后落到 config/credentials/）'
            : '环境变量名，如 ZCODE_JWT'" />
        <div class="field-hint">
          <template v-if="form.credentialKind === 'key'">
            粘进来即可用：写入 <span class="mono">config/credentials/</span>（0600），不在列表回显明文。
          </template>
          <template v-else>只存变量名引用；改值需重启网关。</template>
          留空 = 不改动现有凭据。
        </div>
        <!-- 真实踩坑：同源有可用账号时，账号凭据会覆盖该源 Provider 自己的凭据
             （proxy.ts:203 真实转发、probe.ts:214 探测，同一条规则）。往「default」
             这类已配了 Key 的源下面加账号，会让那个 Provider 改用新账号的 Key。 -->
        <div v-if="siblingProviders.length" class="cred-warn">
          该源下已有 Provider（<span class="mono">{{ siblingProviders.join('、') }}</span>）：
          这个账号一旦可用，它的 Key 会**接管**该源所有 Provider 的鉴权——Provider 自己配的 Key 会被绕过。
          只想给某个 Provider 单独配 Key，就别往它的源下面挂账号。
        </div>
      </el-form-item>
    </el-form>
    <template #footer>
      <button class="btn ghost" @click="dialog = false">取消</button>
      <button class="btn" @click="save">保存</button>
    </template>
  </el-dialog>
</template>

<style scoped>
.page-head { margin-bottom: 16px; }
.page-head h2 { margin: 0 0 4px; font-size: 18px; }
.sub { color: var(--dim); margin: 0 0 10px; font-size: 12px; }
.head-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }

/* ---- 时间胶囊（与概览归因区同款，见 Dashboard.vue） ---- */
.range-pill-wrap { position: relative; flex: none; margin-top: 2px; }
.range-pill {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--line); background: var(--panel-2); color: var(--text);
  border-radius: 999px; padding: 5px 13px; font-size: 12px; cursor: pointer; white-space: nowrap;
  transition: border-color .15s, background .15s;
}
.range-pill svg { color: var(--dim); }
.range-pill:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); }
.range-pill.on { border-color: var(--accent); }
.range-pill:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.range-caret { color: var(--dim); font-size: 10px; transition: transform .15s; }
.range-pill.on .range-caret { transform: rotate(180deg); }
.range-card {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 30; width: 264px;
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px;
  padding: 10px; box-shadow: 0 12px 32px rgb(0 0 0 / 50%);
}
.range-presets { display: flex; gap: 6px; }
.range-item {
  flex: 1; padding: 6px 0; font-size: 12px; text-align: center;
  color: var(--dim); background: var(--bg); border: 1px solid var(--line);
  border-radius: 6px; cursor: pointer; transition: color .15s, border-color .15s, background .15s;
}
.range-item:hover { color: var(--text); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.range-item.on {
  color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, var(--line));
  background: color-mix(in srgb, var(--accent) 12%, var(--bg)); font-weight: 600;
}
.range-sep { border-top: 1px solid var(--line); margin: 10px 0 8px; }
.range-custom-title { font-size: 11px; color: var(--dim); margin: 0 2px 6px; }
.range-card :deep(.el-date-editor) { width: 100%; }
.range-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
.range-hint { font-size: 11px; }
.range-apply {
  border: 1px solid var(--accent); color: var(--accent); background: none;
  border-radius: 6px; padding: 4px 16px; font-size: 12px; cursor: pointer;
  transition: background .15s, opacity .15s;
}
.range-apply:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.range-apply:disabled { opacity: .4; cursor: default; }
.btn {
  background: var(--accent); color: #0b1119; border: 0; border-radius: 6px;
  padding: 6px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
}
.btn.ghost { background: transparent; color: var(--dim); border: 1px solid var(--line); }
/* .linklike 基础样式已上收 styles.css */
.dim { color: var(--dim); }
/* API Key 的语义二选一（与 Provider 页同口径，见 Providers.vue） */
.cred-kind { margin-bottom: 8px; }
.cred-kind :deep(.el-radio-button__inner) { font-size: 12px; padding: 5px 14px; }
.field-hint { color: var(--dim); font-size: 11px; line-height: 1.5; padding-top: 2px; }
.err { color: var(--bad); }
.empty { color: var(--dim); border: 1px dashed var(--line); border-radius: 10px; padding: 40px 24px; text-align: center; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--dim); flex: none; }
.dot.ok { background: var(--ok); }
.dot.warn { background: var(--warn); }
.dot.bad { background: var(--bad); }
.warn { color: var(--warn); }

/* 归属源分组：源是小节头，账号行挂在组内 */
.src {
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  margin-bottom: 16px; overflow: hidden;
}
.src-head { display: flex; align-items: center; gap: 10px; padding: 11px 16px; }
.src-head h3 { margin: 0; font-size: 15px; font-family: var(--mono); }
.src-count { color: var(--dim); font-size: 12px; }
/* 「接管鉴权」提示：账号与 Provider 同源时的真实影响，不是装饰 */
.pid-h { color: var(--dim); opacity: .7; font-size: 11px; margin-left: 4px; }
.src-takeover {
  font-size: 11px; color: var(--warn); cursor: help;
  border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent);
  border-radius: var(--r-chip); padding: 1px 8px; white-space: nowrap;
}
/* 账号弹窗里的接管警告：与字段提示区分开，避免被当说明文字略过 */
.cred-warn {
  margin-top: 6px; padding: 7px 10px; font-size: 11px; line-height: 1.6;
  color: var(--warn); border-radius: var(--r-ctl);
  background: color-mix(in srgb, var(--warn) 8%, transparent);
  border-left: 2px solid var(--warn);
}
.grow { flex: 1; }
.src-empty { color: var(--dim); font-size: 13px; padding: 0 16px 12px; margin: 0; }

.acct { border-top: 1px solid var(--line); }
.acct:nth-child(even) { background: color-mix(in srgb, var(--panel-2) 45%, var(--panel)); }
.acct-row {
  display: flex; align-items: center; gap: 12px;
  padding: 9px 16px; font-size: 13px; cursor: pointer; flex-wrap: wrap;
}
.chev { color: var(--dim); font-size: 11px; transition: transform .12s; flex: none; }
.chev.open { transform: rotate(90deg); }
.acct-id { font-weight: 600; }
.acct-name { color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.acct-cred { font-size: 12px; }
.acct-metric { color: var(--dim); font-size: 12px; }
.acct-metric.bad { color: var(--bad); }
.acct-metric.warn { color: var(--warn); }
.acct-status { margin-left: auto; color: var(--dim); font-size: 12px; }
.acct-weight { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; flex: none; }
.weight-input { width: 96px; }
.weight-input :deep(.el-input__inner) { text-align: center; }
.acct-actions { display: flex; gap: 4px; flex: none; }

/* 健康状态标识：绿=健康，琥珀=连败超阈值/冷却，红=耗尽/停用 */
.acct-health {
  font-size: 11px; padding: 0 7px; border-radius: 999px; white-space: nowrap;
  border: 1px solid var(--line); color: var(--dim);
}
.acct-health.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); }
.acct-health.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
.acct-health.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, transparent); }

/* 展开详情：自绘深色面板（替换 el-table 白色展开行） */
.acct-detail {
  background: var(--panel-2); border-top: 1px dashed var(--line);
  padding: 10px 16px 10px 40px; font-size: 12px;
}
/* 测试条：选模型 + 打一次真实请求（放在明细顶部，展开了就能点） */
.test-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.test-sel { width: 240px; }
.btn.sm { padding: 3px 10px; font-size: 12px; }
.test-note { font-size: 11px; }

/* 明细归因表：与概览用量归因表同构（模型/请求/输入/输出/总量/失败+占比条） */
.mattr { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
.mattr th { text-align: left; color: var(--dim); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--line); }
.mattr td { padding: 7px 8px; border-bottom: 1px solid var(--line); }
.mattr tr:last-child td { border-bottom: 0; }
.mattr .n { text-align: right; }
.mattr .strong { font-weight: 600; }
.mattr .err { color: var(--bad); }
.mattr .model-name { font-family: var(--mono); }
.mattr .bar-col { width: 120px; }
.mattr .bar { height: 6px; background: var(--panel-2, #1a222d); border-radius: 3px; overflow: hidden; }
.mattr .bar-fill { height: 100%; background: var(--accent); border-radius: 3px; }
/* 失败原因分布（byKind）：一行小标签，回答"这个号为什么挂" */
.bykind { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 8px; font-size: 12px; }
.bykind-item {
  padding: 1px 7px; border-radius: 4px; border: 1px solid var(--line);
  color: var(--text); font-variant-numeric: tabular-nums;
}
</style>
