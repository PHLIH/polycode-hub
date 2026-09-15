// zcodeauth 行为锚点（复刻 Go internal/zcodeauth/flow_test.go，HTTP 层用注入的 fetch 替身打桩）。

import { describe, expect, test } from 'vitest'
import { Client, TOKEN_BASE, LOGIN_BASE, type Flow } from '../src/zcodeauth/index.ts'

type FetchLike = typeof fetch

// 按 pathname 路由的 fetch 替身；handler 返回 Response，缺路由即 404。
function fakeFetch(routes: Record<string, (url: URL, init?: RequestInit) => Promise<Response> | Response>): FetchLike {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const handler = routes[url.pathname]
    if (!handler) return new Response('not found', { status: 404 })
    return await handler(url, init)
  }) as FetchLike
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function flowOf(overrides: Partial<Flow> = {}): Flow {
  return {
    flowID: 'f1', authorizeURL: 'https://chat.z.ai/api/oauth/authorize?state=s1',
    state: 's1', pollToken: 'POLLTOK', pollIntervalMs: 5,
    expiresAt: new Date(Date.now() + 3600_000), ...overrides,
  }
}

describe('StartFlow', () => {
  test('init 建流：flow_id / authorize_url / state / 间隔与有效期', async () => {
    let seenAuth = ''
    let seenProvider = ''
    const c = new Client('https://token.test', 'https://login.test', fakeFetch({
      '/api/v1/oauth/cli/init': async (_url, init) => {
        seenAuth = (init?.headers as Record<string, string>).Authorization ?? ''
        seenProvider = (JSON.parse(String(init?.body)) as Record<string, string>).provider ?? ''
        return json({ code: 0, data: { flow_id: 'f1', authorize_url: 'https://chat.z.ai/api/oauth/authorize?state=s1', expires_at: 1899999999, poll_interval_sec: 1 } })
      },
    }))
    const flow = await c.startFlow('zai')
    expect(flow.flowID).toBe('f1')
    expect(flow.state).toBe('s1')
    expect(flow.authorizeURL).toContain('authorize')
    expect(flow.pollIntervalMs).toBe(1000)
    expect(flow.expiresAt.getTime()).toBe(1899999999 * 1000)
    expect(seenProvider).toBe('zai')
    // 64 位 hex poll token 作 Bearer
    expect(seenAuth).toMatch(/^Bearer [0-9a-f]{64}$/)
  })

  test('缺 flow_id/authorize_url 报错；业务 code 非 0 报错', async () => {
    const c = new Client('https://token.test', '', fakeFetch({
      '/api/v1/oauth/cli/init': () => json({ code: 0, data: { authorize_url: 'https://x' } }),
    }))
    await expect(c.startFlow('zai')).rejects.toThrow('flow_id/authorize_url')

    const c2 = new Client('https://token.test', '', fakeFetch({
      '/api/v1/oauth/cli/init': () => json({ code: 4001, msg: 'rate limited' }),
    }))
    await expect(c2.startFlow('zai')).rejects.toThrow('rate limited')
  })

  test('HTTP 非 2xx 报错', async () => {
    const c = new Client('https://token.test', '', fakeFetch({
      '/api/v1/oauth/cli/init': () => json({ msg: 'nope' }, 401),
    }))
    await expect(c.startFlow('zai')).rejects.toThrow('http 401')
  })

  test('生产端点常量与默认装配', async () => {
    expect(TOKEN_BASE).toBe('https://zcode.z.ai')
    expect(LOGIN_BASE).toBe('https://api.z.ai')
    let seenURL = ''
    const c = new Client('', '', (async (input: string | URL | Request) => {
      seenURL = String(input)
      return json({ code: 0, data: {} })
    }) as FetchLike)
    await expect(c.startFlow('zai')).rejects.toThrow('flow_id/authorize_url')
    expect(seenURL).toBe('https://zcode.z.ai/api/v1/oauth/cli/init')
  })
})

