import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  accountEffectiveStatus,
  accountHealth,
  applyReasoningFloor,
  capabilitiesFrom,
  credentialResolve,
  looksFree,
  modelEffAPI,
  providerValidate,
  reasoningFloorFor,
  riskAllowed,
  sanitizeReasoningMinTokens,
  supportsImage,
  forgetProtocol,
  autoProtocol,
  rememberProtocol,
  workBuddyRealmOfBaseUrl,
  workBuddyRealmOfIssuer,
  workBuddyRealmOfToken,
  workBuddyRealmLabel,
  FAILS_WARN_AT,
  type Account,
  type AccessKind,
  type CredentialRef,
  type Model,
  type Provider,
  type Risk,
  type Stability,
} from '../src/model/index.ts'

// Provider 身份已拆成「数字 providerId + 可变 name」：夹具给固定正数 id（0 = 待分配哨兵）。
const p = (over: Partial<Provider>): Provider => ({
  providerId: 1, name: 'demo', state: 'active', displayName: 'Demo', accessKind: 'official',
  risk: 'low', riskNote: '', stability: 'stable', api: '', baseUrl: 'https://x.example',
  credential: {}, headers: {}, priority: 0,
  streamOnly: false, models: [], probeModel: '', ...over,
})

describe('Provider 校验（对齐 Go provider.go Validate）', () => {
  test('合法 Provider 通过', () => {
    expect(providerValidate(p({}))).toBeUndefined()
  })

  test('name 非空 + 字符白名单（小写/数字/连字符）', () => {
    expect(providerValidate(p({ name: '' }))).toMatch(/name 不能为空/)
    expect(providerValidate(p({ name: 'Bad_ID' }))).toMatch(/只允许小写字母\/数字\/连字符/)
  })

  test('risk 非法 / medium+high 必须带 risk_note', () => {
    expect(providerValidate(p({ risk: ' extreme' as unknown as Risk }))).toMatch(/risk.*非法/)
    expect(providerValidate(p({ risk: 'medium' }))).toMatch(/risk_note/)
    expect(providerValidate(p({ risk: 'high', riskNote: '_reason' }))).toBeUndefined()
  })

  test('accessKind / stability / api 非法', () => {
    expect(providerValidate(p({ accessKind: 'hijack' as unknown as AccessKind }))).toMatch(/access_kind/)
    expect(providerValidate(p({ stability: 'nightly' as unknown as Stability }))).toMatch(/stability/)
    expect(providerValidate(p({ api: 'grpc' }))).toMatch(/api .*非法/)
    expect(providerValidate(p({ api: '' }))).toBeUndefined() // 空 = 自动探测
  })

  test('baseURL 必填；dynamic_headers.command 必须绝对路径', () => {
    expect(providerValidate(p({ baseUrl: '' }))).toMatch(/base_url 不能为空/)
    expect(providerValidate(p({ dynamicHeaders: { command: 'relative/cmd', args: [] } })))
      .toMatch(/绝对路径/)
    expect(providerValidate(p({ dynamicHeaders: { command: '/abs/cmd', args: [] } })))
      .toBeUndefined()
    expect(providerValidate(p({ dynamicHeaders: { command: '', args: [] } })))
      .toMatch(/command 不能为空/)
  })
})

describe('调度维度', () => {
  test('riskAllowed：数值上限过滤', () => {
    expect(riskAllowed('low', 'low')).toBe(true)
    expect(riskAllowed('low', 'medium')).toBe(false)
    expect(riskAllowed('high', 'medium')).toBe(true)
  })
})

describe('CredentialRef：凭据不落明文（文件热轮换语义）', () => {
  const env = new Map([['K', '  from-env  ']])
  const lookup = (n: string) => [env.get(n) ?? '', env.has(n)] as [string, boolean]

  test('api_key_file 优先且值 trim（每次现读）', () => {
    const ref: CredentialRef = { apiKeyFile: '/nonexistent/key' }
    expect(credentialResolve(ref, lookup)[1]).toBe(false)
  })

  test('env 引用解析（env 值不 trim，与 Go 一致；文件引用才 trim）', () => {
    expect(credentialResolve({ apiKeyEnv: 'K' }, lookup)).toEqual(['  from-env  ', true])
    expect(credentialResolve({ apiKeyEnv: 'MISSING' }, lookup)[1]).toBe(false)
  })

  test('空引用 = 无凭据（公开端点），返回 ("", true)', () => {
    expect(credentialResolve({}, lookup)).toEqual(['', true])
  })
})

