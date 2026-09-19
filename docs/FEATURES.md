# polycode-hub 功能说明（按代码实际行为）

> 口径：以下每条均可在 `server/src/` 找到对应实现；凡涉及“是什么、怎么配、会发生什么”，均以代码为准。
> 最近核对：2026-09-15（仓库 Node/TS 主工程，`package.json` engines `node >= 22.13`）。

## 1. 它是什么

多源 Coding Agent 免费额度**统一反代网关**：把 ZCode / OpenCode Zen / WorkBuddy 等上游拧成一个入口，client 只需对接网关暴露的协议端点，不用关心背后是谁在干活。

- **网关进程**：`server/src/cli.ts`（入口）+ Hono 应用；运行时**只有一个服务、一个端口**，网关进程自己托管前端构建产物 `web/dist`（`cli.ts:33-35` 探测含 `web/dist` 的目录，`cli.ts:180` 挂载 `createAdminUI`）。
- **管理台**：浏览器打开 `http://127.0.0.1:3000/admin/`（`cli.ts:183` 打印该地址），Vue 3 + Element Plus + ECharts（`web/src/views/` 共 6 个页面，见 §7）。
- **存储**：SQLite，`data/admin.db`（Provider / 账号 / egress 三表，`adminapi/store.ts:87-102`）与 `data/usage.db`（用量，`cli.ts:83`）分两个库；`data_dir` 缺省 `data`（`config/index.ts:244`）。

## 2. 转发面：client 能调什么

挂载位置 `server/src/gateway/proxy.ts:123-136`（`registerRoutes`），由 `cli.ts:177-180` 装到同一 Hono 应用。

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/v1/messages` | Anthropic Messages 入站 |
| POST | `/v1/chat/completions` | OpenAI Chat Completions 入站 |
| POST | `/v1/responses` | OpenAI Responses 入站 |
| POST | `/chat/completions`、`/responses` | 裸路径别名（Base URL 填到端口根的客户端用，`proxy.ts:128-130`） |
| GET | `/v1/models`、`/models` | 模型目录，OpenAI `{"data":[{id}]}` 形态，id 为限定名 `name/modelId`（`proxy.ts:144-158`）；受 `gateway_key` 校验（`proxy.ts:146-149`，失败 401） |
| GET | `/health` | 健康检查，返回 `{ok:true, apps:N}`，N = 启用中的 Provider 数（`proxy.ts:139-142`）；**不鉴权**（注释 `proxy.ts:133-135`） |

- **流式 / 非流式**：都支持。非流式走整体 JSON（`proxy.ts:353-378`）；流式走 SSE（`Content-Type: text/event-stream`，`proxy.ts:540-547`）。
- **client 接入示例**：`export ANTHROPIC_BASE_URL=http://localhost:3000`（README 实测口径）；client 未指定 model 时用 `gateway.default_model` 兜底（`proxy.ts:176`）。
- **网关自身鉴权**：`gateway_key` 为空 = 不校验；非空则转发面三端点与模型目录要求 `Authorization: Bearer <key>` 并做恒时比较（`proxy.ts:36-43 bearerMatch`，`proxy.ts:164-167`）。

## 3. 三协议与 IR 中间表示

- **支持的协议**：`anthropic-messages` / `openai-completions` / `openai-responses`（协议表 `ir/index.ts:5-9`）。
- **转换方式**：统一经 **IR 中间表示**中转——3 个入站解析器 + 3 个出站序列化器，不做 N×N 两两直转（`ir/codec.ts:2`）。三 codec 均双向注册：`codec/anthropicmessages.ts:642-643`、`codec/openaicompletions.ts:969-970`、`codec/openairesponses.ts:1074-1075`。
- **IR 词汇表**以 Anthropic Messages 为基准（`ir/types.ts:1-3`）：`IrRequest` 字段见 `ir/types.ts`（model / system / messages / tools / toolChoice / maxTokens / temperature / topP / stopSequences / reasoningEffort / thinkingBudget / stream）；推理强度三协议互转（completions `reasoning_effort` / responses `reasoning.effort` / anthropic `thinking` + `output_config.effort`，未知档位原样透传）；Block 类型 `text | image | tool_use | tool_result | thinking`（`ir/types.ts:8`）；图片源 `base64 | url`（`ir/types.ts:10-16`）；流事件以 Anthropic SSE 事件集为规范形态（`ir/types.ts:105-130`）。
- **工具调用**：三向均支持 `tool_use` / `tool_result`，但线上传输形态不同（OpenAI Completions 的 arguments 是 JSON 字符串，转换时须 parse/serialize，`ir/types.ts:22`；Responses 用 function_call / function_call_output；Anthropic 直译）。Responses 的 tool_choice 不支持会抛错；Completions 未知 tool_choice 容忍为 undefined。
- **已知丢弃点**（如实列出，非缺陷隐瞒）：
  - OpenAI Completions 非流式响应序列化丢弃 thinking（`codecov` 位置：`codec/openaicompletions.ts:491`），`blocksToParts` 只收 text/image（`:348-357`）。
  - OpenAI Responses 丢弃 stopSequences、请求侧 thinking 无形态不处理、未知输出项容忍丢弃。
  - 上游 `reasoning_content`（GLM / DeepSeek 事实标准）→ IR thinking 增量有转换（`codec/openaicompletions.ts:861-864`），出站 thinking → `reasoning_content`（`:542-543`）。
- **图片**：三向支持 text/image；Completions `decodeImageURL / outImageURL`（`:297-312` / `:696-699`，base64 组 data URI）；Responses 的 data URI 缺 `;base64,` 会抛错；Completions system-only 场景丢图片（`:286`）。

