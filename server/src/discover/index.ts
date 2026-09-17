// 发现本机 coding agent 客户端的安装与登录痕迹（对齐 Go internal/discover）。
// 路径表按 goos 参数生成（darwin/linux/windows），一律可注入，测试不依赖运行环境。
// 报告永不含密钥原文。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Provider } from '../model/index.ts'
import { ZEN_REAL_UA } from '../router/upstream.ts'
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
export function workBuddySearchPaths(goos: string, home: string, winProfile: string): string[] {
  const custom = process.env.CODEBUDDY_DESKTOP_AUTH_FILE
  if (custom) return [custom]
  if (goos === 'windows') {
    const appdata = join(winProfile, 'AppData', 'Roaming')
    return [
      join(appdata, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
      join(winProfile, '.workbuddy', 'auth', 'workbuddy-desktop.info'),
      join(winProfile, '.config', 'workbuddy', 'auth', 'workbuddy-desktop.info'),
    ]
  }
  if (goos === 'linux') {
    return [
      join(home, '.config', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
      join(home, '.workbuddy', 'auth', 'workbuddy-desktop.info'),
      join(home, '.config', 'workbuddy', 'auth', 'workbuddy-desktop.info'),
    ]
  }
  // darwin 及其他类 Unix
  return [
    join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
    join(home, '.workbuddy', 'auth', 'workbuddy-desktop.info'),
    join(home, '.config', 'workbuddy', 'auth', 'workbuddy-desktop.info'),
  ]
}

// auth 目录候选（多账号发现按目录扫全部共存登录态），从文件候选的 Dir 部分去重即得。
export function workBuddyAuthDirs(goos: string, home: string, winProfile: string): string[] {
  return workBuddyAuthDirsFromPaths(workBuddySearchPaths(goos, home, winProfile))
}

export function workBuddyAuthDirsFromPaths(paths: string[]): string[] {
  const dirs: string[] = []
  for (const p of paths) {
    const d = dirname(p)
    if (!dirs.includes(d)) dirs.push(d)
  }
  return dirs
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
    priority: 1,
    // providerId 由存储层在建 Provider 时分配（此处占位 0）
    models: [{ id: 'hy3-preview', displayName: 'HY免费', manual: false, enabled: true }],
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
export function checkWorkBuddyWithAccounts(paths: string[], authDirs: string[]): Checked {
  const { finding: f, ok } = checkWorkBuddy(paths)
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
      // 真机指纹：官方客户端只发 UA + 会话头，不发 x-opencode-*（那是毒头，见 upstream.applyZenFingerprint）。
      // 会话头优先透传客户端的；其他客户端经网关调用时用这里配的静态值。
      'User-Agent': ZEN_REAL_UA,
    },
    priority: 1,
    models: [
      { id: 'mimo-v2.5-free', manual: false, enabled: true },
      { id: 'nemotron-3-ultra-free', manual: false, enabled: true },
    ],
  }
}

// 探 /v1/models；成功返回模型数。
export async function checkZen(baseURL: string, fetchImpl: FetchLike, timeoutMs = 8000): Promise<Finding> {
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
  f.status = 'ready'
  f.detail = `连通，${list.data?.length ?? 0} 个模型（export ZEN_KEY=public 后采用）`
  f.actions = ['export ZEN_KEY=public', '然后在发现页点「采用」']
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
  zCodeDirs?: string[]
  zenBaseURL?: string
  zenTimeoutMs?: number // <=0 用 8000
  fetchImpl?: FetchLike // 不填用全局 fetch
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
    const { finding: wb, ok } = checkWorkBuddyWithAccounts(this.cfg.workBuddyPaths ?? [], this.wbDirs)
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
    ))
    return out
  }
}
