# W2 统一转换测试 fixtures（共享契约，锁定后禁止私改）

本目录是全部协议编解码器（A1..A6）的**唯一**测试夹具来源。各编解码器通过
`tests/conformance`（`InboundSuite` / `OutboundSuite`）消费本目录，**禁止自带 fixture**。
改动本目录任何文件 = 改动所有人的契约，必须主控 agent 批准并全量回归。

## 目录结构（每个协议一份）

```
<protocol>/
  request.<scenario>.json          # client 请求 wire（入站解析器的输入）
  response.<scenario>.json         # 非流式响应 wire（出站解析输入 / 入站序列化期望输出）
  stream.<scenario>.sse            # SSE 事件流 wire（同上，双向使用）
  error.json                       # 错误响应 wire（SerializeError 期望输出）
  expected/
    request.<s>.ir.json            # 期望 IR（ParseRequest 的期望输出 = SerializeRequest 的输入）
    response.<s>.ir.json           # 期望 IR
    stream.<s>.events.json         # 期望 []*ir.StreamEvent
    upstream-request.<s>.json      # 期望上游请求 wire（SerializeRequest 的期望输出）
```

场景：`basic`（文本+system+参数）、`tools`（工具定义+tool_use/tool_result 往返+tool_choice，
stream=true）、`multimodal`（base64 图 + url 图）。

## 谁消费什么

| 任务 | 用例 |
|---|---|
| A1..A3 入站解析器 | `ParseRequest(request.*)` == `expected/request.*.ir.json`；`SerializeResponse(expected/response.*.ir)` == `response.*`；`SerializeEvent(expected/stream.*.events)` == `stream.*.sse` 帧；`SerializeError` == `error.json` |
| A4..A6 出站序列化器 | `RequestPath()` == conformance 期望表；`SerializeRequest(expected/request.*.ir)` == `expected/upstream-request.*`；`ParseResponse(response.*)` == `expected/response.*.ir`；`StreamParser.Feed(stream.*.sse)`（整块 + 7 字节分块）+ `Finish()` == `expected/stream.*.events` |

三个协议的 `request.*.ir.json` **内容完全一致**（同一故事跨协议规范化为同一 IR，
`fixture_test.go` 强制校验）。

## 序列化形态约定（合同条款，全部编解码器必须遵守）

1. **system**：anthropic 客户端接受 string 或块数组（basic 场景 wire 是 string，
   必须解析为 IR text 块）；anthropic 出站序列化**统一输出块数组**。
   openai-completions 用 `messages[role=system]`；openai-responses 用 `instructions`。
2. **工具调用**：IR `Block.Input` 是**对象**（json.RawMessage）。openai 的 `arguments`
   是 **JSON 字符串**，双向转换必须 parse/stringify；出站序列化时先 `json.Compact`
   再嵌入字符串（fixture 中为 `{"city":"北京"}` 紧凑形态）。`tool_use.id` ↔ `call_id`
   /`tool_call_id`；anthropic `tool_use_id` 也映射到 IR `toolUseId`。
3. **结束原因映射**（IR 以 Anthropic 词汇为规范）：
   `stop`→`end_turn`；`length`→`max_tokens`；`tool_calls`→`tool_use`；
   `content_filter`→`content_filter`；responses `status:completed`→`end_turn`。
   IR→anthropic 出站时 `content_filter` 降级为 `end_turn`（有损，罕见）。
4. **SSE 帧形态**：
   - anthropic-messages：`event: <type>\ndata: <json>\n\n`，data 内 `type` 与 event 名一致，无 [DONE]；
   - openai-completions：`data: <json>\n\n`（无 event 行），最后一个帧是 `data: [DONE]`；
   - openai-responses：`event: <type>\ndata: <json>\n\n`（具名事件），无 [DONE]。
   `SerializeEvent` 返回**完整帧**；OpenAI 系的 [DONE] 由 IR `message_stop` 事件产出。
5. **流式状态机（OpenAI 系 → IR）**：
   - 首 chunk（含 delta.role）→ `message_start`（id/model/created；openai 此时无 usage）；
   - 文本块**惰性开启**：首个非空 content delta 才发 `content_block_start`；
   - `tool_calls[i]` 新出现 → 先关闭当前开着的块，再 `content_block_start`（IR index = 已开启块数）；
   - `finish_reason` → 关闭开着的块（`content_block_stop`），暂存 stopReason；
   - usage chunk（choices 空）→ 暂存 usage；
   - `[DONE]` / EOF → 发 `message_delta`（stopReason + 完整 usage）+ `message_stop`。
   - IR 事件顺序规范：**所有 content_block_stop 都先于 message_delta**。
6. **usage 语义**：`message_start.Usage` = 流开始时已知的输入用量（anthropic 有，
   openai 系没有则省略）；`message_delta.Usage` = 结束时最终用量（anthropic 只有
   output；openai/responses 给输入+输出全量）。消费方按「字段级最新优先」合并。
   有 usage → `accuracy: exact`；无 → 不填 usage（计费侧再兜底估算）。
   ⚠️ `cache_read`/`cache_creation` 映射进 IR Usage 的**独立字段**，绝不混入 inputTokens：
   anthropic `cache_read_input_tokens`/`cache_creation_input_tokens`；
   openai-completions `prompt_tokens_details.cached_tokens`；
   openai-responses `input_tokens_details.cached_tokens`。
   注（openai-responses 特有）：非流式响应对象的 `output_tokens_details:{reasoning_tokens:N}`
   即使为 0 也显式输出（对齐真实 Responses API 的完整 response 形态）；
   流式 `response.completed` 里的 usage 则省略零值明细子对象。两条路径各自夹具锁定。
7. **stream_options（坑位 #1）**：openai-completions 出站 `SerializeRequest` 在
   `stream:true` 时**必须**补 `"stream_options":{"include_usage":true}`（见 tools 场景）。
   openai-responses 不需要（usage 在 response.completed 里）。
8. **省略规则**：`stream:false` 时所有协议出站请求**省略** `stream` 字段；
   `maxTokens<=0` 时 anthropic 出站默认 4096（Anthropic API 必填），openai 系省略；
   `ToolChoice==nil` 时省略 tool_choice/toolChoice；temperature/topP 未设置省略。
   请求解析**容忍未知字段**（不报错），但只提取 IR 已有字段（P0 不透传扩展字段）。
9. **多模态**：IR `ImageSource{kind:base64|url}`；openai 系的 data URI
   （`data:image/png;base64,XXX`）双向重组；responses 的 `input_image.image_url` 同理。
10. **content 形态**：单 text 块序列化为 openai `content` 字符串；多块/多模态才用数组。
    anthropic 客户端 wire 的 `content` string 同样要能解析（basic 场景已覆盖）。
11. **零值序列化约定**：IR `Usage.InputTokens` 带 omitempty（伪 0 不得覆盖「字段级最新优先」
    合并中的真实输入量）；期望事件文件中省略 `"index": 0`（IR 的 Index 为 int + omitempty，
    零值块索引在 IR JSON 形态里不可见；SSE wire 上的 index:0 由各协议入站序列化器与
    .sse 夹具另行锁定，覆盖不受损）。

## 运行方式

各编解码器包测试文件内：

```go
func TestConformance(t *testing.T) {
    conformance.InboundSuite(t, NewInbound())   // 入站编解码器
    // 或
    conformance.OutboundSuite(t, NewOutbound()) // 出站编解码器
}
```

建议每个编解码器另补 2~3 个协议特有边角用例（如 anthropic system 数组带
cache_control 的容忍、openai 多工具并行调用），但 conformance 通过是验收底线。
