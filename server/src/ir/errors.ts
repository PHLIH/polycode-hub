// IR 错误（对齐 Go internal/ir/errors.go）。
// UpstreamError 是「首字节前」上游失败的规范形态：调度器见它可安全换源；
// 拿到流之后的一切失败以 IR error 事件/读错误透传，禁止换源（换源闸门硬约束）。

export const ERR = {
  INVALID_REQUEST: 'invalid_request_error',
  AUTHENTICATION: 'authentication_error',
  PERMISSION: 'permission_error',
  NOT_FOUND: 'not_found_error',
  REQUEST_TOO_LARGE: 'request_too_large',
  RATE_LIMIT: 'rate_limit_error',
  API: 'api_error',
  OVERLOADED: 'overloaded_error',
} as const

export interface IrError {
  type: string
  message: string
  httpStatus: number
}

const HTTP_STATUS: Record<string, number> = {
  [ERR.INVALID_REQUEST]: 400,
  [ERR.AUTHENTICATION]: 401,
  [ERR.PERMISSION]: 403,
  [ERR.NOT_FOUND]: 404,
  [ERR.REQUEST_TOO_LARGE]: 413,
  [ERR.RATE_LIMIT]: 429,
  [ERR.OVERLOADED]: 529,
}

export function irError(type: string, message: string): IrError {
  // 未知 type 回落 500（HTTP_STATUS 无该项时 ?? 500）。
  return { type, message, httpStatus: HTTP_STATUS[type] ?? 500 }
}

export const UPSTREAM = {
  NETWORK: 'network',
  AUTH: 'auth',
  RATE_LIMIT: 'rate_limit',
  QUOTA: 'quota',
  BAD_REQUEST: 'bad_request',
  SERVER: 'server',
  // 指纹缺失：上游按策略拒绝「非官方客户端」流量（如 zen 的 FreeTierError）。
  // 既不是凭据错（Key 是好的）也不是协议路径错（换端点照样 403），必须独立分类：
  // 归 auth 会让人去翻 API Key，归 bad_request 又会被探测当成「路径噪音」压到最低优先级，
  // 真实病因（缺 UA/会话指纹）在报错里永远浮不上来。
  FINGERPRINT: 'fingerprint',
  // 地区限制：模型在当前出口 IP 所在地区不可用（RegionError / "not available in your
  // country"）。与指纹同属「被拒但不是凭据问题」，但病灶不同——换出口代理可解，
  // 所以必须分开：归 auth 会让人去翻 API Key，归 bad_request 会被当协议噪音压下去。
  REGION: 'region',
  UNKNOWN: 'unknown',
} as const

export class UpstreamError extends Error {
  readonly status: number // 0 = 未拿到响应（网络/DNS/超时）
  readonly kind: string
  constructor(status: number, kind: string, message: string) {
    super(status !== 0 ? `upstream ${kind} (http ${status}): ${message}` : `upstream ${kind}: ${message}`)
    this.status = status
    this.kind = kind
  }
}

// 状态码 → 上游失败分类：401/403 鉴权、402 额度用尽、429 限流、
// 400/404/413/422 请求侧、5xx 服务端，其余 unknown。
// 注意 403 只是初判（RegionError 等会由 classifyUpstreamError 细分为 bad_request），
// 402 恒为 quota（与 429 + QUOTA_HINT 互补，见 upstream.ts）。
export function kindForStatus(status: number): string {
  if (status === 401 || status === 403) return UPSTREAM.AUTH
  if (status === 402) return UPSTREAM.QUOTA
  if (status === 429) return UPSTREAM.RATE_LIMIT
  if (status === 400 || status === 404 || status === 413 || status === 422) return UPSTREAM.BAD_REQUEST
  if (status >= 500) return UPSTREAM.SERVER
  return UPSTREAM.UNKNOWN
}
