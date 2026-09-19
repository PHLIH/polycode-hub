// 自绘 tooltip 的唯一定位实现（概览归因表 / 账号明细表共用）。
//
// 为什么不直接用原生 title：浏览器要等约 1 秒才弹（各浏览器不等，用户实测「悬停
// 一秒才显示，我想要实时」），而且样式不可控、无法排版。热力图当初也是为这个
// 原因自绘的（见 Dashboard.vue 的历史注释），现在把那份定位逻辑抽出来共用，
// 避免每个表各写一套。
//
// 定位硬约束：框永远不压住目标矩形本身。默认放在目标正上方并水平居中，
// 上方放不下就翻到下方，再放不下就推到侧边；水平方向按视口收边。
// 之所以分两步（先给估算坐标 → 渲染后按实测尺寸校正）：框高随内容变（多一行就高
// 一行），写死高度必然在某个组合下算错并压住目标。见 useHintTip 的 watch。

import { computed, nextTick, ref, watch, type CSSProperties, type Ref } from 'vue'

/** 锚点：只要 getBoundingClientRect 的形状即可（热力图格子、表格 td 都能喂）。 */
export interface AnchorLike {
  left: number
  right: number
  top: number
  bottom: number
}

export interface TipRow {
  label: string
  value: string | number
  /** 语义为「坏消息」的行（如失败数），渲染成告警色 */
  bad?: boolean
}

interface AnchorRect extends AnchorLike {
  width: number
}

interface TipBox {
  title: string
  rows: TipRow[]
  left: number
  top: number
  side: 'top' | 'below' | 'right'
  anchor: AnchorLike
}

const GAP = 10      // 框与目标的间距
const EDGE = 8      // 距视口边缘的最小留白

/** 校正后的坐标与方位；side 决定箭头朝向（见 styles.css 的 .heat-tip::after）。 */
export interface TipPlacement {
  left: number
  top: number
  side: 'top' | 'below' | 'right'
}

/**
 * 纯定位计算（抽出来是为了可测：这部分算错就会压住目标或跑出视口，
 * 而它跟 Vue/DOM 无关，没必要连着组件一起测）。
 *
 * 策略：目标上方（首选，视线自然落在光标上方）；上方空间不足就翻到目标下方；
 * 下方也放不下（视口太矮）就推到目标右侧——这一条是「框永不压住目标」硬约束的
 * 最后保障（styles.css 的 .heat-tip.right 箭头样式就服务于它）。
 * 水平方向始终以目标中心对齐，再做视口收边。
 *
 * 历史教训：曾把侧边分支当死代码删掉，理由是「翻到下方时 top 恒大于 anchor.bottom，
 * 触发条件 top < anchor.bottom 必然为假」——那个推理只对**未夹取前**成立。
 * 删掉后只剩「超出视口底部就上抬」（下方 top 被夹成 vh-EDGE-h），短视口下这个
 * 夹取会把框正好压回目标身上（vh=200/h=96 就是一例），硬约束被破坏，而当时的
 * 测试把视口高度写死 800，永远扫不到夹取分支，所以是假绿。
 */
export function placeTip(
  anchor: { left: number; right: number; top: number; bottom: number },
  w: number,
  h: number,
  vw: number,
  vh: number,
): TipPlacement {
  // 垂直：默认放目标上方；上方放不下就翻到下方
  const above = anchor.top - h - GAP >= EDGE
  let top = above ? anchor.top - h - GAP : anchor.bottom + GAP
  let side: TipPlacement['side'] = above ? 'top' : 'below'

  // 水平：以目标中心对齐，再做视口收边
  let left = anchor.left + (anchor.right - anchor.left) / 2 - w / 2
  if (left < EDGE) left = EDGE
  if (left + w > vw - EDGE) left = vw - EDGE - w

  // 下方放置后若超出视口底部，先试着上抬。短视口下上抬会压住目标（见上方注释），
  // 这时改推到目标右侧：垂直方向以目标为中心对齐，仍做视口收边。
  if (top + h > vh - EDGE) {
    const lifted = Math.max(EDGE, vh - EDGE - h)
    // 上抬后仍与目标纵向相交 → 右侧放置（放得下才推，放不下就保留上抬结果）。
    const overlaps = lifted < anchor.bottom && lifted + h > anchor.top
    const rightLeft = anchor.right + GAP
    if (overlaps && rightLeft + w <= vw - EDGE) {
      left = rightLeft
      top = anchor.top + (anchor.bottom - anchor.top) / 2 - h / 2
      if (top < EDGE) top = EDGE
      if (top + h > vh - EDGE) top = Math.max(EDGE, vh - EDGE - h)
      side = 'right'
    } else {
      top = lifted
    }
  }
  if (top < EDGE) top = EDGE

  return { left, top, side }
}

