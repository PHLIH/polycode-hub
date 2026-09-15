// anthropic-messages 编解码器（Go internal/codec/anthropicmessages 的 TS 移植）。
// inbound：client wire ↔ IR；outbound：IR ↔ 上游 wire。
// IR 词汇表以 Anthropic Messages 为规范，mostly 直译；形态差异：
// system/content 的 string↔块数组、stop_sequence 显式 null、SSE 具名事件帧、半行缓冲。
// 语义逐条对齐 Go 版（含 omitempty ↔ undefined 的省略规则与各坑位注释）。

import {
  ERR,
  irError,
  registerInbound,
  registerOutbound,
  type Block,
  type Delta,
  type ImageSource,
  type InboundCodec,
  type IrRequest,
  type IrResponse,
  type Message,
  type OutboundCodec,
  type Role,
  type StopReason,
  type StreamEvent,
  type StreamParser,
  type ToolChoiceMode,
  type ToolDef,
  type Usage,
} from '../ir/index.ts'

type Obj = Record<string, unknown>

const enc = new TextEncoder()

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
// 宽松取值：缺失/类型不符按零值处理（Go 解码零值语义）；仅未知块类型/图片来源等
// 语义性错误抛错，与 Go 一致。
function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}
// Go omitempty：空串在 IR JSON 中省略 ↔ undefined。
function nonEmpty(s: string): string | undefined {
  return s === '' ? undefined : s
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function parseJSON(what: string, body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body))
  } catch (e) {
    throw new Error(`anthropic-messages: 解析${what}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function jsonBytes(v: unknown): Uint8Array {
  return enc.encode(JSON.stringify(v))
}

// ---- 入站（client wire ↔ IR）----

export function newInbound(): InboundCodec {
  return new InCodec()
}

class InCodec implements InboundCodec {
  readonly protocol = 'anthropic-messages'

  parseRequest(body: Uint8Array): IrRequest {
    const w = parseJSON('请求', body)
    if (!isObj(w)) throw new Error('anthropic-messages: 请求不是 JSON 对象')
    const req: IrRequest = {
      model: str(w.model),
      messages: arr(w.messages).map((m) => {
        if (!isObj(m)) throw new Error('anthropic-messages: message 不是对象')
        return { role: str(m.role) as Role, content: parseContent(m.content) }
      }),
      stream: w.stream === true,
    }
    const system = parseSystem(w.system)
    if (system) req.system = system
    const maxTokens = num(w.max_tokens)
    if (maxTokens) req.maxTokens = maxTokens
    if (w.temperature !== undefined) req.temperature = num(w.temperature)
    if (w.top_p !== undefined) req.topP = num(w.top_p)
    const stops = arr(w.stop_sequences).map((s) => str(s))
    if (stops.length) req.stopSequences = stops
    const tools = arr(w.tools).map((t) => {
      if (!isObj(t)) throw new Error('anthropic-messages: tool 不是对象')
      const def: ToolDef = { name: str(t.name), inputSchema: t.input_schema ?? null }
      const desc = nonEmpty(str(t.description))
      if (desc !== undefined) def.description = desc
      return def
    })
    if (tools.length) req.tools = tools
    if (isObj(w.tool_choice)) {
      req.toolChoice = { mode: str(w.tool_choice.type) as ToolChoiceMode, name: nonEmpty(str(w.tool_choice.name)) }
    }
    return req
  }

  serializeResponse(resp: IrResponse): Uint8Array {
    return jsonBytes({
      id: resp.id ?? '',
      type: 'message',
      role: 'assistant',
      model: resp.model ?? '',
      content: resp.content.map(inBlockToWire),
      stop_reason: resp.stopReason || undefined, // omitempty
      stop_sequence: null, // 协议形态：恒为显式 null
      usage: usageToWire(resp.usage) ?? {},
    })
  }

  // 完整 SSE 帧："event: <type>\ndata: <json>\n\n"，data 内 type 与 event 名一致（W2 契约 §4）。
  serializeEvent(ev: StreamEvent): Uint8Array {
    return enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(inEventData(ev))}\n\n`)
  }

  serializeError(e: { type: string; message: string }): Uint8Array {
    return jsonBytes(errorWire(e.type, e.message))
  }
}

