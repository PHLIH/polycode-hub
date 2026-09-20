// Provider 身份字段守卫：前端只能通过 providerId 认 Provider。
//
// 背景（真实缺陷，两次复发）：Provider 的对外形状里**没有** id 字段，
// 只有自增的 providerId。前端把它写成 `.id` 时取到 undefined，请求打到
// /admin/api/providers/undefined/models，后端 Number() 化后报
// 「provider #undefined 不存在」——用户看到的是"模型保存不了"，
// 而报错里看不出是谁传错了。tsc --noEmit 不编译 .vue、vite build 也不报
// 属性不存在，两关都能过，所以必须在测试里拦下来。
//
// 两道防线：
//   1) 形状契约：GET /admin/api/providers 下发的每个 Provider 必须带
//      providerId、且不得带裸 id（前端据此取字段，多一个 id 就会诱导误用）。
//   2) 源码守卫：Provider 相关视图里，持有 Provider 的标识符不得被读 .id。

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAdminApi } from '../src/adminapi/index.ts'
import { MemoryAccountStore, MemoryProviderStore } from '../src/adminapi/store.ts'
import type { Provider } from '../src/model/index.ts'

const ROOT = process.cwd()

// ---- 防线 1：响应形状 ----

const mkProvider = (over: Partial<Provider> & Pick<Provider, 'name'>): Provider => {
  const p: Provider = {
    providerId: 0, name: over.name, state: 'active', displayName: '', accessKind: 'official',
    risk: 'low', stability: 'stable', api: '', baseUrl: '', credential: {},
    priority: 0, models: [],
  }
  for (const [k, v] of Object.entries(over)) {
    if (k !== 'name') (p as unknown as Record<string, unknown>)[k] = v
  }
  return p
}

const statsStub = {
  summarize: () => ({
    requests: 0,
    tokens: {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, reasoningTokens: 0, totalTokens: 0,
    },
    errors: 0,
  }),
  breakdown: () => Promise.resolve({
    totals: {
      requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, reasoningTokens: 0, totalTokens: 0, errors: 0, cacheHitRate: 0,
      inputSideTokens: 0,
    },
    daily: [], byModel: [],
  }),
}

describe('Provider 下发形状：有 providerId，无裸 id', () => {
  test('GET /admin/api/providers 的每个元素都不带 id 字段', async () => {
    const app = createAdminApi({
      adminKey: 'secret',
      providers: new MemoryProviderStore([
        mkProvider({ name: 'atria', providerId: 1 }),
        mkProvider({ name: 'workbuddy', providerId: 5, state: 'paused' }),
      ]),
      accounts: new MemoryAccountStore([]),
      stats: statsStub as never,
    })
    const res = await app.request('/admin/api/providers', { headers: { 'X-Admin-Key': 'secret' } })
    expect(res.status).toBe(200)
    const body = await res.json() as { providers?: Record<string, unknown>[] }
    const ps = body.providers ?? (body as unknown as Record<string, unknown>[])
    expect(Array.isArray(ps)).toBe(true)
    expect(ps.length).toBe(2)
    for (const p of ps) {
      // 有 providerId：前端唯一的身份来源
      expect(typeof p['providerId']).toBe('number')
      // 没有裸 id：多一个同义字段只会诱导前端写错（历史缺陷正是这么来的）
      expect(p).not.toHaveProperty('id')
    }
  })
})

// ---- 防线 2：源码守卫 ----

// Provider 相关视图 + 其中「持有 Provider 对象」的标识符。
// 这些名字被读 `.id` 就是缺陷：它们指向的对象没有 id 字段。
const PROVIDER_FILES: { file: string; holders: string[] }[] = [
  // list 是 Provider 数组，循环变量一律叫 p
  { file: 'web/src/views/Providers.vue', holders: ['p', 'modelsTarget.value', 'modelsTarget', 'editing.value', 'target'] },
  { file: 'web/src/views/ProviderCard.vue', holders: ['p', 'props.p'] },
  // providers.value 循环变量叫 p；注意 a 是账号、m 是模型、g 是分组键，都不在此列
  { file: 'web/src/views/Accounts.vue', holders: ['p'] },
  // api.adopt 返回的是 Provider 本体
  { file: 'web/src/views/Discover.vue', holders: ['p'] },
  // providers.value.find(...) 的结果
  { file: 'web/src/views/Dashboard.vue', holders: ['p'] },
]

