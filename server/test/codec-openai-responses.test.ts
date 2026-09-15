// openai-responses 编解码器测试：
//   1. 一致性套件（fixture 全量，单一真相 = 仓库根 tests/fixtures/openai-responses/）；
//   2. internal/codec/openairesponses/{inbound,outbound}_test.go 补充单测逐条移植。
// 运行：cd next && npx vitest run server/test/codec-openai-responses.test.ts
import { describe, expect, test } from 'vitest'
import { inboundSuite, outboundSuite } from './conformance.ts'
import { getInbound, getOutbound } from '../src/ir/index.ts'
import type { StreamEvent } from '../src/ir/index.ts'
import { newInbound, newOutbound } from '../src/codec/openairesponses.ts'

const enc = new TextEncoder()

// ---- 一致性套件（验收底线） ----
inboundSuite(newInbound())
outboundSuite(newOutbound())

function feedAll(sse: string): StreamEvent[] {
  const sp = newOutbound().newStreamParser()
  return [...sp.feed(enc.encode(sse)), ...sp.finish()]
}

describe('注册（Go TestOutRegistered 移植）', () => {
  test('出站编解码器已注册进 IR 注册表，协议名正确', () => {
    const c = getOutbound('openai-responses')
    expect(c.protocol).toBe('openai-responses')
  })

  test('入站工厂每次返回独立实例（每请求独立流式状态）', () => {
    expect(getInbound('openai-responses')()).not.toBe(getInbound('openai-responses')())
  })
})

describe('入站边角（Go inbound_test.go 移植）', () => {
  test('TestInboundStringInput: input 纯字符串 → 单条 user 文本消息', () => {
    const req = newInbound().parseRequest(enc.encode('{"model":"m1","input":"hi"}'))
    expect(req.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  test('TestInboundNoInstructions: instructions 缺省 → system 空；role 消息 content 字符串形态可解析', () => {
    const req = newInbound().parseRequest(
      enc.encode('{"model":"m1","input":[{"role":"user","content":"hello"}]}'))
    expect(req.system).toBeUndefined()
    expect(req.messages).toHaveLength(1)
    expect(req.messages[0]!.content).toHaveLength(1)
    expect(req.messages[0]!.content[0]!.text).toBe('hello')
  })

  test('TestInboundObjectToolChoice: tool_choice 对象形态（指定函数）→ IR mode=tool', () => {
    const req = newInbound().parseRequest(enc.encode(
      '{"model":"m1","input":"x",' +
      '"tools":[{"type":"function","name":"f","parameters":{"type":"object"}}],' +
      '"tool_choice":{"type":"function","name":"f"}}'))
    expect(req.toolChoice).toEqual({ mode: 'tool', name: 'f' })
  })
})

describe('出站请求（坑位语义锁定）', () => {
  // Responses API 与 completions 的坑位 #1 不同：usage 随 response.completed 返回，
  // 无 stream_options 参数（Go outbound.go 明确注释，fixture upstream-request.tools 锁定）。
  test('SerializeRequest stream=true 不补 stream_options，stream=false 时省略 stream 字段', () => {
    const body = JSON.parse(new TextDecoder().decode(newOutbound().serializeRequest({
      model: 'm1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      stream: true,
    })))
    expect(body.stream).toBe(true)
    expect(body).not.toHaveProperty('stream_options')

    const bodyNoStream = JSON.parse(new TextDecoder().decode(newOutbound().serializeRequest({
      model: 'm1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      stream: false,
    })))
    expect(bodyNoStream).not.toHaveProperty('stream')
  })

  // 真实缺陷回归（上游原文报错，2026-09-13 实测 zen muse-spark-1.3 多轮）：
  //   content type `input_text` is not valid on `assistant` message
  // 序列化时无视 role 一律写 input_text，导致任何多轮对话（历史里有 assistant 轮）
  // 都被上游拒掉 → 「根本用不了」。assistant 的历史文本必须是 output_text。
  test('多轮：assistant 历史文本用 output_text，user 用 input_text', () => {
    const body = JSON.parse(new TextDecoder().decode(newOutbound().serializeRequest({
      model: 'm1',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '记住 7、13、29' }] },
        { role: 'assistant', content: [{ type: 'text', text: '记住了' }] },
        { role: 'user', content: [{ type: 'text', text: '加起来是多少？' }] },
      ],
      stream: true,
    })))
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: '记住 7、13、29' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: '记住了' }] },
      { role: 'user', content: [{ type: 'input_text', text: '加起来是多少？' }] },
    ])
  })

  test('单轮 user 仍是 input_text（不回归）', () => {
    const body = JSON.parse(new TextDecoder().decode(newOutbound().serializeRequest({
      model: 'm1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      stream: true,
    })))
    expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
  })
})

