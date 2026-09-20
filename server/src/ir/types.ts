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

// ---- 模型级推理等级预设用的档位词汇 ----
// 客户端透传语义上游各自解读，网关不校验；但模型预设的档位键是**网关自己的
// 配置词汇**，写入与应用两侧必须同口径，这里只定义一次。

// 「跟随上游」：模型预设不覆盖客户端档位，上游发来（客户端透传）什么档位就用什么。
// 客户端没带档位时同理——不凭空注入，保持省略语义交给上游默认档。
export const REASONING_FOLLOW = 'follow'

// 模型推理等级预设的合法档位：DSH 档位体系 + follow（跟随上游）。
export const REASONING_LEVELS = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', REASONING_FOLLOW,
] as const

export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

export function validReasoningLevel(v: string): v is ReasoningLevel {
  return (REASONING_LEVELS as readonly string[]).includes(v.trim().toLowerCase())
}

// 档位键规范形（trim + 小写）。仅去空格与大小写收敛，不判合法性——
// 非法值由写入入口报错或忽略，这里不替调用方做决定。
export function normalizeReasoningKey(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim().toLowerCase()
  return t === '' ? undefined : t
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
  // 该 Usage 各字段的缓存计量语义（CACHE-SEMANTICS）：
  //   subset   —— OpenAI 系 wire：inputTokens 已含缓存命中（cached ⊆ prompt）。
  //   separate —— Anthropic 系 wire：input/read/creation 三桶互斥，input 只含未命中。
  // 出站解析时由 codec 打上（等于上游实际协议），入站序列化时据此与客户端协议
  // 的语义做归一。真实缺陷背景：anthropic 上游（separate）的响应转给 openai
  // 客户端时，input=105(未命中) 与 cached_tokens=320 同包输出——子集语义下
  // 命中数不可能超过父集，客户端按 subset 读就得出荒值（命中率 >100% 同源病灶）。
  sem?: CacheSemantics
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

// normalizeUsageSem 把 Usage 归一到目标语义（跨协议转发时的语义转换）。
//
// ir 的 Usage 是中性容器，字段语义由「产生它的协议」决定。入站序列化（把 IR
// 转回客户端协议 wire）时必须归一，否则：
//   separate → subset 客户端：input(未命中=105) 与 cached(320) 同包，客户端按
//     「cached ⊆ prompt」读即得荒值；正确输出 prompt = 三桶和。
//   subset → separate 客户端：input(prompt=425，已含 cached=320) 会被客户端
//     当「未命中部分」，再加 read/creation 就重复计 320；正确输出 input 需扣除
//     命中/写入明细（下限 0：上游偶发误报时宁可低估也不输出负数）。
// reasoning 与 output 的关系不受语义影响（reasoning 恒已含于 output），不动。
// usage 无 sem 标签（conformance 夹具、旧路径、测试桩）时原样返回——来源语义
// 不可判定，任何折算都是猜；输出 wire 的字段名本身会告诉客户端怎么读。
// 生产路径上三个出站解析器都打 sem，不受此影响。
export function normalizeUsageSem(u: Usage, to: CacheSemantics): Usage {
  const from = u.sem
  if (from === undefined || from === to) return u
  const read = u.cacheReadTokens ?? 0
  const creation = u.cacheCreationTokens ?? 0
  if (from === 'separate' && to === 'subset') {
    // separate 三桶 → subset 的 prompt（全量输入 = 未命中 + 命中 + 写入）
    const input = (u.inputTokens ?? 0) + read + creation
    return {
      ...u, inputTokens: input, cacheReadTokens: undefined, cacheCreationTokens: undefined,
      sem: 'subset',
    }
  }
  // subset → separate：prompt 拆出命中与写入明细，剩下的才是未命中输入
  const input = Math.max(0, (u.inputTokens ?? 0) - read - creation)
  return { ...u, inputTokens: input, sem: 'separate' }
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
