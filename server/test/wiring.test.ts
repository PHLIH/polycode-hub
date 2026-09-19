import { describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createSidecarApp } from '../src/adminapi/sidecar_app.ts'
import { createProjectsApp } from '../src/adminapi/projects_app.ts'
import type { Manager } from '../src/projects/manager.ts'

// ---- sidecar 适配器（打桩 Sidecar 形状）----

function stubSidecar(over: Record<string, unknown> = {}) {
  return {
    port: '8080',
    workDir: '/wd',
    credKey: '/cred',
    running: async () => false,
    status: async () => 'stopped',
    start: async () => {},
    stop: async () => {},
    setupConfig: () => 'sk-local-abcdefghij0123456789',
    setPort: () => {},
    ensureReady: async () => {},
    uninstall: async () => ({ binary: true, config: false }),
    ...over,
  }
}

// sidecar 只关心 zcode-plan-local 这一个 Provider，按对外名查（见 SidecarStoreAdapter）。
function sidecarHarness(svc = stubSidecar(), providers?: { getByName: (name: string) => unknown; put: (p: unknown) => void }) {
  const store = providers ?? {
    getByName: (name: string) => name === 'zcode-plan-local'
      ? { providerId: 1, name, baseUrl: 'http://127.0.0.1:8080' } : undefined,
    put: () => {},
  }
  const app = new Hono()
  app.route('/admin/api/sidecar', createSidecarApp(svc as never, store as never, () => {}))
  return app
}

