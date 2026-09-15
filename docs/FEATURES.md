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
| GET | `/v1/models`、`/models` | 模型目录，OpenAI `{"data":[{id}]}` 形态，id 为限定名 `sourceId/modelId`（`proxy.ts:144-158`）；受 `gateway_key` 校验（`proxy.ts:146-149`，失败 401） |
| GET | `/health` | 健康检查，返回 `{ok:true, apps:N}`，N = 启用中的 Provider 数（`proxy.ts:139-142`）；**不鉴权**（注释 `proxy.ts:133-135`） |

- **流式 / 非流式**：都支持。非流式走整体 JSON（`proxy.ts:353-378`）；流式走 SSE（`Content-Type: text/event-stream`，`proxy.ts:540-547`）。
- **client 接入示例**：`export ANTHROPIC_BASE_URL=http://localhost:3000`（README 实测口径）；client 未指定 model 时用 `gateway.default_model` 兜底（`proxy.ts:176`）。
- **网关自身鉴权**：`gateway_key` 为空 = 不校验；非空则转发面三端点与模型目录要求 `Authorization: Bearer <key>` 并做恒时比较（`proxy.ts:36-43 bearerMatch`，`proxy.ts:164-167`）。

## 3. 三协议与 IR 中间表示

- **支持的协议**：`anthropic-messages` / `openai-completions` / `openai-responses`（协议表 `ir/index.ts:5-9`）。
- **转换方式**：统一经 **IR 中间表示**中转——3 个入站解析器 + 3 个出站序列化器，不做 N×N 两两直转（`ir/codec.ts:2`）。三 codec 均双向注册：`codec/anthropicmessages.ts:642-643`、`codec/openaicompletions.ts:969-970`、`codec/openairesponses.ts:1074-1075`。
- **IR 词汇表**以 Anthropic Messages 为基准（`ir/types.ts:1-3`）：`IrRequest` 字段见 `ir/types.ts:50-62`（model / system / messages / tools / toolChoice / maxTokens / temperature / topP / stopSequences / stream）；Block 类型 `text | image | tool_use | tool_result | thinking`（`ir/types.ts:8`）；图片源 `base64 | url`（`ir/types.ts:10-16`）；流事件以 Anthropic SSE 事件集为规范形态（`ir/types.ts:105-130`）。
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
4. 限定名：`sourceId/modelId` 形态，仅当前缀是已知 sourceId 时才视为限定（`splitModelRef:18-26`）；上游只认裸模型名，网关在转发前剥前缀（`proxy.ts:185-187`）。
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

- 同源轮询（`pick:36-44`）；Provider 白名单（`accountIds`）按名单轮询（`pickFrom:49-60`）；无可用抛 `ErrNoAccount`（`:11-14`），调度据此换源/报错，不静默等待。
- `markResult:69-93`：成功且有惩罚时清零落盘；失败 `fails++`，kind=quota → `exhausted`（**不设到期时间，只认人工“重置”或一次成功的测试**，`pool/account.ts:84-87`），其余 → `cooldown` + 到期时间。
- `hasFor:30-32` 区分“该源无账号 → 走 Provider 级凭据”与“有账号但全冷却 → 跳过该源”。
- 冷却到期自动复位（`eligible:128-140`）；`exhausted` 永不自动恢复（`model/index.ts:200-203`）。
- 惩罚落盘：`fails / cooldownUntil` 写回 `admin.db`，重启不失忆；`exhausted` 必须把 status 一起写进去，恢复时再抹回 available（`cli.ts:104-118` 回写规则注释）。
- 健康度（纯派生，不落盘，`model/index.ts:205-218`）：绿=健康、琥珀=冷却中或连败 ≥ 3 次（`FAILS_WARN_AT=3`）、红=disabled / exhausted。
- **指定账号头** `x-polycode-account`（`proxy.ts:190-192,268-321 servePinned`）：钉死指定账号，不轮询、不换号；账号不存在→404、source 不匹配→400、冷却中→429、不在 Provider 白名单→400。

### 协议自动识别

- 解析顺序：模型级 `api` → 进程内事实缓存 → Provider 默认 `api`（`resolveProtocol`，`upstream.ts:316-323`）；三者皆无时逐个试候选协议，首个成功者被记住（`upstream.ts:113-123`，`rememberProtocol`）。
- 事实缓存：进程内 Map，key = `providerID + modelID`（`model/autoproto.ts:7-30`）；已知协议失败且错误值得换协议（仅 server / network / bad_request，401/403/404 不换）时丢弃重探（`shouldTryOtherProtocol:333-336`）。
- 管理台“扫描可用性”：并发打最小真实请求（`maxTokens: 16`，`probe.ts:235-239`），单模型超时 90s、最多 3 次（`probe.ts:55-57`，仅 rate_limit / quota / server / network 可重试，批量并发 4），成功后把协议写回模型目录持久化。

