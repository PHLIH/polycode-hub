// openai-responses（OpenAI Responses API）编解码器：
//   入站（客户端 wire ↔ IR）：对齐 internal/codec/openairesponses/inbound.go
//   出站（IR ↔ 上游协议）：对齐 internal/codec/openairesponses/outbound.go
//
// 移植约定：
//   - Go 的 json tag 字段名逐字保留；Go omitempty 字段在 TS 用 undefined 表达
//     （JSON.stringify 自动省略，含 index 0 / 空串 / 0 值）。
//   - Go json.RawMessage 在 IR 中已是 parse 后的值（Block.input / ToolDef.inputSchema），
//     「紧凑化」即 JSON.stringify；「parse 字符串形态」即 JSON.parse + 形态校验。
//   - 非流式路径与流式路径的 usage 帧形态各自独立（对齐 Go inUsageWire / inStreamUsageWire）。
//   - 流中协议错误以 error 事件透传（不触发换源，换源闸门硬约束）。

import {
  ERR,
  irError,
  registerInbound,
  registerOutbound,
  type Block,
  type BlockType,
  type ImageSource,
  type InboundCodec,
  type IrError,
  type IrRequest,
  type IrResponse,
  type Message,
  type OutboundCodec,
  type StreamEvent,
  type StreamParser,
  type StopReason,
  type ToolChoice,
  type Usage,
  normalizeUsageSem,
} from '../ir/index.ts'

const PROTOCOL = 'openai-responses'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// 解析失败的规范形态：抛出携带 IrError 的异常（对齐 Go 返回 *ir.Error），
// gateway 据此映射 client 可见的错误响应。
export class CodecError extends Error {
  readonly ir: IrError
  constructor(ir: IrError) {
    super(`${ir.type}: ${ir.message}`)
    this.ir = ir
  }
}

function invalidRequest(message: string): CodecError {
  return new CodecError(irError(ERR.INVALID_REQUEST, message))
}

// ---- 宽松取值助手（SSE / 上游 JSON 形态防御；unknown + 收窄，不用 any） ----

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function optNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

// Go strings.TrimSuffix(x, "_error")。
function errorCode(type: string): string {
  return type.endsWith('_error') ? type.slice(0, -'_error'.length) : type
}

// Go json:"index,omitempty"：index 0 在 JSON 中省略，TS 以 undefined 表达。
function idxField(n: number): number | undefined {
  return n === 0 ? undefined : n
}

// IR 对象形态 Input → responses 的 arguments 紧凑 JSON 字符串（对齐 Go inCompactString）。
function compactJSON(v: unknown): string {
  return v === undefined ? '' : JSON.stringify(v)
}

// 拼接 text 块文本（system → instructions / tool_result content 用）。
// 逐语义对齐 Go outJoinTexts：分隔符只在前缀非空时插入。
function joinTexts(blocks: Block[] | undefined): string {
  let out = ''
  for (const b of blocks ?? []) {
    if (b.type !== 'text') continue
    if (out.length > 0) out += '\n'
    out += b.text ?? ''
  }
  return out
}

// responses 状态 → IR stopReason：含 function_call 即 tool_use；
// incomplete 且 reason max_output_tokens → max_tokens；其余 end_turn（对齐 Go outStopReason）。
function stopReason(status: string, incompleteReason: string, sawCall: boolean): StopReason {
  if (sawCall) return 'tool_use'
  if (status === 'incomplete' && incompleteReason === 'max_output_tokens') return 'max_tokens'
  return 'end_turn'
}

// responses usage → IR Usage。cached_tokens 进独立 cacheReadTokens（绝不混入
// inputTokens）；reasoning_tokens → ReasoningTokens。全零且无明细视为未提供，返回
// undefined（对齐 Go outUsageOf）。
// 明细输出规则：任一明细 >0 才输出 details（含 reasoning_tokens 顺带显式 0，
// 见 response.basic 夹具形态）；三者全零则整个 details 省略。
// 缓存写入同 openai-completions：标准未定义，部分上游在顶层给
// cache_creation_input_tokens / prompt_cache_write_tokens / prompt_cache_miss_tokens。
function usageOf(w: Record<string, unknown>): Usage | undefined {
  const input = asNumber(w['input_tokens'])
  const output = asNumber(w['output_tokens'])
  const total = asNumber(w['total_tokens'])
  const inDetails = w['input_tokens_details'] == null ? null : asRecord(w['input_tokens_details'])
  const outDetails = w['output_tokens_details'] == null ? null : asRecord(w['output_tokens_details'])
  // 全零与否看「实际计数」而非 details 是否存在：有的上游带了空的
  // output_tokens_details（如 reasoning_tokens:0 占位）却所有计数都是 0。
  // 旧判据此时放行并把 accuracy 拔高为 exact，而下游 mergeStreamUsage 用
  // accuracyWorst 取最差档——先写入 exact 就再也降不回去了。
  const cached = inDetails !== null ? asNumber(inDetails['cached_tokens']) : 0
  const reasoning = outDetails !== null ? asNumber(outDetails['reasoning_tokens']) : 0
  if (input === 0 && output === 0 && total === 0 && cached === 0 && reasoning === 0) {
    return undefined
  }
  const u: Usage = { inputTokens: input || undefined, outputTokens: output, accuracy: 'exact' }
  if (cached !== 0) u.cacheReadTokens = cached
  if (reasoning !== 0) u.reasoningTokens = reasoning
  // 同 openai-completions：取第一个 >0 的值，不用 ||
  // （上游会把不支持的字段填 0 占位，短路会读不到真正有值的那个）。
  const write = [w['cache_creation_input_tokens'], w['prompt_cache_write_tokens'], w['prompt_cache_miss_tokens']]
    .map((v) => asNumber(v))
    .find((v) => v > 0)
  if (write !== undefined) u.cacheCreationTokens = write
  u.sem = 'subset' // openai 系 wire：input 已含 cached（CACHE-SEMANTICS）
  return u
}

