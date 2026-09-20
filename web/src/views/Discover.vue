<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api.js'
import { useSidecar } from '../sidecarJob'

const list = ref([])
const err = ref('')
// Provider 内部 id → 名字：发现项只带回 adoptedProviderId（数字），直接渲染会显示
// 「已由 Provider「3」接管」——用户不认识数字，得映射回他起的名字。
const providerNames = ref(new Map())
async function loadProviderNames() {
  try {
    const ps = await api.providers()
    providerNames.value = new Map(ps.map(p => [p.providerId, p.name]))
  } catch { providerNames.value = new Map() }
}
function adoptedName(id) {
  return providerNames.value.get(id) || `#${id}`
}
const scanning = ref(false)
const adopting = ref('')
const scannedAt = ref('')
const elapsed = ref('')

const GROUP = {
  ready: { title: '可采用', hint: '登录态有效，点采用即生成 Provider 并把桌面登录态导入账号池' },
  attention: { title: '需处理', hint: '联网探测没通过（多为地区限制/指纹过期/网络）——仍可点「仍要采用」先导入，再按提示处理' },
  missing: { title: '未发现', hint: '本机没装或没登录过这些 harness' }
}
const ATTENTION = new Set(['expired', 'unknown', 'unreachable'])
const statusText = { ready: '可采用', expired: '已过期', missing: '未发现', unknown: '待确认', unreachable: '不可达' }
const dotClass = { ready: 'ok', expired: 'warn', unknown: 'warn', unreachable: 'bad', missing: '' }

// 版本徽标：WorkBuddy 国内版 / 海外版各是一个独立发行版，登录态与认证域都不同。
function realmLabel(realm) {
  return realm === 'ai' ? '海外版' : realm === 'cn' ? '国内版' : '版本未知'
}

function groupOf(f) {
  if (f.status === 'ready') return 'ready'
  if (ATTENTION.has(f.status)) return 'attention'
  return 'missing'
}

const groups = computed(() => {
  const g = { ready: [], attention: [], missing: [] }
  for (const f of list.value) g[groupOf(f)].push(f)
  return g
})

// 用户显式点「重新扫描」= 要实时结果，绕后端缓存；页面首次加载走缓存 + 后台刷新，
// 不让人对着空白干等（zen 联网验证上游固有 2~8 秒，那是上游响应头就慢）。
async function rescan(force = true) {
  if (scanning.value) return
  scanning.value = true
  err.value = ''
  const t0 = performance.now()
  try {
    list.value = await api.discover(force)
    elapsed.value = ((performance.now() - t0) / 1000).toFixed(1) + 's'
    scannedAt.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    const n = list.value.filter(f => f.status === 'ready').length
    ElMessage.success(`扫描完成，发现 ${list.value.length} 项，其中 ${n} 项可采用`)
  } catch (e) {
    err.value = e.message
    ElMessage.error(`扫描失败：${e.message}`)
  } finally {
    scanning.value = false
  }
}
// ---- ZCode sidecar（免费 plan 通道的本地引擎）即插即用管理 ----
// 状态与安装进度来自共享模块 web/src/sidecarJob.ts（真相源在服务端）：
// 这里不再自己存 sc，也不再自己管「安装中」——切页回来进度接着走，
// 详见该文件顶部注释。refresh 复用原名 loadSidecar，下面多处调用点不用动。
const {
  sc, installing: scInstalling, percent: scPercent,
  phaseText: scPhase, detailText: scProgressDetail,
  errorText: scError, proxyText: scProxy, start: scStart,
  pause: scPauseRun, cancel: scCancelRun,
  refresh: loadSidecar,
} = useSidecar()
const scBusy = ref('')

// scPause：暂停下载，保留已下的部分（下次断点续传）。
// 服务端作业态只统一标 cancelled，分不出暂停还是取消，所以反馈在这里就地给。
async function scPause() {
  const ok = await scPauseRun()
  if (ok) ElMessage.success('已暂停：已下载的进度已保留，下次安装从断点续传')
}

// scCancel：取消并**丢弃**已下的内容（下次从 0 开始）。
// 会丢数据，所以必须二次确认；这是它与「暂停」的唯一区别。
async function scCancel() {
  try {
    await ElMessageBox.confirm(
      '取消会删除已下载的进度，下次安装从头开始。若只想暂时停下，请用「暂停」（保留进度，可续传）。',
      '取消安装', { type: 'warning', confirmButtonText: '取消安装', cancelButtonText: '再想想' })
  } catch { return }
  const ok = await scCancelRun()
  if (ok) ElMessage.success('已取消安装：半成品已删除，下次从 0 开始')
}

// 登录 provider：引擎支持 z.ai 与智谱（bigmodel）两种账号，用户要能自己选。
// '' = 自动（按本机 ZCode 客户端已登录的那个猜）。
const scProvider = ref('')

