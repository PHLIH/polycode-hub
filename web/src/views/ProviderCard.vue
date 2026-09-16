<script setup>
import { computed, ref, nextTick, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, AbortError } from '../api.js'

const props = defineProps({
  p: { type: Object, required: true },
  egresses: { type: Array, default: () => [] },
  testing: { type: Boolean, default: false },
  testRes: { type: Object, default: null }
})
const emit = defineEmits(['test', 'reload', 'models', 'edit', 'remove'])

const open = ref(false)

const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']
const KIND_LABELS = {
  official: '官方 API',
  'session-reuse': '复用登录态',
  'simulated-login': '模拟登录',
  reverse: '反向代理'
}
const RISK_LABELS = { low: '低风险', medium: '中风险', high: '高风险' }

const keyOf = (p, id) => `${p.providerId}/${id}`
const modelOf = (p, id) => ((p && p.models) || []).find(x => x.id === id)

// 展开行展示的就是「模型」按钮里勾选的那批——唯一的真相源（/v1/models 与测试候选同源）
const exposedModels = computed(() => (props.p.models || []).filter(m => m.enabled))
const exposedCount = computed(() => exposedModels.value.length)
const totalCount = computed(() => (props.p.models || []).length)

// 数据核对用：这些字段在创建表单里都填了，原表格一行也放不下，收进「接入信息」。
// API Key 默认只显示「引用来源」（环境变量名或文件路径）；明文按需现取现显，
// 不随列表下发、不落盘（后端 /credential 显式端点，见 adminapi/api.ts credentialView）。
const metaOpen = ref(false)
const cred = ref(null) // {source, present, value, hint}：点「查看明文」后才有
const credLoading = ref(false)
const credShown = ref(false)
async function toggleCred() {
  if (credShown.value) { credShown.value = false; return }
  if (!cred.value) {
    credLoading.value = true
    try { cred.value = await api.providerCredential(props.p.providerId) }
    catch (e) { ElMessage.error(`查看明文失败：${e.message}`); return }
    finally { credLoading.value = false }
  }
  credShown.value = true
}
async function copyCred() {
  const v = cred.value && cred.value.value ? cred.value.value : ''
  if (!v) return
  try {
    await navigator.clipboard.writeText(v)
    ElMessage.success('API Key 已复制')
  } catch {
    ElMessage.error('复制失败：浏览器拒绝了剪贴板')
  }
}
function apiKeyRef(p) {
  const c = (p && p.credential) || {}
  if (c.apiKeyFile) return `文件 ${c.apiKeyFile}`
  if (c.apiKeyEnv) return `env ${c.apiKeyEnv}`
  return '无（复用登录态或无需鉴权）'
}

// 本 Provider 名下的账号会接管鉴权：真实转发（proxy.ts）与探测（probe.ts）都取
// 该 Provider 第一个可用账号的凭据覆盖 Provider 凭据。所以卡片上「我配的 Key」
// 可能根本没在用——不标出来，用户会对着一个明明有效的 Key 排查半天 401。
const peerAccounts = ref([])
async function loadPeers() {
  if (!props.p.providerId) return
  try {
    const all = await api.accounts()
    peerAccounts.value = all.filter(a => a.providerId === props.p.providerId && a.status !== 'disabled')
  } catch { peerAccounts.value = [] }
}
onMounted(loadPeers)
const META = computed(() => [
  ['接入方式', KIND_LABELS[props.p.accessKind] || props.p.accessKind],
  ['风险', RISK_LABELS[props.p.risk] || props.p.risk],
  ['稳定性', props.p.stability],
  ['API Key', apiKeyRef(props.p)],
  ['出口', props.p.egress || '直连'],
  ['只走流式', props.p.streamOnly ? '是' : '否']
])
const metaLine = computed(() => META.value.filter(([k]) => k !== '风险' && k !== '稳定性')
  .map(([k, v]) => `${k} ${v}`).join('　'))

const riskClass = computed(() => (props.p.risk === 'high' ? 'bad' : props.p.risk === 'medium' ? 'warn' : ''))