export interface HintTipOptions {
  /** 多行框的固定宽度（热力图多行对齐用）；单行框会按内容自适应 */
  width?: number
  /** 没有实测尺寸时的兜底高度 */
  fallbackHeight?: number
}

export function useHintTip(opts: HintTipOptions = {}) {
  const TIP_W = opts.width ?? 186
  const FALLBACK_H = opts.fallbackHeight ?? 96

  const tip = ref<TipBox | null>(null) as Ref<TipBox | null>
  // 元素引用用 any 存：本仓根 tsconfig 不含 DOM lib（web 侧源码是 .js/.ts 混写，
  // 只有 server 走 tsc），写 HTMLElement 会让 `tsc --noEmit` 报找不到类型名。
  const tipEl = ref<any>(null)
  // 校正后的坐标与参考坐标分开存：绝不能写回被 watch 的 tip，
  // 否则本轮写入会再触发本 watcher，微任务队列永不排空（悬停即卡死）。
  const pos = ref<TipPlacement | null>(null)

  function show(anchor: AnchorRect, title: string, rows: TipRow[]) {
    pos.value = null
    tip.value = {
      title, rows,
      left: anchor.left + anchor.width / 2 - TIP_W / 2, // 先居中，稍后校正
      top: anchor.top - GAP,                            // 先假设框底贴目标顶，稍后校正
      side: 'top',
      anchor: { left: anchor.left, right: anchor.right, top: anchor.top, bottom: anchor.bottom },
    }
  }

  function hide() {
    tip.value = null
    pos.value = null
  }

  // 渲染后校正：拿到框的真实宽高再决定最终位置，保证任何情况下都不压住目标。
  // 关键：校正结果写进独立字段 pos，绝不能写回被 watch 的 tip —— 否则本轮写入
  // 会再次触发本 watcher，微任务队列永不排空，主线程直接饿死（悬停即卡死）。
  watch(tip, async (t) => {
    if (!t) { pos.value = null; return }
    await nextTick()
    const el = tipEl.value
    if (!el) return
    const w = el.offsetWidth || TIP_W
    const h = el.offsetHeight || FALLBACK_H
    // window 同样不在 lib 里：经 globalThis 取，行为一致且类型干净。
    const gw = globalThis as unknown as { innerWidth: number; innerHeight: number }
    pos.value = placeTip(t.anchor, w, h, gw.innerWidth, gw.innerHeight)
  }, { flush: 'post' })

  // 首帧先用未校正坐标（框已自带 left/top），nextTick 后由 pos 覆盖为实测位置。
  const tipStyle = computed<CSSProperties>(() => {
    const p = pos.value || tip.value
    return p ? { left: p.left + 'px', top: p.top + 'px' } : {}
  })
  // 单行（占比条）不锁宽：靠 title 是否为空区分是不是热力图那种多行框。
  //
  // 判据必须看 tip.value（原始提示数据，带 title），**不能**看 pos.value：
  // pos 是 placeTip() 的结果（只有 left/top/side，没有 title 字段），
  // 而 nextTick 校正后 pos 几乎总是有值——取 `pos.value || tip.value` 会让
  // 'title' in p 恒为 false，于是 wide 恒真，热力图多行框也被套上 .tip-wide
  // （width:auto; white-space:nowrap），186px 的固定宽多行排版直接塌成一行。
  const tipClass = computed(() => {
    const p = pos.value || tip.value
    const wide = tip.value ? !tip.value.title : false
    return [p?.side || 'top', { 'tip-wide': wide }]
  })

  return { tip, tipEl, tipStyle, tipClass, show, hide }
}
