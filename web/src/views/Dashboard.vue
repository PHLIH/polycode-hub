<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api.js'
import { shareOf, shareTitle } from '../share'
import { applyGroups, applyGroupsReport, rowKey } from '../mergeGroups'

// 概览页：用量仪表盘。三块——
//   ① 热力图（每天一格，token 越多越绿，GitHub 贡献图那种）
//   ② 按 provider/model 归因（额度到底花在哪）
//   ③ 区间合计与缓存命中率
// 两套独立时间语境（TIME-RANGE-FILTER §3.4 方案 B 分离，用户拍板）：
//   热力图 = 长周期铺满趋势（365 天铺满，独立请求，胶囊管不到它）；
//   归因区 = 前三张 stat card + 归因表跟胶囊（今天/7/30/自定义短区间）。
//   例外：第四张「活跃天数」跟热力图（全周期），卡片上有「近一年」徽标注明。
const heatBd = ref(null)   // 热力图数据（days 长区间，只用 daily）
const attrBd = ref(null)   // 归因区数据（胶囊区间：totals + byModel）
const providers = ref([])
const err = ref('')
// 默认「今天」：概览首屏关心的是当下用了多少，30 天聚合会把当天变化冲淡（用户拍板）。
const range = ref({ mode: 'today' })  // {mode:'today'|'7d'|'30d'} 或 {mode:'custom', since, until}（YYYY-MM-DD，含当日）

const RANGE_LABELS = { today: '今天', '7d': '近 7 天', '30d': '近 30 天' }
const rangeLabel = computed(() =>
  range.value.mode === 'custom'
    ? `自定义 ${range.value.since.slice(5)}~${range.value.until.slice(5)}`
    : RANGE_LABELS[range.value.mode])

// range → API 参数（自然日口径：今天 = 今日 00:00 起；近 N 天 = 含今日的 N 个本地日历日）。
// 之前预设档发的是 {days} 滚动窗口（近 24h / 7×24h）：库里只有两天数据时切哪个档结果
// 都一样，看起来就像「筛选根本没用」。改走 since/until 日历日后，后端按本地日分组
// 过滤（localtime），与热力图的口径一致。热力图是独立的 365 天请求，不走这里。
const RANGE_DAYS = { today: 1, '7d': 7, '30d': 30 }
const rangeQuery = computed(() => {
  if (range.value.mode === 'custom') return { since: range.value.since, until: range.value.until }
  const end = new Date()
  end.setHours(0, 0, 0, 0)
  const start = new Date(end)
  start.setDate(start.getDate() - ((RANGE_DAYS[range.value.mode] ?? 30) - 1))
  // localDay 在下方函数声明（提升可用）：与后端 daily 的 localtime 分组同口径
  return { since: localDay(start), until: localDay(end) }
})
// 浮层卡片状态
const pillOpen = ref(false)
const customRange = ref([]) // el-date-picker daterange（value-format → [YYYY-MM-DD, YYYY-MM-DD]）
const canApplyCustom = computed(() =>
  Array.isArray(customRange.value) && !!customRange.value[0] && !!customRange.value[1])
const noFuture = (d) => d.getTime() > Date.now()
// 打开时把当前自定义区间回填进选择器（预设模式则清空，上次残留不误导）
watch(pillOpen, (open) => {
  if (!open) return
  customRange.value = range.value.mode === 'custom' ? [range.value.since, range.value.until] : []
})

function pick(mode) {
  range.value = { mode }
  pillOpen.value = false
  load()
}
function applyCustom() {
  const [since, until] = customRange.value || []
  if (!since || !until || until < since) {
    ElMessage.warning('请选择有效的起止日期')
    return
  }
  range.value = { mode: 'custom', since, until }
  pillOpen.value = false
  load()
}

const METRICS_LABEL = '总 token' // 热力图着色口径（下拉已移除，固定总 token）

async function load() {
  try {
    const [hb, ab, ps] = await Promise.all([
      api.breakdown({ days: heatDays }),
      api.breakdown(rangeQuery.value),
      api.providers().catch(() => [])
    ])
    heatBd.value = hb || {}
    attrBd.value = ab || {}
    providers.value = ps
    err.value = ''
    page.value = 1
  } catch (e) {
    err.value = e.message
  }
}

onMounted(load)

// ---- 数字格式化 ----
function fmt(n) {
  if (n == null) return '—'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}
function pct(v) {
  if (!v) return '0%'
  return (v * 100).toFixed(1) + '%'
}

// ---- 热力图 ----
// 布局契约（用户拍板，2026-09-14）：
//   ① 不展示星期维度（行标去掉）——格子只表达「某天用了多少」；
//   ② 今天恒在右下角最后一格；每过一天整体左移一格，格子总数恒定；
//   ③ 月份标签跟随真实月份：某列的日期跨进新月份就在该列上方标出来。
// 做法：列优先铺满 ROWS 行（idx → 列 = idx/rows，行 = idx%rows），固定 COLS×ROWS 格。
//
// 行数自适应（2026-09-17，用户要求「横向铺满；正方形等比放大会让那一栏不够高时，
// 减少每列的正方形数量」）：
//   格子是正方形且横向铺满 → 边长 s 由容器宽度定，整块高度 = rows*s + (rows-1)*gap。
//   宽度越大 s 越大、整块越高。超过高度上限就减少 rows（列数相应增加），
//   这样既铺满横向、又不把面板撑高。
//   上限 HEAT_MAX_H 是「这块热力图最多占多高」的产品选择，不是硬约束。
// 目标天数：格子数 = cols × rows，取整后实际覆盖 365~371 天（略微多于一年，不会少）——
// 「近一年」是语义，不追求恰好 365 格：多出的几格是最早那几天，不影响「今天在右下角」。
const heatDays = 365
const HEAT_MAX_H = 168 // 高度上限（px）：超过就减行数换更多列
const GAP_PX = 3       // 与 CSS 的 gap 一致（格子间距）

// 容器可用宽度。用 ResizeObserver 实测——CSS 里是 flex 均分，
// 纯算术推不出（受侧栏折叠、滚动条、padding 影响）。
const heatWrapEl = ref(null)
const heatWidth = ref(0)
let heatRO = null
// 实测宽度 → 选行数：在「铺满宽度」的前提下，取满足高度上限的最大行数。
const heatRows = computed(() => {
  const W = heatWidth.value
  if (!W || W < 100) return 7 // 未测到（首帧）：用默认 7 行，避免闪跳
  // 给定 rows，列数 = ceil(days/rows)，边长 s = (W - (cols-1)*gap)/cols，高度 = rows*s + (rows-1)*gap
  const heightFor = (rows) => {
    const cols = Math.ceil(heatDays / rows)
    const s = (W - (cols - 1) * GAP_PX) / cols
    return rows * s + (rows - 1) * GAP_PX
  }
  // 从 7 行（一周的直觉）起，过高就减；也允许在极宽屏增高到上限（最多 10 行）。
  let best = 1
  for (let rows = 1; rows <= 10; rows++) {
    if (heightFor(rows) <= HEAT_MAX_H) best = rows
  }
  return best
})
const heatCols = computed(() => Math.ceil(heatDays / heatRows.value))
const heatCellsN = computed(() => heatCols.value * heatRows.value)