// 屏蔽注释，避免把「解释这个缺陷」的注释本身当成缺陷。
//
// 关键：注释内容换成等长空白，**换行原样保留**，这样行号不偏移——
// 报错里的 file:line 必须能直��跳过去，否则守卫的提示等于没用
// （第一版用 replace 删掉整行，注入测试时报 445 而真实位置在 467）。
function maskComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ')
  return src
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^\s*\/\/[^\n]*/gm, blank)
    .replace(/([^:'"`])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length))
}

describe('Provider 视图不得把 Provider 读成 .id（两次真实复发的回归锚点）', () => {
  test('持有 Provider 的标识符只准用 providerId', () => {
    const problems: string[] = []
    for (const { file, holders } of PROVIDER_FILES) {
      const raw = readFileSync(join(ROOT, file), 'utf8')
      // 行号必须与磁盘上的原文一一对应，报错才能直接定位
      const src = maskComments(raw)
      const lines = src.split('\n')
      for (const holder of holders) {
        // 转义 `.`（对象属性访问），拼出 `holder.id` 的精确匹配，
        // 边界用非标识符字符，避免 `props.p.id` 被 `p.id` 重复计数、
        // 也避免 `map.id` 撞上 `p.id`。
        const re = new RegExp(`(^|[^\\w$.])${holder.replace(/\./g, '\\.')}\\.id\\b`)
        lines.forEach((line, i) => {
          if (re.test(line)) {
            problems.push(`${file}:${i + 1} 把 Provider 当 .id 用（应为 .providerId）→ ${line.trim()}`)
          }
        })
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
  })

  test('守卫本身有效：注入 `modelsTarget.value.id` 必须能被抓到', () => {
    // 自检：正则若写错（比如漏了转义）会静默放行，这里用一段假源码证明它真会报。
    const fake = 'const x = modelsTarget.value.id\nconst y = p.id\nconst ok = m.id + e.id'
    const src = maskComments(fake)
    const re = new RegExp(`(^|[^\\w$.])modelsTarget\\.value\\.id\\b`)
    expect(re.test(src)).toBe(true)
    const reP = new RegExp(`(^|[^\\w$.])p\\.id\\b`)
    expect(reP.test(src)).toBe(true)
    // 上面三条只证明正则对各自形态有效。真正的"不误伤"靠 m/e 不在 PROVIDER_FILES
    // 的 holders 列表里（见该文件 90 行注释），而不是靠正则放过它们——
    // 换言之，若哪天把 m 或 e 加进 holders，这些 .id 就会真的被报出来。
    expect(new RegExp(`(^|[^\\w$.])m\\.id\\b`).test(src)).toBe(true)
  })

  test('报错行号与磁盘原文一一对应', () => {
    // 注入一行缺陷，报出来的行号必须等于它在文件里的真实行号。
    const file = 'web/src/views/Providers.vue'
    const raw = readFileSync(join(ROOT, file), 'utf8')
    const realLine = raw.split('\n').findIndex((l) => l.includes('await api.fetchProviderModels(modelsTarget.value.providerId)')) + 1
    expect(realLine).toBeGreaterThan(0)
    // maskComments 不增删行，行数必须完全一致
    expect(maskComments(raw).split('\n').length).toBe(raw.split('\n').length)
    // 缺陷在真文件里的行号：把 providerId 换成 id 后，守卫必须报这一行
    const injected = raw.replace(
      'await api.fetchProviderModels(modelsTarget.value.providerId)',
      'await api.fetchProviderModels(modelsTarget.value.id)',
    )
    const lines = maskComments(injected).split('\n')
    const hit = lines.findIndex((l) => /(^|[^\w$.])modelsTarget\.value\.id\b/.test(l)) + 1
    expect(hit).toBe(realLine)
  })
})