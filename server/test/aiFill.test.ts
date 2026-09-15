import { describe, test, expect } from 'vitest'
import { pickServices, applyAiService, childOf } from '../../web/src/aiFill.ts'

describe('AI 回填纯逻辑', () => {
  test('pickServices：一个项目多服务 → 全部返回（不能只取第一个）', () => {
    const raw = JSON.stringify({
      name: 'demo',
      services: [
        { name: 'api', cmd: 'uvicorn main:app --port 8000', port: 8000, dir: '/p/api' },
        { name: 'web', cmd: 'npm run dev', port: 5173, dir: '/p/web' },
      ],
    })
    const got = pickServices(raw)
    expect(got.length).toBe(2)
    expect(got.map((s) => s.name)).toEqual(['api', 'web'])
  })

  test('pickServices：多个项目对象 → 拼它们的服务', () => {
    const got = pickServices([
      { name: 'a', services: [{ name: 'a1', cmd: 'x' }] },
      { name: 'b', services: [{ name: 'b1', cmd: 'y' }] },
    ])
    expect(got.map((s) => s.name)).toEqual(['a1', 'b1'])
  })

  test('pickServices：单对象（无 services 包裹）也能接', () => {
    const got = pickServices({ name: 'web', cmd: 'npm run dev' })
    expect(got.length).toBe(1)
    expect(got[0]?.name).toBe('web')
  })

  test('pickServices：垃圾输入 → 空数组（不抛）', () => {
    expect(pickServices('not json')).toEqual([])
    expect(pickServices(null)).toEqual([])
    expect(pickServices(42)).toEqual([])
    expect(pickServices([null, 7, {}])).toEqual([])
  })

  test('childOf：根目录本身与子目录都算，旁系/父目录不算', () => {
    expect(childOf('/p', '/p')).toBe(true)
    expect(childOf('/p', '/p/api')).toBe(true)
    expect(childOf('/p', '/p/a/b')).toBe(true)
    expect(childOf('/p', '/other')).toBe(false)
    expect(childOf('/p', '/pp')).toBe(false) // 前缀相同但不是子路径
    expect(childOf('/p', '/')).toBe(false)
  })

  test('applyAiService：dir 只在给定目录内才采信（AI 编路径不生效）', () => {
    const s = { name: '', dir: '/p', cmd: '', port: 0 }
    applyAiService(s, { name: 'api', cmd: 'run', dir: '/p/api', port: 8000 }, '/p')
    expect(s.dir).toBe('/p/api')
    applyAiService(s, { name: 'x', dir: '/etc/evil' }, '/p')
    expect(s.dir).toBe('/p/api') // 越界 → 保持不动
  })

  test('applyAiService：只覆盖 AI 给了的字段', () => {
    const s = { name: 'keep', dir: '/p', cmd: 'keep-cmd', port: 3000, portEnv: 'PORT' }
    applyAiService(s, { name: 'api' }, '/p')
    expect(s).toEqual({ name: 'api', dir: '/p', cmd: 'keep-cmd', port: 3000, portEnv: 'PORT' })
  })
})
