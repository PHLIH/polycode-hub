// 凭据落盘权限（0600）的行为锚定。
//
// 为什么值得单独测：writeFileSync 的 mode 只对**新建**文件生效，文件已存在时
// 被忽略——实测覆写一个 0644 的文件，写完仍是 0644。而"落盘即 0600"是
// 凭据安全红线，已存在的旧文件（首次导入写过、用户从别处拷来、旧版本留下的）
// 恰恰最容易被同机其他用户读走。writeFile0600 必须显式 chmod 收紧，
// 这条测试盯着的就是这个"覆写不收紧"的静默漏洞。

import { describe, expect, test } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile0600 } from '../src/adminapi/credential_file.ts'

function mode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8)
}

describe('writeFile0600 凭据落盘权限', () => {
  test('新建文件 → 0600，父目录 0700', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polycode-cred-'))
    try {
      const p = join(dir, 'sub', 'cred.jwt')
      writeFile0600(p, 'secret')
      expect(mode(p)).toBe('600')
      expect(mode(join(dir, 'sub'))).toBe('700')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 核心：覆写已存在且权限过宽的文件，必须收紧回 0600。
  test('覆写已存在的 0644 文件 → 收紧为 0600（mode 参数在这里无效）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polycode-cred2-'))
    try {
      const p = join(dir, 'cred.jwt')
      mkdirSync(dir, { recursive: true })
      writeFileSync(p, 'old', { mode: 0o644 })
      expect(mode(p)).toBe('644') // 前置：确认起点是过宽的
      writeFile0600(p, 'new-secret')
      expect(mode(p)).toBe('600') // 修复前这里是 644（静默漏洞）
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('覆写已存在的过宽目录 → 收紧为 0700', () => {
    const dir = mkdtempSync(join(tmpdir(), 'polycode-cred3-'))
    try {
      const sub = join(dir, 'creds')
      mkdirSync(sub, { recursive: true })
      chmodSync(sub, 0o755)
      expect(mode(sub)).toBe('755')
      writeFile0600(join(sub, 'k'), 'x')
      expect(mode(sub)).toBe('700')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
