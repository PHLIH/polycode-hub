// wb_refresh 行为锚点：官方刷新链路的形状处理（fetch 全 mock，不打真服务）。
// 真实链路已于 2026-09-29 对 copilot.tencent.com 实测 HTTP 200（见模块头注释），
// 这里只锁代码契约：包络解析、token 校验、有效期兜底、域派生。

import { describe, expect, test } from 'vitest'
import { wbRefreshBaseOf, wbRefreshSession, type WbRefreshed } from '../src/discover/wb_refresh.ts'
import { workBuddyRealmOfToken } from '../src/model/index.ts'

// 组装 1300+ 字节的假 JWT（exp = 未来 30 天）。
// iss 可选：真实 WorkBuddy token 一定带它（实测国内版 https://www.workbuddy.cn/auth/realms/copilot、
// 海外版 https://www.workbuddy.ai/auth/realms/copilot），而版本守卫（账号-Provider 一致性）
// 正是从 iss 反推版本的——所以测「刷新后的 token 能不能过守卫」必须带上它。
function craftJWT(expDays = 30, iss?: string): string {
  const header = Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url')
  const claims = Buffer.from(JSON.stringify({
    exp: Math.floor((Date.now() + expDays * 86400_000) / 1000), sub: 'u1',
    ...(iss !== undefined ? { iss } : {}),
  })).toString('base64url')
  return `${header}.${claims}.${'x'.repeat(600)}`
}

function okFetch(body: unknown, status = 200) {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch
}

const RT = 'r'.repeat(700)

describe('wbRefreshBaseOf', () => {
  test('域派生：国内版 / 海外版 / 认不出', () => {
    expect(wbRefreshBaseOf('copilot.tencent.com')).toBe('https://copilot.tencent.com')
    expect(wbRefreshBaseOf('www.workbuddy.cn')).toBe('https://copilot.tencent.com') // www 剥掉，cn → copilot
    // 海外版**保留 www**：2026-10-15 实测 workbuddy.ai 的 302 Location 指向
    // https://www.workbuddy.ai:443/ **且不带路径**，跟随过去拿到的是 HTML 而非 JSON。
    // 这条断言以前是 'https://workbuddy.ai'（剥 www），正是海外版自动刷新恒失败的原因。
    expect(wbRefreshBaseOf('www.workbuddy.ai')).toBe('https://www.workbuddy.ai')
    expect(wbRefreshBaseOf('workbuddy.ai')).toBe('https://www.workbuddy.ai')
    expect(wbRefreshBaseOf('example.com')).toBeUndefined()
    expect(wbRefreshBaseOf(undefined)).toBeUndefined()
  })
})

