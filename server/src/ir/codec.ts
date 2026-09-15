// 编解码器契约与注册表（对齐 Go internal/ir/codec.go）。
// 入站 N 协议 → IR → 出站 N 协议；禁止 N×N 硬转。

import type { IrError } from './errors.ts'
import type { IrRequest, IrResponse, Protocol, StreamEvent } from './types.ts'

// InboundCodec 负责「客户端协议 ↔ IR」。入站编解码器可能携带跨事件状态，
// gateway 每请求经工厂取独立实例，同一实例不可并发承载多条流。
export interface InboundCodec {
  readonly protocol: Protocol
  parseRequest(body: Uint8Array): IrRequest
  serializeResponse(resp: IrResponse): Uint8Array
  // 序列化单个 IR 流事件为完整 SSE 帧（含 data: 前缀与结尾空行）
  serializeEvent(ev: StreamEvent): Uint8Array
  serializeError(err: IrError): Uint8Array
}

// OutboundCodec 负责「IR ↔ 上游协议」。硬规则：SerializeRequest 在 Stream=true
// 且协议为 OpenAI 系时必须自动补 stream_options.include_usage（否则 usage 恒 0 且不报错）。
export interface OutboundCodec {
  readonly protocol: Protocol
  serializeRequest(req: IrRequest): Uint8Array
  // 操作路径（拼在 baseURL 之后）。baseURL 约定：anthropic-messages 停域名根（拼 /v1/messages）；
  // openai 两种停在 /v1（拼 chat/completions / responses）。
  // 注意：同一 Provider 可能被三种协议轮流打（自动探测/回退），单一 baseURL 无法同时满足
  // 两套约定，故真实拼接收口在 buildRequestURL（router/upstream.ts），它会消除重复的 /v1。
  requestPath(): string
  parseResponse(body: Uint8Array): IrResponse
  // 有状态的 SSE 解析器：上游字节块边界任意，实现必须自行缓冲半行。
  // 流中的协议错误以 error 事件产出（透传，不触发换源）。
  newStreamParser(): StreamParser
}

export interface StreamParser {
  feed(chunk: Uint8Array): StreamEvent[]
  finish(): StreamEvent[]
}

const inbounds = new Map<Protocol, () => InboundCodec>()
const outbounds = new Map<Protocol, OutboundCodec>()

export function registerInbound(factory: () => InboundCodec): void {
  const proto = factory().protocol
  if (inbounds.has(proto)) throw new Error(`ir: duplicate inbound codec for ${proto}`)
  inbounds.set(proto, factory)
}

export function registerOutbound(codec: OutboundCodec): void {
  if (outbounds.has(codec.protocol)) throw new Error(`ir: duplicate outbound codec for ${codec.protocol}`)
  outbounds.set(codec.protocol, codec)
}

export function getInbound(p: Protocol): () => InboundCodec {
  const f = inbounds.get(p)
  if (!f) throw new Error(`ir: no inbound codec registered for "${p}"`)
  return f
}

export function getOutbound(p: Protocol): OutboundCodec {
  const c = outbounds.get(p)
  if (!c) throw new Error(`ir: no outbound codec registered for "${p}"`)
  return c
}
