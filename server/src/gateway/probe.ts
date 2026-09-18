// Provider 测试与模型发现（对齐 Go internal/gateway/proxy.go 后半段）。
// 管理面 SetProber/SetModelLister/SetModelProber 的实现。

import { getOutbound, UpstreamError, type IrRequest, type StreamEvent } from '../ir/index.ts'
import {
  autoProtocol, rememberProtocol, looksFree, accountEffectiveStatus, applyReasoningFloor,
  type Provider, type UsageLog,
} from '../model/index.ts'
import type { AccountPool } from '../pool/account.ts'
import type { Scheduler } from '../router/scheduler.ts'
import type { Upstream } from '../router/upstream.ts'
import { requestID, mergeStreamUsage, cooldownFor } from './proxy.ts'

// ---- 管理面 DTO（json 键与 Go adminapi 一致）----

export interface ProbeResult {
  ok: boolean
  model?: string
  protocol?: string
  text?: string
  latencyMs?: number
  error?: string
}

export interface ModelProbe {
  model: string
  ok: boolean
  protocol?: string
  text?: string
  latencyMs?: number
  error?: string
  // 失败原因分类（ir.UpstreamError.kind），供账号测试按原因决定冷却时长。
  kind?: string
}

export interface CapsDTO {
  input?: string[]
  contextWindow?: number
  maxOutputTokens?: number
}

export interface ModelList {
  models: string[]
  source: string
  protocols?: Record<string, string>
  free?: string[]
  caps?: Record<string, CapsDTO>
}

export interface UsageWriter {
  insertLog(l: UsageLog): Promise<void> | void
}

// 探针最大尝试次数（含首次）：免费档上游会间歇 429/503。
const PROBE_ATTEMPTS = 3
// 单模型探测超时（含重试）：上游冷启动可能很慢（实测 40s+）。
const PROBE_TIMEOUT_MS = 90_000
// 批量扫描并发上限：别把上游和本机打爆，也避免触发更高限流。
const PROBE_CONCURRENCY = 4

function retryableProbeErr(err: unknown): boolean {
  const kind = (err as { kind?: string }).kind
  return kind === 'rate_limit' || kind === 'quota' || kind === 'server' || kind === 'network'
}

// 非法 providerId 的最后一道防线（NaN / undefined / 非正整数）。
//
// 背景：这三个探针原先只用 `===` 查找。NaN 与任何值都不相等（连它自己都不等），
// 所以查找必然落空，报错再用模板字面量把 NaN 渲染成「provider #NaN 不存在」——
// 排查时看不出是谁传错了，还会被读成「Provider 被删了」。历史上前端误传 .id
// 时这里吐出的是 `#undefined`（见 Providers.vue 的修复）。管理面现在都先查库
// 再传真实 id，这里兜住绕过管理面的直接调用。
// 返回错误文案；id 合法时返回空串。
function badProviderID(providerId: number): string {
  if (typeof providerId !== 'number' || !Number.isInteger(providerId) || providerId <= 0) {
    return `provider #${String(providerId)} 不存在`
  }
  return ''
}

export function freeAmong(ids: string[]): string[] {
  return ids.filter((id) => looksFree(id))
}

// 从客户端本地痕迹发现模型（按 Provider 名分派）：当前为桩实现（恒返回空，
// 调用方回落本地配置）；workbuddy 痕迹发现由 cli 层经 discoverLocal 参数注入（见 cli.ts runServe）。
// 参数是 Provider 名（不是内部 id）：分派依据是"这是哪个上游"，而名字才是它。
export function discoverLocalModels(providerName: string): string[] {
  void providerName
  return []
}

interface ProbeOutcome {
  ok: boolean
  text: string
  latencyMs: number
  error: string
  ul: UsageLog
  firstMs: number
}

export class Probe {
  // 管理面探针：Provider 测试 / 账号测试 / 批量扫描 / 模型目录。
  // 测试即真实上游请求（有成本）；成功会 rememberProtocol，失败按 kind 记 errorKind。
  private sched: Scheduler
  private up: Upstream
  private usage: UsageWriter | null
  private accounts: AccountPool | null
  private discoverLocal: (providerName: string) => string[]
  constructor(
    sched: Scheduler,
    up: Upstream,
    usage: UsageWriter | null,
    accounts: AccountPool | null = null,
    discoverLocal: (providerName: string) => string[] = discoverLocalModels,
  ) {
    this.sched = sched
    this.up = up
    this.usage = usage
    this.accounts = accounts
    this.discoverLocal = discoverLocal
  }