const probeOptions = computed(() => exposedModels.value.map(m => m.id))
// 用 computed + 本地草稿，而不是 ref(props.p.probeModel)：
// 后者只在组件挂载时拷贝一次。父组件 refreshTarget 会用 splice 换成**新对象**
// （Providers.vue openModels → refreshTarget），props 更新了但这个 ref 仍是旧值，
// 下拉里显示的是过期模型。这里让显示值始终跟随 props，用户输入时走本地草稿。
const probeDraft = ref(null)
const probeModel = computed({
  get: () => (probeDraft.value ?? props.p.probeModel ?? ''),
  set: (v) => { probeDraft.value = v },
})

async function saveProbeModel() {
  const v = (probeModel.value || '').trim()
  try {
    await api.updateProvider(props.p.providerId, { probeModel: v })
    // 不要 mutate props（`props.p.probeModel = ...`）：那是在写父组件传下来的对象，
    // 靠副作用"碰巧生效"。父侧一旦换成新对象（refreshTarget / 重新拉列表）写入就丢，
    // 下拉会回弹成旧值。改为让父组件重新拉一次，由数据流驱动。
    probeDraft.value = null // 清草稿，回到以服务端数据为准
    emit('reload')
    emit('test', props.p)
  } catch (e) { ElMessage.error(e.message) }
}

// 行内协议：探到的结果即事实，也允许手工纠正（写入 models[].api）
const detecting = ref({}) // providerId/模型ID → true（探测中）
const detectCtrl = {} // providerId/模型ID → AbortController
// 可用性实测结果，按 providerId/模型ID 存
const scanRes = ref({})

function protoValue(p, id) {
  const m = modelOf(p, id)
  return (m && m.api) || ''
}
function protoPlaceholder(p, id) {
  const r = scanRes.value[keyOf(p, id)]
  if (r && !r.ok) {
    const e = r.error || ''
    if (e.includes('429')) return '429 限流'
    if (e.includes('401') || e.includes('403')) return '鉴权失败'
    if (e.includes('country') || e.includes('region')) return '地区限制'
    if (e.includes('超时')) return '超时'
    return '不可用'
  }
  return '未识别 · 继承默认'
}
function egressValue(p, id) {
  const m = modelOf(p, id)
  return (m && m.egress) || ''
}
// 就地回填行内模型：改完立刻反映在下拉上，不用整表重拉
function patchRowModel(p, id, key, val) {
  const m = modelOf(p, id)
  if (!m) return
  if (val) m[key] = val
  else delete m[key]
}

async function setModelProtocol(p, id, proto) {
  try {
    await api.updateProviderModelProtocol(p.providerId, id, proto)
    patchRowModel(p, id, 'api', proto)
    ElMessage.success(`${id} → ${proto || '继承 Provider 默认'}`)
  } catch (e) { ElMessage.error(e.message) }
}

async function setModelEgress(p, id, eg) {
  try {
    await api.updateProviderModelEgress(p.providerId, id, eg)
    patchRowModel(p, id, 'egress', eg)
    ElMessage.success(`${id} 出口 → ${eg || '直连'}`)
  } catch (e) { ElMessage.error(e.message) }
}

// 就地识别单个模型的协议：复用扫描接口（只传该模型），探到即写回并更新行内显示。
// 识别是真打上游，慢则几十秒——按钮在探测中变成「取消」，点了立即中断。
async function detect(p, id) {
  const k = keyOf(p, id)
  if (detecting.value[k]) { // 再点一次 = 取消
    detectCtrl[k]?.abort()
    return
  }
  const ctrl = new AbortController()
  detectCtrl[k] = ctrl
  detecting.value[k] = true
  try {
    const rs = await api.scanProviderModels(p.providerId, [id], { signal: ctrl.signal })
    const r = rs && rs[0]
    if (!r) throw new Error('无结果')
    scanRes.value[k] = r // 行内标签立即反映结果
    if (r.ok) {
      const m = modelOf(p, id)
      if (m && r.protocol) m.api = r.protocol // 协议已写回服务端，同步到本地行
    } else {
      ElMessage.error(`${id}：${(r.error || '').slice(0, 60)}`)
    }
  } catch (e) {
    // 主动取消不报错（用户自己按的），超时/失败才说
    if (e instanceof AbortError) {
      if (e.message.includes('超时')) ElMessage.warning(`${id}：${e.message}`)
    } else {
      ElMessage.error(`识别失败：${e.message}`)
    }
  } finally {
    delete detectCtrl[k]
    delete detecting.value[k]
    detecting.value = { ...detecting.value } // 触发响应式更新
  }
}

