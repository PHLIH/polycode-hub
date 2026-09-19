// 项目管理面的后端接线：把 projects 包暴露为 /admin/api/projects/*（薄适配，
// 对齐 Go internal/adminapi/projects_api.go）。与代理链路无关，独立文件。

import { openSync, readFileSync, readdirSync, readSync, statSync, truncateSync, closeSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Hono, type Context } from 'hono'
import { type Manager } from '../projects/manager.ts'
import { newID, type Project } from '../projects/store.ts'
import { portBusy as realPortBusy, portOwner as realPortOwner, killPort as realKillPort } from '../projects/process.ts'

function err(c: Context, status: 400 | 404 | 500, msg: string): Response {
  return c.json({ error: { type: status === 404 ? 'not_found_error' : status === 400 ? 'invalid_request_error' : 'api_error', message: msg } }, status)
}

// 校验项目定义。只拦真正无法补救的：项目名、至少一个服务、服务名非空且唯一。
// dir/cmd 不再强制——留空有默认（dir 缺省=进程 cwd，cmd 缺省=由服务类型推导），
// 强制三填空会让用户为了过校验随手填 "-" 这种假占位符（比空值更糟）。
export function validateProject(p: Project): string | undefined {
  if (!p.name) return '项目名不能为空'
  if (!p.services || p.services.length === 0) return '至少配置一个服务'
  const seen = new Set<string>()
  for (const s of p.services) {
    if (!s.name) return '服务名不能为空'
    if (seen.has(s.name)) return '服务名重复: ' + s.name
    seen.add(s.name)
  }
  return undefined
}