// scLogin：网页内一键登录授权。
//
// 用户原话：「为啥不能手动弹出登录界面呢？」——以前引擎未登录时，页面上只有
// 一句「去终端跑 polycode-hub zcode sidecar login」的文案，登录被赶出了网页。
//
// **绝不能在这里 window.open**。真实缺陷（用户报告「点一次登录弹出两个一模一样
// 的授权页」）：引擎 4.6.8 起 `auth login` 会**自己打开默认浏览器**（spawn 的
// 引擎进程内跑 `cmd /c start <授权页>`，本机实测确认），旧版引擎不自带这行为，
// 当时由网页代开是对的；引擎行为变了这边没跟上，就变成引擎开一次 + 网页再开
// 一次 = 两个一模一样的页面。zai / bigmodel 两种账号都走同一条引擎代码路径，
// 症状相同。引擎也没有关闭自开的旗标（--paste 只管 bigmodel 验证码流），
// 所以唯一一次打开交给引擎，这里只展示兜底链接。
// loginToast：当前常驻的登录提示句柄。duration:0 的提示不会自己消失，
// 换 provider 再点一次会叠出两条，展示新提示前先把旧的关掉。
let loginToast = null

async function scLogin() {
  // 防重入：scBusy 的赋值是同步的，但 `:disabled` 要等 Vue 更新 DOM 才生效，
  // 快速双击仍可能进两次函数。这里显式挡一道。
  if (scBusy.value === 'login') return
  scBusy.value = 'login'
  try {
    const q = scProvider.value === '' ? '' : `?provider=${scProvider.value}`
    const r = await api.sidecarAction('login' + q)
    if (!r.url) { ElMessage.error('未取得授权链接'); return }
    // 引擎此刻已自行弹出默认浏览器。链接只是兜底：个别机器上自动弹出会失灵
    // （没有默认浏览器关联、远程会话等），用户点一下就能到达授权页。
    // 常驻提示只保留最新一条：换 provider 再点时旧的还在，会跟新文案打架。
    loginToast?.close()
    loginToast = ElMessage({
      duration: 0, showClose: true, dangerouslyUseHTMLString: true,
      message: `引擎已在默认浏览器打开 <b>${r.provider}</b> 授权页 —— 完成授权后回来点「启动」。`
        + `<br><a href="${r.url}" target="_blank" rel="noopener">没看到弹窗？点此打开授权页</a>`
        + `<br><span style="opacity:.7">若随后自动弹出 ZCode 客户端窗口，那是授权回调`
        + `（zcode:// 链接），直接关掉即可，不影响登录。</span>`,
    })
  } catch (e) { ElMessage.error(e.message) } finally { scBusy.value = '' }
}

async function scAction(action, confirmText) {
  // 防重入：与 scLogin 同理，`:disabled` 生效前的快速双击会双发 POST。
  if (scBusy.value === action) return
  if (confirmText && !window.confirm(confirmText)) return
  scBusy.value = action
  try {
    const r = await api.sidecarAction(action)
    ElMessage.success(r.message || `已${action === 'start' ? '启动' : action === 'stop' ? '停止' : '完成'}`)
    await Promise.all([loadSidecar(), rescan()])
  } catch (e) { ElMessage.error(e.message) } finally { scBusy.value = '' }
}

async function scInstall() {
  // 进度与失败原因都由服务端作业态提供（scPhase / scError），切页不丢；
  // 这里只负责触发，以及成功后刷新扫描结果。
  if (await scStart()) await rescan()
}

async function scUninstall() {
  // 双确认：第一步确认卸载，第二步确认是否连配置/日志一起清
  try {
    await ElMessageBox.confirm(
      '卸载会删除引擎二进制与网关侧鉴权 key。登录态（OAuth 身份）不受影响。',
      '卸载 ZCode 本地引擎', { type: 'warning', confirmButtonText: '继续' })
  } catch { return }
  // 防重入：scBusy 在下方才赋值，await 确认框期间按钮是「活的」。
  if (scBusy.value === 'uninstall') return
  let q = '?confirm=true'
  try {
    await ElMessageBox.confirm('是否同时清除配置文件与日志？（含 proxyApiKey 明文）',
      '清理范围', { type: 'warning', confirmButtonText: '连配置一起清', cancelButtonText: '只卸载程序' })
    q += '&removeWorkDir=true'
  } catch { /* 只卸载程序 */ }
  scBusy.value = 'uninstall'
  try {
    await api.sidecarUninstall(q)
    ElMessage.success('已卸载')
    await loadSidecar()
  } catch (e) { ElMessage.error(e.message) } finally { scBusy.value = '' }
}

