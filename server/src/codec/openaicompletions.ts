// openai-completions（OpenAI Chat Completions）编解码器。
// 自 Go internal/codec/openaicompletions/{inbound,outbound}.go 逐语义移植：
//   - 入站（client 是 openai-completions 方言 ↔ IR）：in 前缀；出站（IR ↔ 上游）：out 前缀。
//   - SerializeEvent 携带跨事件状态（id/model/created、tool_calls 序号、usage 合并），
//     每个请求流必须经 newInbound() 取独立实例，不要跨流共享。
//   - 坑位 #1：serializeRequest 在 stream:true 时强制补 stream_options.include_usage
//     （否则上游不回 usage 且不报错，计费侧拿到恒 0）。
//   - 坑位 #2：requestPath 为相对段 "chat/completions"（openai 系 baseURL 停在 /v1）。
//
// Go 的 json omitempty 在 TS 侧以 undefined 模拟（JSON.stringify 自动省略）；
// wire 侧的指针语义（nil vs 指向空串）用 undefined vs '' 区分——最典型的是
// 首 chunk 必须输出 "content":""，而缺省时整个字段省略。

import {
  ERR,
  irError,
  registerInbound,
  registerOutbound,
  type Block,
  type BlockType,
  type DeltaKind,
  type ImageSource,
  type InboundCodec,
  type IrError,
  type IrRequest,
  type IrResponse,
  type Message,
  type OutboundCodec,
  type StopReason,
  type StreamEvent,
  type StreamParser,
  type ToolChoice,
  type ToolDef,
  type Usage,
} from '../ir/index.ts'

