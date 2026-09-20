import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'

// MIME 表只需覆盖 Vite 构建产物会出现的类型（不为此引入 mime 库）。
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

// createAdminUI 复刻 Go MountAdminUI 语义：/admin 301 到 /admin/。
//
// 缓存策略（2026-09-15 修正）：index.html 与下列资源一律 no-cache（每次都带
// ETag 回源校验，命中 304 仍然省流量）。原先只给 index.html 设了 no-cache，
// 指望「hash 资源内容永不改」——但本项目是本地重建产物，同名 hash 文件会被
// 直接覆盖（构建哈希相同/被浏览器启发式缓存命中时），结果是：升级后刷新页面
// 仍加载旧 JS，用户看不到任何改动。no-cache 不等于不缓存，只是强制校验，
// 本地场景开销可忽略，换来「改完刷新就能看到」。
export function createAdminUI(distDir: string): Hono {
  const root = resolve(distDir)
  const app = new Hono()
  app.get('/admin', (c) => c.redirect('/admin/', 301))
  app.get('/admin/*', (c) => {
    const rel = c.req.path === '/admin/' ? 'index.html' : c.req.path.slice('/admin/'.length)
    // 目录穿越：normalize 后必须仍在 root 内。
    const file = normalize(join(root, rel))
    if (!file.startsWith(root + sep) || rel.endsWith('/')) {
      return c.notFound()
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      return c.notFound()
    }
    c.header('Cache-Control', 'no-cache')
    const type = MIME[extname(file)] ?? 'application/octet-stream'
    c.header('Content-Type', type)
    // no-cache 注释里承诺的「带 ETag 回源校验」此前从未落地：ETag 根本没生成，
    // 浏览器每次刷新都整份重下 1.6MB 产物。这里补上——内容寻址的强 ETag，
    // 命中 If-None-Match 直接 304（管理台产物虽 1.6MB，但请求频率低，
    // readFileSync + sha256 全量重算的代价可接受；将来访问量上去再加内存缓存）。
    const body = readFileSync(file)
    const etag = `"${createHash('sha256').update(body).digest('base64url')}"`
    c.header('ETag', etag)
    if (c.req.header('If-None-Match') === etag) {
      return c.body(null, 304)
    }
    return c.body(body)
  })
  return app
}
