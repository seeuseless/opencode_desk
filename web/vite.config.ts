import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 9003,
    proxy: {
      // 开发时前端跑 9003，API 转到 35000 的本地服务端（server_cloudflare npm start 默认端口）
      '/api': { target: 'http://127.0.0.1:35000', changeOrigin: true }
    }
  }
})
