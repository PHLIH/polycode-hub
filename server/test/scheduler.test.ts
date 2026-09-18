import { describe, expect, test } from 'vitest'
import {
  Scheduler,
  splitModelRef,
  estimateRequestTokens,
  type SchedulerInput,
} from '../src/router/scheduler.ts'
import type { Provider } from '../src/model/index.ts'

// 每个 Provider 给一个稳定的正数 providerId（存储层分配语义），
// 并让引用它的 Model 用同一个数字——挂错号会让模型匹配静默失败。
const p = (over: Partial<Provider> & { name: string }): Provider => ({
  providerId: 1,
  displayName: over.name, accessKind: 'official', risk: 'low',
  stability: 'stable', api: '', baseUrl: `https://${over.name}.example`, credential: {},
  state: 'active', priority: 0, models: [], ...over,
})

const sched = (providers: Provider[], riskMax: SchedulerInput['riskMax'] = 'high') =>
  new Scheduler(providers, riskMax)

describe('候选过滤与排序（对齐 Go scheduler.go）', () => {
  test('非 active 与超风险上限的 Provider 被过滤；priority 升序稳定排序', () => {
    const s = sched([
      p({ name: 'b', providerId: 2, priority: 2 }),
      p({ name: 'paused', providerId: 3, state: 'paused', priority: 0 }),
      p({ name: 'deleted', providerId: 4, state: 'deleted', priority: 0 }),
      p({ name: 'risky', providerId: 5, risk: 'high' }),
      p({ name: 'a', providerId: 6, priority: 1 }),
    ], 'medium')
    // paused/deleted 都不进候选（state 一列承担开关与删除两件事）
    expect(s.providers().map((x) => x.name)).toEqual(['a', 'b'])
  })

  test('同 priority 段内轮转（round_robin），跨段保持 priority 序', () => {
    // 注意对齐 Go：轮转计数每段各 +1，size-2 段 + 后续段时 offset 恒定（Go 真实行为）；
    // 用 size-3 段观察轮转。
    const s = sched([
      p({ name: 'x1', providerId: 1, priority: 1 }), p({ name: 'x2', providerId: 2, priority: 1 }),
      p({ name: 'x3', providerId: 3, priority: 1 }),
      p({ name: 'y', providerId: 4, priority: 2 }),
    ])
    const first = s.pickOrderPublic().map((x) => x.name)
    const second = s.pickOrderPublic().map((x) => x.name)
    expect(first[3]).toBe('y')
    expect(second[3]).toBe('y')
    expect(first[0]).not.toBe(second[0])
  })

  test('单 Provider 轮转不变', () => {
    const s = sched([p({ name: 'solo', providerId: 1 })])
    expect(s.pickOrderPublic().map((x) => x.name)).toEqual(['solo'])
    expect(s.pickOrderPublic().map((x) => x.name)).toEqual(['solo'])
  })
})

describe('模型路由（对齐 PickOrder）', () => {
  test('声明了 Models 的 Provider 只服务声明且启用的模型；未声明视为透明代理', () => {
    const s = sched([
      p({ name: 'declared', providerId: 1, priority: 0, models: [{ id: 'glm-4.6', manual: false, enabled: true },
        { id: 'disabled-m', manual: false, enabled: false }] }),
      p({ name: 'transparent', providerId: 2, priority: 2 }),
    ])
    const got = s.pickOrder('glm-4.6', 0, false, true).map((x) => x.name)
    expect(got).toEqual(['declared', 'transparent'])
    expect(s.pickOrder('disabled-m', 0, false, true).map((x) => x.name)).toEqual(['transparent'])
  })

  test('限定名 name/modelId：只留该 Provider；未知前缀按裸名', () => {
    const s = sched([
      p({ name: 'z1', providerId: 1, priority: 0 }),
      p({ name: 'o1', providerId: 2, priority: 2 }),
    ])
    expect(s.pickOrder('z1/glm-4.6', 0, false, true).map((x) => x.name)).toEqual(['z1'])
    // unknownsrc 不是已知 Provider name → 整体按裸名，两边都接受
    expect(s.pickOrder('unknownsrc/glm-4.6', 0, false, true).map((x) => x.name)).toEqual(['z1', 'o1'])
  })

  test('StreamOnly 源不再因非流式被跳过（网关内部一律流式打上游并拼包）', () => {
    const s = sched([p({ name: 'so', providerId: 1, streamOnly: true, priority: 0 }), p({ name: 'both', providerId: 2, priority: 2 })])
    expect(s.pickOrder('m', 0, false, true).map((x) => x.name)).toEqual(['so', 'both'])
    // 非流式客户端同样可路由到 StreamOnly 源：拼包对客户端透明
    expect(s.pickOrder('m', 0, false, false).map((x) => x.name)).toEqual(['so', 'both'])
  })

  test('上下文预检：超限跳过该 Provider（绝不截断），unknown 放行', () => {
    const s = sched([
      p({ name: 'small', providerId: 1, priority: 0, models: [{ id: 'm', contextWindow: 100, manual: false, enabled: true }] }),
      p({ name: 'unknown-win', providerId: 2, priority: 2 }),
    ])
    expect(s.pickOrder('m', 500, true, true).map((x) => x.name)).toEqual(['unknown-win'])
    expect(s.pickOrder('m', 50, true, true).map((x) => x.name)).toEqual(['small', 'unknown-win'])
    // 预检关闭时不拦截
    expect(s.pickOrder('m', 500, false, true).map((x) => x.name)).toEqual(['small', 'unknown-win'])
  })

  test('modelOf：按数字 providerId 查模型能力，改名不影响', () => {
    const s = sched([
      p({ name: 'z1', providerId: 7, models: [{ id: 'glm', contextWindow: 128, manual: false, enabled: true }] }),
    ])
    const [m, ok] = s.modelOf(7, 'glm')
    expect(ok).toBe(true)
    expect(m.contextWindow).toBe(128)
    expect(s.modelOf(99, 'glm')[1]).toBe(false)
  })

  test('splitModelRef：首段命中已知 Provider name 才算限定名', () => {
    const providers = ['zcode', 'opencode']
    expect(splitModelRef('zcode/glm', providers)).toEqual({ provider: 'zcode', model: 'glm', qualified: true })
    expect(splitModelRef('opencode-zen/m', providers)).toEqual({ provider: '', model: 'opencode-zen/m', qualified: false })
    expect(splitModelRef('no-slash', providers)).toEqual({ provider: '', model: 'no-slash', qualified: false })
    expect(splitModelRef('zcode/', providers)).toEqual({ provider: '', model: 'zcode/', qualified: false })
    expect(splitModelRef('/glm', providers)).toEqual({ provider: '', model: '/glm', qualified: false })
  })

  test('estimateRequestTokens：len/4 粗估', () => {
    expect(estimateRequestTokens(new TextEncoder().encode('12345678'))).toBe(2)
  })
})