async function scChangePort() {
  if (!sc.value) return
  let port
  try {
    const r = await ElMessageBox.prompt(
      '改写引擎配置并自动重启（几秒中断），网关会自动指向新端口。范围 1024-65535。',
      '修改引擎端口', {
        inputValue: String(sc.value.port || ''),
        inputPattern: /^\d{4,5}$/,
        inputErrorMessage: '请输入 1024-65535 的端口号',
        confirmButtonText: '确认修改', type: 'warning'
      })
    port = String(r.value).trim()
  } catch { return }
  scBusy.value = 'port'
  try {
    const r2 = await api.sidecarPort(port)
    ElMessage.success(`端口已改为 ${r2.port}${r2.restarted ? '，引擎已重启' : ''}`)
    await loadSidecar()
  } catch (e) { ElMessage.error(e.message) } finally { scBusy.value = '' }
}

// 自定义/兜底：用户自己跑了兼容程序，网关直接指向它的地址（不动内置引擎）。
async function scCustomEndpoint() {
  if (!sc.value) return
  let u
  try {
    const r = await ElMessageBox.prompt(
      '填你自己运行的兼容程序地址（http://127.0.0.1:端口）。保存后网关直接指向它，内置引擎不受影响。\n\n'
      + '你的程序需实现（Anthropic 兼容）：\n'
      + '· GET /health —— 探活，回 200 即可\n'
      + '· POST /v1/messages —— 对话，入参 JSON：{ model, max_tokens, messages:[{role,content}] }；'
      + '鉴权头 x-api-key / Authorization: Bearer（值 = config/credentials/zcode-proxy-key 的内容）\n'
      + '· 流式回 SSE（text/event-stream），非流式回 JSON',
      '自定义引擎地址', {
        inputValue: sc.value.endpoint || ('http://127.0.0.1:' + sc.value.port),
        inputPattern: /^http:\/\/(127\.0\.0\.1|localhost):\d{4,5}\/?$/,
        inputErrorMessage: '地址形如 http://127.0.0.1:8080',
        confirmButtonText: '测试连通', type: 'warning',
      })
    u = String(r.value).trim().replace(/\/+$/, '')
  } catch { return }
  scBusy.value = 'endpoint'
  try {
    const t = await api.sidecarEndpoint({ url: u, test: true })
    const note = t.ok ? '✅ 连通正常' : '⚠️ 探活失败（对方没响应，确认程序已启动；也可以先保存，等它启动后自动生效）'
    try {
      await ElMessageBox.confirm(`${note}。确认保存并启用该地址？`, '保存确认', {
        type: 'warning', confirmButtonText: '保存并启用', cancelButtonText: '不保存'
      })
    } catch { return }
    await api.sidecarEndpoint({ url: u })
    ElMessage.success('已启用自定义引擎地址：' + u)
    await loadSidecar()
  } catch (e) { ElMessage.error(e.message) } finally { scBusy.value = '' }
}

async function scRestoreBuiltin() {
  try {
    await ElMessageBox.confirm('恢复指向内置引擎（当前端口 ' + sc.value.port + '）。', '恢复内置引擎',
      { type: 'warning', confirmButtonText: '恢复' })
  } catch { return }
  scBusy.value = 'endpoint'
  try {
    await api.sidecarEndpoint({ builtin: true })
    ElMessage.success('已恢复内置引擎地址')
    await loadSidecar()
  } catch (e) { ElMessage.error(e.message) } finally { scBusy.value = '' }
}

const scHint = computed(() => {
  if (!sc.value) return ''
  if (sc.value.running) return '运行中 —— ZCode 免费额度（3 亿 token 池）经此供给网关'
  if (scInstalling.value) return '正在安装 —— 首次需下载约 66MB，进度见下方进度条'
  if (sc.value.custom) return '自定义引擎模式 —— 网关指向你自己运行的程序；内置引擎未安装不影响使用'
  if (!sc.value.hasKey || !sc.value.installed) return '未安装 —— 点「安装引擎」一键下载并配置，或「自定义引擎地址」指向你自己跑的兼容程序'
  // 卡死必须单独讲：它看起来像「没在跑」，处置却完全不同——直接点「启动」
  // 必然被端口拦下（EADDRINUSE），得先「停止」清掉那个不服务的进程。
  if (sc.value.probe === 'hung') {
    return '引擎卡死 —— 进程还在占着端口，但已不再响应 /health（常见于上游验证码风暴把引擎拖死）。'
      + '先点「停止」清掉它，再点「启动」'
  }
  return '已安装已配置，未运行 —— 点「启动」'
})

// scGuardTip 把保活守护的状态讲成人话。
//
// 为什么单独一条：引擎掉线后「谁在处理」是关键信息，此前页面只有一句
// 「installed, stopped」，用户不知道是系统正在自动救、还是已经放弃等人工，
// 也不知道它其实已经反复掉过很多次。三种情况的处置完全不同。
const scGuardTip = computed(() => {
  const g = sc.value && sc.value.guard
  if (!g || sc.value.running) return ''
  if (g.state === 'recovering') {
    const n = g.restarts ? `（已尝试 ${g.restarts} 次）` : ''
    const r = g.reaped ? `（已自动清场 ${g.reaped} 次）` : ''
    return `保活守护正在自动拉起引擎${n}${r}…`
  }
  if (g.state === 'failed') {
    // 已暂停：把真实原因和「要做什么」一起给出，别让用户对着一个红字猜。
    // 不再是「永久放弃」——冷却到期后守护会自己再试一轮，这里如实告知。
    return `保活守护已暂停自动重试（冷却后会再试，也可点「重置保活」立即恢复）—— ${g.lastError || '原因见引擎日志'}`
  }
  if (g.state === 'ok' && g.restarts > 0) {
    return `引擎曾被保活守护自动拉起（本进程累计 ${g.restarts} 次）`
  }
  return ''
})