const PROTOCOL = 'openai-completions'
const IN_OBJECT_COMPLETION = 'chat.completion'
const IN_OBJECT_CHUNK = 'chat.completion.chunk'
const EMPTY_BYTES = new Uint8Array(0)

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function bytes(s: string): Uint8Array {
  return encoder.encode(s)
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

// 解析失败的规范形态（Go 版经 error 返回；TS 契约无错误通道，改为抛出并携带 IrError）。
export class CodecError extends Error {
  readonly irError: IrError
  constructor(irError: IrError) {
    super(irError.message)
    this.irError = irError
    this.name = 'CodecError'
  }
}

// ---- 上游 wire 形态（入站序列化与出站解析共用，对齐 Go inResponse/inChunk 等）----

interface WireToolFunc {
  name: string
  arguments: string // 紧凑 JSON 对象的字符串形态
}

interface WireToolCall {
  id: string
  type: string // 恒为 "function"，忽略
  function: WireToolFunc
}

interface WireToolDef {
  name: string
  description: string
  parameters: unknown
}

interface WireImage {
  url: string
}

interface WireContentPart {
  type: string
  text?: string
  image_url?: WireImage
}

interface WirePromptDetails {
  cached_tokens: number
}

// OpenRouter/Tencent 系上游在 usage 顶层另给的缓存字段（非标准 OpenAI，
// 但 CodeBuddy/hy4 这条链路确实在发）。prompt_cache_miss_tokens 是「本次真正
// 新写入缓存」的量，也就是 anthropic 口径的 cache_creation_input_tokens。
interface WireCacheExtras {
  prompt_cache_miss_tokens?: number
  prompt_cache_write_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface WireUsage extends WireCacheExtras {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: WirePromptDetails
}

interface WireMessage {
  role: string
  content: unknown // string | 部件数组 | null
  tool_calls?: WireToolCall[]
}

interface WireChoice {
  index: number
  message: WireMessage
  finish_reason: string
}

interface WireResponse {
  id: string
  object: string
  created: number
  model: string
  choices: WireChoice[]
  usage: WireUsage
}

interface WireDelta {
  role?: string
  // 指针语义：undefined = 字段缺省（省略）；'' = 显式空串（首 chunk 需输出 "content":""）
  content?: string
  reasoning_content?: string
  tool_calls?: WireToolDelta[]
}

interface WireToolDelta {
  index: number
  id?: string
  type?: string
  function?: { name?: string; arguments: string } // 声明帧需输出 "arguments":""
}

interface WireChunkChoice {
  index: number
  delta: WireDelta
  finish_reason: string | null
}

interface WireChunk {
  id?: string
  object: string
  created?: number
  model?: string
  choices: WireChunkChoice[]
  usage?: WireUsage
}

// ---- IR ↔ wire 字段映射 ----

// IR stopReason → openai finish_reason。
function inFinishReason(sr: StopReason | undefined): string {
  switch (sr) {
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    case 'content_filter':
      return 'content_filter'
    default:
      return 'stop' // end_turn / 空 → stop
  }
}

// openai finish_reason → IR stopReason（README 约定 #3）。
function outStopReason(fr: string): StopReason {
  switch (fr) {
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    case 'content_filter':
      return 'content_filter'
    default:
      return 'end_turn' // stop / 空 / 未知
  }
}

// IR Usage → openai usage。total = prompt + completion（缓存读不进 total，
// 与上游 wire 语义一致，见夹具 12+34=46）；cached_tokens 来自 IR 独立字段
// cacheReadTokens，绝不混入 prompt_tokens。
function wireUsage(u: Usage): WireUsage {
  const prompt = u.inputTokens ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: u.outputTokens,
    total_tokens: prompt + u.outputTokens,
    ...(u.cacheReadTokens !== undefined && u.cacheReadTokens > 0
      ? { prompt_tokens_details: { cached_tokens: u.cacheReadTokens } }
      : {}),
  }
}

// openai usage → IR Usage。cached_tokens 进独立 cacheReadTokens，绝不混入
// inputTokens（成本核算硬约束）；全零且无明细视为上游未提供，返回 undefined。
//
// 缓存写入（cacheCreationTokens）：标准 OpenAI 没有这个字段，但部分上游
// （Tencent CodeBuddy / OpenRouter 系）在顶层给 prompt_cache_miss_tokens /
// prompt_cache_write_tokens / cache_creation_input_tokens。三者按可信度依次取，
// 全缺省则留空——留空而不是 0，UI 才能区分「没写入」和「上游没说」。
function irUsageOf(w: WireUsage | undefined): Usage | undefined {
  const prompt = w?.prompt_tokens ?? 0
  const completion = w?.completion_tokens ?? 0
  const total = w?.total_tokens ?? 0
  const details = w?.prompt_tokens_details
  if (prompt === 0 && completion === 0 && total === 0 && details === undefined) return undefined
  const u: Usage = { outputTokens: completion, accuracy: 'exact' }
  if (prompt !== 0) u.inputTokens = prompt
  if (details !== undefined && details.cached_tokens !== 0) u.cacheReadTokens = details.cached_tokens
  // 取第一个 >0 的字段，不能写 `a ?? b ?? c`：上游常把不支持的字段填 0
  // 占位（真实载荷里 cache_creation_input_tokens:0 与 prompt_cache_miss_tokens:23
  // 同时出现），`??` 会被那个 0 短路掉，真正有值的字段反而读不到。
  const write = [w?.cache_creation_input_tokens, w?.prompt_cache_write_tokens, w?.prompt_cache_miss_tokens]
    .find((v) => v !== undefined && v > 0)
  if (write !== undefined) u.cacheCreationTokens = write
  return u
}

// 字段级合并 message_start 与 message_delta 的用量（新值非零优先）。
function mergeUsage(start: Usage | undefined, delta: Usage): Usage {
  if (start === undefined) return delta
  return {
    inputTokens: delta.inputTokens || start.inputTokens,
    outputTokens: delta.outputTokens || start.outputTokens,
    cacheReadTokens: delta.cacheReadTokens || start.cacheReadTokens,
    cacheCreationTokens: delta.cacheCreationTokens || start.cacheCreationTokens,
    reasoningTokens: delta.reasoningTokens || start.reasoningTokens,
    accuracy: delta.accuracy,
  }
}

// IR Input 对象 → OpenAI arguments 紧凑 JSON 字符串。
function compactArgs(input: unknown): string {
  return input === undefined ? '{}' : JSON.stringify(input)
}

// OpenAI 的 arguments JSON 字符串 → 对象形态的 IR Input。
function parseArgs(args: string): unknown {
  if (args.trim() === '') return undefined
  try {
    return JSON.parse(args) as unknown
  } catch {
    return undefined // 非法 arguments 容忍为空，不让整个请求失败
  }
}

// ---- wire content 解码（string | 部件数组 | null → IR 块）----

// systemOnly 时只保留 text 块（IR System 仅允许 text）。
function decodeParts(raw: unknown, systemOnly: boolean): Block[] {
  if (raw === null || raw === undefined) return []
  if (typeof raw === 'string') {
    return raw === '' ? [{ type: 'text' }] : [{ type: 'text', text: raw }]
  }
  if (!Array.isArray(raw)) return [] // 无法识别的 content 形态，容忍
  const blocks: Block[] = []
  for (const item of raw) {
    const p = item as { type?: unknown; text?: unknown; image_url?: unknown }
    switch (p.type) {
      case 'text':
        blocks.push(
          typeof p.text === 'string' && p.text !== ''
            ? { type: 'text', text: p.text }
            : { type: 'text' },
        )
        break
      case 'image_url': {
        if (systemOnly || p.image_url === null || p.image_url === undefined) continue
        const img = p.image_url as WireImage
        blocks.push(decodeImageURL(typeof img.url === 'string' ? img.url : ''))
        break
      }
    }
  }
  return blocks
}

// 解析图片 URL：data URI（base64）→ base64 来源，其余 → url 来源。
function decodeImageURL(u: string): Block {
  if (u.startsWith('data:')) {
    const rest = u.slice('data:'.length)
    const i = rest.indexOf(',')
    if (i >= 0) {
      const head = rest.slice(0, i)
      if (head.endsWith(';base64')) {
        return {
          type: 'image',
          imageSource: { kind: 'base64', mediaType: head.slice(0, -';base64'.length), data: rest.slice(i + 1) },
        }
      }
    }
  }
  return { type: 'image', imageSource: { kind: 'url', data: u } }
}

// 解析 tool_choice：字符串枚举或 {type:function,function:{name}}。
function decodeToolChoice(raw: unknown): ToolChoice | undefined {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw === 'string') {
    switch (raw) {
      case 'auto':
        return { mode: 'auto' }
      case 'none':
        return { mode: 'none' }
      case 'required':
        return { mode: 'any' }
      default:
        return undefined // 未知枚举容忍
    }
  }
  const obj = raw as { type?: unknown; function?: { name?: unknown } }
  if (obj.type === 'function' && typeof obj.function?.name === 'string' && obj.function.name !== '') {
    return { mode: 'tool', name: obj.function.name }
  }
  return undefined // 未知形态容忍
}