## 5. 配置：YAML 严格模式与凭据

- **配置文件**：`config/apps.yaml`（本机正式配置，git 忽略）；模板 `config/apps.example.yaml`（171 行，v0.4 口径）。`POLYCODE_CONFIG` 可覆盖路径（`cli.ts:72`）；文件不存在 → 全默认零配置启动（`config/index.ts:50-54`）。
- **gateway 真实字段**（`config/index.ts:18-31`）：`host`（缺省 `127.0.0.1`）、`port`（缺省 3000）、`admin_key`、`gateway_key`（空=不校验）、`default_model`、`risk_max`（low/medium/high，缺省 high=不过滤）、`precheck_context`、`first_byte_timeout_ms`、`stream_idle_timeout_ms`。启动参数 `--port` 可覆盖端口（`cli.ts:73-80`）。
- **Provider 真实字段**（`config/index.ts:105-126`）：`id`（只允许小写字母/数字/连字符，永久不可改，`model/index.ts:150-152`）、`source_id`、`display_name`、`access_kind`（official/session-reuse/simulated-login/reverse）、`risk` + `risk_note`（medium/high 必填，`model/index.ts:157-159`）、`stability`、`api`（空=自动探测）、`base_url`（anthropic-messages 停域名根由网关拼 `/v1/messages`，openai 两种停 `/v1`，`upstream.ts:392-405` 有去重 `/v1` 逻辑）、`credential`、`headers`、`dynamic_headers`（绝对路径命令，不走 shell，缺省超时 8000ms）、`enabled`、`priority`、`stream_only`、`tags`、`models`、`probe_model`、`egress`、`account_ids`（绑定账号白名单）。
- **严格模式**：未知字段直接抛错拒绝启动（`config/index.ts:173-184 strictMap`，含 jwt/token 等明文凭据字段亦拒，注释 `:1-2`）；跨实体校验 source 引用 / egress 引用 / 重复 id / 端口范围（`:281-315`）。示例文件本身有测试保证可解析。
- **凭据不落明文**：只存引用 `api_key_env`（环境变量，改值需重启）或 `api_key_file`（`config/credentials/` 下文件，**改内容即热轮换**，每次请求现读，`model/index.ts:34-47`）；无凭据返回 `['', true]` 即公开端点。管理面写凭据文件限定在 `config/credentials/` 下（`adminapi/discover_api.ts:40-42`）。
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
| `zcode sidecar <动作>` | 本地引擎管理：`install / setup / start / stop / status / login / ensure`（缺省 `ensure`，`cli.ts:271-320`）；`install` 支持 `--proxy <url>` / `--force`，无值读 `HTTPS_PROXY`（`:277-291`） |

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
- providers：`GET` 列表，`POST` 新建（`parse.ts:53-97` 收敛解析 + `providerValidate`，accountIds 须存在且同 sourceId，冲突 409），`PATCH /:id`（白名单 `enabled/priority/streamOnly/displayName/riskNote/credential/models/probeModel/egress/accountIds`，models 只增不减，`api.ts:43-47,199-305`），`DELETE /:id`（builtin 禁删 403，成功 204）。
- 模型：`POST /providers/:id/test`（最小真实请求），`POST /providers/:id/scan`（探到协议写回），`PUT /providers/:id/models/:model/{protocol,egress,note,enabled}`（note 限 200 字，空串删字段），`DELETE /providers/:id/models/:model`（PATCH 删不掉故独立端点），`GET /providers/:id/models`（lister 报错转 502）。
- accounts：`GET /admin/api/accounts`（DB + 池内冷却/连败合并，过期冷却复位），`POST` 新建（id/sourceId 必填，新建只许 available/disabled），`PATCH /:id`（白名单 status/displayName/credential），`DELETE /:id`，`POST /:id/recheck`（零上游成本，只清惩罚），`POST /:id/test`（真实请求，可传 `{model}`，成功清冷却归零）。
- stats：`GET /admin/api/stats`（全量），`GET /admin/api/breakdown?days|since|until&account_id`（默认 365 天），`GET /admin/api/usage/accounts`（账号维度）。
- discover（`discover_api.ts`）：`GET /admin/api/discover`（未接线返回空列表），`POST /discover/adopt {key,id?}`（须 ready 否则 400，幂等），`POST /discover/import-account`（必填 key/tokenPath/accountId/credentialFile，服务端 0600 落盘，token 不经前端），`POST /discover/quick-import {key}`（全量导入存活登录态）。
- sidecar / projects 以 Hono 子应用注入（`api.ts:646-653`），未注入对应端点 501。