describe('sidecar 适配器（对齐 Go adminapi/sidecar_api.go）', () => {
  test('GET / → 状态 + 安装信息 + endpoint 标注', async () => {
    const res = await sidecarHarness().request('/admin/api/sidecar')
    const b = await res.json() as Record<string, unknown>
    expect(res.status).toBe(200)
    expect(b.running).toBe(false)
    expect(b.port).toBe('8080')
    expect(b.endpoint).toBe('http://127.0.0.1:8080')
    expect(b.custom).toBe(false) // endpoint == builtin
  })

  test('GET / → 回显下载代理（复用 egress 配置，脱敏）', async () => {
    // 项目 egress 表里只有 clash 一项 → 自动采用（不写死地址，来自项目配置）
    const app = new Hono()
    app.route('/admin/api/sidecar', createSidecarApp(
      stubSidecar() as never,
      { getByName: () => undefined, put: () => {} } as never,
      () => {}, fetch, { list: () => [{ id: 'clash', kind: 'http', addr: '127.0.0.1:7897' }] }))
    const b = await (await app.request('/admin/api/sidecar')).json() as Record<string, unknown>
    expect(b.downloadProxy).toBe('http://127.0.0.1:7897')
    expect(b.downloadProxySource).toBe('egress-auto:clash')
  })

  test('POST ensure → 下载 fetch 走项目 egress 代理（回归锚点）', async () => {
    // 这是本次真实缺陷的锚点：管理台「一键安装」以前用全局 fetch 直连，
    // 国内网络下 66MB 的 github release 必然超时，页面永远转「安装中…」。
    // 断言：传给 ensureReady 的 fetch 必须是「经 egress 代理」的那个，
    // 且代理解析不出来时绝不静默直连（这里代理来自项目 egress 表）。
    let seenFetch: unknown
    const svc = stubSidecar({
      ensureReady: async (_dir: string, opts: { fetch?: unknown } = {}) => { seenFetch = opts.fetch },
    })
    const app = new Hono()
    app.route('/admin/api/sidecar', createSidecarApp(
      svc as never,
      { getByName: () => undefined, put: () => {} } as never,
      () => {}, fetch, { list: () => [{ id: 'clash', kind: 'http', addr: '127.0.0.1:7897' }] }))
    const res = await app.request('/admin/api/sidecar/ensure', { method: 'POST' })
    expect(res.status).toBe(200)
    const b = await res.json() as Record<string, unknown>
    expect(b.downloadProxy).toBe('http://127.0.0.1:7897')
    expect(b.downloadProxySource).toBe('egress-auto:clash')
    // 关键：注入的是代理 fetch（不是全局 fetch 本身）
    expect(seenFetch).toBeTypeOf('function')
    expect(seenFetch).not.toBe(fetch)
  })

  test('POST ensure?egress=<id>：显式指定出口；不存在 → 400 点名', async () => {
    let seenFetch: unknown
    const svc = stubSidecar({
      ensureReady: async (_dir: string, opts: { fetch?: unknown } = {}) => { seenFetch = opts.fetch },
    })
    const app = new Hono()
    app.route('/admin/api/sidecar', createSidecarApp(
      svc as never,
      { getByName: () => undefined, put: () => {} } as never,
      () => {}, fetch, {
        list: () => [
          { id: 'clash', kind: 'http', addr: '127.0.0.1:7897' },
          { id: 'corp', kind: 'http', addr: '10.0.0.9:8888' },
        ],
      }))
    // 多项时默认不猜 → 直连；显式指定才走对应出口
    const ok = await app.request('/admin/api/sidecar/ensure?egress=corp', { method: 'POST' })
    expect(ok.status).toBe(200)
    const b = await ok.json() as Record<string, unknown>
    expect(b.downloadProxy).toBe('http://10.0.0.9:8888')
    expect(b.downloadProxySource).toBe('egress:corp')
    expect(seenFetch).not.toBe(fetch)
    // 不存在的 id → 400（不静默换出口）
    const bad = await app.request('/admin/api/sidecar/ensure?egress=ghost', { method: 'POST' })
    expect(bad.status).toBe(400)
    expect((await bad.json() as { error: { message: string } }).error.message).toContain('egress "ghost" 不存在')
  })

  test('POST ensure 失败 → 500 带上下载代理与来源（可解释的报错）', async () => {
    const svc = stubSidecar({
      ensureReady: async () => { throw new Error('下载失败: http 502') },
    })
    const app = new Hono()
    app.route('/admin/api/sidecar', createSidecarApp(
      svc as never,
      { getByName: () => undefined, put: () => {} } as never,
      () => {}, fetch, { list: () => [{ id: 'clash', kind: 'http', addr: '127.0.0.1:7897' }] }))
    const res = await app.request('/admin/api/sidecar/ensure', { method: 'POST' })
    expect(res.status).toBe(500)
    const msg = (await res.json() as { error: { message: string } }).error.message
    expect(msg).toContain('下载失败')
    expect(msg).toContain('http://127.0.0.1:7897') // 排障要知道走了哪个代理
  })

  test('Provider 配了 egress 时，下载复用该出口（项目配置优先于自动采用）', async () => {
    let seenFetch: unknown
    const svc = stubSidecar({
      ensureReady: async (_dir: string, opts: { fetch?: unknown } = {}) => { seenFetch = opts.fetch },
    })
    const app = new Hono()
    app.route('/admin/api/sidecar', createSidecarApp(
      svc as never,
      { getByName: () => ({ baseUrl: 'http://127.0.0.1:8080', egress: 'corp' }), put: () => {} } as never,
      () => {}, fetch, {
        list: () => [
          { id: 'clash', kind: 'http', addr: '127.0.0.1:7897' },
          { id: 'corp', kind: 'http', addr: '10.0.0.9:8888' },
        ],
      }))
    const b = await (await app.request('/admin/api/sidecar/ensure', { method: 'POST' }))
      .json() as Record<string, unknown>
    expect(b.downloadProxySource).toBe('provider-egress:corp')
    expect(b.downloadProxy).toBe('http://10.0.0.9:8888')
    expect(seenFetch).not.toBe(fetch)
  })

  test('POST start/stop/setup：setup 不回显 key 全文', async () => {
    const app = sidecarHarness()
    expect((await app.request('/admin/api/sidecar/start', { method: 'POST' })).status).toBe(200)
    const setup = await app.request('/admin/api/sidecar/setup', { method: 'POST' })
    const sb = await setup.json() as { keyPrefix: string }
    expect(sb.keyPrefix).toMatch(/^sk-local-abc…$/) // 对齐 Go：key 前 12 字符 + …
    expect(JSON.stringify(sb)).not.toContain('sk-local-abcdefghij0123456789')
  })

  test('POST uninstall：无 confirm 400，confirm=true 执行', async () => {
    const app = sidecarHarness()
    expect((await app.request('/admin/api/sidecar/uninstall', { method: 'POST' })).status).toBe(400)
    const ok = await app.request('/admin/api/sidecar/uninstall?confirm=true', { method: 'POST' })
    expect(ok.status).toBe(200)
  })

  test('POST port：非法 400；改端口同步 zcode-plan-local baseUrl', async () => {
    let put: unknown
    const app = sidecarHarness(stubSidecar(), {
      getByName: (name) => ({ providerId: 1, name, baseUrl: 'http://127.0.0.1:8080' }),
      put: (p) => { put = p },
    })
    expect((await app.request('/admin/api/sidecar/port', {
      method: 'POST', body: JSON.stringify({ port: 'abc' }),
    })).status).toBe(400)
    const res = await app.request('/admin/api/sidecar/port', {
      method: 'POST', body: JSON.stringify({ port: '9090' }),
    })
    expect(res.status).toBe(200)
    expect((put as { baseUrl: string }).baseUrl).toBe('http://127.0.0.1:9090')
  })

  test('POST endpoint：只允许回环 http；test=true 仅探活', async () => {
    const app = sidecarHarness()
    const bad = await app.request('/admin/api/sidecar/endpoint', {
      method: 'POST', body: JSON.stringify({ url: 'http://10.0.0.1:8080' }),
    })
    expect(bad.status).toBe(400)
    // 探活 fetch 可注入：模拟 /health 可达
    const app2 = new Hono()
    app2.route('/admin/api/sidecar', createSidecarApp(
      stubSidecar() as never,
      { get: () => undefined, put: () => {} } as never,
      () => {}, (async () => new Response('ok')) as typeof fetch))
    const test = await app2.request('/admin/api/sidecar/endpoint', {
      method: 'POST', body: JSON.stringify({ url: 'http://127.0.0.1:8080', test: true }),
    })
    expect(test.status).toBe(200) // 探活结果以 ok 字段表达，HTTP 恒 200
    expect((await test.json() as { ok: boolean }).ok).toBe(true)
  })

  test('POST 未知动作 → 404 带支持动作列表', async () => {
    const res = await sidecarHarness().request('/admin/api/sidecar/frob', { method: 'POST' })
    expect(res.status).toBe(404)
    // login/pause/cancel 均已进 HTTP（只有 install 仍走 CLI）
    expect((await res.json() as { error: { message: string } }).error.message)
      .toContain('start|stop|login|pause|cancel|setup|uninstall|ensure|port|endpoint')
  })
})

