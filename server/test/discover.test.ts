// discover 行为锚点（复刻 Go internal/discover/*_test.go，fixture 全在临时目录）。

import { describe, expect, test, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkWorkBuddy, checkZCode, checkZen, discoverWorkBuddyAccounts,
  discoverWorkBuddyModels, workBuddyAuthDirs, workBuddySearchPaths,
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
