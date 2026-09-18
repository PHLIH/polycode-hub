// 探针只发最小真实请求（不带推理档位）：测的是连通性，不是档位枚举。

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

async function simpleServer(): Promise<string> {
  lastBody = ''
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString() })
    req.on('end', () => {
      if (!req.url?.includes('/chat/completions')) {
        res.writeHead(404); res.end('not here'); return
      }
      lastBody = raw
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

describe('探针只发最小请求（不带推理档位）', () => {
  test('探测请求体里不带 reasoning_effort', async () => {
    const base = await simpleServer()
    const r = await probeOf(mkProv(base)).probeWithProtocols(mkProv(base), 'm1')
    expect(r.ok).toBe(true)
    expect(JSON.parse(lastBody)).not.toHaveProperty('reasoning_effort')
  })
})