// 删除单个模型：手填错的/上游已下架的得能摘掉（PATCH models 只增不减）
async function removeModel(p, id) {
  try {
    await ElMessageBox.confirm(`从「${p.name}」删除模型 ${id}？`, '确认删除', { type: 'warning' })
  } catch { return }
  try {
    await api.deleteProviderModel(p.providerId, id)
    ElMessage.success(`已删除 ${id}`)
    emit('reload')
  } catch (e) { ElMessage.error(e.message) }
}

// 模型备注：一句话运维知识（「23 点后才免费，白天用会扣额度」这种），点开就地编辑
const noteEdit = ref('')
const noteDraft = ref('')
const noteInput = ref(null)

function startNote(p, id) {
  const k = keyOf(p, id)
  noteEdit.value = k
  noteDraft.value = modelOf(p, id)?.note || ''
  nextTick(() => {
    // v-if 在 v-for 里：ref 会退化成数组（模板引用数组），取最后一个才是刚渲染出的那个输入框
    const el = Array.isArray(noteInput.value) ? noteInput.value[noteInput.value.length - 1] : noteInput.value
    if (el) { el.focus(); el.select() }
  })
}
async function saveNote(p, id) {
  const k = keyOf(p, id)
  const m = modelOf(p, id)
  if (!m) return
  const note = noteDraft.value.trim()
  if (note === (m.note || '')) { noteEdit.value = ''; return } // 没改就不打接口
  try {
    await api.updateProviderModelNote(p.providerId, id, note)
    patchRowModel(p, id, 'note', note)
    noteEdit.value = ''
    ElMessage.success(note ? '备注已保存' : '备注已清除')
  } catch (e) { ElMessage.error(e.message) }
}

// 点整行开合；没有勾选任何模型时，点它直接去「模型」里勾——否则点了没反应像坏了
function onHeadClick() {
  if (exposedCount.value) open.value = !open.value
  else emit('models', props.p)
}

async function toggle() {
  try {
    await api.updateProvider(props.p.providerId, { state: props.p.state !== 'active' ? 'active' : 'paused' })
    emit('reload')
  } catch (e) { ElMessage.error(e.message) }
}
</script>

