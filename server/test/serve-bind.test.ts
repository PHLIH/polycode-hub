// 网关绑定端口的失败路径：必须「起不来就说人话」，不能留原始栈。
//
// 真实故障（2026-09-19 现场）：自我重启/update.sh/管理台「启动」并发时，旧进程
// 还没释放 port，新进程撞上 EADDRINUSE。旧实现先打印「polycode-hub 已启动」
// 再让 Node 抛未处理的 'error' 事件——日志里落下 18 次 `node:events:497 throw er`
// 原始栈，用户看到的是内部栈而不是「端口被谁占了、怎么办」，而且因为「已启动」
// 已经打出来了，健康检查还会以为起成功了（同 update.sh 记过的「报成功但跑旧代码」）。
//
// 这里起**真实子进程**跑真实 cli.ts serve：只有真起进程才能验证
// 「进程退出码 + stderr 文案 + 不出现原始栈」这三件事，打桩做不到。

import { describe, expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dirname, '..', '..', 'bin', 'polycode-hub.mjs')

// 拿一个空闲端口并**保持占用**：用真实的监听套接字占住它，制造 EADDRINUSE。
async function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const srv = createServer()
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const port = (srv.address() as { port: number }).port
  return {
    port,
    release: () => new Promise<void>((resolve) => { srv.close(() => resolve()) }),
  }
}

interface RunResult { code: number | null; stdout: string; stderr: string }

// 起一个真实网关子进程并等它退出（端口被占时它会很快自己退掉）。
// 走 bin/polycode-hub.mjs（与 launchd/update.sh 同一条入口）：它自己注册 tsx 加载器，
// 直接 node cli.ts 会 ERR_MODULE_NOT_FOUND，测的就不是真实启动路径了。
//
// 端口用 `--port` 显式指定（cli 只认 --port 与配置文件，不看 POLYCODE_PORT——
// 那是 update.sh 自己的变量），并给一个独立的 cwd，避免碰到真实 config/apps.yaml
// 里那个正在服务本机流量的 3000 端口。
function runServe(port: number, dir: string, timeoutMs = 20_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port)], {
      cwd: dir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += String(d) })
    child.stderr.on('data', (d) => { stderr += String(d) })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`serve 子进程 ${timeoutMs}ms 未退出（端口被占时应立即失败）`))
    }, timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

describe('网关绑定失败路径（真实子进程）', () => {
  test('端口被占：非零退出 + 人话提示，且不出现未处理 error 的原始栈', async () => {
    const home = mkdtempSync(join(tmpdir(), 'polycode-bind-'))
    const { port, release } = await occupyPort()
    try {
      const r = await runServe(port, home)
      // ① 必须失败退出（旧实现是抛栈崩溃，退出码 1 但日志是原始栈）
      expect(r.code).not.toBe(0)
      const err = r.stderr
      // ② 必须是人话：点明端口被占 + 给出可照做的下一步
      expect(err).toContain('已被占用')
      expect(err).toContain(String(port))
      expect(err).toMatch(/lsof -tiTCP:/)
      // ③ 原始栈必须消失（这正是用户实际看到的那一坨）
      expect(err).not.toContain('Unhandled')
      expect(err).not.toContain("throw er; // Unhandled 'error' event")
      expect(err).not.toContain('at Server.setupListenHandle')
      // ④ 关键回归：没绑上就绝不能报「已启动」，否则健康检查会误判成功
      expect(r.stdout).not.toContain('已启动')
    } finally {
      await release()
      rmSync(home, { recursive: true, force: true })
    }
  }, 40_000)
})
