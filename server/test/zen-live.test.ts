import { describe, expect, test } from 'vitest'
import { Proxy } from '../src/gateway/proxy.ts'
import { Scheduler } from '../src/router/scheduler.ts'
import { Upstream } from '../src/router/upstream.ts'
import { Hono } from 'hono'
import '../src/codec/openaicompletions.ts'

// 真正要回答的问题：**一个没装过 opencode 的用户**（Provider 上没有任何指纹静态头）
// 能不能直接调通 zen 免费档？现铸会话那条链的端到端证据。
// 默认 skip：它打真上游（有网络依赖），需要时 ZEN_LIVE=1 npx vitest run 显式开启。
describe.skipIf(process.env.ZEN_LIVE !== '1')('zen 免静态指纹：端到端实打上游', () => {
  test('无任何指纹头 → 现铸会话 → 真实出字', async () => {
    process.env.ZEN_KEY = 'public'
    const provider = {
      providerId: 1, name: 'opencode', state: 'active' as const,
      displayName: 'Zen', accessKind: 'reverse' as const, risk: 'high' as const,
      riskNote: 't', stability: 'beta' as const, api: 'openai-completions' as const,
      baseUrl: 'https://opencode.ai/inference/v1',
      credential: { apiKeyEnv: 'ZEN_KEY' },
      headers: {}, // ★ 无任何指纹（模拟没装客户端的用户）
      priority: 1,
      models: [{ id: 'mimo-v2.6-flash-free', manual: false, enabled: true, api: 'openai-completions' as const }],
    }
    const cfg = {
      gateway: { host: '127.0.0.1', port: 0, adminKey: '', gatewayKey: '', defaultModel: '',
        riskMax: 'high', precheckContext: false, firstByteTimeoutMs: 90000, streamIdleTimeoutMs: 90000 },
      dataDir: 'data', egresses: [], providers: [], accounts: [],
    } as never
    const px = new Proxy(cfg, new Scheduler([provider], 'high'), new Upstream({}), null)
    const app = new Hono()
    px.registerRoutes(app)
    const res = await app.request('/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'opencode/mimo-v2.6-flash-free', stream: true,
        messages: [{ role: 'user', content: 'say hi in one word' }] }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text.length).toBeGreaterThan(0)
  }, 60000)
})