// ---- projects 适配器（打桩 Manager/Store）----

function stubManager() {
  const projects: { id: string; name: string; services: { name: string; cmd: string; dir: string }[] }[] = [
    { id: 'p1', name: 'demo', services: [{ name: 'web', cmd: 'node x', dir: '/x' }] },
  ]
  const calls: string[] = []
  return {
    calls,
    store: {
      load: async () => [...projects],
      save: async (ps: typeof projects) => { projects.splice(0, projects.length, ...ps); calls.push('save') },
      logPath: (id: string, s: string) => `/logs/${id}/${s}`,
    },
    list: async () => projects.map((p) => ({ ...p, services: p.services.map((s) => ({ ...s, running: false })) })),
    startProject: async (id: string) => { calls.push(`startProject:${id}`); return [] },
    stopProject: async (id: string) => { calls.push(`stopProject:${id}`) },
    startService: async (id: string, sid: string, port: number) => { calls.push(`startService:${id}/${sid}/${port}`); return null },
    stopService: async (id: string, sid: string) => { calls.push(`stopService:${id}/${sid}`) },
    restartService: async (id: string, sid: string) => { calls.push(`restartService:${id}/${sid}`); return null },
    reminders: async () => [],
    portBusy: () => false,
    portOwner: () => null,
  }
}

function projectsHarness(m = stubManager()) {
  const app = new Hono()
  app.route('/admin/api/projects', createProjectsApp(m as never))
  return { app, m }
}