export function createProjectsApp(
  m: Manager,
  io: {
    portBusy?: (port: number) => Promise<boolean> | boolean
    portOwner?: (port: number) => Promise<string | null> | string | null
    // killPort 注入点（测试用；默认 killPort 查 pid 停进程）
    killPort?: (port: number) => Promise<{ killed: number[]; owner: string; busy: boolean }>
    openDir?: (dir: string) => void
    // ai-fill 注入点（测试用；默认走本网关 chat/completions）
    aiComplete?: (model: string, system: string) => Promise<string>
    readFile?: (path: string) => string
    gatewayBase?: string
    defaultModel?: string
  } = {},
): Hono {
  const app = new Hono()

  // GET / → 全部项目（含实时状态）。
  app.get('/', async (c) => c.json({ projects: await m.list() }))

  // POST / → 新建项目。
  app.post('/', async (c) => {
    const p = await c.req.json().catch(() => undefined) as Project | undefined
    if (!p) return err(c, 400, '请求体须为项目 JSON')
    const invalid = validateProject(p)
    if (invalid) return err(c, 400, invalid)
    p.id = newID()
    const ps = await m.store.load()
    ps.push(p)
    try {
      await m.store.save(ps)
    } catch (e) {
      return err(c, 500, (e as Error).message)
    }
    return c.json({ project: p })
  })

  // GET /reminders → 长期运行提醒。
  app.get('/reminders', async (c) => {
    const v = Number(c.req.query('thresholdHours'))
    const thresholdMs = (v > 0 ? v : 24) * 3600_000
    return c.json({ projects: await m.reminders(thresholdMs) })
  })

  // GET /port-owner?port= → 占用者查询。
  app.get('/port-owner', async (c) => {
    const port = Number(c.req.query('port'))
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return err(c, 400, '须为合法端口')
    }
    return c.json({
      port,
      busy: await (io.portBusy ?? realPortBusy)(port),
      owner: await (io.portOwner ?? realPortOwner)(port),
    })
  })

  // POST /port-kill {port} → 停掉监听该端口的外部进程。
  // 危险动作：只停「非网关自身」的进程。confirm=true 才算用户二次确认。
  // 网关自身端口 / 无权限 / 查不到进程 → 4xx/500，不静默。
  app.post('/port-kill', async (c) => {
    const body = await c.req.json().catch(() => undefined) as { port?: unknown; confirm?: unknown } | undefined
    const port = Number(body?.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return err(c, 400, '须为合法端口')
    }
    if (body?.confirm !== true) {
      return err(c, 400, '停端口是危险动作，须带 confirm=true 二次确认')
    }
    try {
      const r = await (io.killPort ?? realKillPort)(port)
      return c.json({ port, ...r })
    } catch (e) {
      return err(c, 500, (e as Error).message)
    }
  })

  // PUT /{id} → 整体替换定义。
  app.put('/:id', async (c) => {
    const id = c.req.param('id')
    const input = await c.req.json().catch(() => undefined) as Project | undefined
    if (!input) return err(c, 400, '请求体须为项目 JSON')
    const invalid = validateProject(input)
    if (invalid) return err(c, 400, invalid)
    const ps = await m.store.load()
    const i = ps.findIndex((p) => p.id === id)
    if (i < 0) return err(c, 404, '项目不存在')
    input.id = id
    ps[i] = input
    try {
      await m.store.save(ps)
    } catch (e) {
      return err(c, 500, (e as Error).message)
    }
    return c.json({ project: input })
  })

  // DELETE /{id} → 先停服务再删定义。
  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    try {
      await m.stopProject(id)
    } catch (e) {
      return err(c, 500, '停止服务失败: ' + (e as Error).message)
    }
    const ps = await m.store.load()
    try {
      await m.store.save(ps.filter((p) => p.id !== id))
    } catch (e) {
      return err(c, 500, (e as Error).message)
    }
    return c.json({ ok: true })
  })

  // POST /{id}/{action} → 项目级 start|stop。
  app.post('/:id/:action', async (c) => {
    const id = c.req.param('id')
    const action = c.req.param('action')
    if (action === 'start') {
      const conflicts = await m.startProject(id)
      return c.json({ ok: true, conflicts })
    }
    if (action === 'stop') {
      try {
        await m.stopProject(id)
      } catch (e) {
        return err(c, 500, (e as Error).message)
      }
      // 该项目可能就包含网关自己（管理台跑在网关里）：响应先写回再退出。
      m.finishPendingSelfStop()
      return c.json({ ok: true })
    }
    return err(c, 404, '未知动作（支持: start|stop）')
  })

  // POST /{id}/services/{sid}/{action} → 单服务 start|stop|restart。
  // 启动的端口冲突返回 409 + conflict 载荷。
  app.post('/:id/services/:sid/:action', async (c) => {
    const id = c.req.param('id')
    const sid = c.req.param('sid')
    const action = c.req.param('action')
    let conflict: unknown
    let failure: string | undefined
    if (action === 'start') {
      const body = await c.req.json().catch(() => undefined) as { port?: number } | undefined
      conflict = await m.startService(id, sid, body?.port ?? 0)
    } else if (action === 'stop') {
      try {
        await m.stopService(id, sid)
      } catch (e) {
        failure = (e as Error).message
      }
    } else if (action === 'restart') {
      conflict = await m.restartService(id, sid)
    } else {
      return err(c, 404, '未知动作（支持: start|stop|restart）')
    }
    if (conflict) return c.json({ conflict }, 409)
    if (failure) return err(c, 400, failure)
    // 停/重启的是网关自己时：响应先写回，再退出本进程。
    // 顺序不能反——立刻 process.exit 会让浏览器只看到请求失败，用户以为操作出错。
    m.finishPendingSelfStop()
    return c.json({ ok: true })
  })

  // POST /open → 在系统中打开目录（Finder/文件管理器）。
  // dir 须为已存在的目录；不存在/留空 → 400（不调用 opener）。
  app.post('/open', async (c) => {
    const body = await c.req.json().catch(() => undefined) as { dir?: unknown } | undefined
    const dir = typeof body?.dir === 'string' ? body.dir : ''
    if (!dir) return err(c, 400, '须指定 dir')
    try {
      const st = statSync(dir)
      if (!st.isDirectory()) return err(c, 400, `不是目录: ${dir}`)
    } catch {
      return err(c, 400, `目录不存在: ${dir}`)
    }
    try {
      (io.openDir ?? defaultOpenDir)(dir)
    } catch (e) {
      return err(c, 500, '打开目录失败: ' + (e as Error).message)
    }
    return c.json({ ok: true })
  })

  // GET /browse?path= → 列子目录（目录浏览器用）。
  // path 为空：posix 返回 /，win32 返回盘符列表；不存在/非目录 → 400。
  app.get('/browse', async (c) => {
    const raw = c.req.query('path') ?? ''
    if (raw === '') {
      if (process.platform === 'win32') {
        return c.json({ path: '', parent: '', dirs: winDrives() })
      }
      return browseDir('/')
    }
    return browseDir(raw)
  })

  // GET /default-model → 网关 default_model（AI 下拉的默认值；空串=没配，前端回落首个）。
  // 说明：不为这一个值新增 /admin/api/config 大端点，只开这一个小口子。
  app.get('/default-model', (c) => c.json({ model: io.defaultModel ?? '' }))

  // GET /readmes?dir= → 递归找 README（3 层封顶/跳过噪音/相对路径返回）。
  // 防护：不存在 400；噪音目录跳过；最多 50 个；超 3s 截断（根目录也不炸）。
  app.get('/readmes', async (c) => {
    const raw = c.req.query('dir') ?? ''
    if (!raw) return err(c, 400, '须指定 dir')
    let abs: string
    try {
      abs = resolve(raw)
      if (!statSync(abs).isDirectory()) return err(c, 400, `不是目录: ${raw}`)
    } catch {
      return err(c, 400, `目录不存在: ${raw}`)
    }
    return c.json({ dir: abs, readmes: findReadmes(abs) })
  })

  // POST /ai-fill → 用本网关模型现场填项目 JSON。
  // {dir, model?, readmes?[]}；README 内容拼进 system；AI 失败 → 502（前端降级复制）。
  app.post('/ai-fill', async (c) => {
    const body = await c.req.json().catch(() => undefined) as
      { dir?: unknown; model?: unknown; readmes?: unknown } | undefined
    const dir = typeof body?.dir === 'string' ? body.dir : ''
    if (!dir) return err(c, 400, '须指定 dir')
    let abs: string
    try {
      abs = resolve(dir)
      if (!statSync(abs).isDirectory()) return err(c, 400, `不是目录: ${dir}`)
    } catch {
      return err(c, 400, `目录不存在: ${dir}`)
    }
    const model = typeof body?.model === 'string' && body.model
      ? body.model
      : (io.defaultModel ?? process.env.POLYCODE_DEFAULT_MODEL ?? '')
    if (!model) return err(c, 400, '须指定 model（网关无 default_model）')
    const picked = Array.isArray(body?.readmes)
      ? (body.readmes as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
    // README 内容拼 system：单个 8k，总上限 24k；读不到跳过不报错。
    const read = io.readFile ?? ((p: string) => readFileSync(p, 'utf8'))
    const chunks: string[] = []
    let budget = 24_000
    for (const rel of picked.slice(0, 10)) {
      if (budget <= 0) break
      if (rel.includes('..')) continue // 目录穿越直接跳过
      try {
        const content = read(join(abs, rel)).slice(0, 8_000)
        chunks.push(`--- ${rel} ---\n${content}`)
        budget -= content.length
      } catch { /* 读不到跳过 */ }
    }
    const system = buildAiFillPrompt(abs, chunks)
    try {
      const text = await (io.aiComplete ?? ((md, sys) => gatewayComplete(
        io.gatewayBase ?? 'http://127.0.0.1:3000', md, sys,
      )))(model, system)
      return c.json({ json: extractJSON(text), readmeFound: chunks.length })
    } catch (e) {
      return c.json(
        { error: { type: 'api_error', message: 'AI 填写失败: ' + (e as Error).message } },
        502,
      )
    }
  })

  // GET/DELETE /{id}/logs?service=&tail=。
  app.get('/:id/logs', async (c) => handleLogs(c, m, false))
  app.delete('/:id/logs', async (c) => handleLogs(c, m, true))

  return app
}