// 解析 stop：string 或数组。
function decodeStop(raw: unknown): string[] {
  if (typeof raw === 'string') return [raw]
  if (Array.isArray(raw) && raw.every((s): s is string => typeof s === 'string')) return raw
  return []
}

// 解析推理强度：各方言的 effort 写法收敛为单个字符串（原样透传，不校验取值）。
// 优先级：reasoning_effort > reasoningEffort > reasoning（字符串或 {effort}）>
// thinking（字符串或 {effort}）> output_config.effort（Anthropic 新式误发到此端点的容错）。
// 空串视为未提供；off/none 等关闭档也如实透传（出站侧再决定省略还是 disabled）。
function decodeReasoningEffort(w: Record<string, unknown>): string | undefined {
  const pick = (v: unknown): string | undefined => {
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
    return undefined
  }
  const direct = pick(w['reasoning_effort']) ?? pick(w['reasoningEffort'])
  if (direct) return direct
  const r = w['reasoning']
  if (typeof r === 'string' && r.trim() !== '') return r.trim()
  if (r !== null && typeof r === 'object' && !Array.isArray(r)) {
    const e = pick((r as Record<string, unknown>)['effort'])
    if (e) return e
  }
  const t = w['thinking']
  if (typeof t === 'string' && t.trim() !== '') return t.trim()
  if (t !== null && typeof t === 'object' && !Array.isArray(t)) {
    const e = pick((t as Record<string, unknown>)['effort'])
    if (e) return e
  }
  const oc = w['output_config']
  if (oc !== null && typeof oc === 'object' && !Array.isArray(oc)) {
    const e = pick((oc as Record<string, unknown>)['effort'])
    if (e) return e
  }
  return undefined
}

// 解析推理预算（token 数形态）：thinking.budget_tokens 等；>0 的有限数才收。
function decodeThinkingBudget(w: Record<string, unknown>): number | undefined {
  const t = w['thinking']
  if (t !== null && typeof t === 'object' && !Array.isArray(t)) {
    for (const k of ['budget_tokens', 'budget', 'thinking_budget']) {
      const v = (t as Record<string, unknown>)[k]
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
    }
  }
  for (const k of ['thinking_budget', 'thinkingBudget', 'max_thinking_tokens']) {
    const v = w[k]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  }
  return undefined
}

// ---- wire content 序列化（IR 块 → string / 部件数组 / null）----

// 中间部件形态：先收集再决定 string / 数组 wire 形态（README 约定 #10）。
type Part = { kind: 'text'; text: string } | { kind: 'image'; url: string }

function blocksToParts(blocks: Block[] | undefined): Part[] {
  const parts: Part[] = []
  for (const b of blocks ?? []) {
    if (b.type === 'text') parts.push({ kind: 'text', text: b.text ?? '' })
    else if (b.type === 'image' && b.imageSource !== undefined) {
      parts.push({ kind: 'image', url: b.imageSource.data })
    }
  }
  return parts
}

function wirePart(p: Part): WireContentPart {
  if (p.kind === 'text') {
    return p.text === '' ? { type: 'text' } : { type: 'text', text: p.text }
  }
  return { type: 'image_url', image_url: { url: p.url } }
}

// 非流式响应的 content 形态：单 text 块 → 字符串；多块/多模态 → 数组；无块 → null。
function partsToResponseContent(parts: Part[]): string | WireContentPart[] | null {
  const first = parts[0]
  if (parts.length === 1 && first?.kind === 'text') return first.text
  if (parts.length > 0) return parts.map(wirePart)
  return null
}