describe('Model 目录条目', () => {
  const m = (over: Partial<Model>): Model => ({
    id: 'm1', displayName: '', contextWindow: 0,
    maxOutputTokens: 0, input: [], api: '', manual: false, enabled: true, ...over,
  })

  test('effAPI：模型级覆盖 > Provider 默认', () => {
    expect(modelEffAPI(m({ api: 'openai-responses' }), 'anthropic-messages')).toBe('openai-responses')
    expect(modelEffAPI(m({ api: '' }), 'anthropic-messages')).toBe('anthropic-messages')
  })

  test('supportsImage 只认显式 image 声明', () => {
    expect(supportsImage(m({ input: [] }))).toBe(false)
    expect(supportsImage(m({ input: ['text', 'image'] }))).toBe(true)
  })

  test('sanitizeReasoningMinTokens：键收小写、值须为 1-200000 正整数，空/非法全拒', () => {
    expect(sanitizeReasoningMinTokens({ XHIGH: 128000, Max: 200000 })).toEqual({ xhigh: 128000, max: 200000 })
    expect(sanitizeReasoningMinTokens({})).toBeUndefined()
    expect(sanitizeReasoningMinTokens(undefined)).toBeUndefined()
    expect(sanitizeReasoningMinTokens([])).toBeUndefined()
    expect(sanitizeReasoningMinTokens({ xhigh: 0 })).toBeUndefined()
    expect(sanitizeReasoningMinTokens({ xhigh: 200001 })).toBeUndefined()
    expect(sanitizeReasoningMinTokens({ xhigh: -5 })).toBeUndefined()
    expect(sanitizeReasoningMinTokens({ xhigh: 1.5 })).toBeUndefined()
    expect(sanitizeReasoningMinTokens({ xhigh: '8000' })).toBeUndefined()
    expect(sanitizeReasoningMinTokens({ '': 100 })).toBeUndefined()
  })

  test('applyReasoningFloor：只管 xhigh/max，只托底不封顶，没给值的不动', () => {
    const mm = m({ reasoningMinTokens: { xhigh: 128000, max: 200000 } })
    // 低于下限 → 抬到下限（返回副本，原对象不动）
    const req = { reasoningEffort: 'xhigh', maxTokens: 32768 }
    expect(applyReasoningFloor(req, mm)).toEqual({ reasoningEffort: 'xhigh', maxTokens: 128000 })
    expect(req).toEqual({ reasoningEffort: 'xhigh', maxTokens: 32768 })
    // 大小写不敏感；max 档同样托底
    expect(applyReasoningFloor({ reasoningEffort: 'XHigh', maxTokens: 1 }, mm)).toEqual({ reasoningEffort: 'XHigh', maxTokens: 128000 })
    expect(applyReasoningFloor({ reasoningEffort: 'max', maxTokens: 100 }, mm)).toEqual({ reasoningEffort: 'max', maxTokens: 200000 })
    // 高于下限 → 同一引用（没动过）
    const ok = { reasoningEffort: 'xhigh', maxTokens: 200000 }
    expect(applyReasoningFloor(ok, mm)).toBe(ok)
    // 没给值 → 不动（保持省略语义）
    const bare = { reasoningEffort: 'xhigh' }
    expect(applyReasoningFloor(bare, mm)).toBe(bare)
    // 其他档位一律不动（low/high/off/没传）
    expect(applyReasoningFloor({ reasoningEffort: 'high', maxTokens: 100 }, mm)).toEqual({ reasoningEffort: 'high', maxTokens: 100 })
    expect(applyReasoningFloor({ reasoningEffort: 'low', maxTokens: 100 }, mm)).toEqual({ reasoningEffort: 'low', maxTokens: 100 })
    expect(applyReasoningFloor({ reasoningEffort: 'off', maxTokens: 100 }, mm)).toEqual({ reasoningEffort: 'off', maxTokens: 100 })
    expect(applyReasoningFloor({ maxTokens: 100 }, mm)).toEqual({ maxTokens: 100 })
    // 无映射表 → 不动
    expect(applyReasoningFloor({ reasoningEffort: 'xhigh', maxTokens: 100 }, m({}))).toEqual({ reasoningEffort: 'xhigh', maxTokens: 100 })
  })

  test('reasoningFloorFor：只认 xhigh/max（大小写不敏感），其他档返回 undefined', () => {
    const mm = m({ reasoningMinTokens: { xhigh: 128000, max: 200000 } })
    expect(reasoningFloorFor('xhigh', mm)).toBe(128000)
    expect(reasoningFloorFor('MAX', mm)).toBe(200000)
    expect(reasoningFloorFor('high', mm)).toBeUndefined()
    expect(reasoningFloorFor('low', mm)).toBeUndefined()
    expect(reasoningFloorFor('off', mm)).toBeUndefined()
    expect(reasoningFloorFor(undefined, mm)).toBeUndefined()
    expect(reasoningFloorFor('xhigh', m({}))).toBeUndefined()
  })

  test('providerValidate 点名非法档位下限（含超 20w 上限）', () => {
    expect(providerValidate(p({ models: [m({ reasoningMinTokens: { xhigh: 128000 } })] }))).toBeUndefined()
    expect(providerValidate(p({ models: [m({ id: 'm9', reasoningMinTokens: { xhigh: 0 } })] }))).toMatch(/m9/)
    expect(providerValidate(p({ models: [m({ id: 'm9', reasoningMinTokens: { xhigh: 200001 } })] }))).toMatch(/m9/)
  })

  test('capabilitiesFrom：modalities 优先、vision 收敛为 image、无声明返回 null', () => {
    expect(capabilitiesFrom([], [], 0, 0)).toBeNull()
    expect(capabilitiesFrom(['text', 'vision'], [], 8192, 4096)).toEqual({
      input: ['text', 'image'], contextWindow: 8192, maxOutputTokens: 4096,
    })
    expect(capabilitiesFrom([], ['image'], 0, 0)).toEqual({
      input: ['image'], contextWindow: 0, maxOutputTokens: 0,
    })
    // 有 limit 无 input 声明：按文本兜底
    expect(capabilitiesFrom([], [], 4096, 0)).toEqual({
      input: ['text'], contextWindow: 4096, maxOutputTokens: 0,
    })
  })
})

