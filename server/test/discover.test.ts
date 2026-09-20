// discover 行为锚点（复刻 Go internal/discover/*_test.go，fixture 全在临时目录）。

import { describe, expect, test, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkWorkBuddy, checkWorkBuddyWithAccounts, checkZCode, checkZen, discoverWorkBuddyAccounts,
  discoverWorkBuddyModels, workBuddyAuthDirs, workBuddySearchPaths, searchWorkBuddyAuthFiles,
  detectRealmFromAuth,
  parseFingerprintFromLog, openCodeDataDirs,
  Scanner, defaultConfig, type ScanConfig, zenProbeRequest, pruneStaleDraftModels,
} from '../src/discover/index.ts'
import { providerValidate, type Provider } from '../src/model/index.ts'

function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'discover-test-'))
}

// 组装仅载荷有意义的未签名 JWT（解析只读 claims，不验签）。
function craftJWT(exp: Date): string {
  const b64 = Buffer.from(JSON.stringify({ exp: Math.floor(exp.getTime() / 1000), sub: 'u1' }))
    .toString('base64url')
  return `eyJhbGciOiJub25lIn0.${b64}.sig`
}

async function writeAuthFile(
  dir: string, name: string, token: string,
  account: Record<string, unknown> = { uid: '16e123c7', nickname: ' tester ', type: 'personal' },
): Promise<string> {
  const raw = JSON.stringify({
    auth: { accessToken: token, tokenType: 'Bearer', domain: 'copilot.tencent.com' },
    account,
  })
  const path = join(dir, name)
  await writeFile(path, raw, 'utf8')
  return path
}

describe('checkWorkBuddy', () => {
  test('有效登录态 → ready，脱敏无 token 原文，建议 Provider 合法', async () => {
    const dir = await tempDir()
    const path = await writeAuthFile(dir, 'workbuddy-desktop.info', craftJWT(new Date(Date.now() + 90 * 86400_000)))
    const { finding: f, ok } = checkWorkBuddy([path])
    expect(ok).toBe(true)
    expect(f.status).toBe('ready')
    expect(JSON.stringify(f)).not.toContain('eyJhbGciOiJub25lIn0')
    expect(f.detail).toContain('tester')
    expect(f.detail).toContain(path)
    expect(f.actions?.length).toBeGreaterThan(0)
    const p = f.suggestedProvider as Provider
    expect(p.api).toBe('openai-completions')
    expect(providerValidate(p)).toBeUndefined()
  })

  // 草稿**不预填猜的模型名**（2026-09-17 实测新用户路径）：曾写死 hy3-preview，
  // 用户按真实模型名（hy4-preview）调用 404；而占位名有时上游还认、调用出字，
  // 让用户以为配好了——比 404 更难发现。真实目录由导入时自动扫描补全。
  test('草稿不预填猜测的模型，模型目录为空', async () => {
    const dir = await tempDir()
    const path = await writeAuthFile(dir, 'workbuddy-desktop.info', craftJWT(new Date(Date.now() + 86400_000)))
    const { finding: f } = checkWorkBuddy([path])
    expect((f.suggestedProvider as Provider).models).toEqual([])
  })

  // WorkBuddy 上游对非流式回 404 Route Not Found（实测）。声明 streamOnly，
  // 非流式调用才能命中 proxy 里那段专门提示，而不是让用户去核对模型列表。
  test('草稿声明 streamOnly（非流式应给「只支持流式」提示）', async () => {
    const dir = await tempDir()
    const path = await writeAuthFile(dir, 'workbuddy-desktop.info', craftJWT(new Date(Date.now() + 86400_000)))
    const { finding: f } = checkWorkBuddy([path])
    expect((f.suggestedProvider as Provider).streamOnly).toBe(true)
  })

  test('过期 token → expired，仍给续登指引', async () => {
    const dir = await tempDir()
    const path = await writeAuthFile(dir, 'workbuddy-desktop.info', craftJWT(new Date(Date.now() - 3600_000)))
    const { finding: f, ok } = checkWorkBuddy([path])
    expect(ok).toBe(true)
    expect(f.status).toBe('expired')
    expect(f.actions?.length).toBeGreaterThan(0)
  })

  test('无文件/坏文件 → ok=false', async () => {
    const missing = checkWorkBuddy([join(await tempDir(), 'nope.info')])
    expect(missing.ok).toBe(false)
    const dir = await tempDir()
    const bad = join(dir, 'workbuddy-desktop.info')
    await writeFile(bad, '{not json', 'utf8')
    expect(checkWorkBuddy([bad]).ok).toBe(false)
  })

  test('token 无法解析有效期 → unknown', async () => {
    const dir = await tempDir()
    const path = await writeAuthFile(dir, 'workbuddy-desktop.info', 'not-a-jwt')
    const { finding: f } = checkWorkBuddy([path])
    expect(f.status).toBe('unknown')
    expect(f.detail).toContain('有效期不明')
  })
})