## 8. 自动发现：本机 harness（仅 3 项）

`Scanner.scan` 恒返回 3 项（`discover/index.ts:457-475`），报告永不含密钥原文（`:3`）：

| key | 机制 |
|---|---|
| `workbuddy` | 读桌面登录态文件候选路径（三平台路径表 `workBuddySearchPaths:46-70`，`CODEBUDDY_DESKTOP_AUTH_FILE` 可覆盖）：取 `auth.accessToken`，解 JWT exp 判 ready / expired / unknown（`checkWorkBuddy:151-198`）；多账号按目录扫 `workbuddy-desktop*.info` 全部共存登录态，按 UID 去重取最新（`discoverWorkBuddyAccounts:309-362`）。模型无列表接口，正则扫 `traces/**/*.json` 的 `"models"` 字段。 |
| `zcode` | 仅 `statSync` 安装目录存在即 unknown（`checkZCode:222-239`，`zCodeSearchDirs:87-91`）；登录态无法本地判定，指引走 OAuth。 |
| `opencode-zen` | 连通探针 `GET {base}/v1/models` 带 `Bearer public`（`checkZen:264-297`），200 即 ready；默认 `https://opencode.ai/zen`。 |

一键导入的 Provider 草稿：WorkBuddy（`wb-auto`，openai-completions，`copilot.tencent.com/v2`，`headers X-Product/X-Domain`，模型 `hy3-preview`）与 Zen（`zen-auto`，openai-completions，`zen/v1`，`x-opencode-*` 四头，模型 `mimo-v2.5-free` / `nemotron-3-ultra-free`）——见 `discover/index.ts:136-148,243-261`。

## 9. 用量统计口径

SQLite 持久化（`usage/store.ts`，schema v2，`user_version` 前向迁移，建表恒最新、缺列 ALTER 且幂等，`:1-8`）。硬规则：`cacheRead / cacheCreation` 独立字段存储，绝不混入 input；accuracy 原样保存，估算值仅展示不可计费；P0 不记金额（`:2-4`）。

- **total**：`totalOf`，`total = input + output`（上游 wire 总量；reasoning 已含 output 不重复计；cacheCreation/miss 是 input 子集不另加；读时重算不读存量列）。
- **TPS**：总输出 / 总“生成段”耗时（tok/s）。SQL：`avgTps = SUM(守卫内 output) * 1000 / SUM(守卫内 latency_ms - first_token_ms)`，分母已扣 TTFT（decode 段）。守卫：`status='ok' AND stream=1 AND first_token_ms>0 AND latency_ms>first_token_ms`（缺失字段行被排除）；无样本时 `avgTps / avgTtftMs` 为 null，前端显示 —（`usage/store.ts:58-63,347-364`，`Dashboard.vue:412-420`）。
- **缓存命中率**：`hitRate = read / input`（缓存命中 / 总输入；OpenAI 系 input 已含 cached，`usage/store.ts`），无输入返回 null；零命中源计入分母。总量公式见 `ir/types.ts usageTotal`。
- **账号维度**：哪个号被限额一眼认出（`usage/store.ts:72-96 AccountUsage`：requests / errors / errorRate / byKind{quota/rate_limit/auth/…} / tokens / lastErrorAt / models 明细）。

## 10. ZCode sidecar（本地引擎托管，胶水层）

合规边界：上游工具无 LICENSE（默认保留所有权利），本项目不分发、不捆绑、不复制其代码——只做“下载官方 release → 生成安全配置 → 进程管理”（`sidecar/sidecar.ts:1-6`）。

