import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 构建产物输出到 web/dist，由网关进程运行时读取并挂载在 /admin
// （server/src/gateway/adminui.ts）。改动源码后需 `npm run build --prefix web` 才生效。
export default defineConfig({
  plugins: [vue()],
  base: '/admin/',
  // dev 下前端由 vite 出、API 转给本机网关（管理口令为空时免鉴权）
  server: {
    proxy: { '/admin/api': 'http://127.0.0.1:3000' }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
