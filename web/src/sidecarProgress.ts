// 安装进度的纯展示逻辑（从 sidecarJob.ts 抽出来以便单测）。
// 只管「服务端作业态 → 页面文案/百分比」，不碰 Vue、不碰网络、不碰 DOM。

/** 服务端 GET /admin/api/sidecar 里 install 字段的形状。 */
export interface InstallJobLike {
  running: boolean
  phase: string
  received: number
  total: number
  // startedAt/finishedAt/cancelled 服务端恒下发；标成可选是为兼容旧载荷与测试
  // 构造的部分字面量。消费侧一律带缺省判断（finishedAt ?? 0、cancelled === true）。
  startedAt?: number
  elapsedMs: number
  // finishedAt !== 0 = 作业已有结论（成功/失败/取消）；空闲初值两者都是 0。
  finishedAt?: number
  ok: boolean
  error: string
  // 用户主动暂停/取消（非失败）：页面不渲染成红报错。
  cancelled?: boolean
  downloadProxy: string
  downloadProxySource: string
}

const PHASE_TEXT: Record<string, string> = {
  resolving: '正在查询最新版本',
  downloading: '正在下载引擎',
  verifying: '正在校验并落盘',
  configuring: '正在生成安全配置',
  starting: '正在启动引擎',
}

export function fmtMB(n: number): string {
  return (n / 1048576).toFixed(1)
}

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

// percentOf：只在「有总数」时给百分比。上游或代理丢了 Content-Length 时
// 后端回 total=0，这里返回 null，由视图降级成不确定进度条——
// 宁可显示「在动但不知道到哪」，也不编一个会突然跳变的假百分比。
export function percentOf(j: InstallJobLike | null): number | null {
  if (!j || !j.running || j.phase !== 'downloading' || j.total <= 0) return null
  return Math.min(100, Math.round((j.received / j.total) * 100))
}

export function phaseLabelOf(j: InstallJobLike | null): string {
  if (!j || !j.running) return ''
  const base = PHASE_TEXT[j.phase] ?? '正在安装'
  const p = percentOf(j)
  return p === null ? base : `${base} ${p}%`
}

// detailOf：字节与耗时。下载阶段显示 已收/总量，其余阶段只给耗时
// （阶段名本身已经说清在干什么，再堆数字是噪音）。
export function detailOf(j: InstallJobLike | null): string {
  if (!j || !j.running) return ''
  const used = `已用 ${fmtDur(j.elapsedMs)}`
  if (j.phase !== 'downloading') return used
  return j.total > 0 ? `${fmtMB(j.received)} / ${fmtMB(j.total)} MB · ${used}` : `${fmtMB(j.received)} MB · ${used}`
}

// errorOf：失败原因常驻（不是会消失的 toast），切页回来还能看到。
// 前缀「上次安装失败」是为了说清这是历史结果而不是此刻正在发生——
// 作业态会一直留到下一次尝试，不点重试就永远在。
export function errorOf(j: InstallJobLike | null): string {
  if (!j || j.running || j.ok || j.error === '') return ''
  return `上次安装失败：${j.error}`
}

// proxyOf：这次尝试实际走的下载出口——失败时「走了哪个代理」是排障第一问。
export function proxyOf(j: InstallJobLike | null): string {
  if (!j || j.downloadProxy === '') return ''
  return `${j.downloadProxy}（来源 ${j.downloadProxySource}）`
}