function errorWire(type: string, message: string): Obj {
  return { type: 'error', error: { type, message } }
}

// ---- 入站解析：client wire → IR ----

function parseSystem(raw: unknown): Block[] | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === 'string') {
    if (raw === '') return undefined
    return [{ type: 'text', text: nonEmpty(raw) }]
  }
  const out = arr(raw).map((wb) => {
    if (!isObj(wb)) throw new Error('anthropic-messages: system 块不是对象')
    return parseBlock(wb)
  })
  for (const b of out) {
    if (b.type !== 'text') {
      throw new Error(`anthropic-messages: system 仅支持 text 块，得到 ${b.type}`)
    }
  }
  return out.length ? out : undefined
}

// 消息 content：string 或块数组。
function parseContent(raw: unknown): Block[] {
  if (typeof raw === 'string') return [{ type: 'text', text: nonEmpty(raw) }]
  if (Array.isArray(raw)) {
    return raw.map((wb) => {
      if (!isObj(wb)) throw new Error('anthropic-messages: content 块不是对象')
      return parseBlock(wb)
    })
  }
  throw new Error('anthropic-messages: content 不是字符串或块数组')
}

// tool_result 的 content：string、块数组或缺省。
function parseToolResultContent(raw: unknown): Block[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string') return [{ type: 'text', text: nonEmpty(raw) }]
  if (Array.isArray(raw)) {
    const out = raw.map((wb) => {
      if (!isObj(wb)) throw new Error('anthropic-messages: tool_result content 块不是对象')
      return parseBlock(wb)
    })
    return out.length ? out : undefined
  }
  throw new Error('anthropic-messages: tool_result content 不是字符串或块数组')
}

function parseBlock(w: Obj): Block {
  switch (str(w.type)) {
    case 'text':
      return { type: 'text', text: nonEmpty(str(w.text)) }
    case 'thinking': // wire 字段名与 IR 不同
      return { type: 'thinking', text: nonEmpty(str(w.thinking)) }
    case 'image': {
      if (!isObj(w.source)) throw new Error('anthropic-messages: image 块缺少 source')
      return { type: 'image', imageSource: parseImageSource(w.source) }
    }
    case 'tool_use':
      // input 恒为对象形态（null/缺省 → {}）
      return {
        type: 'tool_use',
        id: nonEmpty(str(w.id)),
        name: nonEmpty(str(w.name)),
        input: w.input ?? {},
      }
    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: nonEmpty(str(w.tool_use_id)),
        isError: w.is_error === true || undefined,
        content: parseToolResultContent(w.content),
      }
    default:
      throw new Error(`anthropic-messages: 未知内容块类型 ${JSON.stringify(str(w.type))}`)
  }
}

function parseImageSource(s: Obj): ImageSource {
  switch (str(s.type)) {
    case 'base64':
      return { kind: 'base64', mediaType: nonEmpty(str(s.media_type)), data: str(s.data) }
    case 'url':
      return { kind: 'url', data: str(s.url) }
    default:
      throw new Error(`anthropic-messages: 未知图片来源 ${JSON.stringify(str(s.type))}`)
  }
}

// ---- 入站序列化：IR → client wire ----

// usage 是 wire 侧用量；accuracy 是 IR 内部记账词汇，不上 wire。全字段 omitempty。
function usageToWire(u: Usage | undefined): Obj | undefined {
  if (!u) return undefined
  return {
    input_tokens: u.inputTokens || undefined,
    output_tokens: u.outputTokens || undefined,
    cache_read_input_tokens: u.cacheReadTokens || undefined,
    cache_creation_input_tokens: u.cacheCreationTokens || undefined,
  }
}

