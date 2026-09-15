// ZCode OAuth 轮询登录流（对齐 Go internal/zcodeauth，协议事实见
// docs/zcode-reverse-engineering.md §3.2，来源已登记，独立实现）。
// 现行流程为官方 CLI 同款轮询流：init 拿授权链接 → 用户浏览器点同意 →
// 轮询拿到凭证 → access_token 再 resolve 一次换 business JWT（zcodejwttoken）。
// JWT 只打印一次，不落盘。HTTP 调用用注入的 fetch（默认全局 fetch）。

import { randomBytes } from 'node:crypto'

export type FetchLike = typeof fetch

// 生产端点（测试经构造参数覆盖）。
export const TOKEN_BASE = 'https://zcode.z.ai'
export const LOGIN_BASE = 'https://api.z.ai'

// 伪装浏览器 UA（上游 WAF 会 RST 非浏览器请求，实测非浏览器 UA 直接 EOF）。
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

// 一次登录轮询会话。
export interface Flow {
  flowID: string
  authorizeURL: string
  state: string
  pollToken: string // 32 随机字节 hex（init 与 poll 共用）
  pollIntervalMs: number
  expiresAt: Date
}

// 轮询批准后的凭证组（字段含义对齐官方客户端 tokenSet）。
export interface Session {
  // token 即 data.token，官方命名 zcodeJwtToken = business JWT，直接当 Bearer 用。
  token: string
  // accessToken 即 data.zai.access_token（身份侧）。
  accessToken: string
  // userID 即 data.user.user_id。
  userID: string
  // code 兼容旧形态（data.code，回调流用）。
  code: string
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function compact(s: string): string {
  return s.length > 300 ? s.slice(0, 300) + '…' : s
}

type Envelope = Record<string, unknown>

// 解析 {code,msg,data} 包络；code 非 0 即业务失败。
async function decodeEnvelope(res: Response): Promise<Envelope> {
  const text = await res.text()
  if (res.status < 200 || res.status > 299) {
    throw new Error(`http ${res.status}: ${compact(text)}`)
  }
  let env: Envelope
  try {
    env = JSON.parse(text) as Envelope
  } catch (err) {
    throw new Error(`响应非 JSON: ${(err as Error).message}`)
  }
  const code = typeof env.code === 'number' ? env.code : 0
  if (code !== 0) {
    const msg = typeof env.msg === 'string' && env.msg ? env.msg : `code=${code}`
    throw new Error(msg)
  }
  return env
}

function dataOf(env: Envelope): Record<string, unknown> | null {
  const d = env.data
  return d !== null && typeof d === 'object' ? (d as Record<string, unknown>) : null
}

// 从批准响应提取凭证；无凭证返回 null（继续等）。
function parseSession(data: Record<string, unknown>): Session | null {
  const code = typeof data.code === 'string' ? data.code : ''
  if (code) return { token: '', accessToken: '', userID: '', code }
  const token = typeof data.token === 'string' ? data.token : ''
  if (!token) return null
  const s: Session = { token, accessToken: '', userID: '', code: '' }
  const zai = data.zai
  if (zai !== null && typeof zai === 'object' && typeof (zai as Record<string, unknown>).access_token === 'string') {
    s.accessToken = (zai as Record<string, unknown>).access_token as string
  }
  const user = data.user
  if (user !== null && typeof user === 'object' && typeof (user as Record<string, unknown>).user_id === 'string') {
    s.userID = (user as Record<string, unknown>).user_id as string
  }
  return s
}

export class Client {
  private readonly tokenBase: string
  private readonly loginBase: string
  private readonly fetchImpl: FetchLike

  // 装配（base 为空用生产端点）。
  constructor(tokenBase = '', loginBase = '', fetchImpl: FetchLike = globalThis.fetch) {
    this.tokenBase = tokenBase || TOKEN_BASE
    this.loginBase = loginBase || LOGIN_BASE
    this.fetchImpl = fetchImpl
  }

