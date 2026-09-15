import { describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll } from 'vitest'
import { loadConfig, loadOrDefault, DEFAULT_FIRST_BYTE_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../src/config/index.ts'

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'polycode-config-')) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const write = (name: string, content: string) => {
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

describe('零配置启动', () => {
  test('文件不存在 → 全默认配置', () => {
    const cfg = loadOrDefault(join(dir, 'nope.yaml'))
    expect(cfg.gateway).toEqual({
      host: '127.0.0.1', port: 3000, adminKey: '', gatewayKey: '',
      defaultModel: '', riskMax: 'high', precheckContext: false,
      // 超时守卫有默认值：零配置启动也不能没有（上游挂住会拖死客户端）
      firstByteTimeoutMs: DEFAULT_FIRST_BYTE_TIMEOUT_MS,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    })
    expect(cfg.dataDir).toBe('data')
    expect(cfg.providers).toEqual([])
  })
})

describe('严格解析（对齐 Go KnownFields(true)：未知字段报错）', () => {
  test('顶层未知字段拒绝', () => {
    const path = write('unknown-top.yaml', 'gateway: {}\njwt: "明文凭据不许进配置"\n')
    expect(() => loadConfig(path)).toThrow(/未知字段.*jwt/)
  })

  test('provider 嵌套未知字段拒绝（防拼错 + 强制凭据不落明文）', () => {
    const path = write('unknown-provider.yaml', `
sources: [{ id: s1 }]
providers:
  - id: p1
    source_id: s1
    access_kind: official
    risk: low
    stability: stable
    base_url: https://x.example
    jwt_token: leak
`)
    expect(() => loadConfig(path)).toThrow(/未知字段.*jwt_token/)
  })
})

// 示例配置是 README 的首选上手路径（cp config/apps.example.yaml config/apps.yaml）。
// 严格模式下它必须自己先能解析——否则用户照抄即启动失败。
describe('仓库自带示例配置', () => {
  test('config/apps.example.yaml 通过严格解析', () => {
    expect(() => loadConfig('config/apps.example.yaml')).not.toThrow()
  })
})

describe('默认值与跨实体校验', () => {
  test('provider/account 缺省值补齐', () => {
    const path = write('defaults.yaml', `
providers:
  - id: p1
    source_id: s1
    base_url: https://x.example
sources: [{ id: s1 }]
accounts: [{ id: a1, source_id: s1 }]
`)
    const cfg = loadConfig(path)
    const prov = cfg.providers[0]!
    expect(prov.stability).toBe('stable')
    expect(prov.risk).toBe('low')
    expect(prov.accessKind).toBe('official')
    expect(prov.models).toEqual([])
    expect(cfg.accounts[0]!.status).toBe('available')
  })

  test('校验失败：risk_max 非法 / 端口越界 / source 重复 / provider 引用缺失 source / provider id 重复', () => {
    const bad = (body: string) => write('bad.yaml', body)
    expect(() => loadConfig(bad('gateway: {risk_max: extreme}\nsources: [{id: s1}]\nproviders: []\n')))
      .toThrow(/risk_max/)
    expect(() => loadConfig(bad('gateway: {port: 99999}\nsources: [{id: s1}]\nproviders: []\n')))
      .toThrow(/port/)
    expect(() => loadConfig(bad('sources: [{id: s1}, {id: s1}]\nproviders: []\n')))
      .toThrow(/重复/)
    expect(() => loadConfig(bad('sources: [{id: s1}]\nproviders:\n  - id: p1\n    source_id: other\n    access_kind: official\n    risk: low\n    stability: stable\n    base_url: https://x\n')))
      .toThrow(/不存在的 source/)
    expect(() => loadConfig(bad('sources: [{id: s1}]\nproviders:\n  - id: p1\n    source_id: s1\n    access_kind: official\n    risk: low\n    stability: stable\n    base_url: https://x\n    models: []\n  - id: p1\n    source_id: s1\n    access_kind: official\n    risk: low\n    stability: stable\n    base_url: https://y\n')))
      .toThrow(/重复/)
  })
})

describe('egress 出口代理（EGRESS-SPIKE 方案 A 落地）', () => {
  test('顶层 egresses 解析 + provider.egress 引用', () => {
    const path = write('egress.yaml', `
egresses:
  - id: clash
    kind: http
    addr: 127.0.0.1:7897
providers:
  - id: zen
    source_id: s1
    base_url: https://x.example
    egress: clash
sources: [{ id: s1 }]
`)
    const cfg = loadConfig(path)
    expect(cfg.egresses).toEqual([{ id: 'clash', kind: 'http', addr: '127.0.0.1:7897' }])
    expect(cfg.providers[0]!.egress).toBe('clash')
  })

  test('provider.egress 引用不存在的出口 → 报错', () => {
    const path = write('egress-bad.yaml', `
providers:
  - id: zen
    source_id: s1
    base_url: https://x.example
    egress: nope
sources: [{ id: s1 }]
`)
    expect(() => loadConfig(path)).toThrow(/egress/)
  })

  // 备注是运维知识（「23 点后才免费」），得能从配置文件写进库，不然每次重启就丢。
  test('模型 note 与 egress 一起从 YAML 解析', () => {
    const path = write('note.yaml', `
egresses:
  - id: clash
    kind: http
    addr: 127.0.0.1:7897
providers:
  - id: wb
    source_id: s1
    base_url: https://x.example
    models:
      - id: hy4-preview
        note: 23 点后才免费，白天用会扣额度
        egress: clash
      - id: plain
sources: [{ id: s1 }]
`)
    const cfg = loadConfig(path)
    const ms = cfg.providers[0]!.models
    expect(ms[0]!.note).toBe('23 点后才免费，白天用会扣额度')
    expect(ms[0]!.egress).toBe('clash')
    expect(ms[1]!.note).toBeUndefined()
  })

  test('model.egress 解析 + 引用不存在的出口 → 报错（模型级粒度）', () => {
    const ok = write('egress-model.yaml', `
egresses:
  - id: clash
    kind: http
    addr: 127.0.0.1:7897
providers:
  - id: zen
    source_id: s1
    base_url: https://x.example
    models:
      - id: muse-spark-1.3
        egress: clash
sources: [{ id: s1 }]
`)
    const cfg = loadConfig(ok)
    expect(cfg.providers[0]!.models[0]!.egress).toBe('clash')

    const bad = write('egress-model-bad.yaml', `
providers:
  - id: zen
    source_id: s1
    base_url: https://x.example
    models:
      - id: muse-spark-1.3
        egress: nope
sources: [{ id: s1 }]
`)
    expect(() => loadConfig(bad)).toThrow(/egress/)
  })
})