// text 块恒带 text 字段（含空串）、tool_use 恒带 input 对象——与上游真实形态一致。
function inBlockToWire(b: Block): unknown {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text ?? '' }
    case 'thinking':
      return { type: 'thinking', thinking: b.text ?? '' }
    case 'image':
      return { type: 'image', source: b.imageSource ? inImageSourceToWire(b.imageSource) : null }
    case 'tool_use':
      return { type: 'tool_use', id: b.id ?? '', name: b.name ?? '', input: b.input ?? {} }
    case 'tool_result': {
      const content = (b.content ?? []).map(inBlockToWire)
      return {
        type: 'tool_result',
        tool_use_id: b.toolUseId ?? '',
        content: content.length ? content : undefined, // omitempty
        is_error: b.isError || undefined, // omitempty
      }
    }
    default:
      return { type: b.type }
  }
}

function inImageSourceToWire(s: ImageSource): Obj {
  if (s.kind === 'base64') {
    return { type: 'base64', media_type: s.mediaType || undefined, data: s.data }
  }
  return { type: 'url', url: s.data }
}

function inEventData(ev: StreamEvent): Obj {
  switch (ev.type) {
    case 'message_start':
      return {
        type: 'message_start',
        message: {
          id: ev.id ?? '',
          type: 'message',
          role: 'assistant',
          model: ev.model ?? '',
          content: [],
          usage: usageToWire(ev.usage), // omitempty
        },
      }
    case 'content_block_start': {
      if (!ev.block) throw new Error('anthropic-messages: content_block_start 缺少 block')
      return { type: 'content_block_start', index: ev.index ?? 0, content_block: inBlockToWire(ev.block) }
    }
    case 'content_block_delta': {
      if (!ev.delta) throw new Error('anthropic-messages: content_block_delta 缺少 delta')
      return { type: 'content_block_delta', index: ev.index ?? 0, delta: inDeltaToWire(ev.delta) }
    }
    case 'content_block_stop':
      return { type: 'content_block_stop', index: ev.index ?? 0 }
    case 'message_delta':
      return {
        type: 'message_delta',
        delta: { stop_reason: ev.stopReason || undefined, stop_sequence: null }, // stop_sequence 恒为显式 null
        usage: usageToWire(ev.usage), // omitempty
      }
    case 'message_stop':
      return { type: 'message_stop' }
    case 'ping':
      return { type: 'ping' }
    case 'error': {
      if (!ev.error) throw new Error('anthropic-messages: error 事件缺少 error 载荷')
      return errorWire(ev.error.type, ev.error.message)
    }
    default:
      throw new Error(`anthropic-messages: 未知流事件类型 ${JSON.stringify(ev.type)}`)
  }
}

function inDeltaToWire(d: Delta): Obj {
  switch (d.kind) {
    case 'text':
      return { type: 'text_delta', text: d.text ?? '' }
    case 'thinking':
      return { type: 'thinking_delta', thinking: d.text ?? '' }
    case 'tool_json':
      return { type: 'input_json_delta', partial_json: d.partialJson ?? '' }
    default:
      return { type: d.kind }
  }
}

// ---- 出站（IR ↔ 上游 wire）----

export function newOutbound(): OutboundCodec {
  return new OutCodec()
}

class OutCodec implements OutboundCodec {
  readonly protocol = 'anthropic-messages'

  // baseURL 约定停在域名根（不含 /v1），路径由本方法给出（坑位 #2）。
  requestPath(): string {
    return '/v1/messages'
  }

