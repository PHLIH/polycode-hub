// IR 数据类型（对齐 Go internal/ir/ir.go + stream.go 的 JSON 形状）。
// IR 的词汇表以 Anthropic Messages 为基准；入站/出站编解码器只依赖本包，互不耦合。

export type Protocol = string

export type Role = 'user' | 'assistant'

export type BlockType = 'text' | 'image' | 'tool_use' | 'tool_result' | 'thinking'

export type ImageSourceKind = 'base64' | 'url'

export interface ImageSource {
  kind: ImageSourceKind
  mediaType?: string
  data: string
}

export interface Block {
  type: BlockType
  text?: string
  imageSource?: ImageSource
  // tool_use：input 是「对象」形态（OpenAI 的 arguments 是 JSON 字符串，转换须 parse/serialize）
  id?: string
  name?: string
  input?: unknown
  // tool_result
  toolUseId?: string
  isError?: boolean
  content?: Block[]
}

export interface ToolDef {
  name: string
  description?: string
  inputSchema: unknown
}

export type ToolChoiceMode = 'auto' | 'none' | 'any' | 'tool'

export interface ToolChoice {
  mode: ToolChoiceMode
  name?: string
}

export interface Message {
  role: Role
  content: Block[]
}

export interface IrRequest {
  model: string
  system?: Block[]
  messages: Message[]
  tools?: ToolDef[]
  toolChoice?: ToolChoice
  maxTokens?: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
  // 推理强度：原样透传的档位名（low / medium / high / max / minimal / xhigh / off / none …）。
  // DSH 侧是会话偏好 reasoningEffort，最终落在各协议的 reasoning_effort / reasoning.effort /
  // output_config.effort 里；网关不校验取值、只透传（未知值也透传，由上游决定是否接受）。
  // 缺省 = 客户端没说，上游用自己的默认档（DeepSeek 系默认 high）。
  reasoningEffort?: string
  // 推理预算（token 数形态）：Anthropic 旧式 budget_tokens 等。
  // 与 reasoningEffort 正交、可并存；各出站 codec 只发自己协议认识的那个，不互相换算。
  thinkingBudget?: number
  stream: boolean
  created?: number
}

// reasoningEffort 是否表示「关闭思考」（DSH 的 off / OpenAI 的 none / Anthropic disabled）。
// 大小写不敏感；网关用它决定出站时省略还是显式 disabled，不做档位合法性校验。
export function isReasoningOff(effort?: string): boolean {
  if (!effort) return false
  const v = effort.trim().toLowerCase()
  return v === 'off' || v === 'none' || v === 'disabled' || v === 'disable'
}

export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'content_filter'

export type Accuracy = 'exact' | 'estimated' | 'unknown'

export interface Usage {
  inputTokens?: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
  accuracy: Accuracy
}

export type CacheSemantics = 'subset' | 'separate'

// 上游 wire 总量 = input + output（OpenAI 系 prompt 已含 cached/miss 全量，
// cached/miss 都是 prompt 的子集，另加即重复计数；实抓 prompt=425/cached=320/
// miss=105 时 wire=435）。sem 参数保留供调用方显式标注语义，默认 subset。
// reasoning 已含于 output，不重复计。
export function usageTotal(u: Usage, sem: CacheSemantics = 'subset'): number {
  const base = (u.inputTokens ?? 0) + u.outputTokens
  return sem === 'separate'
    ? base + (u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0)
    : base
}

const ACCURACY_RANK: Record<Accuracy, number> = { exact: 0, estimated: 1, unknown: 2 }

// 取两者中较差（rank 更大）的 accuracy：流式多事件合并用量时，任一估算即整体估算。
export function accuracyWorst(a: Accuracy, b: Accuracy): Accuracy {
  return ACCURACY_RANK[a] >= ACCURACY_RANK[b] ? a : b
}

export interface IrResponse {
  id?: string
  model?: string
  content: Block[]
  stopReason?: StopReason
  usage: Usage
  created?: number
}

// ---- 流事件（以 Anthropic SSE 事件集为规范形态）----

export type StreamEventType =
  | 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop'
  | 'message_delta' | 'message_stop' | 'ping' | 'error'

export type DeltaKind = 'text' | 'thinking' | 'tool_json'

export interface Delta {
  kind: DeltaKind
  text?: string
  partialJson?: string
}

export interface StreamEvent {
  type: StreamEventType
  id?: string
  model?: string
  created?: number
  index?: number
  block?: Block
  delta?: Delta
  stopReason?: StopReason
  usage?: Usage
  error?: import('./errors.ts').IrError
}