// defaultOpenDir：在系统中打开目录（跨平台：darwin open / win32 explorer / linux xdg-open）。
// fire-and-forget：只负责调起，不等结果。
function defaultOpenDir(dir: string): void {
  if (process.platform === 'darwin') {
    execFile('open', [dir], () => {})
  } else if (process.platform === 'win32') {
    execFile('explorer', [dir], () => {})
  } else {
    execFile('xdg-open', [dir], () => {})
  }
}

// browseDir：列 path 下的子目录（只返回目录名，不递归；隐藏目录照常列出）。
function browseDir(raw: string): Response {
  const bad = (msg: string): Response =>
    new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: msg } }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  let abs: string
  try {
    abs = resolve(raw)
    const st = statSync(abs)
    if (!st.isDirectory()) return bad(`不是目录: ${raw}`)
  } catch {
    return bad(`目录不存在: ${raw}`)
  }
  let names: string[]
  try {
    names = readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
  } catch (e) {
    return new Response(JSON.stringify({ error: { type: 'api_error', message: '列目录失败: ' + (e as Error).message } }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
  const parent = dirname(abs)
  return Response.json({
    path: abs,
    parent: parent === abs ? '' : parent, // 根目录无上级
    sep,
    dirs: names,
  })
}

// winDrives：Windows 盘符列表（逐个探测存在性）。
function winDrives(): string[] {
  const out: string[] = []
  for (let code = 65; code <= 90; code++) {
    const d = String.fromCharCode(code) + ':\\'
    try {
      if (statSync(d).isDirectory()) out.push(d)
    } catch { /* 不存在 */ }
  }
  return out
}

// README 扫描防护：3 层封顶 / 最多 5 个 / 超 3s 截断（根目录也不炸）。
// 5 个是刻意的低上限：这个列表是给人勾的，几十个候选比没候选更劝退。
const README_MAX_DEPTH = 3
const README_MAX_COUNT = 5
const README_TIME_BUDGET_MS = 3000
// 噪音目录直接跳过（依赖/构建产物/版本控制）。
const README_SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '.venv', '__pycache__',
  '.pytest_cache', 'Library', '.cache', 'vendor', 'out', '.next', '.nuxt',
])