  // 对指定 Provider 打一次最小真实流式请求（首段文本 + 首字延迟回显）。
  // 锁定单个 Provider，不换源；任何失败都如实返回，不抛错。
  async probeProvider(providerId: number): Promise<ProbeResult> {
    const fail = (error: string, latencyMs: number): ProbeResult => ({ ok: false, error, latencyMs })
    const bad = badProviderID(providerId)
    if (bad) return fail(bad, 0)
    const found = this.sched.providers().find((p) => p.providerId === providerId)
    if (!found) return fail(`provider #${providerId} 不存在`, 0)
    let bare = found.probeModel ?? ''
    if (!bare) {
      for (const m of found.models) {
        if (m.enabled) { bare = m.id; break }
      }
    }
    if (!bare) return fail('该 Provider 在「模型」里一个都没勾选，先勾选模型再测', 0)
    const pv = this.probeCredential(found)
    const pr = await this.probeWithProtocols(pv, bare)
    if (!pr.ok) return fail('上游错误: ' + pr.error, pr.latencyMs ?? 0)
    return {
      ok: true, model: `${found.name}/${bare}`, protocol: pr.protocol,
      text: pr.text, latencyMs: pr.latencyMs,
    }
  }

  // 账号测试：用指定账号的凭据打一次指定模型的真实请求，结果计入账号状态。
  // 与 Provider 测试的区别：钉死账号（不走轮询）、测完按结果更新冷却与连败计数
  // ——「测试」即人工验证手段，测通了就把该号从冷却里放出来。
  async probeAccount(accountID: string, modelID: string): Promise<ProbeResult> {
    const fail = (error: string): ProbeResult => ({ ok: false, error, latencyMs: 0 })
    const acct = this.accounts?.get(accountID)
    if (!acct) return fail(`账号 ${accountID} 不存在`)
    const p = this.sched.providers().find((x) => x.providerId === acct.providerId)
    if (!p) return fail(`账号 ${accountID} 归属 Provider #${acct.providerId} 不存在`)
    const bare = modelID || p.probeModel || p.models.find((m) => m.enabled)?.id || ''
    if (!bare) return fail('该源没有可测模型：先到 Provider 页获取模型列表')
    const pv: Provider = { ...p, credential: acct.credential }
    const pr = await this.probeWithProtocols(pv, bare)
    // 测试即验证：结果计入账号状态（成功清冷却归零，失败计连败并按原因冷却）。
    // kind 一并传下去：quota 走 exhausted（不自动恢复），其余走定时冷却。
    this.accounts?.markResult(accountID, pr.ok, cooldownFor(pr.kind ?? 'unknown'), new Date(), pr.ok ? '' : (pr.kind ?? ''))
    if (!pr.ok) return fail('上游错误: ' + pr.error)
    return { ok: true, model: `${p.name}/${bare}`, protocol: pr.protocol, text: pr.text, latencyMs: pr.latencyMs }
  }

