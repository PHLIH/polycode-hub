// 调度器（对齐 Go internal/router/scheduler.go）：
// Provider 候选排序（priority + 段内轮转）、风险过滤、模型匹配与上下文预检。

import { riskAllowed, type Model, type Provider, type Risk } from '../model/index.ts'

export interface SchedulerInput {
  riskMax: Risk
}

function filterProviders(providers: Provider[], riskMax: Risk): Provider[] {
  // 只有 active 参与路由；paused（开关关掉）与 deleted 都不进入候选。
  const kept = providers.filter((p) => p.state === 'active' && riskAllowed(riskMax, p.risk))
  // priority 升序稳定排序；同 priority 内保持配置顺序（轮转由 pickOrder 完成）
  return kept.map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.priority - b.p.priority || a.i - b.i)
    .map((x) => ({ ...x.p }))
}

// 限定名 <prefix>/<modelId>：prefix 是 Provider id（客户端从 /v1/models 拿到什么就填什么）。
// 历史上 prefix 是抽象的「源」名，它与 Provider 恒为 1:1，多一层概念只让人对不上号。
export function splitModelRef(
  name: string, providerIDs: string[],
): { provider: string; model: string; qualified: boolean } {
  const i = name.indexOf('/')
  if (i > 0 && i < name.length - 1 && providerIDs.includes(name.slice(0, i))) {
    return { provider: name.slice(0, i), model: name.slice(i + 1), qualified: true }
  }
  return { provider: '', model: name, qualified: false }
}

function providerNamesOf(providers: Provider[]): string[] {
  const out: string[] = []
  for (const p of providers) {
    if (!out.includes(p.name)) out.push(p.name)
  }
  return out
}

function matchModel(p: Provider, name: string): [Model, boolean] {
  if (!p.models || p.models.length === 0) {
    // 未声明 Models 的 Provider 视为透明代理，接受任意模型
    return [{ id: name, input: ['text'], manual: false, enabled: false }, true]
  }
  for (const m of p.models) {
    if (m.id === name && m.enabled) return [m, true]
  }
  return [{ id: '', manual: false, enabled: false }, false]
}

export class Scheduler {
  private list: Provider[]
  private counter = 0 // round_robin 轮转计数

  constructor(providers: Provider[], riskMax: Risk) {
    this.list = filterProviders(providers, riskMax)
  }

  // 热重载 Provider 集合（Admin 增删改后调用，轮转计数保留）。
  reset(providers: Provider[], riskMax: Risk): void {
    this.list = filterProviders(providers, riskMax)
  }

  // 候选集合快照。
  providers(): Provider[] {
    return this.list.map((p) => ({ ...p }))
  }

  // 同 priority 段内轮转后的顺序。
  pickOrderPublic(): Provider[] {
    const out = this.list.map((p) => ({ ...p }))
    if (out.length <= 1) return out
    let i = 0
    while (i < out.length) {
      let j = i + 1
      while (j < out.length && out[j]!.priority === out[i]!.priority) j++
      const seg = out.slice(i, j)
      const off = (this.counter = (this.counter + 1) % 2 ** 53) % seg.length
      for (let k = 0; k < seg.length; k++) out[i + k] = seg[(k + off) % seg.length]!
      i = j
    }
    return out
  }

  // 按模型解析候选 Provider（对齐 Go PickOrder）。
  // modelName 为空返回轮转全集；precheckContext 时超限跳过（拒绝 + 换源，绝不截断）。
  // 注意：历史上「非流式请求跳过 StreamOnly 源」，网关内部一律流式打上游之后
  // 这条不再需要——非流式客户端由 forward 收齐拼包（见 proxy.collectStreamResponse），
  // StreamOnly 源同样可服务。stream 参数保留（调用兼容），不再参与过滤。
  pickOrder(modelName: string, inputEstimateTokens: number, precheckContext: boolean, stream: boolean): Provider[]
  pickOrder(): Provider[]
  pickOrder(modelName?: string, inputEstimateTokens = 0, precheckContext = false, stream = true): Provider[] {
    void stream
    if (modelName === undefined) return this.pickOrderPublic()
    if (modelName === '') return this.pickOrderPublic()
    const cands = this.pickOrderPublic()
    const { provider, model: bare, qualified } = splitModelRef(modelName, providerNamesOf(this.list))
    const out: Provider[] = []
    for (const p of cands) {
      if (qualified && p.name !== provider) continue
      const [m, ok] = matchModel(p, bare)
      if (!ok) continue
      if (precheckContext && (m.contextWindow ?? 0) > 0 && inputEstimateTokens > (m.contextWindow ?? 0)) continue
      out.push(p)
    }
    return out
  }

  // 用本集合的 Provider id 解析限定名（proxy 剥前缀用）。
  splitRef(name: string): { provider: string; model: string; qualified: boolean } {
    return splitModelRef(name, providerNamesOf(this.list))
  }

  // 查找 Provider 下指定模型的能力元数据。
  // 按内部 id 查（数字，改名不影响）。
  // 按 Provider 内部 id 查它名下的模型（模型是 Provider 的从属数据，不带反向引用）
  modelOf(providerId: number, modelName: string): [Model, boolean] {
    for (const p of this.list) {
      if (p.providerId !== providerId) continue
      return matchModel(p, modelName)
    }
    return [{ id: '', manual: false, enabled: false }, false]
  }
}

// 上下文预检用的粗估（len/4 启发式，estimated 档，不写入计费数据）。
export function estimateRequestTokens(body: Uint8Array): number {
  return Math.floor(body.length / 4)
}
