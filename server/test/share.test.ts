import { describe, test, expect } from 'vitest'
import { shareOf, shareTitle, type ShareRow } from '../../web/src/share.ts'

// 回归背景：旧口径分母是「全表最大 totalTokens」，导致用量第一的行恒等于 100%、
// 进度条永远满格，读不出真实占比。分母必须是区间总量。
describe('占比条口径', () => {
  const a: ShareRow = { totalTokens: 300 }
  const b: ShareRow = { totalTokens: 200 }
  const c: ShareRow = { totalTokens: 100 }
  const rows: ShareRow[] = [a, b, c]

  test('分母是区间总量：第一名 50% 而不是 100%', () => {
    expect(shareOf(rows, a)).toBeCloseTo(0.5, 6)
    expect(shareOf(rows, b)).toBeCloseTo(1 / 3, 6)
    expect(shareOf(rows, c)).toBeCloseTo(1 / 6, 6)
  })

  test('所有行占比之和为 1', () => {
    const sum = rows.reduce((s, r) => s + shareOf(rows, r), 0)
    expect(sum).toBeCloseTo(1, 6)
  })

  test('只有一行时才是 100%', () => {
    expect(shareOf([a], a)).toBe(1)
  })

  test('总量为 0（区间无用量）→ 0，不产出 NaN', () => {
    const zero: ShareRow[] = [{ totalTokens: 0 }, { totalTokens: 0 }]
    expect(shareOf(zero, zero[0] ?? {})).toBe(0)
    expect(Number.isNaN(shareOf(zero, zero[0] ?? {}))).toBe(false)
  })

  test('缺 totalTokens 字段当 0，不崩', () => {
    const none: ShareRow = {}
    const ten: ShareRow = { totalTokens: 10 }
    expect(shareOf([none, ten], none)).toBe(0)
    expect(shareOf([none, ten], ten)).toBe(1)
  })

  test('空组 / 行缺失：返回 0 而不是 NaN', () => {
    expect(shareOf([], a)).toBe(0)
    expect(shareOf(null, a)).toBe(0)
    expect(shareOf(rows, null)).toBe(0)
  })

  test('悬浮文案是百分比（真占比，不是相对最大）', () => {
    expect(shareTitle(rows, a)).toBe('占总 token 50.0%')
    expect(shareTitle(rows, c)).toBe('占总 token 16.7%')
    expect(shareTitle([{ totalTokens: 0 }], { totalTokens: 0 })).toBe('占总 token 0.0%')
  })
})
