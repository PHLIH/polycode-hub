// 跨协议 usage 语义归一 + completions 抽取/合并（扫描实证的三条 P1 回归）。
//
// 背景（CACHE-SEMANTICS）：ir 的 Usage 是中性容器，字段语义由产生它的协议决定。
// 网关允许任意「客户端协议 × 上游协议」组合（/v1/chat/completions 的客户端可以
// 打到 anthropic 出站的 zcode/zcode-plan-local），因此：
//   P1-1 跨协议语义破坏——anthropic 上游（separate：input 只含未命中）的响应
//        转给 openai 客户端时，曾原样输出 prompt_tokens=105 + cached_tokens=320
//        （子集语义下命中数不可能超过父集，客户端按 subset 读即得荒值）。
//   P1-2 completions 不抽 completion_tokens_details.reasoning_tokens——
//        实抓载荷里该字段存在（97），不抽则 reasoning 用量全程丢失。
//   P1-3 completions 的 usage chunk 直接赋值——真 usage 之后跟一个全零 usage
//        chunk 会把已暂存的用量抹成 undefined（计费侧记 0）。

import { describe, expect, test } from 'vitest'
import { getInbound, getOutbound } from '../src/ir/index.ts'
// import 副作用：注册三个 codec（getInbound/getOutbound 依赖注册表）
import '../src/codec/anthropicmessages.ts'
import '../src/codec/openaicompletions.ts'
import '../src/codec/openairesponses.ts'
import type { IrRequest, StreamEvent, Usage } from '../src/ir/types.ts'
import { normalizeUsageSem } from '../src/ir/types.ts'

const req: IrRequest = {
  model: 'm', stream: false, maxTokens: 16,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
}

describe('跨协议 usage 语义归一（P1-1）', () => {
  test('separate 上游 → openai 客户端：prompt 折算为三桶和，明细清空', () => {
    // anthropic wire：input=105(未命中) read=320 creation=0
    const ir: Usage = { outputTokens: 50, inputTokens: 105, cacheReadTokens: 320, accuracy: 'exact', sem: 'separate' }
    const inb = getInbound('openai-completions')()
    // 入站序列化（IR → openai），IR 带来自 anthropic 上游的 separate 语义
    const wire = inb.serializeResponse({
      id: 'x', content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn',
      usage: normalizeUsageSem(ir, 'subset'), created: 1,
    })
    const text = Buffer.from(wire as unknown as ArrayBuffer).toString('utf8')
    const parsed = JSON.parse(text) as { usage: { prompt_tokens: number; prompt_tokens_details?: { cached_tokens: number } } }
    // 折算后 prompt = 105 + 320 = 425（全量输入），cached 明细已随折算清空——
    // 不会再出现 105 + cached 320 的自相矛盾组合。
    expect(parsed.usage.prompt_tokens).toBe(425)
    expect(parsed.usage.prompt_tokens_details).toBeUndefined()
  })

  test('subset 上游 → anthropic 客户端：input 折算为未命中部分', () => {
    // openai wire：prompt=425（已含 cached=320）
    const ir: Usage = { outputTokens: 50, inputTokens: 425, cacheReadTokens: 320, accuracy: 'exact', sem: 'subset' }
    const inb = getInbound('anthropic-messages')()
    const wire = inb.serializeResponse({
      id: 'x', content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn',
      usage: normalizeUsageSem(ir, 'separate'), created: 1,
    })
    const parsed = JSON.parse(Buffer.from(wire as unknown as ArrayBuffer).toString('utf8')) as {
      usage: { input_tokens: number; cache_read_input_tokens?: number }
    }
    // 未命中输入 = 425 - 320 = 105；命中量独立保留（三桶互斥读法成立）
    expect(parsed.usage.input_tokens).toBe(105)
    expect(parsed.usage.cache_read_input_tokens).toBe(320)
  })

  test('同语义不折算（separate → anthropic 原样）', () => {
    const ir: Usage = { outputTokens: 1, inputTokens: 105, cacheReadTokens: 320, accuracy: 'exact', sem: 'separate' }
    expect(normalizeUsageSem(ir, 'separate')).toBe(ir)
  })

  test('无 sem 标签（conformance 夹具/旧路径）→ 原样返回，不猜语义', () => {
    const ir: Usage = { outputTokens: 1, inputTokens: 12, cacheReadTokens: 3, accuracy: 'exact' }
    expect(normalizeUsageSem(ir, 'separate')).toBe(ir)
    expect(normalizeUsageSem(ir, 'subset')).toBe(ir)
  })

  test('subset → separate 折算下限 0（上游误报时不输出负数）', () => {
    const ir: Usage = { outputTokens: 1, inputTokens: 5, cacheReadTokens: 320, cacheCreationTokens: 1, accuracy: 'exact', sem: 'subset' }
    const got = normalizeUsageSem(ir, 'separate')
    expect(got.inputTokens).toBe(0)
  })
})

describe('completions usage 抽取与合并（P1-2 / P1-3）', () => {
  test('completion_tokens_details.reasoning_tokens 被抽取（实抓载荷形态）', () => {
    const parser = getOutbound('openai-completions').newStreamParser()
    const feed = (s: string): StreamEvent[] => parser.feed(new TextEncoder().encode(s))
    feed('data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n')
    feed('data: {"id":"c1","choices":[],"usage":{"prompt_tokens":23,"completion_tokens":108,"total_tokens":131,'
      + '"prompt_tokens_details":{"cached_tokens":20},'
      + '"completion_tokens_details":{"accepted_prediction_tokens":0,"audio_tokens":0,"reasoning_tokens":97}}}\n\n')
    // [DONE] 触发收尾序列（message_delta + message_stop），其返回值必须接住——
    // finish() 之后不会再有事件。
    const evs = [...feed('data: [DONE]\n\n'), ...parser.finish()]
    const delta = evs.find((e) => e.type === 'message_delta')
    expect(delta).toBeDefined()
    const u = (delta as { usage?: Usage }).usage
    expect(u?.reasoningTokens).toBe(97)
    expect(u?.outputTokens).toBe(108)
    expect(u?.cacheReadTokens).toBe(20)
  })

  test('真 usage 之后的全零 usage chunk 不再抹掉用量（P1-3 回归）', () => {
    const parser = getOutbound('openai-completions').newStreamParser()
    const feed = (s: string): StreamEvent[] => parser.feed(new TextEncoder().encode(s))
    feed('data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n')
    // 真实 usage
    feed('data: {"id":"c1","choices":[],"usage":{"prompt_tokens":23,"completion_tokens":108,"total_tokens":131}}\n\n')
    // 有的上游会再发一个全零 usage chunk——旧代码在这里把用量抹成 undefined
    feed('data: {"id":"c1","choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}\n\n')
    const evs = [...feed('data: [DONE]\n\n'), ...parser.finish()]
    const delta = evs.find((e) => e.type === 'message_delta')
    const u = (delta as { usage?: Usage }).usage
    expect(u).toBeDefined()
    expect(u?.inputTokens).toBe(23)
    expect(u?.outputTokens).toBe(108)
  })
})
