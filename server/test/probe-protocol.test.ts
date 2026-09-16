// 探测协议回退的真实缺陷回归（zen muse-spark-1.3 场景）。
//
// 背景：muse-spark 系只认 /responses。Probe.probeWithProtocols 按候选协议逐个试，
// 但 probeFatalError 把 http 404 当「硬错误」直接早停（原意：省掉无意义的换协议）。
// 后果：探测顺序里 openai-completions 排第一，它在上游回 500/404 时就地终止，
// 唯一能用的 openai-responses 永远轮不到 → UI 显示「上游错误: upstream bad_request (http 404)」。
//
// 修复：404 是「本端点没有此路径/模型」——恰恰最该换协议试的情况。
// 只有 401（凭据）才是换协议无意义的硬错误。

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

// 起一个「只有 /responses 能用」的上游，模拟 zen：其余路径回 404。
async function onlyResponsesServer(): Promise<string> {
  server = createServer((req, res) => {
    if (req.url?.includes('/responses')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n')
      res.write('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n')
      res.end()
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/html' })
    res.end('<!DOCTYPE html><html><body>Not Found</body></html>')
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

const mkProv = (baseUrl: string, over: Partial<Provider> = {}): Provider => ({
  providerId: 1, name: 'zen', displayName: 'zen', accessKind: 'reverse', risk: 'high',
  riskNote: 'x', stability: 'beta', api: 'openai-completions', baseUrl,
  credential: {}, headers: {}, state: 'active', priority: 1,
  models: [{ id: 'muse-spark-1.3-contributor-free', manual: false, enabled: true }],
  ...over,
})

describe('探测协议回退：404 必须换协议继续试', () => {
  test('首个协议 404 时，回退到 openai-responses 并成功', async () => {
    const base = await onlyResponsesServer()
    const p = mkProv(base)
    const probe = new Probe(new Scheduler([p], 'high'), new Upstream({ credLookup: () => ['', false] }), null)
    const r = await probe.probeWithProtocols(p, 'muse-spark-1.3-contributor-free')
    expect(r.ok).toBe(true)
    expect(r.protocol).toBe('openai-responses')
  })

  test('Provider 测试入口不再返回上游 HTML 404', async () => {
    const base = await onlyResponsesServer()
    const p = mkProv(base)
    const probe = new Probe(new Scheduler([p], 'high'), new Upstream({ credLookup: () => ['', false] }), null)
    const r = await probe.probeProvider(1)
    expect(r.ok).toBe(true)
    expect(r.error ?? '').not.toContain('http 404')
    expect(r.error ?? '').not.toContain('<!DOCTYPE')
  })

  test('401 凭据错误仍早停（换协议无意义，不该白试三轮）', async () => {
    let count = 0
    server = createServer((req, res) => {
      count++
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end('{"type":"error","error":{"type":"AuthError","message":"Missing API key."}}')
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
    const p = mkProv(base)
    const probe = new Probe(new Scheduler([p], 'high'), new Upstream({ credLookup: () => ['', false] }), null)
    const r = await probe.probeWithProtocols(p, 'muse-spark-1.3-contributor-free')
    expect(r.ok).toBe(false)
    expect(count).toBe(1) // 只打了一次：401 立即早停
  })
})
