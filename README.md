# polycode-hub

[![Version: 0.1.0](https://img.shields.io/badge/version-0.1.0-orange)](package.json) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node.js >= 22.13](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?logo=node.js&logoColor=white)](package.json) [![Tests](https://img.shields.io/badge/tests-463%20passed-brightgreen)](#开发) [![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript&logoColor=white)](tsconfig.json)

> 你手上有五六个编程 Agent，每个都给你一点免费额度。它们互不相识，也不会在你额度耗尽时互相帮忙。于是你成了那个手动换号的人。

多源 Coding Agent 免费额度**统一反代网关**：把 ZCode / OpenCode Zen / WorkBuddy 的免费额度拧成一股，对外只暴露一个入口，背后谁有额度就用谁。

**额度耗尽自动换源。** 这是它存在的全部理由。

## 立场

**接受免费 token ≠ 我同意。**

免费额度常常绑着自家 harness 一起发：领了你的 token，就得用你的客户端、用你的姿势干活。这笔绑定我不认——额度是额度，工具是工具。我想用哪个 harness，就用哪个 harness；你发你的额度，我选我的入口，两不相欠。上游要改就改、要限就限，网关会自动换下一个有额度的。上了这个网关的上游同样如此：接进来用，不代表认同，更不代表独占。

---

## 功能

- **一个入口，多源调度**：上游谁有额度就用谁，额度耗尽首字节前自动换下一个（首字节后绝不换源，不拼接胡话）
- **三种协议都吃**：`POST /v1/messages`（Anthropic）、`POST /v1/chat/completions`（OpenAI Chat）、`POST /v1/responses`（OpenAI Responses），流式与非流式均可，经 IR 中间表示中转
- **协议自动识别**：`api` 留空即自动探测，首次成功后记住；管理台「扫描可用性」可批量实测并写回
- **账号池**：同源轮询，按失败原因冷却（限流 60s / 额度用尽 600s / 鉴权 1800s）；额度用尽只认人工重置或一次成功的测试
- **管理台**：`http://127.0.0.1:3000/admin/` —— 配 Provider、导账号、看用量、管项目
- **账号健康度**：绿 / 琥珀 / 红一眼看清连败与额度见底，不用翻日志
- **本机发现**：自动扫描 WorkBuddy 登录态、ZCode 安装、OpenCode Zen 连通，点一下完成「采用 Provider + 账号入池」
- **用量统计**：SQLite 落盘；TPS 缺样本显示 `—`，不假装 0

完整行为说明（含全部 REST 端点、调度细节、转换丢弃点、口径公式）见 [`docs/FEATURES.md`](docs/FEATURES.md)，每条均可在 `server/src/` 找到对应实现。

---

## 架构

![polycode-hub 架构图](docs/architecture.png)

矢量版 [`docs/architecture.svg`](docs/architecture.svg)，图源文件 [`docs/polycode-hub.architecture.json`](docs/polycode-hub.architecture.json)（由 [archify](https://github.com/tt-a1i/archify) 生成；另有可搜索/缩放的可交互版本，体积较大，故未入库）。

---

## 快速开始

前置要求：Node.js **≥ 22.13**（用了 `node:sqlite`；低于此版本起不来）。检查 `node -v`。

以下命令均在**仓库根目录**（含 `package.json` 与 `server/` 的那一层）执行：

```bash
npm run setup   # 装两份依赖 + 构建前端，首次跑一次
npm start
```

启动成功会打印监听地址，浏览器打开 **<http://127.0.0.1:3000/admin/>** 即可。

| 场景 | 命令 |
|---|---|
| 日常启动 | `npm start` |
| 改后端代码自动重启 | `npm run dev`（`tsx watch`） |
| 后台常驻 + 改完前端一键重启 | `./update.sh`（构建前端 → 重启进程 → 健康检查，日志在 `data/gateway.log`） |

> 运行时只有**一个服务、一个端口**：网关进程自己托管前端构建产物 `web/dist`，所以**改了 `web/` 下任何东西都要重新构建**（`npm run build:web`），否则页面还是旧的。开发时例外，见[开发](#开发)。
>
> **`web/dist` 不入库**（与 Java 的 `target/` 同口径：要用就自己打包）。clone 后**必须先 `npm run setup`**，否则服务照常启动、API 照常可用，但 `/admin` 全 404——启动日志会打一条「前端产物缺失」警告提醒你。仓库里只留前端源码，产物由你本地构建。
>
> 报 `EADDRINUSE` 说明 3000 已被占用，通常另有一个实例在跑。先 `curl -sf -o /dev/null http://127.0.0.1:3000/admin/` 确认是否健康——健康就直接用，不必再启。

### 首次配置：不用写配置文件

**零配置启动**后直接进管理台，全部在界面上点：

1. **Discover 页 → 一键导入**：自动发现本机装过并登录过的 harness（WorkBuddy / OpenCode Zen 等），点一下就完成「采用 Provider + 账号入池」。
2. **ZCode 免费额度**：面板里点「一键安装 / 一键启动」拉起本地 sidecar。要 OAuth 登录时到命令行跑 `npx tsx server/src/cli.ts zcode login`（JWT 只打印一次，不保存）。
3. **Providers 页 → 模型**：拉上游模型列表 → 「扫描可用性」自动识别每个模型的协议并记住 → 勾选采用。**勾选 = 对外暴露**：只有勾中的模型会出现在 `/v1/models`（id 为 `sourceId/modelId` 限定名）、参与路由、进入测试下拉。
4. **Providers 页 → 测试**：打一次最小真实请求，确认打通。

---

## 对接方式

网关说三种协议，请求里带 `model` 字段即可（`GET /v1/models` 查可用 id，形态为 `sourceId/modelId`）；不带则用 `gateway.default_model` 兜底。

```bash
# Anthropic Messages（Claude Code / Cline 用这种）
export ANTHROPIC_BASE_URL=http://localhost:3000
curl -N http://127.0.0.1:3000/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{"model":"<sourceId>/<modelId>","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'

# OpenAI Chat Completions
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<sourceId>/<modelId>","stream":true,"messages":[{"role":"user","content":"hi"}]}'

# OpenAI Responses
curl -N http://127.0.0.1:3000/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"<sourceId>/<modelId>","input":"hi"}'
```

网关默认**只监听 `127.0.0.1`** 且**免鉴权**（回环地址安全）。要对局域网/公网暴露，必须在配置文件里设 `gateway.admin_key`，否则拒绝启动。转发面另有 `gateway_key`（非空则 client 须带 `Authorization: Bearer <key>`）。

---

## 配置文件（可选）

零配置能跑，但要固定端口、设口令、预置 Provider 时写 YAML：

```bash
cp config/apps.example.yaml config/apps.yaml
```

`POLYCODE_CONFIG` 可覆盖配置路径。常用改动：

```yaml
gateway:
  port: 3000            # 换端口；也可启动时加 --port 3999
  admin_key: "..."      # 管理台口令；对非回环监听时必填
  gateway_key: ""       # client 侧 Bearer 校验；留空不校验
providers:
  - id: "company-anthropic"
    source_id: "company"
    api: "anthropic-messages"   # 留空 = 自动识别（推荐）
    base_url: "https://gw.example.com"
    credential:
      api_key_env: "COMPANY_GW_KEY"   # 密钥走环境变量，配置不落明文
```

> **注意**：配置文件是**严格模式**——写错字段名会直接拒绝启动（防拼错，也强制凭据不落明文）。错误信息会点名是哪个字段。示例文件本身一定是能解析的（有测试守着）。
>
> **存储**：配置只在**空库时播种一次**，之后 SQLite（`data/admin.db`）是唯一真相源——运行时在界面上的增删改重启不丢，YAML 后续改动不再生效（配置文件里的 Provider 定义在库里缺失时会被补回）。运维入口以管理台为准。
>
> **凭据热轮换**：改 `config/credentials/` 下的文件内容即生效（下次请求自动读新值），再调 `POST /admin/api/accounts/{id}/recheck` 清冷却立刻恢复，**全程不重启**。`api_key_env` 引的环境变量改值需重启进程。

---

## 命令行

```bash
npx tsx server/src/cli.ts <子命令>     # 或用 bin shim：node bin/polycode-hub.mjs <子命令>
```

| 子命令 | 作用 |
|---|---|
| `serve`（默认） | 启动网关 + 管理台。常用参数：`--port 3999`、`--config <path>` |
| `scan` | 只扫描本机可导入的 harness，不启动服务（`--json` 输出 JSON） |
| `adopt [--id ID] <finding-key>` | 命令行采用某个 harness（如 `workbuddy` / `opencode-zen`） |
| `zcode login` | ZCode OAuth 登录（浏览器授权，一次即可） |
| `zcode sidecar <动作>` | 本地引擎管理：`install` / `setup` / `start` / `stop` / `status` / `login` / `ensure`（缺省 `ensure`） |

---

## 管理台（6 个页面）

| 页面 | 作用 |
|---|---|
| Dashboard | 用量仪表盘：365 天热力图 + 归因表 |
| Providers | Provider CRUD + 模型勾选/协议/出口/测试/一键导入 |
| Accounts | 按源分组的账号池 + 健康/测试/重置 |
| Discover | 本机 harness 扫描采用 + 共存登录态导入 + sidecar 管理 |
| Projects | 本机项目一键启停 / 端口冲突 / 日志 |
| Login | 管理口令登录 |

转发面端点：`POST /v1/messages`、`POST /v1/chat/completions`、`POST /v1/responses`（另有裸路径别名 `/chat/completions`、`/responses`）、`GET /v1/models`、免鉴权的 `GET /health`。

---

## 开发

```bash
npm run dev            # 后端热重启（tsx watch）
npm test               # 全量测试（vitest，27 个文件 463 个用例）
npm run typecheck      # tsc --noEmit

npm run dev:web        # 前端 HMR；已配代理把 /admin/api 转给 :3000
```

改后端跑 `npm run dev`；改前端跑 `npm run dev:web`（HMR，不用反复 build）。

> 只有**开发**时前后端才是分开的两个服务：`vite` dev server 占一个端口提供 HMR，并把 `/admin/api` 代理给 3000 端口的后端。生产运行时不涉及这一层——网关进程直接托管 `web/dist`，只有一个端口。

### 工程结构

```
server/src/
├── cli.ts            # 入口与子命令
├── config/           # YAML 严格解析 + 默认值
├── gateway/          # HTTP 挂载、/v1/* 路由、管理台静态托管
├── router/           # 调度：候选排序、模型匹配、上下文预检
├── pool/             # 账号池（轮询 + 冷却）
├── ir/               # 中间表示（协议转换的公共边界）
├── codec/            # 三种协议的解析器 / 序列化器
├── model/            # Provider / Model / Account 类型与校验
├── adminapi/         # 管理台 REST API
├── usage/            # 用量与 token 计量（SQLite）
├── projects/         # 本地项目管理器（启停服务、端口冲突检测）
└── sidecar/          # ZCode 本地引擎托管（只做下载+配置+进程管理，不含上游代码）
web/src/              # Vue 3 + Element Plus + ECharts 管理台
```

**架构要点**：三种协议经 **IR 中间表示**互转（3 解析器 + 3 序列化器，而非 9 套两两转换）。调度按 **Provider 优先级**排序，同级轮转。

---

## 约束与约定

改动代码前需要知道的几条硬约束（完整版见 [`docs/FEATURES.md`](docs/FEATURES.md)）：

- **换源闸门**：一旦向 client 吐出首字节即不可换源，故障转移只在首字节之前发生
- **协议自动识别**：Provider `api` 是默认协议，`models[].api` 可覆盖（扫描实测写入）；留空即自动探测
- **许可证边界**：本项目 MIT，**不得混入具有传染性的开源许可证代码**
- **凭据不落明文**：只引环境变量名或 `config/credentials/` 下的文件
- **Provider ID 永久不可改**；一个 Provider 只说一种协议；baseURL 停在操作路径之前

---

## 许可证

MIT（见 [`LICENSE`](LICENSE)）