const WEEKS = computed(() => {
  const daily = (heatBd.value && heatBd.value.daily) || []
  const byDay = new Map(daily.map(d => [d.day, d]))
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const rows = heatRows.value
  const cols = heatCols.value
  const HEAT_CELLS = heatCellsN.value

  // 最后一格恒 = 今天；往前依次回推，铺满 HEAT_CELLS 格。
  // 这样每天整体左移一格、格数不变，今天永远落在右下角。
  const todayIdx = HEAT_CELLS - 1
  const cells = []
  for (let i = 0; i < HEAT_CELLS; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() - (todayIdx - i))
    const key = localDay(d)
    const rec = byDay.get(key)
    cells.push({
      key,
      day: key,
      date: d.getDate(),
      month: d.getMonth() + 1,
      value: rec ? (rec.totalTokens || 0) : 0,
      tokens: rec ? rec.totalTokens : 0,
      requests: rec ? rec.requests : 0,
      output: rec ? rec.outputTokens : 0,
      errors: rec ? rec.errors : 0
    })
  }
  // 切成 cols 列 × rows 行（列优先）
  const out = []
  for (let c = 0; c < cols; c++) {
    out.push(cells.slice(c * rows, c * rows + rows))
  }
  return out
})

// 容器宽度实测：CSS 是 flex 均分，纯算术推不准（侧栏折叠/滚动条/padding 都会变）。
// 用 ResizeObserver 跟踪，宽度变化即重算行数 → 始终铺满且不超高度上限。
onMounted(() => {
  if (!heatWrapEl.value || typeof ResizeObserver === 'undefined') return
  heatRO = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect?.width ?? 0
    if (w > 0) heatWidth.value = w
  })
  heatRO.observe(heatWrapEl.value)
  heatWidth.value = heatWrapEl.value.clientWidth || 0
})
onBeforeUnmount(() => {
  if (heatRO) { heatRO.disconnect(); heatRO = null }
})

function localDay(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

// 自绘 tooltip：原生 title 要等 1~2s 浏览器延迟，用户明确嫌慢。
// 定位策略（关键）：tooltip 永远放在被 hover 那格的【正上方】并水平居中——
// 绝不覆盖目标格子本身。格子在网格右侧/顶部时按视口收边，必要时整体挪到
// 格子下方，保证「框不挡格」这条硬约束在任何位置都成立。
const tip = ref(null) // { day, tokens, requests, output, errors, left, top, side, anchor }
const tipEl = ref(null) // 提示框 DOM：用于渲染后实测真实尺寸
const hover = ref({ col: -1, row: -1 })
const TIP_W = 186   // 与 CSS .heat-tip 的宽度一致（含 padding）
const GAP = 10      // 框与目标格的间距

// 定位：先按「框在格上方居中」放好，渲染后用实测尺寸校正一次。
// 之所以不预先算高度——失败行只在有失败时出现，框高会变；写死高度必然
// 在某个组合下算错并压到格子上。实测一次（nextTick）比猜准得多。
function showTip(c, e, col, row) {
  const r = e.currentTarget.getBoundingClientRect()
  hover.value = { col, row }
  tip.value = {
    day: c.day, tokens: c.tokens, requests: c.requests,
    output: c.output, errors: c.errors,
    left: r.left + r.width / 2 - TIP_W / 2, // 先居中，稍后校正
    top: r.top - GAP,                       // 先假设框底贴格顶，稍后校正
    side: 'top',
    anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
  }
}

// 渲染后校正：拿到框的真实宽高再决定最终位置，保证任何情况下都不压住目标格。
// 关键：校正结果写进独立字段 pos，绝不能写回被 watch 的 tip —— 否则本轮写入
// 会再次触发本 watcher，微任务队列永不排空，主线程直接饿死（悬停即卡死）。
const pos = ref(null) // { left, top, side }，仅存校正后的坐标
watch(tip, async (t) => {
  if (!t) { pos.value = null; return }
  await nextTick()
  const el = tipEl.value
  if (!el) return
  const w = el.offsetWidth || TIP_W
  const h = el.offsetHeight || 96
  const a = t.anchor
  const vw = window.innerWidth
  const vh = window.innerHeight

  // 垂直：默认放格子上方；上方放不下就翻到下方
  const above = a.top - h - GAP >= 8
  let top = above ? a.top - h - GAP : a.bottom + GAP
  let side = above ? 'top' : 'below'

  // 水平：以格子中心对齐，再做视口收边
  let left = a.left + (a.right - a.left) / 2 - w / 2
  if (left < 8) left = 8
  if (left + w > vw - 8) left = vw - 8 - w

  // 硬约束复核：纵向若仍与目标格相交（视口极矮），改推到格子侧边
  if (top < a.bottom && top + h > a.top) {
    left = a.right + GAP
    if (left + w > vw - 8) left = Math.max(8, a.left - w - GAP)
    side = 'right'
    top = Math.max(8, Math.min(top, vh - h - 8))
  }
  pos.value = { left, top, side }
}, { flush: 'post' })

function hideTip() { tip.value = null; hover.value = { col: -1, row: -1 } }
// 首帧先用未校正坐标（框已在 tip 里带 left/top），nextTick 后由 pos 覆盖为实测位置。
const tipStyle = computed(() => {
  const p = pos.value || tip.value
  return p ? { left: p.left + 'px', top: p.top + 'px' } : {}
})
const tipSide = computed(() => (pos.value || tip.value)?.side || 'top')

// 分位阈值：用非零值的分位数定 4 档，避免个别大值把其余都压成一档。
const LEVELS = computed(() => {
  const vals = []
  for (const w of WEEKS.value) for (const c of w) if (c.value > 0) vals.push(c.value)
  if (!vals.length) return [0, 0, 0]
  vals.sort((a, b) => a - b)
  const q = p => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))]
  return [q(0.25), q(0.5), q(0.85)]
})

// level 0-4：0 表示当天没用，4 最深
function level(v) {
  if (!v) return 0
  const [a, b, c] = LEVELS.value
  if (v <= a) return 1
  if (v <= b) return 2
  if (v <= c) return 3
  return 4
}

// 月份标签：跟随真实月份。某列里出现了「比上一列更新的月份」就在该列标注。
// 一列 7 天可能横跨两个月份，取该列中占多数/首个新月份的那天来标，
// 保证标签位置与真实日历一致，而不是按周对齐后的近似。
const MONTH_LABELS = computed(() => {
  const cols = WEEKS.value
  let lastMonth = null
  return cols.map((col) => {
    if (!col.length) return ''
    // 该列里第一个「月份与上一列末尾不同」的格子 = 本月真正开始的位置
    const months = col.map(c => c.month)
    const newMonth = months.find(m => lastMonth !== null && m !== lastMonth)
    if (lastMonth === null) {
      lastMonth = months[months.length - 1]
      return lastMonth + '月'
    }
    if (newMonth !== undefined) {
      lastMonth = newMonth
      return newMonth + '月'
    }
    return ''
  })
})

