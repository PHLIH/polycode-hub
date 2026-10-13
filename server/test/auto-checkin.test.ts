// WorkBuddy 自动签到单测：时区判定（checkin_schedule）+ 值守类（AutoCheckin）+ 端点契约。
// 全部离线：签到上游调用一律走注入的假 fetch，绝不打真实网络（有上游成本且结果不可复现）。

import { describe, expect, test } from 'vitest'
import { Hono } from 'hono'
import {
  CHECKIN_DAY_CUTOFF_HOUR, checkinDayKey, localDayKey, msUntilNextCheckinDay, signedToday,
} from '../src/pool/checkin_schedule.ts'
import { AutoCheckin, describeNextWindow, type CheckinOutcome } from '../src/pool/auto_checkin.ts'
import { createAdminApi } from '../src/adminapi/index.ts'
import { MemoryAccountStore, MemoryProviderStore } from '../src/adminapi/store.ts'
import { workbuddyTokenHash } from '../src/adminapi/discover_api.ts'
import type { Account, Provider } from '../src/model/index.ts'

// ---- A. 时区判定：本地日历日 + 04:00 跨天边界 ----
//
// 所有用例都用 `new Date(y, m, d, h, min)` 本地构造。用 UTC 字符串构造会在
// 非 UTC 时区的机器上得到不同结论——那正是本模块存在的意义，测试必须先绕开它。

describe('checkin_schedule（本地日历日与 04:00 跨天边界）', () => {
  test('checkinDayKey：本地 03:30 归前一天，04:00 归当天', () => {
    // 边界前一刻与边界整点：两边的「逻辑日」必须不同，否则跨天判定不生效。
    expect(checkinDayKey(new Date(2026, 9, 13, 3, 30))).toBe('2026-10-12')
    expect(checkinDayKey(new Date(2026, 9, 13, CHECKIN_DAY_CUTOFF_HOUR - 1, 59))).toBe('2026-10-12')
    expect(checkinDayKey(new Date(2026, 9, 13, CHECKIN_DAY_CUTOFF_HOUR, 0))).toBe('2026-10-13')
    expect(checkinDayKey(new Date(2026, 9, 13, 23, 59))).toBe('2026-10-13')
  })

  test('localDayKey 与 checkinDayKey 在边界后一致、边界前相差一天', () => {
    const noon = new Date(2026, 9, 13, 12, 0)
    expect(localDayKey(noon)).toBe('2026-10-13')
    expect(checkinDayKey(noon)).toBe(localDayKey(noon))
    const early = new Date(2026, 9, 13, 2, 0)
    expect(checkinDayKey(early)).not.toBe(localDayKey(early))
  })

  test('signedToday：空/不可解析 → false；同逻辑日 → true；跨边界 → false', () => {
    const now = new Date(2026, 9, 13, 10, 0)
    expect(signedToday(undefined, now)).toBe(false)
    expect(signedToday('', now)).toBe(false)
    expect(signedToday('not-a-date', now)).toBe(false)
    // 同一天里的两个时刻（含边界前的 03:50 与边界后的 10:00 属于不同逻辑日）。
    expect(signedToday(new Date(2026, 9, 13, 9, 0).toISOString(), now)).toBe(true)
    expect(signedToday(new Date(2026, 9, 13, 3, 50).toISOString(), now)).toBe(false)
    expect(signedToday(new Date(2026, 9, 12, 20, 0).toISOString(), now)).toBe(false)
  })

  test('msUntilNextCheckinDay：落点是本地 04:00:00.000 且为正', () => {
    for (const now of [
      new Date(2026, 9, 13, 0, 10),
      new Date(2026, 9, 13, 3, 59),
      new Date(2026, 9, 13, 4, 0),
      new Date(2026, 9, 13, 23, 59),
    ]) {
      const ms = msUntilNextCheckinDay(now)
      expect(ms).toBeGreaterThan(0)
      const at = new Date(now.getTime() + ms)
      expect(at.getHours()).toBe(CHECKIN_DAY_CUTOFF_HOUR)
      expect(at.getMinutes()).toBe(0)
      expect(at.getSeconds()).toBe(0)
      expect(at.getMilliseconds()).toBe(0)
      // 落点必须严格晚于 now（不能把「正好 04:00 的现在」算成下一个窗口）。
      expect(at.getTime()).toBeGreaterThan(now.getTime())
    }
  })
})