  // 初始化登录流（provider 固定 "zai"）。
  async startFlow(provider: string): Promise<Flow> {
    const token = randomBytes(32).toString('hex')
    let res: Response
    try {
      res = await this.fetchImpl(`${this.tokenBase}/api/v1/oauth/cli/init`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': BROWSER_UA,
        },
        body: JSON.stringify({ provider }),
      })
    } catch (err) {
      throw new Error(`init 登录流失败: ${(err as Error).message}`)
    }
    let env: Envelope
    try {
      env = await decodeEnvelope(res)
    } catch (err) {
      throw new Error(`init 登录流失败: ${(err as Error).message}`)
    }
    const data = dataOf(env)
    const flowID = typeof data?.flow_id === 'string' ? data.flow_id : ''
    const authURL = typeof data?.authorize_url === 'string' ? data.authorize_url : ''
    if (!data || !flowID || !authURL) {
      throw new Error('init 登录流失败：响应缺 flow_id/authorize_url')
    }
    let state = ''
    try {
      state = new URL(authURL).searchParams.get('state') ?? ''
    } catch {
      // 解析失败 state 留空
    }
    let pollIntervalMs = 2000
    if (typeof data.poll_interval_sec === 'number' && data.poll_interval_sec >= 1) {
      pollIntervalMs = data.poll_interval_sec * 1000
    }
    let expiresAt = new Date(Date.now() + 5 * 60_000)
    if (typeof data.expires_at === 'number' && data.expires_at > 0) {
      expiresAt = new Date(data.expires_at * 1000)
    }
    return { flowID, authorizeURL: authURL, state, pollToken: token, pollIntervalMs, expiresAt }
  }

  // 轮询等待用户同意，批准即返回凭证组；超时/过期/业务失败抛错。
  async pollFlow(flow: Flow, timeoutMs: number): Promise<Session> {
    let deadline = Date.now() + timeoutMs
    if (flow.expiresAt.getTime() < deadline) deadline = flow.expiresAt.getTime()
    for (;;) {
      if (Date.now() > deadline) throw new Error('等待登录超时，请重试')
      const [sess, done] = await this.pollOnce(flow)
      if (done && sess) return sess
      await sleep(flow.pollIntervalMs)
    }
  }

  private async pollOnce(flow: Flow): Promise<[Session | null, boolean]> {
    const res = await this.fetchImpl(`${this.tokenBase}/api/v1/oauth/cli/poll/${flow.flowID}`, {
      headers: { Authorization: `Bearer ${flow.pollToken}`, 'User-Agent': BROWSER_UA },
    })
    const text = await res.text()
    let env: Envelope
    try {
      env = JSON.parse(text) as Envelope
    } catch (err) {
      throw new Error(`轮询失败：响应非 JSON: ${(err as Error).message}`)
    }
    const code = typeof env.code === 'number' ? env.code : 0
    if (code !== 0) {
      const msg = typeof env.msg === 'string' && env.msg ? env.msg : `code=${code}`
      throw new Error(`轮询失败: ${msg}`)
    }
    const data = dataOf(env)
    if (!data) throw new Error('轮询失败：响应无 data')
    const status = typeof data.status === 'string' ? data.status : ''
    if (status === 'failed') throw new Error('OAuth 授权失败')
    if (status !== '' && status !== 'ready' && status !== 'pending') {
      throw new Error(`轮询失败：未知状态 "${status}"`)
    }
    const sess = parseSession(data)
    return sess ? [sess, true] : [null, false] // pending：继续轮询
  }

  // 用 zai access_token 换 business JWT（官方 businessTokenResolver 同款：
  // POST loginUrl {"token"} 取 data.access_token）。
  async resolveBusinessToken(accessToken: string): Promise<string> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.loginBase}/api/auth/z/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': BROWSER_UA,
          'HTTP-Referer': 'https://zcode.z.ai',
          'X-Title': 'Z Code@electron',
        },
        body: JSON.stringify({ token: accessToken }),
      })
    } catch (err) {
      throw new Error(`resolve business JWT 失败: ${(err as Error).message}`)
    }
    const text = await res.text()
    if (res.status < 200 || res.status > 299) {
      throw new Error(`resolve business JWT 失败: http ${res.status}: ${compact(text)}`)
    }
    let out: Envelope
    try {
      out = JSON.parse(text) as Envelope
    } catch (err) {
      throw new Error(`resolve business JWT 失败: 响应非 JSON: ${(err as Error).message}`)
    }
    const data = dataOf(out)
    const jwt = data && typeof data.access_token === 'string' && data.access_token
      ? data.access_token
      : data && typeof data.accessToken === 'string' ? data.accessToken : ''
    if (!jwt) throw new Error('resolve business JWT 失败：响应无 access_token')
    return jwt
  }
}
