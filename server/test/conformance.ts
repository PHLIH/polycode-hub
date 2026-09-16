// 一致性套件：三协议 × 入站/出站，逐语义覆盖全部 fixture。
// 各编解码器测试只调用 inboundSuite / outboundSuite，即自动跑完全部 fixture。
// fixture 单一真相在 server/test/fixtures/（不复制到别处）。

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import type { InboundCodec, OutboundCodec } from '../src/ir/index.ts'
import type { IrError, IrRequest, IrResponse, StreamEvent } from '../src/ir/index.ts'

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))

// wantRequestPath 锁定 baseURL 拼接规则（坑位 #2）：
// anthropic-messages 的 baseURL 不含 /v1（路径以 /v1 开头）；openai 两种含 /v1（相对段）。
const WANT_REQUEST_PATH: Record<string, string> = {
  'anthropic-messages': '/v1/messages',
  'openai-completions': 'chat/completions',
  'openai-responses': 'responses',
}

const WANT_ERROR: IrError = { type: 'rate_limit_error', message: '限流了', httpStatus: 429 }

function read(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(`${FIXTURES}/${rel}`))
}
function readJSON(rel: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES}/${rel}`, 'utf8'))
}

function scenarios(protocol: string, kind: 'request' | 'response' | 'stream'): string[] {
  const ext = kind === 'stream' ? '.sse' : '.json'
  const prefix = `${kind}.`
  return readdirSync(`${FIXTURES}/${protocol}`)
    .filter((n) => n.startsWith(prefix) && n.endsWith(ext))
    .map((n) => n.slice(prefix.length, -ext.length))
    .sort()
}

function assertJSONEqual(got: unknown, wantFile: string): void {
  // 对齐 Go：两边反序列化为 any 后 DeepEqual（键序无关、数字统一）
  const gotAny = JSON.parse(JSON.stringify(got ?? null))
  expect(gotAny, `与期望 ${wantFile} 不相等`).toEqual(readJSON(wantFile))
}

function assertJSONBytesEqual(got: Uint8Array, wantFile: string): void {
  const text = new TextDecoder().decode(got)
  assertJSONEqual(JSON.parse(text), wantFile)
}

interface Frame { event: string; data: string }

// 宽松 SSE 解析：忽略注释/空行/未知行，多 data: 行按 \n 拼接（SSE 规范）。
export function parseSSE(data: Uint8Array | string): Frame[] {
  const frames: Frame[] = []
  let cur: Frame | null = null
  const flush = () => {
    if (cur && (cur.event !== '' || cur.data !== '')) frames.push(cur)
    cur = null
  }
  const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '') flush()
    else if (line.startsWith(':')) { /* 注释 */ } else if (line.startsWith('event:')) {
      cur ??= { event: '', data: '' }
      cur.event = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      cur ??= { event: '', data: '' }
      const d = line.slice('data:'.length).replace(/^ /, '') // 去掉一个前导空格
      cur.data = cur.data === '' ? d : `${cur.data}\n${d}`
    }
  }
  flush()
  return frames
}

function assertSSEEqual(got: Uint8Array, wantFile: string): void {
  const gf = parseSSE(got)
  const wf = parseSSE(read(wantFile))
  expect(gf.length, `帧数不一致 got=${JSON.stringify(gf)} want=${JSON.stringify(wf)}`).toBe(wf.length)
  for (let i = 0; i < gf.length; i++) {
    expect(gf[i]!.event, `帧 ${i} event 名不一致`).toBe(wf[i]!.event)
    const gd = gf[i]!.data.trim()
    const wd = wf[i]!.data.trim()
    if (gd === '[DONE]' || wd === '[DONE]') {
      expect(gd, `帧 ${i} [DONE] 不一致`).toBe(wd)
      continue
    }
    expect(JSON.parse(gd), `帧 ${i} data 与 ${wantFile} 不一致`).toEqual(JSON.parse(wd))
  }
}

// 「客户端协议 ↔ IR」全部一致性用例（对齐 Go InboundSuite）。
export function inboundSuite(c: InboundCodec): void {
  const p = c.protocol

  for (const s of scenarios(p, 'request')) {
    test(`ParseRequest/${s}`, () => {
      const got = c.parseRequest(read(`${p}/request.${s}.json`))
      assertJSONEqual(got, `${p}/expected/request.${s}.ir.json`)
    })
  }
  for (const s of scenarios(p, 'response')) {
    test(`SerializeResponse/${s}`, () => {
      const irResp = readJSON(`${p}/expected/response.${s}.ir.json`) as unknown as IrResponse
      assertJSONBytesEqual(c.serializeResponse(irResp), `${p}/response.${s}.json`)
    })
  }
  for (const s of scenarios(p, 'stream')) {
    test(`SerializeEvent/${s}`, () => {
      const events = readJSON(`${p}/expected/stream.${s}.events.json`) as StreamEvent[]
      const chunks: Uint8Array[] = []
      for (const ev of events) chunks.push(c.serializeEvent(ev))
      const total = chunks.reduce((n, b) => n + b.length, 0)
      const buf = new Uint8Array(total)
      let off = 0
      for (const b of chunks) { buf.set(b, off); off += b.length }
      assertSSEEqual(buf, `${p}/stream.${s}.sse`)
    })
  }
  test('SerializeError', () => {
    assertJSONBytesEqual(c.serializeError(WANT_ERROR), `${p}/error.json`)
  })
}

function feedAll(c: OutboundCodec, sse: Uint8Array): StreamEvent[] {
  const sp = c.newStreamParser()
  return [...sp.feed(sse), ...sp.finish()]
}

function feedChunks(c: OutboundCodec, sse: Uint8Array, n: number): StreamEvent[] {
  const sp = c.newStreamParser()
  const got: StreamEvent[] = []
  for (let i = 0; i < sse.length; i += n) {
    got.push(...sp.feed(sse.subarray(i, Math.min(i + n, sse.length))))
  }
  got.push(...sp.finish())
  return got
}

// 「IR ↔ 上游协议」全部一致性用例（对齐 Go OutboundSuite）。
export function outboundSuite(c: OutboundCodec): void {
  const p = c.protocol

  test('RequestPath', () => {
    expect(c.requestPath()).toBe(WANT_REQUEST_PATH[p])
  })

  for (const s of scenarios(p, 'request')) {
    test(`SerializeRequest/${s}`, () => {
      const irReq = readJSON(`${p}/expected/request.${s}.ir.json`) as unknown as IrRequest
      assertJSONBytesEqual(c.serializeRequest(irReq), `${p}/expected/upstream-request.${s}.json`)
    })
  }
  for (const s of scenarios(p, 'response')) {
    test(`ParseResponse/${s}`, () => {
      assertJSONEqual(c.parseResponse(read(`${p}/response.${s}.json`)), `${p}/expected/response.${s}.ir.json`)
    })
  }
  for (const s of scenarios(p, 'stream')) {
    const wantFile = `${p}/expected/stream.${s}.events.json`
    const sse = read(`${p}/stream.${s}.sse`)
    test(`StreamParser/${s} 整块喂入`, () => {
      assertJSONEqual(feedAll(c, sse), wantFile)
    })
    test(`StreamParser/${s} 7字节分块喂入`, () => {
      assertJSONEqual(feedChunks(c, sse, 7), wantFile)
    })
  }
}