## 4. 调度：候选排序、换源闸门、冷却

### 候选排序（`router/scheduler.ts`）

1. 过滤：只留 `enabled` 且风险在 `riskMax` 内的 Provider（`scheduler.ts:10-16`，`riskAllowed` 见 `model/index.ts:19-21`）。
2. 排序：按 `priority` 升序稳定排序；同 priority 段内按计数器轮转（`pickOrderPublic:66-79`）。
3. 模型匹配（`matchModel:36-45`）：Provider 未声明 models = 透明代理，接受任意模型；否则模型 id 精确相等**且** `enabled` 才接受。
4. 限定名：`name/modelId` 形态，仅当前缀是已知 Provider 名时才视为限定（`splitModelRef:18-28`）；上游只认裸模型名，网关在转发前剥前缀（`proxy.ts:185-187`）。
5. 上下文预检（默认关，`precheck_context: false`）：开启后，用 `len/4` 粗估（`estimateRequestTokens:119-121`）超 `context_window` 的候选被跳过——拒绝 + 换源，**绝不截断**（`pickOrder:84-101`，注释 `:82`）。`context_window` 未知（0/缺省）= 放行。
6. 非流式请求跳过 `stream_only` 的源（`pickOrder:94`，如 WorkBuddy 只走流式）。

### 换源闸门（硬约束）

- **首字节前可换源，首字节后绝不换源**（`router/upstream.ts:1-4`，`ir/errors.ts:1-3`）。
- 实现：`Upstream.stream()` 非 2xx / 网络错误抛 `UpstreamError`（可换源）；2xx 返回 body 流，此后不可换源（`upstream.ts:95-124`，注释 `:162`）。
- 流式有**首字节闸门**：先等上游吐出第一个真实事件（心跳注释行不算）或超时，再向 client 承诺 200（`proxy.ts:384-436`）；首字节超时默认 15s（`config/index.ts:15`），流中途静默超时默认 60s（`:16`）。闸门已过后上游中途断流，只能补发 error 帧并收尾，不能换源（`proxy.ts:520-527`）。
- 全部候选失败：记一笔 tokens 为 0 的失败账（失败原因进 `errorKind`，供账号维度归因），再把最后一个上游错误映射为对 client 的规范错误（`proxy.ts:246-261`，`mapUpstreamError:46-55`）。

### 失败分类与账号冷却

失败分类（`ir/errors.ts:56-63 kindForStatus` + `upstream.ts:296-305 classifyUpstreamError`）：401/403 → auth（但 403 + RegionError 按 bad_request 处理，不挡协议回退）；402 → quota；429 → rate_limit（但 body 命中配额 hint 则升为 quota）；400/404/413/422 → bad_request；5xx → server。

冷却时长（`proxy.ts:24-29 cooldownFor`）：限流 60s、额度用尽 600s、鉴权 1800s、其他 30s。

账号池（`pool/account.ts`）：

- 同源加权轮询（`pick`）：按 `Account.weight`（缺省/非法按 1）分配流量；无可用抛 `ErrNoAccount`，调度据此换源/报错，不静默等待。
- `markResult:69-93`：成功且有惩罚时清零落盘；失败 `fails++`，kind=quota → `exhausted`（**不设到期时间，只认人工“重置”或一次成功的测试**，`pool/account.ts:84-87`），其余 → `cooldown` + 到期时间。
- `hasFor:30-32` 区分“该源无账号 → 走 Provider 级凭据”与“有账号但全冷却 → 跳过该源”。
- 冷却到期自动复位（`eligible:128-140`）；`exhausted` 永不自动恢复（`model/index.ts:200-203`）。
- 惩罚落盘：`fails / cooldownUntil` 写回 `admin.db`，重启不失忆；`exhausted` 必须把 status 一起写进去，恢复时再抹回 available（`cli.ts:104-118` 回写规则注释）。
- 健康度（纯派生，不落盘，`model/index.ts:205-218`）：绿=健康、琥珀=冷却中或连败 ≥ 3 次（`FAILS_WARN_AT=3`）、红=disabled / exhausted。
- **指定账号头** `x-polycode-account`（`proxy.ts servePinned`）：钉死指定账号，不轮询、不换号；账号不存在→404、source 不匹配→400、冷却中→429。
- **权重**：账号 `weight`（正整数，默认 1，`PATCH /admin/api/accounts/:id {weight}`）；关（disabled）/失效（exhausted/cooldown）的账号不在 eligible 里，分母是可用者的权重和——自动重算，不用手动调。

### 协议自动识别

- 解析顺序：模型级 `api` → 进程内事实缓存 → Provider 默认 `api`（`resolveProtocol`，`upstream.ts:316-323`）；三者皆无时逐个试候选协议，首个成功者被记住（`upstream.ts:113-123`，`rememberProtocol`）。
- 事实缓存：进程内 Map，key = `providerID + modelID`（`model/autoproto.ts:7-30`）；清缓存与换协议是两件事（`upstream.ts shouldForgetProtocol / shouldTryNextProtocol`）：只有 BAD_REQUEST（路径不对）才忘掉记住的协议，SERVER / NETWORK 不清（上游病了不代表协议错了）但照样换下一个协议试；AUTH / QUOTA / RATE_LIMIT / FINGERPRINT / REGION 不换（`shouldTryOtherProtocol` 旧名兼容，语义 = shouldForgetProtocol）。
- 管理台“扫描可用性”：并发打最小真实请求（`maxTokens: 16`，`probe.ts:235-239`），单模型超时 90s、最多 3 次（`probe.ts:55-57`，仅 rate_limit / quota / server / network 可重试，批量并发 4），成功后把协议写回模型目录持久化。

