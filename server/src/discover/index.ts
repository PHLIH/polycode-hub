// 发现本机 coding agent 客户端的安装与登录痕迹（对齐 Go internal/discover）。
// 路径表按 goos 参数生成（darwin/linux/windows），一律可注入，测试不依赖运行环境。
// 报告永不含密钥原文。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Provider } from '../model/index.ts'
import type { Finding } from '../adminapi/types.ts'

// 状态枚举的唯一定义是 adminapi/types.ts 的 DiscoverStatus（Finding.status 用的就是它）。
// 这里曾另有一份等价的 `export type Status`——与下面 Finding 的教训同源：
// 类型留两处迟早漂移，已删除；需要时请从 adminapi/types.ts 引入。

// Finding 的唯一定义在 adminapi/types.ts（发现层要产出、管理面要消费、前端要渲染）。
// 这里曾各自定义一份，结果 adoptedProviderId 一边是 string 一边是 number 悄悄漂移，
// 前端把 Provider 内部 id 当名字渲染成「已由 Provider「3」接管」。类型只留一处。
export type { Finding }

// 从客户端本地发现的单个登录态（脱敏，不含 token 本体）。
export interface DiscoveredAccount {
  nickname: string // 账号昵称/邮箱
  uid: string // 短 UID（脱敏）
  type?: string // personal / enterprise
  alive: boolean // token 未过期
  expiresAt?: string // ISO 时间（本地）
  tokenPath: string // 登录态文件路径（导出凭据用）
}

export type FetchLike = typeof fetch

// 检查结果：finding + 是否有可用登录态。
// 仅供本模块内部与测试使用——不从包边界导出，导出会让人误以为它是公共契约
// （实际调用方都按结构解构，从没标注过这个类型）。
interface Checked {
  finding: Finding
  ok: boolean // false = 无可用登录态
}

// ---- WorkBuddy / CodeBuddy（桌面登录态复用） ----

