import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: { lib: { entry: 'electron/main/index.ts' } }
  },
  preload: {
    build: { lib: { entry: 'electron/preload/index.ts' } }
  },
  renderer: {
    plugins: [react()]
  }
})
