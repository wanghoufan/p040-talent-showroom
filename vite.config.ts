import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev 端口固定 127.0.0.1:5173，API 固定 127.0.0.1:8791（供 adb reverse 真机实时预览）。
// /api 代理到本地 Node API，便于浏览器与 USB 真机走同一条路径。
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8791',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
