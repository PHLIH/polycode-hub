// ElMessage 双参误用守卫（真实缺陷回归）：
//
// 背景：ElMessage.success/warning/error/info 的函数签名是 (options, appContext)，
// 第二个位置参数是 Vue 的 appContext，不是选项对象（见
// web/node_modules/element-plus/es/components/message/src/method.mjs：
//   message[type] = (options = {}, appContext) => message({...normalizeOptions(options), type}, appContext)
//   createMessage: vnode.appContext = context || message._context
// 曾经 Providers.vue / Discover.vue 里写了 ElMessage.warning(w, { duration: 6000 })，
// { duration: 6000 } 被当成 appContext → vnode.appContext.provides 为 undefined →
// Vue 内部 Object.create(appContext.provides) 抛出
// 「Object prototype may only be an Object or null: undefined」（V8 原生文案）。
// 该异常发生在 ElMessage.warning 那一行，直接跳进 catch 弹红色报错，
// 而后面的 load() 根本没执行——用户看到“导入成功又报错”，列表还不刷新。
// 只有带 warnings 的导入才会触发（无 warnings 不走这行），所以时有时无、极具误导性。
//
// 正确写法：ElMessage.warning({ message: w, duration: 6000 })。
// 注意 ElMessageBox 不在此列——它的签名本就是 (message, title, options)，三参合法。
//
// 做法：扫描 web/src 下全部 .vue/.js/.ts（含多行调用），禁止
// ElMessage.success/warning/info/error/primary(...) 出现第二个位置参数。

import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const WEB_SRC = join(process.cwd(), 'web', 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(vue|js|ts)$/.test(f)) out.push(p)
  }
  return out
}

// 去掉 // 行注释与 /* */ 块注释，避免注释里的示例代码被误报。
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const CALLEE = ['success', 'warning', 'info', 'error', 'primary']

// 从 openIdx（'(' 的位置）向后扫描括号配平的调用实参，判断顶层是否有逗号
// （即是否存在第二个位置参数）。字符串/模板字符串/正则感知，跳过其中的逗号与括号。
// 返回 { hasSecondArg, endLine }，endLine 是调用右括号所在行号（1-based）。
function scanCall(src: string, openIdx: number, startLine: number): { hasSecondArg: boolean; endLine: number } {
  let depth = 0
  // brace/bracket 嵌套深度：对象字面量 { message: w, duration: 6000 } 里的逗号
  // 不是参数分隔，只有三者全为 0 级（即调用括号顶层）时的逗号才算第二个参数。
  let brace = 0
  let bracket = 0
  let line = startLine
  let hasSecondArg = false
  let i = openIdx
  let state: 'code' | 'sq' | 'dq' | 'tpl' | 're' = 'code'
  let tplExprDepth = 0
  const tplStack: number[] = []
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\n') line++
    if (state === 'sq') {
      if (ch === '\\') i++
      else if (ch === "'") state = 'code'
    } else if (state === 'dq') {
      if (ch === '\\') i++
      else if (ch === '"') state = 'code'
    } else if (state === 'tpl') {
      if (ch === '\\') i++
      else if (ch === '`') state = 'code'
      else if (ch === '$' && src[i + 1] === '{') { tplStack.push(tplExprDepth); tplExprDepth = depth; state = 'code'; i++ }
    } else {
      if (ch === "'") state = 'sq'
      else if (ch === '"') state = 'dq'
      else if (ch === '`') state = 'tpl'
      else if (ch === '/' && src[i + 1] === '/' ) { while (i < src.length && src[i] !== '\n') i++; continue }
      else if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) return { hasSecondArg, endLine: line }
      }
      else if (ch === '{') brace++
      else if (ch === '}') brace--
      else if (ch === '[') bracket++
      else if (ch === ']') bracket--
      else if (ch === ',' && depth === 1 && brace === 0 && bracket === 0) hasSecondArg = true
      else if (ch === '}' && tplStack.length > 0 && depth === tplStack[tplStack.length - 1]) { tplStack.pop(); tplExprDepth = 0; state = 'tpl' }
    }
    i++
  }
  return { hasSecondArg: false, endLine: line }
}

function checkFile(file: string, problems: string[]): void {
  const raw = readFileSync(file, 'utf8')
  const code = stripComments(raw)
  const re = /\bElMessage\.(success|warning|info|error|primary)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    const startLine = code.slice(0, m.index).split('\n').length
    const openIdx = m.index + m[0].length - 1
    const { hasSecondArg, endLine } = scanCall(code, openIdx, startLine)
    if (hasSecondArg) {
      const short = file.split('/').slice(-2).join('/')
      problems.push(short + ':' + startLine + (endLine !== startLine ? '-' + endLine : '') + ' ElMessage.' + m[1] + ' 带第二个位置参数（会被当成 appContext）')
    }
  }
}

describe('ElMessage 不得用双参形式（真实缺陷回归）', () => {
  test('ElMessage.xxx(msg, {...}) 必须写成 ElMessage.xxx({ message: msg, ... })', () => {
    const problems: string[] = []
    for (const file of walk(WEB_SRC)) checkFile(file, problems)
    expect(problems, problems.join('\n')).toEqual([])
  })
})