// function_call 的 arguments JSON 字符串 → IR 对象形态（Block.Input 约定为对象）。
// 空串 → undefined（对齐 Go inParseArgs 返回 nil raw）。
function parseArgs(s: string): unknown {
  if (s.trim() === '') return undefined
  let v: unknown
  try {
    v = JSON.parse(s)
  } catch (e) {
    throw invalidRequest(`function_call.arguments 不是合法 JSON: ${(e as Error).message}`)
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw invalidRequest('function_call.arguments 必须是 JSON 对象')
  }
  return v
}

// input_image.image_url：data URI 重组为 base64 来源，其余按 URL（对齐 Go inParseImage）。
function parseImage(u: string): Block {
  if (u.startsWith('data:')) {
    const rest = u.slice('data:'.length)
    const mark = ';base64,'
    const semi = rest.indexOf(mark)
    if (semi < 0) {
      throw invalidRequest('input_image data URI 缺少 ;base64, 标记')
    }
    return {
      type: 'image',
      imageSource: {
        kind: 'base64',
        mediaType: rest.slice(0, semi) || undefined,
        data: rest.slice(semi + mark.length),
      },
    }
  }
  return { type: 'image', imageSource: { kind: 'url', data: u } }
}

// IR 图片来源 → input_image.image_url（base64 重组为 data URI，对齐 Go outImageURL）。
function imageURL(s: ImageSource): string {
  if (s.kind === 'base64') return `data:${s.mediaType ?? ''};base64,${s.data}`
  return s.data
}

// 产出完整 SSE 帧："event: <name>\ndata: <json>\n\n"（对齐 Go inFrame）。
function frame(event: string, payload: unknown): Uint8Array {
  return textEncoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
}

// ---- 入站：客户端 responses wire ↔ IR（对齐 inbound.go，流式状态机见 InboundCodec） ----

export function newInbound(): InboundCodec {
  return new Inbound()
}

// 流式状态：response.completed 需要聚合 message_start（输入用量）与
// message_delta（输出用量），output_item.done 必须重放整块文本/参数，边序列化边累积。
class Inbound implements InboundCodec {
  readonly protocol = PROTOCOL

  private id = ''
  private model = ''
  private created = 0
  private items = new Map<number, InOpenItem>() // IR 块 index → 开启中的输出项
  private msgN = 0 // msg_N 编号器（每条流在 message_start 重置）
  private fcN = 0 // fc_N 编号器
  private startUsage: Usage | undefined // message_start 携带的输入用量
  private deltaUsage: Usage | undefined // message_delta 携带的最终用量

