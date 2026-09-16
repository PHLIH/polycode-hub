// 移植锚点：internal/sidecar/sidecar_test.go / uninstall_test.go / lifecycle_test.go
// 测试绝不依赖真实网络下载：Install 用注入 fetch 替身；生命周期用本地假二进制。

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import {
  Sidecar,
  assetName,
  checkDownloadURL,
  killSidecarSpec,
  latestRelease,
  sha256Hex,
  validatePort,
} from '../src/sidecar/sidecar.ts'
import { parseScutilProxy } from '../src/sidecar/httpproxy.ts'

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
      expect(statSync(s.credKey).mode & 0o777).toBe(0o600)
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
      expect(statSync(dest).mode & 0o777).toBe(0o700)
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
    await expect(s.install(false, { fetch: jsonFetch(releaseBody), goos: 'windows', arch: 'x64' }))
      .resolves.toBe(join(s.binDir, 'zcode-proxy'))
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
  test('下载失败重试 3 次后报错', async () => {
    const dir = makeTemp('polycode-sready-')
    try {
      const s = new Sidecar(join(dir, 'cred'), { binDir: join(dir, 'bin') })
      let calls = 0
      const f = async (): Promise<Response> => { calls++; return new Response('nope', { status: 500 }) }
      let sleeps = 0
      await expect(s.ensureReady(join(dir, 'sidecar'), { fetch: f, sleep: async () => { sleeps++ } }))
        .rejects.toThrow()
      expect(calls).toBe(3)
      expect(sleeps).toBe(3)
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
      const bin = join(binDir, 'zcode-proxy')
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

describe('生命周期（真实子进程）', () => {
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
    const bin = join(dir, 'zcode-proxy')
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
