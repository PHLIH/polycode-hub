// 来源体检两道中间件：Content-Type（防 CSRF）与 Host（防 DNS rebinding）。
//
// 装配口径对齐 server/src/cli.ts 的真实路径：
//   · Content-Type 检查长在 createAdminApi 内（只挂 admin 面）；
//   · hostGuard 挂根应用（/v1 转发面与 /admin 管理面都覆盖），这里同样挂根应用。
//
// 铁律：本机正常使用者（浏览器同源管理台 + curl）必须完全无感——
// 两道检查只打「恶意网页能造出来、本机正常流量不会出现」的请求。

import { describe, expect, test } from 'vitest'
import { Hono } from 'hono'
import { createAdminApi } from '../src/adminapi/index.ts'
import { MemoryAccountStore, MemoryProviderStore } from '../src/adminapi/store.ts'
import { hostGuard, hostOnly, isLoopbackHost } from '../src/source_guard.ts'

// 与 adminapi.test.ts 同款的合法 Provider 请求体（providerValidate 要过）。
const providerBody = {
  name: 'p1', displayName: 'P1', accessKind: 'official', risk: 'low',
  stability: 'stable', api: 'anthropic-messages', baseUrl: 'https://gw.example.com',
  credential: { apiKeyEnv: 'K' }, state: 'active', priority: 1,
}

// 只有 admin 面的裸 app（测 Content-Type 检查用）。
function admin(adminKey = ''): Hono {
  return createAdminApi({
    adminKey,
    providers: new MemoryProviderStore(),
    accounts: new MemoryAccountStore(),
  })
}

// 根应用（对齐 cli.ts：hostGuard → 转发面 → 管理面）。
function root(opts: { adminKey?: string; gatewayKey?: string } = {}): Hono {
  const keys = { adminKey: opts.adminKey ?? '', gatewayKey: opts.gatewayKey ?? '' }
  const app = new Hono()
  app.use('*', hostGuard(keys))
  // 转发面替身：真实实现是 px.registerRoutes 的 /v1/*，这里只要一个可命中的端点。
  app.post('/v1/chat/completions', (c) => c.json({ ok: true }))
  app.get('/admin/api/providers', (c) => c.json({ providers: [] }))
  app.route('/', createAdminApi({
    adminKey: keys.adminKey,
    providers: new MemoryProviderStore(),
    accounts: new MemoryAccountStore(),
  }))
  return app
}

describe('来源体检 · Content-Type（防 CSRF，只挂 admin 面）', () => {
  test('text/plain POST JSON → 415 + invalid_request_error（恶意网页的 simple request）', async () => {
    const res = await admin().request('/admin/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(providerBody),
    })
    expect(res.status).toBe(415)
    const b = await res.json() as { error: { type: string; message: string } }
    expect(b.error.type).toBe('invalid_request_error')
    expect(b.error.message).toContain('application/json')
  })

  test('表单/FormData 形状（urlencoded）同样 415', async () => {
    const res = await admin().request('/admin/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=p1',
    })
    expect(res.status).toBe(415)
  })

  test('没带 Content-Type 的 POST → 放行（保 curl 无头习惯）', async () => {
    // 用字节体：fetch 对字符串体会自动补 text/plain，只有字节体才真的「没带 CT」。
    const res = await admin().request('/admin/api/providers', {
      method: 'POST',
      body: new TextEncoder().encode(JSON.stringify(providerBody)),
    })
    expect(res.status).toBe(201)
  })

  test('application/json（含 ;charset 参数）→ 放行', async () => {
    const res = await admin().request('/admin/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(providerBody),
    })
    expect(res.status).toBe(201)
  })

  test('GET 不查 Content-Type（无 body 可藏）', async () => {
    const res = await admin().request('/admin/api/providers', {
      headers: { 'Content-Type': 'text/plain' },
    })
    expect(res.status).toBe(200)
  })

  test('鉴权在前：key 错 → 401（不先暴露 Content-Type 校验口径）', async () => {
    const res = await admin('secret').request('/admin/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(providerBody),
    })
    expect(res.status).toBe(401)
  })
})

describe('来源体检 · Host（防 DNS rebinding，全局 /v1 + /admin）', () => {
  test('裸跑 + Host: evil.com + 管理面 → 403，errRes 形态', async () => {
    const res = await root().request('http://localhost/admin/api/providers', {
      headers: { Host: 'evil.com' },
    })
    expect(res.status).toBe(403)
    const b = await res.json() as { error: { type: string; message: string } }
    expect(b.error.type).toBe('permission_error')
    expect(b.error.message).toContain('evil.com')
  })

  test('裸跑 + Host: evil.com + 转发面 → 403，{error: string} 形态', async () => {
    const res = await root().request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { Host: 'evil.com' },
      body: new TextEncoder().encode('{}'),
    })
    expect(res.status).toBe(403)
    const b = await res.json() as { error: unknown }
    expect(typeof b.error).toBe('string')
  })

  test('裸跑 + Host: 127.0.0.1 → 放行', async () => {
    const res = await root().request('http://localhost/admin/api/providers', {
      headers: { Host: '127.0.0.1' },
    })
    expect(res.status).toBe(200)
  })

  test('裸跑 + Host 带端口 / IPv6 方括号 / localhost → 放行', async () => {
    const app = root()
    for (const host of ['127.0.0.1:3000', 'localhost:3000', '[::1]:3000']) {
      const res = await app.request('http://localhost/admin/api/providers', { headers: { Host: host } })
      expect(res.status, `Host: ${host}`).toBe(200)
    }
  })

  test('裸跑 + Host 缺失 → 放行（老客户端）', async () => {
    // Request 构造不带 Host 头 = 头缺失。
    const res = await root().request('http://localhost/admin/api/providers')
    expect(res.status).toBe(200)
  })

  test('配了 admin_key：Host: evil.com 不被 Host 检查拦（key 模式不启用）', async () => {
    const res = await root({ adminKey: 'secret' }).request('http://localhost/admin/api/providers', {
      headers: { Host: 'evil.com', 'X-Admin-Key': 'secret' },
    })
    expect(res.status).toBe(200)
  })

  test('只配了 gateway_key（admin_key 仍空）：同样不启用 Host 检查', async () => {
    const res = await root({ gatewayKey: 'gw' }).request('http://localhost/admin/api/providers', {
      headers: { Host: 'evil.com' },
    })
    expect(res.status).toBe(200)
  })

  test('hostOnly / isLoopbackHost：剥端口与方括号后的回环判据', () => {
    expect(hostOnly('[::1]:3000')).toBe('::1')
    expect(hostOnly('LOCALHOST:3000')).toBe('localhost')
    expect(hostOnly('evil.com:8080')).toBe('evil.com')
    expect(hostOnly('::1')).toBe('::1')
    expect(isLoopbackHost('127.8.9.1:4123')).toBe(true)
    expect(isLoopbackHost('[::1]:4123')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('192.168.1.7')).toBe(false)
    expect(isLoopbackHost('evil.com')).toBe(false)
  })
})