// ---- 入站编解码器（client 是 openai-completions 方言 → IR）----

interface InWireRequest {
  model?: string
  messages?: InWireMessage[]
  tools?: { function?: { name?: string; description?: string; parameters?: unknown } }[]
  tool_choice?: unknown
  max_tokens?: number
  max_completion_tokens?: number // 新版 OpenAI SDK 默认字段；缺 max_tokens 时回落
  temperature?: unknown
  top_p?: unknown
  stop?: unknown // string 或数组
  stream?: boolean
  // 推理强度：DSH 会话偏好 reasoningEffort 落在这些字段里（DeepSeek 官方即 OpenAI 兼容格式）。
  // 必须进 IR，否则换个 harness 调档位到上游完全没效果（此前静默丢弃就是这个 bug）。
  reasoning_effort?: unknown
  reasoningEffort?: unknown // 少数客户端的驼峰写法，容错
  reasoning?: unknown // 字符串或 {effort} 对象形态
  thinking?: unknown // DeepSeek/ZAI 方言的 thinking 对象（含 effort / budget_tokens 时也收）
  output_config?: unknown // Anthropic 新式 output_config.effort 被误发到 openai 端点时的容错
  // 未知字段容忍：JSON.parse 默认忽略（stream_options / user / frequency_penalty 等）
}

interface InWireMessage {
  role?: string
  content?: unknown // string | 部件数组 | null
  tool_call_id?: string
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
}

class InCodec implements InboundCodec {
  readonly protocol = PROTOCOL

  // 流式状态：由 message_start 置位/复位，供后续 chunk 复用。
  private inID = ''
  private inModel = ''
  private inCreated = 0
  private inStartUsage: Usage | undefined // message_start 携带的输入用量（openai 上游通常为空）
  private inToolIdx = new Map<number, number>() // IR block index → openai tool_calls index
  private inToolSeq = 0 // 已开启的 tool_calls 数（即下一个 tool_calls index）

