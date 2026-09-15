// 复现 issue #1：Discover「采用」WorkBuddy 后测试报 APISIX 401。
//
// 现象：落库 Provider 只挂 credential.apiKeyEnv = 'WB_TOKEN'，进程里 WB_TOKEN 未设置
// 且账号池为空；测试请求不带 Authorization 仍打到上游，被腾讯 Copilot 前的
// APISIX/openresty 拦成 HTML 401，UI 把这段 HTML 当成「上游鉴权失败」。
//
// 期望：凭据解析失败时，在发上游之前就失败，并告诉用户「WB_TOKEN 未设置 / 无账号凭据」。

import { describe, expect, test } from 'vitest'
import { Probe } from '../src/gateway/probe.ts'
import { Scheduler } from '../src/router/scheduler.ts'
import { Upstream } from '../src/router/upstream.ts'
import type { Provider } from '../src/model/index.ts'
import { startOneShot } from './helpers/one-shot-server.ts'
import '../src/codec/anthropicmessages.ts'
import '../src/codec/openaicompletions.ts'
import '../src/codec/openairesponses.ts'

// 模仿腾讯 Copilot 前的 APISIX：没带 Authorization 一律回 HTML 401。
async function apisixLikeServer(): Promise<{ base: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = []
  const { server, base } = await startOneShot((req, res) => {
    hits.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? '-'}`)
    if (!req.headers.authorization) {
      res.writeHead(401, { 'Content-Type': 'text/html' })
      res.end('<html>\n<head><title>401 Authorization Required</title></head>\n<body>\n'
        + '<center><h1>401 Authorization Required</h1></center>\n<hr><center>openresty</center>\n'
        + '<p><em>Powered by <a href="https://apisix.apache.org/">APISIX</a></em></p>\n</body>\n</html>\n')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('data: [DONE]\n\n')
  })
  return { base, hits, close: () => new Promise<void>((r) => server.close(() => r())) }
}

const wbProvider = (baseUrl: string): Provider => ({
  id: 'wb-auto', sourceId: 'workbuddy', displayName: 'WorkBuddy（自动发现）',
  accessKind: 'session-reuse', risk: 'medium', riskNote: '复用本机桌面登录态',
  stability: 'beta', api: 'openai-completions', baseUrl,
  credential: { apiKeyEnv: 'WB_TOKEN' }, // 采纳草稿原样：只有环境变量引用，没有 token
  headers: { 'X-Product': 'SaaS' },
  enabled: true, priority: 1,
  models: [{ id: 'hy3-preview', providerId: 'wb-auto', manual: false, enabled: true }],
})

describe('issue #1 复现：空 WB_TOKEN 不该打到上游', () => {
  test('凭据未配置 → 发上游前失败，且报告 WB_TOKEN 未设置（不打上游）', async () => {
    const { base, hits, close } = await apisixLikeServer()
    try {
      const p = wbProvider(base)
      // 模拟真实环境：WB_TOKEN 未设置
      const probe = new Probe(
        new Scheduler([p], 'high'),
        new Upstream({ credLookup: (n) => (n === 'WB_TOKEN' ? ['', false] : ['', false]) }),
        null,
      )
      const r = await probe.probeProvider('wb-auto')
      expect(r.ok).toBe(false)
      // 关键：不该把 APISIX 的 HTML 401 当「上游鉴权失败」上报
      expect(r.error).not.toContain('openresty')
      expect(r.error).not.toContain('<html>')
      // 也不该真的发出去
      expect(hits).toHaveLength(0)
      // 应该明确说是凭据没配置
      expect(r.error).toContain('WB_TOKEN')
    } finally {
      await close()
    }
  })
})

// 同一缺陷的转发侧：真实 /v1/messages 请求也不能把空凭据打到上游。
describe('issue #1 转发侧：空凭据不打上游', () => {
  test('转发时凭据缺失 → 401 且上游零请求', async () => {
    const { base, hits, close } = await apisixLikeServer()
    try {
      const { Proxy } = await import('../src/gateway/proxy.ts')
      const { Hono } = await import('hono')
      const cfg = {
        gateway: { gatewayKey: '', riskMax: 'high', precheckContext: false,
          firstByteTimeoutMs: 5000, streamIdleTimeoutMs: 5000 },
      } as never
      const sched = new Scheduler([wbProvider(base)], 'high')
      const up = new Upstream({ credLookup: () => ['', false], noAutoProtocol: true })
      const proxy = new Proxy(cfg, sched, up, null)
      const app = new Hono()
      proxy.registerRoutes(app)

      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'hy3-preview', max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }] }),
      })
      expect(res.status).toBe(401)
      const body = await res.text()
      expect(body).not.toContain('openresty')
      expect(body).toContain('WB_TOKEN')
      expect(hits).toHaveLength(0)
    } finally {
      await close()
    }
  })
})
