// 凭据落盘的唯一实现。
//
// 0600 是安全红线（凭据不落明文、落盘即受保护），所以这条规则只允许有一处实现——
// 曾经 api.ts 与 discover_api.ts 各抄了一份逐字节相同的 writeFile0600，
// 任何安全加固（如改用 O_EXCL、加审计日志）都得记得改两遍，迟早漏一处。
//
// 目录用 0700：凭据目录不该让同机其他用户列出文件名。

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function writeFile0600(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, content, { mode: 0o600 })
  // 必须补这一步：writeFileSync 的 mode **只对新建文件生效**——文件已存在时忽略。
  // 实测：覆写一个已是 0644 的文件，写完权限仍是 0644。
  // 而"落盘即 0600"是凭据安全红线，已存在的旧文件恰恰最容易被拷走/改坏，
  // 静默放过等于承诺落空。显式 chmod 收紧（目录同理：mkdir 的 mode 也对
  // 已存在目录无效）。
  try {
    chmodSync(path, 0o600)
    chmodSync(dirname(path), 0o700)
  } catch {
    // 收不紧也不该让整次导入失败：内容已落盘，这里只影响同机其他用户的可读性。
    // 但静默吞掉会让人以为收紧了——留一条 warn，便于事后排查。
    console.warn(`凭据文件权限收紧失败，请手动检查 ${path} 是否为 0600`)
  }
}