  parseRequest(body: Uint8Array): IrRequest {
    let w: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(textDecoder.decode(body))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object')
      }
      w = parsed as Record<string, unknown>
    } catch (e) {
      throw invalidRequest(`请求体不是合法 JSON: ${(e as Error).message}`)
    }
    const req: IrRequest = {
      model: asString(w['model']),
      messages: [],
      maxTokens: asNumber(w['max_output_tokens']) || undefined,
      temperature: optNumber(w['temperature']),
      topP: optNumber(w['top_p']),
      stream: w['stream'] === true,
    }
    const instructions = asString(w['instructions'])
    if (instructions !== '') {
      req.system = [{ type: 'text', text: instructions }]
    }
    req.messages = parseInput(w['input'])
    for (const raw of asArray(w['tools'])) {
      const t = asRecord(raw)
      const tt = asString(t['type'])
      if (tt !== '' && tt !== 'function') {
        continue // 容忍：仅提取 IR 已有的 function 工具
      }
      ;(req.tools ??= []).push({
        name: asString(t['name']),
        description: asString(t['description']) || undefined,
        inputSchema: t['parameters'] ?? null,
      })
    }
    if (w['tool_choice'] !== undefined && w['tool_choice'] !== null) {
      req.toolChoice = parseToolChoice(w['tool_choice'])
    }
    // 推理强度：Responses 标准形态 reasoning: {effort}，另容错顶层 reasoning_effort /
    // reasoningEffort / reasoning 字符串 / output_config.effort（跨协议误发）。
    const effort = parseReasoningEffort(w)
    if (effort !== undefined) req.reasoningEffort = effort
    return req
  }

  serializeResponse(r: IrResponse): Uint8Array {
    const wire: Record<string, unknown> = {
      id: r.id || undefined,
      object: 'response',
      created: r.created || undefined,
      model: r.model || undefined,
      status: 'completed',
      output: [] as unknown[],
      usage: usageWire(r.usage),
    }
    const output = wire['output'] as unknown[]
    let msgN = 0
    let fcN = 0
    for (const b of r.content) {
      if (b.type === 'text') {
        msgN++
        output.push({
          type: 'message',
          id: `msg_${msgN}`,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: b.text ?? '' }],
        })
      } else if (b.type === 'tool_use') {
        fcN++
        output.push({
          type: 'function_call',
          id: `fc_${fcN}`,
          call_id: b.id || undefined,
          name: b.name || undefined,
          arguments: compactJSON(b.input) || undefined,
          status: 'completed',
        })
      } else {
        throw new Error(`openairesponses: 非流式响应不支持的内容块 ${b.type}`)
      }
    }
    return textEncoder.encode(JSON.stringify(wire))
  }

  // IR 流事件 → responses 具名 SSE 帧。帧形态：event: <type>\ndata: <json>\n\n，
  // data 内 type 与 event 名一致，无 [DONE]。message_delta 只暂存，由 message_stop
  // 产出 response.completed。
  serializeEvent(ev: StreamEvent): Uint8Array {
    switch (ev.type) {
      case 'message_start': {
        this.reset()
        this.id = ev.id ?? ''
        this.model = ev.model ?? ''
        this.created = ev.created ?? 0
        if (ev.usage) {
          this.startUsage = ev.usage
        }
        return frame('response.created', {
          type: 'response.created',
          response: {
            id: ev.id ?? '',
            model: ev.model ?? '',
            created: ev.created ?? 0,
            status: 'in_progress',
          },
        })
      }

      case 'content_block_start': {
        if (!ev.block) {
          throw new Error('openairesponses: content_block_start 缺少 block')
        }
        const index = ev.index ?? 0
        if (ev.block.type === 'text') {
          this.msgN++
          const id = `msg_${this.msgN}`
          this.items.set(index, { kind: 'message', id, buf: '' })
          return frame('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: index,
            // added 帧的 message 必须 content:[]（不能省略）
            item: { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] },
          })
        }
        if (ev.block.type === 'tool_use') {
          this.fcN++
          const id = `fc_${this.fcN}`
          this.items.set(index, {
            kind: 'function_call',
            id,
            callID: ev.block.id ?? '',
            name: ev.block.name ?? '',
            buf: '',
          })
          return frame('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: index,
            // function_call 必须 arguments:""（不能省略）
            item: {
              type: 'function_call',
              id,
              call_id: ev.block.id ?? '',
              name: ev.block.name ?? '',
              arguments: '',
              status: 'in_progress',
            },
          })
        }
        throw new Error(`openairesponses: 流不支持的内容块类型 ${ev.block.type}`)
      }

      case 'content_block_delta': {
        if (!ev.delta) {
          throw new Error('openairesponses: content_block_delta 缺少 delta')
        }
        const index = ev.index ?? 0
        const it = this.items.get(index)
        if (!it) {
          throw new Error(`openairesponses: index ${index} 无开启中的输出项`)
        }
        if (ev.delta.kind === 'text') {
          it.buf += ev.delta.text ?? ''
          return frame('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: it.id,
            output_index: index,
            content_index: 0,
            delta: ev.delta.text ?? '',
          })
        }
        if (ev.delta.kind === 'tool_json') {
          it.buf += ev.delta.partialJson ?? ''
          return frame('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: it.id,
            output_index: index,
            delta: ev.delta.partialJson ?? '',
          })
        }
        throw new Error(`openairesponses: 流不支持的增量类型 ${ev.delta.kind}`)
      }

      case 'content_block_stop': {
        const index = ev.index ?? 0
        const it = this.items.get(index)
        if (!it) {
          throw new Error(`openairesponses: index ${index} 无开启中的输出项`)
        }
        this.items.delete(index)
        if (it.kind === 'message') {
          return frame('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: index,
            item: {
              type: 'message',
              id: it.id,
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: it.buf }],
            },
          })
        }
        return frame('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: index,
          item: {
            type: 'function_call',
            id: it.id,
            call_id: it.callID,
            name: it.name,
            status: 'completed',
            arguments: it.buf,
          },
        })
      }

      case 'message_delta':
        this.deltaUsage = ev.usage
        return new Uint8Array(0) // 暂存 stopReason 与输出用量，无帧

      case 'message_stop': {
        const resp: Record<string, unknown> = {
          id: this.id,
          model: this.model,
          created: this.created,
          status: 'completed',
        }
        const u = this.mergedUsage()
        if (u) {
          resp['usage'] = streamUsageWire(u)
        }
        return frame('response.completed', { type: 'response.completed', response: resp })
      }

      case 'ping':
        return new Uint8Array(0) // responses 协议无 ping 帧

      case 'error': {
        if (!ev.error) {
          throw new Error('openairesponses: error 事件缺少错误信息')
        }
        return frame('error', {
          type: 'error',
          code: errorCode(ev.error.type),
          message: ev.error.message,
        })
      }

      default:
        throw new Error(`openairesponses: 未知流事件 ${(ev as { type: string }).type}`)
    }
  }

  serializeError(e: IrError): Uint8Array {
    return textEncoder.encode(
      JSON.stringify({ error: { message: e.message, type: e.type, code: errorCode(e.type) } }),
    )
  }

  // 重置流式状态（每条流的 message_start 处调用）。
  private reset(): void {
    this.items = new Map()
    this.msgN = 0
    this.fcN = 0
    this.startUsage = undefined
    this.deltaUsage = undefined
  }

  // 合并输入用量（message_start）与最终用量（message_delta），字段级最新优先。
  private mergedUsage(): Usage | undefined {
    let u: Usage | undefined
    if (this.startUsage) u = { ...this.startUsage }
    const d = this.deltaUsage
    if (d) {
      if (!u) u = { outputTokens: 0, accuracy: 'unknown' }
      if (d.inputTokens) u.inputTokens = d.inputTokens
      if (d.outputTokens) u.outputTokens = d.outputTokens
      if (d.cacheReadTokens) u.cacheReadTokens = d.cacheReadTokens
      if (d.cacheCreationTokens) u.cacheCreationTokens = d.cacheCreationTokens
      if (d.reasoningTokens) u.reasoningTokens = d.reasoningTokens
      if (d.accuracy) u.accuracy = d.accuracy
    }
    return u
  }
}