<template>
  <article class="strip" :class="{ off: p.state !== 'active', expanded: open }">
    <!-- 左侧状态脊：一路贯通的竖线，承载启用态与展开态 -->
    <div class="spine">
      <span class="spine-dot" :class="p.state === 'active' ? 'ok' : ''" />
      <span class="spine-line" :class="p.state === 'active' ? 'ok' : ''" />
    </div>

    <div class="body">
      <!-- 整行可点开合（点按钮/开关不算）：没有模型时点它直接去「模型」勾选 -->
      <div class="head" @click="onHeadClick">
        <button class="caret" :aria-expanded="open" :aria-label="open ? '收起模型' : '展开模型'"
          @click.stop="open = !open">
          <span class="caret-tri" :class="{ open }" />
        </button>

        <div class="ident">
          <div class="row1">
            <span class="name">{{ p.displayName || p.name }}</span>
            <span v-if="p.streamOnly" class="chip"
              title="上游只支持流式，非流式请求会跳过此源">只流式</span>
            <span v-if="p.risk !== 'low'" class="chip" :class="riskClass"
              :title="p.riskNote || ''">{{ RISK_LABELS[p.risk] || p.risk }}</span>
            <span v-if="p.stability !== 'stable'" class="chip warn"
              :title="p.riskNote || ''">{{ p.stability }}</span>
          </div>
          <div class="row2">
            <span class="mono id">{{ p.name }}</span>
            <span class="mono pid" :title="`内部 id（改名不变，账号与用量按它归因）`">#{{ p.providerId }}</span>
            <span class="sep" aria-hidden="true" />
            <span class="mono url" :title="p.baseUrl">{{ p.baseUrl }}</span>
            <span class="sep" aria-hidden="true" />
            <span class="mono proto">{{ p.api || '自动识别' }}</span>
          </div>
        </div>

        <div class="counts">
          <template v-if="exposedCount">
            <span class="num big">{{ exposedCount }}</span>
            <span class="count-label">模型</span>
            <span v-if="totalCount > exposedCount" class="dim small">/ {{ totalCount }} 已采用</span>
          </template>
          <span v-else class="none">未选模型</span>
        </div>

        <div class="acts">
          <button class="act" @click.stop="emit('models', p)">模型</button>
          <button class="act" :disabled="testing" @click.stop="emit('test', p)">
            {{ testing ? '测试中…' : '测试' }}</button>
          <button class="act" @click.stop="emit('edit', p)">编辑</button>
          <button class="act danger" @click.stop="emit('remove', p)">删除</button>
          <span class="vr" aria-hidden="true" />
          <el-switch :model-value="p.state === 'active'" @change="toggle" @click.stop />
        </div>
      </div>

      <div class="underline" aria-hidden="true" />

      <!-- 测试结果：就地显示，不另开弹框。放在模型总线之前，避免把每个模型都顶下去。 -->
      <div v-if="testing || testRes" class="result" :class="testRes ? (testRes.ok ? 'ok' : 'bad') : ''">
        <template v-if="testing">
          <span class="dot" /><span>正在打一次最小真实请求，最多 90 秒…</span>
        </template>
        <template v-else-if="testRes.ok">
          <span class="dot ok" /><span>打通 · 首字延迟</span>
          <span class="mono">{{ testRes.latencyMs }}ms</span>
          <span class="dim">· 用模型</span>
          <span class="mono">{{ testRes.model }}</span>
          <span v-if="testRes.text" class="dim">· {{ testRes.text }}</span>
        </template>
        <template v-else>
          <span class="dot bad" /><span>失败</span>
          <span class="msg">{{ testRes.error }}</span>
        </template>
        <button class="act" :disabled="testing" @click="emit('test', p)">重测</button>
      </div>

      <!-- 模型总线：竖线 + 分支，每格一个模型；不暴露的模型不出现在这里 -->
      <div v-if="open && exposedCount" class="bus">
        <div v-for="m in exposedModels" :key="m.id" class="lane">
          <span class="lane-wire" aria-hidden="true" />

          <span class="lane-id mono" :title="m.id">{{ m.id }}</span>

          <span class="lane-note">
            <input v-if="noteEdit === keyOf(p, m.id)" ref="noteInput" v-model="noteDraft"
              class="note-input" maxlength="200" placeholder="如「23 点后才免费」"
              @keyup.enter="saveNote(p, m.id)" @keyup.esc="noteEdit = ''" @blur="saveNote(p, m.id)">
            <template v-else>
              <button class="note-btn" :class="{ has: m.note }" :title="m.note || '加一句备注'"
                @click="startNote(p, m.id)">{{ m.note ? '备注' : '＋备注' }}</button>
              <span v-if="m.note" class="note-text" :title="m.note">{{ m.note }}</span>
            </template>
          </span>

          <el-select :model-value="protoValue(p, m.id)" size="small" class="lane-sel"
            :placeholder="protoPlaceholder(p, m.id)" :title="protoValue(p, m.id) || protoPlaceholder(p, m.id)"
            clearable filterable @change="v => setModelProtocol(p, m.id, v || '')">
            <el-option v-for="pp in PROTOCOLS" :key="pp" :value="pp" :label="pp" />
          </el-select>

          <el-select :model-value="egressValue(p, m.id)" size="small" class="lane-sel"
            placeholder="直连" :title="egressValue(p, m.id) || '直连'" clearable
            @change="v => setModelEgress(p, m.id, v || '')">
            <el-option v-for="e in egresses" :key="e.id" :value="e.id" :label="e.id" />
          </el-select>

          <span class="lane-detect">
            <button class="act tiny" :class="{ busy: detecting[keyOf(p, m.id)] }"
              :title="detecting[keyOf(p, m.id)] ? '正在探测，点此取消' : '探测这个模型的协议与可用性'"
              @click="detect(p, m.id)">{{ detecting[keyOf(p, m.id)] ? '取消' : '识别' }}</button>
            <span v-if="scanRes[keyOf(p, m.id)]" class="mono scan"
              :class="scanRes[keyOf(p, m.id)].ok ? 'ok' : 'bad'"
              :title="scanRes[keyOf(p, m.id)].error || ''">
              {{ scanRes[keyOf(p, m.id)].ok ? '✓ ' + (scanRes[keyOf(p, m.id)].latencyMs || '?') + 'ms' : '✗ 不通' }}
            </span>
          </span>

          <button class="act tiny danger" title="从该 Provider 删除这个模型"
            @click="removeModel(p, m.id)">删除</button>
        </div>
      </div>

      <p v-else-if="open" class="bus-empty">
        还没有勾选任何模型 —— 打开「模型」从上游目录勾选，勾中的才会对外暴露。
      </p>

      <div class="foot">
        <button class="meta-toggle" @click="metaOpen = !metaOpen">
          <span class="caret-tri small" :class="{ open: metaOpen }" />接入信息
        </button>
        <span v-if="!metaOpen" class="dim meta-line">{{ metaLine }}</span>
        <span v-if="p.riskNote && !metaOpen" class="risk-note" :title="p.riskNote">{{ p.riskNote }}</span>
      </div>
      <div v-if="metaOpen" class="meta-wrap">
      <p v-if="peerAccounts.length" class="takeover-note">
        鉴权已被账号池接管：本 Provider 名下 <span class="mono">{{ peerAccounts.map(a => a.id).join('、') }}</span>
        的凭据会覆盖 Provider 自己配的 Key（转发与测试同一条规则）。
        上面那行「API Key」只在账号全部停用/失效时才生效。
      </p>
      <dl class="meta">
        <div v-for="[k, v] in META" :key="k" class="meta-row">
          <dt>{{ k }}</dt>
          <dd v-if="k !== 'API Key'">{{ v }}</dd>
          <dd v-else class="cred-dd">
            <span>{{ v }}</span>
            <button class="act tiny" :disabled="credLoading" @click="toggleCred">
              {{ credLoading ? '读取中…' : (credShown ? '隐藏明文' : '查看明文') }}</button>
            <template v-if="credShown && cred">
              <span v-if="!cred.present" class="dim cred-hint">{{ cred.hint || '暂无可用明文' }}</span>
              <template v-else>
                <code class="mono cred-val">{{ cred.value }}</code>
                <button class="act tiny" @click="copyCred">复制</button>
              </template>
            </template>
          </dd>
        </div>
        <p v-if="p.riskNote" class="risk-full">{{ p.riskNote }}</p>
      </dl>
      </div>

      <div v-if="open || testRes || testing" class="probe-row">
        <span class="dim">测试模型</span>
        <el-select v-if="probeOptions.length" v-model="probeModel" size="small" class="probe-sel"
          filterable allow-create default-first-option clearable placeholder="留空取第一个启用模型"
          @change="saveProbeModel">
          <el-option v-for="id in probeOptions" :key="id" :value="id" :label="id" />
        </el-select>
        <span v-else class="dim">这个 Provider 还没有启用模型，测试没有对象。</span>
      </div>
    </div>
  </article>