## 5. 配置：YAML 严格模式与凭据

- **配置文件**：`config/apps.yaml`（本机正式配置，git 忽略）；模板 `config/apps.example.yaml`（171 行，v0.4 口径）。`POLYCODE_CONFIG` 可覆盖路径（`cli.ts:72`）；文件不存在 → 全默认零配置启动（`config/index.ts:50-54`）。
- **gateway 真实字段**（`config/index.ts:18-31`）：`host`（缺省 `127.0.0.1`）、`port`（缺省 3000）、`admin_key`、`gateway_key`（空=不校验）、`default_model`、`risk_max`（low/medium/high，缺省 high=不过滤）、`precheck_context`、`first_byte_timeout_ms`、`stream_idle_timeout_ms`。启动参数 `--port` 可覆盖端口（`cli.ts:73-80`）。
- **Provider 真实字段**（`config/index.ts`）：`id`（只允许小写字母/数字/连字符，永久不可改，`model/index.ts:150-152`）、`display_name`、`access_kind`（official/session-reuse/simulated-login/reverse）、`risk` + `risk_note`（medium/high 必填，`model/index.ts:157-159`）、`stability`、`api`（空=自动探测）、`base_url`（anthropic-messages 停域名根由网关拼 `/v1/messages`，openai 两种停 `/v1`，`upstream.ts:392-405` 有去重 `/v1` 逻辑）、`credential`、`headers`、`dynamic_headers`（绝对路径命令，不走 shell，缺省超时 8000ms）、`enabled`、`priority`、`stream_only`、`tags`、`models`、`probe_model`、`egress`。
- **严格模式**：未知字段直接抛错拒绝启动（`config/index.ts:173-184 strictMap`，含 jwt/token 等明文凭据字段亦拒，注释 `:1-2`）；跨实体校验 source 引用 / egress 引用 / 重复 id / 端口范围（`:281-315`）。示例文件本身有测试保证可解析。
- **凭据不落明文**：只存引用 `api_key_env`（环境变量，改值需重启）或 `api_key_file`（`config/credentials/` 下文件，**改内容即热轮换**，每次请求现读，`model/index.ts:34-47`）；无凭据返回 `['', true]` 即公开端点。管理面写凭据文件限定在 `config/credentials/` 下（`adminapi/discover_api.ts:40-42`）。
- **管理面凭据输入（credentialInput / credentialKind）**：界面「API Key」框支持两种语义，由前端显式声明、后端按语义落盘（`adminapi/api.ts` `resolveCredentialInput` / `parseCredentialKind`）：
  - `credentialKind: "key"` → 当作 Key 本体，写入 `config/credentials/{provider|account}-{id}-key`（0600；id 非法字符收敛、`..` 折成 `.` 防误读），DB 只存文件引用；
  - `credentialKind: "env"`（**未声明时的回落值**）→ 维持历史语义，存环境变量名；
  - 空串 = 不改动现有凭据（编辑表单不清掉文件型 Key）；同请求同时带 `credential` 时，`credentialInput` **覆盖**它，保证粘进来的新 Key 生效。

  > 为什么必须显式声明而非自动判别：`atr_EXAMPLE0000000000000000000000abcd` 这类 Key（36 位、全为 `[A-Za-z0-9_]`）与环境变量名**字符集完全重合**，形状判别必然误判。真实缺陷即为此：Key 被存进 `apiKeyEnv`，网关当变量名找不到，请求不带 `Authorization`，用户看到「环境变量 atr_xxx 未设置」而一头雾水。
- **存储语义**：YAML 只在**空库时播种一次**（`seedProvidersIfEmpty / seedAccountsIfEmpty`，`adminapi/store.ts:196-204`），之后 `admin.db` 是唯一真相源，界面增删改重启不丢，YAML 后续改动不再生效；但配置文件里的 Provider / egress 定义在库里缺失时会被补回（删了重启回来，`cli.ts:90-92,124-129`），内置 Provider 不可删（`builtinIDs:cli.ts:171`，删除返回 403）。
- **对外监听保护**：`admin_key` 为空合法（零配置启动）；但监听地址非回环（非 `localhost / 127.* / ::1`）且未配 `admin_key` 时**拒绝启动**（`ensureAdminKey`，`cli.ts:50-58`）。管理面鉴权：`X-Admin-Key` 或 `Bearer`，恒时比较（`adminapi/api.ts:64-72 safeEqual`，`129-141 withAuth`）。

## 6. 命令行

`npx tsx server/src/cli.ts <子命令>`，或 `node bin/polycode-hub.mjs <子命令>`（bin 仅 5 行 tsx 加载 shim，`bin/polycode-hub.mjs:1-5`）。默认子命令 `serve`（`cli.ts:329`）。

| 子命令 | 作用 |
|---|---|
| `serve`（默认） | 启动网关 + 管理台。参数 `--config <path>`、`--port <n>`（`cli.ts:71-77`） |
| `scan` | 只扫描本机可导入的 harness，不启动服务；`--json` 输出 JSON（`cli.ts:199-210`） |
| `adopt [--id ID] <finding-key>` | 命令行采用某个 harness（如 `workbuddy / opencode-zen`），写入 `admin.db`（`cli.ts:214-240`） |
| `zcode login` | ZCode OAuth 登录：浏览器授权，JWT **只打印一次，不保存**，需自行 export（`cli.ts:246-270`） |
| `zcode sidecar <动作>` | 本地引擎管理：`install / setup / start / stop / status / login / ensure`（缺省 `ensure`，`cli.ts:271-320`）；`install`/`ensure` 支持 `--proxy <url>` 与 `--egress <id>` 指定下载出口，缺省自动复用项目 egress 配置（见 §10 下载代理） |

