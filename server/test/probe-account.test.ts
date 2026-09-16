// 账号测试（Probe.probeAccount）：钉死账号打真实请求，结果计入账号状态。
//
// 要验的三件事：
//   1. 用的是「这个账号」的凭据，不是轮询出来的那个；
//   2. 测通 → 连败清零、冷却解除（测试即人工验证手段）；
//   3. 测挂 → 连败 ++，并按失败原因决定冷却时长（auth 30min）。

import { afterEach, describe, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { Probe } from '../src/gateway/probe.ts'
import { AccountPool } from '../src/pool/account.ts'
import { Scheduler } from '../src/router/scheduler.ts'
import { Upstream } from '../src/router/upstream.ts'
import { accountHealth, type Account, type Provider } from '../src/model/index.ts'
import '../src/codec/anthropicmessages.ts'
import '../src/codec/openaicompletions.ts'
import '../src/codec/openairesponses.ts'

let server: Server | null = null
const gotAuth: string[] = []

afterEach(() => {
  if (server) { server.close(); server = null }
  gotAuth.length = 0
})

// 回一条能解析的 OpenAI 流式响应；auth=401 时是鉴权失败。
function chatServer(mode: 'ok' | 'auth'): Promise<string> {
  server = createServer((req, res) => {
    gotAuth.push(String(req.headers.authorization ?? ''))
    if (mode === 'auth') {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"bad key"}}')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"pong"},"index":0}]}\n\n')
    res.write('data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  return new Promise<string>((r) => {
    server!.listen(0, '127.0.0.1', () =>
      r(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`))
  })
}

// 账号归属 Provider（providerId 必须与 mkProbe 造的 Provider.providerId 一致，否则 pick 不到）。
// 这是数字内部 id：改名不会让账号掉队。
const PROV_ID = 1

const acct = (over: Partial<Account> & { id: string }): Account => ({
  providerId: PROV_ID, credential: {}, status: 'available', fails: 0, ...over,
})

// 凭据解析：把 apiKeyEnv 当密钥本身（测试里够用，probe 只管塞进 Authorization）。
function mkProbe(baseUrl: string, accounts: Account[]): { probe: Probe; pool: AccountPool } {
  const p: Provider = {
    providerId: PROV_ID, name: 'prov', displayName: 'd', accessKind: 'official', risk: 'low',
    riskNote: '', stability: 'stable', api: 'openai-completions', baseUrl,
    credential: {}, headers: {}, state: 'active', priority: 1, streamOnly: false,
    models: [{ id: 'm1', input: ['text'], manual: false, enabled: true }],
  }
  const pool = new AccountPool(accounts)
  // 凭据解析：apiKeyEnv 直接当密钥（测试里够用，probe 只管塞进 Authorization）。
  const up = new Upstream({ credLookup: (name) => [name, true] })
  return { probe: new Probe(new Scheduler([p], 'high'), up, null, pool), pool }
}

describe('账号测试：钉账号 + 状态计入', () => {
  test('用该账号的凭据，不是 Provider 级凭据', async () => {
    const base = await chatServer('ok')
    const { probe } = mkProbe(base, [
      acct({ id: 'wb-1', providerId: 1, credential: { apiKeyEnv: 'KEY_OF_WB1' } }),
      acct({ id: 'wb-2', providerId: 1, credential: { apiKeyEnv: 'KEY_OF_WB2' } }),
    ])
    const r = await probe.probeAccount('wb-2', 'm1')
    expect(r.ok).toBe(true)
    expect(gotAuth.every((a) => a.includes('KEY_OF_WB2'))).toBe(true)
    expect(gotAuth.some((a) => a.includes('KEY_OF_WB1'))).toBe(false)
  })

  test('测通：连败清零 + 冷却解除（健康度回到绿）', async () => {
    const base = await chatServer('ok')
    const { probe, pool } = mkProbe(base, [
      acct({ id: 'a', fails: 5, status: 'cooldown', cooldownUntil: new Date(Date.now() + 600_000) }),
    ])
    expect(accountHealth(pool.snapshot()[0]!, new Date())).toBe('warn')
    const r = await probe.probeAccount('a', 'm1')
    expect(r.ok).toBe(true)
    const a = pool.snapshot()[0]!
    expect(a.fails).toBe(0)
    expect(a.status).toBe('available')
    expect(accountHealth(a, new Date())).toBe('ok')
  })

  test('测挂（401）：连败 ++ 并按 auth 冷却 30min', async () => {
    const base = await chatServer('auth')
    const { probe, pool } = mkProbe(base, [acct({ id: 'a' })])
    const r = await probe.probeAccount('a', 'm1')
    expect(r.ok).toBe(false)
    const a = pool.snapshot()[0]!
    expect(a.fails).toBe(1)
    expect(a.status).toBe('cooldown')
    // auth → 30min（±1s 容差）
    const left = (a.cooldownUntil!.getTime() - Date.now()) / 60_000
    expect(left).toBeGreaterThan(29)
    expect(left).toBeLessThan(31)
  })

  test('账号不存在 / 无 Provider：如实报错，不抛异常', async () => {
    const base = await chatServer('ok')
    const { probe } = mkProbe(base, [acct({ id: 'a', providerId: 999 })])
    expect((await probe.probeAccount('nope', 'm1')).error).toMatch(/不存在/)
    // 归属 Provider 不存在 → 如实报错
    expect((await probe.probeAccount('a', 'm1')).error).toMatch(/不存在/)
  })
})
