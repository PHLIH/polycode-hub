// 真实回归样本：2026-09-13 从 zen muse-spark-1.3（reasoning 模型）经代理抓取的完整 SSE。
// 教训：reasoning 模型把小 max_output_tokens 预算全部吃在推理上 → response.incomplete，
// 没有任何 output_text。网关必须如实产出 max_tokens 截断语义，不能装作成功。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import '../src/codec/openairesponses.ts'
import { getOutbound } from '../src/ir/index.ts'

const SSE = fileURLToPath(new URL('./fixtures/openai-responses-real/stream.reasoning.sse', import.meta.url))

describe('openai-responses 真实流回归（reasoning 吃满预算 → incomplete）', () => {
  test('incomplete → IR stopReason=max_tokens，无虚构成文', () => {
    const p = getOutbound('openai-responses').newStreamParser()
    const sse = new Uint8Array(readFileSync(SSE))
    const evs = [...p.feed(sse), ...p.finish()]
    const delta = evs.filter((e) => e.type === 'message_delta')
    expect(delta.length).toBeGreaterThan(0)
    expect(delta.at(-1)!.stopReason).toBe('max_tokens')
    // 全程没有 text delta（reasoning 吃满预算，诚实表达）
    expect(evs.filter((e) => e.type === 'content_block_delta' && e.delta?.kind === 'text')).toHaveLength(0)
    // usage 应有产出（incomplete 带用量）
    expect(evs.some((e) => e.usage)).toBe(true)
  })
})
