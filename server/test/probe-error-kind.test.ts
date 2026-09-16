// 探测失败原因必须报「真病因」，不能被最后一个协议的噪音盖掉。
//
// 真实缺陷（wb-2，2026-09-14）：账号额度已用尽，上游在正确的
// openai-completions 通道回 429 + code 14018「额度已用尽」。
// 但探测会依次试 3 个协议，openai-responses / anthropic-messages 走的是
// 上游根本没有的路径 → 回 404 HTML。最后一次的 404 覆盖了第一次的 429，
// UI 显示「upstream bad_request (http 404): 404 Route Not Found」，
// 完全看不出是额度用尽；连冷却时长都按 bad_request 算成 30s（本该按限流）。
//
// 修法：全失败时按「病因优先级」挑最有信息量的那次上报——
// 凭据/额度/限流是账号的真实状态，路径类 404 只是"这个协议不对"的噪音。

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

// 只有 chat/completions 有真实语义（429 额度用尽）；其余路径回 404。
async function quotaServer(): Promise<string> {
  server = createServer((req, res) => {
    if (req.url?.includes('/chat/completions')) {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end('{"error":{"data":{"code":14018,"msg":"额度已用尽"}}}')
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/html' })
    res.end('<!DOCTYPE html><html><body>Not Found</body></html>')
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

describe('探测失败：上报真病因而非最后的路径噪音', () => {
  test('429 额度用尽不被后续协议的 404 覆盖', async () => {
    const base = await quotaServer()
    const probe = new Probe(new Scheduler([mkProv(base)], 'high'), new Upstream({ credLookup: () => ['', false] }), null)
    const r = await probe.probeWithProtocols(mkProv(base), 'm1')
    expect(r.ok).toBe(false)
    // 关键：报的是额度错误，不是 404
    expect(r.error).toContain('http 429')
    expect(r.error).not.toContain('http 404')
    expect(r.error).not.toContain('Not Found')
    // kind 也得是真病因：额度用尽 → quota（进 exhausted，不再自动复活），
    // 而不是被 404 带成 bad_request 的 30s 短冷却。
    expect(r.kind).toBe('quota')
  })

  test('Provider 测试入口同样报真病因', async () => {
    const base = await quotaServer()
    const probe = new Probe(new Scheduler([mkProv(base)], 'high'), new Upstream({ credLookup: () => ['', false] }), null)
    const r = await probe.probeProvider(1)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('http 429')
    expect(r.error).not.toContain('404 Route Not Found')
  })
})
