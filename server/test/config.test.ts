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
providers:
  - name: p1
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

// 真实故障（2026-09-17）：config/apps.yaml 是 gitignored 本地文件，`git reset --hard`
// 盖不掉它；老结构（sources + provider.id/source_id）撞上严格模式直接
// `未知字段 "sources"` 让进程退出。用户被迫删配置才能起服务。
describe('旧结构自动迁移（老本地配置必须能启动）', () => {
  const legacyYaml = (body: string) => write('legacy.yaml', body)

  test('顶层 sources 被忽略，不再让进程退出', () => {
    const cfg = loadConfig(legacyYaml(`
sources:
  - id: company
    display_name: 公司源
providers:
  - id: p1
    source_id: company
    access_kind: official
    risk: low
    stability: stable
    base_url: https://x.example
`))
    expect(cfg.providers).toHaveLength(1)
  })

  test('provider.id → name；enabled → state；source_id 被忽略', () => {
    const cfg = loadConfig(legacyYaml(`
providers:
  - id: myprov
    source_id: s1
    enabled: false
    access_kind: official
    risk: low
    stability: stable
    base_url: https://x.example
    models:
      - id: m1
        provider_id: myprov
        enabled: true
`))
    const p = cfg.providers[0]!
    expect(p.name).toBe('myprov')
    expect(p.state).toBe('paused') // enabled: false → paused（与库迁移同口径）
    expect((p.models[0] as { providerId?: unknown }).providerId).toBeUndefined()
  })

  test('account.source_id → provider（值命中 Provider 名）', () => {
    const cfg = loadConfig(legacyYaml(`
providers:
  - id: zcode
    access_kind: official
    risk: low
    stability: stable
    base_url: https://x.example
accounts:
  - id: a1
    source_id: zcode
    credential:
      api_key_file: config/credentials/k
`))
    expect((cfg.accounts[0] as { providerName?: string }).providerName).toBe('zcode')
  })

  test('account.source_id 走「源 → 旗下 Provider」映射（源名与 Provider 名不同）', () => {
    const cfg = loadConfig(legacyYaml(`
sources:
  - id: company
providers:
  - id: company-anthropic
    source_id: company
    access_kind: official
    risk: low
    stability: stable
    base_url: https://x.example
accounts:
  - id: a1
    source_id: company
    credential:
      api_key_file: config/credentials/k
`))
    expect((cfg.accounts[0] as { providerName?: string }).providerName).toBe('company-anthropic')
  })

  test('拼错字段仍然拒绝（迁移只放行已知旧字段）', () => {
    expect(() => loadConfig(legacyYaml('source:\n  - id: s1\n')))
      .toThrow(/未知字段.*source/)
  })
})

