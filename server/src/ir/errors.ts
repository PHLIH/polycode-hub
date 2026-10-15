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
  // 本地账号池无可用账号：该源配了账号，但全部冷却/额度用尽/被停用。
  //
  // 必须独立于 AUTH：这条错误**根本没打到上游**（status 恒 0，请求在本地就被拦下），
  // 却顶着「鉴权」二字，会把用户推去反复翻凭据——而凭据很可能是好的。
  // 真实故障（用户反馈）：WorkBuddy 的 Provider 凭据是草稿占位 apiKeyEnv=WB_TOKEN，
  // 账号池里的号一旦全部不可用，回落打 Provider 级凭据就报「环境变量 WB_TOKEN 未设置」，
  // 用户照着重装/重配一遍，问题依旧（账号还是不可用）。
  // 归 RATE_LIMIT 也不对：账号是被本地判定不可用的，恢复方式是「重置/换号」而不是等。
  NO_ACCOUNT: 'no_account',
  UNKNOWN: 'unknown',
} as const

// 账号池侧的失败上下文（NO_ACCOUNT 专用）：让上层（管理面/用量页）不必重新查池
// 就能如实说明「名下几个号、都卡在哪」，而不是只给一句「无可用账号」。
type UpstreamAcctInfo = {
  total: number
  byStatus: string // 已格式化的人话摘要，如「冷却中 1、额度用尽 1」
  last?: { kind: string; message: string; at: Date }
}

export class UpstreamError extends Error {
  readonly status: number // 0 = 未拿到响应（网络/DNS/超时）
  readonly kind: string
  // 可选第 4 参：只在失败原因与账号池状态有关时携带。既有 26 处调用点全部不用改。
  readonly acct?: UpstreamAcctInfo
  // 不带 `upstream <kind>:` 前缀的原文（就是构造时第 3 参）。
  //
  // 需要它是因为那个前缀是**给日志/排障用的机器可读标签**，不是给人看的：
  // 直接端给用户就变成「upstream no_account: 账号池无可用账号…」——一句夹着英文
  // 标识符且自称“upstream”的话，而这件事根本没到上游（NO_ACCOUNT 就是本地拦下的）。
  // 需要面向用户的文案时用 detail；message 维持原样（既有日志格式不变）。
  readonly detail: string
  constructor(status: number, kind: string, message: string, acct?: UpstreamAcctInfo) {
    super(status !== 0 ? `upstream ${kind} (http ${status}): ${message}` : `upstream ${kind}: ${message}`)
    this.status = status
    this.kind = kind
    this.acct = acct
    this.detail = message
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