  // 批量实测候选模型：并发打最小真实请求，逐个报告可用性。空列表时用已配置的启用模型。
  async probeModels(providerId: number, models: string[]): Promise<ModelProbe[]> {
    const bad = badProviderID(providerId)
    if (bad) return [{ model: '', ok: false, error: bad }]
    const found = this.sched.providers().find((p) => p.providerId === providerId)
    if (!found) return [{ model: '', ok: false, error: `provider #${providerId} 不存在` }]
    if (models.length === 0) {
      models = found.models.filter((m) => m.enabled).map((m) => m.id)
    }
    if (models.length === 0) return [{ model: '', ok: false, error: '没有可测模型：先获取模型列表或手填' }]
    const pv = this.probeCredential(found)
    const out: ModelProbe[] = new Array(models.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, models.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= models.length) return
        out[i] = await this.probeWithProtocols(pv, models[i]!)
      }
    }))
    return out
  }

  // 依次用候选协议探测同一模型，返回首个成功的；全失败时报告最有信息量的那次错误。
  async probeWithProtocols(pv: Provider, modelID: string): Promise<ModelProbe> {
    const candidates = probeProtocolOrder(pv, modelID)
    let lastErr = ''
    let lastUL: UsageLog | null = null
    let lastLatency = 0
    let best: { err: string; kind: string; rank: number } | null = null
    for (const proto of candidates) {
      const attempt: Provider = { ...pv, api: proto }
      const m = pv.models.find((x) => x.id === modelID)
      if (m?.egress) attempt.egress = m.egress // 模型级出口覆盖 Provider 级（与转发同语义）
      // 钉死协议：写成模型级 api，避免 Stream 内部自动探测覆盖（探测结果才不失真）。
      attempt.models = pinModelProtocol(pv.models, modelID, proto)
      const r = await this.probeOne(attempt, modelID)
      if (r.ok) {
        // 只记最终采用的那次（试错过程不记账，避免一次测试记出多条）。
        void this.usage?.insertLog({ ...r.ul, status: 'ok', latencyMs: r.firstMs })
        rememberProtocol(pv.name, modelID, proto) // 探到即记住，转发直达
        return { model: modelID, ok: true, protocol: proto, text: r.text, latencyMs: r.firstMs }
      }
      lastErr = r.error
      lastUL = r.ul
      lastLatency = r.latencyMs
      // 记病因：rank 高的（真病因）不被后续协议的路径噪音盖掉。
      const kind = r.ul.errorKind ?? ''
      const rank = errorRank(kind, r.error)
      if (!best || rank > best.rank) best = { err: r.error, kind, rank }
      // 认证/请求侧硬错误：换协议也没用，早停省时间。
      if (probeFatalError(r.error, kind)) break
    }
    if (lastUL && lastUL.modelId) {
      void this.usage?.insertLog({ ...lastUL, status: 'upstream_error', latencyMs: lastLatency })
    }
    const errText = best?.err ?? lastErr
    const errKind = best?.kind || undefined
    return { model: modelID, ok: false, error: errText, kind: errKind }
  }

  // 返回该 Provider 用于探测的副本：同源有可用账号则用账号凭据（与真实转发同路径），
  // 否则用 Provider 级凭据。不写 MarkResult，不污染冷却。
  private probeCredential(p: Provider): Provider {
    if (!this.accounts) return p
    const now = new Date()
    const acct = this.accounts.snapshot().find(
      (a) => a.providerId === p.providerId && accountEffectiveStatus(a, now) === 'available')
    return acct ? { ...p, credential: acct.credential } : p
  }

  // 对指定模型打一次最小真实流式请求。不抛错，失败如实返回。
  // 注意与 Stream 的协议解析不完全一致：此处只看模型级/ Provider 级声明，
  // 不读 autoProtocol 进程内缓存（探测即重探，避免缓存掩盖真相）。
  // 探针不带推理档位（最小请求只测连通，不测档位枚举），但同样走档位下限：
  // 万一模型配了 xhigh/max 下限，16 预算会被抬起，避免把“预算不足”误报成“源不可用”。
  private async probeOne(pv: Provider, bare: string): Promise<ProbeOutcome> {
    const m = pv.models.find((x) => x.id === bare)
    const proto = m?.api || pv.api
    const t0 = Date.now()
    const ms = () => Date.now() - t0
    const ul: UsageLog = {
      id: 0, ts: new Date(t0), requestId: requestID(),
      providerId: pv.providerId, providerName: pv.name, modelId: bare, stream: true,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      reasoningTokens: 0, totalTokens: 0, accuracy: 'unknown', latencyMs: 0, status: 'ok',
    }
    // 探测专用：关闭协议自动回退，确保观察到的是「这个协议」的真实结果。
    const probeUp = this.up.withOpts({ noAutoProtocol: true })
    let stream: ReadableStream<Uint8Array> | undefined
    let err: unknown
    const probeReq: IrRequest = applyReasoningFloor({
      model: bare, stream: true, maxTokens: 16,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }, pv.models.find((x) => x.id === bare))
    // 上游抖动重试：免费档会间歇 503（限流按会话算，见 docs/FEATURES.md），
    // 打一次就报「不通」会误判成配置错误。
    for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
      try {
        stream = await probeUp.streamWithTimeout(pv, probeReq, AbortSignal.timeout(PROBE_TIMEOUT_MS))
        err = undefined
        break
      } catch (e) {
        err = e
        if (!retryableProbeErr(e) || attempt === PROBE_ATTEMPTS) break
        await new Promise((r) => setTimeout(r, attempt * 500))
      }
    }
    if (err || !stream) {
      // 失败原因分类随记账走（协议试错只记最终采用那次，这里只留最后一次的错误）
      const kind = (err as { kind?: string } | undefined)?.kind
      if (kind) ul.errorKind = kind
      return { ok: false, text: '', latencyMs: ms(), error: (err as Error).message, ul, firstMs: 0 }
    }
    const parser = getOutbound(proto).newStreamParser()
    let text = ''
    let firstMs = 0
    const collect = (evs: StreamEvent[]) => {
      for (const ev of evs) {
        mergeStreamUsage(ul, ev)
        if (ev.type === 'content_block_delta' && ev.delta?.kind === 'text') {
          if (firstMs === 0) firstMs = ms()
          text += ev.delta.text ?? ''
        }
      }
    }
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        let evs: StreamEvent[]
        try {
          evs = parser.feed(value)
        } catch (ferr) {
          return { ok: false, text: '', latencyMs: ms(), error: '解析上游响应失败: ' + (ferr as Error).message, ul, firstMs: 0 }
        }
        collect(evs)
      }
    }
    collect(parser.finish())
    if (firstMs === 0) firstMs = ms()
    return { ok: true, text, latencyMs: firstMs, error: '', ul, firstMs }
  }

  // 拉取指定 Provider 的模型目录：先问上游实时列表；失败（无接口/网络/鉴权等）
  // 则回落本地配置/客户端痕迹。
  async listProviderModels(providerId: number): Promise<ModelList> {
    // 注意契约：这里是三个探针里唯一抛错的一个（另两个返回 ok:false / results[]）。
    // 调用方（api.ts 的 GET /providers/:pid/models）先查库，所以走到这里的非法 id
    // 只会来自绕过管理面的直接调用；仍然如实抛，但文案里带上原始值。
    const bad = badProviderID(providerId)
    if (bad) throw new UpstreamError(0, 'bad_request', bad)
    const p = this.sched.providers().find((x) => x.providerId === providerId)
    if (!p) throw new UpstreamError(0, 'bad_request', `provider #${providerId} 不存在`)
    try {
      const [ids, declared, caps] = await this.up.fetchModelsWithProtocols(p)
      const protos: Record<string, string> = { ...declared }
      const outCaps: Record<string, CapsDTO> = {}
      for (const [k, v] of Object.entries(caps)) {
        outCaps[k] = { input: v.input, contextWindow: v.contextWindow, maxOutputTokens: v.maxOutputTokens }
      }
      for (const mid of ids) {
        const m = p.models.find((x) => x.id === mid)
        if (m) {
          if (m.api) protos[mid] = m.api // 模型目录里已存的（扫描/采纳写入，落库）
          else {
            const got = autoProtocol(p.name, mid)
            if (got) protos[mid] = got // 进程内探测缓存
          }
          if ((m.input?.length ?? 0) > 0 || (m.contextWindow ?? 0) > 0) {
            const c: CapsDTO = { input: m.input, contextWindow: m.contextWindow, maxOutputTokens: m.maxOutputTokens }
            const existing = outCaps[mid]
            if (existing && (existing.input?.length ?? 0) > 0) c.input = existing.input // 上游声明优先
            outCaps[mid] = c
          }
          continue
        }
        const got = autoProtocol(p.name, mid)
        if (got) protos[mid] = got
      }
      return { models: ids, source: 'upstream', protocols: protos, free: freeAmong(ids), caps: outCaps }
    } catch {
      // 上游无列表接口（WorkBuddy 类）：合并「客户端痕迹发现」与「已配置」。
      const protos2: Record<string, string> = {}
      for (const m of p.models) {
        if (m.enabled && m.api) { protos2[m.id] = m.api; continue }
        const got = autoProtocol(p.name, m.id)
        if (got) protos2[m.id] = got
      }
      const fromTrace = this.discoverLocal(p.name)
      const models = [...fromTrace]
      const seen = new Set(fromTrace)
      let addedFromConfig = false
      for (const m of p.models) {
        if (m.enabled && !seen.has(m.id)) {
          models.push(m.id)
          seen.add(m.id)
          addedFromConfig = true
        }
      }
      models.sort()
      let source = 'local-config'
      if (fromTrace.length > 0 && addedFromConfig) source = 'client-trace+local-config'
      else if (fromTrace.length > 0) source = 'client-trace'
      if (models.length > 0) {
        const outCaps: Record<string, CapsDTO> = {}
        for (const mid of models) {
          const m = p.models.find((x) => x.id === mid)
          if (!m) continue
          if (m.api) protos2[mid] = m.api
          if ((m.input?.length ?? 0) > 0 || (m.contextWindow ?? 0) > 0) {
            outCaps[mid] = { input: m.input, contextWindow: m.contextWindow, maxOutputTokens: m.maxOutputTokens }
          }
        }
        return { models, source, protocols: protos2, free: freeAmong(models), caps: outCaps }
      }
      throw new UpstreamError(0, 'bad_request', '上游无模型列表接口且本地未配置模型，请手填模型 ID')
    }
  }
}

