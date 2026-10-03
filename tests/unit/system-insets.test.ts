import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Android edge-to-edge 底部适配回归：
 * targetSdk 36 强制 edge-to-edge，Android WebView 的 env(safe-area-inset-*) 恒为 0，
 * 必须由原生 SystemInsetsPlugin 注入 --android-inset-*，且 tabbar 高度变化要触发布局重测。
 */
const readMock = vi.fn();

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({ read: readMock }),
}));

async function loadModule() {
  vi.resetModules();
  return import('../../src/native/system-insets');
}

beforeEach(() => {
  readMock.mockReset();
  document.documentElement.removeAttribute('style');
});

afterEach(() => {
  document.documentElement.removeAttribute('style');
  vi.restoreAllMocks();
});

describe('系统栏 inset 注入', () => {
  it('把原生返回的像素值写入 CSS 变量', async () => {
    readMock.mockResolvedValue({ top: 66, right: 0, bottom: 130, left: 0 });
    const { syncSystemInsets } = await loadModule();
    await syncSystemInsets();
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--android-inset-bottom')).toBe('130px');
    expect(style.getPropertyValue('--android-inset-top')).toBe('66px');
    expect(style.getPropertyValue('--android-inset-left')).toBe('0px');
  });

  it('负值/缺失值归零为 0px，不产生非法 CSS', async () => {
    readMock.mockResolvedValue({ top: -1, right: undefined, bottom: 0, left: 0 });
    const { syncSystemInsets } = await loadModule();
    await syncSystemInsets();
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--android-inset-top')).toBe('0px');
    expect(style.getPropertyValue('--android-inset-right')).toBe('0px');
  });

  it('值变化时派发 dance-insets-changed，供布局重测 tabbar 高度', async () => {
    readMock.mockResolvedValue({ top: 0, right: 0, bottom: 130, left: 0 });
    const listener = vi.fn();
    window.addEventListener('dance-insets-changed', listener);
    const { syncSystemInsets } = await loadModule();
    await syncSystemInsets();
    expect(listener).toHaveBeenCalledTimes(1);
    // 值未变时不重复派发
    await syncSystemInsets();
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('dance-insets-changed', listener);
  });

  it('原生不可用时静默降级，不抛错', async () => {
    readMock.mockRejectedValue(new Error('not implemented'));
    const { syncSystemInsets } = await loadModule();
    await expect(syncSystemInsets()).resolves.toBeUndefined();
  });

  it('watchSystemInsets 在取消后移除全部监听', async () => {
    readMock.mockResolvedValue({ top: 0, right: 0, bottom: 130, left: 0 });
    const winRemove = vi.spyOn(window, 'removeEventListener');
    const docRemove = vi.spyOn(document, 'removeEventListener');
    const { watchSystemInsets } = await loadModule();
    const stop = watchSystemInsets();
    expect(readMock).toHaveBeenCalledTimes(1);
    stop();
    for (const type of ['resize', 'orientationchange']) {
      expect(winRemove.mock.calls.some(([t]) => t === type)).toBe(true);
    }
    expect(docRemove.mock.calls.some(([t]) => t === 'visibilitychange')).toBe(true);
  });
});
