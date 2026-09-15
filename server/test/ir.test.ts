import { describe, expect, test } from 'vitest'
import {
  accuracyWorst,
  kindForStatus,
  irError,
  UpstreamError,
  UPSTREAM,
  usageTotal,
  ERR,
  type IrError,
  type Usage,
} from '../src/ir/index.ts'
import { getInbound, getOutbound, registerInbound, registerOutbound } from '../src/ir/index.ts'
import type { InboundCodec, OutboundCodec } from '../src/ir/index.ts'

describe('ir 错误分类（对齐 Go internal/ir/errors.go）', () => {
  test('kindForStatus 状态码→语义分类', () => {
    expect(kindForStatus(401)).toBe(UPSTREAM.AUTH)
    expect(kindForStatus(403)).toBe(UPSTREAM.AUTH)
    expect(kindForStatus(402)).toBe(UPSTREAM.QUOTA)
    expect(kindForStatus(429)).toBe(UPSTREAM.RATE_LIMIT)
    expect(kindForStatus(400)).toBe(UPSTREAM.BAD_REQUEST)
    expect(kindForStatus(404)).toBe(UPSTREAM.BAD_REQUEST)
    expect(kindForStatus(413)).toBe(UPSTREAM.BAD_REQUEST)
    expect(kindForStatus(422)).toBe(UPSTREAM.BAD_REQUEST)
    expect(kindForStatus(500)).toBe(UPSTREAM.SERVER)
    expect(kindForStatus(503)).toBe(UPSTREAM.SERVER)
    expect(kindForStatus(418)).toBe(UPSTREAM.UNKNOWN)
  })

  test('UpstreamError 消息形态（有/无 http 状态）', () => {
    expect(new UpstreamError(429, UPSTREAM.RATE_LIMIT, '慢').message).toBe(
      'upstream rate_limit (http 429): 慢')
    expect(new UpstreamError(0, UPSTREAM.NETWORK, '连不上').message).toBe(
      'upstream network: 连不上')
  })

  test('IrError.HTTPStatus 对齐 Anthropic 错误词汇', () => {
    expect(irError(ERR.INVALID_REQUEST, 'x').httpStatus).toBe(400)
    expect(irError(ERR.AUTHENTICATION, 'x').httpStatus).toBe(401)
    expect(irError(ERR.PERMISSION, 'x').httpStatus).toBe(403)
    expect(irError(ERR.NOT_FOUND, 'x').httpStatus).toBe(404)
    expect(irError(ERR.REQUEST_TOO_LARGE, 'x').httpStatus).toBe(413)
    expect(irError(ERR.RATE_LIMIT, 'x').httpStatus).toBe(429)
    expect(irError(ERR.OVERLOADED, 'x').httpStatus).toBe(529)
    expect(irError(ERR.API, 'x').httpStatus).toBe(500)
    const unknown: IrError = { type: 'weird_error', message: 'x', httpStatus: 0 }
    expect(irError(unknown.type, unknown.message).httpStatus).toBe(500)
  })
})

describe('IR 用量（缓存独立字段硬约束）', () => {
  test('usageTotal：默认 subset（OpenAI 系）= input+output（cached/miss 是 input 子集，不另加）', () => {
    const u: Usage = {
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 5,
      cacheCreationTokens: 3, reasoningTokens: 8, accuracy: 'exact',
    }
    expect(usageTotal(u)).toBe(30) // 默认 subset
    expect(usageTotal(u, 'subset')).toBe(30)
  })

  test('usageTotal：separate 显式标注时才另加缓存两项', () => {
    const u: Usage = {
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 5,
      cacheCreationTokens: 3, reasoningTokens: 8, accuracy: 'exact',
    }
    expect(usageTotal(u, 'separate')).toBe(38)
  })

  test('usageTotal：subset（OpenAI 系）= input+output（cached 已含在 input 内，不另加）', () => {
    const u: Usage = {
      inputTokens: 12, outputTokens: 34, cacheReadTokens: 8, accuracy: 'exact',
    }
    // 夹具事实：prompt=12, completion=34, total=46，cached=8 不另加
    expect(usageTotal(u, 'subset')).toBe(46)
  })

  test('accuracyWorst 取更不可信一档', () => {
    expect(accuracyWorst('exact', 'estimated')).toBe('estimated')
    expect(accuracyWorst('estimated', 'unknown')).toBe('unknown')
    expect(accuracyWorst('exact', 'exact')).toBe('exact')
  })
})

describe('编解码器注册表（对齐 Go ir/codec.go）', () => {
  test('重复注册同协议视为编程错误', () => {
    const factory = () => ({ protocol: 'test-proto-a' }) as unknown as InboundCodec
    registerInbound(factory)
    expect(() => registerInbound(factory)).toThrow(/test-proto-a/)
    const out = { protocol: 'test-proto-b' } as unknown as OutboundCodec
    registerOutbound(out)
    expect(() => registerOutbound(out)).toThrow(/test-proto-b/)
  })

  test('inbound 工厂每请求取独立实例；未注册报错', () => {
    let n = 0
    registerInbound(() => {
      n++
      return { protocol: `proto-${n}` } as unknown as InboundCodec
    })
    // 对齐 Go：getInbound 返回工厂，gateway 每请求调用取独立实例
    const a = getInbound('proto-1')()
    const b = getInbound('proto-1')()
    expect(a).not.toBe(b)
    expect(() => getInbound('never-registered')).toThrow(/never-registered/)
    expect(() => getOutbound('never-registered')).toThrow(/never-registered/)
  })
})
