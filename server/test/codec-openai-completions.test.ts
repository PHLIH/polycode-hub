// openaicompletions 编解码器测试（对齐 Go internal/codec/openaicompletions/{inbound,outbound}_test.go）。
// 一致性底线：inboundSuite / outboundSuite 跑全量仓库根 fixture；
// 其余用例为 Go 补充单测的逐条移植。

import { describe, expect, test } from 'vitest'
import { inboundSuite, outboundSuite } from './conformance.ts'
import {
  getInbound,
  getOutbound,
  type IrRequest,
  type IrResponse,
  type StreamEvent,
} from '../src/ir/index.ts'
import { newInbound, newOutbound } from '../src/codec/openaicompletions.ts'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const dec = (b: Uint8Array): string => new TextDecoder().decode(b)

// ---- 一致性套件（W2 统一夹具，验收底线；对齐 TestConformance / TestOutConformance）----

inboundSuite(newInbound())
outboundSuite(newOutbound())

// ---- 注册表（对齐 TestRegistered / TestOutRegistered）----

describe('init 必须把编解码器注册进 IR 注册表', () => {
  test('inbound 工厂可取回且协议正确', () => {
    const c = getInbound('openai-completions')()
    expect(c.protocol).toBe('openai-completions')
  })

  test('outbound 可取回且协议正确', () => {
    expect(getOutbound('openai-completions').protocol).toBe('openai-completions')
  })
})

// ---- 入站补充单测（对齐 inbound_test.go）----

describe('入站补充单测（对齐 inbound_test.go）', () => {
  test('stop 支持 string 与数组两种形态', () => {
    const a = newInbound().parseRequest(
      enc(`{"model":"m","messages":[{"role":"user","content":"hi"}],"stop":"END"}`))
    expect(a.stopSequences).toEqual(['END'])
    const b = newInbound().parseRequest(
      enc(`{"model":"m","messages":[{"role":"user","content":"hi"}],"stop":["a","b"]}`))
    expect(b.stopSequences).toEqual(['a', 'b'])
  })

  test('tool_choice 对象形态 → IR tool 模式 + 指定工具名', () => {
    const req = newInbound().parseRequest(enc(
      `{"model":"m","messages":[{"role":"user","content":"hi"}],"tool_choice":{"type":"function","function":{"name":"get_weather"}}}`))
    expect(req.toolChoice).toEqual({ mode: 'tool', name: 'get_weather' })
  })

  test('user content 为纯 text 部件数组 → 多个 IR text 块', () => {
    const req = newInbound().parseRequest(enc(
      `{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}]}`))
    expect(req.messages).toHaveLength(1)
    expect(req.messages[0]?.content).toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
  })

  test('多个 text 块 → content 数组形态（README 约定 #10）', () => {
    const resp: IrResponse = {
      id: 'x',
      model: 'm',
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
      usage: { inputTokens: 1, outputTokens: 2, accuracy: 'exact' },
    }
    const got = JSON.parse(dec(newInbound().serializeResponse(resp))) as {
      choices?: { message?: { content?: unknown } }[]
    }
    expect(got.choices).toHaveLength(1)
    expect(got.choices?.[0]?.message?.content).toEqual([
      { type: 'text', text: 'a' }, { type: 'text', text: 'b' },
    ])
  })

  test('developer 角色进 IR System，不掉进 user 消息（DeepSeek Harness 等）', () => {
    const req = newInbound().parseRequest(enc(
      `{"model":"m","messages":[{"role":"developer","content":"你是助手"},{"role":"user","content":"hi"}]}`))
    expect(req.system).toHaveLength(1)
    expect(req.system?.[0]?.text).toBe('你是助手')
    expect(req.messages).toHaveLength(1)
    expect(req.messages[0]?.role).toBe('user')
  })

  test('max_completion_tokens 回落；双字段并存时 max_tokens 优先', () => {
    const a = newInbound().parseRequest(enc(
      `{"model":"m","max_completion_tokens":100,"messages":[{"role":"user","content":"hi"}]}`))
    expect(a.maxTokens).toBe(100)
    const b = newInbound().parseRequest(enc(
      `{"model":"m","max_tokens":50,"max_completion_tokens":100,"messages":[{"role":"user","content":"hi"}]}`))
    expect(b.maxTokens).toBe(50)
  })
})

// ---- 出站补充单测（对齐 outbound_test.go）----