describe('免费档启发式（独立词段才算）', () => {
  test('looksFree', () => {
    expect(looksFree('mimo-v2.5-free')).toBe(true)
    expect(looksFree('Free-Trial-X')).toBe(true)
    expect(looksFree('contributor-qwen')).toBe(true)
    expect(looksFree('freeform-model')).toBe(false) // 词段不是 free
    expect(looksFree('glm-4.6')).toBe(false)
  })
})

describe('账号池成员状态（冷却到期自动复位）', () => {
  const acct = (over: Partial<Account>): Account => ({
    id: 'a1', providerId: 1, displayName: '', credential: {},
    status: 'available', fails: 0, cooldownUntil: new Date(0), lastUsed: new Date(0),
    ...over,
  })

  test('cooldown 过期后视为 available（不回写）', () => {
    const now = new Date('2026-09-13T12:00:00Z')
    const a = acct({ status: 'cooldown', cooldownUntil: new Date('2026-09-13T11:00:00Z') })
    expect(accountEffectiveStatus(a, now)).toBe('available')
    const b = acct({ status: 'cooldown', cooldownUntil: new Date('2026-09-13T13:00:00Z') })
    expect(accountEffectiveStatus(b, now)).toBe('cooldown')
    expect(accountEffectiveStatus(acct({ status: 'disabled' }), now)).toBe('disabled')
  })

  test('健康度：可用绿、连败超阈值琥珀、冷却琥珀、禁用红', () => {
    const now = new Date('2026-09-13T12:00:00Z')
    expect(accountHealth(acct({}), now)).toBe('ok')
    // 阈值前一档仍绿：免费档间歇 429 不该一发就黄
    expect(accountHealth(acct({ fails: FAILS_WARN_AT - 1 }), now)).toBe('ok')
    expect(accountHealth(acct({ fails: FAILS_WARN_AT }), now)).toBe('warn')
    expect(accountHealth(acct({ status: 'cooldown', cooldownUntil: new Date('2026-09-13T13:00:00Z') }), now)).toBe('warn')
    // 冷却已过期 = 已恢复，不该继续显示琥珀
    expect(accountHealth(acct({ status: 'cooldown', cooldownUntil: new Date('2026-09-13T11:00:00Z') }), now)).toBe('ok')
    expect(accountHealth(acct({ status: 'disabled' }), now)).toBe('bad')
    expect(accountHealth(acct({ status: 'exhausted' }), now)).toBe('bad')
  })
})