// 活跃天数/峰值跟热力图的 365 天全周期（heatBd），【不】跟胶囊。
// 曾跟胶囊：默认「今天」时区间只有一天，卡片恒为 1（有量）/ 0（没量），
// 用户看到的永远是「1 天」，以为坏了（真缺陷）。它要回答的是「这网关用了多久、
// 哪天最猛」，是生命周期指标，不是区间指标——跟胶囊没有意义。
// 代价：四张卡不再同源（前三张跟胶囊）。卡片标签上标了「近一年」明示，
// 免得下次又被当成口径 bug。
const activeDays = computed(() => {
  const daily = (heatBd.value && heatBd.value.daily) || []
  return daily.filter(d => d.totalTokens > 0 || d.requests > 0).length
})
const busiest = computed(() => {
  const daily = (heatBd.value && heatBd.value.daily) || []
  if (!daily.length) return null
  return daily.reduce((a, b) => (b.totalTokens > a.totalTokens ? b : a))
})

// ---- 接入信息（紧凑保留）----
const gatewayBase = computed(() => window.location.origin)

// 复制：按钮自己变「已复制」1.6s（就地反馈，比飘一个 toast 更轻）。
// copied 存按钮标识，多个复制点各亮各的。
const copied = ref('')
let copyTimer = null
async function copy(text, what, key = '') {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
  copied.value = key
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => { copied.value = '' }, 1600)
  ElMessage.success(`已复制${what}`)
}
onUnmounted(() => clearTimeout(copyTimer))

const totals = computed(() => (attrBd.value && attrBd.value.totals) || {})

// 总输入 = input_tokens 本身（OpenAI 系 prompt_tokens 已含 cached 全量）。
// 分子是「缓存读取」——与后端 hitRate 同源，卡片的分子/分母直接显示这两个数。
const billedInput = computed(() => (totals.value.inputTokens || 0))

// 缓存写入（cache_creation）不展示：只有 anthropic-messages 上游会报这个字段，
// OpenAI 系（zen/workbuddy）只有 cached_tokens，绝大多数上游恒 0 = 「上游没给」
// 而非「真的没写」，摆出来只会误导（用户核对时也对不上）。数据仍在库中，未丢弃。
// 展示口径：命中率 / 总输入 / 缓存读取 / 输出。

// 失败率着色：>10% 红，>0 琥珀，0 保持暗色（状态色承担语义，UI-REVIEW §2-5）
function failClass(rate) {
  if (!rate) return 'dim'
  return rate > 0.1 ? 'bad' : 'warn'
}
// byModel：按 providerName+modelId 合并（后端 GROUP BY 同口径，这里兜一层）。
const FIELDS = ['requests', 'inputTokens', 'outputTokens', 'cacheReadTokens',
  'cacheCreationTokens', 'reasoningTokens', 'totalTokens', 'errors']
// 由「后端算好的命中率」反推该行的分母（命中数 / 命中率）。
// 这样前端不必区分上游语义，也不会用错公式重算。
function denomOf(r) {
  const rate = r.cacheHitRate
  return (rate != null && rate > 0) ? (r.cacheReadTokens || 0) / rate : 0
}
const byModel = computed(() => {
  const merged = new Map()
  for (const m of (attrBd.value && attrBd.value.byModel) || []) {
    const k = m.providerName + '/' + m.modelId
    const acc = merged.get(k)
    if (!acc) merged.set(k, { ...m })
    else {
      for (const f of FIELDS) acc[f] = (acc[f] || 0) + (m[f] || 0)
      // TPS/TTFT 合并：sampled 加权平均（展示用途；同 model 跨 Provider 的场景极罕见）
      for (const f of ['avgTps', 'avgTtftMs']) {
        const a = acc[f], b = m[f]
        if (a == null && b == null) { acc[f] = null; continue }
        const wa = acc.sampled || 0, wb = m.sampled || 0
        acc[f] = wa + wb > 0 ? ((a ?? 0) * wa + (b ?? 0) * wb) / (wa + wb) : null
      }
      acc.sampled = (acc.sampled || 0) + (m.sampled || 0)
      // 命中率不能平均（各行权重不同）：按后端算出的率反推各自分母再加总，
      // 维持「命中数 / 输入侧」口径。（仅同 provider 同 model 跨来源时走到这里）
      acc._num = (acc._num ?? acc.cacheReadTokens ?? 0) + (m.cacheReadTokens || 0)
      acc._denom = (acc._denom ?? denomOf(acc)) + denomOf(m)
    }
  }
  // 命中率由后端算好（cacheHitRate = cacheRead / input，见 usage/store.ts hitRate）：
  // 前端不再自行用单一公式重算（那正是之前的错误来源）。
  // 只有发生合并（_denom 被写入）的行才需要按反推的分母重算。
  for (const m of merged.values()) {
    if (m._denom !== undefined) {
      m.cacheHitRate = m._denom > 0 ? m._num / m._denom : null
    }
    delete m._num; delete m._denom
  }
  return [...merged.values()]
})
// 占比：相对区间总 token（不是相对最大值——那样第一名恒为 100%，条子永远满格）
// 占比基准随视图变：视图 A 以合并后的来源行为分母，视图 C 以模型汇总行为分母。
// 分母必须与当前表里的行一致，否则进度条会按另一套总量算（看起来永远填不满）。
function shareBase() {
  return groupByModel.value ? modelRows.value : groupedModels.value
}
function share(x) {
  return shareOf(shareBase(), x)
}
function shareTip(x) {
  return shareTitle(shareBase(), x)
}

// 归因行的「来源」= providerName 快照（后端随每条用量一同落库）。
// 它天然解决了两个问题：Provider 改名/删除后历史行仍显示当时的名字；
// 删除后重建同名不会裂成两行（分组键就是名字）。
function srcName(row) {
  return row.providerName || '（未知来源）'
}
// 聚合视图（C）里一行的 Provider 明细：名字 + #id + 该来源的 token 量。
function memberLabel(m) {
  const id = srcIdOf(m)
  return id ? `${srcName(m)} #${id}` : srcName(m)
}
// 内部 id 标注：名字可能重复（删除后重建），用 #id 让用户能区分是哪一个。
// 查不到活跃 Provider 时（历史/已删）只显示名字，不硬编一个假 id。
function srcIdOf(row) {
  const p = providers.value.find(x => x.providerId === row.providerId)
  return p ? p.providerId : (row.providerId > 0 ? row.providerId : 0)
}
// 「按模型统计」视图：把同一个模型的多个 Provider 行合成一行，Provider 作为明细展开。
// 归因默认视图（A）一行 = 一个 Provider × 一个模型；聚合视图（C）一行 = 一个模型。
const groupByModel = ref(false)
const modelRows = computed(() => {
  if (!groupByModel.value) return []
  const acc = new Map()
  for (const m of byModel.value) {
    const k = m.modelId
    let row = acc.get(k)
    if (!row) {
      row = { modelId: k, _members: [], requests: 0, inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0,
        totalTokens: 0, errors: 0, sampled: 0, _tpsWeighted: 0, _ttftWeighted: 0,
        _num: 0, _denom: 0 }
      acc.set(k, row)
    }
    row._members.push(m)
    for (const f of FIELDS) row[f] = (row[f] || 0) + (m[f] || 0)
    row._num += m.cacheReadTokens || 0
    row._denom += denomOf(m)
    const w = m.sampled || 0
    if (m.avgTps != null) { row._tpsWeighted += m.avgTps * w; row._ttftWeighted += (m.avgTtftMs ?? 0) * w }
    row.sampled += w
  }
  for (const r of acc.values()) {
    r.cacheHitRate = r._denom > 0 ? r._num / r._denom : null
    r.avgTps = r.sampled > 0 ? r._tpsWeighted / r.sampled : null
    r.avgTtftMs = r.sampled > 0 ? r._ttftWeighted / r.sampled : null
    delete r._num; delete r._denom; delete r._tpsWeighted; delete r._ttftWeighted
  }
  return [...acc.values()].sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0))
})