  serializeRequest(req: IrRequest): Uint8Array {
    const w: Obj = {
      model: req.model,
      max_tokens: (req.maxTokens ?? 0) <= 0 ? 4096 : req.maxTokens, // Anthropic API 必填（W2 契约 §8）
      messages: req.messages.map(outMessageToWire),
    }
    const system = (req.system ?? []).map(outBlockToWire)
    if (system.length) w.system = system // 统一输出块数组（W2 契约 §1），omitempty
    if (req.temperature !== undefined) w.temperature = req.temperature
    if (req.topP !== undefined) w.top_p = req.topP
    if (req.stopSequences?.length) w.stop_sequences = req.stopSequences
    if (req.stream) w.stream = true // stream:false 时省略 stream 字段（W2 契约 §8）
    if (req.tools?.length) {
      w.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description || undefined, // omitempty
        input_schema: t.inputSchema,
      }))
    }
    if (req.toolChoice) {
      w.tool_choice = {
        type: req.toolChoice.mode,
        name: req.toolChoice.name || undefined, // omitempty
      }
    }
    return jsonBytes(w)
  }

  parseResponse(body: Uint8Array): IrResponse {
    const w = parseJSON('响应', body)
    if (!isObj(w)) throw new Error('anthropic-messages: 响应不是 JSON 对象')
    const content = arr(w.content).map((wb) => {
      if (!isObj(wb)) throw new Error('anthropic-messages: content 块不是对象')
      return outBlockFromWire(wb)
    })
    return {
      id: nonEmpty(str(w.id)),
      model: nonEmpty(str(w.model)),
      content,
      stopReason: nonEmpty(str(w.stop_reason)) as StopReason | undefined,
      // 上游明示 usage → exact（W2 契约 §6）；缺 usage → unknown
      usage: isObj(w.usage) ? usageFromWire(w.usage) : { outputTokens: 0, accuracy: 'unknown' },
    }
  }

  newStreamParser(): StreamParser {
    return new OutStreamParser()
  }
}

// 单 text 块输出 string，否则块数组（W2 契约 §10）。
function outMessageToWire(m: Message): Obj {
  if (m.content.length === 1 && m.content[0]!.type === 'text') {
    return { role: m.role, content: m.content[0]!.text ?? '' }
  }
  return { role: m.role, content: m.content.map(outBlockToWire) }
}

function outBlockToWire(b: Block): unknown {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text || undefined } // omitempty
    case 'thinking':
      return { type: 'thinking', thinking: b.text || undefined } // wire 字段名与 IR 不同
    case 'image':
      return { type: 'image', source: b.imageSource ? outImageSourceToWire(b.imageSource) : undefined }
    case 'tool_use':
      // input 恒为对象（null/缺省 → {}），且 tool_use 的 input 不省略
      return {
        type: 'tool_use',
        id: b.id || undefined,
        name: b.name || undefined,
        input: b.input ?? {},
      }
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: b.toolUseId || undefined,
        is_error: b.isError || undefined,
        content: b.content?.length ? b.content.map(outBlockToWire) : undefined,
      }
    default:
      throw new Error(`anthropic-messages: 未知内容块类型 ${JSON.stringify(b.type)}`)
  }
}

function outImageSourceToWire(s: ImageSource): Obj {
  if (s.kind === 'url') {
    return { type: 'url', url: s.data || undefined }
  }
  return { type: 'base64', media_type: s.mediaType || undefined, data: s.data || undefined }
}

// 缓存两项映射到 IR 独立字段，绝不混入 InputTokens（硬约束）；上游明示 usage → exact。
function usageFromWire(u: Obj): Usage {
  return {
    inputTokens: num(u.input_tokens) || undefined,
    outputTokens: num(u.output_tokens) ?? 0,
    cacheReadTokens: num(u.cache_read_input_tokens) || undefined,
    cacheCreationTokens: num(u.cache_creation_input_tokens) || undefined,
    accuracy: 'exact',
  }
}

