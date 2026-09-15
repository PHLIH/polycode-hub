// 前端模板完整性守卫：编译每个 .vue 的 <template>，报告引用了但未定义的标识符。
//
// 背景（真实缺陷）：移除「内置 Provider」时删掉了 Provider.vue 里的 isBuiltin()，
// 却漏掉模板里一处 `v-if="!isBuiltin(row)"`。tsc --noEmit 不编译 Vue 模板、
// vite build 也不报未定义符号——两者都通过了，但页面上那个删除按钮渲染失败，
// 用户"什么都删不了"。这类错误必须在测试里拦下来。
//
// 做法：用 @vue/compiler-sfc 编译模板（与 vite 同一条编译路径），收集编译期
// 报出的未解析标识符；再比对 <script setup> 里实际定义的绑定名。

import { describe, expect, test } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// @vue/compiler-sfc 装在 web/ 下（根 node_modules 没有），从那里解析。
const webRequire = createRequire(join(process.cwd(), 'web', 'package.json'))
const { parse, compileTemplate } = webRequire('@vue/compiler-sfc') as {
  parse: (src: string, o?: unknown) => { descriptor: { template?: { content: string; lang?: string }; scriptSetup?: { content: string } } }
  compileTemplate: (o: { source: string; filename: string; id: string }) => { errors: unknown[] }
}

const VIEWS = join(process.cwd(), 'web', 'src', 'views')

function vueFiles(): string[] {
  return readdirSync(VIEWS).filter((f) => f.endsWith('.vue')).map((f) => join(VIEWS, f))
}

// 从 <script setup> 里抽出顶层绑定名（const/let/function/import + defineProps 解构）。
function scriptBindings(src: string): Set<string> {
  const names = new Set<string>()
  for (const m of src.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]!)
  for (const m of src.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) names.add(m[1]!)
  // import { a, b as c } from '...'
  for (const m of src.matchAll(/\bimport\s*\{([^}]+)\}/g)) {
    for (const part of m[1]!.split(',')) {
      const alias = part.includes(' as ') ? part.split(' as ')[1] : part
      const n = alias?.trim()
      if (n) names.add(n)
    }
  }
  return names
}

describe('Vue 模板不得引用未定义标识符（真实缺陷回归）', () => {
  test('每个视图模板引用的函数/变量都在 script 里有定义', () => {
    const problems: string[] = []
    for (const file of vueFiles()) {
      const raw = readFileSync(file, 'utf8')
      const { descriptor } = parse(raw, { filename: file })
      if (!descriptor.template) continue
      const bindings = scriptBindings(descriptor.scriptSetup?.content ?? '')

      // 编译模板：未定义标识符会以编译错误形式出现（与 vite 同一编译器）。
      const res = compileTemplate({
        source: descriptor.template.content,
        filename: file,
        id: 'guard',
      })
      for (const e of res.errors ?? []) {
        const msg = typeof e === 'string' ? e : ((e as { message?: string }).message ?? JSON.stringify(e))
        problems.push(`${file.split('/').pop()}: ${msg}`)
      }

      // 兜底：模板里以调用形式出现的本地函数名必须能在 script 绑定里找到。
      // 只认「表达式开头的裸标识符调用」——`@click="remove(row)"`、`v-if="fn(x)"`。
      // 前导 `!` / 空格允许（v-if="!isBuiltin(row)"）；带点的（a.trim()）与
      // 关键字（'a' in b）一律跳过，否则内置方法会被误报成未定义。
      const callRe = /(?:@[\w.]+|v-if|v-else-if|v-show)="\s*!?\s*([A-Za-z_$][\w$]*)\s*\(/g
      for (const m of descriptor.template.content.matchAll(callRe)) {
        const fn = m[1]!
        if (!bindings.has(fn)) {
          problems.push(`${file.split('/').pop()}: 模板调用了未定义的 ${fn}()`)
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
  })
})
