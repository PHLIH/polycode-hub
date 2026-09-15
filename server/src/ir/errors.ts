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
  return { type, message, httpStatus: HTTP_STATUS[type] ?? 500 }
}

export const UPSTREAM = {
  NETWORK: 'network',
  AUTH: 'auth',
  RATE_LIMIT: 'rate_limit',
  QUOTA: 'quota',
  BAD_REQUEST: 'bad_request',
  SERVER: 'server',
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

export function kindForStatus(status: number): string {
  if (status === 401 || status === 403) return UPSTREAM.AUTH
  if (status === 402) return UPSTREAM.QUOTA
  if (status === 429) return UPSTREAM.RATE_LIMIT
  if (status === 400 || status === 404 || status === 413 || status === 422) return UPSTREAM.BAD_REQUEST
  if (status >= 500) return UPSTREAM.SERVER
  return UPSTREAM.UNKNOWN
}