describe('PollFlow', () => {
  test('成功轮询：两次 pending 后拿到凭证组', async () => {
    let polls = 0
    let seenAuth = ''
    const c = new Client('https://token.test', '', fakeFetch({
      '/api/v1/oauth/cli/poll/f1': async (_url, init) => {
        polls++
        seenAuth = (init?.headers as Record<string, string>).Authorization ?? ''
        if (polls < 3) return json({ code: 0, data: { status: 'pending' } })
        return json({ code: 0, data: { status: 'ready', token: 'TOK9', user: { user_id: 'u9' }, zai: { access_token: 'AT9' } } })
      },
    }))
    const sess = await c.pollFlow(flowOf(), 10_000)
    expect(seenAuth).toBe('Bearer POLLTOK')
    expect(sess.token).toBe('TOK9')
    expect(sess.accessToken).toBe('AT9')
    expect(sess.userID).toBe('u9')
    expect(polls).toBe(3)
  })

  test('回调形态：data.code → Session.code', async () => {
    const c = new Client('https://token.test', '', fakeFetch({
      '/api/v1/oauth/cli/poll/f1': () => json({ code: 0, data: { status: 'ready', code: 'CB1' } }),
    }))
    const sess = await c.pollFlow(flowOf(), 10_000)
    expect(sess.code).toBe('CB1')
  })

  test('超时报错且不等待过久', async () => {
    const c = new Client('https://token.test', '', fakeFetch({
      '/api/v1/oauth/cli/poll/f1': () => json({ code: 0, data: { status: 'pending' } }),
    }))
    const start = Date.now()
    await expect(c.pollFlow(flowOf(), 100)).rejects.toThrow('等待登录超时')
    expect(Date.now() - start).toBeLessThan(5000)
  })

  test('expiresAt 早于 timeout 时按 expiresAt 截止', async () => {
    const c = new Client('https://token.test', '', fakeFetch({
      '/api/v1/oauth/cli/poll/f1': () => json({ code: 0, data: { status: 'pending' } }),
    }))
    const start = Date.now()
    await expect(c.pollFlow(flowOf({ expiresAt: new Date(Date.now() - 1000) }), 60_000))
      .rejects.toThrow('等待登录超时')
    expect(Date.now() - start).toBeLessThan(5000)
  })

  test('业务失败（code 非 0）直接透出 msg', async () => {
    const c = new Client('https://token.test', '', fakeFetch({
      '/api/v1/oauth/cli/poll/f1': () => json({ code: 4001, msg: 'flow expired' }),
    }))
    await expect(c.pollFlow(flowOf(), 10_000)).rejects.toThrow('flow expired')
  })

  test('status=failed → OAuth 授权失败；未知状态报错；无 data 报错', async () => {
    const failed = new Client('https://token.test', '', fakeFetch({
      '/api/v1/oauth/cli/poll/f1': () => json({ code: 0, data: { status: 'failed' } }),
    }))
    await expect(failed.pollFlow(flowOf(), 10_000)).rejects.toThrow('OAuth 授权失败')

    const unknown = new Client('https://token.test', '', fakeFetch({
      '/api/v1/oauth/cli/poll/f1': () => json({ code: 0, data: { status: 'wat' } }),
    }))
    await expect(unknown.pollFlow(flowOf(), 10_000)).rejects.toThrow('未知状态')

    const noData = new Client('https://token.test', '', fakeFetch({
      '/api/v1/oauth/cli/poll/f1': () => json({ code: 0 }),
    }))
    await expect(noData.pollFlow(flowOf(), 10_000)).rejects.toThrow('响应无 data')
  })

  test('响应非 JSON 报错', async () => {
    const c = new Client('https://token.test', '', fakeFetch({
      '/api/v1/oauth/cli/poll/f1': () => new Response('<html>', { status: 200 }),
    }))
    await expect(c.pollFlow(flowOf(), 10_000)).rejects.toThrow('响应非 JSON')
  })
})

describe('ResolveBusinessToken', () => {
  test('用 zai access_token 换 business JWT', async () => {
    let seenBody = ''
    const c = new Client('https://token.test', 'https://login.test', fakeFetch({
      '/api/auth/z/login': async (_url, init) => {
        seenBody = String(init?.body)
        return json({ code: 0, data: { access_token: 'BUSINESS-JWT', expires_in: 3600 } })
      },
    }))
    const jwt = await c.resolveBusinessToken('AT9')
    expect(jwt).toBe('BUSINESS-JWT')
    expect(seenBody).toBe(JSON.stringify({ token: 'AT9' }))
  })

  test('data.accessToken 命名也认', async () => {
    const c = new Client('https://token.test', 'https://login.test', fakeFetch({
      '/api/auth/z/login': () => json({ code: 0, data: { accessToken: 'ALT-JWT' } }),
    }))
    await expect(c.resolveBusinessToken('AT9')).resolves.toBe('ALT-JWT')
  })

  test('响应缺 access_token 报错', async () => {
    const c = new Client('https://token.test', 'https://login.test', fakeFetch({
      '/api/auth/z/login': () => json({ code: 0, data: { expires_in: 3600 } }),
    }))
    await expect(c.resolveBusinessToken('AT9')).rejects.toThrow('响应无 access_token')
  })

  test('坏 token（HTTP 401）报错', async () => {
    const c = new Client('https://token.test', 'https://login.test', fakeFetch({
      '/api/auth/z/login': () => json({ msg: 'bad token' }, 401),
    }))
    await expect(c.resolveBusinessToken('BAD')).rejects.toThrow('http 401')
  })
})
