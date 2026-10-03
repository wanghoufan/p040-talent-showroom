import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * 系统栏主题桥接（T013/T083）。
 * 让 Android 状态栏/导航栏跟随 App 主题；Web 环境静默跳过。
 */
interface ThemeBarsPlugin {
  keepAwake(options:{enabled:boolean}):Promise<void>;
  setDark(options: { dark: boolean }): Promise<void>;
}

const ThemeBars = registerPlugin<ThemeBarsPlugin>('ThemeBars');

export async function applySystemBars(dark: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try { await ThemeBars.setDark({ dark }); } catch { /* 原生不可用时忽略 */ }
}

export async function keepScreenAwake(enabled:boolean):Promise<void>{if(Capacitor.isNativePlatform())await ThemeBars.keepAwake({enabled}).catch(()=>undefined);}