describe('出站补充单测（对齐 outbound_test.go）', () => {
  // stream:true 时的强制补全（坑位 #1）由 conformance tools 场景锁定。
  test('stream:false 时请求不得含 stream / stream_options 字段（README 约定 #8）', () => {
    const req: IrRequest = {
      model: 'm',
      maxTokens: 100,
      stream: false,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }
    const raw = JSON.parse(dec(newOutbound().serializeRequest(req))) as Record<string, unknown>
    expect(raw).not.toHaveProperty('stream')
    expect(raw).not.toHaveProperty('stream_options')
  })

  test('多工具并行：openai tool_calls index 0/1 → IR 块 1/2，arguments 增量落对块', () => {
    const sse = String.raw`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"fa","arguments":""}}]},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"a\":1}"}}]},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"fb","arguments":""}}]},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\"b\":2}"}}]},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
`
    const sp = newOutbound().newStreamParser()
    const evs: StreamEvent[] = [...sp.feed(enc(sse)), ...sp.finish()]

    // 块序列：0=text 1=tool call_a 2=tool call_b
    const wantBlocks = [
      { type: 'text', id: undefined, name: undefined },
      { type: 'tool_use', id: 'call_a', name: 'fa' },
      { type: 'tool_use', id: 'call_b', name: 'fb' },
    ] as const
    const starts = evs.filter((ev) => ev.type === 'content_block_start')
    expect(starts).toHaveLength(wantBlocks.length)
    for (const [i, s] of starts.entries()) {
      expect(s.index ?? 0, `块 ${i} 的 index`).toBe(i)
      expect(s.block?.type).toBe(wantBlocks[i]?.type)
      expect(s.block?.id).toBe(wantBlocks[i]?.id)
      expect(s.block?.name).toBe(wantBlocks[i]?.name)
    }
    // arguments 增量按 openai index 映射到正确的 IR 块
    const wantJSON = new Map<number, string>([[1, '{"a":1}'], [2, '{"b":2}']])
    for (const ev of evs) {
      if (ev.type !== 'content_block_delta' || ev.delta?.kind !== 'tool_json') continue
      expect(ev.delta.partialJson, `块 ${ev.index ?? 0} 的 arguments 增量`).toBe(wantJSON.get(ev.index ?? 0))
      wantJSON.delete(ev.index ?? 0)
    }
    expect(wantJSON.size).toBe(0)
    // 块收尾序列：开新块前先关旧块（text(0)→tool(1)→tool(2)），
    // 且所有 content_block_stop 都先于 message_delta（README 约定 #5）
    const stops: number[] = []
    let mdSeen = false
    for (const ev of evs) {
      if (ev.type === 'content_block_stop') {
        expect(mdSeen, `content_block_stop(${ev.index ?? 0}) 出现在 message_delta 之后`).toBe(false)
        stops.push(ev.index ?? 0)
      }
      if (ev.type === 'message_delta') mdSeen = true
    }
    expect(stops).toEqual([0, 1, 2])
    // 终态：message_delta(tool_use) + message_stop
    const n = evs.length
    expect(evs[n - 2]?.type).toBe('message_delta')
    expect(evs[n - 2]?.stopReason).toBe('tool_use')
    expect(evs[n - 1]?.type).toBe('message_stop')
  })

  test('上游无 [DONE] 直接 EOF：Finish 补发收尾事件，Feed 阶段不提前发', () => {
    const sse = String.raw`data: {"id":"c9","object":"chat.completion.chunk","created":2,"model":"m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"c9","object":"chat.completion.chunk","created":2,"model":"m","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":null}]}

data: {"id":"c9","object":"chat.completion.chunk","created":2,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
`
    expect(sse).toContain('finish_reason') // 保证用例本身有效
    const sp = newOutbound().newStreamParser()
    const evs = sp.feed(enc(sse))
    for (const ev of evs) {
      expect(['message_delta', 'message_stop'], `Feed 阶段不应发出收尾事件: ${ev.type}`).not.toContain(ev.type)
    }
    const tail = sp.finish()
    expect(tail).toHaveLength(2)
    expect(tail[0]?.type).toBe('message_delta')
    expect(tail[0]?.stopReason).toBe('end_turn')
    expect(tail[1]?.type).toBe('message_stop')
  })
})