interface InOpenItem {
  kind: 'message' | 'function_call'
  id: string // msg_N / fc_N
  callID?: string // function_call 的 call_id（即 IR Block.ID）
  name?: string // function_call 的工具名
  buf: string // 累积的整块文本 / arguments
}

// 组装 responses 用量对象（非流式路径）。details 子对象仅在 IR 任一明细字段非零时
// 输出；reasoning_tokens 为 0 时也须显式输出（response.basic 夹具形态）。
function usageWire(u: Usage): Record<string, unknown> {
  // 语义归一（CACHE-SEMANTICS）：见 openaicompletions.wireUsage 注释。
  u = normalizeUsageSem(u, 'subset')
  const input = u.inputTokens ?? 0
  const output = u.outputTokens ?? 0
  const w: Record<string, unknown> = {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
  }
  if ((u.cacheReadTokens ?? 0) > 0 || (u.cacheCreationTokens ?? 0) > 0 || (u.reasoningTokens ?? 0) > 0) {
    w['input_tokens_details'] = { cached_tokens: u.cacheReadTokens ?? 0 }
    w['output_tokens_details'] = { reasoning_tokens: u.reasoningTokens ?? 0 }
  }
  return w
}

// response.completed 的用量：与非流式共用 serializeUsageWire（流式也不丢
// output_tokens_details——此前两函数高度重复，这里的 reasoning 回写就是这么
// 漏改的）。reasoning_tokens 为 0 时也显式输出（response.basic 夹具形态）：
 // 客户端按"key 存在"判定上游是否给了该字段，不输出会被读成"上游没说"。
function streamUsageWire(u: Usage): Record<string, unknown> {
  return serializeUsageWire(u, true)
}

// 两路径共用同一份 usage 序列化（唯一区别见参数注释：当前为零）。
function serializeUsageWire(u: Usage, _stream: boolean): Record<string, unknown> {
  u = normalizeUsageSem(u, 'subset')
  const input = u.inputTokens ?? 0
  const output = u.outputTokens ?? 0
  const w: Record<string, unknown> = {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
  }
  if ((u.cacheReadTokens ?? 0) > 0 || (u.cacheCreationTokens ?? 0) > 0 || (u.reasoningTokens ?? 0) > 0) {
    w['input_tokens_details'] = { cached_tokens: u.cacheReadTokens ?? 0 }
    w['output_tokens_details'] = { reasoning_tokens: u.reasoningTokens ?? 0 }
  }
  return w
}

function textMessage(role: Message['role'], text: string): Message {
  return { role, content: [{ type: 'text', text: text || undefined }] }
}