onMounted(() => rescan(false)) // 首次加载走缓存，秒出；点「重新扫描」才实时探测
onMounted(loadSidecar)

// 导入共存登录态进账号池：token 由服务端读取落盘（不经过前端）。
const importing = ref('')
async function importAccount(f, a) {
  // id 取池子里下一个空闲编号，前缀与后端 shortAccountPrefix 对齐：
  // workbuddy（国内版）/ workbuddy-ai（海外版）/ 其余按 key。此前前端恒用 `wb-N`，
  // 与后端 `${key}-N` 口径不一致，两版账号混在同一个命名空间里也看不出归属。
  const id = nextAccountId(f.key)
  const credFile = `config/credentials/${id}-jwt`
  importing.value = a.tokenPath
  try {
    const acct = await api.importDiscoveredAccount({
      key: f.key, tokenPath: a.tokenPath,
      accountId: id, displayName: `${a.nickname}`,
      credentialFile: credFile
    })
    ElMessage.success(`已导入账号「${acct.displayName}」进账号池（${acct.id}）`)
    await rescan()
    await loadPool() // 刷新池子：按钮随即变「已在账号池」，重复点击不再 409
  } catch (e) { ElMessage.error(e.message) }
  finally { importing.value = '' }
}

// 已在账号池的账号（避免重复导入）
const pool = ref([])
const liveProviderIds = ref(new Set())
async function loadPool() {
  try {
    pool.value = (await api.accounts()) || []
  } catch { /* 忽略 */ }
  try {
    const ps = await api.providers()
    liveProviderIds.value = new Set(
      (ps || []).filter(p => p.state !== 'deleted').map(p => p.providerId)
    )
  } catch { /* 拉不到就退化为按整个账号池判定 */ }
}
onMounted(loadPool)
onMounted(loadProviderNames)

function imported(a) {
  // 后端列表已过滤孤儿账号；这里再按「归属 Provider 还在」兜一层，防止前端
  // 拿着缓存的旧 pool 让按钮一直显示「已在账号池」而实际导不进来。
  const rows = liveProviderIds.value.size
    ? pool.value.filter(x => liveProviderIds.value.has(x.providerId))
    : pool.value
  return rows.some(x => x.displayName === a.nickname)
}

// 账号 id 前缀：与后端 shortAccountPrefix 同口径（workbuddy / workbuddy-ai / key）。
// 两版分开编号，账号页一眼能看出这个号属于哪一版。
function accountPrefix(key) {
  return key || 'workbuddy'
}

function nextAccountId(key) {
  const prefix = accountPrefix(key)
  for (let n = 1; ; n++) {
    if (!pool.value.some(x => x.id === `${prefix}-${n}`)) return `${prefix}-${n}`
  }
}

async function adopt(f) {
  adopting.value = f.key
  try {
    const p = await api.adopt(f.key)
    const accts = (f.suggestedAccounts || []).filter(a => a.alive).length
    // 后端返回的是 Provider 本体（字段是 name / providerId，没有 id）：
    // 以前读 p.id 恒 undefined，采用成功也弹「已采用为 Provider「undefined」」。
    const label = `${p.name} (#${p.providerId})`
    ElMessage.success(accts > 0
      ? `已采用为 Provider「${label}」，${accts} 个登录态已入账号池，去 Provider 页确认模型`
      : `已采用为 Provider「${label}」，去 Provider 页确认模型`)
    // 同 Providers.vue：ElMessage 第二个位置参数是 appContext 而非选项，
    // { duration } 必须包进第一个参数对象，否则抛
    // 「Object prototype may only be an Object or null: undefined」。
    for (const w of p.warnings || []) ElMessage.warning({ message: w, duration: 6000 })
    await Promise.all([rescan(), loadPool()])
  } catch (e) { ElMessage.error(e.message) }
  finally { adopting.value = '' }
}

// gotoProviders：跳 Provider 页。发现页说「已接管」却不给去路时，用户会以为
// 自己被卡死了（尤其接管者是配置种进来的、id 与发现项草稿不同名的时候）。
// 本应用没有 vue-router，视图由 App.vue 的 view ref 切换，用自定义事件通知它。
const emit = defineEmits(['navigate'])
function gotoProviders() {
  emit('navigate', 'providers')
}
</script>