export interface ReadmeHit { path: string; size: number }

// findReadmes：BFS 逐层找 readme*（大小写不敏感），返回相对路径 + 大小。
// BFS 而非 DFS 是这里的关键：先扫完第 0 层再进第 1 层，因此凑满 5 个时
// 命中的一定是最靠近根的那批（根 README 必进），而不是 DFS 顺着第一个
// 子目录一路扎到底、把根目录的兄弟节点全漏掉。
export function findReadmes(root: string): ReadmeHit[] {
  const out: ReadmeHit[] = []
  const t0 = Date.now()
  const stopped = (): boolean =>
    out.length >= README_MAX_COUNT || Date.now() - t0 > README_TIME_BUDGET_MS
  // 队列元素是目录；head 游标代替 shift()，避免 O(n²) 搬数组。
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  for (let head = 0; head < queue.length; head++) {
    if (stopped()) break
    const { dir, depth } = queue[head]!
    // 到达封顶深度的目录仍要扫它自己这一层的 README（a/b/c/README.md 属于
    // 第 3 层、必须收），只是不再把它的子目录入队。
    const canDescend = depth < README_MAX_DEPTH
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    // 同一层内按名字排序，保证结果稳定（readdir 顺序依文件系统而变）。
    names.sort()
    for (const name of names) {
      if (stopped()) break
      if (README_SKIP.has(name)) continue
      if (name.startsWith('.')) continue // 隐藏目录整棵跳过（.worktrees/.github 里的 README 是噪音）
      const p = join(dir, name)
      let isDir = false
      try {
        isDir = statSync(p).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        if (canDescend) queue.push({ dir: p, depth: depth + 1 })
        continue
      }
      if (!/^readme(\..*)?$/i.test(name)) continue
      let size = 0
      try {
        size = statSync(p).size
      } catch { /* 大小读不到按 0 */ }
      // 相对路径在 Windows 上把 '\' 归一成 '/'：该值回给前端展示，也会被 ai-fill
      // 原样收回来再 join(abs, rel) 读文件，跨平台要一致。
      // POSIX 上**不替换**：那里的分隔符本来就是 '/'，而反斜杠是合法文件名字符
      // （macOS/Linux 允许名为 `a\b` 的目录），无脑替换会把真实路径改坏。
      const rel = relative(root, p)
      out.push({ path: process.platform === 'win32' ? rel.replace(/\\/g, '/') : rel, size })
    }
  }
  // 同层按路径短优先（越靠近根越可能是总览），BFS 已保证跨层有序。
  out.sort((a, b) => a.path.length - b.path.length)
  return out
}

// buildAiFillPrompt：组装发给 AI 的 system（含 README 内容 + 字段约束）。
export function buildAiFillPrompt(dir: string, readmeChunks: string[]): string {
  const docs = readmeChunks.length > 0
    ? readmeChunks.join('\n\n')
    : '（该目录下未选 README，按目录结构与常见配置文件推断）'
  return `你是 polycode-hub 项目板块的录入助手。根据下面这个本机项目目录的 README 与结构，输出可直接导入的 JSON。

项目目录：${dir}

${docs}

只输出 JSON，不要解释。单个对象或数组都行，字段如下：
- name：项目名（必填，用目录名即可）
- services：数组（必填，至少一个），每项：
  name（服务名，必填）、dir（工作目录，必填，上面给的目录或其子目录）、cmd（启动命令，必填，从 README/配置里找）、
  port（端口数字，0=不检测）、portEnv（端口变量，选填，如 PORT）、maxRuntimeHours（最长运行小时，0=不限）`
}