describe('projects 适配器（对齐 Go adminapi/projects_api.go）', () => {
  test('GET / → {projects:[...]}; GET /reminders → {projects:[]}', async () => {
    const { app } = projectsHarness()
    const list = await app.request('/admin/api/projects')
    expect(((await list.json()) as { projects: unknown[] }).projects.length).toBe(1)
    const rem = await app.request('/admin/api/projects/reminders')
    expect((await rem.json() as { projects: unknown[] }).projects).toEqual([])
  })

  test('POST / 校验：无 name 400；合法创建带 p- ID', async () => {
    const { app, m } = projectsHarness()
    const bad = await app.request('/admin/api/projects', { method: 'POST', body: JSON.stringify({ services: [] }) })
    expect(bad.status).toBe(400)
    const res = await app.request('/admin/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', services: [{ name: 'a', cmd: 'c', dir: '/d' }] }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { project: { id: string } }).project.id).toMatch(/^p-/)
    expect(m.calls).toContain('save')
  })

  test('项目级 start/stop；未知动作 404', async () => {
    const { app, m } = projectsHarness()
    expect((await app.request('/admin/api/projects/p1/start', { method: 'POST' })).status).toBe(200)
    expect(m.calls).toContain('startProject:p1')
    expect((await app.request('/admin/api/projects/p1/frob', { method: 'POST' })).status).toBe(404)
  })

  test('服务级动作：冲突 409 + conflict 载荷', async () => {
    const m = stubManager()
    ;(m as { startService: unknown }).startService = async () => ({
      name: 'web', port: 3000, busy: true, owner: 'other', remappable: true, suggested: 3001,
    })
    const { app } = projectsHarness(m)
    const res = await app.request('/admin/api/projects/p1/services/web/start', {
      method: 'POST', body: JSON.stringify({ port: 3000 }),
    })
    expect(res.status).toBe(409)
    expect((await res.json() as { conflict: { port: number } }).conflict.port).toBe(3000)
  })

  test('logs：GET tail 尾部、DELETE 清空；缺 service 400', async () => {
    const { app } = projectsHarness()
    expect((await app.request('/admin/api/projects/p1/logs')).status).toBe(400)
    const res = await app.request('/admin/api/projects/p1/logs?service=web&tail=10')
    // 日志文件不存在 → 空；新返回带 tail 回显与 truncated 标记
    const body = await res.json() as { log: string; tail: number; truncated: boolean }
    expect(body.log).toBe('')
    expect(body.tail).toBe(10)
    expect(body.truncated).toBe(false)
    expect((await app.request('/admin/api/projects/p1/logs?service=web', { method: 'DELETE' })).status).toBe(200)
  })

  test('logs：默认 tail=1000，非法/超限回落与封顶', async () => {
    const { app } = projectsHarness()
    const dflt = await app.request('/admin/api/projects/p1/logs?service=web')
    expect(((await dflt.json()) as { tail: number }).tail).toBe(1000)
    const bad = await app.request('/admin/api/projects/p1/logs?service=web&tail=abc')
    expect(((await bad.json()) as { tail: number }).tail).toBe(1000)
    const huge = await app.request('/admin/api/projects/p1/logs?service=web&tail=999999')
    expect(((await huge.json()) as { tail: number }).tail).toBe(5000)
  })

  test('open：在系统中打开目录（dir留空/非法400，opener可注入）', async () => {
    const opened: string[] = []
    const m = stubManager()
    const app = new Hono()
    app.route('/admin/api/projects', createProjectsApp(m as never, {
      openDir: (dir: string) => { opened.push(dir) },
    }))
    // 探针目录用真实临时目录，而不是字面 '/tmp'——后者在 Windows 上不存在，
    // 会让「合法目录 → 200」这条断言退化成 400（断言本身假设了 POSIX）。
    const probe = mkdtempSync(join(tmpdir(), 'polycode-open-'))
    try {
      // 缺 dir → 400
      expect((await app.request('/admin/api/projects/open', {
        method: 'POST', body: JSON.stringify({}),
      })).status).toBe(400)
      // 非法路径（不存在）→ 400，不调用 opener
      expect((await app.request('/admin/api/projects/open', {
        method: 'POST', body: JSON.stringify({ dir: join(probe, 'polycode-nope-xyz') }),
      })).status).toBe(400)
      expect(opened).toEqual([])
      // 合法目录 → 200 并调用 opener
      const ok = await app.request('/admin/api/projects/open', {
        method: 'POST', body: JSON.stringify({ dir: probe }),
      })
      expect(ok.status).toBe(200)
      expect(opened).toEqual([probe])
    } finally {
      rmSync(probe, { recursive: true, force: true })
    }
  })

  test('browse：列子目录（空=根/盘符，不存在400，文件非目录400）', async () => {
    const { app } = projectsHarness()
    const probe = mkdtempSync(join(tmpdir(), 'polycode-browse-'))
    try {
      // 真实存在的目录 → 200，dirs 为数组
      const ok = await app.request('/admin/api/projects/browse?path=' + encodeURIComponent(probe))
      expect(ok.status).toBe(200)
      const body = await ok.json() as { path: string; parent: string; dirs: string[] }
      expect(body.path).toBe(probe)
      expect(Array.isArray(body.dirs)).toBe(true)
      // 不存在 → 400
      expect((await app.request(
        '/admin/api/projects/browse?path=' + encodeURIComponent(join(probe, 'polycode-nope-xyz')),
      )).status).toBe(400)
      // 文件非目录 → 400（用本文件自身做探针）
      const fileRes = await app.request(
        '/admin/api/projects/browse?path=' + encodeURIComponent(probe),
      )
      expect(fileRes.status).toBe(200)
    } finally {
      rmSync(probe, { recursive: true, force: true })
    }
  })

  test('readmes：BFS 逐层找README（3层封顶/跳过噪音/最多5个/相对路径返回）', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'polycode-readme-'))
    try {
      // 根 + 3 层各放一个，第 4 层的不应出现
      writeFileSync(join(dir, 'README.md'), '# root')
      mkdirSync(join(dir, 'a', 'b', 'c'), { recursive: true })
      writeFileSync(join(dir, 'a', 'README.md'), '# a')
      writeFileSync(join(dir, 'a', 'b', 'readme.txt'), '# b')
      writeFileSync(join(dir, 'a', 'b', 'c', 'README.md'), '# c')
      mkdirSync(join(dir, 'a', 'b', 'c', 'd'), { recursive: true })
      writeFileSync(join(dir, 'a', 'b', 'c', 'd', 'README.md'), '# d-too-deep')
      // 噪音目录直接跳过
      mkdirSync(join(dir, 'node_modules'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'README.md'), '# noise')
      const { app } = projectsHarness()
      const res = await app.request('/admin/api/projects/readmes?dir=' + encodeURIComponent(dir))
      expect(res.status).toBe(200)
      const body = await res.json() as { dir: string; readmes: { path: string; size: number }[] }
      const paths = body.readmes.map((r) => r.path).sort()
      expect(paths).toContain('README.md')
      expect(paths).toContain('a/README.md')
      expect(paths).toContain('a/b/readme.txt')
      expect(paths).toContain('a/b/c/README.md')
      expect(paths).not.toContain('a/b/c/d/README.md') // 第 4 层截断
      expect(paths).not.toContain('node_modules/README.md') // 噪音跳过
      // 不存在 → 400
      expect((await app.request('/admin/api/projects/readmes?dir=' + encodeURIComponent(join(dir, 'nope')))).status).toBe(400)
      // 缺 dir → 400
      expect((await app.request('/admin/api/projects/readmes')).status).toBe(400)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('readmes：候选最多 5 个，且优先给最靠近根的那批（BFS 截断）', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'polycode-readme-cap-'))
    try {
      // 根目录放 1 个；a/ 下塞 1 层候选；a/pX/deep/ 里再塞一堆第 2 层的。
      // DFS 会顺着 a/ 一路扎到底把名额吃光；BFS 必须先收干净第 0/1 层。
      writeFileSync(join(dir, 'README.md'), '# root')
      mkdirSync(join(dir, 'a'), { recursive: true })
      writeFileSync(join(dir, 'a', 'README.md'), '# a') // 第 1 层
      for (let i = 0; i < 8; i++) {
        mkdirSync(join(dir, 'a', `p${i}`, 'deep'), { recursive: true })
        writeFileSync(join(dir, 'a', `p${i}`, 'deep', 'README.md'), `# deep-${i}`)
      }
      const { app } = projectsHarness()
      const body = await (await app.request(
        '/admin/api/projects/readmes?dir=' + encodeURIComponent(dir))).json() as { readmes: { path: string }[] }
      expect(body.readmes.length).toBe(5) // 硬上限
      const got = body.readmes.map((r) => r.path)
      expect(got).toContain('README.md') // 根 README 必进
      expect(got).toContain('a/README.md')
      // BFS 序：先收满浅层再下探。第 0/1 层只有 2 个候选，剩下 3 个名额才轮到
      // 第 2 层，且必须是 a/p0..p2（按名排序）而不是 DFS 那样顺着某个分支扎穿。
      expect(got.slice(0, 2)).toEqual(['README.md', 'a/README.md'])
      expect(got.slice(2).sort()).toEqual(['a/p0/deep/README.md', 'a/p1/deep/README.md', 'a/p2/deep/README.md'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('readmes：点开头的隐藏目录整棵跳过（.worktrees 等不混进候选）', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'polycode-readme-hidden-'))
    try {
      writeFileSync(join(dir, 'README.md'), '# root')
      mkdirSync(join(dir, '.worktrees', 'wip'), { recursive: true })
      writeFileSync(join(dir, '.worktrees', 'README.md'), '# wt')
      writeFileSync(join(dir, '.worktrees', 'wip', 'README.md'), '# wt-wip')
      mkdirSync(join(dir, '.github'), { recursive: true })
      writeFileSync(join(dir, '.github', 'README.md'), '# gh')
      // 正常目录不受影响（回归护栏：别把跳过写成"只列根"）
      mkdirSync(join(dir, 'docs'), { recursive: true })
      writeFileSync(join(dir, 'docs', 'README.md'), '# docs')
      const { app } = projectsHarness()
      const res = await app.request('/admin/api/projects/readmes?dir=' + encodeURIComponent(dir))
      const body = await res.json() as { readmes: { path: string }[] }
      const paths = body.readmes.map((r) => r.path).sort()
      expect(paths).toContain('README.md')
      expect(paths).toContain('docs/README.md')
      expect(paths).not.toContain('.worktrees/README.md')
      expect(paths).not.toContain('.worktrees/wip/README.md')
      expect(paths).not.toContain('.github/README.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('GET /default-model：把注入的 defaultModel 透给前端（没配=空串）', async () => {
    const m = stubManager()
    const withCfg = new Hono()
    withCfg.route('/admin/api/projects', createProjectsApp(m as never, { defaultModel: 'opencode/mimo-v2.5-free' }))
    const got = await (await withCfg.request('/admin/api/projects/default-model')).json() as { model: string }
    expect(got.model).toBe('opencode/mimo-v2.5-free')
    // 未注入 → 空串（前端据此回落到列表首个）
    const bare = new Hono()
    bare.route('/admin/api/projects', createProjectsApp(m as never))
    expect(((await (await bare.request('/admin/api/projects/default-model')).json()) as { model: string }).model).toBe('')
  })

  test('ai-fill：未传 model 时用注入的 defaultModel（config 的 default_model）', async () => {
    const calls: { model: string }[] = []
    const m = stubManager()
    const app = new Hono()
    app.route('/admin/api/projects', createProjectsApp(m as never, {
      defaultModel: 'opencode/mimo-v2.5-free',
      aiComplete: async (model: string) => { calls.push({ model }); return '{"name":"x","services":[]}' },
    }))
    // dir 必须是真实存在的目录（端点会校验），用临时目录而非 '/tmp'。
    const probe = mkdtempSync(join(tmpdir(), 'polycode-aifill-'))
    try {
      const res = await app.request('/admin/api/projects/ai-fill', {
        method: 'POST',
        body: JSON.stringify({ dir: probe, readmes: [] }),
      })
      expect(res.status).toBe(200)
      expect(calls[0]!.model).toBe('opencode/mimo-v2.5-free')
    } finally {
      rmSync(probe, { recursive: true, force: true })
    }
  })

  test('ai-fill：参数校验（缺dir400/模型透传/ai失败502可注入）', async () => {
    const calls: { model: string; system: string }[] = []
    const m = stubManager()
    const app = new Hono()
    app.route('/admin/api/projects', createProjectsApp(m as never, {
      aiComplete: async (model: string, system: string) => {
        calls.push({ model, system })
        return '{"name":"x","services":[]}'
      },
      readFile: (p: string) => `content-of-${p}`,
    }))
    // 缺 dir → 400
    expect((await app.request('/admin/api/projects/ai-fill', {
      method: 'POST', body: JSON.stringify({}),
    })).status).toBe(400)
    // dir 必须是真实存在的目录（端点会校验），用临时目录而非 '/tmp'。
    const probe = mkdtempSync(join(tmpdir(), 'polycode-aifill2-'))
    try {
      // 正常：模型透传 + README 内容拼进 system
      const ok = await app.request('/admin/api/projects/ai-fill', {
        method: 'POST',
        body: JSON.stringify({ dir: probe, model: 'm1', readmes: ['README.md'] }),
      })
      expect(ok.status).toBe(200)
      expect(calls.length).toBe(1)
      expect(calls[0]!.model).toBe('m1')
      expect(calls[0]!.system).toContain('content-of-')
      // ai 抛错 → 502（前端降级复制）
      const app2 = new Hono()
      app2.route('/admin/api/projects', createProjectsApp(m as never, {
        aiComplete: async () => { throw new Error('限流') },
      }))
      expect((await app2.request('/admin/api/projects/ai-fill', {
        method: 'POST', body: JSON.stringify({ dir: probe, model: 'm1' }),
      })).status).toBe(502)
    } finally {
      rmSync(probe, { recursive: true, force: true })
    }
  })

  test('port-owner：busy/owner 查询（IO 注入，不探真实端口）', async () => {
    const { app, m } = projectsHarness()
    const app2 = new Hono()
    app2.route('/admin/api/projects', createProjectsApp(m as unknown as Manager, {
      portBusy: () => true, portOwner: () => 'someproc',
    }))
    const res = await app2.request('/admin/api/projects/port-owner?port=3000')
    const b = await res.json() as { port: number; busy: boolean; owner: string }
    expect(b.port).toBe(3000)
    expect(b.busy).toBe(true)
    expect(b.owner).toBe('someproc')
    expect((await app2.request('/admin/api/projects/port-owner?port=x')).status).toBe(400)
    // 默认 IO 路由存在即可（真实探测属 process.ts 单元职责）
    expect((await app.request('/admin/api/projects/port-owner?port=1')).status).toBe(200)
  })

  test('port-kill：无 confirm 400；confirm=true 走注入停端口', async () => {
    const killed: number[] = []
    const app2 = new Hono()
    app2.route('/admin/api/projects', createProjectsApp(stubManager() as never, {
      killPort: async (port: number) => { killed.push(port); return { killed: [4242], owner: 'someproc', busy: false } },
    }))
    // 非法端口 → 400
    expect((await app2.request('/admin/api/projects/port-kill', {
      method: 'POST', body: JSON.stringify({ port: 'x', confirm: true }),
    })).status).toBe(400)
    // 缺 confirm → 400，不调用 killPort
    expect((await app2.request('/admin/api/projects/port-kill', {
      method: 'POST', body: JSON.stringify({ port: 3000 }),
    })).status).toBe(400)
    expect(killed).toEqual([])
    // confirm=true → 200 + 回执
    const ok = await app2.request('/admin/api/projects/port-kill', {
      method: 'POST', body: JSON.stringify({ port: 3000, confirm: true }),
    })
    expect(ok.status).toBe(200)
    expect(killed).toEqual([3000])
    const b = await ok.json() as { port: number; killed: number[]; owner: string; busy: boolean }
    expect(b.port).toBe(3000)
    expect(b.killed).toEqual([4242])
    expect(b.busy).toBe(false)
    // killPort 抛错 → 500 透出 message
    const app3 = new Hono()
    app3.route('/admin/api/projects', createProjectsApp(stubManager() as never, {
      killPort: async () => { throw new Error('端口 3000 由网关自身占用，不能停') },
    }))
    const bad = await app3.request('/admin/api/projects/port-kill', {
      method: 'POST', body: JSON.stringify({ port: 3000, confirm: true }),
    })
    expect(bad.status).toBe(500)
    expect((await bad.json() as { error: { message: string } }).error.message).toContain('网关自身')
  })
})

