import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';

/**
 * 版本信息读取。
 * 原生（Android APK）优先读系统里真实的 versionName / versionCode，
 * 保证「关于」显示的是这个安装包自己的构建号，而不是编译时写死的常量。
 * 浏览器预览没有安装包，退回构建时从 android/app/build.gradle 注入的值。
 */
export interface AppVersion {
  version: string;
  build: string;
  /** native = 读自真实安装包；web = 构建期注入的同一份值 */
  source: 'native' | 'web';
}

// 构建期常量只在 Vite 构建/预览时由 define 注入；测试或其它运行时没有注入时，
// 用 typeof 守卫避免模块加载即抛 ReferenceError，并保留空值而不是编造版本。
const BUILD_TIME_VERSION: AppVersion = {
  version: typeof __APP_VERSION__ === 'undefined' ? '' : __APP_VERSION__,
  build: typeof __APP_BUILD__ === 'undefined' ? '' : __APP_BUILD__,
  source: 'web',
};

export async function readAppVersion(): Promise<AppVersion> {
  if (!Capacitor.isNativePlatform()) return BUILD_TIME_VERSION;
  try {
    const info = await App.getInfo();
    return { version: info.version, build: info.build, source: 'native' };
  } catch {
    return BUILD_TIME_VERSION;
  }
}
