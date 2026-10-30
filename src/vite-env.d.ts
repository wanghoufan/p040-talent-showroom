/// <reference types="vite/client" />

// 构建期由 vite.config.ts 从 android/app/build.gradle 注入，供「关于」在浏览器预览时显示。
declare const __APP_VERSION__: string;
declare const __APP_BUILD__: string;
