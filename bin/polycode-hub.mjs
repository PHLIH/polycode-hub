#!/usr/bin/env node
// bin shim：注册 tsx ESM 加载器后进入 TS 入口。
// 不用 node 原生类型剥离，因为 Node 拒绝对 node_modules 内的 .ts 做剥离。
import 'tsx/esm'
await import('../server/src/cli.ts')
