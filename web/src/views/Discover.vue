<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api.js'

const list = ref([])
const err = ref('')
const scanning = ref(false)
const adopting = ref('')
const scannedAt = ref('')
const elapsed = ref('')

const GROUP = {
  ready: { title: '可采用', hint: '登录态有效，点采用即生成 Provider 并把桌面登录态导入账号池' },
  attention: { title: '需处理', hint: '照下面的提示处理好再采用' },
  missing: { title: '未发现', hint: '本机没装或没登录过这些 harness' }
}
const ATTENTION = new Set(['expired', 'unknown', 'unreachable'])
const statusText = { ready: '可采用', expired: '已过期', missing: '未发现', unknown: '待确认', unreachable: '不可达' }
const dotClass = { ready: 'ok', expired: 'warn', unknown: 'warn', unreachable: 'bad', missing: '' }

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

async function rescan() {
  if (scanning.value) return
  scanning.value = true
  err.value = ''
  const t0 = performance.now()
  try {
    list.value = await api.discover()
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
const sc = ref(null)
const scBusy = ref('')

async function loadSidecar() {
  try { sc.value = await api.sidecarStatus() } catch { sc.value = null }
}

async function scAction(action, confirmText) {
  if (confirmText && !window.confirm(confirmText)) return
  scBusy.value = action
  try {
    const r = await api.sidecarAction(action)
    ElMessage.success(r.message || `已${action === 'start' ? '启动' : action === 'stop' ? '停止' : '完成'}`)
    await Promise.all([loadSidecar(), rescan()])
  } catch (e) { ElMessage.error(e.message) } finally { scBusy.value = '' }
}

async function scInstall() {
  scBusy.value = 'ensure'
  try {
    await api.sidecarAction('ensure')
    ElMessage.success('引擎已安装并就绪')
    await loadSidecar()
  } catch (e) { ElMessage.error(e.message) } finally { scBusy.value = '' }
}

async function scUninstall() {
  // 双确认：第一步确认卸载，第二步确认是否连配置/日志一起清
  try {
    await ElMessageBox.confirm(
      '卸载会删除引擎二进制与网关侧鉴权 key。登录凭据（OAuth 身份）不受影响。',
      '卸载 ZCode 本地引擎', { type: 'warning', confirmButtonText: '继续' })
  } catch { return }
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
  if (sc.value.custom) return '自定义引擎模式 —— 网关指向你自己运行的程序；内置引擎未安装不影响使用'
  if (!sc.value.hasKey || !sc.value.installed) return '未安装 —— 点「安装引擎」一键下载并配置，或「自定义引擎地址」指向你自己跑的兼容程序'
  return '已安装已配置，未运行 —— 点「启动」'
})

onMounted(rescan)
onMounted(loadSidecar)

// 导入共存登录态进账号池：token 由服务端读取落盘（不经过前端）。
const importing = ref('')
// 注意：credFileOf 恒为空（历史残留），实际恒走 `config/credentials/${id}-jwt` 分支。
const credFileOf = {} // 建议 id → 凭据文件路径（与展示顺序一致）

async function importAccount(f, a) {
  // id 取池子里下一个空闲编号（恒为 wb-N 形态；非 workbuddy 源的后端惯例是 ${key}-N，
  // 见 discover_api.ts shortAccountPrefix，前后端此处口径不一致，改动时注意）。
  const id = nextAccountId()
  const credFile = credFileOf[a.tokenPath] || `config/credentials/${id}-jwt`
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
async function loadPool() {
  try {
    pool.value = (await api.accounts()) || []
  } catch { /* 忽略 */ }
}
onMounted(loadPool)

function imported(a) {
  return pool.value.some(x => x.displayName === a.nickname)
}

function nextAccountId() {
  for (let n = 1; ; n++) {
    if (!pool.value.some(x => x.id === `wb-${n}`)) return `wb-${n}`
  }
}

async function adopt(f) {
  adopting.value = f.key
  try {
    const p = await api.adopt(f.key)
    const accts = (f.suggestedAccounts || []).filter(a => a.alive).length
    ElMessage.success(accts > 0
      ? `已采用为 Provider「${p.id}」，${accts} 个登录态已入账号池，去 Provider 页确认模型`
      : `已采用为 Provider「${p.id}」，去 Provider 页确认模型`)
    for (const w of p.warnings || []) ElMessage.warning(w, { duration: 6000 })
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
    <div class="sc-actions">
      <template v-if="sc && sc.installed">
        <button v-if="!sc.running" class="btn" :disabled="scBusy === 'start'"
          @click="scAction('start')">{{ scBusy === 'start' ? '启动中…' : '启动' }}</button>
        <button v-if="sc.running" class="btn ghost" :disabled="scBusy === 'stop'"
          @click="scAction('stop', '确定停止 ZCode 本地引擎？停止后免费额度不可用。')">
          {{ scBusy === 'stop' ? '停止中…' : '停止' }}</button>
        <button class="btn ghost" :disabled="scBusy === 'setup'" @click="scAction('setup')">
          {{ scBusy === 'setup' ? '配置中…' : '重新生成配置' }}</button>
        <button class="btn ghost" :disabled="scBusy === 'port'" @click="scChangePort">
          {{ scBusy === 'port' ? '改端口中…' : '改端口（当前 ' + sc.port + '）' }}</button>
        <button class="btn ghost danger" :disabled="scBusy === 'uninstall'"
          @click="scUninstall">{{ scBusy === 'uninstall' ? '卸载中…' : '卸载' }}</button>
      </template>
      <button v-else class="btn" :disabled="scBusy === 'ensure'" @click="scInstall">
        {{ scBusy === 'ensure' ? '安装中…' : '安装引擎' }}</button>
      <!-- 自定义入口不依赖内置引擎：卸载了也要能指向自己跑的程序 -->
      <button class="btn ghost" :disabled="scBusy === 'endpoint'" @click="scCustomEndpoint">
        {{ scBusy === 'endpoint' ? '测试中…' : '自定义引擎地址' }}</button>
      <button v-if="sc && sc.custom" class="btn ghost" :disabled="scBusy === 'endpoint'"
        @click="scRestoreBuiltin">恢复内置引擎</button>
      <button class="btn ghost" @click="rescan">刷新状态</button>
    </div>
    <p v-if="sc && sc.endpoint" class="field-hint">
      引擎地址：<code>{{ sc.endpoint }}</code>（{{ sc.custom ? '自定义 —— 网关直接指向该地址，内置引擎不受影响' : '内置引擎' }}）
    </p>
    <p class="field-hint">
      引擎是本机运行的官方社区工具（TriDefender/zcode-proxy），负责 ZCode 免费额度的验证与转发。
      首次使用：安装 → 配置 → 启动 → 在终端跑一次 <code>polycode-hub zcode sidecar login</code> 完成授权。
      二进制从其 GitHub Releases 下载，不由本仓分发。
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
          已由 Provider「{{ f.adoptedProviderId }}」接管
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
            <span class="dim">{{ a.alive ? `有效期至 ${a.expiresAt}` : '已过期' }}</span>
            <button class="linklike" :disabled="importing === a.tokenPath || !a.alive || imported(a)"
              @click="importAccount(f, a)">
              {{ imported(a) ? '已在账号池' : importing === a.tokenPath ? '导入中…' : '导入账号池' }}
            </button>
          </div>
          <p class="field-hint">token 由服务端直接从登录态文件读取落盘（0600），不经过浏览器。</p>
        </div>
      </div>
      <button
        v-if="groupOf(f) === 'ready'"
        class="btn primary"
        :disabled="adopting === f.key"
        :title="f.adoptedProviderId ? `已由「${f.adoptedProviderId}」接管，点此跳到 Provider 页` : ''"
        @click="f.adoptedProviderId ? gotoProviders() : adopt(f)">
        {{ f.adoptedProviderId ? '去查看' : adopting === f.key ? '采用中…' : '采用' }}
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
.sc-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.sc-panel code { font-family: var(--mono); background: var(--panel-2); padding: 1px 5px; border-radius: 4px; }
.btn.danger { background: var(--bad, #c0392b); color: #fff; border: 0; }
.co-accounts { margin-top: 10px; border-top: 1px dashed var(--line); padding-top: 8px; }
.co-title { font-size: 12px; margin: 0 0 6px; color: var(--text); }
.co-account { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 12px; }
.co-account .dot { margin: 0; }
.co-name { font-weight: 600; min-width: 140px; }
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
