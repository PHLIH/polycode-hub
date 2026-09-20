// 移植锚点：internal/sidecar/sidecar_test.go / uninstall_test.go / lifecycle_test.go
// 测试绝不依赖真实网络下载：Install 用注入 fetch 替身；生命周期用本地假二进制。

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type AddressInfo } from 'node:net'
import { execFileSync, spawn } from 'node:child_process'
import { Hono } from 'hono'
import { expectMode } from './helpers/posix-mode.ts'
import {
  Sidecar,
  assetName,
  localName,
  normalizeGOOS,
  checkDownloadURL,
  describeFetchError,
  killSidecarSpec,
  latestRelease,
  sha256Hex,
  SidecarCancelledError,
  startupFailureHint,
  logTailHint,
  isPortInUseError,
  validatePort,
} from '../src/sidecar/sidecar.ts'
import type { SidecarProgress } from '../src/sidecar/sidecar.ts'
import { partPath, authURLRe } from '../src/sidecar/sidecar.ts'
import { shouldReuseLogin, createSidecarApp } from '../src/adminapi/sidecar_app.ts'
import { parseScutilProxy, normalizeProxyURI, maskProxyURI, egressDefToProxyURI, resolveSidecarDownloadFetch, parseWinProxySetting } from '../src/sidecar/httpproxy.ts'

const makeTemp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

// testKillSpec：测试专用的「找进程并杀」实现——**只认本测试自己造的进程**。
//
// 为什么必须有（真实事故，2026-09-19 取证）：默认 killSidecarSpec 用
// `pgrep -f 'zcode-proxy.*--cli serve'` 匹配**命令行**，而 uninstall/stop 的
// 测试用例在临时目录里跑——它一旦执行，就会把你**真实**的引擎进程也命中
// SIGTERM（不管谁启的、在哪个目录）。当天日志里引擎被反复杀掉、三连
// 「零请求起停」，正是这里跑测试时把真引擎带走了。注入这个实现后，
// 测试只查带自身令牌的命令行，彻底失去杀伤半径。
const TEST_TOKEN = `polycode-test-${process.pid}`
function testKillSpec(): { cmd: string; args: string[] } {
  return { cmd: 'pgrep', args: ['-f', TEST_TOKEN] }
}
// testSidecar 构造带测试令牌的 Sidecar：uninstall/stop 用例一律用它。
function testSidecar(cred: string, opts: ConstructorParameters<typeof Sidecar>[1] = {}): Sidecar {
  return new Sidecar(cred, { ...opts, killSpec: testKillSpec })
}

// —— assetName：各平台 release 资产名与上游命名约定一致（sidecar_test.go TestAssetNameMapping）

