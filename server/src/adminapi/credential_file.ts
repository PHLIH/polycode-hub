// 凭据落盘的唯一实现。
//
// 0600 是安全红线（凭据不落明文、落盘即受保护），所以这条规则只允许有一处实现——
// 曾经 api.ts 与 discover_api.ts 各抄了一份逐字节相同的 writeFile0600，
// 任何安全加固（如改用 O_EXCL、加审计日志）都得记得改两遍，迟早漏一处。
//
// 目录用 0700：凭据目录不该让同机其他用户列出文件名。

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function writeFile0600(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, content, { mode: 0o600 })
}