// 该模型的协议候选顺序：已声明/已探到的排最前，其余按常见度补全。
function probeProtocolOrder(pv: Provider, modelID: string): string[] {
  const all = ['openai-completions', 'openai-responses', 'anthropic-messages']
  const m = pv.models.find((x) => x.id === modelID)
  const first = m?.api || pv.api || ''
  // 模型级声明最可信（用户/扫描写入的事实）；Provider 级只是默认猜测。
  // 已知事实：zen 的 muse-spark 系只认 /responses，走 /chat/completions 上游回 500。
  // Provider 级 api 是 openai-completions 时不要再让它先撞 500——按已知族提前 responses。
  if (!m?.api && /^muse-spark/i.test(modelID)) {
    return ['openai-responses', ...all.filter((p) => p !== 'openai-responses')]
  }
  if (!first) return all
  return [first, ...all.filter((p) => p !== first)]
}

// 返回模型目录副本，目标模型被钉死为指定协议（仅用于探测）。
function pinModelProtocol(models: Provider['models'], modelID: string, proto: string): Provider['models'] {
  const out = models.map((m) => ({ ...m }))
  const found = out.find((m) => m.id === modelID)
  if (found) found.api = proto
  else out.push({ id: modelID, api: proto, manual: false, enabled: true })
  return out
}

