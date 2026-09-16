// sidecar 管理面的后端接线：把 sidecar 包暴露为 /admin/api/sidecar/*（薄适配，
// 对齐 Go internal/adminapi/sidecar_api.go）。以 Hono 子应用注入 createAdminApi。

import { existsSync, statSync } from 'node:fs'
import { Hono, type Context } from 'hono'
import { validatePort, type Sidecar } from '../sidecar/sidecar.ts'

// sidecar 只关心「zcode-plan-local」这一个 Provider 的 baseUrl，
// 按对外名查（名字比内部 id 更适合这类固定目标）。
export interface SidecarStoreAdapter {
  getByName(name: string): { baseUrl?: string } | undefined
  put(p: { baseUrl?: string }): void
}

function err(c: Context, status: 400 | 404 | 500, msg: string): Response {
  return c.json({ error: { type: status === 404 ? 'not_found_error' : status === 400 ? 'invalid_request_error' : 'api_error', message: msg } }, status)
}

// isLoopbackHost：自定义引擎地址只允许指向本机。
function isLoopbackHost(host: string): boolean {
  if (host === 'localhost') return true
  // 仅识别 IPv4/IPv6 回环字面量（127./::1，Go net.ParseIP + IsLoopback 的常见子集）
  return /^(127\.|::1$)/.test(host)
}

function sidecarInstalled(s: Sidecar): boolean {
  for (const dir of [s.workDir, s.binDir]) {
    const p = `${dir}/zcode-proxy`.replace(/\/+/g, '/')
    try {
      if (statSync(p).size > 0) return true
    } catch { /* 不存在 */ }
  }
  return false
}

export function createSidecarApp(
  svc: Sidecar,
  providers: SidecarStoreAdapter,
  changed: () => void,
  fetchImpl: typeof fetch = fetch,
): Hono {
  const app = new Hono()
  const dir = () => svc.workDir

  // GET / → 状态 + 安装/配置信息。
  app.get('/', async (c) => {
    const endpoint = providers.getByName('zcode-plan-local')?.baseUrl ?? ''
    const builtin = `http://127.0.0.1:${svc.port}`
    return c.json({
      running: await svc.running(),
      status: await svc.status(),
      installed: sidecarInstalled(svc),
      port: svc.port,
      workDir: dir(),
      credFile: svc.credKey,
      hasKey: existsSync(svc.credKey),
      endpoint,
      custom: endpoint !== '' && endpoint !== builtin,
    })
  })

  // POST /{action} → start|stop|setup|uninstall|ensure|port|endpoint。
  // install 与 login 涉及交互/长下载，仍走 CLI（页面上给指引），不进 HTTP。
  app.post('/:action', async (c) => {
    const action = c.req.param('action')
    switch (action) {
      case 'start':
        try { await svc.start(dir()) } catch (e) { return err(c, 500, '启动失败: ' + (e as Error).message) }
        return c.json({ ok: true, status: await svc.status() })
      case 'stop':
        try { await svc.stop() } catch (e) { return err(c, 500, '停止失败: ' + (e as Error).message) }
        return c.json({ ok: true, status: await svc.status() })
      case 'setup': {
        let key: string
        try { key = svc.setupConfig(dir()) } catch (e) { return err(c, 500, '配置失败: ' + (e as Error).message) }
        // key 不回显全文（凭据红线）：只告知前缀
        return c.json({ ok: true,
          message: '已生成安全配置与随机 key（落 config/credentials/zcode-proxy-key，0600）',
          keyPrefix: key.slice(0, 12) + '…' })
      }
      case 'uninstall': {
        // 危险操作：必须显式确认 + 是否连工作目录（config/日志）一起清
        if (c.req.query('confirm') !== 'true') {
          return err(c, 400, '卸载需确认：加 ?confirm=true（可选 &removeWorkDir=true 连配置/日志一起清）')
        }
        try {
          const removed = await svc.uninstall(c.req.query('removeWorkDir') === 'true')
          return c.json({ ok: true, removed })
        } catch (e) {
          return err(c, 500, '卸载失败: ' + (e as Error).message)
        }
      }
      case 'ensure':
        // ensure 需要下载二进制（可能耗时），宽限 5 分钟
        try {
          await svc.ensureReady(dir())
          return c.json({ ok: true, status: await svc.status() })
        } catch (e) {
          return err(c, 500, '就绪失败: ' + (e as Error).message)
        }
      case 'port': {
        // 手动改 sidecar 监听端口。顺序关键：Running()/Stop() 必须在 SetPort 之前。
        const body = await c.req.json().catch(() => undefined) as { port?: string } | undefined
        const port = body?.port
        if (!port) return err(c, 400, '请求体须为 {"port":"9090"}')
        try {
          validatePort(port)
        } catch (e) {
          return err(c, 400, (e as Error).message)
        }
        let restarted = false
        if (await svc.running()) {
          try {
            await svc.stop()
            svc.setPort(dir(), port)
            await svc.start(dir())
          } catch (e) {
            return err(c, 500, `端口已写入但引擎重启失败（可点「启动」重试）: ${(e as Error).message}`)
          }
          restarted = true
        } else {
          try {
            svc.setPort(dir(), port)
          } catch (e) {
            return err(c, 400, (e as Error).message)
          }
        }
        const p = providers.getByName('zcode-plan-local')
        if (p && p.baseUrl !== `http://127.0.0.1:${port}`) {
          providers.put({ ...p, baseUrl: `http://127.0.0.1:${port}` })
          changed()
        }
        return c.json({ ok: true, port, restarted })
      }
      case 'endpoint': {
        // 自定义/兜底引擎地址：只改 provider baseUrl，不碰引擎进程；test=true 仅探活。
        const body = await c.req.json().catch(() => undefined) as
          { url?: string; test?: boolean; builtin?: boolean } | undefined
        if (!body) return err(c, 400, '请求体须为 {"url":"http://127.0.0.1:8080"}')
        let url = body.url ?? ''
        let test = body.test === true
        if (body.builtin) {
          url = `http://127.0.0.1:${svc.port}`
          test = false
        }
        let host: string
        try {
          const u = new URL(url)
          if (u.protocol !== 'http:' || u.hostname === '') throw new Error('bad')
          host = u.hostname
        } catch {
          return err(c, 400, '地址须为 http://127.0.0.1:端口 或 http://localhost:端口（免费凭据不允许指向公网）')
        }
        if (!isLoopbackHost(host)) {
          return err(c, 400, '地址须为 http://127.0.0.1:端口 或 http://localhost:端口（免费凭据不允许指向公网）')
        }
        if (test) {
          let alive = false
          try {
            const res = await fetchImpl(url.replace(/\/+$/, '') + '/health', { signal: AbortSignal.timeout(3000) })
            alive = res.status > 0
          } catch { alive = false }
          return c.json({ ok: alive, url })
        }
        const p = providers.getByName('zcode-plan-local')
        if (!p) return err(c, 404, 'provider zcode-plan-local 不存在')
        providers.put({ ...p, baseUrl: url.replace(/\/+$/, '') })
        changed()
        return c.json({ ok: true, url: url.replace(/\/+$/, '') })
      }
      default:
        return err(c, 404, '未知动作 ' + action +
          '（支持: start|stop|setup|ensure；install/login 走 CLI: polycode-hub zcode sidecar …）')
    }
  })

  return app
}