// ---- 归因表：搜索 / 排序 / 分页（纯前端，数据量小） ----
const q = ref('')
const sortKey = ref('totalTokens')
const sortDir = ref('desc')
const page = ref(1)
const PAGE_SIZE = 20
const SORTABLE = ['requests', 'inputTokens', 'outputTokens', 'avgTps', 'cacheReadTokens', 'cacheHitRate', 'totalTokens', 'errors']

// ---- 手动合并组（纯前端，localStorage 持久化） ----
// 场景：zen（手配）与 zen-auto（自动发现）是同一类上游，理应算一笔账。
// 规则只存本机浏览器：[{ id, name, keys: ['providerName/modelId'] }]。
const MERGE_KEY = 'polycode-hub.mergeGroups.v1'
function loadGroups() {
  try {
    const raw = localStorage.getItem(MERGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter(g => g && g.id && g.name && Array.isArray(g.keys)) : []
  } catch { return [] }
}
const mergeGroups = ref(loadGroups())
function saveGroups() {
  try { localStorage.setItem(MERGE_KEY, JSON.stringify(mergeGroups.value)) }
  catch { /* 配额满就当没存住，下次重配 */ }
}
// 合并模式：右上角「合并」按钮开启后，各行出现勾选框；选中 2+ 行即弹出组名浮层确认
const merging = ref(false)
const checkedKeys = ref(new Set()) // 勾选中的行 key（rowKey）
const mergeName = ref('') // 合并时用户起的组名
const expandedGroups = ref(new Set()) // 展开看明细的组 id
function toggleMergeMode() {
  merging.value = !merging.value
  checkedKeys.value = new Set()
  mergeName.value = ''
}
function toggleCheck(k) {
  const s = new Set(checkedKeys.value)
  if (s.has(k)) s.delete(k)
  else s.add(k)
  checkedKeys.value = s
}
// 行 key：组行不可勾选（避免组套组）；明细展开行也不进勾选。
// 用 mergeGroups.rowKey 而不是手写 providerName+'/'+modelId：手动合并组的
// applyGroups/applyGroupsReport 内部用的就是 rowKey，两边必须同一套口径，
// 否则"勾中的行"和"被合并的行"会对不上号。
function checkKeyOf(m) {
  return m._groupId ? null : rowKey(m)
}
const canMerge = computed(() => checkedKeys.value.size >= 2)
function doMerge() {
  const keys = [...checkedKeys.value]
  if (keys.length < 2) return
  const name = mergeName.value.trim() || ('合并组' + (mergeGroups.value.length + 1))
  const g = { id: 'group-' + Date.now(), name, keys }
  // 先验：选中的 key 是否都在当前行列表里（分页/搜索可能藏起行，导致合了个寂寞）
  const { unmatched } = applyGroupsReport(byModel.value, [...mergeGroups.value, g])
  mergeGroups.value = [...mergeGroups.value, g]
  saveGroups()
  merging.value = false
  checkedKeys.value = new Set()
  mergeName.value = ''
  page.value = 1
  if (unmatched.includes(g.id)) {
    ElMessage.warning('合并未生效：选中的行不在当前数据里（可能被搜索/时间范围过滤了），已保存规则，调整筛选后自动生效')
  } else {
    ElMessage.success(`已合并为「${name}」`)
  }
}
function unmerge(id) {
  mergeGroups.value = mergeGroups.value.filter(g => g.id !== id)
  saveGroups()
  const s = new Set(expandedGroups.value)
  s.delete(id)
  expandedGroups.value = s
}
// 重命名：组行「重命名」→ 组名变输入框，回车/失焦保存，Esc 取消
const renamingId = ref(null)
const renamingName = ref('')
function startRename(m) {
  renamingId.value = m._groupId
  renamingName.value = m.providerName
  nextTick(() => {
    const el = document.querySelector('.rename-input input')
    if (el) { el.focus(); el.select() }
  })
}
function commitRename() {
  if (!renamingId.value) return
  const name = renamingName.value.trim()
  if (name) {
    mergeGroups.value = mergeGroups.value.map((g) =>
      g.id === renamingId.value ? { ...g, name } : g)
    saveGroups()
    ElMessage.success(`已重命名为「${name}」`)
  }
  renamingId.value = null
  renamingName.value = ''
}
function cancelRename() {
  renamingId.value = null
  renamingName.value = ''
}
function toggleExpand(id) {
  const s = new Set(expandedGroups.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  expandedGroups.value = s
}
// byModel（后端按 provider+model 聚合后）再叠手动合并组；占比/排序/分页都吃合并后的行
const groupedModels = computed(() => applyGroups(byModel.value, mergeGroups.value))

const filteredModels = computed(() => {
  const kw = q.value.trim().toLowerCase()
  const rows = kw
    ? groupedModels.value.filter(m =>
      (m.modelId || '').toLowerCase().includes(kw) || (m.providerName || '').toLowerCase().includes(kw))
    : groupedModels.value
  const d = sortDir.value === 'desc' ? -1 : 1
  return [...rows].sort((a, b) =>
    sortKey.value === 'model' ? d * a.modelId.localeCompare(b.modelId) : d * ((a[sortKey.value] || 0) - (b[sortKey.value] || 0)))
})
const pageCount = computed(() => Math.max(1, Math.ceil(filteredModels.value.length / PAGE_SIZE)))
const pagedModels = computed(() =>
  filteredModels.value.slice((Math.min(page.value, pageCount.value) - 1) * PAGE_SIZE, page.value * PAGE_SIZE))

function setSort(k) {
  if (sortKey.value === k) sortDir.value = sortDir.value === 'desc' ? 'asc' : 'desc'
  else { sortKey.value = k; sortDir.value = 'desc' }
  page.value = 1
}
watch(q, () => { page.value = 1 })
// 浮层外点关闭（window 级 click 监听即可，无需每个浮层单独处理）
onMounted(() => document.addEventListener('click', closePill))
onUnmounted(() => document.removeEventListener('click', closePill))
function closePill() { pillOpen.value = false }

// TPS 展示（TPS-METRIC §3.6）：sampled=0 或 null 显示 —（缺数据不产出 0.0，DSH 精神）
function tpsText(m) {
  if (m.sampled === 0 || m.avgTps == null) return '—'
  return m.avgTps.toFixed(1) + ' tok/s'
}
function ttftText(m) {
  if (m.avgTtftMs == null) return '—'
  return m.avgTtftMs >= 1000 ? (m.avgTtftMs / 1000).toFixed(1) + 's' : Math.round(m.avgTtftMs) + 'ms'
}
</script>

<template>
  <header class="page-head">
    <h2>概览</h2>
    <p class="sub">网关用量仪表盘：每天用了多少（越绿越多）、花在哪个 provider 的哪个模型上。</p>
  </header>

  <p v-if="err" class="err">加载失败：{{ err }}</p>

  <section class="panel access">
    <span class="dim access-label">网关</span>
    <code class="gw">{{ gatewayBase }}</code>
    <button class="copy-btn" :class="{ done: copied === 'gw' }" @click="copy(gatewayBase, '网关地址', 'gw')">
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/>
        <path d="M10.5 3.9V3.1A1.6 1.6 0 0 0 8.9 1.5H3.1A1.6 1.6 0 0 0 1.5 3.1v5.8a1.6 1.6 0 0 0 1.6 1.6h.8"
              fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
      {{ copied === 'gw' ? '已复制' : '复制' }}
    </button>
  </section>

  <section class="cards">
    <div class="card">
      <div class="card-label">总 token</div>
      <div class="card-value num">{{ fmt(totals.totalTokens) }}</div>
      <!-- 总量 = 总输入 + 输出 -->
      <div class="card-foot dim">总输入 {{ fmt(billedInput) }} · 输出 {{ fmt(totals.outputTokens) }}</div>
    </div>
    <div class="card">
      <div class="card-label">请求数</div>
      <div class="card-value num">{{ fmt(totals.requests) }}</div>
      <!-- 失败率有量就用状态色说出来，不再是灰色小字（UI-REVIEW §2-5） -->
      <div class="card-foot" :class="failClass(totals.errors / totals.requests)">
        <template v-if="totals.errors">失败 {{ fmt(totals.errors) }}（{{ pct(totals.errors / totals.requests) }}）</template>
        <template v-else>失败 0</template>
      </div>
    </div>
    <div class="card">
      <div class="card-label">缓存命中率</div>
      <div class="card-value num">{{ pct(totals.cacheHitRate) }}</div>
      <!-- 分子 / 分母直接写出来，便于核对口径（命中 / 总输入） -->
      <div class="card-foot dim">
        {{ fmt(totals.cacheReadTokens) }} / {{ fmt(billedInput) }}
      </div>
    </div>
    <div class="card">
      <div class="card-label">活跃天数 <span class="card-scope">近一年</span></div>
      <div class="card-value num">{{ activeDays }}</div>
      <div class="card-foot dim">
        <template v-if="busiest">峰值 {{ busiest.day }}（{{ fmt(busiest.totalTokens) }}）</template>
        <template v-else>暂无用量</template>
      </div>
    </div>
  </section>

  <section class="panel">
    <div class="panel-head">
      <h3>用量热力图</h3>
    </div>

    <div class="heat-wrap" ref="heatWrapEl">
      <div class="heat-months">
        <span v-for="(m, i) in MONTH_LABELS" :key="i" class="heat-month">{{ m }}</span>
      </div>
      <!-- 无星期行标：格子只表达「某天用了多少」，行列不承载星期语义。
           提示用自绘 tooltip（见 hoverTip）：原生 title 有 1~2s 的浏览器延迟。 -->
      <div class="heat-grid">
        <div v-for="(w, wi) in WEEKS" :key="wi" class="heat-week" :class="{ 'col-on': hover.col === wi }">
          <div v-for="(c, ri) in w" :key="c.key" class="heat-cell" :class="'lv' + level(c.value)"
            @mouseenter="showTip(c, $event, wi, ri)" @mouseleave="hideTip" @focus="showTip(c, $event, wi, ri)" @blur="hideTip"
            tabindex="0" :aria-label="`${c.day}：${fmt(c.tokens)} token / ${c.requests} 次请求`" />
        </div>
      </div>
    </div>

    <div class="legend">
      <span class="dim">少</span>
      <span class="heat-cell lv0" /><span class="heat-cell lv1" />
      <span class="heat-cell lv2" /><span class="heat-cell lv3" /><span class="heat-cell lv4" />
      <span class="dim">多</span>
      <span class="dim legend-note">按 {{ METRICS_LABEL }} 着色</span>
    </div>
  </section>

  <!-- 热力图格子提示：fixed 定位脱离面板裁剪，紧跟目标格即时出现 -->
  <div v-if="tip" ref="tipEl" class="heat-tip" :class="tipSide" :style="tipStyle">
    <div class="heat-tip-day num">{{ tip.day }}</div>
    <div class="heat-tip-row"><span>总 token</span><b class="num">{{ fmt(tip.tokens) }}</b></div>
    <div class="heat-tip-row"><span>请求</span><b class="num">{{ tip.requests }}</b></div>
    <div class="heat-tip-row"><span>输出</span><b class="num">{{ fmt(tip.output) }}</b></div>
    <div v-if="tip.errors" class="heat-tip-row bad"><span>失败</span><b class="num">{{ tip.errors }}</b></div>
  </div>

  <section class="panel">
    <div class="panel-head">
      <h3>用量归因（{{ groupByModel ? '模型' : '来源 / 模型' }}）</h3>
      <div class="controls">
        <el-input v-if="byModel.length" v-model="q" size="small" clearable placeholder="搜索模型名" style="width:160px" />
        <!-- 视图切换：默认一行 = 一个来源×一个模型；按模型统计把同一模型的多个来源合成一行 -->
        <button v-if="byModel.length" class="merge-toggle" :class="{ on: groupByModel }"
          :title="groupByModel ? '当前：按模型汇总（展开看各来源）' : '当前：按来源×模型分行'"
          @click="groupByModel = !groupByModel">
          {{ groupByModel ? '按来源分行' : '按模型统计' }}
        </button>
        <!-- 合并模式开关：时间胶囊右边。开启后各行出现勾选框，选中即合 -->
        <button v-if="byModel.length && !groupByModel" class="merge-toggle" :class="{ on: merging }" @click="toggleMergeMode">
          {{ merging ? '取消合并' : '合并' }}
        </button>
        <!-- 时间胶囊只管归因区（stat card + 归因表），管不到热力图 -->
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
    </div>
    <p v-if="!byModel.length" class="dim">还没有用量记录 —— 发一次请求后这里会出现明细。</p>
    <p v-else-if="!filteredModels.length" class="dim">没有匹配「{{ q }}」的模型。</p>
    <!-- 合并确认条：独立 v-if，不进上面的互斥链——否则它一出现就把表格挤掉。
         回车只收起键盘（blur），真正合并只走「确认合并」按钮，避免输一半误触 -->
    <div v-if="byModel.length && filteredModels.length && merging && canMerge" class="merge-bar">
      <span class="dim">已选 {{ checkedKeys.size }} 行，合并为</span>
      <el-input v-model="mergeName" size="small" clearable placeholder="组名，如 Zen"
        style="width:160px" @keydown.enter="$event.isComposing ? null : $event.target.blur()" />
      <button type="button" class="merge-apply" @click="doMerge">确认合并</button>
    </div>
    <p v-if="byModel.length && filteredModels.length && merging && !canMerge" class="dim merge-hint">勾选要合并的行（至少选两行）</p>
    <table v-if="filteredModels.length" class="attr">
      <thead>
        <tr>
          <th v-if="merging" class="check-col"></th>
          <th>Provider / 模型</th>
          <th v-for="k in SORTABLE" :key="k" class="n sortable" @click="setSort(k)">
            {{ { requests:'请求', inputTokens:'输入', outputTokens:'输出', avgTps:'输出速度', cacheReadTokens:'缓存读取', cacheHitRate:'命中率', totalTokens:'总 token', errors:'失败' }[k] }}
            <span v-if="sortKey === k" class="sort-arrow">{{ sortDir === 'desc' ? '▾' : '▴' }}</span>
          </th>
          <th class="n">首字</th>
          <th class="bar-col">占比</th>
        </tr>
      </thead>
      <!-- 视图 C：按模型统计。一行 = 一个模型；来源作为可展开明细，带各自 token 量。 -->
      <tbody v-if="groupByModel">
        <template v-for="r in modelRows" :key="'gm-' + r.modelId">
          <tr>
            <td>
              <div class="model-line"><span class="model-name">{{ r.modelId }}</span></div>
              <div class="src-name sub-src">
                <button class="link-btn" @click="toggleExpand('gm-' + r.modelId)">
                  {{ expandedGroups.has('gm-' + r.modelId) ? '收起' : '展开' }}({{ r._members.length }} 个来源)
                </button>
              </div>
            </td>
            <td class="n num">{{ fmt(r.requests) }}</td>
            <td class="n num">{{ fmt(r.inputTokens) }}</td>
            <td class="n num">{{ fmt(r.outputTokens) }}</td>
            <td class="n num" :class="{ dim: !r.sampled }">{{ tpsText(r) }}</td>
            <td class="n num">{{ fmt(r.cacheReadTokens) }}</td>
            <td class="n num" :class="{ dim: r.cacheHitRate == null }">
              {{ r.cacheHitRate == null ? '—' : pct(r.cacheHitRate) }}
            </td>
            <td class="n num strong">{{ fmt(r.totalTokens) }}</td>
            <td class="n num" :class="{ 'err': r.errors > 0 }">{{ r.errors || '' }}</td>
            <td class="n num" :class="{ dim: r.avgTtftMs == null }">{{ ttftText(r) }}</td>
            <td class="bar-col"><div class="bar"><div class="bar-fill" :style="{ width: (share(r) * 100) + '%' }" /></div></td>
          </tr>
          <tr v-for="sub in (expandedGroups.has('gm-' + r.modelId) ? r._members : [])"
            :key="'gmsub-' + r.modelId + '-' + sub.providerName" class="sub-row">
            <td>
              <div class="src-name sub-name">
                {{ memberLabel(sub) }}
              </div>
            </td>
            <td class="n num">{{ fmt(sub.requests) }}</td>
            <td class="n num">{{ fmt(sub.inputTokens) }}</td>
            <td class="n num">{{ fmt(sub.outputTokens) }}</td>
            <td class="n num" :class="{ dim: sub.sampled === 0 }">{{ tpsText(sub) }}</td>
            <td class="n num">{{ fmt(sub.cacheReadTokens) }}</td>
            <td class="n num" :class="{ dim: sub.cacheHitRate == null }">
              {{ sub.cacheHitRate == null ? '—' : pct(sub.cacheHitRate) }}
            </td>
            <td class="n num">{{ fmt(sub.totalTokens) }}</td>
            <td class="n num" :class="{ 'err': sub.errors > 0 }">{{ sub.errors || '' }}</td>
            <td class="n num" :class="{ dim: sub.avgTtftMs == null }">{{ ttftText(sub) }}</td>
            <td class="bar-col"><div class="bar"><div class="bar-fill" :style="{ width: (share(sub) * 100) + '%' }" /></div></td>
          </tr>
        </template>
      </tbody>
      <tbody v-else>
        <template v-for="m in pagedModels" :key="(m._groupId || '') + m.providerName + '/' + m.modelId">
        <tr>
          <td v-if="merging" class="check-col">
            <input v-if="checkKeyOf(m)" type="checkbox" :checked="checkedKeys.has(checkKeyOf(m))"
              @change="toggleCheck(checkKeyOf(m))" :aria-label="'选择 ' + m.providerName + '/' + m.modelId" />
          </td>
          <td>
            <!-- 组行：组名 + 展开/重命名/拆分；明细行：原 provider 显示名 + 模型 -->
            <template v-if="m._groupId">
              <div v-if="renamingId === m._groupId" class="rename-wrap">
                <!-- 中文输入法选字时的回车（isComposing）不提交，等组词完成后的回车才保存 -->
                <el-input v-model="renamingName" size="small" class="rename-input" style="width:140px"
                  @keydown.enter="e => { if (!e.isComposing) commitRename() }"
                  @keydown.esc="cancelRename" @blur="commitRename" />
              </div>
              <div v-else class="src-name">{{ m.providerName }}
                <button class="link-btn" @click="toggleExpand(m._groupId)">
                  {{ expandedGroups.has(m._groupId) ? '收起' : '展开' }}({{ m._members.length }})
                </button>
                <button class="link-btn" @click="startRename(m)">重命名</button>
                <button class="link-btn danger" @click="unmerge(m._groupId)">拆分</button>
              </div>
              <div class="model-line dim">手动合并组</div>
            </template>
            <template v-else>
              <!-- 归因视图 A：模型是主（用户按模型认账），Provider 是辅并标内部 id -->
              <div class="model-line"><span class="model-name">{{ m.modelId }}</span></div>
              <div class="src-name sub-src">
                {{ srcName(m) }}<span v-if="srcIdOf(m)" class="mono pid">#{{ srcIdOf(m) }}</span>
              </div>
            </template>
          </td>
          <td class="n num">{{ fmt(m.requests) }}</td>
          <td class="n num">{{ fmt(m.inputTokens) }}</td>
          <td class="n num">{{ fmt(m.outputTokens) }}</td>
          <!-- TPS/TTFT 成对展示（DSH 口径）；sampled=0 显示 —，缺数据不产出 0.0 -->
          <td class="n num" :class="{ dim: m.sampled === 0 }">{{ tpsText(m) }}</td>
          <td class="n num">{{ fmt(m.cacheReadTokens) }}</td>
          <!-- 命中率：后端下发的 cacheHitRate（缓存读取 / 总输入，见 usage/store.ts hitRate）；无输入显示 — -->
          <td class="n num" :class="{ dim: m.cacheHitRate == null }">
            {{ m.cacheHitRate == null ? '—' : pct(m.cacheHitRate) }}
          </td>
          <td class="n num strong">{{ fmt(m.totalTokens) }}</td>
          <td class="n num" :class="{ 'err': m.errors > 0 }">{{ m.errors || '' }}</td>
          <td class="n num" :class="{ dim: m.avgTtftMs == null }">{{ ttftText(m) }}</td>
          <td class="bar-col"><div class="bar" :title="shareTip(m)"><div class="bar-fill" :style="{ width: (share(m) * 100) + '%' }" /></div></td>
        </tr>
        <!-- 展开的组明细：缩进展示原行 -->
        <tr v-if="m._groupId && expandedGroups.has(m._groupId)" v-for="sub in m._members"
          :key="'sub-' + sub.providerName + '/' + sub.modelId" class="sub-row">
          <td v-if="merging" class="check-col"></td>
          <td>
            <div class="model-line"><span class="model-name">{{ sub.modelId }}</span></div>
            <div class="src-name sub-name sub-src">
              {{ srcName(sub) }}<span v-if="srcIdOf(sub)" class="mono pid">#{{ srcIdOf(sub) }}</span>
            </div>
          </td>
          <td class="n num">{{ fmt(sub.requests) }}</td>
          <td class="n num">{{ fmt(sub.inputTokens) }}</td>
          <td class="n num">{{ fmt(sub.outputTokens) }}</td>
          <td class="n num" :class="{ dim: sub.sampled === 0 }">{{ tpsText(sub) }}</td>
          <td class="n num">{{ fmt(sub.cacheReadTokens) }}</td>
          <td class="n num" :class="{ dim: sub.cacheHitRate == null }">
            {{ sub.cacheHitRate == null ? '—' : pct(sub.cacheHitRate) }}
          </td>
          <td class="n num">{{ fmt(sub.totalTokens) }}</td>
          <td class="n num" :class="{ 'err': sub.errors > 0 }">{{ sub.errors || '' }}</td>
          <td class="n num" :class="{ dim: sub.avgTtftMs == null }">{{ ttftText(sub) }}</td>
          <td class="bar-col"><div class="bar" :title="shareTip(sub)"><div class="bar-fill" :style="{ width: (share(sub) * 100) + '%' }" /></div></td>
        </tr>
        </template>
      </tbody>
    </table>
    <div v-if="pageCount > 1" class="pager">
      <span class="pager-total num">共 {{ filteredModels.length }} 个模型</span>
      <el-pagination layout="prev, pager, next" :page-size="PAGE_SIZE"
        :total="filteredModels.length" :current-page="page" @current-change="p => page = p" />
    </div>
  </section>
</template>

<style scoped>
.page-head h2 { margin: 0 0 4px; font-size: 18px; }
.sub { color: var(--dim); margin: 0 0 18px; font-size: 12px; }
.dim { color: var(--dim); }
.err { color: var(--bad); }
.num { font-variant-numeric: tabular-nums; }

.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 16px; }
/* 卡片：默认全部同权重，没有任何一格被固定强调。
   只有鼠标悬浮时才提亮边框——高亮是「正在看这里」的反馈，不是常驻状态。 */
.card {
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 14px 16px; transition: border-color .15s;
}
.card:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.card-label { color: var(--dim); font-size: 12px; margin-bottom: 6px; }
/* 作用域徽标：本卡是全周期口径，不吃胶囊。前三张卡跟胶囊，若不说清，
   用户（和下个改代码的人）会以为它也是区间值 —— 曾经因此被当成 bug。 */
.card-scope {
  margin-left: 5px; font-size: 10px; padding: 1px 5px; border-radius: 4px;
  color: var(--dim); border: 1px solid var(--line); opacity: .85;
  font-variant-numeric: tabular-nums;
}
.card-value { font-size: 22px; }
.card-foot { font-size: 11px; margin-top: 6px; }

.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; }
.panel h3 { margin: 0 0 12px; font-size: 14px; }
.panel-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.panel-head h3 { margin: 0; }
.controls { display: flex; gap: 8px; }

