// 探针必须带上模型的推理强度预设实测：管理台「测试」按钮测的就是真实转发会发的东西。
// 预设配错（上游枚举外）要在测试里直接现形，而不是测试通过、业务请求再挂。

import { afterEach, describe, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { Probe } from '../src/gateway/probe.ts'
import { Scheduler } from '../src/router/scheduler.ts'
import { Upstream } from '../src/router/upstream.ts'
import type { Provider } from '../src/model/index.ts'
import '../src/codec/anthropicmessages.ts'
import '../src/codec/openaicompletions.ts'
import '../src/codec/openairesponses.ts'

let server: Server | null = null
afterEach(() => {
  if (server) { server.close(); server = null }
})

let lastBody = ''

// openai-completions 通道：按请求体的 reasoning_effort 决定回什么。
// 无预设/合法档 → 正常 SSE；minimal（假设上游不认）→ 400 点名参数。
async function reasoningServer(): Promise<string> {
  lastBody = ''
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString() })
    req.on('end', () => {
      if (!req.url?.includes('/chat/completions')) {
        res.writeHead(404); res.end('not here'); return
      }
      lastBody = raw
      let effort = ''
      try { effort = (JSON.parse(raw) as { reasoning_effort?: unknown }).reasoning_effort as string ?? '' } catch { /* 保持空 */ }
      if (effort === 'minimal') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(`{"error":{"message":"reasoning_effort 'minimal' is not supported for this model"}}`)
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')
    })
  })
  return new Promise<string>((r) => {
    server!.listen(0, '127.0.0.1', () =>
      r(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`))
  })
}

const mkProv = (baseUrl: string, over: Partial<Provider> = {}): Provider => ({
  providerId: 1, name: 'p', displayName: 'd', accessKind: 'official', risk: 'low',
  riskNote: '', stability: 'stable', api: 'openai-completions', baseUrl,
  credential: {}, headers: {}, state: 'active', priority: 1, streamOnly: false,
  models: [{ id: 'm1', input: ['text'], manual: false, enabled: true }],
  ...over,
})

const probeOf = (p: Provider): Probe =>
  new Probe(new Scheduler([p], 'high'), new Upstream({ credLookup: () => ['', false] }), null)

describe('探针带上模型推理强度预设', () => {
  test('有预设：探测请求体里带 reasoning_effort', async () => {
    const base = await reasoningServer()
    const p = mkProv(base, { models: [{ id: 'm1', input: ['text'], manual: false, enabled: true, reasoningEffort: 'high' }] })
    const r = await probeOf(p).probeWithProtocols(p, 'm1')
    expect(r.ok).toBe(true)
    expect(JSON.parse(lastBody).reasoning_effort).toBe('high')
  })

  test('无预设：探测请求体里不带 reasoning_effort（跟随语义）', async () => {
    const base = await reasoningServer()
    const p = mkProv(base)
    const r = await probeOf(p).probeWithProtocols(p, 'm1')
    expect(r.ok).toBe(true)
    expect(JSON.parse(lastBody)).not.toHaveProperty('reasoning_effort')
  })

  test('预设配错：探测直接失败，上游点名参数的原文透出', async () => {
    const base = await reasoningServer()
    const p = mkProv(base, { models: [{ id: 'm1', input: ['text'], manual: false, enabled: true, reasoningEffort: 'minimal' }] })
    const r = await probeOf(p).probeWithProtocols(p, 'm1')
    expect(r.ok).toBe(false)
    expect(r.error).toContain("reasoning_effort 'minimal' is not supported")
  })
})