// —— 缓存写入字段（真实上游载荷回归）——
// 背景：标准 OpenAI 的 usage 只有 prompt_tokens_details.cached_tokens，
// 但 Tencent CodeBuddy（hy4-preview）这条链路在顶层另发一组缓存字段。
// 网关原先只读 cached_tokens，导致「缓存写入」恒为 0——不是上游没给，是没读。
// 下面这条 usage 是从 https://copilot.tencent.com/v2/chat/completions 实抓的。
describe('缓存字段解析（CodeBuddy/hy4 真实载荷）', () => {
  const realUsage =
    '{"prompt_tokens":23,"completion_tokens":108,"total_tokens":131,' +
    '"completion_tokens_details":{"accepted_prediction_tokens":0,"audio_tokens":0,' +
    '"reasoning_tokens":97,"rejected_prediction_tokens":0,"cached_tokens":0},' +
    '"prompt_tokens_details":{"accepted_prediction_tokens":0,"audio_tokens":0,' +
    '"reasoning_tokens":0,"rejected_prediction_tokens":0,"cached_tokens":0},' +
    '"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":23,' +
    '"cache_read_input_tokens":0,"cache_creation_input_tokens":0,' +
    '"prompt_cache_write_tokens":0,"completion_thinking_tokens":97,"credit":0,"cached_tokens":0}'

  function usageFromStream(u: string): StreamEvent['usage'] {
    const sse = `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"hy4-preview",` +
      `"choices":[{"index":0,"delta":{"content":"好"},"finish_reason":"stop"}],"usage":${u}}\n\n`
    const sp = newOutbound().newStreamParser()
    // usage 与收尾事件一同在 finish() 阶段产出，必须 feed + finish 都收
    const evs = [...sp.feed(enc(sse)), ...sp.finish()]
    return evs.find((e) => e.type === 'message_delta')?.usage
  }

  test('prompt_cache_miss_tokens → cacheCreationTokens（真正写入缓存的量）', () => {
    const u = usageFromStream(realUsage)
    expect(u?.inputTokens).toBe(23)
    expect(u?.outputTokens).toBe(108)
    // 冷启动 23 token 全 miss = 全量写入
    expect(u?.cacheCreationTokens).toBe(23)
  })

  test('命中场景：hit 走 cacheReadTokens，miss 走 cacheCreationTokens', () => {
    const u = usageFromStream(
      '{"prompt_tokens":425,"completion_tokens":10,"total_tokens":435,' +
      '"prompt_tokens_details":{"cached_tokens":320},' +
      '"prompt_cache_hit_tokens":320,"prompt_cache_miss_tokens":105,' +
      '"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"prompt_cache_write_tokens":0}')
    // 两个维度各自独立，绝不互相混入
    expect(u?.cacheReadTokens).toBe(320)
    expect(u?.cacheCreationTokens).toBe(105)
    expect(u?.inputTokens).toBe(425) // input 仍是上游给的全量，不被改写
  })

  test('上游未给缓存写入字段时留空（不产出 0 假装是数据）', () => {
    const u = usageFromStream(
      '{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105,' +
      '"prompt_tokens_details":{"cached_tokens":40}}')
    expect(u?.cacheReadTokens).toBe(40)
    expect(u?.cacheCreationTokens).toBeUndefined()
  })

  test('显式 cache_creation_input_tokens 优先于 miss_tokens', () => {
    const u = usageFromStream(
      '{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105,' +
      '"cache_creation_input_tokens":77,"prompt_cache_miss_tokens":40}')
    expect(u?.cacheCreationTokens).toBe(77)
  })
})

// —— 末帧无尾随换行（真实缺陷回归）——
// 背景：finish() 原先对残余半行调用 this.line(line) 却丢弃返回值
// （feed() 是 `evs.push(...)`，两者不一致）。上游最后一帧不以 \n 结尾时——
// openai 的末尾独立 usage chunk 正是这种形态——该帧被整个丢弃：
// 最后一段正文消失，更糟的是 chunk() 不被调用、this.usage 不会被赋值，
// message_delta 就不带 usage，计费侧拿到 0。
// 所有 .sse fixture 恰好都以 0x0a 结尾，所以一致性套件测不出来，只能在这里钉死。
describe('末帧无尾随换行（收尾不得丢帧）', () => {
  function parse(sse: string): StreamEvent[] {
    const sp = newOutbound().newStreamParser()
    return [...sp.feed(enc(sse)), ...sp.finish()]
  }

  test('最后一帧不带 \\n：正文与 usage 都必须产出', () => {
    const evs = parse(
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m",' +
      '"choices":[{"index":0,"delta":{"content":"最后一个字"},"finish_reason":"stop"}],' +
      '"usage":{"prompt_tokens":23,"completion_tokens":108}}\n\n' +
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m",' +
      '"choices":[{"index":0,"delta":{"content":"收尾"},"finish_reason":"stop"}],' +
      '"usage":{"prompt_tokens":30,"completion_tokens":120}}') // ← 无尾换行
    const texts = evs.filter((e) => e.type === 'content_block_delta')
      .map((e) => (e as { delta?: { text?: string } }).delta?.text)
    expect(texts).toContain('最后一个字')
    expect(texts).toContain('收尾') // 以前这一帧整个消失
    const d = evs.find((e) => e.type === 'message_delta')
    expect(d?.usage?.inputTokens).toBe(30)
    expect(d?.usage?.outputTokens).toBe(120) // 以前恒为 undefined → 计费 0
  })

  test('末尾独立 usage chunk 且无尾换行：usage 仍要落进 message_delta', () => {
    const evs = parse(
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m",' +
      '"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n' +
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m",' +
      '"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":9}}') // ← 无尾换行
    const d = evs.find((e) => e.type === 'message_delta')
    expect(d?.usage?.inputTokens).toBe(7)
    expect(d?.usage?.outputTokens).toBe(9)
    // 收尾序列完整性：message_stop 必须在最后，且 content_block_stop 先于 message_delta
    expect(evs[evs.length - 1]?.type).toBe('message_stop')
  })

  test('带尾换行时行为不变（对照）', () => {
    const withNl = parse(
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m",' +
      '"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}],' +
      '"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n')
    expect(withNl.find((e) => e.type === 'message_delta')?.usage?.outputTokens).toBe(2)
    expect(withNl.filter((e) => e.type === 'content_block_delta')).toHaveLength(1)
  })
})