describe('协议自动识别事实缓存（进程内）', () => {
  test('remember / autoProtocol / forget（modelID 空 = 清整 Provider）', () => {
    rememberProtocol('provA', 'm1', 'openai-completions')
    expect(autoProtocol('provA', 'm1')).toBe('openai-completions')
    rememberProtocol('provA', 'm2', 'openai-responses')
    forgetProtocol('provA', 'm1')
    expect(autoProtocol('provA', 'm1')).toBeUndefined()
    expect(autoProtocol('provA', 'm2')).toBe('openai-responses')
    forgetProtocol('provA', '')
    expect(autoProtocol('provA', 'm2')).toBeUndefined()
    // 无效入参静默忽略
    rememberProtocol('', 'm', 'openai-completions')
    rememberProtocol('provB', '', 'openai-completions')
    expect(autoProtocol('provB', '')).toBeUndefined()
  })
})

// WorkBuddy 双版本（国内版 / 海外版）：认证域与 token 互不通用，版本判定是
// 「发现 → 导入 → 代理」三处共用的地基，判定错了就会把海外号打进腾讯域名。
describe('WorkBuddy 版本判定（2026-09-19 双版本实测）', () => {
  test('base_url → 版本', () => {
    expect(workBuddyRealmOfBaseUrl('https://copilot.tencent.com/v2')).toBe('cn')
    expect(workBuddyRealmOfBaseUrl('https://www.workbuddy.ai/v2')).toBe('ai')
    expect(workBuddyRealmOfBaseUrl('https://www.workbuddy.cn/v2')).toBe('cn')
    // 非 WorkBuddy 上游不参与判定（别把 zen/deepseek 也认成某个版本）。
    expect(workBuddyRealmOfBaseUrl('https://api.deepseek.com')).toBeUndefined()
    expect(workBuddyRealmOfBaseUrl('https://opencode.ai/zen/v1')).toBeUndefined()
    expect(workBuddyRealmOfBaseUrl('not a url')).toBeUndefined()
  })

  test('issuer / 认证域字符串 → 版本（裸域与完整 URL 都认）', () => {
    expect(workBuddyRealmOfIssuer('www.workbuddy.ai')).toBe('ai')
    expect(workBuddyRealmOfIssuer('https://www.workbuddy.ai/auth/realms/copilot')).toBe('ai')
    expect(workBuddyRealmOfIssuer('www.workbuddy.cn')).toBe('cn')
    expect(workBuddyRealmOfIssuer('https://www.workbuddy.cn/auth/realms/copilot')).toBe('cn')
    // 大小写不敏感
    expect(workBuddyRealmOfIssuer('WWW.WorkBuddy.AI')).toBe('ai')
  })

  test('认不出 → undefined，绝不默认成国内版', () => {
    // 默认成 cn 正是把海外 token 打进腾讯域名、被 APISIX 拦成 HTML 401 的根因。
    expect(workBuddyRealmOfIssuer('')).toBeUndefined()
    expect(workBuddyRealmOfIssuer('example.com')).toBeUndefined()
    expect(workBuddyRealmOfIssuer('https://other.example/auth')).toBeUndefined()
  })

  test('JWT iss → 版本（不验签；坏 token 返回 undefined）', () => {
    const jwt = (iss: string) => {
      const b64 = Buffer.from(JSON.stringify({ iss })).toString('base64url')
      return `eyJhbGciOiJub25lIn0.${b64}.sig`
    }
    expect(workBuddyRealmOfToken(jwt('https://www.workbuddy.ai/auth/realms/copilot'))).toBe('ai')
    expect(workBuddyRealmOfToken(jwt('https://www.workbuddy.cn/auth/realms/copilot'))).toBe('cn')
    expect(workBuddyRealmOfToken('not-a-jwt')).toBeUndefined()
    expect(workBuddyRealmOfToken(jwt('https://other.example/auth'))).toBeUndefined()
  })

  test('版本中文名（文案统一出处）', () => {
    expect(workBuddyRealmLabel('ai')).toBe('海外版')
    expect(workBuddyRealmLabel('cn')).toBe('国内版')
    expect(workBuddyRealmLabel(undefined)).toBe('版本未知')
  })
})

// 红线自检：模型能力与 Go 侧 fixture 锚点一致（防止移植时字段漂移）。
describe('JSON 字段形状锚点', () => {
  test('Provider JSON 含 apiKeyEnv/baseUrl/streamOnly 等 camelCase 字段', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('./fixture/provider-shape.json', import.meta.url), 'utf8'))
    const got = p({
      credential: { apiKeyEnv: 'K' },
      headers: { 'X-Title': 't' },
      streamOnly: true,
      models: [{ id: 'm1', input: ['text'], manual: false, enabled: true }],
    }) as unknown as Record<string, unknown>
    for (const [k, v] of Object.entries(fixture)) {
      expect(JSON.stringify(got[k as keyof typeof got])).toBe(JSON.stringify(v))
    }
  })
})
