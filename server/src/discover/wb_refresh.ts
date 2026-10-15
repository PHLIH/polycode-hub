// WorkBuddy 登录态自动刷新（官方客户端同款刷新链路）。
//
// 背景：新版 WorkBuddy 客户端（5.5.x 起）把存量 auth 文件里的 accessToken /
// nickname / phoneNumber 换成了加密信封（{"$wbEncrypted":1,"envelope":"…"}），
// 网关读不出明文 token，扫描能发现、Provider 能采用、账号导入却被拒——
// 「一键导入」看起来像是废的。但客户端自己的事实是：
//   · refreshToken 仍是**明文**（信封方案只加密了业务 token，没动刷新凭据）
//   · 官方刷新链路完全公开：POST /v2/plugin/auth/token/refresh，
//     头带 X-Refresh-Token（来源：客户端 CLI 代码 WxAuthenticationProvider
//     /refreshSession + 本机 acc-product-config-v3.json 的
//     authentication.attributes.prefixPath = "/plugin"，实测 2026-09-29
//     copilot.tencent.com HTTP 200 换出有效 accessToken）
//
// 所以「信封读不出明文」不等于「导入不了」：用明文 refreshToken 走官方端点
// 换新 token 即可。这是**客户端自己刷新自己账号**的同一条路，不是逆向加密——
// 密文仍然没人解，我们根本不碰信封。用户本来就授权自己的账号、自己的机器；
// 厂商加密的是「别人偷文件」的场景，而 refresh token 依旧明文留在同一份文件里，
// 说明厂商自己也没把这条链当成要防的边界。
//
// 端点与 prefixPath 是**运行时事实**，不是常量：上游改协议时按失败如实报，
// 不猜第二个端点（猜错就是把用户的刷新凭据往未知服务器上送）。

import { wbAuxEndpointIdentityHeaders } from '../model/index.ts'

export type FetchLike = typeof fetch

// 国内版 / 海外版的刷新 base（域从登录态文件的 auth.domain 派生，不写死单机事实）。
export function wbRefreshBaseOf(domain: string | undefined): string | undefined {
  const raw = (domain ?? '').trim().toLowerCase()
  const d = raw.replace(/^www\./, '')
  if (d === 'copilot.tencent.com' || d === 'workbuddy.cn') return 'https://copilot.tencent.com'
  // 海外版**必须保留 www**：2026-10-15 实测（本机真实 refreshToken，同一天同一秒对照）——
  //   POST https://www.workbuddy.ai/v2/plugin/auth/token/refresh → 200，换出有效 token；
  //   POST https://workbuddy.ai/v2/plugin/auth/token/refresh     → 302 Location: https://www.workbuddy.ai:443/
  //     （注意 Location 里**没有路径**）→ 跟随过去拿到的是 HTML 首页，不是 JSON。
  // 这里此前写着 `return 'https://workbuddy.ai'`（把 www 剥掉），后果是海外版的
  // **自动刷新整条链路恒失败**：信封登录态刷不出明文 → 账号导入被跳过（imported=0）
  // → Provider 只剩草稿里的占位 apiKeyEnv=WB_TOKEN → 用户看到「环境变量 WB_TOKEN
  // 未设置」，被告知去配环境变量或跑一次客户端重登。真实病因只是少了一个 www。
  // 国内版无此问题（copilot.tencent.com 无 www 变体），所以这条只在 ai 分支生效。
  if (d === 'workbuddy.ai') return 'https://www.workbuddy.ai'
  return undefined
}

// 一次刷新的结果（只含转发所需字段；明文 token 由调用方落凭据文件，不落日志）。
export interface WbRefreshed {
  accessToken: string
  refreshToken?: string
  expiresAt?: Date
  realm: 'cn' | 'ai'
}

function compact(s: string): string {
  return s.length > 200 ? s.slice(0, 200) + '…' : s
}

// JWT exp（不验签）；解析不出返回 null。
function jwtExpiry(token: string): Date | null {
  const parts = token.split('.')
  if (parts.length < 2 || !parts[1]) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: number }
    if (!claims.exp) return null
    return new Date(claims.exp * 1000)
  } catch {
    return null
  }
}

// 用明文 refreshToken 走官方刷新端点换新 token。
// 抛错即失败（网络 / 上游拒绝 / 响应形状不认识），调用方按失败如实报。
export async function wbRefreshSession(
  refreshToken: string, realm: 'cn' | 'ai', fetchImpl: FetchLike = globalThis.fetch,
): Promise<WbRefreshed> {
  const base = wbRefreshBaseOf(realm === 'cn' ? 'copilot.tencent.com' : 'www.workbuddy.ai')
  if (!base) throw new Error(`认不出 ${realm} 版的刷新端点域`)
  const url = `${base}/v2/plugin/auth/token/refresh`
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Refresh-Token': refreshToken,
        'X-Auth-Refresh-Source': 'plugin',
        'X-Domain': realm === 'cn' ? 'copilot.tencent.com' : 'www.workbuddy.ai',
        ...wbAuxEndpointIdentityHeaders(),
      },
      body: '{}',
    })
  } catch (e) {
    throw new Error(`刷新请求失败: ${(e as Error).message}`)
  }
  const text = await res.text().catch(() => '')
  if (res.status < 200 || res.status > 299) {
    throw new Error(`刷新被拒（http ${res.status}）: ${compact(text)}`)
  }
  let env: unknown
  try {
    env = JSON.parse(text)
  } catch {
    throw new Error('刷新响应非 JSON: ' + compact(text))
  }
  const data = (env as { data?: { data?: unknown } })?.data?.data
    ?? (env as { data?: unknown })?.data
  if (typeof data !== 'object' || data === null) {
    throw new Error('刷新响应缺少 data.data 包络: ' + compact(text))
  }
  const d = data as { accessToken?: unknown; refreshToken?: unknown; expiresIn?: unknown }
  if (typeof d.accessToken !== 'string' || d.accessToken.length < 100) {
    throw new Error('刷新响应不含有效 accessToken: ' + compact(text))
  }
  const token = d.accessToken.trim()
  // 有效期：JWT exp 打底，客户端写的 expiresIn 兜底（单位秒）。
  let expiresAt = jwtExpiry(token)
  if (!expiresAt && typeof d.expiresIn === 'number' && d.expiresIn > 0) {
    expiresAt = new Date(Date.now() + d.expiresIn * 1000)
  }
  return {
    accessToken: token,
    refreshToken: typeof d.refreshToken === 'string' && d.refreshToken.length > 50
      ? d.refreshToken
      : undefined,
    expiresAt: expiresAt ?? undefined,
    realm,
  }
}
