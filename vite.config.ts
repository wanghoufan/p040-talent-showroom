import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// 版本号唯一真源＝android/app/build.gradle 的 versionName / versionCode，
// 构建时注入前端，避免「关于」页另写一份常量而与安装包不一致。
const gradle = readFileSync(new URL('./android/app/build.gradle', import.meta.url), 'utf8');
const appVersionName = /versionName\s+"([^"]+)"/.exec(gradle)?.[1] ?? '0.0.0';
const appVersionCode = /versionCode\s+(\d+)/.exec(gradle)?.[1] ?? '0';

// Dev 端口固定 127.0.0.1:5173，API 固定 127.0.0.1:8791（供 adb reverse 真机实时预览）。
// /api 代理到本地 Node API，便于浏览器与 USB 真机走同一条路径。
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersionName),
    __APP_BUILD__: JSON.stringify(appVersionCode),
  },
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