<template>
  <header class="page-head">
    <div>
      <h2>发现</h2>
      <p class="sub">扫描本机装过并登录过的 harness，只读本地登录态，不上传密钥。采用后生成 Provider，再去账号池确认额度。</p>
    </div>
    <div class="head-side">
      <span v-if="scannedAt" class="dim small">上次扫描 {{ scannedAt }}（用时 {{ elapsed }}）</span>
      <button class="btn" :disabled="scanning" @click="rescan">{{ scanning ? '扫描中…' : '重新扫描' }}</button>
    </div>
  </header>

  <p v-if="err" class="err">扫描失败：{{ err }}</p>

  <section class="panel sc-panel">
    <div class="sc-head">
      <h3>ZCode 本地引擎（sidecar）</h3>
      <span class="sc-state" :class="sc && sc.running ? 'ok' : 'dim'">
        {{ sc ? sc.status : '加载中…' }}
      </span>
    </div>
    <p class="sub">{{ scHint }}</p>
    <!-- 保活状态：引擎不在时，必须让人分清「正在自动恢复」「已放弃等人工」，
         以及「它已经悄悄掉过好几次了」。三种处置完全不同，不能都显示成一句
         「已停止」。 -->
    <p v-if="scGuardTip" class="sub sc-guard" :class="'g-' + sc.guard.state">{{ scGuardTip }}</p>
    <!-- 降级警告：引擎死了但请求被别的上游静默接走（同名模型被多个 Provider 声明），
         返回 200 看似一切正常。必须显性化，否则用户永远发现不了引擎已死。 -->
    <p v-if="sc && sc.degraded" class="sub sc-degraded">{{ sc.degraded.text }}</p>
    <div class="sc-actions">
      <!-- 安装中：进度条替代按钮。阶段/百分比/字节/耗时全部来自服务端作业态，
           切页或刷新回来接着显示——以前这里只有一个静止的「安装中…」。 -->
      <span v-if="scInstalling" class="sc-prog">
        <span class="sc-prog-head">
          <span class="sc-prog-phase">{{ scPhase }}</span>
          <span class="sc-prog-num num">{{ scProgressDetail }}</span>
        </span>
        <span class="sc-prog-track"><span class="sc-prog-fill" :class="{ indet: scPercent === null }"
          :style="scPercent === null ? {} : { width: scPercent + '%' }" /></span>
      </span>
      <!-- 暂停 / 取消：下载中途的两个出口，语义必须分开。
           · 暂停 = 停下但保留进度，下次续传
           · 取消 = 停下并丢弃已下的内容，下次从 0 开始（带二次确认） -->
      <button v-if="scInstalling" class="btn ghost" @click="scPause">暂停</button>
      <button v-if="scInstalling" class="btn ghost danger" @click="scCancel">取消</button>
      <template v-else-if="sc && sc.installed">
        <button v-if="!sc.running" class="btn" :disabled="scBusy === 'start'"
          @click="scAction('start')">{{ scBusy === 'start' ? '启动中…' : '启动' }}</button>
        <!-- 「停止」在卡死时也必须可见：running 只表示「能正常服务」，而卡死
             正是「进程在、端口占着、但不服务」——此时 running=false，按老判据
             按钮直接消失，用户既启不来又停不掉（实测死锁）。判据改成
             「运行中 或 卡死」：只要有进程占着，就给一个清掉它的出口。 -->
        <button v-if="sc.running || sc.probe === 'hung'" class="btn ghost" :disabled="scBusy === 'stop'"
          @click="scAction('stop', sc.probe === 'hung'
            ? '引擎已卡死（占着端口但不响应）。停止会强制结束它，随后可重新启动。'
            : '确定停止 ZCode 本地引擎？停止后免费额度不可用。')">
          {{ scBusy === 'stop' ? '停止中…' : '停止' }}</button>
        <button class="btn ghost" :disabled="scBusy === 'setup'" @click="scAction('setup')">
          {{ scBusy === 'setup' ? '配置中…' : '重新生成配置' }}</button>
        <button class="btn ghost" :disabled="scBusy === 'port'" @click="scChangePort">
          {{ scBusy === 'port' ? '改端口中…' : '改端口（当前 ' + sc.port + '）' }}</button>
        <button class="btn ghost danger" :disabled="scBusy === 'uninstall'"
          @click="scUninstall">{{ scBusy === 'uninstall' ? '卸载中…' : '卸载' }}</button>
      </template>
      <button v-else class="btn" @click="scInstall">{{ scError ? '重试安装' : '安装引擎' }}</button>
      <!-- 自定义入口不依赖内置引擎：卸载了也要能指向自己跑的程序 -->
      <button class="btn ghost" :disabled="scBusy === 'endpoint'" @click="scCustomEndpoint">
        {{ scBusy === 'endpoint' ? '测试中…' : '自定义引擎地址' }}</button>
      <button v-if="sc && sc.custom" class="btn ghost" :disabled="scBusy === 'endpoint'"
        @click="scRestoreBuiltin">恢复内置引擎</button>
      <!-- 登录授权：引擎装好了但没登录时给它一个网页内的出口。
           以前只有一句「去终端跑 … login」的文案，登录被赶出了网页。
           provider 可选：引擎支持 z.ai 与智谱两种账号（`auth login <zai|bigmodel>`），
           默认「自动」按本机 ZCode 客户端已登录的那个来，用户也能自己指定。 -->
      <template v-if="sc && sc.installed && !sc.running">
        <select v-model="scProvider" class="sc-provider" :disabled="scBusy === 'login'">
          <option value="">自动选择</option>
          <option value="zai">z.ai 账号</option>
          <option value="bigmodel">智谱（bigmodel）账号</option>
        </select>
        <button class="btn ghost" :disabled="scBusy === 'login'"
          @click="scLogin">{{ scBusy === 'login' ? '获取授权链接…' : '登录授权' }}</button>
      </template>
      <button class="btn ghost" @click="rescan">刷新状态</button>
      <!-- 重置保活：守护连续多次拉起失败后会暂停一段时间（等人处理），
           默认冷却后自己再试。用户手动处置完现场不必干等——这里给立即入口。 -->
      <button v-if="sc && sc.guard && sc.guard.state === 'failed'" class="btn ghost"
        :disabled="scBusy === 'reset-guard'" @click="scAction('reset-guard')">
        {{ scBusy === 'reset-guard' ? '重置中…' : '重置保活' }}</button>
    </div>
    <!-- 失败原因常驻（不是会消失的 toast）：切页回来仍看得到，并带出本次走的下载出口 -->
    <p v-if="scError" class="sc-err">
      {{ scError }}<span v-if="scProxy" class="dim">　下载代理 {{ scProxy }}</span>
    </p>
    <p v-if="sc && sc.endpoint" class="field-hint">
      引擎地址：<code>{{ sc.endpoint }}</code>（{{ sc.custom ? '自定义 —— 网关直接指向该地址，内置引擎不受影响' : '内置引擎' }}）
    </p>
    <!-- 下载走哪个代理要看得见：首次要下 ~66MB 的 release，直连会卡很久，
         只给一个转圈的「安装中…」用户没法判断是慢还是死了。 -->
    <p v-if="sc && sc.downloadProxy" class="field-hint">
      下载代理：<code>{{ sc.downloadProxy }}</code>
      <span class="dim">（{{ sc.downloadProxySource === 'direct'
        ? '直连 —— 国内网络可能很慢，可在 Providers 页配置出口代理'
        : '来源 ' + sc.downloadProxySource }}）</span>
    </p>
    <p class="field-hint">
      引擎是本机运行的官方社区工具（TriDefender/zcode-proxy），负责 ZCode 免费额度的验证与转发。
      首次使用：安装 → 配置 → 启动 → 点上方「登录授权」完成授权（引擎会自动打开浏览器），回网页点「启动」。
      二进制从其 GitHub Releases 下载（约 66MB），不由本仓分发；下载自动复用项目配置的出口代理。
    </p>
    <details class="api-spec">
      <summary>自定义引擎的接口格式（Anthropic 兼容）</summary>
      <div class="api-spec-body">
        <p>网关会打两个请求到你的地址，鉴权头 <code>x-api-key</code> / <code>Authorization: Bearer</code>
          （值 = <code>config/credentials/zcode-proxy-key</code>）：</p>
        <div class="api-row">
          <span class="api-method">GET</span><code class="api-path">/health</code>
          <span class="api-desc">探活，回 200 即可</span>
        </div>
        <div class="api-row">
          <span class="api-method">POST</span><code class="api-path">/v1/messages</code>
          <span class="api-desc">对话；流式回 SSE，非流式回 JSON</span>
        </div>
        <pre class="api-json">{<span class="k">"model"</span>: <span class="s">"glm-5.3-flash"</span>,
 <span class="k">"max_tokens"</span>: <span class="n">4096</span>,
 <span class="k">"messages"</span>: [
   { <span class="k">"role"</span>: <span class="s">"user"</span>,
     <span class="k">"content"</span>: <span class="s">"你好"</span> }
 ],
 <span class="k">"stream"</span>: <span class="b">true</span>}</pre>
      </div>
    </details>
  </section>

  <section v-for="(items, key) in groups" :key="key" class="group">
    <div class="group-head">
      <h3>{{ GROUP[key].title }} <span class="num count">{{ items.length }}</span></h3>
      <p class="sub">{{ GROUP[key].hint }}</p>
    </div>
    <div v-if="!items.length" class="empty">这一组是空的。</div>
    <div v-for="f in items" :key="f.key" class="finding" :class="groupOf(f)">
      <span class="dot" :class="dotClass[f.status]"></span>
      <div class="finding-main">
        <div class="finding-title">{{ f.harness }} <span class="dim">（{{ statusText[f.status] || f.status }}）</span></div>
        <div v-if="f.adoptedProviderId" class="adopted-note">
          已由 Provider「{{ adoptedName(f.adoptedProviderId) }}」接管
          <button class="linklike" @click="gotoProviders">去 Provider 页查看/删除</button>
        </div>
        <div class="finding-detail">{{ f.detail }}</div>
        <ul v-if="(f.actions || []).length" class="finding-actions">
          <li v-for="a in f.actions" :key="a">{{ a }}</li>
        </ul>
        <div v-if="(f.suggestedAccounts || []).length > 1" class="co-accounts">
          <p class="co-title">本机共存登录态（{{ f.suggestedAccounts.length }} 个，{{ f.suggestedAccounts.filter(a => a.alive).length }} 个有效）：</p>
          <div v-for="(a, i) in f.suggestedAccounts" :key="a.tokenPath" class="co-account">
            <span class="dot" :class="a.alive ? 'ok' : 'warn'"></span>
            <span class="co-name">{{ a.nickname }}</span>
            <!-- 版本徽标：国内版/海外版 token 互不通用，用户必须看得见自己在导哪一版 -->
            <span v-if="a.realm" class="realm-badge" :class="a.realm">{{ realmLabel(a.realm) }}</span>
            <span class="dim">{{ a.alive ? `有效期至 ${a.expiresAt}` : '已过期' }}</span>
            <button class="linklike" :disabled="importing === a.tokenPath || !a.alive || imported(a)"
              @click="importAccount(f, a)">
              {{ imported(a) ? '已在账号池' : importing === a.tokenPath ? '导入中…' : '导入账号池' }}
            </button>
          </div>
          <p class="field-hint">token 由服务端直接从登录态文件读取落盘（0600），不经过浏览器。</p>
        </div>
      </div>
      <!-- 采用按钮的显示条件：**只要本机发现了、且有可用草稿就给**。
           以前只有 ready 才渲染（groupOf(f) === 'ready'），于是联网探测没通过的项
           （unreachable/unknown/expired）在页面上连个按钮都没有——用户被告知
           「这也不能用」，却没有任何「先导进来再处理」的出口，被探测结论锁死。
           导入是本地动作（把本机发现翻译成 Provider 配置），不联网、不需要上游同意，
           探测结论该作为提示，不该作为禁止导入的闸门。 -->
      <button
        v-if="f.suggestedProvider"
        class="btn"
        :class="groupOf(f) === 'ready' ? 'primary' : 'ghost'"
        :disabled="adopting === f.key"
        :title="f.adoptedProviderId
          ? `已由「${adoptedName(f.adoptedProviderId)}」接管，点此跳到 Provider 页`
          : groupOf(f) === 'ready'
            ? '采用为 Provider 并导入本机登录态'
            : `探测未通过（${statusText[f.status] || f.status}）——仍可导入，导入后再按上面的指引处理`"
        @click="f.adoptedProviderId ? gotoProviders() : adopt(f)">
        {{ f.adoptedProviderId ? '去查看' : adopting === f.key ? '采用中…' : (groupOf(f) === 'ready' ? '采用' : '仍要采用') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.page-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-bottom: 20px; }
.page-head h2 { margin: 0 0 4px; font-size: 18px; }
.sub { color: var(--dim); margin: 0; font-size: 12px; max-width: 62ch; }
.head-side { display: flex; align-items: center; gap: 12px; flex: none; }
.small { font-size: 12px; }
.dim { color: var(--dim); }
.err { color: var(--bad); }
.btn {
  background: var(--accent); color: #0b1119; border: 0; border-radius: 6px;
  padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap;
}
.btn:disabled { opacity: 0.55; cursor: default; }
.btn.ghost { background: var(--panel-2, #1a222d); color: var(--text); border: 1px solid var(--line); }
.btn.primary { background: var(--ok); }
.group { margin-bottom: 22px; }
.group-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 10px; }
.group-head h3 { margin: 0; font-size: 14px; font-weight: 600; }
.count { color: var(--dim); font-size: 12px; }
.group-head .sub { font-size: 12px; }
.empty { color: var(--dim); font-size: 13px; padding: 10px 0; }
.finding {
  display: flex; align-items: flex-start; gap: 10px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 12px 14px; margin-bottom: 8px;
}
.finding.ready { border-left: 3px solid var(--ok); }
.finding.attention { border-left: 3px solid var(--warn); }
.finding.missing { opacity: 0.6; }
.finding .dot { margin-top: 5px; }
.finding-main { flex: 1; min-width: 0; }
.finding-title { font-size: 14px; font-weight: 600; }
.adopted-note { font-size: 12px; color: var(--ok); margin-top: 4px; }
.finding-detail { font-family: var(--mono); font-size: 12px; color: var(--dim); margin-top: 4px; word-break: break-all; }
.finding-actions { margin: 8px 0 0; padding-left: 18px; font-size: 12px; color: var(--text); }
.finding-actions li { margin-bottom: 2px; }
.finding .btn { flex: none; margin-top: 2px; }
.sc-panel { margin-bottom: 18px; }
.sc-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.sc-head h3 { margin: 0; font-size: 14px; font-weight: 600; }
.sc-state { font-size: 12px; }
.sc-state.ok { color: var(--ok); }
/* 保活提示：按状态上色，让「正在自动救」与「已放弃等人工」一眼可辨。
   变量名用 styles.css 里真实存在的 --warn / --bad（--ok/--dim 同源）。 */
.sc-guard { margin-top: 2px; }
.sc-guard.g-recovering { color: var(--warn); }
.sc-guard.g-failed { color: var(--bad); }
.sc-guard.g-ok { color: var(--dim); }
/* 降级警告：引擎死了但请求被别的上游静默接走（返回 200 看似正常）。
   必须显眼——用户看不到它，就永远发现不了引擎已死。 */
.sc-degraded {
  margin-top: 6px; padding: 6px 8px; border-radius: 6px;
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 12%, transparent);
  border-left: 3px solid var(--warn);
  line-height: 1.5;
}
.sc-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
/* 登录 provider 选择：跟着按钮的视觉走，别在按钮行里冒出一个系统默认灰框 */
.sc-provider {
  padding: 6px 8px; font-size: 12px; font-family: inherit;
  color: var(--text); background: var(--bg); border: 1px solid var(--line);
  border-radius: 6px; cursor: pointer;
}
.sc-provider:disabled { opacity: .5; cursor: default; }
/* 安装进度条：固定宽度，避免字节数变化时按钮行左右抖动 */
.sc-prog { display: block; width: 320px; }
.sc-prog-head { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; line-height: 1.4; }
.sc-prog-phase { color: var(--accent); }
.sc-prog-num { color: var(--dim); }
.sc-prog-track { display: block; height: 4px; margin-top: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
.sc-prog-fill { display: block; height: 100%; background: var(--accent); transition: width .3s linear; }
/* 上游/代理丢了 Content-Length 时不编假百分比：整条淡闪表示「在动但不知道到哪」 */
.sc-prog-fill.indet { width: 100%; opacity: .3; animation: sc-indet 1.4s ease-in-out infinite; }
@keyframes sc-indet { 0%, 100% { opacity: .18; } 50% { opacity: .45; } }
.sc-err { font-size: 12px; line-height: 1.6; color: var(--bad); margin: 8px 0 0; }
.sc-panel code { font-family: var(--mono); background: var(--panel-2); padding: 1px 5px; border-radius: 4px; }
.btn.danger { background: var(--bad, #c0392b); color: #fff; border: 0; }
.co-accounts { margin-top: 10px; border-top: 1px dashed var(--line); padding-top: 8px; }
.co-title { font-size: 12px; margin: 0 0 6px; color: var(--text); }
.co-account { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 12px; }
.co-account .dot { margin: 0; }
.co-name { font-weight: 600; min-width: 140px; }
.realm-badge {
  font-size: 11px; padding: 1px 6px; border-radius: 4px; flex: none;
  border: 1px solid var(--line); color: var(--dim);
}
.realm-badge.ai { color: var(--accent); border-color: var(--accent); }
.co-account .linklike { font-size: 12px; }

/* 自定义引擎接口规格：默认收起，点开是「方法 + 路径 + 用途」三列清单 + JSON 样例。
   终端清单风格（对齐整页 mono 度量语言），不另起炉灶。 */
.api-spec { margin: 8px 0 0; font-size: 12px; }
.api-spec summary {
  cursor: pointer; color: var(--dim); user-select: none;
  list-style: none; display: flex; align-items: center; gap: 6px;
}
.api-spec summary::before { content: '▸'; font-size: 10px; transition: transform .15s ease; }
.api-spec[open] summary::before { transform: rotate(90deg); }
.api-spec summary:hover { color: var(--text); }
.api-spec-body { margin: 8px 0 0; padding: 10px 12px; background: var(--panel-2);
  border: 1px solid var(--line); border-radius: 6px; }
.api-spec-body > p { margin: 0 0 8px; color: var(--dim); }
.api-row { display: flex; align-items: baseline; gap: 10px; padding: 3px 0; }
.api-method {
  font-family: var(--mono); font-size: 11px; font-weight: 600; flex: none;
  color: var(--ok); min-width: 42px;
}
.api-path { font-family: var(--mono); font-size: 12px; color: var(--accent); }
.api-desc { color: var(--dim); }
.api-json {
  margin: 8px 0 0; padding: 10px 12px; overflow-x: auto;
  background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
  font-family: var(--mono); font-size: 12px; line-height: 1.6; color: var(--text);
}
.api-json .k { color: var(--accent); }
.api-json .s { color: var(--ok); }
.api-json .n, .api-json .b { color: var(--warn); }
</style>
