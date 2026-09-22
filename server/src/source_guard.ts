// 来源体检 · Host 检查（防 DNS rebinding）——全局中间件，/v1 与 /admin 都挂。
//
// 威胁模型：恶意网页把域名 rebinding 到 127.0.0.1 后，浏览器眼里它就与本机网关
// **同源**，可以直接 fetch http://evil.com:3000/admin/api/... 读走管理数据。
// 同源策略此时不设防，唯一还能看出「这不是本机客户端」的线索就是 Host 头。
//
// 与 Content-Type 检查（见 adminapi/api.ts）同属「来源体检」：只看请求从哪来，
// 不改登录、不改鉴权模型。
//
// ⚠️ 为什么只在「纯裸跑」（admin_key 与 gateway_key 都为空）时启用——不要改成全局启用：
//   · 裸跑是官方支持的开箱即用模式（回环裸跑），此时合法 Host 只可能是回环地址
//     （浏览器地址栏 localhost/127.0.0.1、curl 默认同款），检查零误伤；
//   · 配了任一 key 的部署往往**合法地**使用非回环 Host——nginx 域名前置、
//     局域网 IP、自定义域名都很常见。那种模式下请求的机密性/完整性由 key 本身
//     保证（DNS rebinding 拿不到 key），再叠一道 Host 检查只会给既有部署加摩擦，
//     把好好的 200 打成 403。
//   结论：Host 检查是「裸跑模式的补偿性防线」，不是通用防线。谁把它改成全局启用，
//   谁就把域名前置/局域网部署打断了。

import type { Context, MiddlewareHandler } from 'hono'
import { ERR } from './ir/index.ts'

export interface HostGuardKeys {
  adminKey: string
  gatewayKey: string
}

// Host 头 → 主机部分：剥端口（host:port）与 IPv6 方括号（[::1]:3000）。
// 判据：单个冒号且尾段全为数字才当端口剥——`::1` 有多个冒号，整段就是主机；
// 带方括号的按 RFC 3986 取括号内。大小写归一（主机名大小写不敏感）。
export function hostOnly(host: string): string {
  const h = host.trim()
  if (h.startsWith('[')) {
    const m = /^\[([^\]]*)\]/.exec(h)
    return (m && m[1] ? m[1] : h).toLowerCase()
  }
  const i = h.lastIndexOf(':')
  if (i > 0 && h.indexOf(':') === i && /^[0-9]+$/.test(h.slice(i + 1))) {
    return h.slice(0, i).toLowerCase()
  }
  return h.toLowerCase()
}

// 回环主机判定：localhost / 127.0.0.0/8 / ::1（先剥端口与方括号）。
// cli.ts 的管理口令、网关口令两处启动守卫与本检查共用这一份口径——
// 判据漂移过一次的地方，再多写一遍迟早再漂一次。
export function isLoopbackHost(host: string): boolean {
  const h = hostOnly(host)
  return h === 'localhost' || h.startsWith('127.') || h === '::1'
}

// 管理面错误形态（与 adminapi/api.ts 的 errRes 一字不差：{error:{type,message}}）。
function errJSON(c: Context, typ: string, msg: string): Response {
  return c.json({ error: { type: typ, message: msg } }, 403)
}

// hostGuard：全局 Host 检查。是否启用按「两个 key 都为空」逐请求判定
// （key 由装配方传入，启动后不变；逐请求读只为让判据与请求同处一个作用域，便于测试）。
export function hostGuard(keys: HostGuardKeys): MiddlewareHandler {
  return async (c, next) => {
    // 只在纯裸跑启用。原因见文件头注释：配了 key 的部署 Host 可以合法地非回环
    // （nginx 域名前置 / 局域网 IP），靠 key 本身保护，绝不给既有部署加摩擦。
    if (keys.adminKey !== '' || keys.gatewayKey !== '') return next()
    const host = c.req.header('Host')
    // Host 缺失 → 放行（老客户端/非 HTTP/1.1 语义的调用方不看这一眼）。
    if (host === undefined || host === '') return next()
    if (isLoopbackHost(host)) return next()
    // 两个面的 403 形态不同：/admin 走 errRes 形态（管理台已有客户端在读这个形状）；
    // 转发面直接 {error:...}——此路径只在攻击场景出现，无兼容包袱。
    const p = c.req.path
    if (p === '/admin' || p.startsWith('/admin/')) {
      return errJSON(c, ERR.PERMISSION, `Host ${host} 不是本机回环地址（裸跑模式只接受 localhost/127.0.0.1/::1）`)
    }
    return c.json({ error: `Host ${host} 不是本机回环地址（裸跑模式只接受 localhost/127.0.0.1/::1）` }, 403)
  }
}
