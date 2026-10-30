import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const native = { value: false };
const getInfo = vi.fn();

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => native.value },
}));
vi.mock('@capacitor/app', () => ({ App: { getInfo } }));

async function load() {
  vi.resetModules();
  return import('../../src/native/app-version');
}

beforeEach(() => { native.value = false; getInfo.mockReset(); });
afterEach(() => { delete (globalThis as Record<string, unknown>).__APP_VERSION__; delete (globalThis as Record<string, unknown>).__APP_BUILD__; });

it('浏览器预览读取构建期注入的版本，不编造', async () => {
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '1.4.2';
  (globalThis as Record<string, unknown>).__APP_BUILD__ = '27';
  const { readAppVersion } = await load();
  await expect(readAppVersion()).resolves.toEqual({ version: '1.4.2', build: '27', source: 'web' });
});

it('构建常量缺失时安全回退为空值而不是崩溃', async () => {
  const { readAppVersion } = await load();
  await expect(readAppVersion()).resolves.toEqual({ version: '', build: '', source: 'web' });
});

it('原生读取安装包真实 versionName/versionCode', async () => {
  native.value = true;
  getInfo.mockResolvedValue({ version: '2.0.1', build: '103' });
  const { readAppVersion } = await load();
  await expect(readAppVersion()).resolves.toEqual({ version: '2.0.1', build: '103', source: 'native' });
});

it('原生读取失败时回退到构建期注入值', async () => {
  native.value = true;
  getInfo.mockRejectedValue(new Error('boom'));
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '1.4.2';
  (globalThis as Record<string, unknown>).__APP_BUILD__ = '27';
  const { readAppVersion } = await load();
  await expect(readAppVersion()).resolves.toEqual({ version: '1.4.2', build: '27', source: 'web' });
});