// input：字符串或 item 数组 → IR 消息（对齐 Go inParseInput）。
function parseInput(raw: unknown): Message[] {
  if (raw === undefined || raw === null) return []
  if (typeof raw === 'string') return [textMessage('user', raw)]
  if (!Array.isArray(raw)) {
    throw invalidRequest(`input 形态不合法（应为字符串或数组）: ${typeof raw}`)
  }
  const msgs: Message[] = []
  for (const item of raw) {
    const it = asRecord(item)
    switch (asString(it['type'])) {
      case 'function_call': {
        const input = parseArgs(asString(it['arguments']))
        msgs.push({
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: asString(it['call_id']) || undefined,
            name: asString(it['name']) || undefined,
            input,
          }],
        })
        break
      }
      case 'function_call_output': {
        const out = it['output']
        if (typeof out !== 'string') {
          throw invalidRequest('function_call_output.output 缺失或非字符串')
        }
        msgs.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            toolUseId: asString(it['call_id']) || undefined,
            content: [{ type: 'text', text: out || undefined }],
          }],
        })
        break
      }
      default: {
        // role 消息（type 为 "message" 或缺省）
        const role = asString(it['role']) === 'assistant' ? 'assistant' : 'user'
        msgs.push({ role, content: parseContent(it['content']) })
      }
    }
  }
  return msgs
}

// content：字符串或内容数组 → IR 块（对齐 Go inParseContent；容忍未知内容类型）。
function parseContent(raw: unknown): Block[] {
  if (raw === undefined || raw === null) return []
  if (typeof raw === 'string') return [{ type: 'text', text: raw || undefined }]
  if (!Array.isArray(raw)) {
    throw invalidRequest(`消息 content 形态不合法: ${typeof raw}`)
  }
  const blocks: Block[] = []
  for (const ci of raw) {
    const c = asRecord(ci)
    switch (asString(c['type'])) {
      case 'input_text':
      case 'output_text':
      case 'text':
        blocks.push({ type: 'text', text: asString(c['text']) || undefined })
        break
      case 'input_image':
        blocks.push(parseImage(asString(c['image_url'])))
        break
      default:
        // 容忍未知内容类型（契约只提取 IR 已有字段）
    }
  }
  return blocks
}

// tool_choice：字符串或对象 → IR ToolChoice（对齐 Go inParseToolChoice）。
function parseToolChoice(raw: unknown): ToolChoice {
  if (typeof raw === 'string') {
    switch (raw) {
      case 'auto':
        return { mode: 'auto' }
      case 'none':
        return { mode: 'none' }
      case 'required':
        return { mode: 'any' }
    }
    throw invalidRequest(`tool_choice 不支持: ${raw}`)
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>
    if (asString(o['type']) === 'function') {
      return { mode: 'tool', name: asString(o['name']) || undefined }
    }
    throw invalidRequest(`tool_choice 对象形态不支持 type: ${asString(o['type'])}`)
  }
  throw invalidRequest(`tool_choice 形态不合法: ${typeof raw}`)
}