启动方式：`npm start`（日常）；`npm run dev`（后端 `tsx watch` 热重启）；`./update.sh`（停旧服务 → 前端构建 → 起新服务 → 健康检查，日志 `data/gateway.log`）。

## 7. 管理台（6 个页面，由网关托管 `web/dist`）

路由非 vue-router，`App.vue:38-44` 内 `pages = {dashboard, providers, accounts, discover, projects}` + `Login` 门禁。网关以 `createAdminUI` 托管静态文件：`/admin → 301 /admin/`，`GET /admin/*` 映射文件（目录穿越防护、缺文件 404、一律 `Cache-Control: no-cache`，`gateway/adminui.ts:27-47`）。

| 页面 | 作用 |
|---|---|
| Dashboard | 用量仪表盘：365 天热力图 + 归因表 + 胶囊区间；TPS / TTFT 为 null 时显示 —（`usage/store.ts:58-63`，`Dashboard.vue:412-420`） |
| Providers | Provider CRUD + 模型勾选/协议/出口/测试/一键导入；sidecar 一键面板嵌在此页（`Providers.vue:79-100`） |
| Accounts | 按源分组的账号池 + 健康（绿/琥珀/红）/测试/重置（`Accounts.vue`） |
| Discover | 本机 harness 扫描采用 + 共存登录态导入 + sidecar 管理（`Discover.vue`） |
| Projects | 本机项目一键启停 / 端口冲突 / 日志 / AI 录入（`Projects.vue`） |
| Login | 管理口令登录（`App.vue:49`） |

管理面 REST（`/admin/api/*`，`adminapi/api.ts:createAdminApi`，错误形状 `{error:{type,message}}`，未接线依赖对应端点 501）：

- egresses：`GET /admin/api/egresses`，`PUT /admin/api/egresses/:id`（body `{kind:http|https, addr}`），`DELETE`（`api.ts:146-170`）。
- providers：`GET` 列表，`POST` 新建（`parse.ts` 收敛解析 + `providerValidate`，冲突 409），`PATCH /:id`（白名单 `enabled/priority/streamOnly/displayName/riskNote/credential/models/probeModel/egress/headers`，models 只增不减，headers 整包替换/空对象清空），`DELETE /:id`（builtin 禁删 403，成功 204）。
- accounts：`GET /admin/api/accounts`（DB + 池内冷却/连败合并，过期冷却复位），`POST` 新建（id/providerId 必填，归属 Provider 必须存在；重名 409；新建只许 available/disabled），`PATCH /:id`（白名单 status/displayName/credential/weight），`DELETE /:id`，`POST /:id/recheck`（零上游成本，只清惩罚），`POST /:id/test`（真实请求，可传 `{model}`，成功清冷却归零），`POST /:id/checkin`（WorkBuddy 自动登录：账号页「签到」按钮，只认一键导入/import-account 打标的 importSource=workbuddy 账号；用导入登录态调上游每日签到，一天一次，不自动重试）。
- 模型：`POST /providers/:id/test`（最小真实请求），`POST /providers/:id/scan`（探到协议写回），`POST /providers/:id/refresh-fingerprint`（Zen 指纹刷新：读本机新鲜会话写回静态头；本地无新鲜会话时返回 next 重登指引，见 `discover/zen_refresh.ts`），`PUT /providers/:id/models/:model/{protocol,egress,note,enabled,reasoning-min-tokens}`（note 限 200 字，空串删字段；reasoning-min-tokens 为高档位最低预算，只管 xhigh/max 两档，值域 1-200000，`{}` 清掉整张映射），`DELETE /providers/:id/models/:model`（PATCH 删不掉故独立端点），`GET /providers/:id/models`（lister 报错转 502）。
- stats：`GET /admin/api/stats`（全量），`GET /admin/api/breakdown?days|since|until&account_id`（默认 365 天），`GET /admin/api/usage/accounts`（账号维度）。
- discover（`discover_api.ts`）：`GET /admin/api/discover`（未接线返回空列表），`POST /discover/adopt {key,id?}`（须 ready 否则 400，幂等），`POST /discover/import-account`（必填 key/tokenPath/accountId/credentialFile，服务端 0600 落盘，token 不经前端；workbuddy 导入打 `importSource` + uid + token 指纹标记，账号页才显示「签到」），`POST /discover/quick-import {key}`（全量导入存活登录态，同样打标记）。
- sidecar / projects 以 Hono 子应用注入（`api.ts:646-653`），未注入对应端点 501。

## 8. 自动发现：本机 harness（仅 3 项）

`Scanner.scan` 恒返回 4 项（国内版 / 海外版 WorkBuddy + ZCode + Zen），报告永不含密钥原文：

