// discover 行为锚点（复刻 Go internal/discover/*_test.go，fixture 全在临时目录）。

import { describe, expect, test, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkWorkBuddy, checkWorkBuddyWithAccounts, checkZCode, checkZen, discoverWorkBuddyAccounts,
  discoverWorkBuddyModels, workBuddyAuthDirs, workBuddySearchPaths, searchWorkBuddyAuthFiles,
  detectRealmFromAuth,
  parseFingerprintFromLog, openCodeDataDirs,
  Scanner, defaultConfig, type ScanConfig, zenProbeRequest, pruneStaleDraftModels, evenlySample,
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

// 新版 WorkBuddy 客户端（2026-09-28 用户机实测）把 auth.accessToken、account.nickname
// 换成了加密信封对象 {"$wbEncrypted":1,"envelope":"…"}，旧版仍是裸字符串。
// 修复前的真实故障：parseAuthFile 用「字段存在」判有效（对象是 truthy），
// 扫描器拿对象去 token.split() → TypeError 穿透到 /admin/api/discover → 整页 500。
describe('加密信封登录态（新版客户端格式）', () => {
  const envelope = { $wbEncrypted: 1, envelope: 'eyJzdWl0ZSI6MSwia2V5SWQiOiI5' }

  async function writeEnvelopeFile(
    dir: string, name: string, expiresAt?: number,
  ): Promise<string> {
    const auth: Record<string, unknown> = {
      accessToken: envelope, refreshToken: envelope, tokenType: 'Bearer',
      domain: 'www.workbuddy.cn', sessionState: '0bb1b756-aa1d',
    }
    if (expiresAt !== undefined) auth.expiresAt = expiresAt
    const path = join(dir, name)
    await writeFile(path, JSON.stringify({
      auth,
      account: {
        uid: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', // 形状仿真实客户端（UUID v4），非真实账号
        nickname: envelope, // 昵称同样是信封
        type: 'personal',
      },
    }), 'utf8')
    return path
  }

  // 回归本体：不会抛，且如实报成「本机发现了、但有效期读不出」而不是崩。
  test('checkWorkBuddy 遇信封 token → unknown，不抛 TypeError', async () => {
    const dir = await tempDir()
    const path = await writeEnvelopeFile(dir, 'workbuddy-desktop.info')
    const r = checkWorkBuddy([path])
    expect(r.ok).toBe(true) // 文件确实是登录痕迹
    expect(r.finding.status).toBe('unknown')
    expect(r.finding.detail).toContain('加密信封')
  })

  test('nickname 是信封对象时回落到默认，不炸（optional chaining 挡不住对象）', async () => {
    const dir = await tempDir()
    const path = await writeEnvelopeFile(dir, 'workbuddy-desktop.info')
    const { finding: f } = checkWorkBuddy([path])
    expect(f.detail).toContain('未知用户')
  })

  // 客户端把绝对过期时刻写在了 auth.expiresAt（epoch 毫秒）。信envelop 没有明文可解，
  // 这是唯一还能拿到的有效性事实——用上它，就不必把一个还剩 30 天的号报成「待确认」。
  test('信封 token + 未来的 expiresAt → ready', async () => {
    const dir = await tempDir()
    const path = await writeEnvelopeFile(
      dir, 'workbuddy-desktop.info', Date.now() + 30 * 86400_000)
    const { finding: f } = checkWorkBuddy([path])
    expect(f.status).toBe('ready')
    expect(f.detail).toContain('剩余约')
  })

  test('信封 token + 已过去的 expiresAt → expired', async () => {
    const dir = await tempDir()
    const path = await writeEnvelopeFile(
      dir, 'workbuddy-desktop.info', Date.now() - 86400_000)
    const { finding: f } = checkWorkBuddy([path])
    expect(f.status).toBe('expired')
    expect(f.detail).toContain('已过期')
  })

  // 秒级时间戳（10 位）也要认：客户端换单位时不该产出 1970 年的假「已过期」。
  test('expiresAt 为秒级时间戳时按秒换算', async () => {
    const dir = await tempDir()
    const path = await writeEnvelopeFile(
      dir, 'workbuddy-desktop.info', Math.floor((Date.now() + 86400_000) / 1000))
    const { finding: f } = checkWorkBuddy([path])
    expect(f.status).toBe('ready')
  })

  // 形状不认识的非字符串不能被当成登录态：宁可少报一条，也不拿一个读不出凭据的
  // 坏文件去编一个「已发现」出来。（注意对象里的 $wbEncrypted 标记例外——
  // 那是新版客户端的合法加密信封格式，见上面同 describe 的用例。）
  test('accessToken 是数字/数组/空对象 → 不算登录态（ok=false）', async () => {
    const dir = await tempDir()
    for (const bad of [123, [], {}, { envelope: 'x' }, null, '']) {
      const path = join(dir, `workbuddy-desktop.${Math.random()}.info`)
      await writeFile(path, JSON.stringify({ auth: { accessToken: bad }, account: { uid: 'u' } }), 'utf8')
      expect(checkWorkBuddy([path]).ok).toBe(false)
    }
  })

  test('导 token 的指引不再指向 python 一行（那条会打印出信封对象）', async () => {
    const dir = await tempDir()
    const path = await writeEnvelopeFile(dir, 'workbuddy-desktop.info')
    const { finding: f } = checkWorkBuddy([path])
    const acts = (f.actions ?? []).join(' | ')
    expect(acts).not.toContain("['auth']['accessToken']")
    expect(acts).toContain('config/credentials/')
  })

  test('旧版明文 token 仍正常给 python 导出行', async () => {
    const dir = await tempDir()
    const path = await writeAuthFile(dir, 'workbuddy-desktop.info', craftJWT(new Date(Date.now() + 86400_000)))
    const { finding: f } = checkWorkBuddy([path])
    expect((f.actions ?? []).join(' | ')).toContain("['auth']['accessToken']")
  })

  test('discoverWorkBuddyAccounts 遇信封：条目不炸，alive 取自 expiresAt', async () => {
    const dir = await tempDir()
    await writeEnvelopeFile(dir, 'workbuddy-desktop.info', Date.now() + 86400_000)
    const accts = discoverWorkBuddyAccounts(dir)
    expect(accts).toHaveLength(1)
    expect(accts[0]!.alive).toBe(true)
    expect(accts[0]!.nickname).toBe('未知用户')
    expect(accts[0]!.realm).toBe('cn') // 仍能按 domain 认出版本
  })
})

// 同一 uid 多份快照时，选哪一份决定一键导入能不能真把号入池。
// 只按 mtime 取最新会把「还活着、实测可用」的旧明文挡掉：
// 实测（2026-09-29）最新份分别是信封/已过期，旧明文打上游全 ok:true。
describe('多快照去重：档位优先于时间', () => {
  const UID = 'same-uid-0001'

  // 两份快照放同一目录（去重按目录扫）。
  //
  // mtime 必须**显式指定**，不能靠写入顺序碰运气：`writeFile` 是两次顺序 await，
  // 偶尔会跨毫秒，于是「后写的那份 mtime 更新」——而本组用例里被后写的恰好是
  // 带时间戳的旧快照，用例就翻了（实测约 1/5 概率，是仓库里长期存在的 flake）。
  // 被测函数的第一判据是档位、第二判据才是 mtime，两个判据都要能独立验证，
  // 所以时间轴由测试自己固定。
  //
  // files 的第一项 = 最新那份（语义与用例注释里的「最新/较旧」一致）；
  // 时间基准取固定时刻，不依赖现在几点。
  const BASE = new Date('2026-10-13T10:00:00.000Z')
  async function dirWith(files: Array<[string, Record<string, unknown>]>): Promise<string> {
    const dir = await tempDir()
    // 首项最新，随后的每项各早 1 分钟（明确区分，不靠同毫秒平手）。
    for (let i = 0; i < files.length; i++) {
      const [name, raw] = files[i]!
      const p = join(dir, name)
      await writeFile(p, JSON.stringify(raw), 'utf8')
      const t = new Date(BASE.getTime() - i * 60_000)
      utimesSync(p, t, t)
    }
    return dir
  }
  const plain = (expDays: number): string => craftJWT(new Date(Date.now() + expDays * 86400_000))
  const envelopeFile = (expiresAt?: number): Record<string, unknown> => ({
    auth: {
      accessToken: { $wbEncrypted: 1, envelope: 'Zm9v' }, tokenType: 'Bearer',
      domain: 'www.workbuddy.cn', ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
    account: { uid: UID, nickname: { $wbEncrypted: 1, envelope: 'Zm9v' }, type: 'personal' },
  })
  const plainFile = (expDays: number): Record<string, unknown> => ({
    auth: { accessToken: plain(expDays), tokenType: 'Bearer', domain: 'www.workbuddy.cn' },
    account: { uid: UID, nickname: '旧明文', type: 'personal' },
  })

  test('新份是信封、旧份是活明文 → 选旧明文（这才是能入池的那份）', async () => {
    // 档位不同：旧明文是档 3、新信封是档 2 → 旧明文胜，与 mtime 相反。
    const dir = await dirWith([
      ['workbuddy-desktop.info', envelopeFile(Date.now() + 29 * 86400_000)], // 最新：信封，alive
      ['workbuddy-desktop.2026-09-16T01-06-33-028Z.9.x.info', plainFile(17)],   // 较旧：明文，alive
    ])
    const accts = discoverWorkBuddyAccounts(dir)
    expect(accts).toHaveLength(1)
    expect(accts[0]!.tokenPath).toContain('2026-09-16')
    expect(accts[0]!.alive).toBe(true)
  })

  test('新份已过期、旧份是活明文 → 选活的旧份（不被死的最新版压掉）', async () => {
    // 档位不同：旧份 3，新份 1（已过期但有明文）→ 旧份胜。
    const dir = await dirWith([
      ['workbuddy-desktop.info', plainFile(-11)],  // 最新：明文但已过期
      ['workbuddy-desktop.2026-09-13T13-53-30-073Z.9.y.info', plainFile(44)], // 较旧：明文且活
    ])
    const accts = discoverWorkBuddyAccounts(dir)
    expect(accts).toHaveLength(1)
    expect(accts[0]!.alive).toBe(true)
    expect(accts[0]!.tokenPath).toContain('2026-09-13')
  })

  test('两份都活且都是明文 → 仍取最新（原有行为不变）', async () => {
    // 同档（都是 3）平手 → 回到 mtime 规则：dirWith 里首项 mtime 最新。
    const dir = await dirWith([
      ['workbuddy-desktop.info', plainFile(30)],
      ['workbuddy-desktop.2026-09-16T01-06-33-028Z.9.z.info', plainFile(17)],
    ])
    const accts = discoverWorkBuddyAccounts(dir)
    expect(accts).toHaveLength(1)
    expect(accts[0]!.tokenPath).toContain('workbuddy-desktop.info') // 最新那份
  })

  test('同档平手时按 mtime 取新（时间轴由测试给定的方向不会被写入顺序影响）', async () => {
    // 这条专门盯 mtime 判据：两份都是档 3（明文且活），结论只能来自 mtime。
    // 若谁把 dirWith 的 mtime 固定改回「不设」，本用例会与上一条一起红，
    // 直接指出是「时间判据没被测到」而不是去猜 flake。
    const dir = await dirWith([
      ['workbuddy-desktop.info', plainFile(30)],                          // BASE      → 最新
      ['workbuddy-desktop.2026-09-16T01-06-33-028Z.9.z.info', plainFile(17)], // BASE - 1min
    ])
    expect(discoverWorkBuddyAccounts(dir)[0]!.tokenPath).toContain('workbuddy-desktop.info')
    // 反向：把两者调换位置，胜者应变成带时间戳的那份（证明不是「永远选某个文件名」）。
    const dir2 = await dirWith([
      ['workbuddy-desktop.2026-09-16T01-06-33-028Z.9.z.info', plainFile(17)], // BASE      → 最新
      ['workbuddy-desktop.info', plainFile(30)],                          // BASE - 1min
    ])
    expect(discoverWorkBuddyAccounts(dir2)[0]!.tokenPath).toContain('2026-09-16')
  })

  test('同档平手仍按 mtime/exp 取最新（原有平手规则保留）', async () => {
    const dir = await dirWith([
      ['workbuddy-desktop.a.info', envelopeFile()],       // 信封，无 expiresAt → 死档? expiresAt 缺失
      ['workbuddy-desktop.b.info', envelopeFile(Date.now() + 5 * 86400_000)],
    ])
    const accts = discoverWorkBuddyAccounts(dir)
    expect(accts).toHaveLength(1)
    // 两份都是信封；a 无 expiresAt（alive=false，档 0），b 有（alive=true，档 2）→ b 胜
    expect(accts[0]!.tokenPath).toContain('workbuddy-desktop.b.info')
    expect(accts[0]!.alive).toBe(true)
  })

  test('不同 uid 不互相吞（去重键含 uid）', async () => {
    const dir = await dirWith([
      ['workbuddy-desktop.info', envelopeFile()],
      ['workbuddy-desktop.other.info', {
        auth: { accessToken: plain(30), tokenType: 'Bearer', domain: 'www.workbuddy.cn' },
        account: { uid: 'other-uid-9', nickname: '二号', type: 'personal' },
      }],
    ])
    expect(discoverWorkBuddyAccounts(dir)).toHaveLength(2)
  })
})

// 一条坏数据不能打掉整页扫描：扫描是尽力而为的观察，任何一环抛错都只应让**该项**
// 降级。（真实故障同上：WorkBuddy 升级 → 整页 /discover 恒 500，连没问题的
// ZCode / zen 也一起陪葬。）
describe('Scanner 容错（单点异常不打掉整页扫描）', () => {
  test('zen 探针抛错 → 其余发现项照常返回，zen 单独报不可达', async () => {
    const dir = await tempDir()
    const sc = new Scanner({
      workBuddyPaths: [], workBuddyAuthDirs: [], workBuddyFallbackRoots: [],
      zCodeDirs: [join(dir, 'no-such-zcode')],
      zCodeHome: dir,
      openCodeDirs: [],
      zenBaseURL: 'https://zen.invalid',
      fetchImpl: (async () => { throw new Error('代理拒绝连接') }) as typeof fetch,
    })
    const out = await sc.scan(true)
    // 扫描本身必须是 200 语义：拿到了结构化结果，而不是抛出去变 500。
    expect(out.length).toBeGreaterThan(1)
    expect(out.some((f) => f.key === 'opencode-zen' && f.status === 'unreachable')).toBe(true)
    expect(out.some((f) => f.key === 'zcode')).toBe(true) // 没被 zen 的故障牵连
  })

  test('本机扫描整体抛错 → 返回带错误原文的 finding，不把异常抛给 HTTP 层', async () => {
    // 打断「读本机路径」这一步：默认配置注入一个会在构造期抛错的 getter。
    const bad: ScanConfig = {
      workBuddyPaths: [],
      workBuddyAuthDirs: [],
      get workBuddyFallbackRoots(): string[] { throw new Error('磁盘炸了') },
      zCodeDirs: [], zCodeHome: tmpdir(), openCodeDirs: [],
      fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
    }
    const out = await new Scanner(bad).scan(true)
    expect(out).toHaveLength(1)
    expect(out[0]!.key).toBe('scan-error')
    expect(out[0]!.status).toBe('unreachable')
    expect(out[0]!.detail).toContain('磁盘炸了')
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

  // ---- 回归：采用草稿必须与登录态判定解耦产出 ----
  //
  // 历史缺陷：checkZCode 从不设 suggestedProvider，而 notAdoptableReason 的拦条件是
  // `!found.suggestedProvider` —— 于是 Discover 页的「一键导入」对 ZCode 恒 400
  // 「无法生成 Provider 配置」，按钮却按 status==='ready' 点亮。更远的影响：sidecar
  // 管理面全程只认 'zcode-plan-local' 这个 Provider 名，它不存在时「改端口」静默
  // 跳过同步、「自定义引擎地址」404、GET /sidecar 的 endpoint 退化成空串。
  //
  // 这三条断言分别锚住：草稿恒存在、状态判据不受影响、草稿形状合法且指向真实端口。
  describe('suggestedProvider 采用草稿', () => {
    test('任何状态下都产出草稿（缺失草稿 = 一键导入必失败）', () => {
      // 不用 as const：readonly tuple 赋不进 checkZCode 的 string[] 形参（TS2345）。
      const cases: { dirs: string[]; home: string }[] = [
        { dirs: [join('/nonexistent', 'ZCode')], home: '/nonexistent-home' }, // 未安装
        { dirs: [], home: '/nonexistent-home' },                              // 无安装目录候选
      ]
      for (const c of cases) {
        const f = checkZCode(c.dirs, c.home)
        expect(f.suggestedProvider, `dirs=${JSON.stringify(c.dirs)}`).toBeDefined()
      }
    })

    test('草稿形状合法：providerValidate 通过且 riskNote 齐（risk=high 必填项）', () => {
      const f = checkZCode([], '/nonexistent-home')
      const p = f.suggestedProvider!
      expect(p.providerId).toBe(0) // 0 = 新建，由存储层分配
      expect(p.name).toBe('zcode-plan-local') // sidecar_app.ts 按此名查找，不可改名
      expect(p.state).toBe('active')
      expect(p.api).toBe('anthropic-messages')
      expect(p.stability).toBe('beta')
      expect(p.accessKind).toBe('reverse')
      expect(p.priority).toBe(1)
      // providerValidate 会在 risk=high 且缺 riskNote 时拒绝，那只是把 400 换个说法
      expect(providerValidate(p)).toBeUndefined()
      // 凭据必须引用 setup 阶段落下的 key 文件：sidecar 开了鉴权，不带 key 打 /v1/models 就是 401
      expect(p.credential.apiKeyFile).toBe('config/credentials/zcode-proxy-key')
      // 目录不预填猜的模型名（同 wbSuggestedProvider 教训），交由 fillModelsIfEmpty 拉真实的
      expect(p.models).toEqual([])
    })

    test('草稿未泄漏登录凭据原文', async () => {
      const home = await tempDir()
      const cliDir = join(home, '.zcode', 'cli')
      await mkdir(cliDir, { recursive: true })
      await writeFile(join(cliDir, 'config.json'), JSON.stringify({
        provider: { zai: { options: { apiKey: 'zcode-secret-key-0123456789abcdef' } } },
      }))
      const f = checkZCode([join('/nonexistent', 'ZCode')], home)
      expect(f.status).toBe('ready')
      expect(JSON.stringify(f.suggestedProvider)).not.toContain('zcode-secret-key')
    })

    test('baseUrl 指向传入的 sidecar 端口，缺省回落 8080', () => {
      expect(checkZCode([], '/nh', '9090').suggestedProvider!.baseUrl).toBe('http://127.0.0.1:9090')
      expect(checkZCode([], '/nh', '8080').suggestedProvider!.baseUrl).toBe('http://127.0.0.1:8080')
      // 未注入端口（引擎未装 / config.yaml 读不到）= 引擎默认端口
      expect(checkZCode([], '/nh', '').suggestedProvider!.baseUrl).toBe('http://127.0.0.1:8080')
      // 非法值不能拼出 http://127.0.0.1:abc 这种打不通的地址
      expect(checkZCode([], '/nh', 'abc').suggestedProvider!.baseUrl).toBe('http://127.0.0.1:8080')
      // baseUrl 停在操作路径之前（不含 /v1）：由网关按 anthropic-messages 拼 /v1/messages
      expect(checkZCode([], '/nh', '9090').suggestedProvider!.baseUrl).not.toContain('/v1')
    })
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

  // 草稿**不能写死模型名**。写死的名字上游一下线就是永远 404 的假值，而它又只在
  // “拿不到上游列表”时生效——断网/被墙的用户恰好被导入一批必死的模型，却看不出
  // 是「模型没了」还是「自己配错了」。权威来源只能是上游实时列表。
  test('草稿不预填任何模型：目录一律交给上游实时列表', async () => {
    const fetchList = (async () => new Response(
      // 故意返回两个“看似应该预填”的 ID：它们不应因为出现在上游列表里就被写进草稿。
      // 草稿是“采用时会落库的目录”，预填等于替用户做了一个未经验证的决定。
      JSON.stringify({ data: [{ id: 'mimo-v2.6-flash-free' }, { id: 'space-bunny-free' }] }),
      { status: 200 },
    )) as typeof fetch
    const f = await checkZen('https://zen.example', fetchList)
    expect(f.suggestedProvider?.models).toEqual([])
    // 上游列表本身仍要拿到（探测靠它），只是不写进草稿。
    expect(f.detail).toContain('2 个模型')
  })

  // 剪枝行为改为直接锁纯函数：草稿不再预填后，这段逻辑的唯一入口就是
  // reconcileCatalogModels（发现层剪草稿、管理面同步目录共用同一份）。
  // 上游已下线的模型留在目录里就是永远 404 的目录项，必须剪掉且如实告知；
  // 但不能误伤——两条边界见下。
  test('已下线项被剔除并如实告知；manual 与空列表两条边界不误删', () => {
    const models = [
      { id: 'longcat-2.5-preview-free' },  // 上游已下线 + 自动 → 剪
      { id: 'mimo-v2.6-flash-free' },      // 上游还在 → 留
      { id: 'my-hand-model', manual: true }, // 上游没有 + 手工 → 留（用户自己维护的）
      { id: 'space-bunny-free' },          // 上游还在 → 留
    ]
    const r = pruneStaleDraftModels(models, ['mimo-v2.6-flash-free', 'space-bunny-free'])
    expect(r.kept.map((m) => m.id)).toEqual(['mimo-v2.6-flash-free', 'my-hand-model', 'space-bunny-free'])
    expect(r.stale).toEqual(['longcat-2.5-preview-free'])
    // live 为空（列表拉空/解析异常）：沉默比误删安全，一个都不剪
    const empty = pruneStaleDraftModels(models, [])
    expect(empty.kept).toHaveLength(4)
    expect(empty.stale).toEqual([])
  })

  // 剪枝要如实告知（不静默改动用户看到的目录）：detail 里要点名被剔除的 ID。
  test('剪掉的模型在 detail 里点名', async () => {
    const fetchList = (async () => new Response(
      JSON.stringify({ data: [{ id: 'mimo-v2.6-flash-free' }, { id: 'space-bunny-free' }] }),
      { status: 200 },
    )) as typeof fetch
    const f = await checkZen('https://zen.example', fetchList)
    // 草稿已空 → 没有可剪的，detail 不应出现“剔除”字样（没改动就不该声称改了）
    expect(f.detail).not.toContain('剔除')
  })

  // 探针只能抽样（预算 3 个），所以采样方式直接决定「整源不可用」这个结论对不对。
  // 真实误判（2026-09-20 用户报回）：沿列表取前 3 个，恰好三个都不可用
  // （jev 500 / deepseek-v4-flash 已下线 / muse-spark 地区受限 连续排在前），
  // 于是整个源被判 unreachable，而可用的模型就在列表后面。
  //
  // 草稿不再预填模型后，候选只能来自上游列表，这条防线变成关键：采样必须
  // **跨族 + 覆盖整张列表（含末尾）**，而不是沿开头截一段。
  test('探针候选覆盖列表末尾：可用模型在后段也能判 ready', async () => {
    const fetchList = (async () => new Response(
      JSON.stringify({ data: [
        { id: 'jev-1.13-free' },
        { id: 'deepseek-v4-flash-free' },
        { id: 'muse-spark-1.3-contributor-free' },
        { id: 'nemotron-3.5-lightning-free' },
        { id: 'mimo-v2.6-flash-free' }, // ← 唯一的可用项，排在末尾
      ] }), { status: 200 },
    )) as typeof fetch
    const tried: string[] = []
    const f = await checkZen('https://zen.example', fetchList, 8000, async (m) => {
      tried.push(m)
      return m === 'mimo-v2.6-flash-free'
        ? { ok: true }
        : { ok: false, kind: 'region', error: 'not available in your country' }
    })
    // 末尾的可用模型必须被抽到（前 3 个全灭不能定案）
    expect(tried).toContain('mimo-v2.6-flash-free')
    expect(f.status).toBe('ready')
    expect(f.detail).toContain('mimo-v2.6-flash-free')
  })

  // 均匀取样的纯函数契约：首尾必含、个数准确、不重复、不打乱原有优先级。
  // 首尾必含是上一条能成立的前提（列表末尾不能因为「名额不够」而永远探不到）。
  test('evenlySample：首尾必含且在区间内均匀分布', () => {
    const xs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    expect(evenlySample(xs, 3)).toEqual(['a', 'e', 'h'])
    expect(evenlySample(xs, 1)).toEqual(['a'])
    expect(evenlySample(xs, 8)).toEqual(xs)
    expect(evenlySample(xs, 99)).toEqual(xs) // 名额多于样本：全试，不重复
    expect(evenlySample([], 3)).toEqual([])
    expect(evenlySample(xs, 0)).toEqual([])
    // 顺序保持原列表顺序（取样只是子集，不重排优先级）
    const s = evenlySample(xs, 4)
    expect(s).toEqual([...s].sort((a, b) => xs.indexOf(a) - xs.indexOf(b)))
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
    // 孪生头必写（UA ≥ 1.19.0 时上游必查它，且须与 session 同值）
    expect(h['x-opencode-session']).toBe('ses_TEST')
    expect(h['x-opencode-session-id']).toBe('ses_TEST')
    // 毒头绝不能写进草稿（带则恒 403，见 applyZenFingerprint）
    expect(h['x-session-affinity']).toBeUndefined()
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

  test('识别不到指纹时现铸合规指纹（不再留空——留空已被实测证为必 403）', async () => {
    // 本用例原先断言 `Object.keys(h)).toHaveLength(0)`，即「不伪造任何头」。
    // 2026-10-15 实测推翻了那个取舍（逐变量单改，Bearer public）：
    //   不发 User-Agent        → 403 FreeTierError
    //   opencode/1.17.99 及以下 → 426 UpgradeRequired（要求 1.18.0+）
    //   无 x-opencode-session   → 403
    // 即「如实不发」在新版上游下等同于必失败。而上游只校验**形状**与一个数值
    // 下界（实测：低 12 位 = 0xfbf → 403，= 0xfc0 → 200），不验真伪——
    // 所以没装过 opencode 的用户也能直接可用，不必再被要求“先跑一次客户端”。
    // 本用例锁的是新契约：吐出的每个值都必须是**形状合规**的，而不是随便编。
    const f = await checkZen('https://zen.example', (async () => new Response(
      JSON.stringify({ data: [{ id: 'm-free' }] }), { status: 200 })) as typeof fetch,
      8000, async () => ({ ok: true }), null)
    const h = (f.suggestedProvider as Provider).headers ?? {}
    // UA 有硬性最低版本：不能缺，且必须是已知可用的版本
    expect(h['User-Agent']).toMatch(/^opencode\/\d+\.\d+\.\d+/)
    // 会话：形状（ses_ + 12 位小写 hex + 14 位 base62）与低 12 位下界
    const sid = h['x-opencode-session']!
    expect(sid).toMatch(/^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/)
    expect(parseInt(sid.slice(4, 16), 16) & 0xfff).toBeGreaterThanOrEqual(0xfc0)
    // 孪生头必须与会话同值（UA≥1.19.0 时上游必查，不一致即 403）
    expect(h['x-opencode-session-id']).toBe(sid)
    expect(h['x-session-id']).toBe(sid)
    // request 头形状：msg_ + 12 位小写 hex + 14 位 base62
    expect(h['x-opencode-request']).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    // 毒头绝不能出现（带则恒 403，实测 3/3）
    for (const k of Object.keys(h)) expect(k.toLowerCase()).not.toContain('affinity')
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
    expect(cfg.zenBaseURL).toBe('https://opencode.ai/inference')
  })
})

// defaultConfig 依赖真实 home（仅生成路径表，不做 IO），此处只验证非空。
function defaultConfigForTest(): ScanConfig {
  return defaultConfig()
}