// auth 文件候选路径（env 覆盖优先，不区分设备）。
//
// 路径不是“写死某台机器”：一律用 USERPROFILE / HOME + AppData 拼接，换用户照样命中。
// Windows 必须同时覆盖 Local 与 Roaming：实测登录态落在
// `%USERPROFILE%\AppData\Local\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`
// （此前只扫了 Roaming，Local 的号一律报 missing）。
// 另认 APPDATA / LOCALAPPDATA / XDG_CONFIG_HOME（重定向文件夹/漫游策略下 join 出来的
// 默认路径可能是错的，环境变量才是真相源），以及 CODEBUDDY_DESKTOP_AUTH_DIR 兜底。
export function workBuddySearchPaths(
  goos: string, home: string, winProfile: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const custom = env.CODEBUDDY_DESKTOP_AUTH_FILE
  if (custom) return [custom]
  const extraDir = env.CODEBUDDY_DESKTOP_AUTH_DIR
  const extra = extraDir ? [join(extraDir, 'workbuddy-desktop.info')] : []
  if (goos === 'windows') {
    const bases: string[] = []
    const pushBase = (b: string | undefined) => { if (b && !bases.includes(b)) bases.push(b) }
    // 环境变量优先（文件夹重定向时最准），join 兜底（变量缺失时）。
    pushBase(env.LOCALAPPDATA)
    pushBase(join(winProfile, 'AppData', 'Local'))
    pushBase(env.APPDATA)
    pushBase(join(winProfile, 'AppData', 'Roaming'))
    const out = [
      ...bases.map((b) => join(b, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')),
      join(winProfile, '.workbuddy', 'auth', 'workbuddy-desktop.info'),
      join(winProfile, '.config', 'workbuddy', 'auth', 'workbuddy-desktop.info'),
      ...extra,
    ]
    return [...new Set(out)]
  }
  if (goos === 'linux') {
    const xdg = env.XDG_CONFIG_HOME || join(home, '.config')
    return [...new Set([
      join(xdg, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
      // XDG 被改掉时仍保留默认位（双保险，不差这一次 stat）。
      ...(xdg !== join(home, '.config')
        ? [join(home, '.config', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')]
        : []),
      join(home, '.workbuddy', 'auth', 'workbuddy-desktop.info'),
      join(home, '.config', 'workbuddy', 'auth', 'workbuddy-desktop.info'),
      ...extra,
    ])]
  }
  // darwin 及其他类 Unix
  return [...new Set([
    join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
    join(home, '.workbuddy', 'auth', 'workbuddy-desktop.info'),
    join(home, '.config', 'workbuddy', 'auth', 'workbuddy-desktop.info'),
    ...extra,
  ])]
}

// auth 目录候选（多账号发现按目录扫全部共存登录态），从文件候选的 Dir 部分去重即得。
// CODEBUDDY_DESKTOP_AUTH_FILE 若指向目录本身（用户把目录配进来），直接把该目录纳入扫描，
// 而不是取它的 Dir（否则扫到父目录去，永远找不到）。
export function workBuddyAuthDirs(
  goos: string, home: string, winProfile: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return workBuddyAuthDirsFromPaths(workBuddySearchPaths(goos, home, winProfile, env), env)
}

export function workBuddyAuthDirsFromPaths(paths: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = []
  const push = (d: string) => { if (d && !dirs.includes(d)) dirs.push(d) }
  for (const p of paths) {
    // env 指向的目录本身：直接纳入（用户把目录配进 CODEBUDDY_DESKTOP_AUTH_FILE 时）。
    // 用后缀判断而不是 stat：路径表生成阶段不做 IO（见 defaultConfig 注释）。
    if (p === env.CODEBUDDY_DESKTOP_AUTH_FILE && !p.endsWith('.info') && !p.endsWith('.json')) {
      push(p)
      continue
    }
    push(dirname(p))
  }
  return dirs
}

// 智能兜底：候选全 miss 时，按“文件名”在桌面扩展数据根下递归找 workbuddy-desktop*.info。
// 覆盖“版本号导致中间目录改名 / 装到 D 盘 / 便携版”等长尾：路径表再全也有漏网时。
// 只在全 miss 时触发（平时不走，避免每次 scan 都全盘递归）。上限 200 文件即停。
// roots：各平台的扩展数据根（如 %LOCALAPPDATA%\CodeBuddyExtension、%APPDATA%\CodeBuddyExtension）。
export function searchWorkBuddyAuthFiles(roots: string[], limit = 200): string[] {
  const out: string[] = []
  const seenDirs = new Set<string>()
  const queue: string[] = []
  for (const r of roots) {
    if (!r || seenDirs.has(r)) continue
    seenDirs.add(r)
    queue.push(r)
  }
  while (queue.length > 0 && out.length < limit) {
    const dir = queue.shift()!
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (out.length >= limit) break
      const p = join(dir, name)
      let isDir = false
      try {
        isDir = statSync(p).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        if (!seenDirs.has(p)) {
          seenDirs.add(p)
          queue.push(p)
        }
        continue
      }
      if (name.startsWith('workbuddy-desktop') && name.endsWith('.info')) out.push(p)
    }
  }
  return out
}

// 各平台的扩展数据根（智能兜底的递归起点）。winProfile = USERPROFILE。
export function workBuddyDataRoots(goos: string, home: string, winProfile: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (goos === 'windows') {
    const out: string[] = []
    const push = (v: string | undefined) => { if (v && !out.includes(v)) out.push(v) }
    // 先放明确的扩展根（少一层递归），再放 AppData 级（兜底装到别处的情况）。
    if (env.LOCALAPPDATA) push(join(env.LOCALAPPDATA, 'CodeBuddyExtension'))
    push(join(winProfile, 'AppData', 'Local', 'CodeBuddyExtension'))
    if (env.APPDATA) push(join(env.APPDATA, 'CodeBuddyExtension'))
    push(join(winProfile, 'AppData', 'Roaming', 'CodeBuddyExtension'))
    if (env.LOCALAPPDATA) push(env.LOCALAPPDATA)
    push(join(winProfile, 'AppData', 'Local'))
    return out
  }
  if (goos === 'linux') {
    const xdg = env.XDG_CONFIG_HOME || join(home, '.config')
    return [join(xdg, 'CodeBuddyExtension'), join(home, '.config', 'CodeBuddyExtension')]
  }
  return [join(home, 'Library', 'Application Support', 'CodeBuddyExtension')]
}

// ZCode 安装目录候选（存在即视为已安装）。
export function zCodeSearchDirs(goos: string, home: string, winProfile: string): string[] {
  if (goos === 'windows') return [join(winProfile, 'AppData', 'Roaming', 'ZCode')]
  if (goos === 'linux') return [join(home, '.config', 'ZCode')]
  return [join(home, 'Library', 'Application Support', 'ZCode')]
}

// ---- 小件 ----

interface WbAuthFile {
  auth?: { accessToken?: string; tokenType?: string; domain?: string }
  account?: { uid?: string; nickname?: string; type?: string }
}

function parseAuthFile(raw: string): WbAuthFile | null {
  try {
    const f = JSON.parse(raw) as WbAuthFile
    if (!f.auth?.accessToken) return null
    return f
  } catch {
    return null
  }
}

// 解 JWT exp（不验签）；解析不出返回 null。
export function jwtExpiry(token: string): Date | null {
  const parts = token.split('.')
  if (parts.length < 2 || !parts[1]) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: number }
    if (!claims.exp) return null
    return new Date(claims.exp * 1000)
  } catch {
    return null
  }
}

// 脱敏截断。
function shortID(id: string): string {
  if (id.length <= 8) return id
  return id.slice(0, 4) + '…' + id.slice(-4)
}

function fmtLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ---- WorkBuddy 检查 ----

function wbSuggestedProvider(): Provider {
  return {
    providerId: 0, name: 'workbuddy', state: 'active' as const, displayName: 'WorkBuddy（自动发现）',
    accessKind: 'session-reuse', risk: 'medium',
    riskNote: '复用本机桌面登录态；只走流式；不要并发压测',
    stability: 'beta', api: 'openai-completions',
    baseUrl: 'https://copilot.tencent.com/v2',
    credential: { apiKeyEnv: 'WB_TOKEN' },
    headers: { 'X-Product': 'SaaS', 'X-Domain': 'copilot.tencent.com' },
    // WorkBuddy 上游对非流式直接回 404 Route Not Found（实测）。
    // 声明它，非流式调用才能命中 proxy 里那段「只支持流式」的专门提示，
    // 而不是让用户照着「没有声明模型」去核对模型列表（永远查不出所以然）。
    streamOnly: true,
    priority: 1,
    // 模型目录留空，**不预填猜的模型名**。
    //
    // 曾经这里写死 'hy3-preview'，代价是双重的：
    //   ① 用户按上游真实模型名（如 hy4-preview）调用 → 404「没有声明模型」；
    //   ② 而那个占位名有时上游还认，调用居然出字 → 用户以为配好了，
    //      实际用的是一个自己没验证过、随时可能消失的模型名。②比①更难发现。
    // WorkBuddy 没有模型列表接口，真实模型要从本机 traces 痕迹扫（见
    // cli.ts 注入的 discoverLocal）+ 用户实测确认，不能由网关代替猜测。
    // 真实目录由「一键导入」时自动扫描补全（见 discover_api.quick-import）。
    // providerId 由存储层在建 Provider 时分配（此处占位 0）
    models: [],
  }
}

// 逐个试候选路径，首个有效文件即返回（ok=true 表示找到登录态文件，
// 可用性看 status：ready 才可用，expired/unknown 仅表示文件存在）。
export function checkWorkBuddy(paths: string[]): Checked {
  const base: Finding = {
    key: 'workbuddy', harness: 'WorkBuddy / CodeBuddy',
    suggestedProvider: wbSuggestedProvider(),
  }
  for (const path of paths) {
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const f = parseAuthFile(raw)
    if (!f || !f.auth?.accessToken) continue
    const exp = jwtExpiry(f.auth.accessToken)
    const nick = f.account?.nickname?.trim() || '未知用户'
    base.detail = `${nick} · ${f.account?.type ?? ''} · ${path}`
    base.actions = [
      `export WB_TOKEN=$(python3 -c "import json;print(json.load(open('${path}'))['auth']['accessToken'])")`,
      '然后在发现页点「采用」，或确认 WB_TOKEN 后重试',
    ]
    // 多账号发现：客户端切号会把旧登录态另存为带时间戳的副本，同机多账号天然共存。
    const accts = discoverWorkBuddyAccounts(dirname(path))
    if (accts.length > 0) {
      base.suggestedAccounts = accts
      if (accts.length > 1) {
        const alive = accts.filter((a) => a.alive).length
        base.detail += ` · 另发现 ${accts.length - 1} 个共存登录态（${alive} 个有效）`
        base.actions = ['发现页可查看全部共存账号，逐个导出进账号池', ...base.actions]
      }
    }
    if (!exp) {
      base.status = 'unknown'
      base.detail += ' · token 有效期不明'
      return { finding: base, ok: true }
    }
    if (Date.now() > exp.getTime()) {
      base.status = 'expired'
      base.detail += ' · 已过期'
      base.actions = ['重新登录 WorkBuddy 桌面端以刷新登录态', ...base.actions]
      return { finding: base, ok: true }
    }
    base.status = 'ready'
    base.detail += ` · ${shortID(f.account?.uid ?? '')} · 剩余约 ${Math.round((exp.getTime() - Date.now()) / 3600_000)}h`
    return { finding: base, ok: true }
  }
  return { finding: { key: 'workbuddy', harness: 'WorkBuddy / CodeBuddy', status: 'missing' }, ok: false }
}

// 多账号版：文件候选定位当前登录态，目录候选补扫全部共存登录态。
// fallbackRoots 非空时启用智能兜底：候选路径 + 目录全 miss 才按文件名递归找
// （见 searchWorkBuddyAuthFiles）。命中后把真实路径回显，用户能直接照着配环境变量。
export function checkWorkBuddyWithAccounts(
  paths: string[], authDirs: string[], fallbackRoots: string[] = [],
): Checked {
  let { finding: f, ok } = checkWorkBuddy(paths)
  // 智能兜底：候选全 miss（含“文件不存在”与“都是坏文件”）时才递归；找到即当候选重跑。
  // 注意是「目录候选也没扫出账号」才兜底——目录扫出来说明路径表已经对了。
  // 另外 expired 也兜一次：主候选可能是个过期旧文件，而真正在用的登录态在
  // 路径表没覆盖的目录（多账号/换过安装位置），此时直接报 expired 会误导用户去重新登录。
  const worthFallback = !ok || f.status === 'expired'
  if (worthFallback && !hasAccounts(authDirs)) {
    const found = searchWorkBuddyAuthFiles(fallbackRoots)
    if (found.length > 0) {
      const r = checkWorkBuddy(found)
      // 只在兜底结果确实更好时才采用它：
      //   原本没有登录态（!ok）→ 兜底找到任何可用文件都算改进；
      //   原本是 expired     → 只有兜底拿到 ready 才算改进（否则原文案更贴近主候选）。
      const better = r.ok && (!ok || r.finding.status === 'ready')
      if (better) {
        f = r.finding
        f.detail = (f.detail ?? '') + ` · 智能兜底定位（配置里没登记的路径）`
        f.actions = [
          `建议把登录态目录加进 CODEBUDDY_DESKTOP_AUTH_DIR，避免每次全盘扫描`,
          ...(f.actions ?? []),
        ]
        ok = true
      }
    }
  }
  if (!ok || !f.suggestedAccounts) {
    for (const d of authDirs) {
      const accts = discoverWorkBuddyAccounts(d)
      if (accts.length > 0) {
        f.suggestedAccounts = accts
        if (accts.length > 1) {
          const alive = accts.filter((a) => a.alive).length
          f.detail = (f.detail ?? '') + ` · 共存登录态 ${accts.length} 个（${alive} 个有效）`
        }
        break
      }
    }
  }
  return { finding: f, ok }
}

// 目录候选里是否已有可读登录态（决定要不要走智能兜底）。
function hasAccounts(dirs: string[]): boolean {
  for (const d of dirs) {
    if (discoverWorkBuddyAccounts(d).length > 0) return true
  }
  return false
}

// ---- ZCode（仅装机提示，JWT 不落本地可读存储） ----

// 装机即 unknown + OAuth 指引；未发现安装目录则 missing。
// 登录态无法本地判定（JWT 不落可读存储）。
export function checkZCode(dirs: string[]): Finding {
  const f: Finding = { key: 'zcode', harness: 'ZCode' }
  for (const d of dirs) {
    try {
      if (statSync(d).isDirectory()) {
        f.status = 'unknown'
        f.detail = '已安装；登录态无法本地判定（JWT 不落可读存储）'
        f.actions = ['用 polycode-hub zcode login 走 OAuth 登录后手动填 JWT']
        return f
      }
    } catch {
      // 缺失继续
    }
  }
  f.status = 'missing'
  f.detail = '未发现安装目录'
  return f
}

// ---- OpenCode Zen（连通性探针，无需凭据） ----

function zenSuggestedProvider(baseURL: string): Provider {
  return {
    providerId: 0, name: 'opencode', state: 'active' as const, displayName: 'Zen免费档（自动发现）',
    accessKind: 'reverse', risk: 'high',
    riskNote: '逆向客户端指纹；免费档按 IP 限速；非 opencode 客户端需在头里配一个真实 ses_ 会话（opencode run --print-logs 取 created id=），opencode 做客户端时自动透传',
    stability: 'beta', api: 'openai-completions',
    baseUrl: baseURL.replace(/\/+$/, '') + '/v1',
    credential: { apiKeyEnv: 'ZEN_KEY' },
    headers: {
      // 指纹靠「诚实透传 + 配置兜底」，草稿里不预填任何 UA（网关不内置版本号）：
      // opencode 做客户端时自动透传它的真 UA；其他客户端经网关调用时，
      // 在 Provider 头里配一个自己抓包取的真串，或设 ZEN_UA 环境变量。
      // 会话头同样优先透传客户端的；其他客户端经网关调用时用这里配的静态值。
      // 不要加 x-opencode-*（毒头，见 upstream.applyZenFingerprint）。
    },
    priority: 1,
    models: [
      // 协议不是「一个 Provider 一刀切」：zen 的 muse-spark 系只认 /responses，
      // 走 /chat/completions 上游直接 500（实测）。草稿里就把它标成 openai-responses，
      // 免得全部继承 Provider 级 openai-completions 后逐个踩坑。
      { id: 'mimo-v2.5-free', manual: false, enabled: true },
      { id: 'nemotron-3-ultra-free', manual: false, enabled: true },
      { id: 'muse-spark-1.3-contributor-free', api: 'openai-responses', manual: false, enabled: true },
      { id: 'union-alpha', manual: false, enabled: true },
    ],
  }
}

// 免费档名字启发式（与 model.looksFree 同口径，但不引 model 包以免依赖环）：
// 命名约定是唯一线索，要求独立词段（freeform 不判免费），误判比漏报安全。
const ZEN_FREE_MARKERS = ['free', 'contributor', 'trial']
function looksFreeName(id: string): boolean {
  return id.toLowerCase().split(/[-_./: \t]+/).some((seg) => ZEN_FREE_MARKERS.includes(seg))
}

// 探 /v1/models（免指纹）+ 一次最小真实调用（带指纹，验「真能调」）。
//
// 为什么必须补第二步：GET /v1/models 对 zen 免费档是**免指纹**端点，71 个模型全列出
// 只证明「网络通」，不证明「能调用」——缺 UA/会话指纹时它会照样 200，而真正的
// chat/completions 回 403 FreeTierError（"can only be used from within OpenCode"）。
// 旧实现因此把「探得到模型」当成 ready，一路绿灯到用户手里才炸，是典型的假阳性。
//
// 现在 ready 的定义收紧为「列表可达 + 至少一个免费模型可真实调用」；
// 列表通但调用 403 指纹错 → 仍报 unreachable 并点名缺指纹（不让它冒充 ready）。
// callable：注入的「真调一次」实现（cli 侧走真实 Upstream；测试注入桩）。
// 缺省不测调用（只做列表探测），保持既有调用方与单测契约不变。
export type ZenCallProbe = (model: string) => Promise<{ ok: boolean; error?: string; kind?: string }>

export async function checkZen(
  baseURL: string, fetchImpl: FetchLike, timeoutMs = 8000, callProbe?: ZenCallProbe,
): Promise<Finding> {
  const f: Finding = {
    key: 'opencode-zen', harness: 'OpenCode Zen',
    suggestedProvider: zenSuggestedProvider(baseURL),
  }
  let res: Response
  try {
    res = await fetchImpl(baseURL.replace(/\/+$/, '') + '/v1/models', {
      headers: { Authorization: 'Bearer public' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    f.status = 'unreachable'
    f.detail = '网络不可达: ' + (err as Error).message
    return f
  }
  if (res.status !== 200) {
    f.status = 'unreachable'
    f.detail = `http ${res.status}`
    return f
  }
  let list: { data?: { id?: string }[] }
  try {
    list = JSON.parse(await res.text()) as { data?: { id?: string }[] }
  } catch {
    f.status = 'unreachable'
    f.detail = '模型列表解析失败'
    return f
  }
  const ids = (list.data ?? []).map((d) => d.id).filter((x): x is string => !!x)
  if (!callProbe) {
    f.status = 'ready'
    f.detail = `连通，${ids.length} 个模型（export ZEN_KEY=public 后采用）`
    f.actions = ['export ZEN_KEY=public', '然后在发现页点「采用」']
    return f
  }
  // 真实调用验证：优先免费档模型（免费档才是本 Provider 的目标）。
  // 本地判免费（不引 gateway/probe：发现层不该依赖网关层，避免反向依赖环）。
  const cands = ids.filter((id) => looksFreeName(id))
  const probeModel = cands[0] ?? ids[0]
  if (!probeModel) {
    f.status = 'unreachable'
    f.detail = `连通，但模型列表为空（${ids.length} 个），无法验证可调用性`
    return f
  }
  const r = await callProbe(probeModel)
  if (r.ok) {
    f.status = 'ready'
    f.detail = `连通，${ids.length} 个模型，实测 ${probeModel} 可调用`
    f.actions = ['export ZEN_KEY=public', '然后在发现页点「采用」']
    return f
  }
  // 列表通但调用失败：不再冒充 ready。指纹错单独点名（这是最常见的一种）。
  f.status = 'unreachable'
  if (r.kind === 'fingerprint' || /free tier can only be used/i.test(r.error ?? '')) {
    f.detail = `模型列表可达（${ids.length} 个），但真实调用被拒：缺少客户端指纹（${probeModel}）`
    f.actions = [
      '免费档只认官方客户端指纹：在 Provider 头里配 User-Agent（抓包取 opencode 真串）与 x-session-id/x-session-affinity（真实 ses_）',
      '或设 ZEN_UA 环境变量；用 opencode 做客户端时自动透传，无需配置',
      '否则改用付费档凭据',
    ]
  } else {
    f.detail = `模型列表可达（${ids.length} 个），但真实调用失败：${r.error ?? '未知原因'}`
    f.actions = ['检查 Provider 协议与模型 ID 是否正确', '到 Providers 页用「测试」逐个排查']
  }
  return f
}

// ---- WorkBuddy 多账号发现 ----

interface Acct extends DiscoveredAccount {
  modified: Date // 文件修改时间（同账号取最新）
  exp: Date | null // token 过期时间（去重平手时比较用）
}

// 扫描 WorkBuddy 登录态目录，返回全部可读的账号登录态。
// 同一账号（按 UID）取修改时间最新的一份，不同账号各自成条目。
// dir 为 auth 文件所在目录；目录不存在/不可读时返回空（尽力而为，不报错）。
export function discoverWorkBuddyAccounts(dir: string): DiscoveredAccount[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const byUID = new Map<string, Acct>()
  for (const name of names) {
    if (!name.startsWith('workbuddy-desktop') || !name.endsWith('.info')) continue
    let raw: string
    try {
      raw = readFileSync(join(dir, name), 'utf8')
    } catch {
      continue
    }
    const f = parseAuthFile(raw)
    if (!f || !f.auth?.accessToken) continue
    const nick = f.account?.nickname?.trim() || '未知用户'
    let uid = f.account?.uid?.trim() ?? ''
    if (!uid) uid = nick // 无 UID 时按昵称去重
    let mod = new Date(0)
    try {
      mod = statSync(join(dir, name)).mtime
    } catch {
      // 取不到 mtime 用零值（不影响去重主键）
    }
    const exp = jwtExpiry(f.auth.accessToken)
    const alive = exp !== null && Date.now() < exp.getTime()
    const prev = byUID.get(uid)
    if (prev) {
      // 同账号去重：取「更新」的一份。mtime 平手（同秒批量写入很常见）时
      // 比 token 过期时间——那是客户端写快照时的真实业务事实。
      if (mod.getTime() > prev.modified.getTime()) {
        // 新文件胜出，继续
      } else if (mod.getTime() === prev.modified.getTime()) {
        if (!exp || !prev.exp || exp.getTime() <= prev.exp.getTime()) continue
      } else {
        continue
      }
    }
    byUID.set(uid, {
      nickname: nick, uid: shortID(uid), type: f.account?.type, alive,
      tokenPath: join(dir, name), modified: mod, exp,
      expiresAt: exp ? fmtLocal(exp) : undefined,
    })
  }
  const out = [...byUID.values()]
  out.sort((x, y) => {
    if (x.alive !== y.alive) return x.alive ? -1 : 1 // 活的排前
    return y.modified.getTime() - x.modified.getTime()
  })
  return out.map(({ modified: _m, exp: _e, ...rest }) => rest)
}

// ---- WorkBuddy 模型发现 ----

// 上游没有模型列表接口，但客户端会把每次会话实际用过的模型写进本地
// trace 的 modelInfo.models。用正则取片段而非完整解析：trace 可达数百 KB
// 且结构可能带非标准扩展。
const WB_MODELS_RE = /"models"\s*:\s*\[([^\]]*)\]/g
const WB_QUOTED_RE = /"([^"]+)"/g

// 扫描客户端数据根目录（如 ~/.workbuddy）的 traces，返回实际用过的模型 ID（去重升序）。
// 目录不存在或无痕迹时返回空，不报错。
export function discoverWorkBuddyModels(dir: string): string[] {
  if (!dir) return []
  const seen = new Set<string>()
  walkJSON(join(dir, 'traces'), seen)
  return [...seen].sort()
}

// 客户端数据根候选（多平台）：调用方逐个扫并合并。
// 此前 CLI 只扫 $HOME/.workbuddy —— Windows 没有 HOME（是 USERPROFILE），
// 且桌面端在 Windows 把数据放在 AppData 下，于是痕迹发现恒为空。
export function workBuddyDataDirs(goos: string, home: string, winProfile: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = []
  const push = (d: string | undefined) => { if (d && !out.includes(d)) out.push(d) }
  if (goos === 'windows') {
    if (env.LOCALAPPDATA) push(join(env.LOCALAPPDATA, 'CodeBuddyExtension'))
    push(join(winProfile, 'AppData', 'Local', 'CodeBuddyExtension'))
    if (env.APPDATA) push(join(env.APPDATA, 'CodeBuddyExtension'))
    push(join(winProfile, 'AppData', 'Roaming', 'CodeBuddyExtension'))
    push(join(winProfile, '.workbuddy'))
    push(join(winProfile, '.config', 'workbuddy'))
    return out
  }
  const xdg = env.XDG_CONFIG_HOME || join(home, '.config')
  push(join(home, '.workbuddy'))
  push(join(xdg, 'CodeBuddyExtension'))
  push(join(home, '.config', 'workbuddy'))
  if (goos !== 'linux') push(join(home, 'Library', 'Application Support', 'CodeBuddyExtension'))
  return out
}

// 合并多个数据根的模型痕迹（去重升序）。空输入返回空。
export function discoverWorkBuddyModelsFrom(dirs: string[]): string[] {
  const seen = new Set<string>()
  for (const d of dirs) {
    for (const id of discoverWorkBuddyModels(d)) seen.add(id)
  }
  return [...seen].sort()
}

function walkJSON(dir: string, seen: Set<string>): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return // 权限/缺失一律跳过：发现是尽力而为
  }
  for (const name of names) {
    const p = join(dir, name)
    let isDir = false
    try {
      isDir = statSync(p).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      walkJSON(p, seen)
      continue
    }
    if (!name.endsWith('.json')) continue
    let raw: string
    try {
      raw = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    for (const m of raw.matchAll(WB_MODELS_RE)) {
      for (const q of m[1]?.matchAll(WB_QUOTED_RE) ?? []) {
        const id = q[1]?.trim()
        if (id) seen.add(id)
      }
    }
  }
}

// ---- Scanner（聚合；调用方按平台给路径） ----

export interface ScanConfig {
  workBuddyPaths?: string[]
  // auth 目录候选：多账号发现按目录扫全部共存登录态。
  // 空 = 从 workBuddyPaths 推导（Dir 部分），保持与文件候选同源。
  workBuddyAuthDirs?: string[]
  // 智能兜底递归起点（各平台扩展数据根）。空 = 不做兜底（测试默认，路径全显式）。
  workBuddyFallbackRoots?: string[]
  zCodeDirs?: string[]
  zenBaseURL?: string
  zenTimeoutMs?: number // <=0 用 8000
  fetchImpl?: FetchLike // 不填用全局 fetch
  // zen 可调用性验证（真打一次模型）。不填 = 只做列表探测（既有单测契约不变）。
  zenCallProbe?: ZenCallProbe
}

// 按本机平台生成默认输入（只生成路径表，不做 IO）。
// 注意 Node 是 "win32"，Go 是 "windows"，此处归一到 Go 词汇。
export function defaultConfig(): ScanConfig {
  const home = homedir()
  const goos = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const profile = goos === 'windows' ? (process.env.USERPROFILE || home) : home
  return {
    workBuddyPaths: workBuddySearchPaths(goos, home, profile),
    workBuddyAuthDirs: workBuddyAuthDirs(goos, home, profile),
    // 智能兜底起点：候选全 miss 时按文件名递归找（覆盖装到别处/目录改名）。
    workBuddyFallbackRoots: workBuddyDataRoots(goos, home, profile),
    zCodeDirs: zCodeSearchDirs(goos, home, profile),
    zenBaseURL: 'https://opencode.ai/zen',
  }
}

// 聚合三探针（zen 探针自带超时，不卡死）。
export class Scanner {
  private readonly cfg: ScanConfig
  private readonly wbDirs: string[]
  private readonly zenTimeoutMs: number

  constructor(cfg: ScanConfig) {
    this.cfg = cfg
    this.zenTimeoutMs = cfg.zenTimeoutMs && cfg.zenTimeoutMs > 0 ? cfg.zenTimeoutMs : 8000
    this.wbDirs = cfg.workBuddyAuthDirs && cfg.workBuddyAuthDirs.length > 0
      ? cfg.workBuddyAuthDirs
      : workBuddyAuthDirsFromPaths(cfg.workBuddyPaths ?? [])
  }

  async scan(): Promise<Finding[]> {
    const out: Finding[] = []
    const { finding: wb, ok } = checkWorkBuddyWithAccounts(
      this.cfg.workBuddyPaths ?? [], this.wbDirs, this.cfg.workBuddyFallbackRoots ?? [])
    if (ok) {
      out.push(wb)
    } else {
      wb.status = 'missing'
      wb.detail = '未发现桌面登录态'
      wb.actions = ['登录 WorkBuddy 桌面端后重扫']
      out.push(wb)
    }
    out.push(checkZCode(this.cfg.zCodeDirs ?? []))
    out.push(await checkZen(
      this.cfg.zenBaseURL ?? 'https://opencode.ai/zen',
      this.cfg.fetchImpl ?? globalThis.fetch,
      this.zenTimeoutMs,
      this.cfg.zenCallProbe,
    ))
    return out
  }
}
