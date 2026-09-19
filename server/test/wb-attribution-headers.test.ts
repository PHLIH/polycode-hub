// WorkBuddy「使用端归因头」锚点。
//
// 背景：上游用量页的「使用端」列在头里带 WorkBuddy 身份时显示 `WorkBuddy`，
// 否则显示 `-`。用户明确要求这一列有显示，所以网关发这组头。
//
// ⚠️ 这组头**不影响计费** —— 三组对照实测（同一账号）：
//     WorkBuddy 头 + hy4-preview         → credit 8.60（扣）
//     WorkBuddy 头 + deepseek-v4.1-flash → credit 0
//     SaaS 头      + deepseek-v4.1-flash → credit 0
//   决定扣费的只有**模型档位**（hy4-preview 是 x0.29，hy4-preview-f 是 x0.00）。
// 这些用例把「归因头的形状」和「迁移的幂等/不越界」钉住。

import { describe, expect, test } from 'vitest'
import { wbAuxEndpointIdentityHeaders, WB_CLIENT_VERSION } from '../src/model/index.ts'
import { MemoryProviderStore, migrateWorkBuddyAttributionHeaders } from '../src/adminapi/store.ts'
import { wbSuggestedProvider } from '../src/discover/index.ts'
import type { Provider } from '../src/model/index.ts'

describe('归因头形状', () => {
  test('含 WorkBuddy 身份四件套 + UA', () => {
    const h = wbAuxEndpointIdentityHeaders()
    expect(h['X-Product']).toBe('WorkBuddy')
    expect(h['X-IDE-Type']).toBe('WorkBuddy')
    expect(h['X-IDE-Name']).toBe('WorkBuddy')
    expect(h['X-IDE-Version']).toBe(WB_CLIENT_VERSION)
    expect(h['User-Agent']).toBe(`WorkBuddy/${WB_CLIENT_VERSION}`)
  })

  test('uid 为空时不造空头', () => {
    expect('X-User-Id' in wbAuxEndpointIdentityHeaders('')).toBe(false)
    expect(wbAuxEndpointIdentityHeaders('u1')['X-User-Id']).toBe('u1')
  })

  test('不含 X-Domain（随版本派生）', () => {
    expect('X-Domain' in wbAuxEndpointIdentityHeaders()).toBe(false)
  })
})

describe('Provider 草稿', () => {
  test('两版都带归因头，且 X-Domain 按版本正确', () => {
    const cn = wbSuggestedProvider('cn')
    expect(cn.headers?.['X-Product']).toBe('WorkBuddy')
    expect(cn.headers?.['X-Domain']).toBe('copilot.tencent.com')

    const ai = wbSuggestedProvider('ai')
    expect(ai.headers?.['X-Product']).toBe('WorkBuddy')
    expect(ai.headers?.['X-Domain']).toBe('www.workbuddy.ai')
  })

  test('静态头不含 X-User-Id（逐账号才准，写死会串号）', () => {
    for (const r of ['cn', 'ai'] as const) {
      expect('X-User-Id' in (wbSuggestedProvider(r).headers ?? {})).toBe(false)
    }
  })
})

function wbProvider(over: Partial<Provider> = {}): Provider {
  return {
    providerId: 1, name: 'workbuddy-ai', state: 'active',
    displayName: 'WorkBuddy', accessKind: 'session-reuse', risk: 'medium',
    stability: 'beta', api: 'openai-completions',
    baseUrl: 'https://www.workbuddy.ai/v2',
    credential: { apiKeyEnv: 'WB_TOKEN' },
    headers: { 'X-Product': 'SaaS', 'X-Domain': 'www.workbuddy.ai' },
    priority: 1, models: [],
    ...over,
  }
}

describe('归因头迁移', () => {
  test('把 SaaS 老值补成归因头', () => {
    const s = new MemoryProviderStore()
    s.put(wbProvider())
    expect(migrateWorkBuddyAttributionHeaders(s)).toBe(1)
    expect(s.list()[0]!.headers!['X-Product']).toBe('WorkBuddy')
  })

  test('幂等：跑两次第二次为 0', () => {
    const s = new MemoryProviderStore()
    s.put(wbProvider())
    expect(migrateWorkBuddyAttributionHeaders(s)).toBe(1)
    expect(migrateWorkBuddyAttributionHeaders(s)).toBe(0)
  })

  test('保留用户自定义头', () => {
    const s = new MemoryProviderStore()
    s.put(wbProvider({ headers: { 'X-Custom': 'keepme' } }))
    migrateWorkBuddyAttributionHeaders(s)
    expect(s.list()[0]!.headers!['X-Custom']).toBe('keepme')
  })

  test('非 WorkBuddy 与 deleted 行都不碰', () => {
    const s = new MemoryProviderStore()
    s.put(wbProvider({ providerId: 2, name: 'zen', baseUrl: 'https://opencode.ai/zen/v1', headers: { 'X-Product': 'SaaS' } }))
    s.put(wbProvider({ providerId: 3, state: 'deleted' }))
    expect(migrateWorkBuddyAttributionHeaders(s)).toBe(0)
    expect(s.list().find((p) => p.name === 'zen')!.headers!['X-Product']).toBe('SaaS')
  })
})
