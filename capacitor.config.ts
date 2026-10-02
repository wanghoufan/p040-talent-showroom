import type { CapacitorConfig } from '@capacitor/cli';

// 真机实时预览：CAP_LIVE=1 时 WebView 直接加载本机 Vite（经 adb reverse 127.0.0.1:5173），
// JS 改动即时生效，/api 由 Vite 代理到本地 Node API。默认（未设 CAP_LIVE）为打包 dist 交付态。
const liveReload = process.env.CAP_LIVE === '1';

const config: CapacitorConfig = {
  appId: 'com.wanghoufan.dancelibrary',
  appName: '舞蹈曲库',
  webDir: 'dist',
  // 交付态整机走私有 LAN 明文 HTTP：WebView 源同样用 http://localhost，
  // 避免 https 页面加载 http 媒体/接口被 mixed content 拦截（仅本机私有网络场景）。
  server: { androidScheme: 'http' },
  android: { backgroundColor: '#060B12', allowMixedContent: true },
  ...(liveReload ? { server: { url: 'http://127.0.0.1:5173', cleartext: true } } : {}),
};
export default config;