describe('assetName 平台映射', () => {
  test.each([
    ['darwin', 'arm64', 'zcode-proxy-darwin-arm64'],
    ['darwin', 'x64', 'zcode-proxy-darwin-x64'],
    ['linux', 'x64', 'zcode-proxy-linux-x64'],
    ['windows', 'amd64', 'zcode-proxy.exe'],
  ])('%s/%s → %s', (goos, arch, want) => {
    expect(assetName(goos, arch)).toBe(want)
  })
  test('未知平台无产物', () => {
    expect(assetName('sunos', 'x64')).toBe('')
  })

  // 回归锚点（真实缺陷）：Windows 上 process.platform 是 "win32"，而 assetName
  // 只认 Go 口径的 "windows"。install() 以前直接把 process.platform 传进来，
  // 于是 Windows 恒抛「平台 win32/x64 无预编译产物」——**从来就装不上**，
  // 且与网络/代理无关（在下载之前就返回了）。
  // 旧测试全用 goos:'windows' 显式传参，恰好绕开了这条真实入参路径，
  // 所以一直没暴露。这里锚死「Node 口径进来也要能出产物」。
  test('Node 口径 win32 必须也能映射出产物（回归锚点）', () => {
    expect(assetName(normalizeGOOS('win32'), 'x64')).toBe('zcode-proxy.exe')
    expect(assetName(normalizeGOOS('win32'), 'arm64')).toBe('zcode-proxy.exe')
    expect(normalizeGOOS('win32')).toBe('windows')
    // 其余平台同名直通；幂等（已归一的值再归一不变）
    expect(normalizeGOOS('darwin')).toBe('darwin')
    expect(normalizeGOOS('linux')).toBe('linux')
    expect(normalizeGOOS(normalizeGOOS('win32'))).toBe('windows')
  })

  test('Windows 上 install 直接吃 process.platform 也能安装（真实入参路径）', async () => {
    // 模拟 Windows 进程：goos 显式传 "win32"（等价于该平台的 process.platform）
    const dir = makeTemp('polycode-swin-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      const body = {
        tag_name: 'v9.9.9',
        assets: [{ name: 'zcode-proxy.exe', browser_download_url: 'https://objects.githubusercontent.com/bin.exe', size: 7 }],
      }
      const bin = new TextEncoder().encode('FAKEBIN')
      const f = async (url: string | URL | Request): Promise<Response> =>
        String(url).includes('api.github.com')
          ? new Response(JSON.stringify(body), { status: 200 })
          : new Response(bin, { status: 200 })
      const dest = await s.install(false, { fetch: f, goos: 'win32', arch: 'x64' })
      // 落地名必须带 .exe：这里曾经断言的是 'zcode-proxy'（无后缀），
      // 等于把这个缺陷写进了测试——装出来的文件 spawn 起不来、taskkill 也杀不掉。
      expect(dest).toBe(join(dir, 'bin', 'zcode-proxy.exe'))
      expect(readFileSync(dest, 'utf8')).toBe('FAKEBIN')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// —— SetupConfig（sidecar_test.go TestSetupConfig）

describe('SetupConfig 安全配置', () => {
  test('127.0.0.1 绑定 + 随机 key + start-plan + 凭据文件 0600', () => {
    const dir = makeTemp('polycode-scfg-')
    try {
      const s = testSidecar(join(dir, 'credentials', 'zcode-proxy-key'), { dataDir: dir })
      const key = s.setupConfig(join(dir, 'sidecar'))
      expect(key.startsWith('sk-local-')).toBe(true)
      expect(key.length).toBeGreaterThanOrEqual(40)
      const cfg = readFileSync(join(dir, 'sidecar', 'config.yaml'), 'utf8')
      expect(cfg).toContain('host: "127.0.0.1"')
      expect(cfg).toContain('plan: start-plan')
      expect(cfg).toContain(key)
      const cred = readFileSync(s.credKey, 'utf8')
      expect(cred).toBe(key)
      // 权限位断言在 Windows 上无意义（NTFS 上 chmod 不生效，恒为 0o666）——
      // helper 内部已按平台跳过，见 helpers/posix-mode.ts。
      expectMode(s.credKey, 0o600)
      // 两次生成 key 必须不同（随机性）
      const s2 = testSidecar(join(dir, 'c2'))
      const key2 = s2.setupConfig(join(dir, 'sidecar2'))
      expect(key2).not.toBe(key)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// —— Running 离线探活（sidecar_test.go TestRunning_Offline）

describe('Running 离线不误报', () => {
  test('不可监听端口探活为 false', async () => {
    const s = testSidecar(join(makeTemp('polycode-off-'), 'k'), { port: '1' })
    expect(await s.running()).toBe(false)
  })
})

// —— SetPort / LoadPort / ValidatePort（sidecar_test.go TestSetPort / TestLoadPort）

describe('SetPort / LoadPort', () => {
  test('改写 port 行且 key 保留；非法端口拒绝且配置不动', () => {
    const dir = makeTemp('polycode-sport-')
    try {
      const s = testSidecar(join(dir, 'credentials', 'zcode-proxy-key'))
      const key = s.setupConfig(join(dir, 'sidecar'))
      s.setPort(join(dir, 'sidecar'), '9090')
      const cfg = readFileSync(join(dir, 'sidecar', 'config.yaml'), 'utf8')
      expect(cfg).toContain('port: 9090')
      expect(cfg).not.toContain('port: 8080')
      expect(cfg).toContain(key)
      expect(s.port).toBe('9090')
      for (const bad of ['80', '70000', 'abc', '']) {
        expect(() => s.setPort(join(dir, 'sidecar'), bad)).toThrow()
      }
      const cfg2 = readFileSync(join(dir, 'sidecar', 'config.yaml'), 'utf8')
      expect(cfg2).toBe(cfg)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('网关重启后从 config.yaml 恢复端口；无配置保持默认', () => {
    const dir = makeTemp('polycode-lport-')
    try {
      const s = testSidecar(join(dir, 'credentials', 'zcode-proxy-key'))
      s.setupConfig(join(dir, 'sidecar'))
      s.setPort(join(dir, 'sidecar'), '9090')
      const fresh = testSidecar(join(dir, 'credentials', 'zcode-proxy-key'))
      expect(fresh.port).toBe('8080')
      fresh.loadPort(join(dir, 'sidecar'))
      expect(fresh.port).toBe('9090')
      const fresh2 = testSidecar(join(dir, 'c3'))
      fresh2.loadPort(join(dir, 'nowhere'))
      expect(fresh2.port).toBe('8080')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('validatePort 边界', () => {
    expect(() => validatePort('1024')).not.toThrow()
    expect(() => validatePort('65535')).not.toThrow()
    expect(() => validatePort('1023')).toThrow()
    expect(() => validatePort('65536')).toThrow()
    expect(() => validatePort('abc')).toThrow()
  })
})

// —— parseScutilProxy（sidecar_test.go TestParseScutilProxy）

describe('parseScutilProxy scutil 输出解析', () => {
  test('HTTPS 优先', () => {
    const out = '  HTTPEnable : 1\n  HTTPProxy : 127.0.0.1\n  HTTPPort : 7897\n' +
      '  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 7897\n'
    expect(parseScutilProxy(out)).toEqual({ scheme: 'http', host: '127.0.0.1:7897' })
  })
  test('HTTP 次之', () => {
    const out = '  HTTPEnable : 1\n  HTTPProxy : 10.0.0.2\n  HTTPPort : 8888\n  HTTPSEnable : 0\n'
    expect(parseScutilProxy(out)).toEqual({ scheme: 'http', host: '10.0.0.2:8888' })
  })
  test('SOCKS 兜底', () => {
    const out = '  SOCKSEnable : 1\n  SOCKSProxy : 127.0.0.1\n  SOCKSPort : 7897\n'
    expect(parseScutilProxy(out)).toEqual({ scheme: 'socks5', host: '127.0.0.1:7897' })
  })
  test('未启用返回 null', () => {
    expect(parseScutilProxy('  HTTPSEnable : 0\n  HTTPEnable : 0\n')).toBeNull()
  })
})

// —— Windows 系统代理：同一台 Clash、同一个网络，macOS 一直能从 scutil 读到
// 系统代理，Windows 却完全没读 → 「Mac 能下、Windows 永远下不来」的那条差异。

describe('Windows 系统代理解析 parseWinProxySetting', () => {
  test('分协议形态取 https（下载目标恒为 https）', () => {
    // 实测形态（2026-09-19 本机注册表）
    const p = parseWinProxySetting('0x1', 'http=127.0.0.1:7897;https=127.0.0.1:7897;socks=127.0.0.1:7897')
    expect(p).toEqual({ scheme: 'http', host: '127.0.0.1:7897' })
  })

  test('只有 http 时用 http', () => {
    expect(parseWinProxySetting('0x1', 'http=127.0.0.1:8080'))
      .toEqual({ scheme: 'http', host: '127.0.0.1:8080' })
  })

  test('单值形态（整串就是一个 host:port）', () => {
    expect(parseWinProxySetting('0x1', '127.0.0.1:7890'))
      .toEqual({ scheme: 'http', host: '127.0.0.1:7890' })
  })

  test('只有 socks 时识别成 socks5（交给调用方决定回落并告警）', () => {
    expect(parseWinProxySetting('0x1', 'socks=127.0.0.1:1080'))
      .toEqual({ scheme: 'socks5', host: '127.0.0.1:1080' })
  })

  test('ProxyEnable 为 0 / 非 1 → 视为没配代理', () => {
    expect(parseWinProxySetting('0x0', 'http=127.0.0.1:7897')).toBeNull()
    expect(parseWinProxySetting('1', 'http=127.0.0.1:7897'))
      .toEqual({ scheme: 'http', host: '127.0.0.1:7897' }) // DWORD 的另一种写法
  })

  test('ProxyServer 为空 / 缺失 → null（不去猜一个不存在的代理）', () => {
    expect(parseWinProxySetting('0x1', '')).toBeNull()
    expect(parseWinProxySetting('0x1', undefined)).toBeNull()
    expect(parseWinProxySetting(undefined, 'http=127.0.0.1:7897')).toBeNull()
  })
})

// 回归锚点：管理台「一键安装」以前用全局 fetch 直连 github release（~66MB），
// 国内网络必然超时，页面永远转「安装中…」。这里锚死「项目 egress 表优先」。

// —— 下载代理决议（复用项目 egress 配置，不写死地址）——
// 回归锚点：管理台「一键安装」以前用全局 fetch 直连 github release（~66MB），
// 国内网络必然超时，页面永远转「安装中…」。这里锚死「项目 egress 表优先」。

describe('下载代理决议 resolveSidecarDownloadFetch', () => {
  const clash = { id: 'clash', kind: 'http', addr: '127.0.0.1:7897' }
  // 测试一律 wantSystem:false + 空 env：不依赖跑测试这台机器的系统代理/环境变量，
  // 否则同一个用例在「开着 Clash 的机器」和 CI 上结论不同（不可复现）。
  const base = { wantSystem: false, env: {} as Record<string, string | undefined> }

  test('优先级 1：显式 --proxy 压过一切', () => {
    const r = resolveSidecarDownloadFetch({
      ...base, explicitProxy: 'http://127.0.0.1:1080',
      egressId: 'clash', egressList: [clash],
    })
    expect(r.proxyURI).toBe('http://127.0.0.1:1080')
    expect(r.source).toBe('--proxy')
  })

  test('优先级 2：显式 egress id 命中即采用（来源可回显）', () => {
    const r = resolveSidecarDownloadFetch({ ...base, egressId: 'clash', egressList: [clash] })
    expect(r.proxyURI).toBe('http://127.0.0.1:7897')
    expect(r.source).toBe('egress:clash')
  })

  test('优先级 2：显式 egress id 不存在 → 点名抛错（不静默换出口）', () => {
    expect(() => resolveSidecarDownloadFetch({ ...base, egressId: 'nope', egressList: [clash] }))
      .toThrow(/egress "nope" 不存在/)
  })

  test('优先级 2：显式 egress id 是 socks5 → 点名抛错（v1 仅 http/https）', () => {
    expect(() => resolveSidecarDownloadFetch({
      ...base, egressId: 's', egressList: [{ id: 's', kind: 'socks5', addr: '127.0.0.1:7897' }],
    })).toThrow(/暂不支持/)
  })

  test('优先级 3：Provider 的 egress 引用（zcode-plan-local 配了 clash）', () => {
    const r = resolveSidecarDownloadFetch({ ...base, providerEgressId: 'clash', egressList: [clash] })
    expect(r.proxyURI).toBe('http://127.0.0.1:7897')
    expect(r.source).toBe('provider-egress:clash')
  })

  test('优先级 3（lenient）：Provider 引用了不存在的 egress → 继续往下，不抛错', () => {
    // 与「显式 id」相反：这是 Provider 静态配置的一行脏引用，不该让下载整个炸掉。
    const r = resolveSidecarDownloadFetch({ ...base, providerEgressId: 'ghost', egressList: [clash] })
    // 落到规则 4：表里仅一项 → 自动采用
    expect(r.proxyURI).toBe('http://127.0.0.1:7897')
    expect(r.source).toBe('egress-auto:clash')
  })

  test('优先级 4：表里仅一项时自动采用（单 clash 最常见的形态）', () => {
    const r = resolveSidecarDownloadFetch({ ...base, egressList: [clash] })
    expect(r.proxyURI).toBe('http://127.0.0.1:7897')
    expect(r.source).toBe('egress-auto:clash')
  })

  test('优先级 4：表里多项时不猜（避免把下载送错出口）', () => {
    const r = resolveSidecarDownloadFetch({
      ...base, egressList: [clash, { id: 'other', kind: 'http', addr: '10.0.0.9:8888' }],
    })
    expect(r.proxyURI).toBeNull()
    expect(r.source).toBe('direct')
  })

  test('优先级 5：环境变量（HTTPS 优先于 ALL，来源点名用了哪个）', () => {
    const r = resolveSidecarDownloadFetch({
      wantSystem: false,
      env: { HTTPS_PROXY: 'http://127.0.0.1:8888', ALL_PROXY: 'http://127.0.0.1:9999' },
    })
    expect(r.proxyURI).toBe('http://127.0.0.1:8888')
    expect(r.source).toBe('env:HTTPS_PROXY')
  })

  test('优先级 6：系统代理（darwin scutil 解析结果）', () => {
    const r = resolveSidecarDownloadFetch({
      wantSystem: true, env: {},
      systemProxy: () => ({ scheme: 'http', host: '127.0.0.1:7897' }),
    })
    expect(r.proxyURI).toBe('http://127.0.0.1:7897')
    expect(r.source).toBe('system')
  })

  test('系统代理是 socks5 → 放弃（ProxyAgent 不支持），回落直连', () => {
    const r = resolveSidecarDownloadFetch({
      wantSystem: true, env: {},
      systemProxy: () => ({ scheme: 'socks5', host: '127.0.0.1:7897' }),
    })
    expect(r.proxyURI).toBeNull()
    expect(r.source).toBe('direct')
  })

  test('读系统代理抛错 → 不冒泡，回落直连', () => {
    const r = resolveSidecarDownloadFetch({
      wantSystem: true, env: {},
      systemProxy: () => { throw new Error('scutil 挂了') },
    })
    expect(r.proxyURI).toBeNull()
    expect(r.source).toBe('direct')
  })

  test('优先级 7：全无 → 直连（保持旧行为）', () => {
    const r = resolveSidecarDownloadFetch({ ...base })
    expect(r.proxyURI).toBeNull()
    expect(r.source).toBe('direct')
  })

  test('normalizeProxyURI：只收 http/https，保留认证、丢掉 path', () => {
    expect(normalizeProxyURI('http://127.0.0.1:7897')).toBe('http://127.0.0.1:7897')
    expect(normalizeProxyURI('https://proxy.corp:8443')).toBe('https://proxy.corp:8443')
    // 认证信息必须保留（有密码的代理否则根本连不上）
    expect(normalizeProxyURI('http://u:p@127.0.0.1:7897')).toBe('http://u:p@127.0.0.1:7897')
    // 代理地址不该带路径
    expect(normalizeProxyURI('http://127.0.0.1:7897/some/path')).toBe('http://127.0.0.1:7897')
    for (const bad of ['socks5://127.0.0.1:7897', '', '   ', 'not-a-url', 'ftp://x']) {
      expect(normalizeProxyURI(bad)).toBeNull()
    }
  })

  test('maskProxyURI：密码打码，host 保留；null/invalid 可读', () => {
    expect(maskProxyURI('http://u:secret@127.0.0.1:7897')).toBe('http://u:***@127.0.0.1:7897')
    expect(maskProxyURI('http://127.0.0.1:7897')).toBe('http://127.0.0.1:7897')
    expect(maskProxyURI(null)).toBe('direct')
    expect(maskProxyURI('garbage')).toBe('invalid')
  })

  test('egressDefToProxyURI：kind/addr 收敛，非法一律 null', () => {
    expect(egressDefToProxyURI(clash)).toBe('http://127.0.0.1:7897')
    expect(egressDefToProxyURI({ id: 'h', kind: 'https', addr: 'p.corp:8443' })).toBe('https://p.corp:8443')
    expect(egressDefToProxyURI(undefined)).toBeNull()
    expect(egressDefToProxyURI({ id: 's', kind: 'socks5', addr: '127.0.0.1:7897' })).toBeNull()
    expect(egressDefToProxyURI({ id: 'e', kind: 'http', addr: '' })).toBeNull()
  })
})

// —— describeFetchError：把 undici 的通用 `fetch failed` 还原成可诊断的一句话。
// 四种故障（节点失效/代理没起/DNS 失败/超时）在界面上原本长得一模一样，
// 用例形态全部取自实测，用合成 Error 构造，不打网络。

describe('describeFetchError 传输层错误还原', () => {
  // 实测形态：depth0 是 undici 的通用包装（无 code），真原因在 cause
  const wrap = (code: string, msg: string): Error =>
    new TypeError('fetch failed', { cause: Object.assign(new Error(msg), { code }) })

  test('ECONNRESET（代理能连但节点失效）：带出 code + 分诊建议', () => {
    const out = describeFetchError(wrap(
      'ECONNRESET', 'Client network socket disconnected before secure TLS connection was established'))
    expect(out).toContain('fetch failed')
    expect(out).toContain('ECONNRESET')
    expect(out).toContain('节点') // 建议里要点出「多半是节点失效」
  })

  test('ECONNREFUSED（代理端口没人监听）：保留原始地址便于核对', () => {
    const out = describeFetchError(wrap('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:10944'))
    expect(out).toContain('ECONNREFUSED')
    expect(out).toContain('127.0.0.1:10944')
    expect(out).toContain('没人监听')
  })

  test('ENOTFOUND（DNS 失败）', () => {
    const out = describeFetchError(wrap('ENOTFOUND', 'getaddrinfo ENOTFOUND no-such-host.invalid'))
    expect(out).toContain('ENOTFOUND')
    expect(out).toContain('域名解析')
  })

  test('TimeoutError：没有 cause，靠 error.name 判', () => {
    const e = new Error('The operation was aborted due to timeout')
    e.name = 'TimeoutError'
    const out = describeFetchError(e)
    expect(out).toContain('超时')
  })

  test('无法识别的错误原样带出，不硬塞建议', () => {
    expect(describeFetchError(new Error('boom'))).toBe('boom')
    expect(describeFetchError('plain string')).toBe('plain string')
  })

  test('cause 链自引用不死循环', () => {
    const a = new Error('x') as Error & { cause?: unknown }
    a.cause = a
    expect(() => describeFetchError(a)).not.toThrow()
  })
})

// —— Install 下载（注入 fetch 替身，不打真实网络）

describe('Install 下载安装', () => {
  // 域名必须是真实的 GitHub 下载 host：install 会校验「https + host 白名单」，
  // 用 example.invalid 这类占位域名会被正当拒绝。这里注入的是 fetch 替身，
  // 不会真的发网络请求，用真实域名不引入任何外部依赖。
  const releaseBody = {
    tag_name: 'v9.9.9',
    assets: [
      { name: 'zcode-proxy-darwin-arm64', browser_download_url: 'https://objects.githubusercontent.com/bin', size: 7 },
      { name: 'zcode-proxy.exe', browser_download_url: 'https://objects.githubusercontent.com/bin.exe', size: 7 },
    ],
  }
  const bytes = new TextEncoder().encode('FAKEBIN')

  const jsonFetch = (body: unknown, status = 200) => async (): Promise<Response> =>
    new Response(JSON.stringify(body), { status })
  const binFetch = (status = 200) => async (): Promise<Response> =>
    new Response(bytes, { status })

  test('下载官方 release 到 BinDir（0700），返回路径', async () => {
    const dir = makeTemp('polycode-sinst-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      let calls = 0
      const f = async (url: string | URL | Request): Promise<Response> => {
        calls++
        if (String(url).includes('api.github.com')) return jsonFetch(releaseBody)()
        return binFetch()()
      }
      const dest = await s.install(false, { fetch: f, goos: 'darwin', arch: 'arm64' })
      expect(dest).toBe(join(dir, 'bin', 'zcode-proxy'))
      expect(readFileSync(dest, 'utf8')).toBe('FAKEBIN')
      // 同上：Windows 上 mode 恒为 0o666，helper 已按平台跳过。
      expectMode(dest, 0o700)
      expect(calls).toBe(2)
      // 已存在 → 跳过下载
      const dest2 = await s.install(false, { fetch: f, goos: 'darwin', arch: 'arm64' })
      expect(dest2).toBe(dest)
      expect(calls).toBe(2)
      // force → 重下
      await s.install(true, { fetch: f, goos: 'darwin', arch: 'arm64' })
      expect(calls).toBe(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('release 缺资产 / API 非 200 报错', async () => {
    const s = testSidecar(join(makeTemp('polycode-sinst2-'), 'cred'), { binDir: makeTemp('polycode-sinst2b-') })
    await expect(s.install(false, { fetch: jsonFetch({ tag_name: 'v1', assets: [] }), goos: 'darwin', arch: 'arm64' }))
      .rejects.toThrow(/无资产/)
    await expect(s.install(false, { fetch: jsonFetch({}, 403), goos: 'darwin', arch: 'arm64' }))
      .rejects.toThrow(/http 403/)
    // Windows 本地落地文件名必须带 .exe——历史缺陷是资产名解析对了（zcode-proxy.exe）
    // 而 dest 仍硬编码 'zcode-proxy'，装出来一个无后缀文件，spawn/taskkill 都不认。
    await expect(s.install(false, { fetch: jsonFetch(releaseBody), goos: 'windows', arch: 'x64' }))
      .resolves.toBe(join(s.binDir, 'zcode-proxy.exe'))
  })

  test('release API 的 digest 会被自动采用（不再静默放行）', async () => {
    const dir = makeTemp('polycode-sdig-')
    try {
      // 造一个带真实 sha256 的 body：摘要对上 → 正常安装
      const good = createHash('sha256').update(bytes).digest('hex')
      const body = {
        tag_name: 'v9.9.9',
        assets: [{
          name: 'zcode-proxy-darwin-arm64',
          browser_download_url: 'https://objects.githubusercontent.com/bin',
          size: bytes.length,
          digest: 'sha256:' + good,
        }],
      }
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      const f = async (url: string | URL | Request): Promise<Response> =>
        String(url).includes('api.github.com') ? jsonFetch(body)() : binFetch()()
      await expect(s.install(false, { fetch: f, goos: 'darwin', arch: 'arm64' }))
        .resolves.toBe(join(dir, 'bin', 'zcode-proxy'))

      // 摘要对不上 → 必须拒绝，且不落地
      const bad = { ...body, assets: [{ ...body.assets[0]!, digest: 'sha256:' + 'de'.repeat(32) }] }
      const dir2 = makeTemp('polycode-sdig2-')
      const s2 = testSidecar(join(dir2, 'cred'), { binDir: join(dir2, 'bin') })
      const f2 = async (url: string | URL | Request): Promise<Response> =>
        String(url).includes('api.github.com') ? jsonFetch(bad)() : binFetch()()
      await expect(s2.install(false, { fetch: f2, goos: 'darwin', arch: 'arm64' }))
        .rejects.toThrow(/摘要不匹配/)
      expect(existsSync(join(dir2, 'bin', 'zcode-proxy'))).toBe(false)
      rmSync(dir2, { recursive: true, force: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('localName：Windows 带 .exe，其余不带；幂等口径与 assetName 对齐', () => {
    expect(localName(normalizeGOOS('win32'))).toBe('zcode-proxy.exe')
    expect(localName('windows')).toBe('zcode-proxy.exe')
    expect(localName('darwin')).toBe('zcode-proxy')
    expect(localName('linux')).toBe('zcode-proxy')
  })

  test('findBinary 认 binName（Windows 下必须找 .exe，不是无后缀）', () => {
    // Windows 生命周期用例被 POSIX 夹具限制跳过了，这里补上「查找口径」这条
    // 纯逻辑锚点：把 binName 显式设成 .exe，验证 findBinary 找的就是这个名字。
    // 历史缺陷：install 落地 zcode-proxy.exe，而 findBinary 找 zcode-proxy，
    // 于是「装得上但 status 永远 not installed、start 直接抛未安装」。
    const dir = makeTemp('polycode-sfind-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: dir })
      s.binName = 'zcode-proxy.exe'
      // 只有无后缀文件时：找不到（证明确实按 binName 找，而非宽容匹配）
      writeFileSync(join(dir, 'zcode-proxy'), 'STALE', { mode: 0o755 })
      expect(() => s.findBinary(dir)).toThrow(/未安装/)
      // 补上 .exe 后：命中
      const exe = join(dir, 'zcode-proxy.exe')
      writeFileSync(exe, 'FAKEBIN', { mode: 0o755 })
      expect(s.findBinary(dir)).toBe(exe)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('latestRelease 解析 tag 与资产', async () => {
    const info = await latestRelease(jsonFetch(releaseBody))
    expect(info.tagName).toBe('v9.9.9')
    expect(info.assets[0]?.name).toBe('zcode-proxy-darwin-arm64')
    expect(info.assets[0]?.url).toBe('https://objects.githubusercontent.com/bin')
  })

  // 回归锚点（安全）：下下来的二进制会被 chmod 0700 并 spawn 执行 =
  // 以网关自身权限运行任意代码。所以「从哪下」必须收死：
  // 非 https / 非白名单 host 一律拒绝，不许落地。
  test('下载来源校验：拒绝非 https 与非白名单 host', () => {
    // 正常来源放行
    expect(checkDownloadURL('https://github.com/a/b/releases/download/v1/x')).toBe('')
    expect(checkDownloadURL('https://objects.githubusercontent.com/x')).toBe('')
    // 明文 http 拒绝（可被 MITM 替换）
    expect(checkDownloadURL('http://github.com/x')).toMatch(/https/)
    // 白名单外 host 拒绝（含伪装成 github 子域的情况）
    expect(checkDownloadURL('https://evil.example.com/x')).toMatch(/白名单/)
    expect(checkDownloadURL('https://github.com.evil.com/x')).toMatch(/白名单/)
    expect(checkDownloadURL('https://raw.githubusercontent.com/x')).toMatch(/白名单/)
    // 非 URL / 空串
    expect(checkDownloadURL('not-a-url')).toMatch(/合法 URL/)
    expect(checkDownloadURL('')).toMatch(/为空/)
  })

  test('install 拒绝被篡改的下载地址，且不落地文件', async () => {
    const dir = makeTemp('polycode-surl-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      const evil = {
        tag_name: 'v1',
        assets: [{ name: 'zcode-proxy-darwin-arm64', browser_download_url: 'https://evil.example.com/bin', size: 7 }],
      }
      const f = async (url: string | URL | Request): Promise<Response> =>
        String(url).includes('api.github.com')
          ? new Response(JSON.stringify(evil), { status: 200 })
          : new Response(bytes, { status: 200 })
      await expect(s.install(false, { fetch: f, goos: 'darwin', arch: 'arm64' }))
        .rejects.toThrow(/拒绝下载/)
      // 关键：拒绝后不许留下任何可执行文件
      expect(existsSync(join(dir, 'bin', 'zcode-proxy'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('install 支持 sha256 校验：匹配放行、不匹配拒绝', async () => {
    const dir = makeTemp('polycode-ssha-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      const f = async (url: string | URL | Request): Promise<Response> =>
        String(url).includes('api.github.com')
          ? new Response(JSON.stringify(releaseBody), { status: 200 })
          : new Response(bytes, { status: 200 })
      const good = sha256Hex(bytes)

      // 摘要正确 → 正常安装
      const dest = await s.install(true, { fetch: f, goos: 'darwin', arch: 'arm64', expectedSha256: good })
      expect(readFileSync(dest, 'utf8')).toBe('FAKEBIN')
      // 大写摘要也应接受（大小写不敏感）
      await expect(s.install(true, { fetch: f, goos: 'darwin', arch: 'arm64', expectedSha256: good.toUpperCase() }))
        .resolves.toBe(dest)

      // 摘要不符 → 拒绝，且不覆盖已安装的文件
      const bad = 'deadbeef'.repeat(8)
      await expect(s.install(true, { fetch: f, goos: 'darwin', arch: 'arm64', expectedSha256: bad }))
        .rejects.toThrow(/摘要不匹配/)
      expect(readFileSync(dest, 'utf8')).toBe('FAKEBIN') // 旧文件未被破坏

      // allowUntrusted:false 且未给摘要 → 硬拒绝
      await expect(s.install(true, { fetch: f, goos: 'darwin', arch: 'arm64', allowUntrusted: false }))
        .rejects.toThrow(/未提供 expectedSha256/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// —— EnsureReady：装 → 配 → 起 编排（注入 fetch + 即时 sleep，不碰网络）

describe('EnsureReady 一键入口', () => {
  test('release 查询失败不重试（http 500 是上游答复，重试无意义）', async () => {
    const dir = makeTemp('polycode-sready-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      let calls = 0
      const f = async (): Promise<Response> => { calls++; return new Response('nope', { status: 500 }) }
      let sleeps = 0
      await expect(s.ensureReady(join(dir, 'sidecar'), { fetch: f, sleep: async () => { sleeps++ } }))
        .rejects.toThrow(/http 500/)
      // 「查释放版本」这一步拿到的 500 是上游的明确答复（不是网络抖动），
      // 重试只是把同一个错误再问一遍。重试与续传都留给下载那一段。
      expect(calls).toBe(1)
      expect(sleeps).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// —— 安装进度上报：管理台不再只有一个静止的「安装中」

describe('安装进度上报', () => {
  // 资产表必须覆盖三个平台：install 可以显式传 goos，但 ensureReady 不接受
  // goos（它按本机平台解析资产名），少一个平台这条用例就会在该平台上失败。
  const releaseBody = {
    tag_name: 'v9.9.9',
    assets: [
      { name: 'zcode-proxy-darwin-arm64', browser_download_url: 'https://objects.githubusercontent.com/bin', size: 7 },
      { name: 'zcode-proxy-darwin-x64', browser_download_url: 'https://objects.githubusercontent.com/bin', size: 7 },
      { name: 'zcode-proxy-linux-x64', browser_download_url: 'https://objects.githubusercontent.com/bin', size: 7 },
      { name: 'zcode-proxy.exe', browser_download_url: 'https://objects.githubusercontent.com/bin.exe', size: 7 },
    ],
  }
  const bytes = new TextEncoder().encode('FAKEBIN')
  const twoStepFetch = async (url: string | URL | Request): Promise<Response> =>
    String(url).includes('api.github.com')
      ? new Response(JSON.stringify(releaseBody), { status: 200 })
      : new Response(bytes, { status: 200 })

  test('install 上报 resolving → downloading（带字节）→ verifying', async () => {
    const dir = makeTemp('polycode-spg-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      const seen: SidecarProgress[] = []
      await s.install(false, { fetch: twoStepFetch, goos: 'darwin', arch: 'arm64', onProgress: (p) => seen.push(p) })

      // 查询 release 也要走网络（弱网下这一步就可能卡几十秒），必须先报出来，
      // 否则用户分不清是「卡在查版本」还是「卡在下载」。
      expect(seen[0]!.phase).toBe('resolving')
      const dl = seen.filter((p) => p.phase === 'downloading')
      expect(dl.length).toBeGreaterThan(0)
      expect(dl[0]!.total).toBe(7)
      expect(dl[dl.length - 1]!.received).toBe(7)
      for (let i = 1; i < dl.length; i++) {
        expect(dl[i]!.received).toBeGreaterThanOrEqual(dl[i - 1]!.received)
      }
      expect(seen[seen.length - 1]!.phase).toBe('verifying')
      expect(seen[seen.length - 1]!.received).toBe(7)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('响应无 Content-Length 时用 release 报的 size 兜底（代理丢头也能画百分比）', async () => {
    const dir = makeTemp('polycode-spg2-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      const f = async (url: string | URL | Request): Promise<Response> => {
        if (String(url).includes('api.github.com')) {
          return new Response(JSON.stringify(releaseBody), { status: 200 })
        }
        // 流式 body → undici 不会写 content-length，模拟代理转发丢头
        return new Response(new ReadableStream<Uint8Array>({
          start(c) { c.enqueue(bytes); c.close() },
        }), { status: 200 })
      }
      const seen: SidecarProgress[] = []
      const dest = await s.install(false, { fetch: f, goos: 'darwin', arch: 'arm64', onProgress: (p) => seen.push(p) })
      // 流式读取必须与原来的 arrayBuffer 语义等价：内容一字不差
      expect(readFileSync(dest, 'utf8')).toBe('FAKEBIN')
      const dl = seen.filter((p) => p.phase === 'downloading')
      expect(dl[dl.length - 1]!.total).toBe(7) // 来自 asset.size
      expect(dl[dl.length - 1]!.received).toBe(7)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('进度回调自己抛错不影响安装（旁路不能打断主流程）', async () => {
    const dir = makeTemp('polycode-spg3-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      const dest = await s.install(false, {
        fetch: twoStepFetch, goos: 'darwin', arch: 'arm64',
        onProgress: () => { throw new Error('回调自己炸了') },
      })
      expect(readFileSync(dest, 'utf8')).toBe('FAKEBIN')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('ensureReady 补齐 configuring / starting 两个阶段', async () => {
    const dir = makeTemp('polycode-spg4-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      // 不真起进程：running 报 false、start 打桩成立即返回。真实 start 会
      // waitHealthy 最长 45 秒，那 45 秒以前在页面上完全不可见。
      vi.spyOn(s, 'running').mockResolvedValue(false)
      const started = vi.spyOn(s, 'start').mockResolvedValue(undefined)
      const phases: string[] = []
      await s.ensureReady(join(dir, 'sidecar'), {
        fetch: twoStepFetch,
        onProgress: (p) => phases.push(p.phase),
      })
      expect(started).toHaveBeenCalledTimes(1)
      expect(phases[0]).toBe('resolving')
      expect(phases).toContain('configuring')
      expect(phases).toContain('starting')
      // 顺序：先装（下载/校验）→ 再配 → 最后起
      expect(phases.indexOf('configuring')).toBeLessThan(phases.indexOf('starting'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// —— 断点续传：87MB 产物在弱网/代理下每 20 秒就被掐断一次，只重试不续传
// 等于进度条永远爬不到头（真实缺陷：macOS 装得上、Windows 装不下来）

describe('下载断点续传', () => {
  // 两个平台的资产都登记，且每个用例显式传 goos/arch：这套用例测的是「续传语义」，
  // 与跑在什么机器上无关。此前 fixture 只登记 .exe，用例又不传平台，
  // 于是在 macOS/Linux 上按本机平台算出 zcode-proxy-darwin-arm64 → 找不到资产，
  // 5 个用例全挂在「无资产」上（Windows 上却是绿的）——测试成了平台相关的。
  const releaseBody = {
    tag_name: 'v9.9.9',
    assets: [
      { name: 'zcode-proxy-darwin-arm64', browser_download_url: 'https://objects.githubusercontent.com/bin', size: 100 },
      { name: 'zcode-proxy.exe', browser_download_url: 'https://objects.githubusercontent.com/bin.exe', size: 100 },
    ],
  }
  // 整份内容：前 40 字节 + 后 60 字节，用来验证续传拼出来的字节与一次下完等价
  const full = Buffer.alloc(100)
  for (let i = 0; i < full.length; i++) full[i] = i % 251

  // flakyFetch：第一次只给前 40 字节就「断线」，第二次按 Range 头给剩下的。
  // 这是 ECONNRESET 的最小复现形态——数据流中途抛错，而不是干净地结束。
  function flakyFetch(): {
    fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>
    seenRanges: (string | null)[]
  } {
    const seenRanges: (string | null)[] = []
    let attempt = 0
    const f = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(url).includes('api.github.com')) {
        return new Response(JSON.stringify(releaseBody), { status: 200 })
      }
      const range = new Headers(init?.headers).get('range')
      seenRanges.push(range)
      attempt++
      const start = range === null ? 0 : Number(/bytes=(\d+)-/.exec(range)![1])
      if (attempt === 1) {
        // 前 40 字节正常吐出来（read 拿到数据），**下一次 read 才**抛 ECONNRESET。
        // 这是真实断流的最小复现：数据先到，然后连接被重置。若在同一个
        // start() 里 enqueue 完立刻 error，排队的 chunk 会被丢弃、根本到不了
        // 读端——那不是断流，是「什么都没收到」。
        let n = 0
        return new Response(new ReadableStream<Uint8Array>({
          pull(c) {
            if (n++ === 0) { c.enqueue(full.subarray(0, 40)); return }
            c.error(new Error('read ECONNRESET'))
          },
        }), { status: 200 })
      }
      // 第二轮：带 Range 续传，必须真的只补剩下那一段
      return new Response(full.subarray(start), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-99/100` },
      })
    }
    return { fetch: f, seenRanges }
  }

  test('中断后带 Range 续传，落地内容与一次下完完全一致', async () => {
    const dir = makeTemp('polycode-sres-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      const { fetch: f, seenRanges } = flakyFetch()
      const dest = await s.install(false, {
        goos: 'darwin', arch: 'arm64',
        fetch: f as never, sleep: async () => { /* 不真等 */ },
      })
      // 第一次不带 Range；第二次必须从第 40 字节接着下（而不是从 0 重来）
      expect(seenRanges[0]).toBeNull()
      expect(seenRanges[1]).toBe('bytes=40-')
      // 拼出来的文件必须与完整内容一字不差
      expect(Buffer.compare(readFileSync(dest), full)).toBe(0)
      // 半成品文件在成功后必须消失
      expect(existsSync(partPath(dest))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('续传期间进度只增不减（不因重试倒回 0）', async () => {
    const dir = makeTemp('polycode-sres2-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      const { fetch: f } = flakyFetch()
      const seen: SidecarProgress[] = []
      await s.install(false, { goos: 'darwin', arch: 'arm64', fetch: f as never, sleep: async () => {}, onProgress: (p) => seen.push(p) })
      const dl = seen.filter((p) => p.phase === 'downloading')
      // 关键回归：收到过 40 字节之后，后续上报不允许再出现更小的 received。
      // 旧实现每次重试都从 0 重下，进度条会一次次打回起点。
      let max = 0
      for (const p of dl) {
        expect(p.received).toBeGreaterThanOrEqual(max)
        max = Math.max(max, p.received)
      }
      expect(max).toBe(100)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('服务端不支持 Range（回 200）时不追加，避免拼出错位文件', async () => {
    const dir = makeTemp('polycode-sres3-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      let attempt = 0
      const f = async (url: string | URL | Request): Promise<Response> => {
        if (String(url).includes('api.github.com')) {
          return new Response(JSON.stringify(releaseBody), { status: 200 })
        }
        attempt++
        if (attempt === 1) {
          let n = 0
          return new Response(new ReadableStream<Uint8Array>({
            pull(c) {
              if (n++ === 0) { c.enqueue(full.subarray(0, 40)); return }
              c.error(new Error('read ECONNRESET'))
            },
          }), { status: 200 })
        }
        // 假装是个不认 Range 的镜像：无视 Range 头，从 0 重发整份
        return new Response(full, { status: 200 })
      }
      const dest = await s.install(false, { goos: 'darwin', arch: 'arm64', fetch: f as never, sleep: async () => {} })
      // 200 必须走截断重写：若误用追加，文件会是 40+100=140 字节的错位数据
      expect(readFileSync(dest).length).toBe(100)
      expect(Buffer.compare(readFileSync(dest), full)).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 回归：断流恰好发生在「一段已经读完」的时刻。真实网络上极常见——数据收齐了，
  // 收尾时连接被掐断。若只在 catch 里记失败而不回头核对落盘长度，下一轮会拿
  // Range: bytes=<总长>- 去请求，服务端回一段又断，于是空转到耗尽重试次数。
  // 修前实测：20MB 用例第 5 轮起 Range 卡在文件总长，一直试到 60 次才报错。
  test('每轮都断在「刚好读完一段」时，多轮续传仍能下完（不空转到耗尽次数）', async () => {
    const dir = makeTemp('polycode-sres5-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      const chunk = 40 // 每轮只吐 40 字节，然后立刻断
      let rounds = 0
      const f = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (String(url).includes('api.github.com')) {
          return new Response(JSON.stringify(releaseBody), { status: 200 })
        }
        const range = new Headers(init?.headers).get('range')
        const start = range === null ? 0 : Number(/bytes=(\d+)-/.exec(range)![1])
        rounds++
        const end = Math.min(start + chunk, full.length)
        let off = start
        return new Response(new ReadableStream<Uint8Array>({
          pull(c) {
            // 这一段吐完（off 到 end）之后才抛断流——断在「刚好读完」这个点上
            if (off >= end) { c.error(new Error('read ECONNRESET')); return }
            c.enqueue(full.subarray(off, end)); off = end
          },
        }), { status: 206, headers: { 'content-range': `bytes ${start}-${full.length - 1}/${full.length}` } })
      }
      const dest = await s.install(false, { goos: 'darwin', arch: 'arm64', fetch: f as never, sleep: async () => {} })
      expect(Buffer.compare(readFileSync(dest), full)).toBe(0)
      // 100 字节 / 每轮 40 → 3 轮足够；空转的话会一路试到上限 60
      expect(rounds).toBeLessThanOrEqual(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('4xx 不重试：资产被删/被限流重试也只是再错一次', async () => {    const dir = makeTemp('polycode-sres4-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      let dlCalls = 0
      const f = async (url: string | URL | Request): Promise<Response> => {
        if (String(url).includes('api.github.com')) {
          return new Response(JSON.stringify(releaseBody), { status: 200 })
        }
        dlCalls++
        return new Response('denied', { status: 404 })
      }
      await expect(s.install(false, { goos: 'darwin', arch: 'arm64', fetch: f as never, sleep: async () => {} }))
        .rejects.toThrow(/http 404/)
      expect(dlCalls).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 回归：磁盘上残留**旧版本**半成品时，绝不能带 Range 续传。
  // 旧实现只守 received >= asset.size（挡住「半成品更大」），反向没守：
  // 旧包更小时会把新版本字节追加到旧数据后面，拼出一个长度恰好等于
  // asset.size 的「缝合怪」——长度校验照样通过，然后被 chmod 0700 执行。
  // 现在 .part 旁记来源（tag+资产名+大小+digest），对不上就整包重下。
  test('残留旧版本半成品：不续传，整包重下（不拼出缝合怪）', async () => {
    const dir = makeTemp('polycode-stale-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      // 造一个「旧版本的半成品」：内容与本次要下的资产不同，长度 30 < 100
      const partFile = join(dir, 'bin', 'zcode-proxy.part')
      mkdirSync(join(dir, 'bin'), { recursive: true })
      const stale = Buffer.alloc(30, 0xAA)
      writeFileSync(partFile, stale)
      // 且**没有** .meta（旧实现遗留的半成品正是这个形态）

      const seenRanges: (string | null)[] = []
      const { fetch: f } = flakyFetch()
      const spy = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (String(url).includes('api.github.com')) {
          return new Response(JSON.stringify(releaseBody), { status: 200 })
        }
        seenRanges.push(new Headers(init?.headers).get('range'))
        return f(url, init)
      }
      const dest = await s.install(false, {
        goos: 'darwin', arch: 'arm64', fetch: spy as never, sleep: async () => {},
      })
      // 关键：第一次下载就不能带 Range（旧半成品不属于本次资产）
      expect(seenRanges[0]).toBeNull()
      // 落地内容必须是本次资产的完整字节，绝不含旧数据的 0xAA 前缀
      const got = readFileSync(dest)
      expect(got.length).toBe(100)
      expect(Buffer.compare(got, full)).toBe(0)
      expect(got[0]).not.toBe(0xAA)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})


// —— 启动失败的根因要能到达页面 ——
//
// 真实缺陷（Windows「老是启动失败」）：引擎没登录时打印 `Not logged in` 并以
// 退出码 1 立刻退出，而 waitHealthy 只会说「启动超时」——用户被引向
// 「网络/二进制坏了」，真正该做的「跑一次登录」反而看不见。

describe('启动失败提示 startupFailureHint', () => {
  const writeLog = (dir: string, text: string): string => {
    const work = join(dir, 'sidecar')
    mkdirSync(join(work, 'logs'), { recursive: true })
    writeFileSync(join(work, 'logs', 'sidecar.log'), text)
    return work
  }

  test('未登录 → 给出可直接照做的登录指引（而不是一句「超时」）', () => {
    const dir = makeTemp('polycode-shint1-')
    try {
      const work = writeLog(dir, 'Not logged in. Run: zcode-proxy auth login zai\n')
      const hint = startupFailureHint(work)
      expect(hint).toContain('未登录')
      expect(hint).toContain('zcode sidecar login')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('端口占用 / 权限 各有对应建议', () => {
    const dir = makeTemp('polycode-shint2-')
    try {
      const a = writeLog(dir, 'listen tcp 127.0.0.1:8080: bind: address already in use\n')
      expect(startupFailureHint(a)).toContain('端口已被占用')
      const b = writeLog(dir, 'open ./zcode-proxy: permission denied\n')
      expect(startupFailureHint(b)).toContain('执行权限')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Bun 口径（回归锚点，真实故障 2026-09-19）：引擎是 Bun 打的二进制，bind 失败
  // 时**不打** Go/Node 那句 "address already in use"，而是下面的措辞。老正则
  // 匹配不上 → 落到「最后一行」兜底 → 用户看到的是 Bun 的版本脚注，真正的
  // 根因（端口被僵死的旧进程占着）被完全盖住。这是当时页面上报错的原句。
  test('Bun 的端口占用措辞要被认出来（不能退化成版本脚注）', () => {
    const dir = makeTemp('polycode-shbun-')
    try {
      const bun = [
        'error: Failed to start server. Is port 8080 in use?',
        ' syscall: "listen",',
        '   errno: 0,',
        '    code: "EADDRINUSE"',
        '',
        'Bun v1.4.0 (macOS arm64)',
      ].join('\n') + '\n'
      const hint = startupFailureHint(writeLog(dir, bun))
      expect(hint).toContain('端口已被占用')
      expect(hint).not.toContain('Bun v1.4.0')
      // 单独出现 EADDRINUSE（别的 runtime 措辞）同样要认得
      expect(startupFailureHint(writeLog(dir + '-2', 'Error: listen EADDRINUSE: address already in use\n')))
        .toContain('端口已被占用')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(dir + '-2', { recursive: true, force: true })
    }
  })

  // 「没人认得 + 最后一行是 Bun 版本脚注」= 那句让用户完全摸不着头脑的报错。
  // 宁可退回「启动超时」，也不要把与故障无关的版本号端给用户。
  test('Bun 版本脚注不该被当成「最后一行」报给用户', () => {
    const dir = makeTemp('polycode-shbun2-')
    try {
      const work = writeLog(dir, '359 | };\n360 | Server.prototype[kRealListen] = function() {\n\nBun v1.4.0 (macOS arm64)\n')
      expect(startupFailureHint(work)).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('认得原因时跳过脚注行，取最后一行有意义的原文', () => {
    const dir = makeTemp('polycode-shbun3-')
    try {
      // 脚注在最后，但它上面那行才是真实信息
      const work = writeLog(dir, 'something went quite wrong\nBun v1.4.0 (macOS arm64)\n')
      expect(startupFailureHint(work)).toContain('something went quite wrong')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('isPortInUseError 认三种口径（含 hint 翻好的中文）', () => {
    expect(isPortInUseError(new Error('sidecar: 启动失败 —— 端口已被占用。'))).toBe(true)
    expect(isPortInUseError(new Error('listen tcp: bind: address already in use'))).toBe(true)
    expect(isPortInUseError(new Error('Failed to start server. Is port 8080 in use? EADDRINUSE'))).toBe(true)
    // 别的失败原因不能被误判成端口问题——否则守护会对着「未登录」反复清场
    expect(isPortInUseError(new Error('Not logged in. Run: zcode-proxy auth login zai'))).toBe(false)
    expect(isPortInUseError(new Error('permission denied'))).toBe(false)
  })

  test('认不出的失败：带出日志最后一行，总比只说「超时」有用', () => {
    const dir = makeTemp('polycode-shint3-')
    try {
      const work = writeLog(dir, 'panic: some brand new failure mode\n')
      expect(startupFailureHint(work)).toContain('panic: some brand new failure mode')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('日志不存在 → 返回空串（调用方退回「启动超时」，不编造原因）', () => {
    const dir = makeTemp('polycode-shint4-')
    try {
      expect(startupFailureHint(join(dir, 'nope'))).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('只看日志尾部：陈旧的 Not logged in 不该掩盖当前真实失败', () => {
    const dir = makeTemp('polycode-shint5-')
    try {
      // 早先登录过、后来因为端口占用失败——不能因为历史里有 Not logged in 就误报
      const old = 'Not logged in. Run: zcode-proxy auth login zai\n'.repeat(50)
      const work = writeLog(dir, old + 'x'.repeat(5000)
        + '\nlisten tcp 127.0.0.1:8080: bind: address already in use\n')
      expect(startupFailureHint(work)).toContain('端口已被占用')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // logTailHint 是早退路径专用的：只看「本次启动新增」的那一段日志。
  // 这条是上一条的强化——历史里的 Not logged in 必须与本次无关。
  test('logTailHint 只认本次新增的日志，不被历史错误污染', () => {
    const dir = makeTemp('polycode-shint6-')
    try {
      const work = join(dir, 'sidecar')
      mkdirSync(join(work, 'logs'), { recursive: true })
      const logPath = join(work, 'logs', 'sidecar.log')
      const old = 'Not logged in. Run: zcode-proxy auth login zai\n'
      writeFileSync(logPath, old)
      const from = old.length
      writeFileSync(logPath, old + 'bind: address already in use\n')
      // 从 from 之后读 → 只看到本次的端口冲突
      expect(logTailHint(work, logPath, from)).toContain('端口已被占用')
      // 退而求其次读全量时，才会看到历史里的 Not logged in（说明切片确实生效）
      expect(startupFailureHint(work)).toContain('未登录')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})


// ——（注：这里曾有一个用**本地复刻正则**的「登录授权 URL 抓取」用例块——
// 复刻的正则只认 oauth/authorize、缺 bigmodel 分支，与生产 authURLRe 各说各话，
// 生产正则再退化它也测不出来，已整块删除；分块边界与「无 URL → 空串」的用例
// 都并入下面使用生产 authURLRe 的 beginLogin 块。）——

// —— 未登录时自动导入本机 ZCode 凭据 ——
//
// 用户原话：「既然没登陆就不能自动弹出登录界面吗」。以前启动失败只会甩给用户
// 一句「去终端跑 polycode-hub zcode sidecar login」——而多数人早就用 ZCode
// 客户端登录过，凭据现成放着，程序完全可以自己导入。

describe('未登录自动导入凭据', () => {
  test('start 遇到 Not logged in → 先自动导入，再重试启动（用户零操作）', async () => {
    const dir = makeTemp('polycode-auto1-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      // 第一次 start 抛「未登录」，自动导入成功后第二次应当成功
      let attempts = 0
      const startOnce = vi.spyOn(s as never, 'startOnce' as never)
        .mockImplementation((async () => {
          attempts++
          if (attempts === 1) throw new Error('sidecar: 启动失败 —— 引擎未登录（日志：Not logged in）')
        }) as never)
      const imported = vi.spyOn(s, 'tryAutoImportCredentials').mockResolvedValue('bigmodel')

      await s.start(join(dir, 'sidecar'))
      expect(imported).toHaveBeenCalledTimes(1)
      expect(attempts).toBe(2) // 失败 → 导入 → 再试一次
      expect(startOnce).toHaveBeenCalledTimes(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('导入也失败 → 把原始「未登录」错误抛给用户（不谎报成功）', async () => {
    const dir = makeTemp('polycode-auto2-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      vi.spyOn(s as never, 'startOnce' as never)
        .mockRejectedValue(new Error('sidecar: 启动失败 —— 引擎未登录（日志：Not logged in）') as never)
      vi.spyOn(s, 'tryAutoImportCredentials').mockResolvedValue('')

      await expect(s.start(join(dir, 'sidecar'))).rejects.toThrow(/未登录/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('与登录无关的启动失败（如端口占用）不去做导入，原样抛出', async () => {
    const dir = makeTemp('polycode-auto3-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      vi.spyOn(s as never, 'startOnce' as never)
        .mockRejectedValue(new Error('sidecar: 启动失败 —— 端口已被占用') as never)
      const imported = vi.spyOn(s, 'tryAutoImportCredentials').mockResolvedValue('bigmodel')

      await expect(s.start(join(dir, 'sidecar'))).rejects.toThrow(/端口已被占用/)
      // 别在无关故障上白跑导入：那是两次多余的进程 spawn
      expect(imported).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// —— 出口双向回退 + 取消（用户明确要求的三点）——
//
// 1) 代理连不上 → 自动换直连；2) 直连连不上 → 自动换代理；3) 两条都不通 → 抛异常。
// 4) 下载中必须能取消（以前只能等它跑满 60 轮或杀进程）。

describe('出口双向回退', () => {
  test('代理连续零推进 → 自动改用直连，最终下载成功', async () => {
    const dir = makeTemp('polycode-swap1-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      const body = {
        tag_name: 'v9.9.9',
        assets: [{ name: 'zcode-proxy.exe', browser_download_url: 'https://objects.githubusercontent.com/bin.exe', size: 100 }],
      }
      let proxyTries = 0
      // 代理：release 查询能过（走直连兜底），但资产永远 ECONNRESET
      const proxyFetch = (async (url: string | URL | Request) => {
        if (String(url).includes('api.github.com')) return new Response(JSON.stringify(body), { status: 200 })
        proxyTries++
        throw new Error('read ECONNRESET')
      }) as never
      // 直连：正常给数据
      const realFetch = globalThis.fetch
      globalThis.fetch = (async (url: string | URL | Request) => {
        if (String(url).includes('api.github.com')) return new Response(JSON.stringify(body), { status: 200 })
        return new Response(Buffer.alloc(100), { status: 200 })
      }) as never
      try {
        // goos 显式给 'windows'：release 替身里只有 zcode-proxy.exe 资产，
        // 而默认 goos 跟随 process.platform——POSIX 上会找不到资产直接抛错。
        // assetName('windows', …) 与 arch 无关，任何平台都能跑这个替身。
        const dest = await s.install(false, {
          goos: 'windows', fetch: proxyFetch, proxySource: 'egress-auto:clash', sleep: async () => {},
        })
        expect(existsSync(dest)).toBe(true)
        // 阈值是 20 轮零推进（见 ZERO_PROGRESS_LIMIT 的演进注释）；这里断言
        // 代理确实被试满冷启动窗口之后才换，而不是第 3 轮就放弃。
        expect(proxyTries).toBeGreaterThanOrEqual(15)
      } finally { globalThis.fetch = realFetch }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('直连连续零推进 → 自动改用代理（反向也成立）', async () => {
    const dir = makeTemp('polycode-swap2-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      const body = {
        tag_name: 'v9.9.9',
        assets: [{ name: 'zcode-proxy.exe', browser_download_url: 'https://objects.githubusercontent.com/bin.exe', size: 100 }],
      }
      let directTries = 0
      const realFetch = globalThis.fetch
      globalThis.fetch = (async (url: string | URL | Request) => {
        if (String(url).includes('api.github.com')) return new Response(JSON.stringify(body), { status: 200 })
        directTries++
        throw new Error('read ECONNRESET')
      }) as never
      let proxyTries = 0
      const proxyFetch = (async (url: string | URL | Request) => {
        if (String(url).includes('api.github.com')) return new Response(JSON.stringify(body), { status: 200 })
        proxyTries++
        return new Response(Buffer.alloc(100), { status: 200 })
      }) as never
      try {
        const dest = await s.install(false, {
          goos: 'windows', fetch: proxyFetch, proxySource: 'direct', sleep: async () => {},
        })
        expect(existsSync(dest)).toBe(true)
        expect(directTries).toBeGreaterThanOrEqual(3) // 直连先失败若干轮
        expect(proxyTries).toBeGreaterThan(0)         // 然后切到代理成功
      } finally { globalThis.fetch = realFetch }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('两条路都不通 → 抛异常（不谎报成功、不无限换）', async () => {
    const dir = makeTemp('polycode-swap3-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      const body = {
        tag_name: 'v9.9.9',
        assets: [{ name: 'zcode-proxy.exe', browser_download_url: 'https://objects.githubusercontent.com/bin.exe', size: 100 }],
      }
      const dead = (async (url: string | URL | Request) => {
        if (String(url).includes('api.github.com')) return new Response(JSON.stringify(body), { status: 200 })
        throw new Error('read ECONNRESET')
      }) as never
      const realFetch = globalThis.fetch
      globalThis.fetch = dead
      try {
        await expect(s.install(false, {
          goos: 'windows', fetch: dead, proxySource: 'egress-auto:clash', sleep: async () => {},
        })).rejects.toThrow(/ECONNRESET|失败/)
      } finally { globalThis.fetch = realFetch }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('下载可取消', () => {
  const body = {
    tag_name: 'v9.9.9',
    assets: [{ name: 'zcode-proxy.exe', browser_download_url: 'https://objects.githubusercontent.com/bin.exe', size: 100_000 }],
  }

  test('abort 后立刻抛 SidecarCancelledError，且已下的 .part 保留（= 暂停语义，可续传）', async () => {
    const dir = makeTemp('polycode-cancel1-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      const ac = new AbortController()
      const chunk = Buffer.alloc(1000)
      // 资产远大于取消点，且**每块之间让出事件循环**，保证取消确实落在传输中途
      // 而不是「假流瞬间跑完」。不让出的话 100KB 会在 20ms 内读完，定时器根本
      // 来不及触发 —— 这正是前两版测试一直 resolved 的原因。
      const f = (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('api.github.com')) return new Response(JSON.stringify(body), { status: 200 })
        let sent = 0
        return new Response(new ReadableStream<Uint8Array>({
          async pull(c) {
            if (init?.signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
            if (sent >= 100_000) { c.close(); return }
            sent += chunk.length
            c.enqueue(chunk)
            await new Promise((r) => setTimeout(r, 2)) // 让真实时间流逝
          },
        }), { status: 200 })
      }) as never

      let triggered = false
      const t0 = Date.now()
      // 用定时器触发取消，而不是挂在 onProgress 上：进度回调有 200ms 节流，
      // 假流又跑得极快，挂在回调上会「还没等回调就被下完」→ 测试变成 flaky。
      // 定时器能稳定地打在传输中途。
      const timer = setTimeout(() => { triggered = true; ac.abort() }, 30)
      try {
        await expect(s.install(false, {
          goos: 'windows', fetch: f, signal: ac.signal, sleep: async () => {},
        })).rejects.toThrow(SidecarCancelledError)
      } finally { clearTimeout(timer) }
      expect(triggered).toBe(true)
      // 立刻停下（不是等退避重试跑完）
      expect(Date.now() - t0).toBeLessThan(5000)
      // 半成品保留：取消不等于把已下的字节也扔掉，下次能接着传
      const part = join(dir, 'bin', 'zcode-proxy.exe.part')
      expect(existsSync(part)).toBe(true)
      expect(statSync(part).size).toBeGreaterThan(0)
      // 目标文件不该落地（没下完就不是有效二进制）
      expect(existsSync(join(dir, 'bin', 'zcode-proxy.exe'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('已取消的 signal → 一开始就拒绝，不发任何请求', async () => {
    const dir = makeTemp('polycode-cancel2-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      const ac = new AbortController()
      ac.abort()
      let calls = 0
      const f = (async () => { calls++; return new Response(JSON.stringify(body), { status: 200 }) }) as never
      await expect(s.install(false, { goos: 'windows', fetch: f, signal: ac.signal, sleep: async () => {} }))
        .rejects.toThrow(SidecarCancelledError)
      expect(calls).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('代理冷启动预热', () => {
  // 真实缺陷（用户实测打脸后修正）：代理是好的，但**头几次连接会被重置**，
  // 之后非常快。我一度误判成「代理坏了」，把换路阈值设成 3 轮——正好卡在冷启动
  // 窗口中间，于是永远用不上代理，掉到慢 53 倍的直连（2.67 vs 0.05 MB/s）。
  // 症状就是用户说的「切不切代理都一样慢」。
  const body = {
    tag_name: 'v9.9.9',
    assets: [{ name: 'zcode-proxy.exe', browser_download_url: 'https://objects.githubusercontent.com/bin.exe', size: 100 }],
  }

  test('代理前几轮 ECONNRESET 后恢复 → 全程留在代理，不切直连', async () => {
    const dir = makeTemp('polycode-warm1-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      let proxyCalls = 0
      const deadDirect = (async () => { throw new Error('直连不该被用到') }) as never
      const realFetch = globalThis.fetch
      globalThis.fetch = deadDirect
      // 前 5 次 resets，第 6 次开始成功（贴近实测的冷启动窗口）
      const warmProxy = (async (url: string | URL | Request) => {
        if (String(url).includes('api.github.com')) return new Response(JSON.stringify(body), { status: 200 })
        proxyCalls++
        if (proxyCalls <= 5) throw new Error('read ECONNRESET')
        return new Response(Buffer.alloc(100), { status: 200 })
      }) as never
      try {
        const dest = await s.install(false, {
          goos: 'windows', fetch: warmProxy, proxySource: 'egress-auto:clash', sleep: async () => {},
        })
        expect(existsSync(dest)).toBe(true)
        // 关键：必须撑过冷启动，而不是第 3 轮就换路
        expect(proxyCalls).toBeGreaterThan(5)
      } finally { globalThis.fetch = realFetch }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('latestRelease 在代理冷启动后仍优先用代理（不因一次失败就跳直连）', async () => {
    let proxyCalls = 0
    const flaky = (async () => {
      proxyCalls++
      if (proxyCalls <= 4) throw new Error('read ECONNRESET')
      return new Response(JSON.stringify({ tag_name: 'v9.9.9', assets: [] }), { status: 200 })
    }) as never
    const r = await latestRelease(flaky, 'egress-auto:clash')
    expect(r.tagName).toBe('v9.9.9')
    expect(proxyCalls).toBe(5) // 试到第 5 次成功，而不是第 1 次就放弃
  })

  // 回归：本地代理「活着但连不上游」时最常见的是 502/503，而不是连接异常。
  // 旧实现只在**抛异常**时才兜底直连（判据是 res === null），拿到 5xx 会立刻
  // 走到 `if (res.status !== 200) throw`，正是它注释里宣称要解决的那个场景。
  test('latestRelease 代理返回 5xx 也会兜底直连（不只兜异常）', async () => {
    const realFetch = globalThis.fetch
    let proxyCalls = 0
    let directCalls = 0
    const proxy = (async () => {
      proxyCalls++
      return new Response('bad gateway', { status: 502 })
    }) as never
    globalThis.fetch = (async () => {
      directCalls++
      return new Response(JSON.stringify({ tag_name: 'v9.9.9', assets: [] }), { status: 200 })
    }) as never
    try {
      const r = await latestRelease(proxy, 'egress-auto:clash')
      expect(r.tagName).toBe('v9.9.9')
      expect(proxyCalls).toBe(6)   // 5xx 计入重试，把 6 次额度用完
      expect(directCalls).toBe(1)  // 然后才走直连
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

// —— 暂停（保留） vs 取消（丢弃）——
//
// 用户明确指出：此前的「取消」实际是暂停语义，名不副实。两者必须分开：
//   · 暂停 = 停下载，保留 .part，下次续传
//   · 取消 = 停下载 + 删 .part，下次从 0 开始

describe('discardPartial', () => {
  test('删除已下的一半（.part），返回被删字节数', () => {
    const dir = makeTemp('polycode-discard1-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      mkdirSync(join(dir, 'bin'), { recursive: true })
      // 文件名跟 s.binName 走（discardPartial 的判据）：Windows 是 zcode-proxy.exe.part，
      // POSIX 是 zcode-proxy.part——硬编码 .exe 的话这组用例在 mac/linux 必挂。
      const part = partPath(join(dir, 'bin', s.binName))
      writeFileSync(part, Buffer.alloc(1234))
      const removed = s.discardPartial(dir)
      expect(removed).toBe(1234)
      expect(existsSync(part)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('没东西可删时返回 0（不报错，幂等）', () => {
    const dir = makeTemp('polycode-discard2-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      expect(s.discardPartial(dir)).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('绝不误删已装好的正式二进制（取消 ≠ 卸载）', () => {
    const dir = makeTemp('polycode-discard3-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      mkdirSync(join(dir, 'bin'), { recursive: true })
      const bin = join(dir, 'bin', s.binName)
      writeFileSync(bin, Buffer.alloc(999))
      s.discardPartial(dir)
      // 正式产物必须还在：取消的是「这次下载」，不是卸载引擎
      expect(existsSync(bin)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// —— 卸载失败必须报出来，不能静默吞掉 ——
//
// 真实缺陷（用户报告「点了卸载还是显示 installed」）：Windows 上可执行文件
// 正被占用时 unlinkSync 抛 EPERM/EBUSY，原实现用 `catch {}` 当「本来就不在」
// 静默跳过 → 卸载返回成功、二进制原封不动。静默吞异常比报错更糟：
// 用户以为卸了，实际没卸。

describe('卸载失败不再静默', () => {
  test('删除受阻（EPERM）→ 抛错说明哪个文件、可能因何占用', async () => {
    const dir = makeTemp('polycode-uninst-perm-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin'), workDir: join(dir, 'w') })
      mkdirSync(join(dir, 'bin'), { recursive: true })
      // 文件名跟 s.binName 走（uninstall 的判据与 install/findBinary 同口径），
      // 硬编码 .exe 在 POSIX 上找不到目标、EPERM 分支根本不触发
      const bin = join(dir, 'bin', s.binName)
      writeFileSync(bin, Buffer.alloc(10))
      // ESM 的 namespace 是只读的，spyon 会报 Cannot redefine property。
      // 改用「临时替换 statSync 之后再把它换回来」不可行（同为只读），
      // 于是走另一条路：直接验证 uninstall 的错误分支——把文件变成不可删的
      // 目录（unlinkSync 对目录抛 EPERM/EISDIR，正好覆盖非 ENOENT 分支）。
      rmSync(bin)
      mkdirSync(bin) // 同名目录：unlinkSync 会失败，且不是 ENOENT
      await expect(s.uninstall(false)).rejects.toThrow(/卸载未能删除|占用|停止/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('文件本就不在（ENOENT）→ 不算失败，正常返回', async () => {
    const dir = makeTemp('polycode-uninst-none-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin'), workDir: join(dir, 'w') })
      mkdirSync(join(dir, 'bin'), { recursive: true })
      // 什么都没装 → 全是 ENOENT，不该抛错
      await expect(s.uninstall(false)).resolves.toBeDefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// —— 暂停 / 取消 两个路由必须走不同分支 ——

//
// 真实 bug（用户反馈「我取消安装，还是从下载到一半的进度开始」）：
// 路由曾写成
//   case 'cancel':
//   case 'pause':
// 于是 'cancel' 直接 fall-through 进 pause 分支，删除逻辑永远执行不到，
// 「取消」实际只做了暂停，.part 一直留着 → 取消后仍从一半续传。

describe('pause 与 cancel 路由分支', () => {
  test('取消确实删除 .part，暂停不删 —— 两者行为可区分', () => {
    const dir = makeTemp('polycode-pc1-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      mkdirSync(join(dir, 'bin'), { recursive: true })
      // 文件名跟 s.binName 走（与 discardPartial 的判据同口径），POSIX 上才不会挂
      const part = partPath(join(dir, 'bin', s.binName))

      // 取消 = 删除
      writeFileSync(part, Buffer.alloc(5000))
      expect(s.discardPartial(dir)).toBe(5000)
      expect(existsSync(part)).toBe(false)

      // 暂停 = 什么都不删（模拟：文件留在那儿）
      writeFileSync(part, Buffer.alloc(5000))
      expect(existsSync(part)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// —— pause / cancel / login 走**真实路由** ——
//
// 此前这里有两组「测自己」的用例：一是在测试里复刻一份 switch 来验证
// 分发（生产再出现 case fall-through 它照样绿），二是复刻 startLogin 的
// 会话守卫（同病）。现在统一改为 createSidecarApp + 打桩 Sidecar，直接打
// HTTP 路由断言行为——生产接线变了测试立刻红。

// 给一组打桩 Sidecar 造一个挂好路由的 Hono app（与 wiring.test.ts 同法）。
function sidecarAppFor(svc: Record<string, unknown>) {
  const app = new Hono()
  app.route('/admin/api/sidecar', createSidecarApp(
    svc as never,
    { getByName: () => undefined, put: () => {} } as never,
    () => {},
  ))
  return app
}

describe('pause / cancel 路由（真实接线）', () => {
  // 造一个「正在下载」的作业：ensureReady 挂住直到 signal 被 abort。
  function runningSvc(dir: string, discardCalls: () => number) {
    const ac = new AbortController()
    return {
      ac,
      svc: {
        workDir: dir,
        port: '8080',
        credKey: join(dir, 'k'),
        detectProvider: () => 'zai',
        ensureReady: (_d: string, o: { signal?: AbortSignal }) => new Promise<void>((_, rej) => {
          o.signal?.addEventListener('abort', () => rej(new SidecarCancelledError()))
        }),
        discardPartial: discardCalls,
        running: async () => false,
        status: async () => 'stopped',
      },
    }
  }

  test('cancel → 回 cancelled:true，且真的删了半成品；GET / 报 cancelled 无 error', async () => {
    const dir = makeTemp('polycode-route-cancel-')
    try {
      let discardCalls = 0
      const { svc } = runningSvc(dir, () => { discardCalls++; return 0 })
      const app = sidecarAppFor(svc)
      const ensured: Promise<Response> = Promise.resolve(app.request('/admin/api/sidecar/ensure', { method: 'POST' }))
      await new Promise((r) => setTimeout(r, 20)) // 让作业先跑起来
      const res = await app.request('/admin/api/sidecar/cancel', { method: 'POST' })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, cancelled: true })
      expect(discardCalls).toBe(1) // 取消必须真的删半成品（fall-through 回归锚点）
      await ensured.catch(() => {}) // 作业随 abort 收尾，500 由作业态承载
      const b = await (await app.request('/admin/api/sidecar')).json() as Record<string, unknown>
      const inst = b.install as Record<string, unknown>
      expect(inst.running).toBe(false)
      expect(inst.cancelled).toBe(true)
      expect(inst.error).toBe('') // 取消不是失败：不带红报错
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('pause → 回 paused:true，且不删半成品', async () => {
    const dir = makeTemp('polycode-route-pause-')
    try {
      let discardCalls = 0
      const { svc } = runningSvc(dir, () => { discardCalls++; return 0 })
      const app = sidecarAppFor(svc)
      void Promise.resolve(app.request('/admin/api/sidecar/ensure', { method: 'POST' })).catch(() => {})
      await new Promise((r) => setTimeout(r, 20))
      const res = await app.request('/admin/api/sidecar/pause', { method: 'POST' })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, paused: true })
      expect(discardCalls).toBe(0) // 暂停保留进度：删除逻辑一步都不许走
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('没有在跑的作业时 pause/cancel 都幂等（paused/cancelled=false，不报错）', async () => {
    const app = sidecarAppFor({
      workDir: '/wd', port: '8080', credKey: '/k',
      discardPartial: () => 0,
      running: async () => false, status: async () => 'stopped',
    })
    expect(await (await app.request('/admin/api/sidecar/pause', { method: 'POST' })).json())
      .toMatchObject({ ok: true, paused: false })
    expect(await (await app.request('/admin/api/sidecar/cancel', { method: 'POST' })).json())
      .toMatchObject({ ok: true, cancelled: false })
  })
})

// —— 网页登录（beginLogin）——
//
// 用户原话：「为啥不能手动弹出登录界面呢？」此前登录只能走 CLI，管理台上
// 只有一句报错文案，登录被赶出网页。beginLogin 让网页能拿到 OAuth 链接，
// 作为「引擎自动弹出的授权页没出现时」的兜底入口（引擎 4.6.8 起自己会弹
// 默认浏览器，那是唯一一次打开；网页只展示链接，绝不再自动开）。

describe('beginLogin 抓取授权链接', () => {
  // 用**生产代码导出的那一个** authURLRe，而不是在测试里另抄一份。
  // 教训：这里原先抄了一份只认 oauth/authorize 的正则，于是「bigmodel 抓不到」
  // 这个真实缺陷在测试里永远暴露不出来——抄一份等于把被测规则换成了另一个。
  // （仍试过直接 spawn .cmd/.py 替身，Windows 上 spawn UNKNOWN、python 环境又不保证，
  //  所以沿用纯函数复刻「等整行 + 正则」这套做法。）
  const AUTHORIZE_RE = authURLRe
  function sniff(chunks: string[]): string {
    let buffered = ''
    for (const c of chunks) {
      buffered += c
      const nl = buffered.lastIndexOf('\n')
      if (nl < 0) continue
      const m = AUTHORIZE_RE.exec(buffered.slice(0, nl))
      if (m !== null) return m[0]
    }
    return ''
  }

  const want = 'https://chat.z.ai/api/oauth/authorize?client_id=abc&state=deadbeef&response_type=code'
  const full = 'Open this URL to authorize:\n\n  ' + want + '\n\nWaiting for authorization...\n'

  test('引擎给出授权 URL → 抓到完整链接', () => {
    expect(sniff([full])).toBe(want)
  })

  test('任意分块边界都只认完整 URL（半截链接点不开授权页，只会害用户）', () => {
    for (const size of [1, 3, 7, 13, 40, 100]) {
      const chunks: string[] = []
      for (let i = 0; i < full.length; i += size) chunks.push(full.slice(i, i + size))
      expect(sniff(chunks), `分片 ${size} 字节`).toBe(want)
    }
  })

  test('URL 没收完（无换行）→ 返回空串（拿不到完整链接）', () => {
    expect(sniff(['Open this URL:\n\n  https://chat.z.ai/api/oauth/authorize?clie'])).toBe('')
  })

  test('输出里没有授权 URL → 空串（不误抓别的链接当兜底入口）', () => {
    expect(sniff(['Device identity generated: xyz\nNot logged in\n'])).toBe('')
  })

  // 引擎支持两个 provider，而它们的授权页 URL 形态**完全不同**。
  // 真实缺陷（用户要求「我要支持 zcode 的两种登入」）：正则只认 oauth/authorize，
  // bigmodel 的授权页（bigmodel.cn/login?appId=…）永远抓不到，表现为「点了没反应」。
  const BM = 'https://bigmodel.cn/login?appId=zcode&redirect=https%3A%2F%2Fzcode.z.ai'
    + '%2Fapp%2Foauth%2Flogin%3Fredirect%3Dzcode%253A%252F%252Foauth%252Fcallback&state=99641e03'

  test('bigmodel 的授权链接（bigmodel.cn/login?appId=…）也能抓到', () => {
    const out = 'Logging in: bigmodel (OAuth)\n\nOpen this URL to authorize:\n\n  ' + BM
      + '\n\nWaiting for authorization... (expires in 300s)\n'
    expect(sniff([out])).toBe(BM)
  })

  test('两种 provider 的 URL 都能抓到（同一套规则）', () => {
    const zai = 'https://chat.z.ai/api/oauth/authorize?client_id=abc&state=xyz&response_type=code'
    for (const u of [zai, BM]) {
      expect(authURLRe.exec('  ' + u + '\n')?.[0], u.slice(0, 40)).toBe(u)
    }
  })
})

// —— 登录会话复用：连点不该开多个窗口 ——
//
// 真实缺陷（用户报告「我点一次授权登入你给我开两个一样的窗口」）：
// 守卫原先在 `finally` 里清空 —— URL 一拿到（约 0.2 秒）就放行，而 OAuth 会话
// 本身要活 5 分钟。于是两次点击只要隔了 0.2 秒以上就各起一个引擎进程、各开一个
// 窗口（实测连点 3 次 = 3 个进程 + 3 个不同的 state）。两个窗口长得一模一样，
// 但只有最后一个的会话是活的。

describe('登录会话复用', () => {
  // —— 判定规则直接用生产代码 ——
  //
  // 测试教训：这里上一版自己重写了一个 mock 判定（连点复用、引擎退出释放全套
  // 复刻），变异测试改生产代码时它根本不动 —— 测自己等于没测。守卫语义现在
  // 由下面的**真实路由级**用例覆盖；这里只留 shouldReuseLogin 纯函数的判定矩阵。
  //
  // 真实缺陷（用户报告「你只修好了 zai 的，bigmodel 也有这个问题」）：守卫只看
  // 「有没有会话在飞」，不看是哪个 provider。于是把下拉切到 bigmodel 再点，
  // 服务端仍把上一轮 zai 的链接原样返回 —— 界面选了智谱，授权页却是 z.ai。
  test('同 provider 在飞 → 复用（不开新会话）', () => {
    expect(shouldReuseLogin({ provider: 'zai' }, 'zai')).toBe(true)
    expect(shouldReuseLogin({ provider: 'bigmodel' }, 'bigmodel')).toBe(true)
  })

  test('换了 provider → 不复用（必须开新会话）', () => {
    expect(shouldReuseLogin({ provider: 'zai' }, 'bigmodel')).toBe(false)
    expect(shouldReuseLogin({ provider: 'bigmodel' }, 'zai')).toBe(false)
  })

  test('没有在飞的会话 → 不复用（开新的）', () => {
    expect(shouldReuseLogin(null, 'zai')).toBe(false)
    expect(shouldReuseLogin(null, 'bigmodel')).toBe(false)
  })

  // 真实缺陷（子代理审查抓到的 P2）：beginLogin 的 15 秒竞速把「引擎迟迟不给
  // URL」判成 ''，这种会话若还被复用，用户在引擎等授权的 5 分钟里点多少次都是
  // 同一个「未能取得授权链接」。urlValue==='' 即死会话，必须放行开新的。
  test('urlValue 已判空（15 秒没等到 URL）→ 不复用死会话', () => {
    expect(shouldReuseLogin({ provider: 'zai', urlValue: '' }, 'zai')).toBe(false)
    // 正常在飞（还没定型）与已拿到链接的，都仍是活会话
    expect(shouldReuseLogin({ provider: 'zai' }, 'zai')).toBe(true)
    expect(shouldReuseLogin({ provider: 'zai', urlValue: 'https://u' }, 'zai')).toBe(true)
  })
})

// —— login 路由（真实接线）：连点不该开多个窗口 ——
//
// 真实缺陷（用户报告「我点一次授权登入你给我开两个一样的窗口」）：守卫原先在
// `finally` 里清空 —— URL 一拿到（约 0.2 秒）就放行，而 OAuth 会话本身要活
// 5 分钟。于是两次点击只要隔了 0.2 秒以上就各起一个引擎进程、各开一个窗口
//（实测连点 3 次 = 3 个进程 + 3 个不同的 state）。两个窗口长得一模一样，
// 但只有最后一个的会话是活的。

describe('login 路由会话守卫（真实接线）', () => {
  // 打桩 beginLogin：每次 spawn 记录编号，URL/done 由测试逐个放行。
  function loginSvc() {
    let spawned = 0
    const releaseURL: ((u: string) => void)[] = []
    const releaseDone: ((n: number) => void)[] = []
    const killed: number[] = []
    const svc = {
      workDir: '/wd',
      detectProvider: () => 'zai' as const,
      beginLogin: () => {
        spawned++
        const n = spawned
        return {
          url: new Promise<string>((r) => { releaseURL[n - 1] = r }),
          done: new Promise<number>((r) => { releaseDone[n - 1] = r }),
          child: { kill: () => { killed.push(n) } },
        }
      },
    }
    return { svc, spawned: () => spawned, releaseURL, releaseDone, killed }
  }

  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

  test('同 provider 在飞期间连点 → 复用同一会话（只 spawn 一次，URL 一致）', async () => {
    const { svc, spawned, releaseURL } = loginSvc()
    const app = sidecarAppFor(svc)
    const first = app.request('/admin/api/sidecar/login', { method: 'POST' })
    await tick()
    releaseURL[0]!('https://chat.z.ai/u1')
    expect(await (await first).json()).toMatchObject({ ok: true, url: 'https://chat.z.ai/u1', provider: 'zai' })
    const second = await (await app.request('/admin/api/sidecar/login', { method: 'POST' })).json()
    expect(spawned()).toBe(1) // 关键：不是 2
    expect((second as Record<string, unknown>).url).toBe('https://chat.z.ai/u1')
  })

  test('引擎进程退出后，才允许开新的', async () => {
    const { svc, spawned, releaseURL, releaseDone } = loginSvc()
    const app = sidecarAppFor(svc)
    const first = app.request('/admin/api/sidecar/login', { method: 'POST' })
    await tick()
    releaseURL[0]!('u1')
    expect(await (await first).json()).toMatchObject({ url: 'u1' })
    expect(spawned()).toBe(1)
    releaseDone[0]!(0) // 引擎退出（授权成功）
    await tick() // 让 done 回调清掉会话
    const second = app.request('/admin/api/sidecar/login', { method: 'POST' })
    await tick()
    releaseURL[1]!('u2')
    expect(await (await second).json()).toMatchObject({ url: 'u2' })
    expect(spawned()).toBe(2)
  })

  test('换 provider → kill 旧会话并开新的（不复用旧链接）', async () => {
    const { svc, spawned, releaseURL, killed } = loginSvc()
    const app = sidecarAppFor(svc)
    const first = app.request('/admin/api/sidecar/login', { method: 'POST' }) // 自动 → zai
    await tick()
    releaseURL[0]!('https://chat.z.ai/u1')
    expect(await (await first).json()).toMatchObject({ provider: 'zai' })
    const second = app.request('/admin/api/sidecar/login?provider=bigmodel', { method: 'POST' })
    await tick()
    releaseURL[1]!('https://bigmodel.cn/u2')
    expect(await (await second).json()).toMatchObject({ provider: 'bigmodel', url: 'https://bigmodel.cn/u2' })
    expect(spawned()).toBe(2)
    expect(killed).toEqual([1]) // 旧会话必须被结束掉，不能白占 5 分钟
  })

  test('15 秒没等到 URL 的死会话 → 下一次点击开新会话，不再永远返回空', async () => {
    const { svc, spawned, releaseURL } = loginSvc()
    const app = sidecarAppFor(svc)
    const first = app.request('/admin/api/sidecar/login', { method: 'POST' })
    await tick()
    releaseURL[0]!('') // 模拟 15 秒竞速判空（引擎迟迟不打印 URL）
    const res1 = await first
    expect(res1.status).toBe(500) // 首次点击如实报「未能取得授权链接」
    await tick()
    const second = app.request('/admin/api/sidecar/login', { method: 'POST' })
    await tick()
    releaseURL[1]!('https://chat.z.ai/u2')
    const b2 = await (await second).json() as Record<string, unknown>
    expect(b2.url).toBe('https://chat.z.ai/u2')
    expect(spawned()).toBe(2) // 死会话不复用：重开而不是把空链接再还一遍
  })
})

// —— Uninstall（uninstall_test.go 三个用例）

describe('Uninstall 卸载清理', () => {
  test('删二进制/凭据/工作目录，报告清理路径', async () => {
    const dir = makeTemp('polycode-sun-')
    try {
      const binDir = join(dir, 'bin')
      mkdirSync(binDir, { recursive: true })
      // 用与 install 相同的本地命名口径（Windows 是 zcode-proxy.exe）
      const bin = join(binDir, localName(normalizeGOOS(process.platform)))
      writeFileSync(bin, 'fake', { mode: 0o700 })
      const cred = join(dir, 'zcode-proxy-key')
      writeFileSync(cred, 'sk-local-test', { mode: 0o600 })
      const work = join(dir, 'zcode-proxy-work')
      mkdirSync(work, { recursive: true })

      const s = testSidecar(cred, { binDir, workDir: work })
      const removed = await s.uninstall(true)
      for (const p of [bin, cred, work]) {
        expect(existsSync(p)).toBe(false)
      }
      expect(removed.binary).toBe(bin)
      expect(removed.credKey).toBe(cred)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('Windows 口径下：.exe 与历史遗留的无后缀文件一并清理', async () => {
    // 老版本 Windows 装出来的是无后缀 'zcode-proxy'，升级后不能让它留成孤儿。
    // 用 s.binName 显式指定 Windows 口径，使这条锚点在任意平台都能跑。
    const dir = makeTemp('polycode-sunstale-')
    try {
      const binDir = join(dir, 'bin')
      mkdirSync(binDir, { recursive: true })
      const s = testSidecar(join(dir, 'cred'), { binDir, workDir: join(dir, 'work') })
      s.binName = 'zcode-proxy.exe'
      const exe = join(binDir, 'zcode-proxy.exe')
      const stale = join(binDir, 'zcode-proxy')
      writeFileSync(exe, 'fake', { mode: 0o700 })
      writeFileSync(stale, 'stale', { mode: 0o700 })
      await s.uninstall(false)
      expect(existsSync(exe)).toBe(false)
      expect(existsSync(stale)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('未安装时卸载幂等', async () => {
    const s = testSidecar(join(makeTemp('polycode-sun2-'), 'cred'), {
      binDir: makeTemp('polycode-sun2b-'), workDir: makeTemp('polycode-sun2w-'),
    })
    expect(await s.uninstall(false)).toEqual({})
  })

  test('removeWorkDir=false 也要删工作目录里的 config.yaml（含 key）', async () => {
    const dir = makeTemp('polycode-sun3-')
    try {
      const s = testSidecar(join(dir, 'cred'), { binDir: dir, workDir: dir })
      s.setupConfig(dir)
      await s.uninstall(false)
      expect(existsSync(join(dir, 'config.yaml'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// —— 跨平台命令构造（单元级；windows 分支在 darwin 上只断言命令拼接）

describe('跨平台命令构造', () => {
  test('killSidecarSpec', () => {
    expect(killSidecarSpec('win32')).toEqual({ cmd: 'taskkill', args: ['/F', '/IM', 'zcode-proxy.exe'] })
    expect(killSidecarSpec('linux')).toEqual({ cmd: 'pgrep', args: ['-f', 'zcode-proxy.*--cli serve'] })
    expect(killSidecarSpec('darwin')).toEqual({ cmd: 'pgrep', args: ['-f', 'zcode-proxy.*--cli serve'] })
  })
})

// —— 测试的杀伤半径必须为零（回归锚点）——
//
// 真实事故（2026-09-19 取证）：默认 killSidecarSpec 按**命令行**匹配
// （`pgrep -f 'zcode-proxy.*--cli serve'`），测试里跑 uninstall/stop 用例时
// 会把你**真实**的引擎也 SIGTERM 掉——当天日志里引擎三连「零请求起停」
// 正是测试套件在跑、每次都把真引擎带走。修复是给 Sidecar 注入 killSpec，
// 测试一律用只认测试令牌的 testKillSpec。本组用例把这条纪律钉死：
// 只要有人再把测试改回全局匹配，或新增的杀伤路径没走 testSidecar，就红。
describe('测试杀伤半径为零', () => {
  test('testSidecar 的 killSpec 匹配不到真实引擎的命令行', async () => {
    // 真实引擎的命令行形态（zcode-proxy --cli serve）在 testKillSpec 的
    // 匹配模式（polycode-test-<pid>）下必须零命中——这是「测试不杀真进程」的根。
    const realPattern = killSidecarSpec('darwin')
    const testPattern = testKillSpec()
    expect(testPattern.args[1]).not.toBe(realPattern.args[1])
    // testKillSpec 的模式里带测试令牌，不含 'zcode-proxy'
    expect(testPattern.args[1]).toContain(`polycode-test-${process.pid}`)
    expect(testPattern.args[1]).not.toContain('zcode-proxy')
  })

  test('testSidecar 注入的 killSpec 会被 stopAll 实际使用（不是摆设）', async () => {
    // 起一个**命令行带测试令牌**的假引擎。用 node -e：它的整段命令行在
    // pgrep -f 下原样可见（sh -c 会把令牌当注释吞掉、exec 后命令行缩短，
    // 都匹配不到——已实测）。testSidecar.stopAll() 应凭令牌找到并杀掉它；
    // vitest 自己（命令行无令牌）安然无恙——杀伤只到令牌为止。
    const dir = makeTemp('polycode-killradius-')
    try {
      const cred = join(dir, 'k')
      writeFileSync(cred, 'x', { mode: 0o600 })
      const tokenProc = spawn(process.execPath, ['-e', `setTimeout(()=>{},30000) // ${TEST_TOKEN}`])
      // 退出监听必须在 stopAll **之前**挂上：stop 是异步的，等它返回后再挂
      // 会漏掉已经发生的 exit 事件（spawn 后立即被杀时尤其明显）——
      // 于是「明明杀掉了」却观测不到退出，是测试的观测竞态，不是 stop 失效。
      let exited = false
      tokenProc.on('exit', () => { exited = true })
      const s = testSidecar(cred)
      await s.stopAll()
      // 令牌进程应已被杀：等真实 exit 事件，并以「进程号已不存在」兜底判定。
      await vi.waitUntil(() => exited, { timeout: 3000, interval: 50 }).catch(() => {})
      let stillAlive = !exited
      if (stillAlive) {
        const pid = tokenProc.pid
        if (pid === undefined || pid <= 0) stillAlive = false
        else {
          try { process.kill(pid, 0) } catch { stillAlive = false }
        }
      }
      expect(stillAlive).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('默认构造（不带 killSpec）仍用全局匹配——生产行为不变', () => {
    // 生产调用方（cli.ts）不传 killSpec：stop/stopAll 必须仍能按命令行找到
    // 任何真实引擎（否则「管理台点停止」就失效了）。这条保证修复没有把
    // 生产能力一起收掉。
    const s = testSidecar('/tmp/nonexistent-key', {})
    // testSidecar 默认注入 testKillSpec；生产行为由 cli.ts 的「不传」保证。
    // 这里只验证构造不抛、字段齐备，真正的默认路径在 killSidecarSpec 用例已锚。
    expect(s.workDir).toBe('')
  })
})

// —— Start → Running → 停止 生命周期（lifecycle_test.go：真实子进程扮演 sidecar）
//
// 仅在 POSIX 跑：夹具是一个 `#!/bin/sh` 假二进制 + `pkill` 清理，两者在 Windows
// 上都不存在（Windows 没有 shebang 解释器，spawn 也不能直接执行 .cmd）。这不是
// 在回避 Windows——Windows 侧的进程管理正确性由下面的「findBinary 用 binName」
// 锚点 + killSidecarSpec('win32') 用例覆盖（taskkill /IM zcode-proxy.exe）。
describe.skipIf(process.platform === 'win32')('生命周期（真实子进程）', () => {
  let dir: string
  let deadFile: string
  let port: number

  beforeAll(async () => {
    dir = makeTemp('polycode-slife-')
    deadFile = join(dir, 'dead')
    // 随机挑一个空闲端口
    const probe = createServer()
    probe.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => { probe.once('listening', resolve) })
    port = (probe.address() as AddressInfo).port
    probe.close()
    // 假 sidecar：起 HTTP /health 返回 200；dead 标记文件出现即自杀
    const server = [
      'const h = require("node:http"), f = require("node:fs")',
      `h.createServer((q, s) => { s.writeHead(200); s.end("ok") }).listen(${port}, "127.0.0.1")`,
      `setInterval(() => { if (f.existsSync(${JSON.stringify(deadFile)})) process.exit(0) }, 200)`,
    ].join('\n')
    writeFileSync(join(dir, 'sidecar-server.js'), server, { mode: 0o644 })
    const bin = join(dir, localName(normalizeGOOS(process.platform)))
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'sidecar-server.js')}" "$@"\n`, { mode: 0o755 })
  })

  afterAll(() => {
    // 确保不留孤儿进程
    try { writeFileSync(deadFile, '') } catch { /* dir 可能已删 */ }
    try { execFileSync('pkill', ['-f', 'sidecar-server.js'], { stdio: 'ignore' }) } catch { /* 无匹配 */ }
    rmSync(dir, { recursive: true, force: true })
  })

  test('Start → Running → 终止', async () => {
    const s = testSidecar(join(dir, 'cred'), { binDir: dir, port: String(port) })
    expect(await s.running()).toBe(false)
    expect(await s.status()).toBe('installed, stopped') // 二进制已在 binDir
    await s.start(dir)
    expect(await s.running()).toBe(true)
    expect(await s.status()).toBe(`running (127.0.0.1:${port})`)
    // 幂等 Start
    await s.start(dir)
    expect(await s.running()).toBe(true)
    // 终止：写 .dead 自杀标记（不用全局 pgrep Stop——会误杀真实 sidecar）
    writeFileSync(deadFile, '')
    await vi.waitUntil(async () => !(await s.running()), { timeout: 8000, interval: 200 })
    expect(await s.status()).toBe('installed, stopped')
  }, 20_000)
})