</template>

<style scoped>
/* 一条 Provider = 配电盘上的一路通道条：左侧状态脊承载启用/展开态，
   展开后每条模型挂在一条竖线上——竖线是「属于这路」的信息，不是装饰。 */
.strip {
  display: flex; align-items: stretch;
  border: 1px solid var(--line); border-radius: var(--r-box);
  background: var(--panel); margin-bottom: 10px;
}
.strip.expanded { background: var(--panel-2); }
/* 停用：整条退到背景里，但状态与操作保留可点（不是禁用态） */
.strip.off { background: color-mix(in srgb, var(--bg) 55%, var(--panel)); }
.strip.off .name, .strip.off .lane-id { color: var(--dim); }

/* 状态脊 */
.spine { flex: none; width: 16px; display: flex; flex-direction: column; align-items: center; padding: 14px 0 12px; }
.spine-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); flex: none; }
.spine-dot.ok { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 18%, transparent); }
.spine-line { flex: 1; width: 1px; margin-top: 6px; background: var(--line); }
.spine-line.ok { background: color-mix(in srgb, var(--ok) 40%, var(--line)); }

.body { flex: 1; min-width: 0; padding: 12px 16px 12px 4px; }

.head { display: flex; align-items: center; gap: 12px; cursor: default; }
.caret {
  flex: none; width: 20px; height: 20px; display: grid; place-items: center;
  border: 0; background: none; border-radius: var(--r-ctl); cursor: pointer; padding: 0;
}
.caret:hover { background: color-mix(in srgb, var(--bg) 60%, transparent); }
.caret:disabled { cursor: default; opacity: .35; }
/* CSS 三角：不依赖字体里有没有 ▸ 字形 */
.caret-tri {
  width: 0; height: 0; border-top: 4px solid transparent; border-bottom: 4px solid transparent;
  border-left: 6px solid var(--dim); transition: transform .15s ease;
}
.caret:hover .caret-tri { border-left-color: var(--text); }
.caret-tri.open { transform: rotate(90deg); }
.caret-tri.small { border-top-width: 3px; border-bottom-width: 3px; border-left-width: 5px; }

