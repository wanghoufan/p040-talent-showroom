import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 浏览器/组件测试默认 jsdom；Node 侧测试在文件顶部用 `// @vitest-environment node`。
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'android', 'dist'],
  },
});
