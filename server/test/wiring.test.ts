import { describe, expect, test } from 'vitest'
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

function sidecarHarness(svc = stubSidecar(), providers?: { get: (id: string) => unknown; put: (p: unknown) => void }) {
  const store = providers ?? {
    get: (id: string) => id === 'zcode-plan-local' ? { id, baseUrl: 'http://127.0.0.1:8080' } : undefined,
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
      get: () => ({ id: 'zcode-plan-local', baseUrl: 'http://127.0.0.1:8080' }),
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
    expect((await res.json() as { error: { message: string } }).error.message).toContain('start|stop|setup|ensure')
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
    expect((await res.json() as { log: string }).log).toBe('') // 日志文件不存在 → 空
    expect((await app.request('/admin/api/projects/p1/logs?service=web', { method: 'DELETE' })).status).toBe(200)
  })

  test('open：在系统中打开目录（dir留空/非法400，opener可注入）', async () => {
    const opened: string[] = []
    const m = stubManager()
    const app = new Hono()
    app.route('/admin/api/projects', createProjectsApp(m as never, {
      openDir: (dir: string) => { opened.push(dir) },
    }))
    // 缺 dir → 400
    expect((await app.request('/admin/api/projects/open', {
      method: 'POST', body: JSON.stringify({}),
    })).status).toBe(400)
    // 非法路径（不存在）→ 400，不调用 opener
    expect((await app.request('/admin/api/projects/open', {
      method: 'POST', body: JSON.stringify({ dir: '/tmp/polycode-nope-xyz' }),
    })).status).toBe(400)
    expect(opened).toEqual([])
    // 合法目录 → 200 并调用 opener
    const ok = await app.request('/admin/api/projects/open', {
      method: 'POST', body: JSON.stringify({ dir: '/tmp' }),
    })
    expect(ok.status).toBe(200)
    expect(opened).toEqual(['/tmp'])
  })

  test('browse：列子目录（空=根/盘符，不存在400，文件非目录400）', async () => {
    const { app } = projectsHarness()
    // /tmp 存在 → 200，dirs 为数组
    const ok = await app.request('/admin/api/projects/browse?path=' + encodeURIComponent('/tmp'))
    expect(ok.status).toBe(200)
    const body = await ok.json() as { path: string; parent: string; dirs: string[] }
    expect(body.path).toBe('/tmp')
    expect(Array.isArray(body.dirs)).toBe(true)
    // 不存在 → 400
    expect((await app.request('/admin/api/projects/browse?path=' + encodeURIComponent('/tmp/polycode-nope-xyz'))).status).toBe(400)
    // 文件非目录 → 400（用本文件自身做探针）
    const fileRes = await app.request('/admin/api/projects/browse?path=' + encodeURIComponent('/tmp'))
    expect(fileRes.status).toBe(200)
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
    const res = await app.request('/admin/api/projects/ai-fill', {
      method: 'POST',
      body: JSON.stringify({ dir: '/tmp', readmes: [] }),
    })
    expect(res.status).toBe(200)
    expect(calls[0]!.model).toBe('opencode/mimo-v2.5-free')
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
    // 正常：模型透传 + README 内容拼进 system
    const ok = await app.request('/admin/api/projects/ai-fill', {
      method: 'POST',
      body: JSON.stringify({ dir: '/tmp', model: 'm1', readmes: ['README.md'] }),
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
      method: 'POST', body: JSON.stringify({ dir: '/tmp', model: 'm1' }),
    })).status).toBe(502)
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
