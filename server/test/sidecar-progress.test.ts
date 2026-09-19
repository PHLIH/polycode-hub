// 安装进度的展示规则（从 sidecarJob.ts 抽出的纯函数）。
//
// 这些规则决定了用户在页面上到底看到什么，而它们本身没有任何 IO，
// 所以放在这里锚死：百分比只在有总数时给（丢了 Content-Length 不能编数字）、
// 失败原因必须常驻且标明是「上次」、字节与耗时的拼法。

import { describe, expect, test } from 'vitest'
import { detailOf, errorOf, fmtDur, fmtMB, percentOf, phaseLabelOf, proxyOf } from '../../web/src/sidecarProgress.ts'
import type { InstallJobLike } from '../../web/src/sidecarProgress.ts'

const MB = 1048576
const job = (over: Partial<InstallJobLike> = {}): InstallJobLike => ({
  running: true,
  phase: 'downloading',
  received: 0,
  total: 0,
  elapsedMs: 0,
  ok: false,
  error: '',
  downloadProxy: '',
  downloadProxySource: '',
  ...over,
})

describe('安装进度展示规则', () => {
  test('percentOf：只在「在下载且有总数」时给百分比', () => {
    expect(percentOf(null)).toBeNull()
    expect(percentOf(job({ running: false }))).toBeNull()
    // 非下载阶段没有百分比可言（校验/配置/启动都是瞬时或不定长）
    expect(percentOf(job({ phase: 'verifying', received: 10, total: 10 }))).toBeNull()
    // 丢了 Content-Length（total=0）→ 不编百分比，交给视图显示不确定进度条
    expect(percentOf(job({ received: 3 * MB, total: 0 }))).toBeNull()
    // 正常：30.1 / 66.4 MB ≈ 45%
    expect(percentOf(job({ received: Math.round(30.1 * MB), total: Math.round(66.4 * MB) }))).toBe(45)
    // 上游多吐了几个字节也不能超过 100%
    expect(percentOf(job({ received: 70 * MB, total: 66 * MB }))).toBe(100)
  })

  test('phaseLabelOf：阶段中文名 + 有总数时带百分比', () => {
    expect(phaseLabelOf(null)).toBe('')
    expect(phaseLabelOf(job({ running: false }))).toBe('')
    expect(phaseLabelOf(job({ phase: 'resolving' }))).toBe('正在查询最新版本')
    expect(phaseLabelOf(job({ phase: 'downloading', received: 0, total: 0 }))).toBe('正在下载引擎')
    expect(phaseLabelOf(job({ phase: 'downloading', received: Math.round(30.1 * MB), total: Math.round(66.4 * MB) })))
      .toBe('正在下载引擎 45%')
    expect(phaseLabelOf(job({ phase: 'configuring' }))).toBe('正在生成安全配置')
    expect(phaseLabelOf(job({ phase: 'starting' }))).toBe('正在启动引擎')
    // 后端将来加了新阶段也不能渲染成空白
    expect(phaseLabelOf(job({ phase: 'mystery' }))).toBe('正在安装')
  })

  test('detailOf：下载阶段给字节，其余阶段只给耗时', () => {
    expect(detailOf(null)).toBe('')
    expect(detailOf(job({ running: false }))).toBe('')
    expect(detailOf(job({ received: Math.round(30.1 * MB), total: Math.round(66.4 * MB), elapsedMs: 72000 })))
      .toBe('30.1 / 66.4 MB · 已用 1 分 12 秒')
    // 无总数：只报已收，不报一个假的「/ 0 MB」
    expect(detailOf(job({ received: 3 * MB, total: 0, elapsedMs: 5000 })))
      .toBe('3.0 MB · 已用 5 秒')
    expect(detailOf(job({ phase: 'starting', elapsedMs: 45000 }))).toBe('已用 45 秒')
  })

  test('fmtDur / fmtMB：负数与边界不产生「-1 秒」「NaN」这类文案', () => {
    expect(fmtDur(0)).toBe('0 秒')
    expect(fmtDur(999)).toBe('1 秒')
    expect(fmtDur(59_400)).toBe('59 秒')
    expect(fmtDur(60_000)).toBe('1 分 0 秒')
    expect(fmtDur(-5000)).toBe('0 秒')
    expect(fmtMB(0)).toBe('0.0')
    expect(fmtMB(MB)).toBe('1.0')
    expect(fmtMB(66.4 * MB)).toBe('66.4')
  })

  test('errorOf：失败原因常驻并标明「上次」，成功/进行中不显示', () => {
    expect(errorOf(null)).toBe('')
    // 正在跑：不显示上一轮的旧错误
    expect(errorOf(job({ running: true, error: '旧的失败' }))).toBe('')
    // 成功：清掉
    expect(errorOf(job({ running: false, ok: true, error: '' }))).toBe('')
    expect(errorOf(job({ running: false, ok: false, error: '' }))).toBe('')
    expect(errorOf(job({ running: false, ok: false, error: '下载 x 失败 —— ECONNRESET。请换节点后重试' })))
      .toBe('上次安装失败：下载 x 失败 —— ECONNRESET。请换节点后重试')
  })

  test('proxyOf：带出来源，空值不渲染半个括号', () => {
    expect(proxyOf(null)).toBe('')
    expect(proxyOf(job())).toBe('')
    expect(proxyOf(job({ downloadProxy: 'http://127.0.0.1:7897', downloadProxySource: 'egress-auto:clash' })))
      .toBe('http://127.0.0.1:7897（来源 egress-auto:clash）')
  })
})
