// macOS 代码签名修复的测试。
//
// 这些用例锁住的行为（对应 machsign.ts 的取证结论）：
//   1. darwin 上，签名无效的 Mach-O 会被重签，且重签后 codesign --verify 通过；
//   2. 签名本来就有效的**不动**（避免每次安装都白跑一次 codesign）；
//   3. 非 darwin 平台一律无操作；
//   4. 重签幂等——修好的文件再修一次仍然是 valid，不会越修越坏。
//
// 只在 darwin 上跑：codesign 是 macOS 专有工具，其余平台没有这个故障形态
// （官方 release 在 linux/windows 上一直是能跑的），跳过而非假造。

import { describe, expect, test, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resignIfNeeded, isDarwin } from '../src/sidecar/machsign.ts'

const isMac = process.platform === 'darwin'

// verifyOK 直接问 codesign：退出码 0 = 签名被 macOS 认可，1 = 不认可。
function verifyOK(path: string): boolean {
  try {
    execFileSync('codesign', ['--verify', path], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// 造一个「签名坏了」的 Mach-O：拿一份真实的、本机 bun 编译产物，写坏它的
// 代码分页内容但**不动签名区**——这正是上游官方 release 的故障形态
// （内容与签名不一致，exec 时内核逐页校验失败 → SIGKILL）。
//
// 为什么不用 zcode-proxy 真产物做 fixture：66MB，且要靠网络下载；
// 这里只需要「Mach-O + 有效签名 + 内容被改」这三件事。
function makeCorruptedMachO(): string {
  const dir = mkdtempSync(join(tmpdir(), 'polycode-msign-'))
  const bin = join(dir, 'corrupt')
  // 从本机 bun 编译一个最小 Mach-O（elf 不含代码签名，bun 产物才带）。
  // bun 在 ~/.bun/bin/bun（本机已装）；不存在则跳过造样本，由调用方处理。
  const bun = process.env.HOME + '/.bun/bin/bun'
  const src = join(dir, 'a.ts')
  writeFileSync(src, 'console.log("ok")\n')
  execFileSync(bun, ['build', '--compile', '--target', 'bun-darwin-arm64', src, '--outfile', bin], { stdio: 'ignore' })
  expect(verifyOK(bin)).toBe(true) // 前提：新编译的产物签名有效
  // 往 Mach-O 的 __TEXT 段中部写垃圾：破坏分页哈希，但保留签名区与文件长度
  //（长度变化会让 LC_CODE_SIGNATURE 的 dataoff/vmsize 错位，形态不真实）。
  const buf = readFileSync(bin)
  const mid = Math.floor(buf.length / 2)
  for (let i = mid; i < mid + 512 && i < buf.length; i++) buf[i] = 0x5a
  writeFileSync(bin, buf, { mode: 0o755 })
  return bin
}

describe.skipIf(!isMac)('machsign：macOS 代码签名修复', () => {
  const made: string[] = []

  afterEach(() => {
    for (const p of made.splice(0)) {
      try { rmSync(join(p, '..'), { recursive: true, force: true }) } catch { /* 已清 */ }
    }
  })

  test('isDarwin 与平台一致', () => {
    expect(isDarwin()).toBe(true)
  })

  test('签名损坏的 Mach-O → 重签后 codesign --verify 通过', () => {
    const bin = makeCorruptedMachO()
    made.push(bin)
    expect(verifyOK(bin)).toBe(false) // 前提确认：样本确实是坏的

    const r = resignIfNeeded(bin)
    expect(r).toBe('resigned')
    // 关键断言：修完之后 codesign 认它。这正是「能否在本机 exec」的凭据。
    expect(verifyOK(bin)).toBe(true)
  }, 60_000)

  test('签名本就有效 → 不动（already-valid），不重复跑 codesign', () => {
    const bin = makeCorruptedMachO()
    made.push(bin)
    // 先修好
    expect(resignIfNeeded(bin)).toBe('resigned')
    // 再修一次必须是 already-valid：既幂等，也说明不会把好签名反复换掉
    expect(resignIfNeeded(bin)).toBe('already-valid')
    expect(verifyOK(bin)).toBe(true)
  }, 60_000)

  test('重签后仍可执行（exec 不再被 SIGKILL）', () => {
    const bin = makeCorruptedMachO()
    made.push(bin)
    expect(resignIfNeeded(bin)).toBe('resigned')
    // 直接 exec：坏签名时这一步是被内核 SIGKILL（退出码 137），修好后退出 0。
    const out = execFileSync(bin, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    expect(out).toContain('ok')
  }, 60_000)
})

describe.skipIf(isMac)('machsign：非 macOS 平台', () => {
  test('isDarwin 为 false，resignIfNeeded 一律无操作', () => {
    expect(isDarwin()).toBe(false)
    // 不该去调 codesign（不存在），也不能因它 failures 影响安装。
    expect(resignIfNeeded('/nonexistent/path')).toBe('already-valid')
  })
})
