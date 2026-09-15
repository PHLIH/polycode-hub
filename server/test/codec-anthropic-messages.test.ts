// anthropic-messages 编解码器测试：
// 1) inboundSuite / outboundSuite —— 复用仓库根 tests/fixtures/anthropic-messages 的全部一致性用例；
// 2) 移植 Go internal/codec/anthropicmessages/{inbound,outbound}_test.go 中 fixture 之外的补充单测。
import { describe, expect, test } from 'vitest'
import { getInbound, getOutbound } from '../src/ir/index.ts'
import { ERR, irError } from '../src/ir/index.ts'
import type { StreamEvent, Usage } from '../src/ir/index.ts'
import { newInbound, newOutbound } from '../src/codec/anthropicmessages.ts'
import { inboundSuite, outboundSuite } from './conformance.ts'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const dec = (b: Uint8Array): string => new TextDecoder().decode(b)

// ---- W2 统一夹具一致性（契约底线）----
inboundSuite(newInbound())
outboundSuite(newOutbound())

// ---- 注册表（对齐 Go init() 注册）----
describe('注册表', () => {
  test('anthropic-messages 已注册 inbound/outbound，requestPath 停域名根拼 /v1/messages', () => {
    expect(getInbound('anthropic-messages')().protocol).toBe('anthropic-messages')
    expect(getOutbound('anthropic-messages').requestPath()).toBe('/v1/messages')
  })
})

// ---- 移植自 Go inbound_test.go ----
describe('inbound 补充单测', () => {
  test('system 为块数组（带 cache_control 等未知字段）时解析为 IR text 块', () => {
    const req = newInbound().parseRequest(enc(`{
      "model": "glm-5.2",
      "max_tokens": 8,
      "system": [
        {"type": "text", "text": "s1", "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": "s2"}
      ],
      "messages": [{"role": "user", "content": "hi"}]
    }`))
    expect(req.system).toEqual([
      { type: 'text', text: 's1' },
      { type: 'text', text: 's2' },
    ])
  })

  test('content 为纯字符串、tool_result.content 为纯字符串都要能解析', () => {
    const req = newInbound().parseRequest(enc(`{
      "model": "glm-5.2",
      "max_tokens": 8,
      "messages": [
        {"role": "user", "content": "查天气"},
        {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "f", "input": {}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "晴 25 度"}]}
      ]
    }`))
    expect(req.messages).toHaveLength(3)
    const first = req.messages[0]!.content
    expect(first).toEqual([{ type: 'text', text: '查天气' }])
    const tr = req.messages[2]!.content[0]!
    expect(tr.type).toBe('tool_result')
    expect(tr.toolUseId).toBe('t1')
    expect(tr.content).toEqual([{ type: 'text', text: '晴 25 度' }])
  })

  test('未知字段（metadata / top_k / stop_sequence:null 等）一律容忍，不报错', () => {
    const req = newInbound().parseRequest(enc(`{
      "model": "glm-5.2",
      "max_tokens": 8,
      "metadata": {"user_id": "u-123"},
      "top_k": 5,
      "stop_sequence": null,
      "future_field": {"x": 1},
      "messages": [{"role": "user", "content": "hi"}]
    }`))
    expect(req.model).toBe('glm-5.2')
    expect(req.maxTokens).toBe(8)
    expect(req.messages).toHaveLength(1)
  })

  test('非法 JSON 报错而不是静默成功', () => {
    expect(() => newInbound().parseRequest(enc('{"model":'))).toThrow()
  })

  test('error 事件产出 event: error 帧，data 内 type 与 event 名一致', () => {
    const ev: StreamEvent = { type: 'error', error: irError(ERR.OVERLOADED, '过载') }
    const got = dec(newInbound().serializeEvent(ev))
    expect(got).toBe(
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"过载"}}\n\n')
  })

  test('非流式响应带显式 "stop_sequence": null（协议形态约定）', () => {
    const usage: Usage = { outputTokens: 0, accuracy: 'exact' }
    const got = dec(newInbound().serializeResponse({
      id: 'msg_x',
      model: 'glm-5.2',
      content: [{ type: 'text', text: 'ok' }],
      usage,
    }))
    expect(got).toContain('"stop_sequence":null')
  })
})

