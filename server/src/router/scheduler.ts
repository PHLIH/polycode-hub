// 调度器（对齐 Go internal/router/scheduler.go）：
// Provider 候选排序（priority + 段内轮转）、风险过滤、模型匹配与上下文预检。

import { riskAllowed, type Model, type Provider, type Risk } from '../model/index.ts'

export interface SchedulerInput {
  riskMax: Risk
}

function filterProviders(providers: Provider[], riskMax: Risk): Provider[] {
  const kept = providers.filter((p) => p.enabled && riskAllowed(riskMax, p.risk))
  // priority 升序稳定排序；同 priority 内保持配置顺序（轮转由 pickOrder 完成）
  return kept.map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.priority - b.p.priority || a.i - b.i)
    .map((x) => ({ ...x.p }))
}

export function splitModelRef(
  name: string, sources: string[],
): { source: string; model: string; qualified: boolean } {
  const i = name.indexOf('/')
  if (i > 0 && i < name.length - 1 && sources.includes(name.slice(0, i))) {
    return { source: name.slice(0, i), model: name.slice(i + 1), qualified: true }
  }
  return { source: '', model: name, qualified: false }
}

function sourcesOf(providers: Provider[]): string[] {
  const out: string[] = []
  for (const p of providers) {
    if (!out.includes(p.sourceId)) out.push(p.sourceId)
  }
  return out
}

function matchModel(p: Provider, name: string): [Model, boolean] {
  if (!p.models || p.models.length === 0) {
    // 未声明 Models 的 Provider 视为透明代理，接受任意模型
    return [{ id: name, providerId: p.id, input: ['text'], manual: false, enabled: false }, true]
  }
  for (const m of p.models) {
    if (m.id === name && m.enabled) return [m, true]
  }
  return [{ id: '', providerId: p.id, manual: false, enabled: false }, false]
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
  // modelName 为空返回轮转全集；precheckContext 时超限跳过（拒绝 + 换源，绝不截断）；
  // 非流式请求跳过 StreamOnly 源。
  pickOrder(modelName: string, inputEstimateTokens: number, precheckContext: boolean, stream: boolean): Provider[]
  pickOrder(): Provider[]
  pickOrder(modelName?: string, inputEstimateTokens = 0, precheckContext = false, stream = true): Provider[] {
    if (modelName === undefined) return this.pickOrderPublic()
    if (modelName === '') return this.pickOrderPublic()
    const cands = this.pickOrderPublic()
    const { source, model: bare, qualified } = splitModelRef(modelName, sourcesOf(this.list))
    const out: Provider[] = []
    for (const p of cands) {
      if (qualified && p.sourceId !== source) continue
      if (!stream && p.streamOnly) continue
      const [m, ok] = matchModel(p, bare)
      if (!ok) continue
      if (precheckContext && (m.contextWindow ?? 0) > 0 && inputEstimateTokens > (m.contextWindow ?? 0)) continue
      out.push(p)
    }
    return out
  }

  // 用本集合的 source 解析限定名（proxy 剥前缀用）。
  splitRef(name: string): { source: string; model: string; qualified: boolean } {
    return splitModelRef(name, sourcesOf(this.list))
  }

  // 查找 Provider 下指定模型的能力元数据。
  modelOf(providerID: string, modelName: string): [Model, boolean] {
    for (const p of this.list) {
      if (p.id !== providerID) continue
      return matchModel(p, modelName)
    }
    return [{ id: '', providerId: '', manual: false, enabled: false }, false]
  }
}

// 上下文预检用的粗估（len/4 启发式，estimated 档，不写入计费数据）。
export function estimateRequestTokens(body: Uint8Array): number {
  return Math.floor(body.length / 4)
}
