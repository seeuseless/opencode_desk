import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') }
  },
  // 产物直接落到 internal/web/dist，go:embed 随二进制一起走
  build: {
    outDir: '../internal/web/dist',
    emptyOutDir: true
  },
  server: {
    port: 9003,
    proxy: {
      // 开发时前端跑 9003，API 转到 9002 的服务端
      '/api': { target: 'http://127.0.0.1:9002', changeOrigin: true }
    }
  }
})
