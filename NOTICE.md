# NOTICE — 第三方来源登记

polycode-hub 是**独立实现**：自有架构（IR 中间表示 + 三种协议编解码器）、自有调度与账号池，
不含任何第三方代理项目的源码。

但少数**上游协议细节、鉴权方式、指标口径**来自开源项目的公开文档与社区整理。
本文件只登记**项目中真实用到的**部分，用于表明归属、落实许可证义务。

> **登记规则**：新增适配器或采用任何上游协议做法之前，先在此登记「来源 + 借鉴内容 + 许可证」。
> 未登记不得动手；许可证未核实的，只可参考思路与协议事实，禁止复制源码。

---

## 一、借鉴清单（均为 MIT，宽松可吸收）

| 来源项目 | 借鉴内容（本项目实际用法） | 许可证 |
|---|---|---|
| `deepseek-ai/deepseek-harness`（DSH） | **配置模型**：① 三种上游协议划分 `openai-completions` / `openai-responses` / `anthropic-messages`（见 `server/src/ir/`）；② 一个 Provider 只说一种协议；③ Provider ID 不可改；④ baseURL 停在操作路径之前，由调用方拼具体操作路径；⑤ 模型能力显式声明（`contextWindow` / `maxOutputTokens` / `input: [text, image]`）；⑥ 手填模型默认纯文本，未声明图片时在发请求前拒绝并点名；⑦ 凭据分离，配置只存环境变量名引用，不落明文 | **MIT** ✅ |
| `deepseek-ai/deepseek-harness`（DSH） | **TPS 指标口径**：① ratio-of-averages 聚合（总输出 ÷ 总耗时），非逐条再平均；② 分母取**生成段**、扣除 TTFT；③ `sampled` 守卫——timing 或 outputTokens 缺失的条目不参与统计；④ 无样本时**不产出指标**（显示 —，不假装 0）。见 `server/src/usage/store.ts` | **MIT** ✅ |
| OpenCode Zen 免费档（社区整理 + 2026-09-17 真机抓包） | zen 免费档上游 `opencode.ai/zen/v1`；鉴权 `Authorization: Bearer public`（由 `ZEN_KEY` 环境变量提供）；必需请求头：官方客户端真 `User-Agent`（三段式 `opencode/<ver> ai-sdk/… runtime/…`，版本号随官方发版变，网关不内置——opencode 做客户端时自动透传，其他客户端配 Provider 静态头或 `ZEN_UA` 环境变量）+ `x-session-id` / `x-session-affinity`（真实官方 ses_ 会话；opencode 做客户端时网关透传）。旧 `x-opencode-*` 四头已变毒头（带了必 403），不要再发。见 `server/src/router/upstream.ts` | 协议事实（端点与请求头），**未复制代码** |
| WorkBuddy / CodeBuddy 桌面端（社区整理） | 复用**已登录桌面端的 auth 文件**而非另存明文 token：读 `CODEBUDDY_DESKTOP_AUTH_FILE` 等环境变量定位，请求时按次读取再下发。见 `server/src/discover/index.ts` | 协议事实（环境变量与 auth 文件用法），**未复制代码** |

---

## 二、运行时依赖（非借鉴，仅声明）

本项目的直接依赖均为宽松许可证，见 `package.json` 与 `web/package.json`：

- **后端**：hono / @hono/node-server / tsx / undici / yaml（MIT 或兼容）
- **前端**：vue / element-plus（MIT）；构建期 vite / @vitejs/plugin-vue（MIT）

---

## 三、许可证边界

本项目为 **MIT**（见 `LICENSE`）。为保障这一点：

1. **不引入具有传染性的开源许可证代码或依赖**——包括不将其作为库依赖、不复制其源码片段。
2. **许可证未核实 = 不得复制代码**，只可参考思路与协议事实。
3. **复制即保留许可头**：若确有复制，必须在文件头保留原许可证声明。
4. ZCode 侧边车（sidecar）**不包含、不修改、不复制**上游任何代码，
   仅提供「下载官方 release → 生成配置 → 进程管理」的胶水；
   二进制由用户自行从上游 Releases 获取，使用关系由用户与上游自行承担。
