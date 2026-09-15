import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts'],
    // node:sqlite 是 Node 22.13+ 新内置模块，vite 5 的内置清单未收录，需显式外置
    server: { deps: { external: ['node:sqlite'] } },
  },
})
