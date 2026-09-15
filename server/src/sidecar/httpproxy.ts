// 系统代理解析：网关常由 launchd/systemd 拉起，进程里没有 *_proxy 环境变量，
// 而下载用全局 fetch 只认环境变量——在这类机器上直连 github.com 会超时，
// 但浏览器走系统代理是通的。故 darwin 从 scutil --proxy 读系统代理，
// 其余平台回落环境变量（对齐 Go internal/sidecar/httpproxy.go）。
//
// 注意偏差：Node 全局 fetch 不支持经代理转发（undici ProxyAgent 未暴露为内置
// 模块，本仓库不新增依赖），本模块当前供调用方展示/兜底判断；下载函数支持
// 注入 fetch 替身，接入代理转发留给后续（如 Node 内置 NODE_USE_ENV_PROXY）。

import { execFileSync } from 'node:child_process'

export interface ProxyURL {
  scheme: 'http' | 'socks5'
  host: string // host:port
}

// parseScutilProxy 从 `scutil --proxy` 输出解析系统代理，优先级 HTTPS → HTTP → SOCKS。
// 输出形如 "  HTTPSProxy : 127.0.0.1"（键值都以 " : " 分隔）。无启用代理返回 null。
export function parseScutilProxy(out: string): ProxyURL | null {
  const kv = new Map<string, string>()
  for (const line of out.split('\n')) {
    const i = line.indexOf(':')
    if (i < 0) continue
    kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
  }
  const enabled = (k: string): boolean => kv.get(k) === '1'
  const hostPort = (hostK: string, portK: string): string => {
    const h = kv.get(hostK) ?? ''
    const p = kv.get(portK) ?? ''
    if (h === '' || p === '') return ''
    // 对齐 net.JoinHostPort：IPv6 主机加方括号
    return h.includes(':') ? `[${h}]:${p}` : `${h}:${p}`
  }
  if (enabled('HTTPSEnable')) {
    const hp = hostPort('HTTPSProxy', 'HTTPSPort')
    if (hp !== '') return { scheme: 'http', host: hp }
  }
  if (enabled('HTTPEnable')) {
    const hp = hostPort('HTTPProxy', 'HTTPPort')
    if (hp !== '') return { scheme: 'http', host: hp }
  }
  if (enabled('SOCKSEnable')) {
    const hp = hostPort('SOCKSProxy', 'SOCKSPort')
    if (hp !== '') {
      // 与 Go 一致：仅当端口可解析为数字才采用（net.SplitHostPort + Atoi）
      const port = hp.slice(hp.lastIndexOf(':') + 1)
      if (/^\d+$/.test(port)) return { scheme: 'socks5', host: hp }
    }
  }
  return null
}

// envProxyURL 从环境变量取代理（对齐 Go http.ProxyFromEnvironment 的 HTTPS 语义，
// 下载目标固定是 https://api.github.com，故只看 HTTPS/ALL）。
function envProxyURL(): ProxyURL | null {
  const raw = process.env.HTTPS_PROXY ?? process.env.https_proxy
    ?? process.env.ALL_PROXY ?? process.env.all_proxy ?? ''
  if (raw === '') return null
  try {
    const u = new URL(raw)
    const scheme = u.protocol.replace(':', '')
    if (scheme !== 'http' && scheme !== 'socks5') return null
    return { scheme, host: u.host }
  } catch {
    return null
  }
}

// ghProxyURL 访问 GitHub（release 查询与引擎下载）用的代理解析：
// darwin 系统代理优先（launchd 拉起时环境变量缺失），否则环境变量。
export function ghProxyURL(now: () => ProxyURL | null = readScutilOnce): ProxyURL | null {
  if (process.platform === 'darwin') {
    const p = now()
    if (p !== null) return p
  }
  return envProxyURL()
}

let scutilCache: ProxyURL | null | undefined
function readScutilOnce(): ProxyURL | null {
  if (scutilCache !== undefined) return scutilCache
  scutilCache = readScutil()
  return scutilCache
}

function readScutil(): ProxyURL | null {
  if (process.platform !== 'darwin') return null
  try {
    const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 })
    return parseScutilProxy(out)
  } catch {
    return null
  }
}
