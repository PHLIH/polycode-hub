import { describe, test, expect } from 'vitest'
import { placeTip } from '../../web/src/hintTip.ts'

// 回归背景：占比条的提示原先是原生 title，浏览器要等约 1 秒才弹（用户要「实时」），
// 改成自绘即时提示。自绘就得自己算位置，而位置算错的后果是「框压住目标本身」
// 或「框跑出视口看不见」——所以把这段纯计算抽出来钉死。
//
// 常量与实现同步：GAP=10、EDGE=8（视口留白）。这里按行为断言，不复制内部常量。
const VW = 1200
const VH = 800
const W = 186  // 多行框宽
const H = 96

// 视口正中偏下的一个普通目标，四周都有空间
const MID = { left: 500, right: 620, top: 400, bottom: 426 }

describe('提示框定位：不压住目标、不跑出视口', () => {
  test('首选目标正上方，水平居中', () => {
    const p = placeTip(MID, W, H, VW, VH)
    expect(p.side).toBe('top')
    // 框底在目标顶之上（留 GAP）
    expect(p.top + H).toBeLessThanOrEqual(MID.top)
    // 水平居中：框中心 ≈ 目标中心
    expect(p.left + W / 2).toBeCloseTo((MID.left + MID.right) / 2, 6)
  })

  test('上方放不下 → 翻到下方（箭头朝上）', () => {
    // 目标贴着视口顶部，上方塞不下 H
    const nearTop = { left: 500, right: 620, top: 4, bottom: 30 }
    const p = placeTip(nearTop, W, H, VW, VH)
    expect(p.side).toBe('below')
    expect(p.top).toBeGreaterThanOrEqual(nearTop.bottom)
  })

  test('目标太靠下 → 框被夹回视口内，不溢出底部', () => {
    // 目标贴着视口底部：翻到下方会溢出，必须夹回
    const nearBottom = { left: 500, right: 620, top: VH - 30, bottom: VH }
    const p = placeTip(nearBottom, W, H, VW, VH)
    expect(p.top + H).toBeLessThanOrEqual(VH)
    expect(p.top).toBeGreaterThanOrEqual(0)
  })

  test('目标贴左边缘 → 框被收边，不越出左侧', () => {
    const nearLeft = { left: 0, right: 120, top: 400, bottom: 426 }
    const p = placeTip(nearLeft, W, H, VW, VH)
    expect(p.left).toBeGreaterThanOrEqual(0)
  })

  test('目标贴右边缘 → 框被收边，不越出右侧', () => {
    const nearRight = { left: VW - 120, right: VW, top: 400, bottom: 426 }
    const p = placeTip(nearRight, W, H, VW, VH)
    expect(p.left + W).toBeLessThanOrEqual(VW)
  })

  test('任何情况下框都不与目标纵向相交（硬约束）', () => {
    // 扫一遍各种目标位置，确认没有一种组合会压住目标
    for (let top = 0; top <= VH; top += 37) {
      const anchor = { left: 300, right: 420, top, bottom: top + 26 }
      const p = placeTip(anchor, W, H, VW, VH)
      const overlaps = p.top < anchor.bottom && p.top + H > anchor.top
      expect(overlaps, `anchor.top=${top} side=${p.side} top=${p.top}`).toBe(false)
    }
  })

  test('单行框（更宽更矮，占比条用）同样满足硬约束', () => {
    // 占比条提示是 width:auto，实测尺寸与多行框不同 -> 用一组更扁的尺寸再扫一遍
    for (let top = 0; top <= VH; top += 41) {
      const anchor = { left: 700, right: 820, top, bottom: top + 26 }
      const p = placeTip(anchor, 120, 34, VW, VH)
      const overlaps = p.top < anchor.bottom && p.top + 34 > anchor.top
      expect(overlaps, `anchor.top=${top} side=${p.side} top=${p.top}`).toBe(false)
    }
  })
})