describe('默认值与跨实体校验', () => {
  test('provider/account 缺省值补齐', () => {
    const path = write('defaults.yaml', `
providers:
  - name: p1
    base_url: https://x.example
accounts: [{ id: a1, provider: p1 }]
`)
    const cfg = loadConfig(path)
    const prov = cfg.providers[0]!
    expect(prov.stability).toBe('stable')
    expect(prov.risk).toBe('low')
    expect(prov.accessKind).toBe('official')
    expect(prov.models).toEqual([])
    expect(cfg.accounts[0]!.status).toBe('available')
  })

  test('校验失败：risk_max 非法 / 端口越界 / provider name 重复', () => {
    const bad = (body: string) => write('bad.yaml', body)
    expect(() => loadConfig(bad('gateway: {risk_max: extreme}\nproviders: []\n')))
      .toThrow(/risk_max/)
    expect(() => loadConfig(bad('gateway: {port: 99999}\nproviders: []\n')))
      .toThrow(/port/)
    // 回归：旧判据是 `port <= 0 || port > 65535`，而 NaN 与任何数比较都是 false
    // ——**同时躲过两边**。小数 3000.5 也不满足任一条件，能一路进 serve()。
    // 现在改用 Number.isInteger 拦住。
    // （注：NaN 路径实际不可达——applyDefaults 的 `if (!port) port = 3000`
    //   会先把 NaN 兜成 3000，因为 !NaN === true。测试只钉真实可达的小数路径。）
    expect(() => loadConfig(bad('gateway: {port: 3000.5}\nproviders: []\n')))
      .toThrow(/port/)
    // sources/source_id 已废弃，但老文件必须能启动（config/apps.yaml 是 gitignored 本地
    // 文件，git reset 盖不掉它）：这类**已知的旧字段**走自动迁移 + 告警，不再抛错。
    // 真正拼错的字段照旧拒绝（见上面两条，以及下面这条防回归）。
    const legacy = loadConfig(bad('sources:\n  - id: s1\nproviders:\n  - id: p1\n    source_id: s1\n    base_url: https://x\n'))
    expect(legacy.providers[0]!.name).toBe('p1') // id → name
    expect(() => loadConfig(bad('providers:\n  - name: p1\n    source_idd: s1\n    base_url: https://x\n')))
      .toThrow(/未知字段.*source_idd/)
    expect(() => loadConfig(bad('providers:\n  - name: p1\n    access_kind: official\n    risk: low\n    stability: stable\n    base_url: https://x\n    models: []\n  - name: p1\n    access_kind: official\n    risk: low\n    stability: stable\n    base_url: https://y\n')))
      .toThrow(/重复/)
  })

})

describe('egress 出口代理（EGRESS-SPIKE 方案 A 落地）', () => {
  test('顶层 egresses 解析 + provider.egress 引用', () => {
    const path = write('egress-provider.yaml', `
egresses:
  - id: clash
    kind: http
    addr: 127.0.0.1:7897
providers:
  - name: zen
    base_url: https://x.example
    egress: clash
`)
    const cfg = loadConfig(path)
    expect(cfg.egresses).toEqual([{ id: 'clash', kind: 'http', addr: '127.0.0.1:7897' }])
    expect(cfg.providers[0]!.egress).toBe('clash')
  })

  test('provider.egress 引用不存在的出口 → 报错', () => {
    const path = write('egress-provider-bad.yaml', `
providers:
  - name: zen
    base_url: https://x.example
    egress: nope
`)
    expect(() => loadConfig(path)).toThrow(/egress/)
  })

  test('顶层 egresses 解析 + model.egress 引用', () => {
    const path = write('egress.yaml', `
egresses:
  - id: clash
    kind: http
    addr: 127.0.0.1:7897
providers:
  - name: zen
    base_url: https://x.example
    models:
      - id: muse-spark-1.3
        egress: clash
`)
    const cfg = loadConfig(path)
    expect(cfg.egresses).toEqual([{ id: 'clash', kind: 'http', addr: '127.0.0.1:7897' }])
    expect(cfg.providers[0]!.models[0]!.egress).toBe('clash')
  })

  // 备注是运维知识（「23 点后才免费」），得能从配置文件写进库，不然每次重启就丢。
  test('模型 note 与 egress 一起从 YAML 解析', () => {
    const path = write('note.yaml', `
egresses:
  - id: clash
    kind: http
    addr: 127.0.0.1:7897
providers:
  - name: wb
    base_url: https://x.example
    models:
      - id: hy4-preview
        note: 23 点后才免费，白天用会扣额度
        egress: clash
      - id: plain
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
  - name: zen
    base_url: https://x.example
    models:
      - id: muse-spark-1.3
        egress: clash
`)
    const cfg = loadConfig(ok)
    expect(cfg.providers[0]!.models[0]!.egress).toBe('clash')

    const bad = write('egress-model-bad.yaml', `
providers:
  - name: zen
    base_url: https://x.example
    models:
      - id: muse-spark-1.3
        egress: nope
`)
    expect(() => loadConfig(bad)).toThrow(/egress/)
  })
})