.ident { flex: 1; min-width: 0; }
.row1 { display: flex; align-items: baseline; gap: 8px; }
.name { font-size: 14px; font-weight: 600; letter-spacing: .01em; }
.row2 { display: flex; align-items: baseline; gap: 0; margin-top: 3px; font-size: 11.5px; color: var(--dim); min-width: 0; }
.id { color: var(--dim); }
/* 内部 id：改名不变的身份，展示在名字旁边（用户要能对上归因表里的 #N） */
.pid { color: var(--dim); opacity: .7; margin-left: 5px; font-size: 11px; }
.url, .proto { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 34ch; }
/* 1px 竖线代替「·」连接元信息（中点是生成式默认） */
.sep { display: inline-block; width: 1px; height: 9px; background: var(--line); margin: 0 9px; }

.chip {
  flex: none; font-size: 10px; padding: 1px 8px; border-radius: var(--r-chip);
  border: 1px solid var(--line); color: var(--dim); white-space: nowrap;
}
.chip.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
.chip.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, transparent); }

.counts { flex: none; display: flex; align-items: baseline; gap: 5px; }
.num.big { font-size: 19px; line-height: 1; font-weight: 600; }
.count-label, .small { font-size: 11px; color: var(--dim); }
.none { font-size: 11px; color: var(--warn); }

.acts { flex: none; display: flex; align-items: center; gap: 4px; }
.vr { width: 1px; height: 14px; background: var(--line); margin: 0 6px; }