// ---- B. AutoCheckin 值守 ----

describe('AutoCheckin（值守：开关 + 来源 + 当天去重）', () => {
  const now = new Date(2026, 9, 13, 10, 0)
  const acc = (over: Partial<Account> = {}): Account => ({
    id: 'wb-1', providerId: 1, credential: {}, status: 'available', fails: 0,
    importSource: 'workbuddy', autoCheckin: true,
    workbuddyUid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    workbuddyTokenHash: 'hash-1',
    ...over,
  })
  const mk = (accounts: Account[], run: (id: string) => Promise<CheckinOutcome | undefined>) =>
    new AutoCheckin({ listAccounts: () => accounts, run, log: () => {}, now: () => now })

  test('due：开关开 + WorkBuddy 两版来源 → 命中；未开开关/非 WorkBuddy → 不命中', () => {
    const accounts = [
      acc(),
      acc({ id: 'wb-ai-1', importSource: 'workbuddy-ai' }),
      acc({ id: 'off', autoCheckin: false }),
      acc({ id: 'unset', autoCheckin: undefined }),
      acc({ id: 'zcode', importSource: 'zcode' }),
      acc({ id: 'no-src', importSource: undefined }),
    ]
    const due = mk(accounts, async () => ({ status: 'accepted', message: '' })).due(now)
    expect(due.map((a) => a.id)).toEqual(['wb-1', 'wb-ai-1'])
  })

  test('当天已完成 → 不命中；失败结果 → 按节流重试，需人工的失败 → 当天不再试', () => {
    // 每条用不同 id：本用例要比的是「哪些结果还会再试」，同 id 会让断言分不清是谁。
    // 记录时间统一取「两个小时前」，此时 30 分钟的节流窗已过。
    const at = new Date(2026, 9, 13, 8, 0).toISOString()
    const done = (id: string, r: string) => acc({
      id, lastCheckinAt: at, lastCheckinResult: r, lastCheckinTokenHash: 'hash-1',
    })
    const auto = mk([
      done('acc', 'accepted'), done('already', 'already_checked_in'),
      done('na', 'not_available'), done('fail', 'fail'),
      done('invalid', 'invalid'), done('unauth', 'unauthorized'),
    ], async () => ({ status: 'skipped', message: '' }))
    // 只有 fail 会在节流窗过后再看一次。invalid/unauthorized 要用人工处理，
    // 自动重试不可能变好（且会用废 token 反复打上游）；not_available 是上游
    // 明确说「今天没这个活动」，重试同样没意义。
    expect(auto.due(now).map((a) => a.id)).toEqual(['fail'])
  })

  test('fail 后的重试节流：刚失败过的账号不立刻重试，过窗后才重试', () => {
    // 上游抖动/超时属于「结果未确认」：马上重试等于对上游连打，一直不重试又会让
    // 一次抖动废掉一整天。所以允许复查，但必须隔开。
    const a = acc({
      lastCheckinAt: new Date(2026, 9, 13, 9, 50).toISOString(),
      lastCheckinResult: 'fail', lastCheckinTokenHash: 'hash-1',
    })
    const auto = mk([a], async () => undefined)
    expect(auto.due(new Date(2026, 9, 13, 9, 55))).toHaveLength(0) // 5 分钟后：还在窗内
    expect(auto.due(new Date(2026, 9, 13, 10, 25)).map((x) => x.id)).toEqual(['wb-1']) // 35 分钟后：该复查

    // invalid/unauthorized 即使过了窗也不重试（等人工）。
    for (const r of ['invalid', 'unauthorized']) {
      const b = { ...a, lastCheckinResult: r }
      expect(mk([b], async () => undefined).due(new Date(2026, 9, 13, 23, 0))).toHaveLength(0)
    }
  })

  test('凭据指纹变化 → 即使当天已签也命中（重新登录导入后立即用新登录态重试）', () => {
    const a = acc({
      lastCheckinAt: new Date(2026, 9, 13, 9, 0).toISOString(),
      lastCheckinResult: 'accepted', lastCheckinTokenHash: 'old-hash',
      workbuddyTokenHash: 'new-hash',
    })
    expect(mk([a], async () => undefined).due(now).map((x) => x.id)).toEqual(['wb-1'])
    // 指纹一致时不重签（否则每轮 tick 都会再打一次上游）。
    const b = { ...a, lastCheckinTokenHash: 'new-hash' }
    expect(mk([b], async () => undefined).due(now)).toHaveLength(0)
  })

  test('due 用逻辑日而非 24 小时：同一条记录在边界前后结论相反', () => {
    // 记录时间 10-13 03:50（属于逻辑日 10-12）。
    const a = acc({
      lastCheckinAt: new Date(2026, 9, 13, 3, 50).toISOString(),
      lastCheckinResult: 'accepted', lastCheckinTokenHash: 'hash-1',
    })
    const auto = mk([a], async () => undefined)
    // 03:55 仍在逻辑日 10-12 内 → 当天已完成，不签；
    // 04:05 已进入逻辑日 10-13 → 新的一天，该签。
    expect(auto.due(new Date(2026, 9, 13, 3, 55))).toHaveLength(0)
    expect(auto.due(new Date(2026, 9, 13, 4, 5)).map((x) => x.id)).toEqual(['wb-1'])
  })

  test('tick：按结果归类计数，run 抛异常/返回 undefined 都不冒泡', async () => {
    const accounts = [
      acc({ id: 'ok' }), acc({ id: 'dup' }), acc({ id: 'bad' }), acc({ id: 'boom' }), acc({ id: 'none' }),
    ]
    const calls: string[] = []
    const run = async (id: string): Promise<CheckinOutcome | undefined> => {
      calls.push(id)
      if (id === 'ok') return { status: 'accepted', message: 'x' }
      if (id === 'dup') return { status: 'already_checked_in', message: 'x' }
      if (id === 'bad') return { status: 'fail', message: 'x' }
      if (id === 'boom') throw new Error('上游炸了')
      return undefined
    }
    const stats = await mk(accounts, run).tick(now)
    expect(calls).toEqual(['ok', 'dup', 'bad', 'boom', 'none']) // 串行且不跳号
    expect(stats).toEqual({ checked: 5, ok: 2, failed: 3 })
  })

  test('tick：not_available（活动未开启）算已处理而非失败', async () => {
    // 海外版实测：上游回 400/code 10001「签到活动未开启或已过期」。
    // 这不是故障，日志与计数不该把它长期报成一个错误。
    const stats = await mk([acc()], async () => ({ status: 'not_available', message: 'x' })).tick(now)
    expect(stats).toEqual({ checked: 1, ok: 1, failed: 0 })
  })

  test('tick 重入保护：上一轮未结束时不并发第二轮', async () => {
    let release: (() => void) | undefined
    let started = 0
    const auto = mk([acc()], async () => {
      started++
      await new Promise<void>((r) => { release = r })
      return { status: 'accepted', message: '' }
    })
    const first = auto.tick(now)
    // 等第一轮的 run 真正开始（tick 内部先做 due 过滤，是同步段，随后才 await run）。
    await Promise.resolve()
    expect(started).toBe(1)
    expect(await auto.tick(now)).toEqual({ checked: 0, ok: 0, failed: 0 })
    release?.()
    expect((await first).ok).toBe(1)
    expect(started).toBe(1)
  })

  test('describeNextWindow 给人话（时/分）', () => {
    const s = describeNextWindow(new Date(2026, 9, 13, 3, 0))
    expect(s).toMatch(/后$/)
    expect(s).toContain('小时')
  })
})