/* ---- 接入信息条 ----
   一行三件：标签 / 地址框 / 复制键。地址框占满剩余宽度，
   复制键与地址框同高同边框——两者是同一组控件，不再是一大一小两截。 */
.access { display: flex; align-items: center; gap: 10px; padding: 10px 16px; }
.access-label { flex: 0 0 auto; font-size: 12px; }
.access code.gw {
  flex: 1; min-width: 0; font-family: var(--mono); font-size: 12px; line-height: 1.6;
  background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 5px 10px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.copy-btn {
  flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px;
  font-size: 12px; line-height: 1.6; padding: 5px 11px;
  color: var(--dim); background: var(--panel-2);
  border: 1px solid var(--line); border-radius: 6px; cursor: pointer;
  transition: color .15s, border-color .15s, background .15s;
}
.copy-btn:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); }
.copy-btn:active { background: var(--bg); }
.copy-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* 就地确认：按下后这一格自己变绿说「已复制」，不需要另一个 toast 解释 */
.copy-btn.done {
  color: var(--ok); border-color: color-mix(in srgb, var(--ok) 55%, var(--line));
  background: color-mix(in srgb, var(--ok) 12%, var(--panel-2));
}

/* 注：无数据维度（上游不提供该字段）不产出 0，显示 —，悬停给原因。
   历史上这里有个 .na 类承担"悬停给原因"的样式，但模板从没引用过它，
   已删；现在 — 单元格靠 title 提供原因，不再假装有可悬停样式。 */