// gatewayComplete：调本网关 chat/completions 非流式拿全文。
async function gatewayComplete(base: string, model: string, system: string): Promise<string> {
  const r = await fetch(`${base.replace(/\/+$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: '请输出该项目的导入 JSON。' },
      ],
    }),
  })
  if (!r.ok) throw new Error(`网关 ${r.status}`)
  const data = await r.json() as { choices?: { message?: { content?: string } }[] }
  const text = data.choices?.[0]?.message?.content ?? ''
  if (!text) throw new Error('网关返回为空')
  return text
}

// extractJSON：从 AI 回复里抠 JSON（``` 包裹或首个 {/[ 到末尾配对 ]/}）。
export function extractJSON(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) return fenced[1].trim()
  const start = text.search(/[{[]/)
  if (start < 0) return text.trim()
  return text.slice(start).trim()
}

async function handleLogs(c: Context, m: Manager, isDelete: boolean): Promise<Response> {
  const id = c.req.param('id')!
  const service = c.req.query('service')
  if (!service) return err(c, 400, '须指定 service')
  const path = m.store.logPath(id, service)
  if (isDelete) {
    try {
      truncateSync(path, 0)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') return err(c, 500, (e as Error).message)
    }
    return c.json({ ok: true })
  }
  // 1k 条滑动窗口：环形读——从文件尾往前扫块，只读够 tail 行需要的字节，
  // 而不是全量读进内存再 slice。Vite 热更新日志几十万行是常态，全量读会卡死事件循环。
  // 默认 1000；tail<=0 或非法回落 1000；上限 5000（防一次拖走几十 MB）。
  const raw = Number(c.req.query('tail'))
  const tail = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 5000) : 1000
  const r = readTailLines(path, tail)
  return c.json({ log: r.text, tail, truncated: r.truncated })
}

// readTailLines 从文件尾往前取最后 maxLines 行。
// 实现：按 64KB 块从尾向前读，数 '\n'，凑够 maxLines+1 个换行即停（多一个用来
// 确认"前面还有"。返回 {text, truncated}：truncated=true 表示文件里还有更早的行没显示。
// 文件不存在/空/目录/权限等问题 → 空（与旧行为一致：日志缺失不算 500）。
export function readTailLines(path: string, maxLines: number): { text: string; truncated: boolean } {
  if (!Number.isInteger(maxLines) || maxLines <= 0) return { text: '', truncated: false }
  let fd = -1
  try {
    const st = statSync(path)
    if (!st.isFile() || st.size === 0) return { text: '', truncated: false }
    fd = openSync(path, 'r')
    const CHUNK = 64 * 1024
    const buf = Buffer.alloc(CHUNK)
    let pos = st.size // 已读区间 [pos, size)
    const chunks: Buffer[] = []
    let newlines = 0
    while (pos > 0 && newlines <= maxLines) {
      const len = Math.min(CHUNK, pos)
      const n = readSync(fd, buf, 0, len, pos - len)
      if (n <= 0) break
      // 必须拷贝：subarray 与 buf 共享内存，下一次 readSync 会把它覆盖。
      chunks.unshift(Buffer.from(buf.subarray(0, n)))
      for (let i = n - 1; i >= 0 && newlines <= maxLines; i--) {
        if (buf[i] === 0x0a) newlines++
      }
      pos -= n
    }
    const text = Buffer.concat(chunks).toString('utf8')
    // 尾换行不计一行（与旧 `replace(/\n$/,'')` 语义对齐：`a\n` 与 `a` 都是 1 行）。
    const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
    const lines = stripped === '' ? [] : stripped.split('\n')
    const out = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines
    // pos>0 说明文件头没读完 → 一定还有更早的行；读完则按实际行数判。
    const truncated = pos > 0 || lines.length > maxLines
    return { text: out.join('\n'), truncated }
  } catch {
    return { text: '', truncated: false }
  } finally {
    if (fd >= 0) try { closeSync(fd) } catch { /* 已关闭 */ }
  }
}