// ---- C. adminapi 端点：开关 PATCH + 自动签到 ----

describe('adminapi 自动签到端点', () => {
  const TOKEN = 'wb-auto-checkin-token'
  const ENV = 'WB_AUTO_CHECKIN_TEST_TOKEN'
  const UID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

  const wbProvider = (): Provider => ({
    providerId: 7, name: 'wb-auto', state: 'active', displayName: 'WB', accessKind: 'session-reuse',
    risk: 'medium', stability: 'beta', api: 'openai-completions',
    baseUrl: 'https://copilot.tencent.com/v2', credential: {}, priority: 0, models: [],
  })
  const wbAccount = (over: Partial<Account> = {}): Account => ({
    id: 'wb-1', providerId: 7, displayName: '主号', credential: { apiKeyEnv: ENV },
    status: 'available', fails: 0, importSource: 'workbuddy',
    workbuddyUid: UID, workbuddyTokenHash: workbuddyTokenHash(TOKEN),
    ...over,
  })
  const jsonFetch = (status: number, body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

  const build = (o: { accounts: Account[]; workbuddyCheckinFetch?: typeof fetch }) => {
    const store = new MemoryAccountStore(o.accounts)
    const app = createAdminApi({
      adminKey: 'secret',
      providers: new MemoryProviderStore([wbProvider()]),
      accounts: store,
      workbuddyCheckinFetch: o.workbuddyCheckinFetch,
    })
    return { app, store }
  }
  const post = (app: Hono, path: string) =>
    app.request(path, { method: 'POST', headers: { 'X-Admin-Key': 'secret', 'Content-Type': 'application/json' } })
  const patch = (app: Hono, path: string, body: unknown) =>
    app.request(path, {
      method: 'PATCH',
      headers: { 'X-Admin-Key': 'secret', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  const withEnv = async (fn: () => Promise<void>): Promise<void> => {
    const prev = process.env[ENV]
    process.env[ENV] = TOKEN
    try { await fn() } finally {
      if (prev === undefined) delete process.env[ENV]
      else process.env[ENV] = prev
    }
  }

  test('autoCheckin 可 PATCH 开，可 PATCH 关（false 删除字段）', async () => {
    const { app, store } = build({ accounts: [wbAccount()] })
    const on = await patch(app, '/admin/api/accounts/wb-1', { autoCheckin: true })
    expect(on.status).toBe(200)
    expect((await on.json() as { autoCheckin?: boolean }).autoCheckin).toBe(true)
    expect(store.get('wb-1')?.autoCheckin).toBe(true)

    // 关 = 字段消失（而不是留一个 false）：配置里不该有语义重复的两种「关」。
    const off = await patch(app, '/admin/api/accounts/wb-1', { autoCheckin: false })
    expect(off.status).toBe(200)
    const offBody = await off.json() as Record<string, unknown>
    expect('autoCheckin' in offBody).toBe(false)
    expect(store.get('wb-1')?.autoCheckin).toBeUndefined()
  })

  test('autoCheckin：非布尔 → 400', async () => {
    const { app } = build({ accounts: [wbAccount()] })
    expect((await patch(app, '/admin/api/accounts/wb-1', { autoCheckin: 'yes' })).status).toBe(400)
  })

  test('auto-checkin：未开开关 → skipped，且不打上游', async () => {
    let called = 0
    const { app, store } = build({
      accounts: [wbAccount()],
      workbuddyCheckinFetch: (async () => { called++; return new Response('{}', { status: 200 }) }) as typeof fetch,
    })
    const res = await post(app, '/admin/api/accounts/wb-1/auto-checkin')
    expect(res.status).toBe(200)
    expect((await res.json() as { status: string }).status).toBe('skipped')
    expect(called).toBe(0)
    // 跳过不该留下签到记录（否则会把「当天已签」骗过去）。
    expect(store.get('wb-1')?.lastCheckinAt).toBeUndefined()
  })

  test('auto-checkin：成功 → accepted，落 lastCheckinAt/Status/Result/TokenHash', async () => {
    await withEnv(async () => {
      const { app, store } = build({
        accounts: [wbAccount({ autoCheckin: true })],
        workbuddyCheckinFetch: jsonFetch(200, { code: 0, msg: 'OK' }),
      })
      const res = await post(app, '/admin/api/accounts/wb-1/auto-checkin')
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ status: 'accepted' })
      const after = store.get('wb-1')!
      expect(after.lastCheckinResult).toBe('accepted')
      expect(after.lastCheckinStatus).toBe('已签到')
      expect(Number.isNaN(new Date(after.lastCheckinAt!).getTime())).toBe(false)
      // 指纹一起落：定时器靠它判「凭据是否换过」。
      expect(after.lastCheckinTokenHash).toBe(workbuddyTokenHash(TOKEN))
    })
  })

  test('auto-checkin：上游 400/code 10001「今日已签」→ already_checked_in；「活动未开启」→ not_available', async () => {
    await withEnv(async () => {
      const { app, store } = build({
        accounts: [wbAccount({ autoCheckin: true })],
        workbuddyCheckinFetch: jsonFetch(400, { code: 10001, msg: '今天已签到，请明天再来' }),
      })
      const res = await post(app, '/admin/api/accounts/wb-1/auto-checkin')
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ status: 'already_checked_in' })
      expect(store.get('wb-1')?.lastCheckinResult).toBe('already_checked_in')

      // 同码不同文案 = 另一个业务答复（海外版实测）。**原话透给用户**，
      // 不替上游编语义；同时按「今天没得签」记，不当未知结果。
      const na = build({
        accounts: [wbAccount({ autoCheckin: true })],
        workbuddyCheckinFetch: jsonFetch(400, { code: 10001, msg: '签到活动未开启或已过期' }),
      })
      const r2 = await post(na.app, '/admin/api/accounts/wb-1/auto-checkin')
      expect(await r2.json()).toMatchObject({ status: 'not_available' })
      expect(na.store.get('wb-1')?.lastCheckinResult).toBe('not_available')
      expect(na.store.get('wb-1')?.lastCheckinStatus).toContain('签到活动未开启或已过期')
    })
  })

  test('auto-checkin：上游 401 → unauthorized；上游抛错 → fail（都落盘）', async () => {
    await withEnv(async () => {
      const un = build({
        accounts: [wbAccount({ autoCheckin: true })],
        workbuddyCheckinFetch: jsonFetch(401, { code: 401, msg: 'unauthorized' }),
      })
      const r1 = await post(un.app, '/admin/api/accounts/wb-1/auto-checkin')
      expect(await r1.json()).toMatchObject({ status: 'unauthorized' })
      expect(un.store.get('wb-1')?.lastCheckinResult).toBe('unauthorized')

      const boom = build({
        accounts: [wbAccount({ autoCheckin: true })],
        workbuddyCheckinFetch: (async () => { throw new Error('网络断了') }) as typeof fetch,
      })
      const r2 = await post(boom.app, '/admin/api/accounts/wb-1/auto-checkin')
      expect(await r2.json()).toMatchObject({ status: 'fail' })
      expect(boom.store.get('wb-1')?.lastCheckinResult).toBe('fail')
    })
  })

  test('auto-checkin：未知账号 404', async () => {
    const { app } = build({ accounts: [] })
    expect((await post(app, '/admin/api/accounts/nope/auto-checkin')).status).toBe(404)
  })

  test('签到记录字段只读：PATCH 带 lastCheckinAt → 400；新建带 lastCheckinStatus → 400', async () => {
    const { app } = build({ accounts: [wbAccount()] })
    expect((await patch(app, '/admin/api/accounts/wb-1', { lastCheckinAt: '2026-01-01T00:00:00.000Z' })).status).toBe(400)
    expect((await patch(app, '/admin/api/accounts/wb-1', { lastCheckinResult: 'accepted' })).status).toBe(400)

    const created = await app.request('/admin/api/accounts', {
      method: 'POST',
      headers: { 'X-Admin-Key': 'secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'x1', providerId: 7, lastCheckinStatus: '已签到' }),
    })
    expect(created.status).toBe(400)
  })
})