// 推理强度：reasoning: {effort}（Responses 标准）为主，另容错 reasoning_effort /
// reasoningEffort / reasoning 字符串 / output_config.effort。原样透传不校验。
function parseReasoningEffort(w: Record<string, unknown>): string | undefined {
  const r = w['reasoning']
  if (typeof r === 'string' && r.trim() !== '') return r.trim()
  if (r !== null && typeof r === 'object' && !Array.isArray(r)) {
    const e = asString((r as Record<string, unknown>)['effort'])
    if (e.trim() !== '') return e.trim()
  }
  for (const k of ['reasoning_effort', 'reasoningEffort']) {
    const v = w[k]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  const oc = w['output_config']
  if (oc !== null && typeof oc === 'object' && !Array.isArray(oc)) {
    const e = asString((oc as Record<string, unknown>)['effort'])
    if (e.trim() !== '') return e.trim()
  }
  return undefined
}

function isOff(effort: string): boolean {
  const v = effort.trim().toLowerCase()
  return v === 'off' || v === 'none' || v === 'disabled' || v === 'disable'
}

// ---- 出站：IR ↔ openai-responses 上游（对齐 outbound.go） ----

export function newOutbound(): OutboundCodec {
  return new Outbound()
}

class Outbound implements OutboundCodec {
  readonly protocol = PROTOCOL

  // baseURL 已含 /v1（坑位 #2），操作路径为相对段。
  requestPath(): string {
    return 'responses'
  }

  // IR → 上游请求 body。
  // 注意：Responses 没有 stop_sequences 参数，IR 的 StopSequences 在此丢弃。
  // 注意：Responses 不需要 stream_options.include_usage（usage 在 response.completed
  // 里返回）——与 completions 的坑位 #1 不同，勿混用（fixture upstream-request.tools 锁定）。
  serializeRequest(req: IrRequest): Uint8Array {
    const tools = (req.tools ?? []).map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description ?? '',
      parameters: t.inputSchema ?? null,
    }))
    const input: unknown[] = []
    for (const m of req.messages) {
      input.push(...inputItems(m))
    }
    const wire: Record<string, unknown> = {
      model: req.model,
      instructions: joinTexts(req.system) || undefined,
      input,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: toolChoiceWire(req.toolChoice),
      // truncation: disabled 与真机对齐（2026-09-13 真机抓包回显）。
      // 上下文超限时不让上游自作主张截断（auto 会砍掉工具定义/历史导致模型
      // “看不见”工具）；超了就报错，调用方压缩或重开会话。
      // 兼容：老/兼容上游若报 400 且直指 truncation，调用方去字段重发一次
      // （见 router/upstream.ts streamWith 内的 truncation 回退 withoutTruncation）。
      truncation: 'disabled',
      max_output_tokens: req.maxTokens || undefined,
      temperature: req.temperature,
      top_p: req.topP,
      // 推理强度透传：Responses 标准形态 reasoning: {effort}；off 系关闭档省略即回上游默认。
      reasoning: req.reasoningEffort !== undefined && req.reasoningEffort.trim() !== '' && !isOff(req.reasoningEffort)
        ? { effort: req.reasoningEffort.trim() }
        : undefined,
      stream: req.stream || undefined,
    }
    return textEncoder.encode(JSON.stringify(wire))
  }

  // 上游响应 body → IR（对齐 Go ParseResponse；容忍未知输出项，reasoning 等不建模）。
  parseResponse(body: Uint8Array): IrResponse {
    let w: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(textDecoder.decode(body))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object')
      }
      w = parsed as Record<string, unknown>
    } catch (e) {
      throw new CodecError(irError(ERR.API, `上游响应不是合法 JSON: ${(e as Error).message}`))
    }
    const resp: IrResponse = {
      id: asString(w['id']) || undefined,
      model: asString(w['model']) || undefined,
      created: asNumber(w['created']) || undefined,
      content: [],
      usage: { outputTokens: 0, accuracy: 'unknown' },
    }
    let sawCall = false
    for (const raw of asArray(w['output'])) {
      const it = asRecord(raw)
      switch (asString(it['type'])) {
        case 'function_call': {
          // call_id → IR Block.ID；arguments 字符串 → Input 对象
          resp.content.push({
            type: 'tool_use',
            id: asString(it['call_id']) || undefined,
            name: asString(it['name']) || undefined,
            input: parseArgs(asString(it['arguments'])),
          })
          sawCall = true
          break
        }
        case 'message': {
          for (const rawCP of asArray(it['content'])) {
            const cp = asRecord(rawCP)
            const ct = asString(cp['type'])
            if (ct === 'output_text' || ct === 'text') {
              resp.content.push({ type: 'text', text: asString(cp['text']) || undefined })
            }
          }
          break
        }
        default:
          // 容忍未知输出项（reasoning 等 P0 不建模）
      }
    }
    const inc = w['incomplete_details'] == null ? null : asRecord(w['incomplete_details'])
    resp.stopReason = stopReason(asString(w['status']), inc === null ? '' : asString(inc['reason']), sawCall)
    const u = usageOf(asRecord(w['usage']))
    if (u) resp.usage = u
    return resp
  }

  // 有状态的具名 SSE 解析器（对齐 Go outStreamParser）：response.created →
  // message_start；output_item.added → 开块（function_call 先关当前开块）；delta →
  // 惰性开块 + 增量；output_item.done → 关块；response.completed → message_delta +
  // message_stop。自行缓冲半行（上游字节块边界任意）。
  newStreamParser(): StreamParser {
    return new ResponsesStreamParser()
  }
}

// 一条 IR 消息 → 1..N 个 input 项（对齐 Go outInputItems）：text/image 聚合成 role
// 消息项（content 恒为数组，单 text 块也不坍缩为字符串），tool_use 各成一个
// function_call 项，tool_result 各成一个 function_call_output 项。
function inputItems(m: Message): unknown[] {
  const items: unknown[] = []
  let parts: Record<string, unknown>[] = []
  const flush = (): void => {
    if (parts.length > 0) {
      items.push({ role: m.role, content: parts })
      parts = []
    }
  }
  // 文本块的 content type 由 role 决定（上游硬校验，实测 zen muse-spark 多轮）：
  //   assistant 历史必须是 output_text，写成 input_text 会被上游拒：
  //   "content type `input_text` is not valid on `assistant` message"
  // user/system 侧才是 input_text。
  const textType = m.role === 'assistant' ? 'output_text' : 'input_text'
  for (const b of m.content) {
    switch (b.type) {
      case 'text':
        parts.push({ type: textType, text: b.text || undefined })
        break
      case 'image':
        if (b.imageSource) {
          parts.push({ type: 'input_image', image_url: imageURL(b.imageSource) })
        }
        break
      case 'tool_use': {
        // 对象 Input → arguments JSON 字符串（紧凑化）
        flush()
        items.push({
          type: 'function_call',
          call_id: b.id || undefined,
          name: b.name || undefined,
          arguments: compactJSON(b.input) || undefined,
        })
        break
      }
      case 'tool_result':
        flush()
        items.push({
          type: 'function_call_output',
          call_id: b.toolUseId || undefined,
          output: joinTexts(b.content) || undefined,
        })
        break
      default:
        // thinking 等：responses 请求侧无对应形态，不处理（对齐 Go default）
    }
  }
  flush()
  return items
}

