/**
 * 主题解析与应用。
 *
 * SPEC FR-021：支持 light/dark 双主题，默认跟随系统，选择需持久化。
 * 这里只处理“解析 + 落到 DOM”，持久化在 device-settings（Phase 3，T024）接入。
 */

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'] as const;
export const DEFAULT_THEME_MODE: ThemeMode = 'system';
export const THEME_STORAGE_KEY = 'dancelib.themeMode';

/** 把用户模式解析成实际主题；system 跟随 prefers-dark。 */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return prefersDark ? 'dark' : 'light';
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** 解析存储值：非法或缺失一律回退默认（system）。 */
export function parseStoredTheme(raw: string | null): ThemeMode {
  return isThemeMode(raw) ? raw : DEFAULT_THEME_MODE;
}

/** 把解析后的主题写到 <html data-theme>，供 CSS token 切换；同时设置 color-scheme。 */
export function applyTheme(resolved: ResolvedTheme, root: HTMLElement): void {
  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved;
}

/** 监听系统深浅色变化；返回取消订阅函数。 */
export function watchSystemTheme(
  onChange: (prefersDark: boolean) => void,
): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (event: MediaQueryListEvent) => onChange(event.matches);
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}

export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
