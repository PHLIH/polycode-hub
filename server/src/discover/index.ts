// 发现本机 coding agent 客户端的安装与登录痕迹（对齐 Go internal/discover）。
// 路径表按 goos 参数生成（darwin/linux/windows），一律可注入，测试不依赖运行环境。
// 报告永不含密钥原文。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Provider } from '../model/index.ts'
import { mintZenRequestId, wbAuxEndpointIdentityHeaders, workBuddyRealmOfIssuer } from '../model/index.ts'
import type { Finding } from '../adminapi/types.ts'

// 状态枚举的唯一定义是 adminapi/types.ts 的 DiscoverStatus（Finding.status 用的就是它）。
// 这里曾另有一份等价的 `export type Status`——与下面 Finding 的教训同源：
// 类型留两处迟早漂移，已删除；需要时请从 adminapi/types.ts 引入。

// Finding 的唯一定义在 adminapi/types.ts（发现层要产出、管理面要消费、前端要渲染）。
// 这里曾各自定义一份，结果 adoptedProviderId 一边是 string 一边是 number 悄悄漂移，
// 前端把 Provider 内部 id 当名字渲染成「已由 Provider「3」接管」。类型只留一处。
export type { Finding }

// 从客户端本地发现的单个登录态（脱敏，不含 token 本体）。
//
// 唯一定义在 adminapi/types.ts：发现层产出、管理面消费、前端渲染。这里曾经
// 各留一份，加 realm 字段时立刻漂移（本地这份没跟上，类型报错才发现）。
// 与上面 Finding 的教训同源——类型只留一处。
export type { DiscoveredAccount } from '../adminapi/types.ts'
import type { DiscoveredAccount } from '../adminapi/types.ts'

export type FetchLike = typeof fetch

// 检查结果：finding + 是否有可用登录态。
// 仅供本模块内部与测试使用——不从包边界导出，导出会让人误以为它是公共契约
// （实际调用方都按结构解构，从没标注过这个类型）。
interface Checked {
  finding: Finding
  ok: boolean // false = 无可用登录态
}

// ---- WorkBuddy / CodeBuddy（桌面登录态复用） ----

// ---- WorkBuddy 双版本（国内版 / 海外版） ----
//
// 桌面端有两个发行版，**登录态文件与认证域都不同**，token 互不通用：
//
//   国内版  workbuddy-desktop.info     realm www.workbuddy.cn   上游 copilot.tencent.com
//   海外版  workbuddy-desktop-ai.info  realm www.workbuddy.ai   上游 www.workbuddy.ai
//
// 两者 JWT 的 iss 分别是 https://www.workbuddy.cn/auth/realms/copilot 与
// https://www.workbuddy.ai/auth/realms/copilot —— realm 同名但 issuer 不同。
// 把海外版的 token 打到 copilot.tencent.com 会被前置 APISIX 拦成 HTML 401
// 「Authorization Required」（看起来像账号失效，其实只是域名不对）。
//
// 所以版本必须是一个**显式标识**：发现层要认全两个文件名，并把它一路带到
// Provider 草稿（baseUrl / X-Domain 由它派生），否则导入哪个版本都打到国内域名。
export type WbRealm = 'cn' | 'ai'

// 各版本的发行标识：文件名后缀 + 认证域。顺序即「同名冲突时的优先顺序」（国内版在前，
// 因为无后缀的 workbuddy-desktop.info 在老机器上是主文件）。
export const WB_REALMS: readonly { realm: WbRealm; suffix: string; label: string; issuer: string; upstream: string }[] = [
  { realm: 'cn', suffix: '', label: '国内版', issuer: 'www.workbuddy.cn', upstream: 'copilot.tencent.com' },
  { realm: 'ai', suffix: '-ai', label: '海外版', issuer: 'www.workbuddy.ai', upstream: 'www.workbuddy.ai' },
] as const

// 某版本的登录态文件名（suffix 为空时就是历史主文件名 workbuddy-desktop.info，
// 保持向后兼容——老机器上国内版仍叫这个名字）。
export function wbAuthFileName(realm: WbRealm): string {
  const r = WB_REALMS.find((x) => x.realm === realm)
  return `workbuddy-desktop${r?.suffix ?? ''}.info`
}

// 从登录态文件内容判定版本（两条独立证据，优先级固定）：
//
//   ① auth.domain —— 客户端自己写的认证域，最直接（www.workbuddy.ai / www.workbuddy.cn）。
//   ② JWT 的 iss —— 兜底。旧版本客户端不一定写 domain，但 token 一定带 issuer。
//
// 都取不到返回 undefined：**不猜**。猜错会把海外版的号打进国内域名，正是本模块要修的故障。
export function detectRealmFromAuth(raw: string): WbRealm | undefined {
  let f: WbAuthFile | null = null
  try {
    const p: unknown = JSON.parse(raw)
    if (typeof p === 'object' && p !== null) f = p as WbAuthFile
  } catch {
    return undefined
  }
  const domain = f?.auth?.domain
  if (typeof domain === 'string' && domain.trim() !== '') {
    const hit = realmFromIssuer(domain)
    if (hit) return hit
  }
  const tok = f?.auth?.accessToken
  if (typeof tok === 'string' && tok !== '') {
    const iss = jwtIssuer(tok)
    if (iss) {
      const hit = realmFromIssuer(iss)
      if (hit) return hit
    }
  }
  return undefined
}