// IR → responses tool_choice（与入站解析对称，对齐 Go outToolChoice）。
function toolChoiceWire(tc: ToolChoice | undefined): unknown {
  if (!tc) return undefined
  switch (tc.mode) {
    case 'none':
      return 'none'
    case 'any':
      return 'required'
    case 'tool':
      return { type: 'function', name: tc.name ?? '' }
    default: // auto
      return 'auto'
  }
}

// 具名 SSE 流 → IR 事件流（对齐 Go outStreamParser 状态机）。
class ResponsesStreamParser implements StreamParser {
  private buf: Uint8Array = new Uint8Array(0) // 半行缓冲
  private event = '' // 当前帧的 event 名
  private data: string[] = []
  private closed = false // 已终结（completed/failed 后 Finish 不再补发）

  private next = 0 // 下一个 IR 块 index（= 已开启块数）
  private open = -1 // 当前开着的块 index；-1 无
  private items = new Map<number, number>() // output_index → IR 块 index
  private sawCall = false // 见过 function_call（completed 时 stopReason 取 tool_use）

  feed(chunk: Uint8Array): StreamEvent[] {
    const merged = new Uint8Array(this.buf.length + chunk.length)
    merged.set(this.buf)
    merged.set(chunk, this.buf.length)
    const evs: StreamEvent[] = []
    let start = 0
    for (let i = 0; i < merged.length; i++) {
      if (merged[i] === 0x0a) {
        evs.push(...this.line(textDecoder.decode(merged.subarray(start, i))))
        start = i + 1
      }
    }
    this.buf = merged.subarray(start)
    return evs
  }

  // 上游 EOF：先把残余半行按整行处理，再分发尚在等待空行的尾帧（上游未必以空行
  // 结尾），无 completed 则补发收尾事件。
  finish(): StreamEvent[] {
    const evs: StreamEvent[] = []
    if (this.buf.length > 0) {
      const line = textDecoder.decode(this.buf)
      this.buf = new Uint8Array(0)
      evs.push(...this.line(line))
    }
    evs.push(...this.dispatch())
    return evs.concat(this.close())
  }

  // 累积一帧的行；空行触发分发（对齐 Go outLine）。
  private line(raw: string): StreamEvent[] {
    if (this.closed) return []
    const line = raw.replace(/\r+$/, '')
    if (line === '') return this.dispatch()
    if (line.startsWith(':')) return [] // SSE 注释容忍
    if (line.startsWith('event:')) {
      this.event = line.slice('event:'.length).trim()
      return []
    }
    if (line.startsWith('data:')) {
      const v = line.slice('data:'.length)
      this.data.push(v.startsWith(' ') ? v.slice(1) : v)
      return []
    }
    return [] // 其他 SSE 字段容忍
  }

  // 分发攒满的一帧（对齐 Go outDispatch；无论是否分发都先清空当前帧）。
  private dispatch(): StreamEvent[] {
    const ev = this.event
    const data = this.data.join('\n')
    this.event = ''
    this.data = []
    if (this.closed || ev === '' || data.trim() === '') return []
    return this.frame(ev, data.trim())
  }

  private frame(ev: string, data: string): StreamEvent[] {
    let json: unknown
    try {
      json = JSON.parse(data)
    } catch (e) {
      return this.badChunk(e)
    }
    const f = asRecord(json)
    switch (ev) {
      case 'response.created': {
        const r = asRecord(f['response'])
        return [{
          type: 'message_start',
          id: asString(r['id']) || undefined,
          model: asString(r['model']) || undefined,
          created: asNumber(r['created']) || undefined,
        }]
      }

      case 'response.output_item.added':
        return this.openBlock(asNumber(f['output_index']), asRecord(f['item']))

      case 'response.output_text.delta': {
        const delta = asString(f['delta'])
        if (delta === '') return []
        const [idx, start] = this.ensure(asNumber(f['output_index']), 'text')
        return [...start, {
          type: 'content_block_delta',
          index: idxField(idx),
          delta: { kind: 'text', text: delta },
        }]
      }

      case 'response.function_call_arguments.delta': {
        const delta = asString(f['delta'])
        if (delta === '') return []
        this.sawCall = true
        const [idx, start] = this.ensure(asNumber(f['output_index']), 'tool_use')
        return [...start, {
          type: 'content_block_delta',
          index: idxField(idx),
          delta: { kind: 'tool_json', partialJson: delta },
        }]
      }

      case 'response.output_text.done':
        return [] // 容忍：done 的文本已由 delta 产出，不重复产事件

      case 'response.output_item.done': {
        const idx = this.items.get(asNumber(f['output_index']))
        if (idx !== undefined && idx === this.open) {
          const e = this.closeOpen()
          return e ? [e] : []
        }
        return []
      }

      case 'response.incomplete': {
        // 真实场景：reasoning 模型把 max_output_tokens 预算吃满 → incomplete（无文本）。
        // 必须如实映射 max_tokens 截断语义，不能落进默认 end_turn。
        const r = asRecord(f['response'])
        const inc = r['incomplete_details'] == null ? null : asRecord(r['incomplete_details'])
        const stop = stopReason(asString(r['status']) || 'incomplete', inc === null ? '' : asString(inc['reason']), this.sawCall)
        const usage = r['usage'] == null ? undefined : usageOf(asRecord(r['usage']))
        const evs: StreamEvent[] = []
        const e = this.closeOpen()
        if (e) evs.push(e)
        this.closed = true
        evs.push({ type: 'message_delta', stopReason: stop, usage })
        evs.push({ type: 'message_stop' })
        return evs
      }

      case 'response.completed': {
        const r = asRecord(f['response'])
        const inc = r['incomplete_details'] == null ? null : asRecord(r['incomplete_details'])
        const stop = stopReason(asString(r['status']), inc === null ? '' : asString(inc['reason']), this.sawCall)
        const usage = r['usage'] == null ? undefined : usageOf(asRecord(r['usage']))
        const evs: StreamEvent[] = []
        const e = this.closeOpen()
        if (e) evs.push(e)
        this.closed = true
        evs.push({ type: 'message_delta', stopReason: stop, usage })
        evs.push({ type: 'message_stop' })
        return evs
      }

      case 'response.failed': {
        const r = asRecord(f['response'])
        let msg = '上游响应失败'
        if (r['error'] != null) {
          const m = asString(asRecord(r['error'])['message'])
          if (m !== '') msg = m
        }
        this.closed = true
        return [{ type: 'error', error: { type: ERR.API, message: msg, httpStatus: 0 } }]
      }

      case 'error': {
        const msg = asString(f['message']) || '上游流错误'
        this.closed = true
        return [{ type: 'error', error: { type: ERR.API, message: msg, httpStatus: 0 } }]
      }

      default:
        return [] // 未知事件容忍
    }
  }