  parseRequest(body: Uint8Array): IrRequest {
    let v: unknown
    try {
      v = JSON.parse(decoder.decode(body))
    } catch (err) {
      throw new CodecError(irError(ERR.INVALID_REQUEST, `请求不是合法 JSON: ${String(err)}`))
    }
    const w = v as InWireRequest
    const req: IrRequest = {
      model: w.model ?? '',
      messages: [],
      stream: w.stream === true,
      ...(typeof w.temperature === 'number' ? { temperature: w.temperature } : {}),
      ...(typeof w.top_p === 'number' ? { topP: w.top_p } : {}),
    }
    let maxTokens = w.max_tokens ?? 0
    if (maxTokens === 0) maxTokens = w.max_completion_tokens ?? 0
    if (maxTokens !== 0) req.maxTokens = maxTokens
    for (const m of w.messages ?? []) {
      switch (m.role) {
        case 'system':
        case 'developer': {
          // 推理 harness 把系统提示发成 developer，按 system 收
          const sys = decodeParts(m.content, true)
          if (sys.length > 0) (req.system ??= []).push(...sys)
          break
        }
        case 'tool': {
          // tool 结果回填为 IR user 消息 + tool_result 块
          req.messages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              toolUseId: m.tool_call_id ?? '',
              content: decodeParts(m.content, false),
            }],
          })
          break
        }
        case 'assistant': {
          const content = [...decodeParts(m.content, false)]
          for (const tc of m.tool_calls ?? []) {
            const input = parseArgs(tc.function?.arguments ?? '')
            content.push({
              type: 'tool_use',
              ...(tc.id ? { id: tc.id } : {}),
              ...(tc.function?.name ? { name: tc.function.name } : {}),
              ...(input !== undefined ? { input } : {}),
            })
          }
          req.messages.push({ role: 'assistant', content })
          break
        }
        default: {
          // user（及未知角色按 user 容错）
          req.messages.push({ role: 'user', content: decodeParts(m.content, false) })
        }
      }
    }
    const tools = (w.tools ?? []).map((t): ToolDef => ({
      name: t.function?.name ?? '',
      ...(t.function?.description ? { description: t.function.description } : {}),
      inputSchema: t.function?.parameters ?? null,
    }))
    if (tools.length > 0) req.tools = tools
    const toolChoice = decodeToolChoice(w.tool_choice)
    if (toolChoice !== undefined) req.toolChoice = toolChoice
    const stop = decodeStop(w.stop)
    if (stop.length > 0) req.stopSequences = stop
    const effort = decodeReasoningEffort(w as unknown as Record<string, unknown>)
    if (effort !== undefined) req.reasoningEffort = effort
    const budget = decodeThinkingBudget(w as unknown as Record<string, unknown>)
    if (budget !== undefined) req.thinkingBudget = budget
    return req
  }

  serializeResponse(resp: IrResponse): Uint8Array {
    const parts = blocksToParts(resp.content)
    const toolCalls: WireToolCall[] = []
    for (const b of resp.content) {
      if (b.type === 'tool_use') {
        toolCalls.push({
          id: b.id ?? '',
          type: 'function',
          function: { name: b.name ?? '', arguments: compactArgs(b.input) },
        })
      }
      // thinking 等块在 openai-completions 非流式响应无标准 wire 形态，省略
    }
    return bytes(JSON.stringify({
      id: resp.id ?? '',
      object: IN_OBJECT_COMPLETION,
      created: resp.created ?? 0,
      model: resp.model ?? '',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: partsToResponseContent(parts),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: inFinishReason(resp.stopReason),
      }],
      usage: wireUsage(resp.usage),
    }))
  }

  serializeEvent(ev: StreamEvent): Uint8Array {
    switch (ev.type) {
      case 'message_start': {
        // 首 chunk：role + 复位流状态
        this.inReset(ev)
        return bytes(this.frameStr([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]))
      }
      case 'content_block_start': {
        // text 等块的开始无独立 wire 形态；tool_use 声明 tool_calls
        if (ev.block?.type !== 'tool_use') return EMPTY_BYTES
        const block = ev.block
        return bytes(this.frameStr([{
          index: 0,
          delta: {
            tool_calls: [{
              index: this.nextToolIdx(ev.index ?? 0),
              ...(block.id ? { id: block.id } : {}),
              type: 'function',
              function: { ...(block.name ? { name: block.name } : {}), arguments: '' },
            }],
          },
          finish_reason: null,
        }]))
      }
      case 'content_block_delta': {
        if (ev.delta === undefined) return EMPTY_BYTES
        const d: WireDelta = {}
        switch (ev.delta.kind) {
          case 'text': // 指针语义：空串也要输出 "content":""
            d.content = ev.delta.text ?? ''
            break
          case 'thinking': // openai 方言事实标准：reasoning_content（GLM/DeepSeek）
            d.reasoning_content = ev.delta.text ?? ''
            break
          case 'tool_json':
            d.tool_calls = [{
              index: this.nextToolIdx(ev.index ?? 0),
              function: { arguments: ev.delta.partialJson ?? '' },
            }]
            break
          default:
            return EMPTY_BYTES
        }
        return bytes(this.frameStr([{ index: 0, delta: d, finish_reason: null }]))
      }
      case 'content_block_stop':
      case 'ping':
        return EMPTY_BYTES
      case 'message_delta': {
        // finish_reason chunk + （有用量时）usage chunk
        let out = ''
        if (ev.stopReason !== undefined) {
          out += this.frameStr([{ index: 0, delta: {}, finish_reason: inFinishReason(ev.stopReason) }])
        }
        if (ev.usage !== undefined) {
          out += this.frameStr([], wireUsage(mergeUsage(this.inStartUsage, ev.usage)))
        }
        return bytes(out)
      }
      case 'message_stop': // openai 系终止帧
        return bytes('data: [DONE]\n\n')
      case 'error':
        if (ev.error === undefined) return EMPTY_BYTES
        return bytes(`data: ${dec(this.serializeError(ev.error))}\n\n`)
      default:
        return EMPTY_BYTES
    }
  }

  serializeError(e: IrError): Uint8Array {
    return bytes(JSON.stringify({
      error: {
        message: e.message,
        type: e.type,
        ...(e.type === ERR.RATE_LIMIT ? { code: 'rate_limit' } : {}), // 夹具锁定的 openai 侧 code
      },
    }))
  }

  // 由 message_start 复位流状态。
  private inReset(ev: StreamEvent): void {
    this.inID = ev.id ?? ''
    this.inModel = ev.model ?? ''
    this.inCreated = ev.created ?? 0
    this.inStartUsage = ev.usage
    this.inToolIdx.clear()
    this.inToolSeq = 0
  }

  // 返回 IR 块对应的 openai tool_calls index（按 tool 块出现顺序编号）。
  private nextToolIdx(irIndex: number): number {
    const known = this.inToolIdx.get(irIndex)
    if (known !== undefined) return known
    const idx = this.inToolSeq
    this.inToolSeq++
    this.inToolIdx.set(irIndex, idx)
    return idx
  }

  // 写出一个完整 chunk 帧（补上流级 id/object/created/model 头）。
  private frameStr(choices: WireChunkChoice[], usage?: WireUsage): string {
    const chunk: Record<string, unknown> = { object: IN_OBJECT_CHUNK, choices }
    if (this.inID !== '') chunk.id = this.inID
    if (this.inCreated !== 0) chunk.created = this.inCreated
    if (this.inModel !== '') chunk.model = this.inModel
    if (usage !== undefined) chunk.usage = usage
    return `data: ${JSON.stringify(chunk)}\n\n`
  }
}

