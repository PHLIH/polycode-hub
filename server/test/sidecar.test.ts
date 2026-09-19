// 移植锚点：internal/sidecar/sidecar_test.go / uninstall_test.go / lifecycle_test.go
// 测试绝不依赖真实网络下载：Install 用注入 fetch 替身；生命周期用本地假二进制。

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
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
  validatePort,
} from '../src/sidecar/sidecar.ts'
import type { SidecarProgress } from '../src/sidecar/sidecar.ts'
import { partPath } from '../src/sidecar/sidecar.ts'
import { parseScutilProxy, normalizeProxyURI, maskProxyURI, egressDefToProxyURI, resolveSidecarDownloadFetch, parseWinProxySetting } from '../src/sidecar/httpproxy.ts'

const makeTemp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

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
      const s = new Sidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
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
      const s = new Sidecar(join(dir, 'credentials', 'zcode-proxy-key'), { dataDir: dir })
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
      const s2 = new Sidecar(join(dir, 'c2'))
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
    const s = new Sidecar(join(makeTemp('polycode-off-'), 'k'), { port: '1' })
    expect(await s.running()).toBe(false)
  })
})

// —— SetPort / LoadPort / ValidatePort（sidecar_test.go TestSetPort / TestLoadPort）

describe('SetPort / LoadPort', () => {
  test('改写 port 行且 key 保留；非法端口拒绝且配置不动', () => {
    const dir = makeTemp('polycode-sport-')
    try {
      const s = new Sidecar(join(dir, 'credentials', 'zcode-proxy-key'))
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
      const s = new Sidecar(join(dir, 'credentials', 'zcode-proxy-key'))
      s.setupConfig(join(dir, 'sidecar'))
      s.setPort(join(dir, 'sidecar'), '9090')
      const fresh = new Sidecar(join(dir, 'credentials', 'zcode-proxy-key'))
      expect(fresh.port).toBe('8080')
      fresh.loadPort(join(dir, 'sidecar'))
      expect(fresh.port).toBe('9090')
      const fresh2 = new Sidecar(join(dir, 'c3'))
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
      const s = new Sidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
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
    const s = new Sidecar(join(makeTemp('polycode-sinst2-'), 'cred'), { binDir: makeTemp('polycode-sinst2b-') })
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
      const s = new Sidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      const f = async (url: string | URL | Request): Promise<Response> =>
        String(url).includes('api.github.com') ? jsonFetch(body)() : binFetch()()
      await expect(s.install(false, { fetch: f, goos: 'darwin', arch: 'arm64' }))
        .resolves.toBe(join(dir, 'bin', 'zcode-proxy'))

      // 摘要对不上 → 必须拒绝，且不落地
      const bad = { ...body, assets: [{ ...body.assets[0]!, digest: 'sha256:' + 'de'.repeat(32) }] }
      const dir2 = makeTemp('polycode-sdig2-')
      const s2 = new Sidecar(join(dir2, 'cred'), { binDir: join(dir2, 'bin') })
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
      const s = new Sidecar(join(dir, 'cred'), { binDir: dir })
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
      const s = new Sidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
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
      const s = new Sidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
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
      const s = new Sidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
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
      const s = new Sidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
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
      const s = new Sidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
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
      const s = new Sidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
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
      const s = new Sidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
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
  const releaseBody = {
    tag_name: 'v9.9.9',
    assets: [
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
      const s = new Sidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      const { fetch: f, seenRanges } = flakyFetch()
      const dest = await s.install(false, {
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
      const s = new Sidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      const { fetch: f } = flakyFetch()
      const seen: SidecarProgress[] = []
      await s.install(false, { fetch: f as never, sleep: async () => {}, onProgress: (p) => seen.push(p) })
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
      const s = new Sidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
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
      const dest = await s.install(false, { fetch: f as never, sleep: async () => {} })
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
      const s = new Sidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
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
      const dest = await s.install(false, { fetch: f as never, sleep: async () => {} })
      expect(Buffer.compare(readFileSync(dest), full)).toBe(0)
      // 100 字节 / 每轮 40 → 3 轮足够；空转的话会一路试到上限 60
      expect(rounds).toBeLessThanOrEqual(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('4xx 不重试：资产被删/被限流重试也只是再错一次', async () => {    const dir = makeTemp('polycode-sres4-')
    try {
      const s = new Sidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      let dlCalls = 0
      const f = async (url: string | URL | Request): Promise<Response> => {
        if (String(url).includes('api.github.com')) {
          return new Response(JSON.stringify(releaseBody), { status: 200 })
        }
        dlCalls++
        return new Response('denied', { status: 404 })
      }
      await expect(s.install(false, { fetch: f as never, sleep: async () => {} }))
        .rejects.toThrow(/http 404/)
      expect(dlCalls).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

      const s = new Sidecar(cred, { binDir, workDir: work })
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
      const s = new Sidecar(join(dir, 'cred'), { binDir, workDir: join(dir, 'work') })
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
    const s = new Sidecar(join(makeTemp('polycode-sun2-'), 'cred'), {
      binDir: makeTemp('polycode-sun2b-'), workDir: makeTemp('polycode-sun2w-'),
    })
    expect(await s.uninstall(false)).toEqual({})
  })

  test('removeWorkDir=false 也要删工作目录里的 config.yaml（含 key）', async () => {
    const dir = makeTemp('polycode-sun3-')
    try {
      const s = new Sidecar(join(dir, 'cred'), { binDir: dir, workDir: dir })
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
    const s = new Sidecar(join(dir, 'cred'), { binDir: dir, port: String(port) })
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
