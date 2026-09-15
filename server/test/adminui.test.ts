import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdminUI } from '../src/gateway/adminui.ts'

let dist: string

let app: ReturnType<typeof createAdminUI>

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'polycode-adminui-'))
  mkdirSync(join(dist, 'assets'))
  writeFileSync(join(dist, 'index.html'), '<html>admin</html>')
  writeFileSync(join(dist, 'assets', 'index-a7kT_hPq.css'), 'body{}')
  writeFileSync(join(dist, 'assets', 'index-a7kT_hPq.js'), 'export{}')
  app = createAdminUI(dist)
})
afterAll(() => rmSync(dist, { recursive: true, force: true }))

describe('admin UI 静态托管（对齐 Go MountAdminUI 语义）', () => {
  test('GET /admin 301 到 /admin/', async () => {
    const res = await app.request('/admin')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/admin/')
  })

  test('GET /admin/ 返回 index.html 且 no-cache', async () => {
    const res = await app.request('/admin/')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>admin</html>')
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })

  test('GET /admin/index.html 同样 no-cache', async () => {
    const res = await app.request('/admin/index.html')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })

  // 2026-09-15 修正：原先只给 index.html 设 no-cache，靠「hash 资源内容永不改」
  // 的假设；但本地重建产物会覆盖同名文件，导致升级后刷新仍加载旧 JS（用户实测
  // 「改完看不到前端变化」）。现在静态资源一律 no-cache（强制回源校验，可 304）。
  test('静态资源也带 no-cache（本地重建覆盖同名文件后刷新即生效）', async () => {
    const res = await app.request('/admin/assets/index-a7kT_hPq.css')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('body{}')
    expect(res.headers.get('content-type')).toContain('text/css')
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })

  test('js 资源同样 no-cache', async () => {
    const res = await app.request('/admin/assets/index-a7kT_hPq.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })

  test('不存在的文件 404', async () => {
    const res = await app.request('/admin/nope.js')
    expect(res.status).toBe(404)
  })

  test('目录穿越被拒绝', async () => {
    const res = await app.request('/admin/../package.json')
    expect(res.status).toBe(404)
  })
})