| key | 机制 |
|---|---|
| `workbuddy` | **WorkBuddy 国内版**。读桌面登录态文件候选路径（三平台路径表 `workBuddySearchPaths`，每目录展开两个版本的文件名，`CODEBUDDY_DESKTOP_AUTH_FILE` 可覆盖）：取 `auth.accessToken`，解 JWT exp 判 ready / expired / unknown（`checkWorkBuddy`）；多账号按目录扫 `workbuddy-desktop*.info` 全部共存登录态，按 **realm+UID** 去重取最新（`discoverWorkBuddyAccounts`）。模型无列表接口，正则扫 `traces/**/*.json` 的 `"models"` 字段。 |
| `workbuddy-ai` | **WorkBuddy 海外版**。与国内版**同源代码、分开成条**：两版认证域与 token 互不通用（见下「双版本」），必须各自采用成独立 Provider。 |
| `zcode` | 仅 `statSync` 安装目录存在即 unknown（`checkZCode`，`zCodeSearchDirs`）；登录态无法本地判定，指引走 OAuth。 |
| `opencode-zen` | 连通探针 `GET {base}/v1/models` 带 `Bearer public`（`checkZen`），200 即 ready；默认 `https://opencode.ai/zen`。 |

### WorkBuddy 双版本（国内版 / 海外版，2026-09-19 真机实测）

桌面端两个发行版的**登录态文件、认证域、上游都不同，token 互不通用**：

| 版本 | 登录态文件 | realm（JWT `iss` / `auth.domain`） | 上游 | 额外约束 |
|---|---|---|---|---|
| 国内版 | `workbuddy-desktop.info` | `www.workbuddy.cn` | `copilot.tencent.com/v2` | 无 |
| 海外版 | `workbuddy-desktop-ai.info` | `www.workbuddy.ai` | `www.workbuddy.ai/v2` | **首条消息必须是 system prompt** |

- **realm 判定**（`detectRealmFromAuth`）：优先读 `auth.domain`，回落 JWT `iss`；两者都认不出时返回 `undefined`——**绝不默认成国内版**（默认成 cn 正是把海外号打错域的根因）。
- **认证域由 realm 派生**（`wbSuggestedProvider(realm)`）：`baseUrl` / `X-Domain` 按版本生成，Provider 名分开（`workbuddy` / `workbuddy-ai`）。把海外版 token 打到 `copilot.tencent.com` 会被前置 APISIX 拦成 HTML 401「Authorization Required」——看起来像账号失效，实际只是域名不对。
- **账号池按版本隔离**：`importSource` 是判重分区键（`workbuddy` vs `workbuddy-ai`），两版的号互不认、各自编号（`workbuddy-N` / `workbuddy-ai-N`）。导入时 `realmMismatch` 守卫拒绝跨版本入池（入池后才发现就晚了——它会被轮询到，请求才 401）。
- **海外版 system 打头**：由 `ensureWbAiSystemFirst` 在转发侧兜住（缺则补一句最小中立 system；客户端已有则一字不改）。国内版无此约束，**不得**对它注入——判定按 host（`isWorkBuddyAiBaseUrl`）。
- **签到仅国内版**：`POST /accounts/:id/checkin` 打的是 `copilot.tencent.com/billing/meter/daily-checkin`，只认 `importSource === 'workbuddy'`，海外版账号不显示该按钮。

一键导入的 Provider 草稿：WorkBuddy **按版本两份**（国内版 `workbuddy` → `copilot.tencent.com/v2`；海外版 `workbuddy-ai` → `www.workbuddy.ai/v2`，均为 openai-completions，`headers X-Product/X-Domain` 随版本派生，模型目录留空由导入时扫描补全）与 Zen（`zen-auto`，openai-completions，`zen/v1`，会话头 `x-opencode-session`/`x-opencode-request`（+ 兼容旧 `x-session-id`/`x-session-affinity`），模型 `mimo-v2.5-free` / `nemotron-3-ultra-free`）——见 `discover/index.ts wbSuggestedProvider`。注意：① `x-opencode-*` 四件套是官方客户端本来就发的（2026-09-18 真机取证；旧“毒头”结论已推翻，见 `router/upstream.ts applyZenFingerprint`），上游 2026-09 起要求 `x-opencode-session`，网关按取证原样发送，会话过期由指纹刷新自动续（`discover/zen_refresh.ts`：转发失败自愈重试 + 启动刷新 + 管理台手动刷新；本地无新鲜会话如实返回重登指引）；② UA 网关不内置版本号（通用项目不写死个人环境版本）：opencode 做客户端时透传它的真 UA，其他客户端配 Provider 静态头或 `ZEN_UA` 环境变量，优先级 静态 > 透传 > `ZEN_UA`，全无则如实不发。

### 免费档限流口径：按**会话**而非 IP（2026-09-18 实测修正）

历史文档写「免费档按 IP 限速」，**结论有误，已推翻**。取证：

- 同一会话连打十轮 xhigh 必 429（`rate_limit_exceeded`）；
- 本机 opencode 开多个窗口（每窗口一个新会话）同 IP 打出同一模型，一点事没有；
- 网关连发 429 时，换个 `x-opencode-session` 立即恢复。

两侧出口同为 `clash` 代理（同一 IP），故限流维度是 `x-opencode-session`。

**网关对策（会话池轮换）**：

- 池载体 `x-polycode-session-pool`（网关自定义内网头，上游不认识）：`discover` 从本机 opencode 日志收**全部**真实会话，**新→旧**排列，最多 16 个（`ZEN_POOL_MAX`）写入——越新的会话配额窗口越干净（`parseAllFingerprintsFromLog` / `discoverAllOpenCodeFingerprints`，`parseZenSessionPool` / `writeZenSessionPool`）。
- 轮询首打：每个请求用池游标取首打会话并前移（`takeNextZenSession`），池内会话均摊，不再每请求都打池首。
- 配额 429（`rate_limit`）才换会话：在本请求副本内按序换下一个没试过的重试，有界（min(池长,4)），同一会话不打第二遍；池头在发往上游前剥掉，永不上 wire；副本隔离，并发请求互不污染库内 Provider。池长为 1 时无会话可换，429 原样上报。
- QUOTA（402 / 额度用尽，如 quota/insufficient_quota/余额不足）不轮换，直接抛：充值前换谁都没用。
- 网络抖动 / 上游 5xx 才记失败：15s 窗口内累计 3 次淘汰该会话，并从本机日志取新会话补位写透到库；淘汰有时效（TTL，到期后若刷新仍在库池内则重纳）；成功一次清掉该会话失败计数。
- API 类错误（AUTH / FINGERPRINT / REGION / BAD_REQUEST）直接抛，不重试不淘汰。
- 实测：配额 429 换会话立即恢复（429 转成功）。