describe('search paths', () => {
  test('各 OS 路径表非空且含桌面 auth 文件名', () => {
    for (const goos of ['darwin', 'linux', 'windows']) {
      const paths = workBuddySearchPaths(goos, '/home/u', 'C:\\Users\\u')
      expect(paths.length).toBeGreaterThan(0)
      expect(paths.some((p) => p.endsWith('workbuddy-desktop.info'))).toBe(true)
    }
  })

  test('darwin 目录候选覆盖真实 CodeBuddyExtension auth 目录', () => {
    const dirs = workBuddyAuthDirs('darwin', '/home/u', '/home/u')
    // join 的分隔符随宿主平台变（本机跑测试是 win32），断言按「层级」匹配。
    const norm = dirs.map((d) => d.replace(/\\/g, '/'))
    expect(norm).toContain('/home/u/Library/Application Support/CodeBuddyExtension/Data/Public/auth')
  })

  // 真实缺陷（2026-09-17）：Windows 只扫了 AppData\Roaming，而桌面端登录态实际落在
  // AppData\Local\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
  // → 已登录的机器一律报 missing（「没登录」的误诊）。Local 必须被覆盖。
  test('windows 目录候选同时覆盖 Local 与 Roaming', () => {
    const env = { USERPROFILE: 'C:\\Users\\u' }
    const dirs = workBuddyAuthDirs('windows', 'C:\\Users\\u', 'C:\\Users\\u', env)
    // 用 path.join 拼出的分隔符随平台变（本机跑测试是 POSIX），断言按「层级」匹配
    const norm = dirs.map((d) => d.replace(/\\/g, '/')).join('|')
    expect(norm).toContain('AppData/Local/CodeBuddyExtension/Data/Public/auth')
    expect(norm).toContain('AppData/Roaming/CodeBuddyExtension/Data/Public/auth')
  })

  test('windows 尊重 LOCALAPPDATA/APPDATA 重定向（环境变量优先于 join 猜测）', () => {
    const env = { USERPROFILE: 'C:\\Users\\u', LOCALAPPDATA: 'D:\\Redir\\Local', APPDATA: 'D:\\Redir\\Roaming' }
    const paths = workBuddySearchPaths('windows', 'C:\\Users\\u', 'C:\\Users\\u', env)
    expect(paths.some((p) => p.startsWith('D:\\Redir\\Local'))).toBe(true)
    expect(paths.some((p) => p.startsWith('D:\\Redir\\Roaming'))).toBe(true)
  })

  test('CODEBUDDY_DESKTOP_AUTH_DIR 兜底目录被纳入候选', () => {
    const env = { CODEBUDDY_DESKTOP_AUTH_DIR: 'E:\\Portable\\auth' }
    const paths = workBuddySearchPaths('windows', 'C:\\Users\\u', 'C:\\Users\\u', env)
    expect(paths.some((p) => p.startsWith('E:\\Portable\\auth'))).toBe(true)
  })

  test('智能兜底：只给数据根也能按文件名递归定位登录态', async () => {
    const root = await tempDir()
    // 模拟版本号导致的中间目录改名（候选路径猜不到）
    const nested = join(root, 'CodeBuddyExtension', '2.63.2', 'Data', 'Public', 'auth')
    await mkdir(nested, { recursive: true })
    const path = await writeAuthFile(nested, 'workbuddy-desktop.info', craftJWT(new Date(Date.now() + 3600_000)))
    const found = searchWorkBuddyAuthFiles([root])
    expect(found).toContain(path)
    const { finding, ok } = checkWorkBuddyWithAccounts([], [], [root])
    expect(ok).toBe(true)
    expect(finding.status).toBe('ready')
    expect(finding.detail).toContain('智能兜底')
  })

  test('env 覆盖优先', () => {
    vi.stubEnv('CODEBUDDY_DESKTOP_AUTH_FILE', '/custom/a.info')
    try {
      expect(workBuddySearchPaths('linux', '/home/u', '')[0]).toBe('/custom/a.info')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

// ---- WorkBuddy 双版本（国内版 / 海外版） ----
//
// 2026-09-19 实测确认的真机事实：桌面端两个发行版的登录态文件、认证域、上游都不相同，
// token 互不通用。把海外版的 token 打到 copilot.tencent.com 会被 APISIX 拦成
// HTML 401「Authorization Required」——看起来像账号失效，实际只是域名不对。
// 因此版本必须被发现层显式识别，并一路带到 Provider 草稿。
describe('WorkBuddy 双版本识别', () => {
  // 组装带真实 iss 的 JWT：realm 判定的第二证据是 issuer（第一是 auth.domain）。
  function jwtWithIss(iss: string, exp: Date): string {
    const b64 = Buffer.from(JSON.stringify({
      exp: Math.floor(exp.getTime() / 1000), iss, sub: 'u1',
    })).toString('base64url')
    return `eyJhbGciOiJub25lIn0.${b64}.sig`
  }

  async function writeRealmFile(
    dir: string, name: string, realm: 'cn' | 'ai',
    account: Record<string, unknown>, exp = new Date(Date.now() + 86400_000),
  ): Promise<string> {
    const domain = realm === 'ai' ? 'www.workbuddy.ai' : 'www.workbuddy.cn'
    const raw = JSON.stringify({
      auth: {
        accessToken: jwtWithIss(`https://${domain}/auth/realms/copilot`, exp),
        tokenType: 'Bearer', domain,
      },
      account,
    })
    const path = join(dir, name)
    await writeFile(path, raw, 'utf8')
    return path
  }

  test('detectRealmFromAuth：认 auth.domain（最直接证据）', async () => {
    const raw = JSON.stringify({ auth: { accessToken: 'x', domain: 'www.workbuddy.ai' } })
    expect(detectRealmFromAuth(raw)).toBe('ai')
    expect(detectRealmFromAuth(JSON.stringify(
      { auth: { accessToken: 'x', domain: 'www.workbuddy.cn' } }))).toBe('cn')
  })

  test('detectRealmFromAuth：domain 缺失时回落到 JWT iss', async () => {
    const ai = JSON.stringify({ auth: { accessToken: jwtWithIss('https://www.workbuddy.ai/auth/realms/copilot', new Date()) } })
    expect(detectRealmFromAuth(ai)).toBe('ai')
    const cn = JSON.stringify({ auth: { accessToken: jwtWithIss('https://www.workbuddy.cn/auth/realms/copilot', new Date()) } })
    expect(detectRealmFromAuth(cn)).toBe('cn')
  })

  test('detectRealmFromAuth：认不出返回 undefined，绝不默认成国内版', () => {
    // 默认成 cn 正是当初把海外号打错域的原因——宁可报「版本未知」也不猜。
    expect(detectRealmFromAuth('{bad')).toBeUndefined()
    expect(detectRealmFromAuth(JSON.stringify(
      { auth: { accessToken: 'not-a-jwt', domain: 'example.com' } }))).toBeUndefined()
    expect(detectRealmFromAuth(JSON.stringify({ auth: { accessToken: jwtWithIss('https://other.example/auth', new Date()) } }))).toBeUndefined()
  })

  test('两个版本各生成一条 finding，key 与 Provider 草稿都不撞车', async () => {
    const dir = await tempDir()
    // 模拟真机：两个版本同目录共存（workbuddy-desktop.info + workbuddy-desktop-ai.info）
    await writeRealmFile(dir, 'workbuddy-desktop.info', 'cn',
      { uid: 'uid-cn', nickname: '肥糯米嫩', type: 'personal' })
    await writeRealmFile(dir, 'workbuddy-desktop-ai.info', 'ai',
      { uid: 'uid-ai', nickname: 'liz816339@gmail.com', type: 'personal' })

    const findings = await new Scanner({
      workBuddyPaths: [
        join(dir, 'workbuddy-desktop.info'),
        join(dir, 'workbuddy-desktop-ai.info'),
      ],
      workBuddyAuthDirs: [dir],
      zCodeDirs: [join(dir, 'nope')],
      zenBaseURL: 'http://127.0.0.1:9',
      zenTimeoutMs: 500,
    }).scan()
    const cn = findings.find((f) => f.key === 'workbuddy')
    const ai = findings.find((f) => f.key === 'workbuddy-ai')
    expect(cn?.status).toBe('ready')
    expect(ai?.status).toBe('ready')

    // 认证域由版本派生：这是本次修复的核心——海外版不能再打到腾讯国内域名。
    expect(cn?.suggestedProvider?.baseUrl).toBe('https://copilot.tencent.com/v2')
    expect(cn?.suggestedProvider?.headers?.['X-Domain']).toBe('copilot.tencent.com')
    expect(ai?.suggestedProvider?.baseUrl).toBe('https://www.workbuddy.ai/v2')
    expect(ai?.suggestedProvider?.headers?.['X-Domain']).toBe('www.workbuddy.ai')

    // Provider 名必须不同：账号池按 providerId 归属，同名会合并成一个池。
    expect(cn?.suggestedProvider?.name).toBe('workbuddy')
    expect(ai?.suggestedProvider?.name).toBe('workbuddy-ai')
    expect(providerValidate(ai!.suggestedProvider as Provider)).toBeUndefined()
  })

  test('账号列表按版本隔离：海外版 finding 不列出国内版账号', async () => {
    const dir = await tempDir()
    await writeRealmFile(dir, 'workbuddy-desktop.info', 'cn',
      { uid: 'uid-cn', nickname: '肥糯米嫩', type: 'personal' })
    await writeRealmFile(dir, 'workbuddy-desktop-ai.info', 'ai',
      { uid: 'uid-ai', nickname: 'liz816339@gmail.com', type: 'personal' })

    const findings = await new Scanner({
      workBuddyPaths: [
        join(dir, 'workbuddy-desktop.info'),
        join(dir, 'workbuddy-desktop-ai.info'),
      ],
      workBuddyAuthDirs: [dir],
      zCodeDirs: [join(dir, 'nope')],
      zenBaseURL: 'http://127.0.0.1:9',
      zenTimeoutMs: 500,
    }).scan()

    const cnAccts = findings.find((f) => f.key === 'workbuddy')?.suggestedAccounts ?? []
    const aiAccts = findings.find((f) => f.key === 'workbuddy-ai')?.suggestedAccounts ?? []
    // 混列会诱导用户把两套互不通用的 token 导进同一个 Provider。
    expect(cnAccts.map((a) => a.nickname)).toEqual(['肥糯米嫩'])
    expect(aiAccts.map((a) => a.nickname)).toEqual(['liz816339@gmail.com'])
    expect(cnAccts[0]?.realm).toBe('cn')
    expect(aiAccts[0]?.realm).toBe('ai')
  })

  test('扫描路径同时覆盖两个版本的文件名', () => {
    for (const goos of ['darwin', 'linux', 'windows']) {
      const paths = workBuddySearchPaths(goos, '/home/u', 'C:\\Users\\u')
      expect(paths.some((p) => p.endsWith('workbuddy-desktop.info'))).toBe(true)
      // 此前只生成国内版文件名，海外版永远命中不了候选。
      expect(paths.some((p) => p.endsWith('workbuddy-desktop-ai.info'))).toBe(true)
    }
  })

  test('同 UID 跨版本不去重（两版是两条独立凭据）', async () => {
    const dir = await tempDir()
    await writeRealmFile(dir, 'workbuddy-desktop.info', 'cn',
      { uid: 'same-uid', nickname: '同一人国内', type: 'personal' })
    await writeRealmFile(dir, 'workbuddy-desktop-ai.info', 'ai',
      { uid: 'same-uid', nickname: '同一人海外', type: 'personal' })
    const accts = discoverWorkBuddyAccounts(dir)
    expect(accts).toHaveLength(2)
    expect(new Set(accts.map((a) => a.realm))).toEqual(new Set(['cn', 'ai']))
  })

  test('版本未知的历史文件仍可发现（不因判不出版本而漏掉）', async () => {
    const dir = await tempDir()
    // 旧客户端：没写 domain，token 也不是 JWT → realm 判不出。
    await writeFile(join(dir, 'workbuddy-desktop.info'), JSON.stringify({
      auth: { accessToken: 'opaque-token' },
      account: { uid: 'uid-old', nickname: '老客户端' },
    }), 'utf8')
    const accts = discoverWorkBuddyAccounts(dir)
    expect(accts).toHaveLength(1)
    expect(accts[0]?.realm).toBeUndefined()
  })
})

describe('checkZCode', () => {
  test('未安装且无登录痕迹 → missing', () => {
    const f = checkZCode([join('/nonexistent', 'ZCode')], '/nonexistent-home')
    expect(f.key).toBe('zcode')
    expect(f.status).toBe('missing')
  })

  test('已安装（目录存在）无登录痕迹 → unknown + OAuth 指引', async () => {
    const dir = await tempDir()
    const f = checkZCode([dir], '/nonexistent-home')
    expect(f.status).toBe('unknown')
    expect(f.actions?.some((a) => a.includes('zcode login'))).toBe(true)
  })

  test('CLI 配置里有凭据 → ready + 脱敏指纹（不含密钥原文）', async () => {
    const home = await tempDir()
    const cliDir = join(home, '.zcode', 'cli')
    await mkdir(cliDir, { recursive: true })
    await writeFile(join(cliDir, 'config.json'), JSON.stringify({
      provider: { zai: { options: { apiKey: 'zcode-test-key-0123456789abcdef', baseURL: 'https://api.z.ai/api/anthropic' } } },
    }))
    const f = checkZCode([join('/nonexistent', 'ZCode')], home)
    expect(f.status).toBe('ready')
    expect(f.detail).toContain('CLI')
    // 脱敏红线：指纹是 sha256 前 12 位十六进制，绝不含 key 原文
    expect(f.detail).not.toContain('zcode-test-key')
    expect(f.detail).toMatch(/指纹 [0-9a-f]{12}/)
  })

  test('凭据原文绝不出现在 detail/actions（desktop 来源同样脱敏）', async () => {
    const home = await tempDir()
    const v2Dir = join(home, '.zcode', 'v2')
    await mkdir(v2Dir, { recursive: true })
    await writeFile(join(v2Dir, 'config.json'), JSON.stringify({
      provider: { 'builtin:zai-start-plan': { options: { apiKey: 'desktop-secret-key-0123456789' } } },
    }))
    const f = checkZCode([], home)
    expect(f.status).toBe('ready')
    expect(f.detail).toContain('桌面')
    expect(f.detail).not.toContain('desktop-secret-key')
  })

  // 回归：凭据必须按客户端的真实结构（provider.<名>.options.apiKey）取。
  // 曾经写成「任意层级叫 apiKey 就算」——配置文件里别处的 apiKey（遥测、
  // 第三方插件）会被误判成 ZCode 登录态，并把它们的 sha256 前 12 位显示在
  // 发现页：既误报「已登录」，又是没必要的指纹外泄。
  test('只在 provider.*.options.apiKey 上取凭据，别处的 apiKey 不算', async () => {
    const home = await tempDir()
    const cliDir = join(home, '.zcode', 'cli')
    await mkdir(cliDir, { recursive: true })
    await writeFile(join(cliDir, 'config.json'), JSON.stringify({
      telemetry: { apiKey: 'unrelated-telemetry-key-0123456789' },
      plugin: { nested: { deep: { apiKey: 'unrelated-plugin-key-0123456789' } } },
      provider: { zai: { options: { baseURL: 'https://api.z.ai/api/anthropic' } } }, // 无凭据
    }))
    const f = checkZCode([], home)
    // 没有任何 provider.*.options.apiKey → 不能判成已登录
    expect(f.status).toBe('missing')
    expect(f.detail ?? '').not.toContain('unrelated-telemetry-key')
  })
})

describe('checkZen', () => {
  const fetchOK = (async () => new Response(
    JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }),
    { status: 200 },
  )) as typeof fetch

  test('连通 → ready，返回模型数，建议 Provider 合法', async () => {
    const f = await checkZen('https://zen.example', fetchOK)
    expect(f.status).toBe('ready')
    expect(f.detail).toContain('3 个模型')
    expect(f.actions).toContain('export ZEN_KEY=public')
    const p = f.suggestedProvider as Provider
    expect(p.baseUrl).toBe('https://zen.example/v1')
    expect(providerValidate(p)).toBeUndefined()
  })

  test('请求 /v1/models 且带 Bearer public', async () => {
    const seen: { url?: string; auth?: string } = {}
    const spy = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.url = String(url)
      seen.auth = (init?.headers as Record<string, string> | undefined)?.Authorization
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as typeof fetch
    await checkZen('https://zen.example/', spy)
    expect(seen?.url).toBe('https://zen.example/v1/models')
    expect(seen?.auth).toBe('Bearer public')
  })

  test('非 200 → unreachable', async () => {
    const f = await checkZen('https://zen.example', (async () => new Response('no', { status: 503 })) as typeof fetch)
    expect(f.status).toBe('unreachable')
    expect(f.detail).toContain('503')
  })

  test('网络失败 → unreachable', async () => {
    const f = await checkZen('http://127.0.0.1:9', (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch)
    expect(f.status).toBe('unreachable')
  })

  test('响应非 JSON → unreachable', async () => {
    const f = await checkZen('https://zen.example', (async () => new Response('<html>')) as typeof fetch)
    expect(f.status).toBe('unreachable')
  })

  // 真实假阳性（2026-09-17 实测）：GET /v1/models 是免指纹端点，71 个模型全列出
  // 只证明网络通；缺 UA/会话指纹时真正的 chat/completions 回 403 FreeTierError。
  // 旧实现把「探得到模型」当 ready，用户到手才炸。现在必须真调一次才认 ready。
  test('列表通但真实调用 403 指纹错 → 不冒充 ready，如实说明未找到指纹', async () => {
    const f = await checkZen('https://zen.example', fetchOK, 8000, async () => ({
      ok: false, kind: 'fingerprint',
      error: "upstream fingerprint (http 403): OpenCode's free tier can only be used from within OpenCode",
    }))
    expect(f.status).toBe('unreachable')
    expect(f.detail).toContain('未找到可用的客户端指纹')
    // 出路按门槛从低到高：先「装并运行一次 opencode」，抓包排在后面。
    expect(f.actions?.[0]).toContain('运行一次 opencode')
    expect(f.actions?.some((a) => a.includes('x-opencode-session'))).toBe(true)
  })

  test('列表通且真实调用成功 → ready，并标出实测模型', async () => {
    const fetchFree = (async () => new Response(
      JSON.stringify({ data: [{ id: 'mimo-v2.5-free' }, { id: 'paid-x' }] }), { status: 200 },
    )) as typeof fetch
    let called = ''
    const f = await checkZen('https://zen.example', fetchFree, 8000, async (model) => {
      called = model
      return { ok: true }
    })
    expect(f.status).toBe('ready')
    expect(called).toBe('mimo-v2.5-free') // 优先免费档模型
    expect(f.detail).toContain('实测')
  })

  // 根因回归（2026-09-20 用户实测）：探针发的是裸请求（只有一条 user 消息、无 tools），
  // 而 zen 免费档的身份闸门要求请求体像官方客户端的 agent 请求。抓包实测（同一真实
  // opencode 会话、同一秒、仅换请求体）：裸 body 恒 403 FreeTierError，
  // 加 tools:[bash,read] 立刻 200。于是探针恒报「指纹被拒/地区受限」→ 判 unreachable
  // → 发现页连导入按钮都不给，用户被一个假阴性锁死。
  // 这里把「探针请求必须带 tools 且必须流式」锁成契约。
  test('探针请求形状：必带 tools(bash+read) 且流式（免费档闸门要求）', () => {
    const req = zenProbeRequest('mimo-v2.5-free')
    expect(req.stream).toBe(true) // 非流式同样 403
    const names = (req.tools ?? []).map((t) => t.name)
    // 闸门要求字面量同时含 bash 与 read（大小写敏感，别的组合一律 403）
    expect(names).toContain('bash')
    expect(names).toContain('read')
    expect(req.messages.length).toBeGreaterThan(0)
  })

  // 上游已下线的模型留在草稿里，采用后就是永远 404 的目录项（用户看不出是模型没了
  // 还是自己配错）。草稿必须跟随上游列表剪掉这些，且**如实告知**（不静默改动目录）。
  test('草稿模型跟随上游刷新：剔除已下线项并如实告知', async () => {
    const fetchList = (async () => new Response(
      JSON.stringify({ data: [{ id: 'mimo-v2.5-free' }, { id: 'nemotron-3-ultra-free' }] }),
      { status: 200 },
    )) as typeof fetch
    const f = await checkZen('https://zen.example', fetchList) // 不测调用：只看草稿
    const names = (f.suggestedProvider?.models ?? []).map((m) => m.id)
    expect(names).toContain('mimo-v2.5-free')
    expect(names).toContain('nemotron-3-ultra-free')
    expect(names).not.toContain('union-alpha') // 上游已下线
    expect(f.detail).toContain('union-alpha') // 剔除要如实告知
  })

  // 剪枝的两条边界（宁可不剪也不误删）——直接锁纯函数，不绕道网络。
  test('剪枝保留 manual 手工项；列表拉空时整体不剪', () => {
    const models = [
      { id: 'gone-auto' },                    // 上游没了 + 自动 → 剪
      { id: 'gone-manual', manual: true },    // 上游没了 + 手工 → 留（用户自己维护的）
      { id: 'live', manual: false },          // 上游还在 → 留
    ]
    const r = pruneStaleDraftModels(models, ['live'])
    expect(r.kept.map((m) => m.id)).toEqual(['gone-manual', 'live'])
    expect(r.stale).toEqual(['gone-auto'])
    // live 为空（列表拉空/解析异常）：沉默比误删安全，一个都不剪
    const empty = pruneStaleDraftModels(models, [])
    expect(empty.kept).toHaveLength(3)
    expect(empty.stale).toEqual([])
  })

  // 真实误判（2026-09-20 用户实测报回）：按上游列表顺序取前 3 个免费模型做探针，
  // 恰好那 3 个都不可用（jev 500 / deepseek-v4-flash 已下线 / muse-spark 地区受限），
  // 于是整个源被判 unreachable，用户连导入按钮都点不到——而草稿里的 mimo-v2.5-free
  // 当时是可调用的。探针要回答的是「采用后我能不能用」，所以候选必须先取草稿模型。
  test('探针候选优先取草稿模型（不被列表顺序挤掉）', async () => {
    const fetchList = (async () => new Response(
      JSON.stringify({ data: [
        { id: 'jev-1.13-free' },
        { id: 'deepseek-v4-flash-free' },
        { id: 'muse-spark-1.3-contributor-free' },
        { id: 'mimo-v2.5-free' },
        { id: 'nemotron-3-ultra-free' },
      ] }), { status: 200 },
    )) as typeof fetch
    const tried: string[] = []
    const f = await checkZen('https://zen.example', fetchList, 8000, async (m) => {
      tried.push(m)
      // 只有草稿里的模型可用；列表前三个都不可用（含地区限制）
      return m === 'mimo-v2.5-free'
        ? { ok: true }
        : { ok: false, kind: 'region', error: 'not available in your country' }
    })
    // 草稿里的 mimo-v2.5-free 必须被探到，且整体判 ready
    expect(tried).toContain('mimo-v2.5-free')
    expect(f.status).toBe('ready')
    expect(f.detail).toContain('mimo-v2.5-free')
  })

  // 全失败时，detail 必须列出**每个候选各自**的失败类型，而不是只报一个最优病因。
  // 只报「地区受限」会把真相压成一个词：用户无法判断是源整体不可用，还是探针
  // 撞上了单个坏模型（本轮误判的根源）。
  test('全候选失败：detail 逐个列出候选与失败类型', async () => {
    const fetchList = (async () => new Response(
      JSON.stringify({ data: [{ id: 'a-free' }, { id: 'b-free' }] }), { status: 200 },
    )) as typeof fetch
    const f = await checkZen('https://zen.example', fetchList, 8000, async (m) =>
      m === 'a-free'
        ? { ok: false, error: 'upstream server (http 500): boom' }
        : { ok: false, kind: 'region', error: 'not available in your country' })
    expect(f.status).toBe('unreachable')
    expect(f.detail).toContain('a-free')
    expect(f.detail).toContain('b-free')
    expect(f.detail).toContain('地区受限')
    expect(f.detail).toContain('http 500')
  })

  // 探测没通过也必须留一条「仍可导入」的出路：导入是本地动作，不该被联网结论锁死。
  test('不可达时 action 里仍给出「采用」的出路', async () => {
    const fetchList = (async () => new Response(
      JSON.stringify({ data: [{ id: 'a-free' }] }), { status: 200 },
    )) as typeof fetch
    const f = await checkZen('https://zen.example', fetchList, 8000, async () => ({
      ok: false, kind: 'fingerprint', error: "free tier can only be used from within OpenCode",
    }))
    expect(f.status).toBe('unreachable')
    expect(f.actions?.some((a) => a.includes('采用'))).toBe(true)
  })

  // 单模型误判（2026-09-17 实测）：探针只试第一个模型就下结论，
  // 那个模型恰好不可用（下线/地区受限）时，整个 Provider 被误报成不可用——
  // 用户看到「这也不能用」，实际只是选错了探针模型。
  test('部分模型失败但仍有可用 → 判 ready（不因单模型下线误杀整源）', async () => {
    const fetchMulti = (async () => new Response(
      JSON.stringify({ data: [{ id: 'a-free' }, { id: 'b-free' }, { id: 'c-free' }] }), { status: 200 },
    )) as typeof fetch
    const tried: string[] = []
    const f = await checkZen('https://zen.example', fetchMulti, 8000, async (m) => {
      tried.push(m)
      return m === 'a-free' ? { ok: false, error: 'upstream server (http 500)' } : { ok: true }
    })
    expect(f.status).toBe('ready')
    // 并发探测：候选同时打（速度优先，上游响应头本身就慢），
    // 不再「首个成功就停」——所以断言覆盖集合，不断言截断位置。
    expect(tried).toContain('a-free')
    expect(tried.some((m) => m !== 'a-free')).toBe(true) // 确实试了别的，没被首个失败带停
    expect(f.detail).toMatch(/实测 (b-free|c-free) 可调用/)
  })

  // 同族扎堆：muse-spark 有 1.2/1.3 两代，若按原顺序取前 3 个，名额全被它占掉，
  // 一族不可用就误判整源不可用——其他族可能完全正常。候选必须跨族分散。
  test('候选跨族取样：同族不同代不重复占用探测名额', async () => {
    const fetchFam = (async () => new Response(
      JSON.stringify({ data: [
        { id: 'muse-spark-1.3-contributor-free' },
        { id: 'muse-spark-1.2-contributor-free' },
        { id: 'mimo-v2.5-free' },
        { id: 'nemotron-3-ultra-free' },
      ] }), { status: 200 },
    )) as typeof fetch
    const tried: string[] = []
    const f = await checkZen('https://zen.example', fetchFam, 8000, async (m) => {
      tried.push(m)
      // 模拟 muse-spark 族不可用（如地区限制），其他族正常
      return m.startsWith('muse-spark') ? { ok: false, kind: 'region', error: 'not available in your country' } : { ok: true }
    })
    expect(f.status).toBe('ready')
    // 跨族取样：同族的 1.2 不该占用名额（并发下断言集合，顺序不保证）
    expect(tried).toContain('muse-spark-1.3-contributor-free')
    expect(tried).not.toContain('muse-spark-1.2-contributor-free')
    expect(tried.some((m) => m.startsWith('mimo') || m.startsWith('nemotron'))).toBe(true)
  })

  test('全族都不可用（地区限制）→ unreachable 且指引配 egress', async () => {
    const fetchMulti = (async () => new Response(
      JSON.stringify({ data: [{ id: 'a-free' }, { id: 'b-free' }] }), { status: 200 },
    )) as typeof fetch
    const f = await checkZen('https://zen.example', fetchMulti, 8000, async () => ({
      ok: false, kind: 'region', error: 'not available in your country',
    }))
    expect(f.status).toBe('unreachable')
    expect(f.detail).toContain('地区')
    expect(f.actions?.some((a) => a.includes('egress'))).toBe(true)
  })

  test('列表通但调用非指纹类失败 → unreachable 且保留原因', async () => {
    const f = await checkZen('https://zen.example', fetchOK, 8000, async () => ({
      ok: false, error: 'upstream server (http 500): boom',
    }))
    expect(f.status).toBe('unreachable')
    expect(f.detail).toContain('http 500')
  })
})

// ---- OpenCode 指纹自动识别 ----
//
// 免费档要真实 UA + 真实 ses_。这些不用让用户手抄：opencode 自己会把「自建会话 +
// 版本号」写进本地日志（message=created id=ses_xxx ... version=1.18.29），直接读。
// 只认「客户端自建 + 确实对 zen 发过 stream」两个证据同时成立的会话，宁缺勿滥。
describe('opencode 指纹自动识别', () => {
  const LOG = [
    'timestamp=2026-09-17T02:49:54.272Z level=INFO run=af99f207 message=created id=ses_AAAA1111bbbb version=1.18.29 slug=x version=1.18.29',
    'timestamp=2026-09-17T02:50:02.560Z level=INFO run=af99f207 message=stream providerID=opencode modelID=mimo-v2.5-free session.id=ses_AAAA1111bbbb step=0',
    'timestamp=2026-09-17T05:48:46.376Z level=INFO run=bb11 message=created id=ses_CCCC2222dddd version=1.18.31 slug=y version=1.18.31',
    'timestamp=2026-09-17T05:49:00.000Z level=INFO run=bb11 message=stream providerID=opencode modelID=union-alpha session.id=ses_CCCC2222dddd step=0',
  ].join('\n')

  test('从日志提取会话 + 版本，取最近一次会话', () => {
    const got = parseFingerprintFromLog(LOG)!
    expect(got.sessionID).toBe('ses_CCCC2222dddd')
    expect(got.version).toBe('1.18.31')
    expect(got.modelID).toBe('union-alpha') // 该会话实测用过的模型
  })

  // 真实缺陷（用户实测报回）：早先的正则假设 id 在 version 之前，字段序一变就
  // 整条识别不出来 → 用户装了 opencode 却被告知「缺少客户端指纹」。
  // 日志字段顺序是 opencode 内部实现细节，不该成为我们的假设。
  // 线上报回的真实日志形态（logfmt、字段很多、含 Windows 绝对路径与转义 JSON、
  // 旧版客户端版本号）。标识符已换成构造值，但**字段结构与顺序与实测一致**——
  // 这正是回归重点：格式再变也不能解析不出来。
  test('解析真实日志形态（logfmt 全字段 + Windows 路径 + 旧版本号）', () => {
    const real = 'timestamp=2026-09-04T12:30:01.251Z level=INFO run=02c48c4e message=created '
      + 'id=ses_00000000AAAAbbbb1111 slug=lucky-planet version=1.18.27 '
      + 'projectID=0000000000000000000000000000000000000000 directory="D:\\\\work\\\\demo" path="" '
      + 'workspaceID=undefined parentID=undefined title="New session - 2026-09-04T12:30:01.251Z" '
      + 'agent=undefined model=undefined metadata=undefined cost=0 tokens.input=0 tokens.output=0 '
      + 'time.created=1788525001251 time.updated=1788525001251'
    const got = parseFingerprintFromLog(real)!
    expect(got.sessionID).toBe('ses_00000000AAAAbbbb1111')
    expect(got.version).toBe('1.18.27')
  })

  test('不依赖字段顺序（version 在前也能识别）', () => {
    const got = parseFingerprintFromLog('message=created version=1.20.0 id=ses_AAAAbbbb1111 slug=x')
    expect(got?.sessionID).toBe('ses_AAAAbbbb1111')
    expect(got?.version).toBe('1.20.0')
  })

  test('容忍 v 前缀版本号与 CRLF 换行', () => {
    expect(parseFingerprintFromLog('message=created id=ses_AAAAbbbb1111 version=v1.18.29')?.version).toBe('1.18.29')
    expect(parseFingerprintFromLog('message=created id=ses_AAAAbbbb1111 x version=1.18.29\r\n')?.version).toBe('1.18.29')
  })

  test('无自建会话 → null（不硬凑）', () => {
    expect(parseFingerprintFromLog('nothing here')).toBeNull()
    // 只有 stream 没有 created：会话不是这个客户端建的，不能当指纹
    expect(parseFingerprintFromLog('message=stream providerID=opencode modelID=x session.id=ses_ZZZ')).toBeNull()
  })

  test('版本号非法（抓到无关数字串）→ null', () => {
    expect(parseFingerprintFromLog('message=created id=ses_AAAA1111bbbb x version=nope')).toBeNull()
  })

  test('自动识别的指纹写进草稿 headers（用户无需手抄）', async () => {
    const fp = { sessionID: 'ses_TEST', version: '9.9.9', userAgent: 'opencode/9.9.9', logPath: '/x' }
    const f = await checkZen('https://zen.example', (async () => new Response(
      JSON.stringify({ data: [{ id: 'm-free' }] }), { status: 200 })) as typeof fetch,
      8000, async () => ({ ok: true }), fp)
    const h = (f.suggestedProvider as Provider).headers!
    expect(h['User-Agent']).toBe('opencode/9.9.9')
    expect(h['x-session-id']).toBe('ses_TEST')
    expect(h['x-session-affinity']).toBe('ses_TEST')
    expect(f.detail).toContain('自动识别')
  })

  // 用户报回的真实体验：没识别到指纹时，文案直接让人去「抓包」——门槛最高的一条路，
  // 绝大多数用户不会做。应先给最省事的（装并运行一次 opencode），抓包作为最后选项。
  test('未识别到指纹时的指引分级：先给最省事的，抓包排最后', async () => {
    const fetchFree = (async () => new Response(
      JSON.stringify({ data: [{ id: 'm-free' }] }), { status: 200 },
    )) as typeof fetch
    const f = await checkZen('https://zen.example', fetchFree, 8000,
      async () => ({ ok: false, kind: 'fingerprint', error: 'FreeTierError' }), null)
    expect(f.status).toBe('unreachable')
    expect(f.actions?.[0]).toContain('运行一次 opencode') // 最省事的在前
    expect(f.actions?.some((a) => a.includes('OPENCODE_DATA_DIR'))).toBe(true)
    expect(f.actions?.some((a) => a.includes('抓包'))).toBe(true) // 抓包仍提供但不在首位
  })

  test('识别到但已失效时，提示重新运行客户端而非抓包', async () => {
    const fp = { sessionID: 'ses_X', version: '1.0.0', userAgent: 'opencode/1.0.0', logPath: '/x' }
    const fetchFree = (async () => new Response(
      JSON.stringify({ data: [{ id: 'm-free' }] }), { status: 200 },
    )) as typeof fetch
    const f = await checkZen('https://zen.example', fetchFree, 8000,
      async () => ({ ok: false, kind: 'fingerprint', error: 'FreeTierError' }), fp)
    expect(f.detail).toContain('已失效')
    expect(f.actions?.[0]).toContain('重扫')
    expect(JSON.stringify(f.actions)).not.toContain('抓包')
  })

  test('识别不到指纹时不伪造任何头', async () => {
    const f = await checkZen('https://zen.example', (async () => new Response(
      JSON.stringify({ data: [{ id: 'm-free' }] }), { status: 200 })) as typeof fetch,
      8000, async () => ({ ok: true }), null)
    const h = (f.suggestedProvider as Provider).headers ?? {}
    expect(Object.keys(h)).toHaveLength(0)
  })

  test('opencode 数据目录按平台给候选（含 XDG 覆盖）', () => {
    // join 的分隔符随宿主平台变（本机跑测试是 win32），断言按「层级」匹配。
    const norm = (ds: string[]) => ds.map((d) => d.replace(/\\/g, '/'))
    expect(norm(openCodeDataDirs('linux', '/home/u', '', {}))).toContain('/home/u/.local/share/opencode')
    expect(norm(openCodeDataDirs('linux', '/home/u', '', { XDG_DATA_HOME: '/xdg' }))).toContain('/xdg/opencode')
    const win = norm(openCodeDataDirs('windows', 'C:\\Users\\u', 'C:\\Users\\u', {}))
    expect(win.some((d) => d.includes('AppData/Local/opencode'))).toBe(true)
  })

  // 真实缺陷（Windows 用户实测报回）：opencode 按 XDG 规范实现，**不随平台变**——
  // Windows 上真实路径是 C:\\Users\\<u>\\.local\\share\\opencode\\log\\opencode.log，
  // 而 %LOCALAPPDATA%\\opencode 并不存在。早先只在非 Windows 分支查 XDG，
  // 导致 Windows 用户装了 opencode 也识别不到指纹。
  test('Windows 也查 XDG 位置（.local/share）——实测真实路径就在这里', () => {
    const profile = 'C:\\Users\\someuser'
    const dirs = openCodeDataDirs('windows', profile, profile, {})
      .map((d) => d.replace(/\\/g, '/'))
    expect(dirs.some((d) => d.endsWith('someuser/.local/share/opencode'))).toBe(true)
  })
})

describe('discoverWorkBuddyAccounts', () => {
  test('多登录态共存：同账号取有效期最新的快照，不同账号各自成条目', async () => {
    const dir = await tempDir()
    const future = new Date(Date.now() + 30 * 86400_000)
    const fresher = new Date(Date.now() + 60 * 86400_000)
    const past = new Date(Date.now() - 86400_000)
    await writeAuthFile(dir, 'workbuddy-desktop.info', craftJWT(future),
      { uid: 'uid-main', nickname: '主号', type: 'personal' })
    // 同账号两份快照：旧的一份过期、新的一份有效——去重后应取新的（alive=true）
    await writeAuthFile(dir, 'workbuddy-desktop.2026-09-06T05-17-58.40468.def.info', craftJWT(past),
      { uid: 'uid-side', nickname: '副号', type: 'personal' })
    await writeAuthFile(dir, 'workbuddy-desktop.2026-09-07T14-03-40.64274.abc.info', craftJWT(fresher),
      { uid: 'uid-side', nickname: '副号', type: 'personal' })

    const accts = discoverWorkBuddyAccounts(dir)
    expect(accts).toHaveLength(2)
    const main = accts.find((a) => a.nickname === '主号')
    const side = accts.find((a) => a.nickname === '副号')
    expect(main?.alive).toBe(true)
    expect(side?.alive).toBe(true) // 副号应取更新的快照
    expect(side?.tokenPath).toContain('09-07')
    expect(side?.uid?.length).toBeLessThanOrEqual(9) // 短 UID 脱敏
  })

  test('空目录 → 空', async () => {
    expect(discoverWorkBuddyAccounts(await tempDir())).toHaveLength(0)
  })

  test('非登录态文件（坏 JSON / 无 accessToken）跳过', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'workbuddy-desktop.info'), '{bad', 'utf8')
    await writeFile(join(dir, 'other.txt'), 'x', 'utf8')
    expect(discoverWorkBuddyAccounts(dir)).toHaveLength(0)
  })
})

describe('discoverWorkBuddyModels', () => {
  test('从客户端 traces 里发现实际用过的模型（去重升序）', async () => {
    const dir = await tempDir()
    const tdir = join(dir, 'traces', '6211')
    await mkdir(tdir, { recursive: true })
    await writeFile(join(tdir, 'trace_a.json'),
      '{"workerPid":6211,"modelInfo":{"models":["hy4-preview","glm-5.3-flash"]},"spans":[]}', 'utf8')
    await writeFile(join(tdir, 'trace_b.json'),
      '{"modelInfo":{"models":["hy4-preview","deepseek-v4-pro"]}}', 'utf8')
    expect(discoverWorkBuddyModels(dir))
      .toEqual(['deepseek-v4-pro', 'glm-5.3-flash', 'hy4-preview'])
  })

  test('空目录 → 空', async () => {
    expect(discoverWorkBuddyModels(await tempDir())).toHaveLength(0)
  })

  test('空 dir 入参 → 空', () => {
    expect(discoverWorkBuddyModels('')).toHaveLength(0)
  })
})

describe('Scanner 聚合', () => {
  test('三探针聚合：workbuddy ready + zcode missing + zen 状态透出（不可达不卡死）', async () => {
    const dir = await tempDir()
    const wb = await writeAuthFile(dir, 'workbuddy-desktop.info', craftJWT(new Date(Date.now() + 3600_000)))
    const cfg: ScanConfig = {
      workBuddyPaths: [wb],
      zCodeDirs: [join(dir, 'nope')],
      zCodeHome: join(dir, 'no-home'), // 无登录痕迹 → zcode missing
      zenBaseURL: 'http://127.0.0.1:9', // 不可达 → unreachable
      zenTimeoutMs: 500,
    }
    const byKey = new Map((await new Scanner(cfg).scan()).map((f) => [f.key, f]))
    expect(byKey.get('workbuddy')?.status).toBe('ready')
    expect(byKey.get('zcode')?.status).toBe('missing')
    expect(byKey.get('opencode-zen')?.status).toBe('unreachable')
  })

  test('无任何痕迹：workbuddy missing（带指引），其余照常', async () => {
    const dir = await tempDir()
    const cfg: ScanConfig = {
      workBuddyPaths: [join(dir, 'nope.info')],
      zCodeDirs: [join(dir, 'nope')],
      zenBaseURL: 'http://127.0.0.1:9',
      zenTimeoutMs: 500,
    }
    const byKey = new Map((await new Scanner(cfg).scan()).map((f) => [f.key, f]))
    const wb = byKey.get('workbuddy') as NonNullable<ReturnType<typeof byKey.get>>
    expect(wb.status).toBe('missing')
    // 国内版/海外版分开报，文案各自点名版本（用户才知道该登录哪个客户端）。
    expect(wb.detail).toContain('未发现国内版桌面登录态')
    expect(wb.actions).toContain('登录 WorkBuddy 国内版桌面端后重扫')
    const wbAi = byKey.get('workbuddy-ai') as NonNullable<ReturnType<typeof byKey.get>>
    expect(wbAi.status).toBe('missing')
    expect(wbAi.detail).toContain('未发现海外版桌面登录态')
  })

  test('zen 探针走注入的 fetch，成功即 ready', async () => {
    const dir = await tempDir()
    const cfg: ScanConfig = {
      workBuddyPaths: [join(dir, 'nope.info')],
      zCodeDirs: [join(dir, 'nope')],
      zenBaseURL: 'https://zen.example',
      fetchImpl: (async () => new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 })) as typeof fetch,
    }
    const byKey = new Map((await new Scanner(cfg).scan()).map((f) => [f.key, f]))
    expect(byKey.get('opencode-zen')?.status).toBe('ready')
  })

  test('多账号共存：扫描时一并列出 suggestedAccounts', async () => {
    const dir = await tempDir()
    await writeAuthFile(dir, 'workbuddy-desktop.info', craftJWT(new Date(Date.now() + 3600_000)),
      { uid: 'uid-main', nickname: '主号', type: 'personal' })
    await writeAuthFile(dir, 'workbuddy-desktop.2026-09-07T14-03-40.64274.abc.info',
      craftJWT(new Date(Date.now() + 3600_000)),
      { uid: 'uid-side', nickname: '副号', type: 'personal' })
    const byKey = new Map((await new Scanner({
      workBuddyPaths: [join(dir, 'workbuddy-desktop.info')],
      zCodeDirs: [join(dir, 'nope')],
      zenBaseURL: 'http://127.0.0.1:9',
      zenTimeoutMs: 500,
    }).scan()).map((f) => [f.key, f]))
    const accts = byKey.get('workbuddy')?.suggestedAccounts
    expect(accts).toHaveLength(2)
    expect(byKey.get('workbuddy')?.detail).toContain('共存登录态')
  })
})

