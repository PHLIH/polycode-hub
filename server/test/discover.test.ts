// discover 行为锚点（复刻 Go internal/discover/*_test.go，fixture 全在临时目录）。

import { describe, expect, test, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkWorkBuddy, checkWorkBuddyWithAccounts, checkZCode, checkZen, discoverWorkBuddyAccounts,
  discoverWorkBuddyModels, workBuddyAuthDirs, workBuddySearchPaths, searchWorkBuddyAuthFiles,
  parseFingerprintFromLog, openCodeDataDirs,
  Scanner, defaultConfig, type ScanConfig,
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
    expect(dirs).toContain('/home/u/Library/Application Support/CodeBuddyExtension/Data/Public/auth')
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

describe('checkZCode', () => {
  test('未安装 → missing', () => {
    const f = checkZCode([join('/nonexistent', 'ZCode')])
    expect(f.key).toBe('zcode')
    expect(f.status).toBe('missing')
  })

  test('已安装（目录存在）→ unknown + OAuth 指引', async () => {
    const dir = await tempDir()
    const f = checkZCode([dir])
    expect(f.status).toBe('unknown')
    expect(f.actions?.some((a) => a.includes('zcode login'))).toBe(true)
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
    expect(f.actions?.some((a) => a.includes('x-session-id'))).toBe(true)
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

  // 单模型误判（2026-09-17 实测）：探针只试第一个模型就下结论，
  // 那个模型恰好不可用（下线/地区受限）时，整个 Provider 被误报成不可用——
  // 用户看到「这也不能用」，实际只是选错了探针模型。
  test('首个模型失败但后续可用 → 仍判 ready（不因单模型下线误杀整源）', async () => {
    const fetchMulti = (async () => new Response(
      JSON.stringify({ data: [{ id: 'a-free' }, { id: 'b-free' }, { id: 'c-free' }] }), { status: 200 },
    )) as typeof fetch
    const tried: string[] = []
    const f = await checkZen('https://zen.example', fetchMulti, 8000, async (m) => {
      tried.push(m)
      return m === 'a-free' ? { ok: false, error: 'upstream server (http 500)' } : { ok: true }
    })
    expect(f.status).toBe('ready')
    expect(tried).toEqual(['a-free', 'b-free'])
    expect(f.detail).toContain('b-free')
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
    expect(tried).toEqual(['muse-spark-1.3-contributor-free', 'mimo-v2.5-free'])
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
  // 用户提供的真实日志行（logfmt、含大量字段、CRLF、Windows 路径、1.18.27）。
  // 逐字作为回归锚点：格式再变也不能解析不出来。
  test('解析用户真实日志行（logfmt 全字段形态）', () => {
    const real = 'timestamp=2026-09-04T12:30:01.251Z level=INFO run=02c48c4e message=created '
      + 'id=ses_f939a45dAAAAbbbb1111 slug=lucky-planet version=1.18.27 '
      + 'projectID=59cdb1c95758cb8416e9e8fd295f5d4a936f9612 directory="F:\\\\stock-strategy-lab" path="" '
      + 'workspaceID=undefined parentID=undefined title="New session - 2026-09-04T12:30:01.251Z" '
      + 'agent=undefined model=undefined metadata=undefined cost=0 tokens.input=0 tokens.output=0 '
      + 'time.created=1788525001251 time.updated=1788525001251'
    const got = parseFingerprintFromLog(real)!
    expect(got.sessionID).toBe('ses_f939a45dAAAAbbbb1111')
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
    expect(openCodeDataDirs('linux', '/home/u', '', {})).toContain('/home/u/.local/share/opencode')
    expect(openCodeDataDirs('linux', '/home/u', '', { XDG_DATA_HOME: '/xdg' })).toContain('/xdg/opencode')
    const win = openCodeDataDirs('windows', 'C:\\Users\\u', 'C:\\Users\\u', {})
      .map((d) => d.replace(/\\/g, '/'))
    expect(win.some((d) => d.includes('AppData/Local/opencode'))).toBe(true)
  })

  // 真实缺陷（Windows 用户实测报回）：opencode 按 XDG 规范实现，**不随平台变**——
  // Windows 上真实路径是 C:\\Users\\<u>\\.local\\share\\opencode\\log\\opencode.log，
  // 而 %LOCALAPPDATA%\\opencode 并不存在。早先只在非 Windows 分支查 XDG，
  // 导致 Windows 用户装了 opencode 也识别不到指纹。
  test('Windows 也查 XDG 位置（.local/share）——实测真实路径就在这里', () => {
    const dirs = openCodeDataDirs('windows', 'C:\\Users\\19169', 'C:\\Users\\19169', {})
      .map((d) => d.replace(/\\/g, '/'))
    expect(dirs.some((d) => d.endsWith('19169/.local/share/opencode'))).toBe(true)
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
    expect(side?.uid.length).toBeLessThanOrEqual(9) // 短 UID 脱敏
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
    expect(wb.detail).toContain('未发现桌面登录态')
    expect(wb.actions).toContain('登录 WorkBuddy 桌面端后重扫')
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
