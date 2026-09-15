import { Hono } from 'hono'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
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
    return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream)
  })
  return app
}
