import { describe, expect, test } from 'vitest'
import {
  Scheduler,
  splitModelRef,
  estimateRequestTokens,
  type SchedulerInput,
} from '../src/router/scheduler.ts'
import type { Provider } from '../src/model/index.ts'

const p = (over: Partial<Provider> & { id: string }): Provider => ({
  sourceId: 'src', displayName: over.id, accessKind: 'official', risk: 'low',
  stability: 'stable', api: '', baseUrl: `https://${over.id}.example`, credential: {},
  enabled: true, priority: 0, models: [], ...over,
})

const sched = (providers: Provider[], riskMax: SchedulerInput['riskMax'] = 'high') =>
  new Scheduler(providers, riskMax)

describe('候选过滤与排序（对齐 Go scheduler.go）', () => {
  test('未启用与超风险上限的 Provider 被过滤；priority 升序稳定排序', () => {
    const s = sched([
      p({ id: 'b', priority: 2 }),
      p({ id: 'off', enabled: false, priority: 0 }),
      p({ id: 'risky', risk: 'high' }),
      p({ id: 'a', priority: 1 }),
    ], 'medium')
    expect(s.providers().map((x) => x.id)).toEqual(['a', 'b'])
  })

  test('同 priority 段内轮转（round_robin），跨段保持 priority 序', () => {
    // 注意对齐 Go：轮转计数每段各 +1，size-2 段 + 后续段时 offset 恒定（Go 真实行为）；
    // 用 size-3 段观察轮转。
    const s = sched([
      p({ id: 'x1', priority: 1 }), p({ id: 'x2', priority: 1 }), p({ id: 'x3', priority: 1 }),
      p({ id: 'y', priority: 2 }),
    ])
    const first = s.pickOrderPublic().map((x) => x.id)
    const second = s.pickOrderPublic().map((x) => x.id)
    expect(first[3]).toBe('y')
    expect(second[3]).toBe('y')
    expect(first[0]).not.toBe(second[0])
  })

  test('单 Provider 轮转不变', () => {
    const s = sched([p({ id: 'solo' })])
    expect(s.pickOrderPublic().map((x) => x.id)).toEqual(['solo'])
    expect(s.pickOrderPublic().map((x) => x.id)).toEqual(['solo'])
  })
})

describe('模型路由（对齐 PickOrder）', () => {
  test('声明了 Models 的 Provider 只服务声明且启用的模型；未声明视为透明代理', () => {
    const s = sched([
      p({ id: 'declared', priority: 0, models: [{ id: 'glm-4.6', providerId: 'declared', manual: false, enabled: true },
        { id: 'disabled-m', providerId: 'declared', manual: false, enabled: false }] }),
      p({ id: 'transparent', priority: 2 }),
    ])
    const got = s.pickOrder('glm-4.6', 0, false, true).map((x) => x.id)
    expect(got).toEqual(['declared', 'transparent'])
    expect(s.pickOrder('disabled-m', 0, false, true).map((x) => x.id)).toEqual(['transparent'])
  })

  test('限定名 sourceId/modelId：只留该 source 的 Provider；未知 source 按裸名', () => {
    const s = sched([
      p({ id: 'z1', sourceId: 'zcode', priority: 0 }),
      p({ id: 'o1', sourceId: 'opencode', priority: 2 }),
    ])
    expect(s.pickOrder('zcode/glm-4.6', 0, false, true).map((x) => x.id)).toEqual(['z1'])
    // unknownsrc 不是已知 source → 整体按裸名，两边都接受
    expect(s.pickOrder('unknownsrc/glm-4.6', 0, false, true).map((x) => x.id)).toEqual(['z1', 'o1'])
  })

  test('StreamOnly 源在非流式请求时跳过', () => {
    const s = sched([p({ id: 'so', streamOnly: true, priority: 0 }), p({ id: 'both', priority: 2 })])
    expect(s.pickOrder('m', 0, false, true).map((x) => x.id)).toEqual(['so', 'both'])
    expect(s.pickOrder('m', 0, false, false).map((x) => x.id)).toEqual(['both'])
  })

  test('上下文预检：超限跳过该 Provider（绝不截断），unknown 放行', () => {
    const s = sched([
      p({ id: 'small', priority: 0, models: [{ id: 'm', providerId: 'small', contextWindow: 100, manual: false, enabled: true }] }),
      p({ id: 'unknown-win', priority: 2 }),
    ])
    expect(s.pickOrder('m', 500, true, true).map((x) => x.id)).toEqual(['unknown-win'])
    expect(s.pickOrder('m', 50, true, true).map((x) => x.id)).toEqual(['small', 'unknown-win'])
    // 预检关闭时不拦截
    expect(s.pickOrder('m', 500, false, true).map((x) => x.id)).toEqual(['small', 'unknown-win'])
  })

  test('splitModelRef：首段命中已知 source 才算限定名', () => {
    const sources = ['zcode', 'opencode']
    expect(splitModelRef('zcode/glm', sources)).toEqual({ source: 'zcode', model: 'glm', qualified: true })
    expect(splitModelRef('opencode-zen/m', sources)).toEqual({ source: '', model: 'opencode-zen/m', qualified: false })
    expect(splitModelRef('no-slash', sources)).toEqual({ source: '', model: 'no-slash', qualified: false })
    expect(splitModelRef('zcode/', sources)).toEqual({ source: '', model: 'zcode/', qualified: false })
    expect(splitModelRef('/glm', sources)).toEqual({ source: '', model: '/glm', qualified: false })
  })

  test('estimateRequestTokens：len/4 粗估', () => {
    expect(estimateRequestTokens(new TextEncoder().encode('12345678'))).toBe(2)
  })
})