function dec(b: Uint8Array): string {
  return decoder.decode(b)
}

// ---- 出站编解码器（IR → openai-completions 上游）----

// 上游 wire 消息。content 为 string（单 text 块）| 部件数组 | undefined（省略）；
// IR 的 tool_result 块展开为独立 role:"tool" 消息。
// content 是 Go any + omitempty（interface nil 才省略）：单空串也输出 "content":""。
interface OutWireMessage {
  role: string
  content?: string | WireContentPart[]
  tool_call_id?: string
  tool_calls?: WireToolCall[]
}

interface OutWireTool {
  type: string
  function: WireToolDef
}

// 拼接 text 块文本（system 段 / tool_result content 用）。
function outTexts(blocks: Block[] | undefined): string {
  let s = ''
  for (const b of blocks ?? []) {
    if (b.type !== 'text') continue
    if (s.length > 0) s += '\n'
    s += b.text ?? ''
  }
  return s
}

// 把一条 IR 消息转为 1..N 条 wire 消息：tool_result 块各成一条 role:"tool"
// 消息，其余块合成一条主消息（text/image → content，tool_use → tool_calls）。
function outMessagesOf(m: Message): OutWireMessage[] {
  const msgs: OutWireMessage[] = []
  const toolCalls: WireToolCall[] = []
  const parts: Part[] = []
  for (const b of m.content) {
    switch (b.type) {
      case 'text':
        parts.push({ kind: 'text', text: b.text ?? '' })
        break
      case 'image':
        if (b.imageSource !== undefined) parts.push({ kind: 'image', url: outImageURL(b.imageSource) })
        break
      case 'tool_use': // 对象 Input → arguments JSON 字符串（紧凑化）
        toolCalls.push({
          id: b.id ?? '',
          type: 'function',
          function: { name: b.name ?? '', arguments: compactArgs(b.input) },
        })
        break
      case 'tool_result':
        msgs.push({ role: 'tool', tool_call_id: b.toolUseId ?? '', content: outTexts(b.content) })
        break
      default:
        break
    }
  }
  // 单 text 块 → 字符串（README 约定 #10）；多块/多模态 → 数组；无块 → 缺省
  const first = parts[0]
  const content: string | WireContentPart[] | undefined =
    parts.length === 1 && first?.kind === 'text'
      ? first.text
      : parts.length > 0
        ? parts.map(wirePart)
        : undefined
  if (content !== undefined || toolCalls.length > 0) {
    msgs.push({ role: m.role, content, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) })
  }
  return msgs
}

// IR 图片来源 → openai image_url（base64 重组为 data URI）。
function outImageURL(s: ImageSource): string {
  if (s.kind === 'base64') return `data:${s.mediaType ?? ''};base64,${s.data}`
  return s.data
}

// IR → openai tool_choice。
function outToolChoice(tc: ToolChoice | undefined): unknown {
  if (tc === undefined) return undefined
  switch (tc.mode) {
    case 'none':
      return 'none'
    case 'any':
      return 'required'
    case 'tool':
      return { type: 'function', function: { name: tc.name ?? '' } }
    default:
      return 'auto'
  }
}

class OutCodec implements OutboundCodec {
  readonly protocol = PROTOCOL

  // 操作路径（baseURL 已含 /v1，坑位 #2）。
  requestPath(): string {
    return 'chat/completions'
  }

