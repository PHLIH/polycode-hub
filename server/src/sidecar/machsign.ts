// macOS 代码签名修复：官方 release 产物在本机跑不起来的一类故障。
//
// 现场（2026-09-26 取证，macOS 27.0 / MacBookPro18,3 / arm64）：
//   从 GitHub release 下载的 zcode-proxy（官方产物，sha256 与 release API 的
//   asset.digest **完全一致**，即内容未被篡改）在 exec 之后**立刻被 SIGKILL**，
//   连 --help 都不输出。DiagnosticReports 里的 .ips 给了确切死因：
//     exception   = EXC_BAD_ACCESS / "SIGKILL (Code Signature Invalid)"
//     termination = { namespace: "CODESIGNING", indicator: "Invalid Page" }
//   即**内容分页哈希与自带的 adhoc 签名不符**——内核在按签名逐页校验时判失败。
//   且不是 v4.7.0 引入的：v2.6.0 / v4.0.0 / v4.1.2 / v4.5.5 / v4.6.5 / v4.6.9 /
//   v4.7.0 全部同样被杀，而本机 bun 1.4.2 自己 `bun build --compile` 出来的
//   产物（同样是 linker-signed adhoc）能正常跑——问题出在上游 CI 用的
//   bun 1.4.0 打包出的签名与新版 macOS 的 codesigning 校验不兼容。
//
// 结论是「不能改上游」，只能在**下载落地后**自行修：用本机 codesign
// 重新做一份 adhoc 签名覆盖掉旧的。实测 `codesign --force --sign -` 之后
// v4.6.9 / v4.7.0 都能正常启动（`zcode-proxy 4.6.9` / `zcode-proxy 4.7.0`），
// 且对已修好的文件重复执行幂等（仍然 exiting 0）。
//
// 边界（刻意保守，因为这一步操作的是「即将被 chmod 0700 并 spawn 的可执行文件」）：
//   · **只在 darwin 上动手**。linux/windows 没有这套 codesigning 校验，
//     官方产物一直是能跑的；在别的平台调用 codesign 只会莫名失败。
//   · **只做 adhoc 签名**（`-` = 无身份）：不引入证书、不碰 entitlements、
//     不做 hardened runtime。这只影响「本机是否允许执行」，不影响上游能力。
//   · **失败不阻断安装**。重签失败时保留原文件与原有签名——用户至少还有个
//     明确报错可以看（"Killed: 9" 之外，启动路径上还有日志归因），
//     而因重签失败就直接拒绝安装会让本来能用的环境彻底装不上。
//   · **只在签名确实失效时才重签**：先 codesign --verify 探测，好的就不动。
//     这样避免每次安装都白跑一次 codesign，也避免把一份本来完好的签名换掉。

import { execFileSync } from 'node:child_process'

// macOS 专用：本模块只在 process.platform === 'darwin' 时被调用。
const PLATFORM = 'darwin'

// isDarwin 判断当前是否 macOS（重签只在该平台有意义，见文件头）。
export function isDarwin(): boolean {
  return process.platform === PLATFORM
}

// signatureOK 用 codesign --verify 探测一个 Mach-O 的 adhoc 签名是否被
// macOS 认可。返回 true 表示「签名有效，不用管」。
//
// 注意判定口径：坏签名时 codesign **退出码为 1** 但 stderr 仍会打印
// "invalid signature (code or signature have been modified)"，好签名时
// 退出码 0 且无输出。所以只看退出码即可，不去解析文案（文案随系统版本漂移）。
//
// 探测本身失败（codesign 不存在 / 文件不可读 / 不是 Mach-O）时返回 true——
// 即「不知道」时按「没问题」处理，交由后续实际执行去暴露真实故障。
// 反过来返回 false 会让每个非 Mach-O 文件都走一次重签，纯属噪音。
function signatureOK(binPath: string): boolean {
  try {
    execFileSync('codesign', ['--verify', binPath], { stdio: 'ignore' })
    return true
  } catch {
    // Exit code 1 = 签名确实无效（见文件头）；codesign 缺失/spawn 失败时
    // 也是非零退出，按「不动」处理更安全（见上方说明）。
    return false
  }
}

// resignAdhoc 给一个 Mach-O 可执行文件重新打 adhoc 签名（覆盖原有签名）。
// 返回是否发生了重签：true = 重签成功；false = 签名本来就有效，未改动。
//
// 重签失败**不抛异常**（调用方据此决定是否继续安装），但会把原因写进返回值
// 语义：这里用「已修正 / 未需要 / 修不了」三态表达，避免抛错把安装流程炸掉。
export type ResignResult = 'resigned' | 'already-valid' | 'failed'

// resignIfNeeded 探测并在必要时重签。非 darwin 平台一律返回 already-valid
// （无操作），见文件头关于「只在 macOS 上动手」的说明。
export function resignIfNeeded(binPath: string): ResignResult {
  if (!isDarwin()) return 'already-valid'
  if (signatureOK(binPath)) return 'already-valid'
  try {
    // --force 允许覆盖已有签名；`-` 表示 adhoc（无签名身份）。
    // stdio 全收：codesign 成功时也会有 "replacing existing signature" 这类
    // 提示打到 stderr，任由它泄漏会污染安装日志。
    execFileSync('codesign', ['--force', '--sign', '-', binPath], { stdio: 'ignore' })
    return 'resigned'
  } catch {
    return 'failed'
  }
}