// 认证域/issuer → 版本。**唯一定义在 model/index.ts**（workBuddyRealmOfIssuer），
// 账号-Provider 一致性校验也要用它，两处各写一份迟早漂移。这里只做转出。
export const realmFromIssuer = workBuddyRealmOfIssuer

// 解 JWT 的 iss（不验签）；解析不出返回 null。
export function jwtIssuer(token: string): string | null {
  const parts = token.split('.')
  if (parts.length < 2 || !parts[1]) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { iss?: string }
    return typeof claims.iss === 'string' && claims.iss !== '' ? claims.iss : null
  } catch {
    return null
  }
}

// auth 文件候选路径（env 覆盖优先，不区分设备）。
//
// 路径不是“写死某台机器”：一律用 USERPROFILE / HOME + AppData 拼接，换用户照样命中。
// Windows 必须同时覆盖 Local 与 Roaming：实测登录态落在
// `%USERPROFILE%\AppData\Local\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`
// （此前只扫了 Roaming，Local 的号一律报 missing）。
// 另认 APPDATA / LOCALAPPDATA / XDG_CONFIG_HOME（重定向文件夹/漫游策略下 join 出来的
// 默认路径可能是错的，环境变量才是真相源），以及 CODEBUDDY_DESKTOP_AUTH_DIR 兜底。
//
// 每个基准目录下要展开**两个版本**的文件名（见 WB_REALMS）：此前只生成
// workbuddy-desktop.info，海外版的 workbuddy-desktop-ai.info 永远命中不了候选，
// 只能靠智能兜底递归时被当作「同源的另一个号」扫进来——版本信息就此丢失。
export function workBuddySearchPaths(
  goos: string, home: string, winProfile: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const custom = env.CODEBUDDY_DESKTOP_AUTH_FILE
  if (custom) return [custom]
  const extraDir = env.CODEBUDDY_DESKTOP_AUTH_DIR
  const names = WB_REALMS.map((r) => wbAuthFileName(r.realm))
  // 一个 auth 目录 → 该目录下全部版本的候选文件。
  const expand = (dir: string): string[] => names.map((n) => join(dir, n))
  const extra = extraDir ? expand(extraDir) : []
  if (goos === 'windows') {
    const bases: string[] = []
    const pushBase = (b: string | undefined) => { if (b && !bases.includes(b)) bases.push(b) }
    // 环境变量优先（文件夹重定向时最准），join 兜底（变量缺失时）。
    pushBase(env.LOCALAPPDATA)
    pushBase(join(winProfile, 'AppData', 'Local'))
    pushBase(env.APPDATA)
    pushBase(join(winProfile, 'AppData', 'Roaming'))
    const out = [
      ...bases.flatMap((b) => expand(join(b, 'CodeBuddyExtension', 'Data', 'Public', 'auth'))),
      ...expand(join(winProfile, '.workbuddy', 'auth')),
      ...expand(join(winProfile, '.config', 'workbuddy', 'auth')),
      ...extra,
    ]
    return [...new Set(out)]
  }
  if (goos === 'linux') {
    const xdg = env.XDG_CONFIG_HOME || join(home, '.config')
    return [...new Set([
      ...expand(join(xdg, 'CodeBuddyExtension', 'Data', 'Public', 'auth')),
      // XDG 被改掉时仍保留默认位（双保险，不差这一次 stat）。
      ...(xdg !== join(home, '.config')
        ? expand(join(home, '.config', 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
        : []),
      ...expand(join(home, '.workbuddy', 'auth')),
      ...expand(join(home, '.config', 'workbuddy', 'auth')),
      ...extra,
    ])]
  }
  // darwin 及其他类 Unix
  return [...new Set([
    ...expand(join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')),
    ...expand(join(home, '.workbuddy', 'auth')),
    ...expand(join(home, '.config', 'workbuddy', 'auth')),
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
      // 前缀 + .info 一把抓：既覆盖历史带时间戳的快照
      // （workbuddy-desktop.2026-09-07T14-03-40.64274.abc.info），
      // 也覆盖两个发行版的定名文件（workbuddy-desktop.info / workbuddy-desktop-ai.info）。
      // 版本归属不靠文件名猜，由 detectRealmFromAuth 读文件内容判定。
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

// 某版本建议的 Provider 草稿。
//
// baseUrl / X-Domain 由**版本派生**，不再是常量：把海外版的 token 打到
// copilot.tencent.com 会被 APISIX 拦成 HTML 401「Authorization Required」，
// 用户以为是账号失效，实际只是域名不对（2026-09-19 实测确认）。
//
// Provider 名也按版本区分（workbuddy / workbuddy-ai）：账号池按 providerId 归属，
// 两个版本必须落成两个 Provider，否则同一池里混着两套互不通用的 token，
// 轮询到哪个是哪个，一半的请求注定 401。
export function wbSuggestedProvider(realm: WbRealm = 'cn'): Provider {
  const meta = WB_REALMS.find((r) => r.realm === realm) ?? WB_REALMS[0]!
  const suffix = realm === 'ai' ? '-ai' : ''
  return {
    providerId: 0, name: `workbuddy${suffix}`, state: 'active' as const,
    displayName: `WorkBuddy（自动发现·${meta.label}）`,
    accessKind: 'session-reuse', risk: 'medium',
    riskNote: '复用本机桌面登录态；只走流式；不要并发压测',
    stability: 'beta', api: 'openai-completions',
    baseUrl: `https://${meta.upstream}/v2`,
    credential: { apiKeyEnv: 'WB_TOKEN' },
    // 使用端（上游用量页的「使用端」列）归因头。
    //
    // 这组头的**唯一作用**是让上游把请求归因成 WorkBuddy 客户端，从而在用量页
    // 的「使用端」列显示 `WorkBuddy` 而不是 `-`。用户明确要求这一列有显示。
    //
    // ⚠️ 已证实：**这组头不影响计费。** 实测三组对照（同一账号）：
    //     WorkBuddy 头 + hy4-preview        → credit 8.60（扣）
    //     WorkBuddy 头 + deepseek-v4.1-flash → credit 0（不扣）
    //     SaaS 头      + deepseek-v4.1-flash → credit 0（不扣）
    //   唯一决定扣费的是**模型档位**，与头的值无关。
    //
    // ⚠️ 另注：客户端 app.asar 的真实逻辑是 X-Product = deploymentType
    //   （本机 = "SaaS"，缺省才是 SaaS）。所以严格说这里发的是「为了归因显示」
    //   而非「与官方客户端逐字一致」的值 —— 这是**刻意的、已知的偏离**，
    //   因为用户要的是用量页那列有显示，且已验证它不改变计费。
    //   若将来上游按 X-Product 收紧校验导致 4xx，第一嫌疑就是这里。
    headers: { ...wbAuxEndpointIdentityHeaders(), 'X-Domain': meta.upstream },
    // WorkBuddy 上游对非流式直接回 404 Route Not Found（实测）。国内版/海外版皆然。
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
// realm：只检查该版本的候选（未指定 = 不限，取首个命中的）。多版本场景下由
// checkWorkBuddyWithAccounts 分版本各调一次，避免「先命中的那个版本吃掉全部账号」。
export function checkWorkBuddy(paths: string[], realm?: WbRealm): Checked {
  const base: Finding = {
    key: realm === 'ai' ? 'workbuddy-ai' : 'workbuddy',
    harness: realm === 'ai' ? 'WorkBuddy 海外版 / CodeBuddy' : 'WorkBuddy 国内版 / CodeBuddy',
    suggestedProvider: wbSuggestedProvider(realm ?? 'cn'),
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
    // 版本过滤：文件内容认出的版本与要求的版本不符就跳过。
    // 认不出（旧客户端没写 domain 且 token 不是 JWT）时放行——总比整个漏掉强。
    const fileRealm = detectRealmFromAuth(raw)
    if (realm && fileRealm && fileRealm !== realm) continue
    const exp = jwtExpiry(f.auth.accessToken)
    const nick = f.account?.nickname?.trim() || '未知用户'
    const realmNote = fileRealm ? WB_REALMS.find((r) => r.realm === fileRealm)!.label : '版本未知'
    base.detail = `${nick} · ${f.account?.type ?? ''} · ${realmNote} · ${path}`
    base.actions = [
      `export WB_TOKEN=$(python3 -c "import json;print(json.load(open('${path}'))['auth']['accessToken'])")`,
      '然后在发现页点「采用」，或确认 WB_TOKEN 后重试',
    ]
    // 多账号发现：客户端切号会把旧登录态另存为带时间戳的副本，同机多账号天然共存。
    // 只列**同版本**的账号：跨版本的 token 不通用，混列会诱导用户把它们导进同一个 Provider。
    const accts = discoverWorkBuddyAccounts(dirname(path))
      .filter((a) => !realm || !a.realm || a.realm === realm)
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
  return {
    finding: {
      key: realm === 'ai' ? 'workbuddy-ai' : 'workbuddy',
      harness: realm === 'ai' ? 'WorkBuddy 海外版 / CodeBuddy' : 'WorkBuddy 国内版 / CodeBuddy',
      status: 'missing',
    },
    ok: false,
  }
}

// 多版本版：分别按国内版 / 海外版各检查一次，两个版本各自成 finding。
//
// 为什么必须分开而不是「一个 finding 列全部账号」：两个版本的 token 认证域不同、
// 互不通用，账号池又按 providerId 归属——混在一个 finding 里，用户「采用」时的
// 草稿只能有一个 baseUrl，另一个版本的账号注定全部 401。
// 分开之后：每个版本一个 finding、一个 Provider 草稿、一份只含同版本账号的账号列表。
//
// fallbackRoots 非空时启用智能兜底（候选路径 + 目录全 miss 才按文件名递归找），
// 见 searchWorkBuddyAuthFiles。命中后把真实路径回显，用户能直接照着配环境变量。
export function checkWorkBuddyRealms(
  paths: string[], authDirs: string[], fallbackRoots: string[] = [],
): Checked[] {
  const out: Checked[] = []
  for (const meta of WB_REALMS) {
    out.push(checkWorkBuddyRealm(meta.realm, paths, authDirs, fallbackRoots))
  }
  return out
}

// 单个版本的检查（含智能兜底）。paths/authDirs 是所有版本的候选合集，
// 这里按版本过滤：路径名后缀能先筛一轮，文件内容再由 checkWorkBuddy 按 realm 复核。
function checkWorkBuddyRealm(
  realm: WbRealm, paths: string[], authDirs: string[], fallbackRoots: string[],
): Checked {
  // 优先只看该版本的候选文件；一个都没有（env 覆盖成单文件等情形）时退回全集，
  // 让 checkWorkBuddy 按文件内容判定——否则自定义路径下会恒报 missing。
  const fname = wbAuthFileName(realm)
  const own = paths.filter((p) => p.endsWith(fname))
  const usePaths = own.length > 0 ? own : paths
  let { finding: f, ok } = checkWorkBuddy(usePaths, realm)

  // 智能兜底：仅当**该版本**没有任何账号被发现时才递归找。
  // 注意不能拿「目录候选里有没有账号」当门槛——另一个版本的文件就在同一个目录里，
  // 那样会让本版本永远不做兜底（目录扫出来的账号都属于对方）。
  if (!ok && fallbackRoots.length > 0) {
    const found = searchWorkBuddyAuthFiles(fallbackRoots)
      .filter((p) => p.endsWith(fname) || detectRealmFromFile(p) === realm)
    if (found.length > 0) {
      const r = checkWorkBuddy(found, realm)
      if (r.ok) {
        f = r.finding
        f.detail = (f.detail ?? '') + ' · 智能兜底定位（配置里没登记的路径）'
        f.actions = [
          `建议把登录态目录加进 CODEBUDDY_DESKTOP_AUTH_DIR，避免每次全盘扫描`,
          ...(f.actions ?? []),
        ]
        ok = true
      }
    }
  }

  // 账号列表只收同版本：跨版本的 token 不通用，混列会诱导用户导进同一个 Provider。
  if (!ok || !f.suggestedAccounts) {
    for (const d of authDirs) {
      const accts = discoverWorkBuddyAccounts(d).filter((a) => a.realm === realm)
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

// 读文件内容判版本（兜底筛选用；读不了返回 undefined，交由 checkWorkBuddy 复核）。
function detectRealmFromFile(path: string): WbRealm | undefined {
  try {
    return detectRealmFromAuth(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

// 兼容旧签名的单版本入口（默认国内版）：保留给既有调用方与测试。
export function checkWorkBuddyWithAccounts(
  paths: string[], authDirs: string[], fallbackRoots: string[] = [],
): Checked {
  return checkWorkBuddyRealm('cn', paths, authDirs, fallbackRoots)
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

// fp：从本机 opencode 日志自动识别出的指纹（没有则 undefined）。
// 有就把真实 UA + 会话直接写进草稿——新用户「一键导入」即可用，不需要手抄任何东西。
// 没有也不伪造：留空头，由「opencode 做客户端时的透传 / ZEN_UA / 静态配置」兜底。
// 头集合与真客户端对齐（2026-09-18 取证）：x-opencode-* 四件套必带
// （上游要求 x-opencode-session），旧 x-session-id/affinity 附带兼容。
function zenSuggestedProvider(baseURL: string, fp?: OpenCodeFingerprint | null): Provider {
  return {
    providerId: 0, name: 'opencode', state: 'active' as const, displayName: 'Zen免费档（自动发现）',
    accessKind: 'reverse', risk: 'high',
    riskNote: '逆向客户端指纹；免费档限流按会话（x-opencode-session）而非 IP，网关用会话池自动轮换；指纹优先用本机 opencode 客户端的真实运行记录自动识别，识别不到时才需要手动配置',
    stability: 'beta', api: 'openai-completions',
    baseUrl: baseURL.replace(/\/+$/, '') + '/v1',
    credential: { apiKeyEnv: 'ZEN_KEY' },
    headers: {
      // 指纹优先级（见 upstream.applyZenFingerprint）：
      //   会话：客户端透传 > 静态 x-opencode-session > 旧 x-session-id；
      //   UA：静态头已配的不动（显式配置优先），缺时按 透传 > ZEN_UA 补。
      // 自动识别到的就是「本机 opencode 真实发过的样子」，与手工抓包等价。
      // 注意：只写 opencode/<版本> 这一段 UA——中间两段是 opencode 内部依赖版本，
      // 日志里没有也无从可靠推断；实测这一段足够（测试有锚点）。不编造版本号。
      ...(fp ? {
        'User-Agent': fp.userAgent,
        'x-opencode-client': 'cli',
        'x-opencode-project': 'global',
        'x-opencode-session': fp.sessionID,
        'x-opencode-request': mintZenRequestId(),
        // 旧键附带：历史工具链可能读它们；真客户端虽不发，多带经实测不影响判定。
        'x-session-id': fp.sessionID,
        'x-session-affinity': fp.sessionID,
      } : {}),
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

// 可调用性验证最多试几个候选模型：太少会因单模型下线而误判整源不可用，
// 太多则发现页每次刷新都要打好几个真实请求（有成本、也慢）。
const ZEN_PROBE_MODELS = 3

// 同族归并：id 去掉版本号与免费后缀后相同者视为一族（muse-spark-1.3-x-free → muse-spark）。
// 返回顺序保持原顺序，但同族只保留首个。
function familyOf(id: string): string {
  return id.toLowerCase()
    .replace(/[-_.]?(free|contributor|trial)$/g, '')
    .replace(/[-_.]?v?\d+([-_.]\d+)*/g, '')
    .replace(/[-_.]+$/, '')
}

function spreadByFamily(ids: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const fam = familyOf(id)
    if (seen.has(fam)) continue
    seen.add(fam)
    out.push(id)
  }
  return out
}
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
  fingerprint?: OpenCodeFingerprint | null,
): Promise<Finding> {
  const f: Finding = {
    key: 'opencode-zen', harness: 'OpenCode Zen',
    suggestedProvider: zenSuggestedProvider(baseURL, fingerprint),
  }
  // 指纹说明统一在拿到结果后拼进 detail（见下方 fpNote），此处不抢先赋值避免被覆盖。
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
  // 指纹来源要一路带给用户：自动识别来的会话会过期（换号/重登就失效），
  // 用户得知道「这是自动读到的」才明白过期后该重扫，而不是以为配置坏了。
  const fpNote = fingerprint ? ` · 指纹自动识别自本机 opencode 客户端（${fingerprint.userAgent}）` : ''
  if (!callProbe) {
    f.status = 'ready'
    f.detail = `连通，${ids.length} 个模型${fpNote}（export ZEN_KEY=public 后采用）`
    f.actions = ['export ZEN_KEY=public', '然后在发现页点「采用」']
    return f
  }
  // 真实调用验证：免费档优先，**多试几个**。
  //
  // 只测一个模型就下结论是错的：单个模型可能恰好下线/地区受限/额度单独用尽，
  // 而 Provider 整体仍可用。那样用户会看到「这个也不能用」，实际只是选错了探针模型。
  // 任一候选调通即 ready；全失败才报不可用，且报**最有信息量**的那次病因。
  // 本地判免费（不引 gateway/probe：发现层不该依赖网关层，避免反向依赖环）。
  const freeIds = ids.filter((id) => looksFreeName(id))
  // 按「族」分散取样：同一族（id 去掉免费后缀后的主体）只取第一个。
  // 否则列表里同族模型扎堆时（如 muse-spark 有 1.2/1.3 两代），几个名额全被它占掉，
  // 一族不可用就误判整个 Provider 不可用——而其他族可能完全正常。
  const cands = spreadByFamily(freeIds.length > 0 ? freeIds : ids).slice(0, ZEN_PROBE_MODELS)
  if (cands.length === 0) {
    f.status = 'unreachable'
    f.detail = `连通，但模型列表为空（${ids.length} 个），无法验证可调用性`
    return f
  }
  // 并发探测：上游「响应头」本身就要 2~8 秒，串行试 3 个会把延迟叠加成 10s+。
  // 并发后总耗时取决于最慢的那个（实测 14.4s → 6.3s）。
  // 任一成功即 ready；全失败时按病因优先级挑最有信息量的一次上报
  // （与 probe.ts 的 errorRank 同思路：指纹/地区是源头病因，网络抖动是噪音）。
  const results = await Promise.all(cands.map(async (m) => ({ m, r: await callProbe(m) })))
  const hit = results.find((x) => x.r.ok)
  if (hit) {
    f.status = 'ready'
    f.detail = `连通，${ids.length} 个模型，实测 ${hit.m} 可调用${fpNote}`
    f.actions = ['export ZEN_KEY=public', '然后在发现页点「采用」']
    return f
  }
  const rank = (k?: string) => k === 'fingerprint' ? 3 : k === 'region' ? 2 : k ? 1 : 0
  const best = results.reduce((a, b) => (rank(b.r.kind) > rank(a.r.kind) ? b : a))
  const r = best.r
  const probeModel = best.m
  // 列表通但调用失败：不再冒充 ready。地区限制单独说（换出口可解，不是模型下线）。
  f.status = 'unreachable'
  if (r.kind === 'region' || /not available in your country/i.test(r.error ?? '')) {
    f.detail = `模型列表可达（${ids.length} 个），但试过的 ${cands.length} 个模型在当前出口地区都不可用（${probeModel}）`
    f.actions = [
      '这些模型有地区限制：给 Provider 配一个出口代理（egress）后即可调用',
      '若不打算用它们，可到 Providers 页只保留其他可用模型',
    ]
    return f
  }
  if (r.kind === 'fingerprint' || /free tier can only be used/i.test(r.error ?? '')) {
    // 指纹已尽力自动识别过（fingerprint 有值就是识别到了，仍失败说明会话过期）。
    // 两种情况文案不同：用户能做的事完全不一样。
    if (fingerprint) {
      f.detail = `模型列表可达（${ids.length} 个），但自动识别到的指纹已失效（${fingerprint.userAgent}）`
      f.actions = [
        '本机 opencode 客户端的会话已过期：运行一次 opencode（如 opencode run "hi"）后重扫，网关会重新读取',
        '或改用付费档凭据',
      ]
    } else {
      // 没识别到：最可能是本机没装 opencode、装了没运行过、或数据目录不在默认位置。
      // 不要一上来就让用户「抓包」——那是门槛最高的一条路，绝大多数人不会做。
      f.detail = `模型列表可达（${ids.length} 个），但真实调用被拒：未找到可用的客户端指纹`
      f.actions = [
        'Zen 免费档只接受 opencode 官方客户端的指纹。最省事：安装并运行一次 opencode（opencode run "hi"），它会写入真实指纹，再回本页重扫即可',
        '已装但重扫仍无效？确认数据目录在默认位置，或用 OPENCODE_DATA_DIR 指定其数据目录后重启网关',
        '若不打算用 opencode：在该 Provider 头里手填 User-Agent 与 x-opencode-session（抓包取真值），或设 ZEN_UA 环境变量；x-opencode-request 缺了网关会自动现铸',
        '以上都不想：改用付费档凭据（免费档的限制与额度无关，是客户端身份校验）',
      ]
    }
  } else {
    f.detail = `模型列表可达（${ids.length} 个），但真实调用失败：${r.error ?? '未知原因'}`
    f.actions = ['检查 Provider 协议与模型 ID 是否正确', '到 Providers 页用「测试」逐个排查']
  }
  return f
}

// ---- OpenCode 客户端指纹自动识别 ----
//
// 免费档要求「官方客户端样子」：真实 User-Agent + x-opencode-* 指纹四件套。
// 这些**不用让用户手抄**——opencode 自己会把它们写进本地日志，直接从日志里读。
//
// 日志里的可信来源（宁缺勿滥，避免把无关字符串当指纹）：
//   message=created id=ses_xxx ... version=1.18.29
//     —— 客户端自建会话（ses_ 的权威出处）+ 客户端版本号
//   旁证：同会话出现在 message=stream providerID=opencode ...
//     —— 该会话确实对 zen 发过请求，排除掉别的用途/历史残留
//
// UA 只需 opencode/<版本> 这一段：中间两段（ai-sdk/provider-utils、runtime）是
// opencode 内部依赖版本，日志里没有，也无从可靠推断；实测只发版本号同样被接受
// （见测试）。宁可少写也不编造——编造的版本号正是本项目一直拒绝做的事。
export interface OpenCodeFingerprint {
  sessionID: string
  version: string // 客户端版本（用于拼 UA）
  userAgent: string // opencode/<version>
  logPath: string // 来源日志（回显给用户，便于核对）
  modelID?: string // 该会话实测用过的模型（可作探针候选）
}

// opencode 数据目录候选（跨平台；env 可覆盖以便测试与自定义安装）。
export function openCodeDataDirs(
  goos: string, home: string, winProfile: string, env: NodeJS.ProcessEnv = process.env,
): string[] {
  const custom = env.OPENCODE_DATA_DIR
  if (custom) return [custom]
  const out: string[] = []
  const push = (d: string | undefined) => { if (d && !out.includes(d)) out.push(d) }
  // 三平台都要查 XDG 位置：opencode 是按 XDG 规范实现的，**不随平台变**。
  // 实测（Windows 11）真实路径就是 C:\Users\<u>\.local\share\opencode\log\opencode.log，
  // 而 %LOCALAPPDATA%\opencode 并不存在——早先只在非 Windows 分支查 XDG，
  // 导致 Windows 用户装了 opencode 也识别不到指纹。
  const xdg = env.XDG_DATA_HOME || join(winProfile || home, '.local', 'share')
  push(join(xdg, 'opencode'))
  push(join(home, '.local', 'share', 'opencode'))
  push(join(winProfile, '.local', 'share', 'opencode'))
  if (goos === 'windows') {
    // AppData 也保留：不同版本/打包方式可能改位置，两条都查、谁有日志用谁。
    push(env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'opencode') : undefined)
    push(join(winProfile, 'AppData', 'Local', 'opencode'))
    push(env.APPDATA ? join(env.APPDATA, 'opencode') : undefined)
    push(join(winProfile, 'AppData', 'Roaming', 'opencode'))
  }
  return out
}

// 日志文件候选（log 目录下的 *.log；含轮转文件）。
export function openCodeLogFiles(dirs: string[]): string[] {
  const out: string[] = []
  for (const d of dirs) {
    const logDir = join(d, 'log')
    let names: string[]
    try {
      names = readdirSync(logDir)
    } catch {
      continue
    }
    for (const n of names) {
      if (n.endsWith('.log')) out.push(join(logDir, n))
    }
  }
  return out
}

// 提取日志里**全部**可用会话（按出现顺序，旧→新），供配额轮换取多个候选。
//
// 背景（2026-09-18 实测）：zen 免费档的限流是按 x-opencode-session 会话算的，
// 不是按 IP——同一会话连续打十轮 xhigh 必 429，而本机 opencode 开多个窗口
// （每窗口一个新会话）一点事没有。网关只认一个静态会话，请求量一上去就撞墙。
// 所以刷新器不能只挑一个会话，要把本机近期真实用过的会话全收进来轮换。
export function parseAllFingerprintsFromLog(text: string): { sessionID: string; version: string; modelID?: string }[] {
  const out: { sessionID: string; version: string; modelID?: string }[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    if (!line.includes('message=created')) continue
    const id = /(?:^|\s)id=(ses_[A-Za-z0-9_-]{8,})(?:\s|$)/.exec(line)
    if (!id) continue
    const ver = /(?:^|\s)version=v?(\d+\.\d+\.\d+[\w.-]*)(?:\s|$)/.exec(line)
    if (!ver) continue
    const sessionID = id[1]!
    if (seen.has(sessionID)) continue // 同一会话只收一次（保留最早那次的位置）
    seen.add(sessionID)
    out.push({ sessionID, version: ver[1]! })
  }
  // 旁证：各会话对 zen(opencode provider) 发过流式请求；顺带取它用过的模型。
  for (const item of out) {
    const used = [...text.matchAll(
      new RegExp(`message=stream providerID=opencode modelID=([^\\s]+) session\\.id=${item.sessionID}`, 'g'),
    )]
    if (used.length > 0) item.modelID = used[used.length - 1]![1]
  }
  return out
}

// 从日志内容提取指纹。纯函数（便于测试），不碰文件系统。
// 策略：取**最后一个**可用会话（最近一次真实运行的最可能还新鲜）；
// 需要「自建会话」与「确实对 opencode(zen) 发起过 stream」两个证据同时成立。
export function parseFingerprintFromLog(text: string): { sessionID: string; version: string; modelID?: string } | null {
  const all = parseAllFingerprintsFromLog(text)
  return all.length > 0 ? all[all.length - 1]! : null
}

// ---- Zen 指纹刷新（x-opencode-session / x-opencode-request） ----
//
// 真客户端一次会话内四件套稳定：session = 本次运行的 ses_…，request = 首条用户消息的
// msg_…（同一会话后续请求沿用同一个，见 2026-09-18 取证：1285 次请求同一 msg）。
// 网关刷新策略与之对齐：取最新会话 + 该会话在日志里最后一次出现的 msg ID（
// message=process 行同时带 session.id 与 messageID）；找不到 msg 时现铸一个
// （格式与观测一致即可，见 mintZenRequestId），绝不复用别的会话的。
// key+sid 出现后必须跟分隔符（空白/逗号/引号）或行尾才算命中。
function ownsSessionRef(line: string, sessionID: string): boolean {
  for (const key of ['session.id=', 'id=']) {
    let at = line.indexOf(key + sessionID)
    while (at !== -1) {
      const tail = line.slice(at + key.length + sessionID.length)
      if (tail === '' || /[\s,"\x27]/.test(tail[0]!)) return true
      at = line.indexOf(key + sessionID, at + 1)
    }
  }
  return false
}
const MSG_ID_RE = /messageID=(msg_[A-Za-z0-9_-]{8,64})/

// 取某会话在日志中最后一次关联的 msg ID（纯函数）。同一行须同时出现
// session.id=<sid> 与 messageID=msg_…（即 message=process 行的形状）。
export function latestSessionMessageId(text: string, sessionID: string): string | undefined {
  if (!sessionID) return undefined
  let out: string | undefined
  for (const line of text.split('\n')) {
    if (!line.includes(sessionID)) continue
    const m = MSG_ID_RE.exec(line)
    if (!m) continue
    // 同一行必须同时点名该会话（避免串到别的会话的 msg）。
    // 归属用边界感知匹配：key+id 后必须跟分隔符或行尾，否则会话 A 是会话 B
    // 前缀时会把 B 的 process 行误归属给 A（后 24 位随机，概率极小但防一手）。
    if (!ownsSessionRef(line, sessionID)) continue
    out = m[1]
  }
  return out
}

// 扫描本机 opencode 日志，返回指纹（找不到返回 null）。
// 从最新的日志文件开始找（轮转文件里越新的越可能含未过期会话）。
export function discoverOpenCodeFingerprint(dirs: string[]): OpenCodeFingerprint | null {
  const all = discoverAllOpenCodeFingerprints(dirs)
  return all.length > 0 ? all[all.length - 1]! : null
}

// 本机全部可用会话（跨日志文件去重，按发现顺序），供会话池轮换。
// 每个日志文件内按出现顺序；文件之间按修改时间旧→新，使“越靠后越新鲜”成立。
export function discoverAllOpenCodeFingerprints(dirs: string[]): OpenCodeFingerprint[] {
  const files = openCodeLogFiles(dirs)
  // 按修改时间正序：旧文件先处理，最后累积到的就是最新文件里的会话。
  const sorted = files.map((p) => {
    let m = 0
    try { m = statSync(p).mtimeMs } catch { /* 取不到按 0 */ }
    return { p, m }
  }).sort((a, b) => a.m - b.m)
  const out: OpenCodeFingerprint[] = []
  const seen = new Set<string>()
  for (const { p } of sorted) {
    let raw: string
    try {
      raw = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    for (const got of parseAllFingerprintsFromLog(raw)) {
      if (seen.has(got.sessionID)) continue
      seen.add(got.sessionID)
      out.push({ ...got, userAgent: `opencode/${got.version}`, logPath: p })
    }
  }
  return out
}

// ---- WorkBuddy 多账号发现 ----

interface Acct extends DiscoveredAccount {
  modified: Date // 文件修改时间（同账号取最新）
  exp: Date | null // token 过期时间（去重平手时比较用）
}
// 扫描 WorkBuddy 登录态目录，返回全部可读的账号登录态。
// 同一账号（按 UID）取修改时间最新的一份，不同账号各自成条目。
// 目录不存在/不可读时返回空（尽力而为，不报错）。
// 每个条目带 realm（国内版/海外版）：两个版本的文件共存于同一目录，必须分别标识，
// 否则上层会把两套互不通用的 token 混进同一个 Provider。
export function discoverWorkBuddyAccounts(dir: string): DiscoveredAccount[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  // 去重键必须含 realm：同一个 UID 在两个版本下是两条独立凭据
  // （实测 uid 不同，但理论上同一自然人两版各注册一次就会撞上），
  // 按 realm+uid 分区是唯一安全的做法。
  const byKey = new Map<string, Acct>()
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
    const realm = detectRealmFromAuth(raw)
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
    const key = `${realm ?? '?'}:${uid}`
    const prev = byKey.get(key)
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
    byKey.set(key, {
      nickname: nick, uid: shortID(uid), realm, type: f.account?.type, alive,
      tokenPath: join(dir, name), modified: mod, exp,
      expiresAt: exp ? fmtLocal(exp) : undefined,
    })
  }
  const out = [...byKey.values()]
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
  // opencode 数据目录候选（自动识别指纹用）。不填 = 不做识别（既有单测契约不变）。
  openCodeDirs?: string[]
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
    // opencode 数据目录（指纹自动识别的来源）。
    openCodeDirs: openCodeDataDirs(goos, home, profile),
    zenBaseURL: 'https://opencode.ai/zen',
  }
}

// 聚合三探针（zen 探针自带超时，不卡死）。
//
// 关于耗时：本地三项（WORKBUDDY/ZCode/指纹识别）合计约 50ms，可忽略；
// 慢的是 zen 的联网验证——上游「响应头」本身就要 2~8 秒（它先处理再回头，
// 不是流式吐字慢）。这是上游固有延迟，客户端等不出更短的时间。
//
// 因此不能让每次页面刷新都实时打上游：
//   · scan() 带 TTL 缓存，重复调用直接复用（发现页刷新、导入前后的校验都不再重打）
//   · 过期后**先返回旧结果**（stale-while-revalidate），刷新在后台进行，界面不卡
//   · 候选模型并发探测（不再一个失败才试下一个）
// 用户手动点「重新探测」时传 force=true 绕过缓存，得到的一定是实时结果。
const SCAN_TTL_MS = 60_000

export class Scanner {
  private readonly cfg: ScanConfig
  private readonly wbDirs: string[]
  private readonly zenTimeoutMs: number
  private cached: Finding[] | null = null
  private cachedAt = 0
  private inflight: Promise<Finding[]> | null = null

  constructor(cfg: ScanConfig) {
    this.cfg = cfg
    this.zenTimeoutMs = cfg.zenTimeoutMs && cfg.zenTimeoutMs > 0 ? cfg.zenTimeoutMs : 8000
    this.wbDirs = cfg.workBuddyAuthDirs && cfg.workBuddyAuthDirs.length > 0
      ? cfg.workBuddyAuthDirs
      : workBuddyAuthDirsFromPaths(cfg.workBuddyPaths ?? [])
  }

  // force=true 绕缓存（用户显式「重新探测」）；否则新鲜则直接给，过期则「先给旧的 + 后台刷新」。
  async scan(force = false): Promise<Finding[]> {
    const fresh = this.cached !== null && Date.now() - this.cachedAt < SCAN_TTL_MS
    if (!force && fresh) return this.cached!.map((f) => ({ ...f }))
    if (!force && this.cached !== null) {
      // stale-while-revalidate：立刻返回旧结果，后台更新供下次用。
      // 注意必须 catch：后台失败不能变成 unhandled rejection（那会打崩进程）。
      void this.refresh().catch(() => {})
      return this.cached.map((f) => ({ ...f }))
    }
    return this.refresh()
  }

  // 真正执行一次扫描并写缓存。并发调用共享同一次执行（去重，避免同时打多轮上游）。
  private async refresh(): Promise<Finding[]> {
    if (this.inflight) return this.inflight
    this.inflight = this.runScan()
      .then((out) => {
        this.cached = out
        this.cachedAt = Date.now()
        return out.map((f) => ({ ...f }))
      })
      .finally(() => { this.inflight = null })
    return this.inflight
  }

  private async runScan(): Promise<Finding[]> {
    const out: Finding[] = []
    // 国内版 / 海外版各一条 finding：认证域不同、账号不通用，必须分开采用。
    const wbResults = checkWorkBuddyRealms(
      this.cfg.workBuddyPaths ?? [], this.wbDirs, this.cfg.workBuddyFallbackRoots ?? [])
    for (const { finding: wb, ok } of wbResults) {
      if (ok) {
        out.push(wb)
      } else {
        const label = wb.key === 'workbuddy-ai' ? '海外版' : '国内版'
        wb.status = 'missing'
        wb.detail = `未发现${label}桌面登录态`
        wb.actions = [`登录 WorkBuddy ${label}桌面端后重扫`]
        out.push(wb)
      }
    }
    out.push(checkZCode(this.cfg.zCodeDirs ?? []))
    // 指纹自动识别：从本机 opencode 日志读真实 UA/会话（用户无需手抄任何东西）。
    const fp = this.cfg.openCodeDirs && this.cfg.openCodeDirs.length > 0
      ? discoverOpenCodeFingerprint(this.cfg.openCodeDirs)
      : null
    out.push(await checkZen(
      this.cfg.zenBaseURL ?? 'https://opencode.ai/zen',
      this.cfg.fetchImpl ?? globalThis.fetch,
      this.zenTimeoutMs,
      this.cfg.zenCallProbe,
      fp,
    ))
    return out
  }
}