.act {
  border: 1px solid transparent; background: none; color: var(--dim);
  border-radius: var(--r-ctl); padding: 4px 10px; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.act:hover { color: var(--text); border-color: var(--line); }
.act:disabled { opacity: .45; cursor: default; }
.act:disabled:hover { color: var(--dim); border-color: transparent; }
.act.danger:hover { color: var(--bad); border-color: var(--bad); }
.act.tiny { padding: 2px 6px; font-size: 11px; }
.act.busy { color: var(--warn); border-color: var(--warn); }

/* 头部与下面的内容之间的 1px 规则 */
.underline { height: 1px; background: var(--line); margin: 10px 0 0; }

/* 测试结果条 */
.result {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 10px; padding: 8px 12px; font-size: 12px;
  border-left: 2px solid var(--dim); border-radius: 0 var(--r-ctl) var(--r-ctl) 0;
  background: color-mix(in srgb, var(--bg) 45%, transparent);
}
.result.ok { border-left-color: var(--ok); }
.result.bad { border-left-color: var(--bad); }
.result .msg { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result .act { margin-left: auto; }

/* 模型总线：竖线 + 每格一个分支，一眼看出这些模型挂在这一路上 */
.bus { margin-top: 10px; }
.lane {
  display: flex; align-items: center; gap: 10px; padding: 3px 0;
}
/* 竖线 + 引出到内容的小横线，构成一条分支 */
.lane-wire {
  flex: none; width: 13px; align-self: stretch; margin-right: 3px;
  position: relative;
}
/* 竖线 + 圆角弯头：硬拐 90° 是整个页面最尖的一处，用一段 1px 弧线过渡掉 */
.lane-wire::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 50%;
  width: 8px; border-left: 1px solid var(--line);
  border-bottom: 1px solid var(--line); border-bottom-left-radius: 6px;
}
.lane-wire::after {
  content: ''; position: absolute; left: 8px; top: 50%;
  width: 5px; height: 1px; background: var(--line);
}
.lane:hover .lane-wire::before { border-color: var(--accent); }
.lane-id { flex: 1 1 auto; min-width: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lane-note { flex: none; width: 190px; min-width: 0; display: flex; align-items: center; gap: 6px; }
.note-btn {
  flex: none; border: 1px solid var(--line); background: none; color: var(--dim);
  border-radius: var(--r-chip); padding: 1px 8px; font-size: 11px; cursor: pointer; white-space: nowrap;
}
.note-btn:hover { color: var(--accent); border-color: var(--accent); }
.note-btn.has { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.note-text { font-size: 11px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.note-input {
  width: 100%; min-width: 0; background: var(--bg); color: var(--text);
  border: 1px solid var(--accent); border-radius: var(--r-ctl); padding: 2px 8px; font-size: 11.5px; font-family: inherit;
}
/* 安静下拉：无边框无底色，只留文字；hover/focus 才显形。
   协议/出口是配一次长期不动的，不配拥有两个常驻框。 */
.lane-sel { flex: 0 0 176px; width: 176px; }
.lane-sel :deep(.el-select__wrapper) {
  background: none; box-shadow: none; border: 1px solid transparent;
  border-radius: var(--r-ctl); min-height: 26px; padding: 0 8px;
}
.lane-sel :deep(.el-select__wrapper:hover) { border-color: var(--line); }
.lane-sel :deep(.el-select__wrapper.is-focused) { background: var(--bg); border-color: var(--accent); }
.lane-sel :deep(.el-select__placeholder) { color: var(--dim); }
.lane-detect { flex: none; width: 104px; display: flex; align-items: center; gap: 6px; }
.scan { font-size: 11px; }
.scan.ok { color: var(--ok); }
.scan.bad { color: var(--bad); }

.bus-empty { font-size: 12px; color: var(--dim); margin: 10px 0 2px; }

/* 接入信息：低频核对用的字段，默认一行摘要，展开是完整的键值表 */
.foot { display: flex; align-items: center; gap: 10px; margin-top: 10px; min-width: 0; }
.meta-toggle {
  flex: none; display: inline-flex; align-items: center; gap: 6px;
  border: 0; background: none; color: var(--dim); font-size: 11.5px; cursor: pointer; padding: 2px 0;
}
.meta-toggle:hover { color: var(--text); }
.meta-line { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.risk-note { font-size: 11px; color: var(--warn); flex: none; max-width: 30ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { margin: 0; padding: 8px 0 0; font-size: 11.5px; }
.meta-row { display: flex; gap: 12px; padding: 3px 0; }
.meta-row dt { width: 66px; flex: none; color: var(--dim); margin: 0; }
.meta-row dd { margin: 0; color: var(--text); }
.cred-dd { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.cred-val {
  max-width: 34ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  background: var(--bg); border: 1px solid var(--line); border-radius: var(--r-ctl);
  padding: 1px 8px; font-size: 11.5px; user-select: all;
}
.cred-hint { font-size: 11px; }
.risk-full { margin: 6px 0 0; font-size: 11.5px; color: var(--warn); }
/* 鉴权被同源账号接管：这是「我配的 Key 为什么没用」的答案，必须显眼 */
.takeover-note {
  margin: 8px 0 0; padding: 7px 10px; font-size: 11.5px; line-height: 1.6;
  color: var(--warn); border-radius: var(--r-ctl);
  background: color-mix(in srgb, var(--warn) 8%, transparent);
  border-left: 2px solid var(--warn);
}
.takeover-note .mono { overflow-wrap: anywhere; }

.probe-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; font-size: 12px; }
.probe-sel { width: 300px; }
.dim { color: var(--dim); }
.mono { font-family: var(--mono); }
.num { font-variant-numeric: tabular-nums; }

@media (max-width: 1100px) {
  .lane-note { width: 120px; }
  .lane-sel { flex-basis: 140px; width: 140px; }
  .url, .proto { max-width: 20ch; }
}
@media (max-width: 820px) {
  .head { flex-wrap: wrap; }
  .counts { order: 3; }
  .acts { order: 4; margin-left: auto; }
  .lane { flex-wrap: wrap; }
  .lane-id { flex-basis: 100%; }
  .lane-wire { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .caret-tri { transition: none; }
}
</style>