// wire 块转回 IR（响应 content 与流式 content_block 共用）。
function outBlockFromWire(w: Obj): Block {
  switch (str(w.type)) {
    case 'text':
      return { type: 'text', text: nonEmpty(str(w.text)) }
    case 'thinking':
      return { type: 'thinking', text: nonEmpty(str(w.thinking)) }
    case 'image': {
      if (!isObj(w.source)) throw new Error('anthropic-messages: image 块缺少 source')
      return { type: 'image', imageSource: imageSourceFromWire(w.source) }
    }
    case 'tool_use':
      // wire input 为 {} / null / 缺省时 IR 省略（Block.Input omitempty），其余对象原样保留
      return {
        type: 'tool_use',
        id: nonEmpty(str(w.id)),
        name: nonEmpty(str(w.name)),
        input: objectOrNil(w.input),
      }
    case 'tool_result': {
      const content = arr(w.content).map((c) => {
        if (!isObj(c)) throw new Error('anthropic-messages: tool_result content 块不是对象')
        return outBlockFromWire(c)
      })
      return {
        type: 'tool_result',
        toolUseId: nonEmpty(str(w.tool_use_id)),
        isError: w.is_error === true || undefined,
        content: content.length ? content : undefined,
      }
    }
    default:
      throw new Error(`anthropic-messages: 未知内容块类型 ${JSON.stringify(str(w.type))}`)
  }
}

function imageSourceFromWire(s: Obj): ImageSource {
  if (str(s.type) === 'url') {
    return { kind: 'url', data: str(s.url) }
  }
  return { kind: 'base64', mediaType: nonEmpty(str(s.media_type)), data: str(s.data) }
}

// tool_use.input 三态归一：null/undefined/{} 一律视为“无输入”（IR 侧省略），
// 其余对象原样保留。wire 侧恒为对象（缺省补 {}），IR 侧用 undefined 表省略。
function objectOrNil(v: unknown): unknown {
  if (v === null || v === undefined) return undefined
  if (isObj(v) && Object.keys(v).length === 0) return undefined
  return v
}

// ---- 出站流解析：上游 SSE → IR 事件流 ----

// 有状态的 SSE 解析器。上游字节块边界任意（含 UTF-8 多字节字符被截断），
// Feed 先缓冲半行；每个完整帧（event: X + data: Y + 空行）产出至多一个 IR 事件，
// ping 等容忍跳过。流中的协议错误以 error 事件产出（透传，不触发换源）。
class OutStreamParser implements StreamParser {
  private readonly dec = new TextDecoder()
  private buf = '' // 半行缓冲
  private event = '' // 当前帧 event 名
  private data: string[] = [] // 多 data: 行按 \n 拼接（SSE 规范）
  private raw = '' // 原始体累积（仅用于「全流无事件」时的 200+JSON 错误体回溯）
  private emitted = 0 // 已产出事件数

  feed(chunk: Uint8Array): StreamEvent[] {
    this.buf += this.dec.decode(chunk, { stream: true }) // 流式解码，容忍多字节字符跨块
    const evs: StreamEvent[] = []
    for (;;) {
      const i = this.buf.indexOf('\n')
      if (i < 0) break
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      this.raw += line + '\n'
      const ev = this.line(line)
      if (ev) evs.push(ev)
    }
    this.emitted += evs.length
    return evs
  }

  finish(): StreamEvent[] {
    const evs: StreamEvent[] = []
    if (this.buf !== '') {
      // EOF 时冲掉无换行的最后一行
      const line = this.buf
      this.buf = ''
      this.raw += line
      const ev = this.line(line)
      if (ev) evs.push(ev)
    }
    const ev = this.dispatch()
    if (ev) evs.push(ev)
    evs.push(...this.bareJsonError())
    this.emitted += evs.length
    return evs
  }

  // 上游对错误偶尔返回 HTTP 200 + 裸 JSON 错误体（非 SSE；实测 zcode 余额不足 1113）。
  // 此时闸门已过不可换源，唯一的正确动作是把错误透传给 client——空流比报错更糟。
  // 仅当全流一个事件都没产出时才回溯原始体，正常 SSE 不受影响。
  private bareJsonError(): StreamEvent[] {
    if (this.emitted > 0) return []
    const text = (this.raw + this.buf).trim()
    if (text === '' || !text.startsWith('{')) return []
    try {
      const obj = JSON.parse(text) as { type?: string; error?: { type?: string; message?: string } }
      if (obj.type !== 'error' || !obj.error) return []
      return [{ type: 'error', error: irError(obj.error.type ?? ERR.API, obj.error.message ?? '') }]
    } catch {
      return []
    }
  }