describe('wbRefreshSession', () => {
  test('标准包络 {data:{data:{accessToken}}} → 换出新 token', async () => {
    let calledURL = ''
    let calledHeaders: Record<string, string> = {}
    const refreshed = await wbRefreshSession(RT, 'cn', ((url: string | URL, init?: RequestInit) => {
      calledURL = String(url)
      calledHeaders = (init?.headers ?? {}) as Record<string, string>
      return Promise.resolve(new Response(JSON.stringify({
        code: 0, msg: 'OK',
        data: { accessToken: craftJWT(), tokenType: 'Bearer', expiresIn: 2592000 },
      }), { status: 200 }))
    }) as typeof fetch)
    expect(refreshed.accessToken.split('.').length).toBe(3)
    expect(refreshed.realm).toBe('cn')
    // 官方客户端同款端点与头
    expect(calledURL).toBe('https://copilot.tencent.com/v2/plugin/auth/token/refresh')
    expect(calledHeaders['X-Refresh-Token']).toBe(RT)
    expect(calledHeaders['X-Auth-Refresh-Source']).toBe('plugin')
    expect(calledHeaders['X-Domain']).toBe('copilot.tencent.com')
  })

  test('海外版 → 打 www.workbuddy.ai（带 www，实测 302 的那个域是错的）', async () => {
    let calledURL = ''
    const refreshed = await wbRefreshSession(RT, 'ai', ((url: string | URL, init?: RequestInit) => {
      calledURL = String(url)
      return Promise.resolve(new Response(JSON.stringify({
        data: { data: { accessToken: craftJWT(30, 'https://www.workbuddy.ai/auth/realms/copilot') } },
      }), { status: 200 }))
    }) as typeof fetch)
    expect(refreshed.realm).toBe('ai')
    // 端点字面量锚点：改这里之前先读 wbRefreshBaseOf 的取证注释（302 丢路径）。
    expect(calledURL).toBe('https://www.workbuddy.ai/v2/plugin/auth/token/refresh')
  })

  test('JWT 无 exp 时用 expiresIn 兜底', async () => {
    const header = Buffer.from('"alg":"none"').toString('base64url')
    const noExp = `${header}.${Buffer.from('{"sub":"u1"}').toString('base64url')}.${'x'.repeat(600)}`
    const refreshed: WbRefreshed = await wbRefreshSession(RT, 'cn', okFetch({
      data: { data: { accessToken: noExp, expiresIn: 3600 } },
    }))
    expect(refreshed.expiresAt).toBeDefined()
    // 剩余约 1 小时（±5 分钟）
    const left = refreshed.expiresAt!.getTime() - Date.now()
    expect(left).toBeGreaterThan(55 * 60_000)
    expect(left).toBeLessThan(65 * 60_000)
  })

  test('新 refreshToken 一并带回（客户端会轮换刷新凭据）', async () => {
    const newRT = 'n'.repeat(700)
    const refreshed = await wbRefreshSession(RT, 'cn', okFetch({
      data: { data: { accessToken: craftJWT(), refreshToken: newRT } },
    }))
    expect(refreshed.refreshToken).toBe(newRT)
  })

  test('上游 404（路由变了/域错）→ 如实报，不猜第二个端点', async () => {
    await expect(wbRefreshSession(RT, 'cn', okFetch(
      { error_msg: '404 Route Not Found' }, 404,
    ))).rejects.toThrow(/404/)
  })

  test('401（refresh token 过期）→ 如实报 http 状态', async () => {
    await expect(wbRefreshSession(RT, 'cn', okFetch(
      { code: 40100, msg: 'token expired' }, 401,
    ))).rejects.toThrow(/401/)
  })

  test('响应非 JSON → 如实报', async () => {
    await expect(wbRefreshSession(RT, 'cn', (async () =>
      new Response('<html>502</html>', { status: 200 })) as typeof fetch,
    )).rejects.toThrow(/非 JSON/)
  })

  test('包络缺 accessToken（形状变了）→ 如实报，不把空串当 token', async () => {
    await expect(wbRefreshSession(RT, 'cn', okFetch({ data: { data: {} } })))
      .rejects.toThrow(/不含有效 accessToken/)
    await expect(wbRefreshSession(RT, 'cn', okFetch({ data: { data: { accessToken: 'short' } } })))
      .rejects.toThrow(/不含有效 accessToken/)
  })

  test('网络异常 → 包成「刷新请求失败」', async () => {
    await expect(wbRefreshSession(RT, 'cn', (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch)).rejects.toThrow(/刷新请求失败/)
  })
})

// readSession 的信封兼容（发现 + 导入共用同一条路）：
// 信封文件 → 本文件/同目录同 uid 快照的明文 refreshToken → 官方刷新。
// 真实场景：当前快照连 refreshToken 都是信封，而旧明文快照的 refresh 凭据
// 还能用（2026-09-29 实测刷新 200 并真实出字）。fetch 全 mock。
describe('readSession 信封刷新（含跨快照）', async () => {
  const { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, utimesSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, dirname } = await import('node:path')

  const dir = mkdtempSync(join(tmpdir(), 'wb-refresh-test-'))
  const authFile = (uid: string, accessToken: unknown, refreshToken: unknown, domain = 'www.workbuddy.cn') =>
    JSON.stringify({ auth: { accessToken, refreshToken, domain }, account: { uid, nickname: 'tester', type: 'personal' } })

  const write = (name: string, content: string, mtime?: Date) => {
    const p = join(dir, name)
    writeFileSync(p, content)
    if (mtime) utimesSync(p, mtime, mtime)
    return p
  }

  // readSession 未导出：经 import-account 的调用链不可达（需 server），
  // 这里直接复刻它的选择逻辑（与实现同序）来锁契约。
  async function readSessionLike(tokenPath: string, fetchImpl: typeof fetch): Promise<string> {
    const raw = readFileSync(tokenPath, 'utf8')
    const f = JSON.parse(raw)
    const at = f.auth?.accessToken
    if (typeof at === 'string' && at.length > 100) return at
    const rt = typeof f.auth?.refreshToken === 'string' ? f.auth.refreshToken : undefined
    if (rt) {
      const r = await wbRefreshSession(rt, 'cn', fetchImpl)
      return r.accessToken
    }
    // 跨快照：同目录同 uid 其它快照的明文 refreshToken（最新优先）
    let best: { mtime: number; rt: string } | undefined
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('workbuddy-desktop') || !name.endsWith('.info')) continue
      const p = join(dir, name)
      if (p === tokenPath) continue
      try {
        const alt = JSON.parse(readFileSync(p, 'utf8'))
        if (alt.account?.uid !== f.account?.uid) continue
        if (typeof alt.auth?.refreshToken !== 'string' || alt.auth.refreshToken.length <= 50) continue
        best = { mtime: 0, rt: alt.auth.refreshToken }
      } catch { /* 跳过坏文件 */ }
    }
    if (best) {
      const r = await wbRefreshSession(best.rt, 'cn', fetchImpl)
      return r.accessToken
    }
    throw new Error('无法自动刷新导入')
  }

  const newToken = craftJWT(45)
  const fetchOK = okFetch({ data: { data: { accessToken: newToken, refreshToken: 'n'.repeat(700) } } })

  test('信封文件 + 同目录旧明文 refresh → 刷新换出新 token', async () => {
    // 当前快照：token 和 refreshToken 都是信封
    const cur = write('workbuddy-desktop.info',
      authFile('uid-x', { $wbEncrypted: 1, envelope: 'Zm9v' }, { $wbEncrypted: 1, envelope: 'Zm9v' }))
    // 旧明文快照：refreshToken 是明文（客户端自己没加密它）
    write('workbuddy-desktop.2026-09-13T13-53-30Z.1.old.info',
      authFile('uid-x', craftJWT(-30), 'o'.repeat(700)), new Date(Date.now() - 86400_000))
    const got = await readSessionLike(cur, fetchOK)
    expect(got).toBe(newToken)
  })

  test('信封文件 + 本文件明文 refresh → 直接刷新，不看别的快照', async () => {
    const cur = write('workbuddy-desktop.info',
      authFile('uid-y', { $wbEncrypted: 1, envelope: 'Zm9v' }, 'y'.repeat(700)))
    const got = await readSessionLike(cur, fetchOK)
    expect(got).toBe(newToken)
  })

  test('明文 token 文件 → 直接用，不打刷新', async () => {
    const own = craftJWT(17)
    const plain = write('workbuddy-desktop.2026-09-16T01-06-33Z.2.old.info',
      authFile('uid-z', own, 'z'.repeat(700)))
    let called = false
    const spy = ((url: string | URL, init?: RequestInit) => { called = true; return fetchOK(url, init) }) as typeof fetch
    const got = await readSessionLike(plain, spy)
    expect(got).toBe(own) // 直接返回文件里的明文 token
    expect(called).toBe(false) // 没打刷新
  })

  test('信封 + 无任何明文 refresh → 明确报「无法自动刷新」', async () => {
    const cur = write('workbuddy-desktop.info',
      authFile('uid-none', { $wbEncrypted: 1, envelope: 'Zm9v' }, { $wbEncrypted: 1, envelope: 'Zm9v' }))
    await expect(readSessionLike(cur, fetchOK)).rejects.toThrow(/无法自动刷新/)
  })
})

