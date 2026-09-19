// POSIX 权限位断言（平台感知）。
//
// 为什么需要这个 helper：Node 的 chmod / writeFileSync({mode}) 在 Windows 的
// NTFS 上**不生效**——statSync 对任何文件都返回 0o666（十进制 438），所以
// `expect(statSync(p).mode & 0o777).toBe(0o600)` 在 Windows 上恒失败
// （报 `expected 438 to be 384`）。
//
// 这不是被保护对象的缺陷，而是断言本身假设了 POSIX 语义。凭据文件 0600 的
// 真正保证在 Windows 上要靠 ACL，不在 Node 可移植范围内，测试无法代验。
// 因此这里在 Windows 上跳过断言，但**保留 POSIX 上的严格校验**（CI 主战场），
// 而不是把断言放宽成永真。
//
// 用法：expectMode(file, 0o600)
import { statSync } from 'node:fs'
import { expect } from 'vitest'

// posixModeSupported 表示本平台是否能真实反映 POSIX 权限位。
export const posixModeSupported: boolean = process.platform !== 'win32'

// expectMode 断言文件权限位；Windows 上跳过（见文件头说明）。
export function expectMode(path: string, mode: number): void {
  if (!posixModeSupported) return
  expect(statSync(path).mode & 0o777).toBe(mode)
}