/* ---- 热力图 ----
   横向铺满整栏（用户拍板，2026-09-17）：
   格子用 flex:1 均分整栏宽度，不再设 max-width——曾经的 19px 上限让宽屏下
   只占中间一条（1920 屏两侧白掉 500px），既浪费空间也显得没对齐。

   高度：格子 aspect-ratio:1，行数随容器宽高比自适应（见 heatRows）——
   宽度越宽格子越大、整块越高；若过高则减少每列格数（列数相应增加），
   从而在铺满宽度的同时不把面板撑得过高。

   对齐契约（改一个要同步改其余）：
   月份行与网格同列数、同 flex 策略，节距恒一致（无左侧行标列，
   故月份行不再需要 margin-left）。 */
.heat-wrap { overflow-x: auto; padding-bottom: 4px; }
.heat-months { display: flex; gap: 3px; height: 14px; margin-bottom: 3px; }
.heat-month { font-size: 10px; color: var(--dim); flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; }
.heat-grid { display: flex; gap: 3px; }
.heat-week { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.heat-week .heat-cell {
  width: auto; height: auto; aspect-ratio: 1;
  transition: transform .1s ease, box-shadow .1s ease;
}
.heat-cell { box-sizing: border-box; width: 10px; height: 10px; border-radius: 2px; }

/* 十字定位（用户：「我放到这个正方形上可以明显的知道我在看这个正方形」）：
   同行/同列的兄弟格子保持原样，靠「整列轻微提亮 + 目标格描边放大」建立指向，
   不动数据的颜色本身——格子颜色是信息，不能被交互态改写。
   动效只回应人的动作，且只动 transform/opacity（不触发重排）。 */
.heat-week { transition: opacity .12s ease; }
.heat-grid:hover .heat-week:not(.col-on) { opacity: .45; }
.heat-week.col-on .heat-cell { box-shadow: 0 0 0 1px color-mix(in srgb, var(--dim) 45%, transparent); }
/* 目标格：靠描边从同列里跳出来即可，放大克制在格间距（3px）以内——
   之前 scale(1.55) 在 19px 格子上外扩近 5px，会啃到上下左右邻格，显得聒噪。 */
.heat-week.col-on .heat-cell:hover,
.heat-week.col-on .heat-cell:focus-visible {
  box-shadow: 0 0 0 1.5px var(--accent);
  transform: scale(1.15);
  position: relative; z-index: 2;
}
.heat-cell:focus-visible { outline: none; }
.lv0 { background: var(--panel-2, #1a222d); border: 1px solid var(--line); }
.lv1 { background: color-mix(in srgb, var(--ok) 25%, transparent); }
.lv2 { background: color-mix(in srgb, var(--ok) 45%, transparent); }
.lv3 { background: color-mix(in srgb, var(--ok) 70%, transparent); }
.lv4 { background: var(--ok); }
.legend { display: flex; align-items: center; gap: 4px; margin-top: 10px; font-size: 11px; }
.legend-note { margin-left: 10px; }

/* 热力图提示：自绘替代原生 title（即时、可排版）。fixed 定位不被面板裁剪，
   pointer-events:none 保证它不会把 mouseleave 抢掉导致闪烁。
   定位由 JS 保证贴在目标格正上方（或下方），永不复压住格子本身。 */
.heat-tip {
  --tip-bg: var(--panel-2);
  position: fixed; z-index: 60; pointer-events: none;
  width: 186px; box-sizing: border-box; padding: 8px 10px;
  background: var(--tip-bg); border: 1px solid var(--line); border-radius: 8px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 50%);
  font-size: 12px; line-height: 1.7;
}
/* 指向目标格的小箭头：明确「这个框说的是哪一格」。
   基线一律「箭头在框下方、朝下」，再按实际方位覆盖：below=框在格下方
   （箭头朝上），right=框在格侧边（箭头朝左）。箭头颜色统一取 --tip-bg，
   与框底色同源，改底色时箭头不会掉队。 */
.heat-tip::after {
  content: ''; position: absolute;
  border: 5px solid transparent;
  /* 默认：框在格子上方 → 箭头贴框底、朝下 */
  left: 50%; margin-left: -5px; top: 100%;
  border-top-color: var(--tip-bg);
}
.heat-tip.below::after { /* 框在格子下方 → 箭头贴框顶、朝上 */
  top: auto; bottom: 100%;
  border-top-color: transparent; border-bottom-color: var(--tip-bg);
}
.heat-tip.right::after { /* 框在格子侧边 → 箭头贴框左、朝左 */
  left: auto; right: 100%; top: 50%; margin: -5px 0 0 0;
  border-top-color: transparent; border-right-color: var(--tip-bg);
}
.heat-tip-day { font-size: 12px; font-weight: 600; margin-bottom: 4px; }
.heat-tip-row { display: flex; justify-content: space-between; gap: 14px; color: var(--dim); }
.heat-tip-row b { color: var(--text); font-weight: 500; }
.heat-tip-row.bad b { color: var(--bad); }

/* ---- 归因表 ---- */
.attr { width: 100%; border-collapse: collapse; font-size: 12px; }
/* 右上角合并开关：与时间胶囊并排的轻量按钮 */
.merge-toggle {
  border: 1px solid var(--line); background: var(--panel-2); color: var(--dim);
  border-radius: 999px; padding: 5px 13px; font-size: 12px; cursor: pointer; white-space: nowrap;
  transition: border-color .15s, color .15s;
}
.merge-toggle:hover { color: var(--text); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.merge-toggle.on { color: var(--accent); border-color: var(--accent); }
/* 合并确认条：合并模式下选中 2+ 行后出现 */
.merge-bar {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 10px; padding: 8px 12px;
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px;
  font-size: 12px;
}
.merge-hint { margin: 0 0 10px; font-size: 12px; }
.merge-apply {
  border: 1px solid var(--accent); color: var(--accent); background: none;
  border-radius: 6px; padding: 3px 14px; font-size: 12px; cursor: pointer;
}
.merge-apply:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.check-col { width: 28px; }
.check-col input { cursor: pointer; accent-color: var(--accent); }
/* 组行操作：展开/拆分是行内小字按钮，不是主要操作 */
.link-btn {
  border: none; background: none; color: var(--accent);
  font-size: 11px; cursor: pointer; padding: 0 4px;
}
.link-btn:hover { text-decoration: underline; }
.link-btn.danger { color: var(--dim); }
.link-btn.danger:hover { color: var(--bad); }
/* 重命名输入框：行内小输入，与小字按钮同高 */
.rename-wrap { display: flex; align-items: center; }
/* 展开的明细行：缩进 + 弱化，表明从属关系 */
.sub-row td { background: color-mix(in srgb, var(--panel-2) 55%, transparent); }
.sub-name { padding-left: 14px; }
.attr th { text-align: left; color: var(--dim); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--line); }
.attr td { padding: 7px 8px; border-bottom: 1px solid var(--line); }
.attr tr:last-child td { border-bottom: 0; }
.attr .n { text-align: right; }
.attr th.sortable { cursor: pointer; user-select: none; }
.attr th.sortable:hover { color: var(--text); }
.sort-arrow { color: var(--accent); }
/* 分页页脚：与面板同构的页脚条（吃掉面板 padding 通到边缘），不再是一行孤零零的小数字 */
.pager {
  display: flex; align-items: center; justify-content: flex-end; gap: 16px;
  margin: 10px -16px -14px; padding: 10px 16px;
  border-top: 1px solid var(--line); background: var(--panel-2);
  border-radius: 0 0 8px 8px;
}
.pager-total { color: var(--dim); font-size: 12px; }
.pager :deep(.el-pagination) {
  --el-pagination-bg-color: transparent;
  --el-pagination-text-color: var(--dim);
  --el-pagination-button-color: var(--text);
  --el-pagination-hover-color: var(--accent);
  --el-pagination-button-height: 28px;
  --el-pagination-button-width: 28px;
  --el-pagination-font-size: 13px;
}
.pager :deep(.el-pager li) { border-radius: 6px; }
.pager :deep(.el-pager li.is-active) {
  background: color-mix(in srgb, var(--accent) 18%, var(--panel));
  color: var(--accent); font-weight: 600;
}
.attr .strong { font-weight: 600; }
.attr .err { color: var(--bad); }
.model-name { font-family: var(--mono); }
/* 归因行里的内部分 id：名字可能重复（删除后重建），#N 用来区分是哪一个 */
.pid { color: var(--dim); opacity: .65; margin-left: 6px; font-size: 11px; }
/* 视图 A 里模型是主行、来源是副行，副行字号收一档 */
.sub-src { font-size: 11.5px; color: var(--dim); margin-top: 2px; }
.src-name { font-weight: 600; font-size: 12px; }
.model-line { font-size: 11px; color: var(--dim); }
.bar-col { width: 120px; }
.bar { height: 6px; background: var(--panel-2, #1a222d); border-radius: 3px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--accent); border-radius: 3px; }

/* ---- 时间胶囊（TIME-RANGE-FILTER §3.3）：轻量 popover，非全屏弹窗 ----
   胶囊 = 当前区间指示器（钟表icon + label），弹窗 = 预设三档 + 日期区间选择。
   归因区数字都跟这个区间（stat card：总 token / 请求数 / 缓存命中率 + 归因表）。
   例外：「活跃天数」跟热力图走全周期，不吃胶囊（见 activeDays 注释）。 */
.range-pill-wrap { position: relative; }
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
</style>