**运维含义**：会话是稀缺资源（一次 `opencode run` 产一个）。本机跑过的客户端越多，池越厚、越抗限流；长期不开客户端则池停止更新，旧会话配额窗口会越用越紧——届时跑一次 `opencode run "hi"` 再刷新指纹即可续上。

## 9. 用量统计口径

SQLite 持久化（`usage/store.ts`，schema v2，`user_version` 前向迁移，建表恒最新、缺列 ALTER 且幂等，`:1-8`）。硬规则：`cacheRead / cacheCreation` 独立字段存储，绝不混入 input；accuracy 原样保存，估算值仅展示不可计费；P0 不记金额（`:2-4`）。

- **total**：`totalOf`，`total = input + output`（上游 wire 总量；reasoning 已含 output 不重复计；cacheCreation/miss 是 input 子集不另加；读时重算不读存量列）。
- **TPS**：总输出 / 总“生成段”耗时（tok/s）。SQL：`avgTps = SUM(守卫内 output) * 1000 / SUM(守卫内 latency_ms - first_token_ms)`，分母已扣 TTFT（decode 段）。守卫：`status='ok' AND stream=1 AND first_token_ms>0 AND latency_ms>first_token_ms`（缺失字段行被排除）；无样本时 `avgTps / avgTtftMs` 为 null，前端显示 —（`usage/store.ts:58-63,347-364`，`Dashboard.vue:412-420`）。
- **缓存命中率**：`hitRate = read / input`（缓存命中 / 总输入；OpenAI 系 input 已含 cached，`usage/store.ts`），无输入返回 null；零命中源计入分母。总量公式见 `ir/types.ts usageTotal`。
- **账号维度**：哪个号被限额一眼认出（`usage/store.ts:72-96 AccountUsage`：requests / errors / errorRate / byKind{quota/rate_limit/auth/…} / tokens / lastErrorAt / models 明细）。

## 10. ZCode sidecar（本地引擎托管，胶水层）

合规边界：上游工具无 LICENSE（默认保留所有权利），本项目不分发、不捆绑、不复制其代码——只做“下载官方 release → 生成安全配置 → 进程管理”（`sidecar/sidecar.ts:1-6`）。

- `Sidecar` 句柄（`sidecar.ts:111-127`）：二进制缺省 `~/.polycode-hub/bin`，数据 `~/.zcode-proxy`，网关侧凭据引用 `config/credentials/zcode-proxy-key`（`cli.ts:137`），端口缺省 8080，工作目录 `config/zcode-proxy`（`cli.ts:138`）。
- 真实功能：`install [--force]`（下载 GitHub release `TriDefender/zcode-api`，按平台选资产名，已存在跳过，`:132-160`）；`setupConfig`（写 127.0.0.1 + 24 字节 hex 随机 `sk-local-` key + start-plan，凭据 0600 落盘，`:167-188`）；`setPort/loadPort`（改/恢复 config.yaml port 行，端口 1024-65535，`:196-218`）；`start`（分离进程，日志 `logs/sidecar.log`，45s 探活，`:222-238`）；`stop`（按进程名 kill，`:256-270`）；`running`（打 `127.0.0.1:port/health` 带 key，`:274-288`）；`status`（running/installed/stopped/not installed）；`login`（仅交互提示并 spawn 二进制 `auth login zai`，不代持，`:315-331`）；`ensureReady`（装→配→起，下载断点续传+重试上限 60 次）；`uninstall`（删二进制+key+config，运行时拒绝）。
- HTTP 仅 `POST /:action=start|stop|setup|uninstall|ensure|port|endpoint` + `GET /` 状态（`sidecar_app.ts:44-64`）；`install / login` 走 CLI 不进 HTTP（`:60-61,169-171` 明示）；`endpoint` 只改 Provider baseUrl 且仅回环 host（`:133-168`）。
- **下载代理（复用项目 egress 配置，不写死地址）**：release 查询与二进制下载都走 `resolveSidecarDownloadFetch`（`sidecar/httpproxy.ts`）决议出的 fetch，优先级：`--proxy` 显式值 → 显式 `--egress <id>` / `?egress=<id>`（不存在或不支持**点名抛错**，不静默换出口）→ Provider `zcode-plan-local` 的 `egress` 引用（脏引用 lenient 跳过）→ egress 表**仅一项时自动采用**（多个不猜，避免送错出口）→ `HTTPS_PROXY`/`ALL_PROXY` 环境变量 → **系统代理** → 直连。只认 http/https（ProxyAgent 不支持 socks5，Clash 混合端口用其 http 端口；命中 socks5 时**明确告警**并说明回落直连，不静默）。
  - 系统代理：darwin 读 `scutil --proxy`；**windows 读注册表 `HKCU\…\Internet Settings` 的 `ProxyEnable`+`ProxyServer`**（`readWinSystemProxy` / `parseWinProxySetting`，认 `http=…;https=…;socks=…` 分协议形态与单值 `host:port` 两种写法，https 优先）。
  - Windows 这段是后补的**真实缺陷**：早先只有 darwin 分支，而 Windows 进程环境里通常没有 `HTTPS_PROXY`，于是代码判定「直连」——同一台 Clash、同一个网络下表现为「macOS 装得上、Windows 永远装不上」。实测（2026-09-19）本机 `ProxyEnable=1`、`ProxyServer=http=127.0.0.1:7897;https=127.0.0.1:7897;socks=127.0.0.1:7897`，旧代码完全没用上。
