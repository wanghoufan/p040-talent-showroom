/**
 * 路由与导航表（V1.3-R2 §8 上下导航互换）。
 *
 * 底部固定四个主 Tab：舞蹈 / 唱歌 / 吉他 / 我的；今晚节目单与演出模式移到顶部「演出专区」。
 * 选中态由 pathname 推导：曲库与详情路径归属到对应才艺类别，避免顶部分类与新底栏重复展示同一组入口。
 */

export type NavTabKey = 'dance' | 'vocal' | 'guitar' | 'settings';

export interface NavTab {
  path: string;
  label: string;
  /** 用于无障碍与调试的稳定 key */
  key: NavTabKey;
}

export const NAV_TABS: readonly NavTab[] = [
  { path: '/', label: '舞蹈', key: 'dance' },
  { path: '/repertoire/vocal', label: '唱歌', key: 'vocal' },
  { path: '/repertoire/guitar', label: '吉他', key: 'guitar' },
  { path: '/settings', label: '我的', key: 'settings' },
] as const;

/** 顶部演出专区：常规列表、学习页与详情页都可到达，顺序固定。 */
export const SHOW_LINKS: readonly { path: string; label: string }[] = [
  { path: '/tonight', label: '今晚节目单' },
  { path: '/perform', label: '演出模式' },
] as const;

const UNDER = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

/** 曲库路径直接决定类别；详情路径需借助曲目 kind。 */
function directTalentKey(pathname: string): NavTabKey | null {
  if (UNDER(pathname, '/repertoire/guitar')) return 'guitar';
  if (UNDER(pathname, '/repertoire/vocal')) return 'vocal';
  return null;
}

/**
 * 底部 Tab 选中项。
 * - 详情 `/repertoire/item/:id` 用 kindOfItem 解析；缓存无此曲目时沿用最近一次的才艺 Tab（fallback）。
 * - 今晚节目单 / 演出模式不属于任何底栏 Tab，返回 null。
 */
export function activeNavKey(
  pathname: string,
  kindOfItem?: (id: string) => 'VOCAL' | 'GUITAR' | null,
  fallback: 'vocal' | 'guitar' = 'vocal',
): NavTabKey | null {
  if (UNDER(pathname, '/settings')) return 'settings';
  const direct = directTalentKey(pathname);
  if (direct) return direct;
  if (pathname === '/' || UNDER(pathname, '/dances')) return 'dance';
  if (UNDER(pathname, '/repertoire/item')) {
    const id = pathname.split('/')[3] ?? '';
    const kind = kindOfItem?.(id) ?? null;
    return kind === 'GUITAR' ? 'guitar' : kind === 'VOCAL' ? 'vocal' : fallback;
  }
  return null;
}