  // 开新块：先关当前开着的块；IR index = 已开启块数（对齐 Go outOpenBlock）。
  private openBlock(outputIndex: number, item: Record<string, unknown>): StreamEvent[] {
    const evs: StreamEvent[] = []
    const e = this.closeOpen()
    if (e) evs.push(e)
    const idx = this.next++
    this.items.set(outputIndex, idx)
    switch (asString(item['type'])) {
      case 'function_call':
        this.sawCall = true
        this.open = idx
        return [...evs, {
          type: 'content_block_start',
          index: idxField(idx),
          block: {
            type: 'tool_use',
            id: asString(item['call_id']) || undefined,
            name: asString(item['name']) || undefined,
          },
        }]
      case 'message':
        this.open = idx
        return [...evs, {
          type: 'content_block_start',
          index: idxField(idx),
          block: { type: 'text' },
        }]
      default: {
        // 未知输出项不占 IR 块
        this.items.delete(outputIndex)
        this.next--
        return evs
      }
    }
  }

  // 取 output_index 对应的 IR 块；无则惰性开一个并返回对应的 content_block_start
  // 事件（delta 先于 added 到达的防御路径，对齐 Go outEnsure）。
  private ensure(outputIndex: number, kind: BlockType): [number, StreamEvent[]] {
    const known = this.items.get(outputIndex)
    if (known !== undefined) {
      if (known !== this.open) {
        const e = this.closeOpen()
        this.open = known
        return [known, e ? [e] : []]
      }
      return [known, []]
    }
    const idx = this.next++
    this.items.set(outputIndex, idx)
    const evs: StreamEvent[] = []
    const e = this.closeOpen()
    if (e) evs.push(e)
    this.open = idx
    return [idx, [...evs, { type: 'content_block_start', index: idxField(idx), block: { type: kind } }]]
  }

  // 关闭当前开着的块（无开块则返回 undefined）。
  private closeOpen(): StreamEvent | undefined {
    if (this.open < 0) return undefined
    const ev: StreamEvent = { type: 'content_block_stop', index: idxField(this.open) }
    this.open = -1
    return ev
  }

  // 收尾序列：关开块 → message_delta（stopReason，无 usage）→ message_stop。
  // 保证所有 content_block_stop 先于 message_delta（fixtures/README 约定 #5）。
  private close(): StreamEvent[] {
    if (this.closed) return []
    this.closed = true
    const evs: StreamEvent[] = []
    const e = this.closeOpen()
    if (e) evs.push(e)
    evs.push({ type: 'message_delta', stopReason: this.sawCall ? 'tool_use' : 'end_turn' })
    evs.push({ type: 'message_stop' })
    return evs
  }

  // 流中协议错误以 error 事件透传（不触发换源），feed 不抛异常。
  private badChunk(err: unknown): StreamEvent[] {
    return [{
      type: 'error',
      error: { type: ERR.API, message: `responses chunk 不是合法 JSON: ${(err as Error).message}`, httpStatus: 0 },
    }]
  }
}

// 注册（对齐 Go init()：入站工厂 + 出站单例）。
registerInbound(() => newInbound())
registerOutbound(newOutbound())