- **下载断点续传（`install` 内）**：87MB 的 Windows 产物实测在弱网/代理下约 20 秒就被 `ECONNRESET` 掐断一次。旧实现每次重试都从 0 重下，进度条永远爬不到头。
  - 已收到的字节**边收边写 `<dest>.part`**，断线后带 `Range: bytes=<已收>-` 续传（实测 GitHub release 资产支持 Range：206 + `accept-ranges: bytes`）。
  - 服务端若不认 Range 而回 200，必须**截断重写**——追加会把两遍数据拼成错位文件。
  - 重试上限 60 次仅作防死循环兜底；4xx（资产被删 404 / 被限流 403）**立即失败不重试**。
  - `Content-Range` 参与总数换算：续传时 `Content-Length` 只是剩余长度，拿它当总数会画出「快满了其实才一半」的假百分比。
  - 摘要不符、`allowUntrusted=false`、`uninstall` 三处都会清掉 `.part`，避免下次从一段来路不明的数据中间接着写。
  - `ensureReady` 不再自套「重试 3 次」的外层循环：那层循环会让每次重进 `install` 都丢掉续传成果，正是「永远装不完」的由来。
  - 管理面 `GET /` 与 `ensure` 回执都带 `downloadProxy`（**脱敏**，密码位打码）/`downloadProxySource`；`ensure` 失败时把「走了哪个代理 + 来源」写进错误信息——首次要下 ~66MB，直连卡住时不能再只给一个转圈的「安装中…」。
  - 代理实现复用已有依赖 `undici` 的 `ProxyAgent`（与转发面同源，不新增依赖）；CLI 侧不再用 `setGlobalDispatcher` 全局污染（那是进程级副作用，改为按次注入 fetch）。
  - 实测（2026-09-18，本机 egress `clash`=127.0.0.1:7897）：release `v4.6.7` / `zcode-proxy-darwin-arm64` 63.4MB 经代理下载成功，约 1.0 MB/s。修复前管理台 `ensure` 走全局 fetch 直连，同一网络下必然长时间卡住。
- **平台口径（易错点）**：`assetName()` 吃的是 **Go 的 GOOS**（`darwin`/`linux`/`windows`），而 Node 的 `process.platform` 在 Windows 上是 `win32`。两者必须在边界处经 `normalizeGOOS()` 归一。历史缺陷：`install()` 直接把 `process.platform` 传进去，Windows 恒抛「平台 win32/x64 无预编译产物」——**从来就装不上**，且与网络无关（在下载之前就返回了）；旧测试全用 `goos:'windows'` 显式传参，恰好绕开了真实入参路径所以没暴露。Windows 资产是单一构建 `zcode-proxy.exe`（不带架构后缀，v4.6.7 为 87.1MB），arm64 靠系统仿真运行。
- OAuth（`zcodeauth/index.ts`）：`TOKEN_BASE https://zcode.z.ai` / `LOGIN_BASE https://api.z.ai`；`startFlow`（`POST …/oauth/cli/init` 拿 flowID/authorizeURL）→ `pollFlow`（`GET …/poll/{flowID}` 等 ready，5 分钟有效）→ `resolveBusinessToken`（`POST …/api/auth/z/login` 换 business JWT）；JWT 只打印不落盘。

## 11. 本地项目管理器（与代理链路解耦）

- 功能：手动录入项目/服务，一键启停、端口冲突检测、经用户同意的端口映射、最长运行时长自动关闭（`projects/store.ts:1-3`）。
- 数据：定义 `config/projects/projects.json`、运行状态 `config/projects/projects-state.json`（`projects/store.ts:96-102`，dir 由 `cli.ts:142` 传入）、日志 `config/projects/logs/<projectID>-<service>.log`（`projects/store.ts:48-50`，追加写 + 启动分隔线）。日志读取是 1k 条滑动窗口：`readTailLines` 从文件尾按 64KB 块往前扫（`projects_app.ts`），Vite 热更新刷出几十万行也不全量进内存；前端弹窗默认拉 1000 条、贴底跟随、往上滚自动暂停跟随、可选 2s 自动刷新。定义缺失 = 空表不报错；损坏 = 报错（不能静默当空表，否则后续 save 覆盖用户数据，`:52-71`）。
- Service 定义（`projects/store.ts:10-24`）：name / dir / cmd / port（0 = 非网络服务，跳过端口检测）/ portEnv（端口映射方式，缺省 = 端口写死）/ maxRuntimeHours（0/缺省 = 不自动关闭）。
- 启动：端口被占返回 `ConflictError`（API 转 409），带 suggested/remappable（仅 portEnv 已声明的服务可映射）；`startProject` 冲突不阻断其余服务；`stop` 幂等；`restart = stop + start`；巡检每 60s 一次（`cli.ts:186`），超时 kill 留便签 + 死进程清账（`manager.ts:275 sweep`）。
- 端口检测：`process.ts:portBusy:134-147`（TCP 连 127.0.0.1 探监听）、`portOwner:159-175`（lsof/netstat 查占用者）、`freePort:150-155`（从 port+1 找 100 个）、`portPids/killPort`（按端口查 pid 并停掉外部进程；网关自身端口拒绝停）。
- HTTP（`projects_app.ts`，挂载前缀 `/admin/api/projects`）：`GET /` 列表，`POST /` 新建，`PUT /:id` 替换，`DELETE /:id`（先停再删），`POST /:id/start|stop`，`POST /:id/services/:sid/start|stop|restart`（冲突 409），`GET /port-owner?port=`，`POST /port-kill {port, confirm:true}`（停外部占用进程，前端「端口被占用」标签点击二次确认后调用），`POST /open`，`GET /browse|readmes|default-model|reminders`，`POST /ai-fill`（经本网关 chat/completions），`GET|DELETE /:id/logs?service&tail`（默认 tail 1000，上限 5000，环形读只扫尾部块；返回 {log, tail, truncated}）。