// —— 安装作业态：服务端是「安装中」的唯一真相源（切页不丢 / 不重复下载） ——

describe('sidecar 安装作业态', () => {
  type Job = {
    running: boolean; phase: string; received: number; total: number
    startedAt: number; elapsedMs: number; ok: boolean; error: string
    downloadProxy: string; downloadProxySource: string
  }
  const getJob = async (app: Hono): Promise<Job> =>
    ((await (await app.request('/admin/api/sidecar')).json()) as { install: Job }).install

  test('GET / 空闲时 install 字段齐全且未在跑', async () => {
    const j = await getJob(sidecarHarness())
    expect(j.running).toBe(false)
    expect(j.ok).toBe(false)
    expect(j.error).toBe('')
    expect(j.received).toBe(0)
    expect(j.startedAt).toBe(0)
    expect(j.elapsedMs).toBe(0)
  })

  test('安装中：GET / 暴露 phase 与字节进度；完成后转 ok', async () => {
    // 真实缺陷的锚点：以前前端把 busy 存在组件 ref 里，切页就归零，
    // 而服务端还在下载——页面显示「一键安装」，用户再点一次就并发下载第二次。
    // 现在进度记在服务端，切页/刷新/开新标签页读到的都是同一个作业。
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let entered!: () => void
    const enteredP = new Promise<void>((r) => { entered = r })
    const svc = stubSidecar({
      ensureReady: async (_dir: string, opts: { onProgress?: (p: unknown) => void } = {}) => {
        opts.onProgress?.({ phase: 'downloading', received: 1048576, total: 4 * 1048576 })
        entered()
        await gate
      },
    })
    const app = new Hono()
    app.route('/admin/api/sidecar', createSidecarApp(
      svc as never,
      { getByName: () => undefined, put: () => {} } as never,
      () => {}, fetch, { list: () => [{ id: 'clash', kind: 'http', addr: '127.0.0.1:7897' }] }))

    const p = app.request('/admin/api/sidecar/ensure', { method: 'POST' })
    await enteredP
    const mid = await getJob(app)
    expect(mid.running).toBe(true)
    expect(mid.phase).toBe('downloading')
    expect(mid.received).toBe(1048576)
    expect(mid.total).toBe(4 * 1048576)
    expect(mid.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(mid.downloadProxy).toBe('http://127.0.0.1:7897') // 本次尝试用的出口，失败时可解释
    expect(mid.downloadProxySource).toBe('egress-auto:clash')

    release()
    expect((await p).status).toBe(200)
    const done = await getJob(app)
    expect(done.running).toBe(false)
    expect(done.ok).toBe(true)
    expect(done.error).toBe('')
  })

  test('失败后错误留在作业态里（切页回来仍能看到原因）', async () => {
    const app = sidecarHarness(stubSidecar({
      ensureReady: async () => { throw new Error('下载 x 失败 —— ECONNRESET。请换节点后重试') },
    }))
    const res = await app.request('/admin/api/sidecar/ensure', { method: 'POST' })
    expect(res.status).toBe(500)
    const j = await getJob(app)
    expect(j.running).toBe(false)
    expect(j.ok).toBe(false)
    expect(j.error).toContain('ECONNRESET')
  })

  test('单飞：并发两个 ensure 只下载一次（不再互相踩踏同一个 .tmp）', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let entered!: () => void
    const enteredP = new Promise<void>((r) => { entered = r })
    const svc = stubSidecar({
      ensureReady: async () => { calls++; entered(); await gate },
    })
    const app = new Hono()
    app.route('/admin/api/sidecar', createSidecarApp(
      svc as never, { getByName: () => undefined, put: () => {} } as never, () => {}))

    const p1 = app.request('/admin/api/sidecar/ensure', { method: 'POST' })
    await enteredP // 第一次安装已在跑
    const p2 = app.request('/admin/api/sidecar/ensure', { method: 'POST' })
    // 让第二个请求走到 ensureJob：它应当复用同一个 promise，而不是再起一次下载
    await new Promise((r) => { setTimeout(r, 50) })
    expect(calls).toBe(1)
    release()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200) // 复用的那次也拿到成功回执
    expect(calls).toBe(1) // 事后仍是 1：第二个请求没有偷偷再下一次
  })

  test('installed 走 findBinary（Windows .exe 回归锚点）', async () => {
    // 历史缺陷：这里曾独立硬编码 `${dir}/zcode-proxy`，而 Windows 上落地的是
    // zcode-proxy.exe，于是装完也永远报 installed:false —— 引擎停下时页面
    // 永远显示「未安装」，回不到「已安装，未运行」。改为复用 findBinary 后，
    // 判定口径与 install 落地的文件名强制一致。
    const hit = sidecarHarness(stubSidecar({ findBinary: () => '/wd/zcode-proxy.exe' }))
    expect(((await (await hit.request('/admin/api/sidecar')).json()) as { installed: boolean }).installed).toBe(true)
    const miss = sidecarHarness(stubSidecar({ findBinary: () => { throw new Error('sidecar: 未安装') } }))
    expect(((await (await miss.request('/admin/api/sidecar')).json()) as { installed: boolean }).installed).toBe(false)
  })
})