- `Sidecar` 句柄（`sidecar.ts:111-127`）：二进制缺省 `~/.polycode-hub/bin`，数据 `~/.zcode-proxy`，网关侧凭据引用 `config/credentials/zcode-proxy-key`（`cli.ts:137`），端口缺省 8080，工作目录 `config/zcode-proxy`（`cli.ts:138`）。
- 真实功能：`install [--force]`（下载 GitHub release `TriDefender/zcode-api`，按平台选资产名，已存在跳过，`:132-160`）；`setupConfig`（写 127.0.0.1 + 24 字节 hex 随机 `sk-local-` key + start-plan，凭据 0600 落盘，`:167-188`）；`setPort/loadPort`（改/恢复 config.yaml port 行，端口 1024-65535，`:196-218`）；`start`（分离进程，日志 `logs/sidecar.log`，45s 探活，`:222-238`）；`stop`（按进程名 kill，`:256-270`）；`running`（打 `127.0.0.1:port/health` 带 key，`:274-288`）；`status`（running/installed/stopped/not installed）；`login`（仅交互提示并 spawn 二进制 `auth login zai`，不代持，`:315-331`）；`ensureReady`（装→配→起，下载重试 3 次）；`uninstall`（删二进制+key+config，运行时拒绝）。
- HTTP 仅 `POST /:action=start|stop|setup|uninstall|ensure|port|endpoint` + `GET /` 状态（`sidecar_app.ts:44-64`）；`install / login` 走 CLI 不进 HTTP（`:60-61,169-171` 明示）；`endpoint` 只改 Provider baseUrl 且仅回环 host（`:133-168`）。
- OAuth（`zcodeauth/index.ts`）：`TOKEN_BASE https://zcode.z.ai` / `LOGIN_BASE https://api.z.ai`；`startFlow`（`POST …/oauth/cli/init` 拿 flowID/authorizeURL）→ `pollFlow`（`GET …/poll/{flowID}` 等 ready，5 分钟有效）→ `resolveBusinessToken`（`POST …/api/auth/z/login` 换 business JWT）；JWT 只打印不落盘。

## 11. 本地项目管理器（与代理链路解耦）

- 功能：手动录入项目/服务，一键启停、端口冲突检测、经用户同意的端口映射、最长运行时长自动关闭（`projects/store.ts:1-3`）。
- 数据：定义 `config/projects/projects.json`、运行状态 `config/projects/projects-state.json`（`projects/store.ts:96-102`，dir 由 `cli.ts:142` 传入）、日志 `config/projects/logs/<projectID>-<service>.log`（`projects/store.ts:48-50`，追加写 + 启动分隔线）。定义缺失 = 空表不报错；损坏 = 报错（不能静默当空表，否则后续 save 覆盖用户数据，`:52-71`）。
- Service 定义（`projects/store.ts:10-24`）：name / dir / cmd / port（0 = 非网络服务，跳过端口检测）/ portEnv（端口映射方式，缺省 = 端口写死）/ maxRuntimeHours（0/缺省 = 不自动关闭）。
- 启动：端口被占返回 `ConflictError`（API 转 409），带 suggested/remappable（仅 portEnv 已声明的服务可映射）；`startProject` 冲突不阻断其余服务；`stop` 幂等；`restart = stop + start`；巡检每 60s 一次（`cli.ts:186`），超时 kill 留便签 + 死进程清账（`manager.ts:275 sweep`）。
- 端口检测：`process.ts:portBusy:134-147`（TCP 连 127.0.0.1 探监听）、`portOwner:159-175`（lsof/netstat 查占用者）、`freePort:150-155`（从 port+1 找 100 个）、`portPids/killPort`（按端口查 pid 并停掉外部进程；网关自身端口拒绝停）。
- HTTP（`projects_app.ts`，挂载前缀 `/admin/api/projects`）：`GET /` 列表，`POST /` 新建，`PUT /:id` 替换，`DELETE /:id`（先停再删），`POST /:id/start|stop`，`POST /:id/services/:sid/start|stop|restart`（冲突 409），`GET /port-owner?port=`，`POST /port-kill {port, confirm:true}`（停外部占用进程，前端「端口被占用」标签点击二次确认后调用），`POST /open`，`GET /browse|readmes|default-model|reminders`，`POST /ai-fill`（经本网关 chat/completions），`GET|DELETE /:id/logs?service&tail`（默认 tail 200）。

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
- **Provider ID 永久不可改**（改名 = 新建 + 删旧）；baseURL 停在操作路径之前；一个 Provider 只说一种协议（`config/apps.example.yaml:4-11` 硬规则）。
- **未声明 models 的 Provider 视为透明代理**，接受任意模型（`scheduler.ts:36-40`）。
- **手填模型默认纯文本**：`input` 缺省 `['text']`（`config/index.ts:271`）；支持图片须显式声明，未声明时发出请求前拒绝并点名。
- **失败账**：全部候选失败记一笔 tokens 为 0 的失败账，这是流式失败唯一的落账点（`proxy.ts:246-258`）。

## 15. 许可证

MIT（见 `LICENSE`）。