  // 处理一行：event:/data: 记账，空行触发出帧，注释与未知行忽略。
  private line(line: string): StreamEvent | null {
    const l = line.endsWith('\r') ? line.slice(0, -1) : line
    if (l === '') return this.dispatch()
    if (l.startsWith('event:')) {
      this.event = l.slice('event:'.length).trim()
    } else if (l.startsWith('data:')) {
      const d = l.slice('data:'.length)
      this.data.push(d.startsWith(' ') ? d.slice(1) : d) // SSE 规范：去一个前导空格
    }
    return null // 注释（: keep-alive）等，忽略
  }

  // 消费当前帧，产出至多一个 IR 事件。Feed 不抛流中错误：
  // 坏帧/协议错误以 IR error 事件透传（不触发换源）。
  private dispatch(): StreamEvent | null {
    const name = this.event
    const data = this.data.join('\n').trim()
    this.event = ''
    this.data = []
    if (data === '') return null
    let f: Obj
    try {
      const parsed: unknown = JSON.parse(data)
      if (!isObj(parsed)) throw new Error('不是 JSON 对象')
      f = parsed
    } catch (e) {
      return outErrorEvent(`SSE data 非法 JSON: ${e instanceof Error ? e.message : String(e)}`)
    }
    const type = name !== '' ? name : str(f.type) // 无 event: 行时以 data 内 type 为准
    switch (type) {
      case 'message_start': {
        const m = isObj(f.message) ? f.message : {}
        const ev: StreamEvent = { type: 'message_start', id: nonEmpty(str(m.id)), model: nonEmpty(str(m.model)) }
        // 输入侧用量（含缓存）；anthropic 无 created 时间戳，不设 created
        if (isObj(m.usage)) ev.usage = usageFromWire(m.usage)
        return ev
      }
      case 'content_block_start': {
        const wb = isObj(f.content_block) ? f.content_block : {}
        return { type: 'content_block_start', index: wireIndex(f.index), block: outBlockFromWire(wb) }
      }
      case 'content_block_delta': {
        const d = isObj(f.delta) ? f.delta : {}
        let delta: Delta
        switch (str(d.type)) {
          case 'text_delta':
            delta = { kind: 'text', text: str(d.text) || undefined }
            break
          case 'thinking_delta':
            delta = { kind: 'thinking', text: str(d.thinking) || undefined }
            break
          case 'input_json_delta':
            delta = { kind: 'tool_json', partialJson: str(d.partial_json) || undefined }
            break
          default:
            return null // 未知增量（如 signature_delta）容忍跳过
        }
        return { type: 'content_block_delta', index: wireIndex(f.index), delta }
      }
      case 'content_block_stop':
        return { type: 'content_block_stop', index: wireIndex(f.index) }
      case 'message_delta': {
        const md = isObj(f.delta) ? f.delta : {}
        const ev: StreamEvent = { type: 'message_delta', stopReason: nonEmpty(str(md.stop_reason)) as StopReason | undefined }
        if (isObj(f.usage)) ev.usage = usageFromWire(f.usage) // 输出侧用量
        return ev
      }
      case 'message_stop':
        return { type: 'message_stop' }
      case 'error': {
        if (isObj(f.error)) {
          return { type: 'error', error: irError(str(f.error.type), str(f.error.message)) }
        }
        return { type: 'error', error: irError(ERR.API, 'anthropic-messages: error 事件缺少载荷') }
      }
      default:
        return null // ping 等未知事件容忍跳过（W2 契约）
    }
  }
}

// index omitempty：0 省略（对齐 Go StreamEvent.Index）。
function wireIndex(v: unknown): number | undefined {
  return typeof v === 'number' && v !== 0 ? v : undefined
}

function outErrorEvent(msg: string): StreamEvent {
  return { type: 'error', error: irError(ERR.API, `anthropic-messages: ${msg}`) }
}

// 注册表登记（对齐 Go init()）。
registerInbound(() => newInbound())
registerOutbound(newOutbound())