// 扫描缓存（2026-09-17 用户反馈「扫描好慢」）：
// zen 的联网验证上游固有 2~8 秒（响应头就慢），若每次页面刷新都实时打，
// 用户每次进发现页都要干等。缓存 + stale-while-revalidate 让首屏秒出。
describe('Scanner 缓存（扫描提速）', () => {
  const cfg = (): ScanConfig => ({
    workBuddyPaths: ['/nonexistent/x.info'],
    zCodeDirs: ['/nonexistent'],
    zenBaseURL: 'https://zen.example',
    fetchImpl: (async () => new Response(JSON.stringify({ data: [{ id: 'm-free' }] }), { status: 200 })) as typeof fetch,
    zenCallProbe: async () => ({ ok: true }),
  })

  test('二次扫描命中缓存：不再重复打上游', async () => {
    let calls = 0
    const c = cfg()
    c.fetchImpl = (async () => { calls++; return new Response(JSON.stringify({ data: [{ id: 'm-free' }] }), { status: 200 }) }) as typeof fetch
    const sc = new Scanner(c)
    await sc.scan()
    const first = calls
    await sc.scan()
    await sc.scan()
    expect(calls).toBe(first) // 后两次全命中缓存
  })

  test('force=true 绕过缓存（用户点「重新扫描」要实时结果）', async () => {
    let calls = 0
    const c = cfg()
    c.fetchImpl = (async () => { calls++; return new Response(JSON.stringify({ data: [{ id: 'm-free' }] }), { status: 200 }) }) as typeof fetch
    const sc = new Scanner(c)
    await sc.scan()
    const first = calls
    await sc.scan(true)
    expect(calls).toBeGreaterThan(first) // 真的又打了一次
  })

  test('并发调用共享同一次执行（不重复打上游）', async () => {
    let calls = 0
    const c = cfg()
    c.fetchImpl = (async () => {
      calls++
      await new Promise((r) => setTimeout(r, 30))
      return new Response(JSON.stringify({ data: [{ id: 'm-free' }] }), { status: 200 })
    }) as typeof fetch
    const sc = new Scanner(c)
    await Promise.all([sc.scan(), sc.scan(), sc.scan()])
    expect(calls).toBe(1) // 三次并发只打一轮
  })

  test('缓存副本隔离：改返回值不污染缓存', async () => {
    const sc = new Scanner(cfg())
    const a = await sc.scan()
    a[0]!.status = 'unreachable' // 改副本
    const b = await sc.scan()
    expect(b[0]!.status).not.toBe('unreachable') // 缓存未被污染
  })
})

describe('defaultConfig', () => {
  test('三组候选路径全部非空', () => {
    const cfg = defaultConfigForTest()
    expect(cfg.workBuddyPaths!.length).toBeGreaterThan(0)
    expect(cfg.workBuddyAuthDirs!.length).toBeGreaterThan(0)
    expect(cfg.zCodeDirs!.length).toBeGreaterThan(0)
    expect(cfg.zenBaseURL).toBe('https://opencode.ai/zen')
  })
})

// defaultConfig 依赖真实 home（仅生成路径表，不做 IO），此处只验证非空。
function defaultConfigForTest(): ScanConfig {
  return defaultConfig()
}