// ---- 移植自 Go outbound_test.go ----
describe('outbound 补充单测', () => {
  test('maxTokens<=0 缺省 4096；未设置字段不输出（W2 契约 §8）', () => {
    const got = JSON.parse(dec(newOutbound().serializeRequest({
      model: 'glm-5.2',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      stream: false,
    })))
    expect(got['max_tokens']).toBe(4096)
    for (const k of ['stream', 'tool_choice', 'tools', 'system', 'temperature', 'top_p', 'stop_sequences']) {
      expect(got[k], `未设置时不应输出 ${k}`).toBeUndefined()
    }
  })

  test('ping 帧容忍：不产出 IR 事件', () => {
    const sp = newOutbound().newStreamParser()
    expect(sp.feed(enc('event: ping\ndata: {"type":"ping"}\n\n'))).toEqual([])
  })

  test('event: error → IR EventError 事件（透传，不触发换源）', () => {
    const sp = newOutbound().newStreamParser()
    const evs = sp.feed(enc(
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"过载"}}\n\n'))
    expect(evs).toHaveLength(1)
    expect(evs[0]!.type).toBe('error')
    expect(evs[0]!.error?.type).toBe('overloaded_error')
    expect(evs[0]!.error?.message).toBe('过载')
  })
})

describe('outbound：上游 200 + JSON 错误体（真实缺陷回归）', () => {
  // zcode 余额不足时上游返回 HTTP 200 + 裸 JSON 错误（非 SSE）。解析器不得静默吞掉：
  // 空流比报错更糟——客户端永远不知道为什么没字。换源闸门此时已过（首字节已出），
  // 唯一正确的动作是把错误以 IR error 事件透传给 client。
  test('整块喂入：裸 JSON 错误 → error 事件', () => {
    const body = `{"type":"error","error":{"type":"rate_limit_error","code":"1113","message":"[1113] Insufficient balance."},"request_id":"x"}`
    const p = newOutbound().newStreamParser()
    const evs = [...p.feed(new TextEncoder().encode(body)), ...p.finish()]
    expect(evs.length).toBe(1)
    expect(evs[0]!.type).toBe('error')
    expect(evs[0]!.error?.type).toBe('rate_limit_error')
    expect(evs[0]!.error?.message).toContain('Insufficient balance')
  })

  test('7 字节分块同样成立', () => {
    const body = `{"type":"error","error":{"type":"api_error","message":"boom"}}`
    const p = newOutbound().newStreamParser()
    const evs: StreamEvent[] = []
    for (let i = 0; i < body.length; i += 7) evs.push(...p.feed(new TextEncoder().encode(body.slice(i, i + 7))))
    evs.push(...p.finish())
    expect(evs.length).toBe(1)
    expect(evs[0]!.type).toBe('error')
    expect(evs[0]!.error?.type).toBe('api_error')
  })

  test('正常 SSE 不受影响（有事件就不碰原始体）', () => {
    const sse = `event: message_start\ndata: {"type":"message_start"}\n\n`
    const p = newOutbound().newStreamParser()
    const evs = [...p.feed(new TextEncoder().encode(sse)), ...p.finish()]
    expect(evs[0]!.type).toBe('message_start')
  })

  test('非 JSON 垃圾体不产出错误事件（容忍 keep-alive 类噪声）', () => {
    const p = newOutbound().newStreamParser()
    const evs = [...p.feed(new TextEncoder().encode(': ping\n\n')), ...p.finish()]
    expect(evs.filter((e) => e.type === 'error')).toHaveLength(0)
  })
})
