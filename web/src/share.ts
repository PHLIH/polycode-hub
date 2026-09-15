// 占比条的唯口径（概览归因表 + 账号明细表共用）。
// 分母是「组内总 token」，不是「组内最大值」——
// 相对最大会让最大的那行恒等于 100%、进度条永远满格，读不出真实占比。

/** 占比条能算的行：有 totalTokens 即可，缺字段按 0 处理。 */
export interface ShareRow {
  totalTokens?: number
}

/**
 * 一行在组内的真实占比：0~1。
 * 组内总量为 0（区间无用量）返回 0，不产出 NaN。
 */
export function shareOf(rows: ShareRow[] | null | undefined, row: ShareRow | null | undefined): number {
  const total = (rows || []).reduce((s: number, r: ShareRow) => s + (r.totalTokens || 0), 0)
  if (!total) return 0
  return (row?.totalTokens || 0) / total
}

/** 进度条的悬浮文案：把占比说成人话。 */
export function shareTitle(rows: ShareRow[] | null | undefined, row: ShareRow | null | undefined): string {
  return `占总 token ${(shareOf(rows, row) * 100).toFixed(1)}%`
}