// 该错误是否与协议无关（换协议重试无意义）。
// 401 = 凭据错，换端点也进不去。
// 注意 404 不在此列：上游对「本端点没有此路径/模型」正是回 404（实测 zen 的 anthropic 路径
// 回 404 HTML 页）。把它当硬错误会让探测就地终止，唯一能用的 /responses 永远轮不到
// （muse-spark 真实缺陷）。403 同理有 RegionError 细分，已在 classifyUpstreamError 归为
// bad_request，不在此早停。
function probeFatalError(msg: string, kind = ''): boolean {
  // 指纹缺失（FreeTierError）：上游只认官方客户端样子，换协议无解，早停省时间。
  if (kind === 'fingerprint') return true
  // 地区限制（RegionError）：换协议无解（是出口 IP 的问题，不是端点的问题），
  // 早停避免白试三轮；出路是配 egress，报错文案已点名。
  if (kind === 'region') return true
  return msg.includes('http 401')
}

// 全协议都失败时，按「这个错误有多少信息量」排序，挑最有价值的那个上报。
// 背景：探测会依次试 3 个协议，后两者往往打在上游不存在的路径上 → 回 404 HTML。
// 若一律取最后一次，账号真实状态（额度用尽 429 / 限流 / 鉴权）就被 404 噪音盖掉，
// 连冷却时长都会算错（按 bad_request 30s，而非限流 1min / 额度 10min）。
function errorRank(kind: string, msg: string): number {
  const byKind: Record<string, number> = {
    // 指纹缺失排最高：它是「上游明确拒绝这个身份」，比额度/限流更能定位问题，
    // 且绝不能被后续协议的 404/400 路径噪音盖掉。
    fingerprint: 60,
    // 地区限制紧随其后：同为「明确拒绝且换协议无解」，必须能浮到报错面上，
    // 否则用户看到的是被 404 噪音盖过的含糊错，以为模型下线了。
    region: 55,
    quota: 50, rate_limit: 40, auth: 45, server: 20, network: 15, bad_request: 5, unknown: 0,
  }
  const k = byKind[kind] ?? 0
  // 404/400 多半是"这个协议路径不对"，不是账号有问题 → 压到最低。
  if (/http (404|400)/.test(msg)) return Math.min(k, 1)
  return k
}
