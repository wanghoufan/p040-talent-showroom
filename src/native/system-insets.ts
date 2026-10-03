import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * 系统栏 inset 桥接（Android edge-to-edge 底部适配）。
 *
 * targetSdk 36 起 Android 强制 edge-to-edge，WebView 必然铺到系统导航栏下方；
 * 而 Android WebView 不会把系统栏 inset 暴露给 CSS 的 env(safe-area-inset-*)（实测恒为 0），
 * 故由原生 SystemInsetsPlugin 读 WindowInsetsCompat 后换算成 CSS px 注入
 * documentElement 的 --android-inset-* 变量，CSS 侧用 max(env(...), var(--android-inset-*)) 兜底两端。
 *
 * 原生侧在页面就绪/回前台时也会主动注入；这里额外在启动与尺寸变化时补一次，覆盖冷启动与
 * 导航模式切换（三键↔手势）等原生未重新 dispatch 的时机。Web 环境静默跳过。
 *
 * ⚠️ 单位契约：原生 read() 返回的 top/right/bottom/left 已经是「需要预留的 CSS px」
 * （原生侧按屏幕几何实测换算：WebView 未与系统栏重叠时返回 0），这里直接写入变量，
 * 不要再次按 devicePixelRatio 换算。
 */
interface SystemInsetsPlugin {
  read(): Promise<{ top: number; right: number; bottom: number; left: number }>;
}

const SystemInsets = registerPlugin<SystemInsetsPlugin>('SystemInsets');

function toCssPx(px: number): string {
  return `${Math.max(0, Math.round(Number(px) || 0))}px`;
}

export async function syncSystemInsets(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const insets = await SystemInsets.read();
    if (!insets) return;
    const root = document.documentElement.style;
    const next = {
      '--android-inset-top': toCssPx(insets.top),
      '--android-inset-right': toCssPx(insets.right),
      '--android-inset-bottom': toCssPx(insets.bottom),
      '--android-inset-left': toCssPx(insets.left),
    };
    let changed = false;
    for (const [key, value] of Object.entries(next)) {
      if (root.getPropertyValue(key) === value) continue;
      root.setProperty(key, value);
      changed = true;
    }
    // tabbar 的 padding 变化不改 content-box，ResizeObserver 不触发；显式通知布局重算
    if (changed) window.dispatchEvent(new Event('dance-insets-changed'));
  } catch {
    /* 原生插件不可用（旧包/非原生）时静默降级为 0，布局仍可用 */
  }
}

/** 启动后持续跟随系统栏变化：尺寸变化、旋转、前后台切换都重新读一次。 */
export function watchSystemInsets(): () => void {
  if (!Capacitor.isNativePlatform()) return () => undefined;
  let timer: number | undefined;
  const schedule = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => void syncSystemInsets(), 150);
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') void syncSystemInsets();
  };
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  document.addEventListener('visibilitychange', onVisible);
  void syncSystemInsets();
  return () => {
    if (timer !== undefined) window.clearTimeout(timer);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