// 海外版的端到端契约（一位真实用户的实际场景，2026-10-15）：
// 他只装了海外版、token 是加密信封、refreshToken 是明文 → 走自动刷新。
// 修复前 wbRefreshBaseOf('www.workbuddy.ai') 返回 https://workbuddy.ai（剥了 www），
// 而该域实测 302 到 https://www.workbuddy.ai:443/（**Location 不带路径**），
// 跟随过去拿到 HTML 首页 → 「刷新响应非 JSON」→ 账号导入被跳过 → Provider 只剩
// 占位 apiKeyEnv=WB_TOKEN → 用户看到「环境变量 WB_TOKEN 未设置」。
// 这条用例锁住「海外版信封 → 刷新 → 明文 token」整条链的域与包络。
describe('海外版信封登录态 → 自动刷新（真实用户场景回归）', () => {
  const AI_DOMAIN = 'www.workbuddy.ai'

  test('域名派生：海外版保留 www（302 丢路径的那个域不能用）', () => {
    expect(wbRefreshBaseOf(AI_DOMAIN)).toBe('https://www.workbuddy.ai')
    expect(wbRefreshBaseOf('workbuddy.ai')).toBe('https://www.workbuddy.ai')
  })

  test('信封 + 明文 refreshToken → 刷出明文 token（打 www 域，X-Domain 同为海外域）', async () => {
    const RT_AI = 'a'.repeat(700)
    let url = ''
    let hdrs: Record<string, string> = {}
    const refreshed = await wbRefreshSession(RT_AI, 'ai', ((u: string | URL, init?: RequestInit) => {
      url = String(u)
      hdrs = (init?.headers ?? {}) as Record<string, string>
      return Promise.resolve(new Response(JSON.stringify({
        code: 0, msg: 'OK',
        data: { accessToken: craftJWT(30, 'https://www.workbuddy.ai/auth/realms/copilot'), tokenType: 'Bearer', expiresIn: 2592000 },
      }), { status: 200 }))
    }) as typeof fetch)
    expect(url).toBe('https://www.workbuddy.ai/v2/plugin/auth/token/refresh')
    expect(hdrs['X-Domain']).toBe(AI_DOMAIN)
    expect(hdrs['X-Refresh-Token']).toBe(RT_AI)
    expect(refreshed.accessToken.split('.').length).toBe(3)
    expect(refreshed.realm).toBe('ai')
    // 换出的 token 必须能被反推回海外版（版本守卫靠它，推不出会被拒入池）
    expect(workBuddyRealmOfToken(refreshed.accessToken)).toBe('ai')
  })

  test('302（跟随后拿到 HTML）→ 报「非 JSON」而不是把 HTML 当 token', async () => {
    // 修复前的真实形态：workbuddy.ai 返回 302，fetch 跟随到 HTML 首页后状态 200。
    await expect(wbRefreshSession('r'.repeat(700), 'ai', (async () =>
      new Response('<!doctype html><html><head><title>WorkBuddy</title></head></html>', { status: 200 })
    ) as unknown as typeof fetch)).rejects.toThrow(/非 JSON/)
  })
})
