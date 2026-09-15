// AI 回填的纯逻辑（从 Projects.vue 抽出来以便单测）。
// 只管「AI 给了什么 → 填进哪些服务」，不碰 DOM、不碰网络。

/** AI 返回的服务片段：字段全可选，因为模型经常只给一部分。 */
export interface AiService {
  name?: string
  dir?: string
  cmd?: string
  port?: number | string
  portEnv?: string
  maxRuntimeHours?: number | string
}

/**
 * pickServices：AI 返回单个对象或数组都接（与导入弹窗同一份 JSON 契约）。
 * 一个项目多服务（api+web）→ 全部返回；多个项目对象 → 拼它们的服务。
 * 拿不到就返回空数组，让调用方决定怎么提示。
 */
export function pickServices(raw: unknown): AiService[] {
  let v: unknown = raw
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return [] }
  }
  if (!v || typeof v !== 'object') return []
  const arr = Array.isArray(v) ? v : [v]
  const out: AiService[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const rec = item as { services?: unknown; cmd?: unknown; name?: unknown }
    if (Array.isArray(rec.services) && rec.services.length) {
      for (const s of rec.services) {
        if (s && typeof s === 'object') out.push(s as AiService)
      }
    } else if (rec.cmd || rec.name) {
      out.push(rec as AiService)
    }
  }
  return out
}

/**
 * childOf：cand 是否是 root 本身或其子路径（跨平台分隔符）。
 * AI 给的工作目录只在这条边界内才采信 —— 它编一个不相干路径比留空危险。
 */
export function childOf(root: string, cand: string): boolean {
  if (!root || !cand) return false
  const r = String(root).replace(/[\\/]+$/, '')
  const c = String(cand).replace(/[\\/]+$/, '')
  if (c === r) return true
  const sep = r.includes('\\') ? '\\' : '/'
  return c.startsWith(r + sep)
}

/**
 * applyAiService：把 AI 给的一个服务填进表单服务对象。
 * 只覆盖 AI 真给出来的字段；dir 仅在 childOf(root) 内才采信。
 */
export function applyAiService(
  s: Record<string, unknown>,
  svc: AiService,
  root = '',
): Record<string, unknown> {
  if (!s || !svc) return s
  if (svc.name) s.name = String(svc.name)
  if (svc.cmd) s.cmd = String(svc.cmd)
  if (svc.port != null) s.port = Number(svc.port) || 0
  if (svc.portEnv) s.portEnv = String(svc.portEnv)
  if (svc.maxRuntimeHours != null) s.maxRuntimeHours = Number(svc.maxRuntimeHours) || 0
  if (svc.dir && childOf(root, svc.dir)) s.dir = String(svc.dir)
  return s
}