## 12. 出口代理（egress）

- EGRESS-SPIKE 方案 A，模型级粒度：Provider 引用 id，未引用 = 直连（`config/index.ts:33-39`）。v1 仅 http/https 代理（undici ProxyAgent 不支持 socks5；Clash 类混合端口用 `http://`，`router/upstream.ts:17-23 egressProxyURI`）。
- 定义：顶层 `egresses: [{id, kind, addr}]`；Provider.egress / Model.egress 引用（模型级覆盖 Provider 级，未声明继承，`proxy.ts:201-202,295-296`）。
- 热更新：管理面增删后 `setEgresses` 换表并丢弃旧 dispatcher 缓存（`upstream.ts:56-60`）；请求按 Provider.egress 选 dispatcher，懒建缓存（`:62-73`）。

## 13. 开发与测试

```bash
npm run setup   # 装两份依赖 + 构建前端，首次跑一次（package.json scripts）
npm start       # 日常启动（tsx server/src/cli.ts serve）
npm run dev     # 后端热重启（tsx watch）；前端另开 npm run dev --prefix web（HMR，/admin/api 代理给 :3000）
npm test        # 全量测试（vitest，server/test/**/*.test.ts，vitest.config.ts；node:sqlite 显式外置）
npm run typecheck  # tsc --noEmit
```

- 改 `web/` 下任何东西都要重新构建（`npm run build --prefix web`），否则网关托管的还是旧 `web/dist`；开发时用前端 HMR 例外。
- `EADDRINUSE`：3000 已被占用，通常另有一个实例在跑；先 `curl -sf -o /dev/null http://127.0.0.1:3000/admin/` 确认是否健康，健康直接用。
- 工程结构：`cli.ts`（入口）/ `config/`（YAML 严格解析）/ `gateway/`（HTTP 挂载、/v1/* 路由、管理台托管）/ `router/`（调度：候选排序、模型匹配、上下文预检）/ `pool/`（账号池轮询 + 冷却）/ `ir/`（中间表示）/ `codec/`（三协议解析/序列化）/ `model/`（类型与校验）/ `adminapi/`（管理台 REST）/ `usage/`（用量 SQLite）/ `projects/`（本地项目管理器）/ `sidecar/`（ZCode 本地引擎托管）。

## 14. 约束（改代码前必读）

- **换源闸门**：首字节前可换源，首字节后绝不换源（`router/upstream.ts:1-4`）。
- **上下文预检**：只拒绝 + 换源，绝不截断（`router/scheduler.ts:82`）。
- **凭据不落明文**：只引环境变量名或 `config/credentials/` 下的文件（`config/index.ts:1-2`）。
- **许可证边界**：本项目 MIT，不得混入 AGPL/GPL 系代码（NOTICE.md §二·补）；`zcode2api`（AGPL-3.0）只读不抄。
- **Provider 身份拆成两半**：`providerId`（自增数字，永不变，账号归属与用量归因按它走）+ `name`（对外名 = 模型 ID 前缀，可改）。改名只动 name，旧前缀立即失效但报错明确（`unknownProviderMessage`）。
- **Provider 三态**：`active`（参与路由）/ `paused`（开关关掉，仍占名）/ `deleted`（软删，名字释放可复用，历史用量仍可回溯）。新增时空缺名只允许复用 `deleted` 的名字。
- baseURL 停在操作路径之前；一个 Provider 只说一种协议（`config/apps.example.yaml:4-11` 硬规则）。
- **未声明 models 的 Provider 视为透明代理**，接受任意模型（`scheduler.ts:36-40`）。
- **手填模型默认纯文本**：`input` 缺省 `['text']`（`config/index.ts:271`）；支持图片须显式声明，未声明时发出请求前拒绝并点名。
- **失败账**：全部候选失败记一笔 tokens 为 0 的失败账，这是流式失败唯一的落账点（`proxy.ts:246-258`）。
- **高档位最低预算**：模型 `reasoning_min_tokens: {"xhigh": 128000, "max": 200000}`（`PUT /admin/api/providers/:id/models/:model/reasoning-min-tokens`，值域 1-200000）。只管 xhigh/max 两档、只托底不封顶——客户端值低于该档下限时抬到下限（防推理吃光预算导致截断/无工具），高于下限或没给值时不动，其他档位一律不动；探针同样走下限，避免把“预算不足”误报成“源不可用”。托底时记 `[floor]` 日志，入站原文记 `[inbound]` 日志（含 `maxTokens/tools/toolChoice/reasoning`，不记正文）。

## 15. 许可证

MIT（见 `LICENSE`）。