  serializeRequest(req: IrRequest): Uint8Array {
    const messages: OutWireMessage[] = []
    const sys = outTexts(req.system) // IR system → messages[role=system]
    if (sys !== '') messages.push({ role: 'system', content: sys })
    for (const m of req.messages) messages.push(...outMessagesOf(m))
    const tools: OutWireTool[] = []
    for (const t of req.tools ?? []) {
      tools.push({
        type: 'function',
        function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema ?? null },
      })
    }
    const toolChoice = outToolChoice(req.toolChoice)
    // 推理强度透传：off/none 系关闭档在 openai-completions 无标准关闭写法，省略即回到上游默认；
    // 其余档位原样发 reasoning_effort（DeepSeek / ZAI / OpenAI 兼容端都认这个字段）。
    // thinkingBudget 在此协议无标准形态，不发（Anthropic 端点由 anthropicmessages 出站负责）。
    const effort = req.reasoningEffort?.trim()
    const effortOff = effort !== undefined && ['off', 'none', 'disabled', 'disable'].includes(effort.toLowerCase())
    return bytes(JSON.stringify({
      model: req.model,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
      ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
      ...(req.maxTokens !== undefined && req.maxTokens !== 0 ? { max_tokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.topP !== undefined ? { top_p: req.topP } : {}),
      ...(req.stopSequences !== undefined && req.stopSequences.length > 0 ? { stop: req.stopSequences } : {}),
      ...(effort !== undefined && effort !== '' && !effortOff ? { reasoning_effort: effort } : {}),
      // 坑位 #1：stream:true 时必须补 include_usage，否则上游不回 usage 且不报错
      ...(req.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    }))
  }

  parseResponse(body: Uint8Array): IrResponse {
    let v: unknown
    try {
      v = JSON.parse(decoder.decode(body))
    } catch (err) {
      throw new CodecError(irError(ERR.API, `上游响应不是合法 JSON: ${String(err)}`))
    }
    const w = v as Partial<WireResponse>
    const resp: IrResponse = { content: [], usage: { outputTokens: 0, accuracy: 'unknown' } }
    if (w.id) resp.id = w.id
    if (w.model) resp.model = w.model
    if (w.created) resp.created = w.created
    const ch = w.choices?.[0]
    if (ch !== undefined) {
      resp.content.push(...decodeParts(ch.message?.content, false))
      for (const tc of ch.message?.tool_calls ?? []) { // arguments 字符串 → IR 对象
        const block: Block = { type: 'tool_use' }
        if (tc.id) block.id = tc.id
        if (tc.function?.name) block.name = tc.function.name
        const input = parseArgs(tc.function?.arguments ?? '')
        if (input !== undefined) block.input = input
        resp.content.push(block)
      }
      resp.stopReason = outStopReason(ch.finish_reason ?? '')
    }
    const u = irUsageOf(w.usage)
    if (u !== undefined) resp.usage = u
    return resp
  }

  newStreamParser(): StreamParser {
    return new OutStreamParser()
  }
}

// ---- 上游 SSE chunk 流 → IR 事件流 ----

// 有状态的 SSE 解析器，按 fixtures/README.md 约定 #5 状态机把 OpenAI chunk
// 流映射为 IR 事件流。自行缓冲半行（上游字节块边界任意，按字节缓冲防多字节
// 字符被截断）。流中的协议错误以 error 事件产出（透传，不触发换源）。
class OutStreamParser implements StreamParser {
  private buf: Uint8Array = new Uint8Array(0) // 半行缓冲
  private started = false // 已发 message_start
  private closed = false // 已发 message_delta + message_stop
  private next = 0 // 下一个 IR 块 index（= 已开启块数）
  private open = -1 // 当前开着的块 index；-1 无
  private openKind: BlockType = 'text'
  private tools = new Map<number, number>() // openai tool_calls index → IR 块 index
  private stop: StopReason | undefined
  private usage: Usage | undefined

  feed(chunk: Uint8Array): StreamEvent[] {
    this.buf = concatBytes(this.buf, chunk)
    const evs: StreamEvent[] = []
    for (;;) {
      const i = this.buf.indexOf(0x0a)
      if (i < 0) break
      const line = dec(this.buf.subarray(0, i)).replace(/\r+$/, '')
      this.buf = this.buf.subarray(i + 1)
      evs.push(...this.line(line))
    }
    return evs
  }

  // 上游 EOF 时调用：先把残余半行按整行处理，无 [DONE] 则补发收尾事件。
  //
  // 残余行的事件必须**收集并排在 close() 之前**：上游最后一帧不带尾随换行时
  // （openai 很常见——末尾独立的 usage chunk 常常就是没有 \n 结尾），
  // 丢掉它等于丢掉最后一段正文，更糟的是 chunk() 根本不会被调用、
  // this.usage 不会被赋值，message_delta 就不带 usage，计费侧拿到 0。
  // 以前这里只调 `this.line(line)` 不接返回值（与 feed() 的 `evs.push(...)` 不一致），
  // 内容静默消失；所有 .sse fixture 恰好都以 0x0a 结尾，所以一致性套件测不出来。
  // 顺序也关键：先残余行、后 close()，否则 message_delta 先发出就把 usage 漏掉了
  // （另两个编解码器 anthropicmessages/openairesponses 的 finish 同样是这个顺序）。
  finish(): StreamEvent[] {
    const evs: StreamEvent[] = []
    if (this.buf.length > 0) {
      const line = dec(this.buf).replace(/\r+$/, '')
      this.buf = new Uint8Array(0)
      evs.push(...this.line(line))
    }
    return evs.concat(this.close())
  }

  // 处理一行 SSE，返回产出的事件（可能为空）。
  private line(line: string): StreamEvent[] {
    if (this.closed) return []
    if (!line.startsWith('data:')) return [] // 空行/注释/其他 SSE 字段容忍
    const payload = line.slice('data:'.length).trim()
    if (payload === '') return []
    if (payload === '[DONE]') return this.close()
    let v: unknown
    try {
      v = JSON.parse(payload)
    } catch (err) {
      // 流中协议错误以 error 事件透传（不触发换源），不抛出
      return [{ type: 'error', error: irError(ERR.API, `openai chunk 不是合法 JSON: ${String(err)}`) }]
    }
    return this.chunk(v as Partial<WireChunk>)
  }