describe('出站流式边角（Go outbound_test.go 移植）', () => {
  test('TestOutStreamFailed: response.failed → 单个 error 事件透传，Finish 不再补发收尾', () => {
    const sse = `event: response.created
data: {"type":"response.created","response":{"id":"resp_f1","created":1720000100,"model":"glm-5.2","status":"in_progress"}}

event: response.failed
data: {"type":"response.failed","response":{"id":"resp_f1","status":"failed","error":{"code":"server_error","message":"上游炸了"}}}

`
    const sp = newOutbound().newStreamParser()
    const evs = [...sp.feed(enc.encode(sse)), ...sp.finish()]
    expect(evs, `事件数应为 2 (message_start + error): ${JSON.stringify(evs)}`).toHaveLength(2)
    expect(evs[0]!.type).toBe('message_start')
    expect(evs[1]!.type).toBe('error')
    expect(evs[1]!.error?.message).toContain('上游炸了')
  })

  test('TestOutStreamOutputTextDoneTolerated: output_text.done 容忍且不重复产出事件', () => {
    const sse = `event: response.created
data: {"type":"response.created","response":{"id":"resp_s1","created":1720000100,"model":"glm-5.2","status":"in_progress"}}

event: response.output_item.added
data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"in_progress","content":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"你好！"}

event: response.output_text.done
data: {"type":"response.output_text.done","item_id":"msg_1","output_index":0,"content_index":0,"text":"你好！"}

event: response.output_item.done
data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"你好！"}]}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_s1","created":1720000100,"model":"glm-5.2","status":"completed","usage":{"input_tokens":12,"output_tokens":2,"total_tokens":14}}}

`
    const evs = feedAll(sse)
    // start + block_start + 1 delta + block_stop + message_delta + message_stop = 6
    expect(evs, `事件数应为 6 (output_text.done 不得产出事件): ${JSON.stringify(evs)}`).toHaveLength(6)
    expect(evs.filter((ev) => ev.type === 'content_block_delta')).toHaveLength(1)
  })

  test('TestOutStreamNoTrailingBlank: 尾帧无空行时 Finish 必须分发 completed（含 usage）', () => {
    const sse = `event: response.created
data: {"type":"response.created","response":{"id":"resp_s1","created":1720000100,"model":"glm-5.2","status":"in_progress"}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_s1","created":1720000100,"model":"glm-5.2","status":"completed","usage":{"input_tokens":12,"output_tokens":2,"total_tokens":14}}}`
    const sp = newOutbound().newStreamParser()
    const evs = [...sp.feed(enc.encode(sse)), ...sp.finish()]
    expect(evs, `事件数应为 3 (start + delta + stop): ${JSON.stringify(evs)}`).toHaveLength(3)
    const md = evs[1]!
    expect(md.type).toBe('message_delta')
    expect(md.stopReason).toBe('end_turn')
    expect(md.usage?.inputTokens).toBe(12)
    expect(md.usage?.outputTokens).toBe(2)
    expect(evs[2]!.type).toBe('message_stop')
  })

  test('TestOutStreamFinishWithoutCompleted: 无 completed 直接 EOF → Finish 补发收尾，Feed 不提前发', () => {
    const sse = `event: response.created
data: {"type":"response.created","response":{"id":"resp_s9","created":1720000100,"model":"glm-5.2","status":"in_progress"}}

event: response.output_item.added
data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"in_progress","content":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"好"}

event: response.output_item.done
data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"好"}]}}

`
    const sp = newOutbound().newStreamParser()
    const fed = sp.feed(enc.encode(sse))
    for (const ev of fed) {
      expect(ev.type === 'message_delta' || ev.type === 'message_stop',
        `Feed 阶段不应发出收尾事件: ${JSON.stringify(ev)}`).toBe(false)
    }
    const tail = sp.finish()
    expect(tail, `Finish 应补发 2 个事件: ${JSON.stringify(tail)}`).toHaveLength(2)
    expect(tail[0]!.type).toBe('message_delta')
    expect(tail[0]!.stopReason).toBe('end_turn')
    expect(tail[1]!.type).toBe('message_stop')
  })
})
