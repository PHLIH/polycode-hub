import { describe, expect, test } from 'vitest'
import { Hono } from 'hono'
import { createAdminApi } from '../src/adminapi/index.ts'
import { MemoryProviderStore, MemoryAccountStore } from '../src/adminapi/store.ts'
import type { DiscoverSource, Finding } from '../src/adminapi/types.ts'
import type { Provider } from '../src/model/index.ts'
import { providerValidate } from '../src/model/index.ts'

class StubDiscover implements DiscoverSource {
  constructor(readonly findings: Finding[]) {}
  scan(): Finding[] { return this.findings }
}

const draft: Provider = {
  providerId: 0, name: 'workbuddy', state: 'active', displayName: 'WB',
  accessKind: 'session-reuse', risk: 'medium', riskNote: 'r', stability: 'beta',
  api: 'openai-completions', baseUrl: 'https://x.example/v2', credential: { apiKeyEnv: 'WB_TOKEN' },
  priority: 1, models: [],
}

const qf: Finding = { key: 'workbuddy', harness: 'WB', status: 'ready', detail: '', suggestedProvider: draft }

function build(providers: Provider[]) {
  return createAdminApi({
    adminKey: 'secret',
    providers: new MemoryProviderStore(providers),
    accounts: new MemoryAccountStore(),
    discover: new StubDiscover([qf]),
  }) as unknown as Hono
}

async function call(app: Hono, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { 'X-Admin-Key': 'secret', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res
}

describe('quick-import 对同名 deleted 行', () => {
  test('库里只有同名 deleted 行时，一键导入必须新建 active 行', async () => {
    const deletedRow: Provider = { ...draft, providerId: 5, state: 'deleted', displayName: 'WorkBuddy' }
    const app = build([deletedRow])
    const res = await call(app, 'POST', '/admin/api/discover/quick-import', { key: 'workbuddy' })
    expect(res.status).toBe(200)
    const out = await res.json() as { created: boolean; provider: Provider }
    expect(out.created).toBe(true)
    expect(out.provider.state).toBe('active')
    expect(out.provider.providerId).not.toBe(5)
    const list = await call(app, 'GET', '/admin/api/providers')
    const rows = ((await list.json()) as { providers: Provider[] }).providers
    const wb = rows.filter(p => p.name === 'workbuddy')
    expect(wb.some(p => p.state === 'active')).toBe(true)
  })
})