  private chunk(ch: Partial<WireChunk>): StreamEvent[] {
    const evs: StreamEvent[] = []
    if ((ch.choices?.length ?? 0) > 0 && !this.started) {
      // 首 chunk → message_start（openai 此时无 usage）
      this.started = true
      evs.push({
        type: 'message_start',
        ...(ch.id ? { id: ch.id } : {}),
        ...(ch.model ? { model: ch.model } : {}),
        ...(ch.created ? { created: ch.created } : {}),
      })
    }
    if (ch.usage !== undefined && ch.usage !== null) {
      // usage chunk（choices 为空）→ 暂存，收尾时并入 message_delta
      this.usage = irUsageOf(ch.usage)
    }
    for (const choice of ch.choices ?? []) {
      if ((choice.index ?? 0) !== 0) continue // P0 只处理首选
      const d = choice.delta ?? {}
      const reasoning = d.reasoning_content
      if (typeof reasoning === 'string' && reasoning !== '') { // GLM/DeepSeek 事实标准
        evs.push(...this.textDelta('thinking', reasoning, 'thinking'))
      }
      const content = d.content
      if (typeof content === 'string' && content !== '') { // 惰性开文本块
        evs.push(...this.textDelta('text', content, 'text'))
      }
      for (const t of d.tool_calls ?? []) evs.push(...this.toolDelta(t))
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        // 关开块 + 暂存 stopReason
        const stop = this.closeOpen()
        if (stop !== undefined) evs.push(stop)
        this.stop = outStopReason(choice.finish_reason)
      }
    }
    return evs
  }

  // 追加文本/思考增量；块未开或类型不符时先关旧块再开新块。
  private textDelta(kind: DeltaKind, text: string, bt: BlockType): StreamEvent[] {
    const evs: StreamEvent[] = []
    if (this.open < 0 || this.openKind !== bt) {
      const stop = this.closeOpen()
      if (stop !== undefined) evs.push(stop)
      this.open = this.next
      this.openKind = bt
      this.next++
      evs.push({
        type: 'content_block_start',
        ...(this.open > 0 ? { index: this.open } : {}), // 对齐 Go omitempty：index 0 省略
        block: { type: bt },
      })
    }
    evs.push({
      type: 'content_block_delta',
      ...(this.open > 0 ? { index: this.open } : {}),
      delta: { kind, text },
    })
    return evs
  }

  // 处理一个 tool_calls 片段：新 index → 关当前开块并开 tool_use 块
  // （IR index = 已开启块数）；非空 arguments → tool_json 增量。
  private toolDelta(t: WireToolDelta): StreamEvent[] {
    const evs: StreamEvent[] = []
    const tIdx = t.index ?? 0
    let idx = this.tools.get(tIdx)
    if (idx === undefined) {
      const stop = this.closeOpen()
      if (stop !== undefined) evs.push(stop)
      idx = this.next
      this.next++
      this.tools.set(tIdx, idx)
      this.open = idx
      this.openKind = 'tool_use'
      const block: Block = { type: 'tool_use' }
      if (t.id) block.id = t.id
      if (t.function?.name) block.name = t.function.name
      evs.push({ type: 'content_block_start', ...(idx > 0 ? { index: idx } : {}), block })
    }
    const args = t.function?.arguments
    if (args !== undefined && args !== '') {
      evs.push({
        type: 'content_block_delta',
        ...(idx > 0 ? { index: idx } : {}),
        delta: { kind: 'tool_json', partialJson: args },
      })
    }
    return evs
  }

  // 关闭当前开着的块（无开块则返回 undefined）。
  private closeOpen(): StreamEvent | undefined {
    if (this.open < 0) return undefined
    const ev: StreamEvent = { type: 'content_block_stop', ...(this.open > 0 ? { index: this.open } : {}) }
    this.open = -1
    return ev
  }

  // 收尾序列：关开块 → message_delta（stopReason + 完整 usage）→ message_stop。
  // 保证所有 content_block_stop 先于 message_delta（README 约定 #5）。
  private close(): StreamEvent[] {
    if (this.closed) return []
    this.closed = true
    const evs: StreamEvent[] = []
    const stop = this.closeOpen()
    if (stop !== undefined) evs.push(stop)
    evs.push({
      type: 'message_delta',
      ...(this.stop !== undefined ? { stopReason: this.stop } : {}),
      ...(this.usage !== undefined ? { usage: this.usage } : {}),
    })
    evs.push({ type: 'message_stop' })
    return evs
  }
}

// ---- 导出与注册表登记（对齐 Go init()）----

export function newInbound(): InboundCodec {
  return new InCodec()
}

export function newOutbound(): OutboundCodec {
  return new OutCodec()
}

registerInbound(newInbound)
registerOutbound(newOutbound())
