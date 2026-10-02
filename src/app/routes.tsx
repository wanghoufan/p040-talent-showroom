/**
 * 路由与底部导航表。
 *
 * 底部四 Tab 固定（UI Contract §Navigation）：曲库 / 今晚歌单 / 演出模式 / 我的。
 * 本阶段（Foundation，T007–T018）只建立空壳页面，不实现各用户故事业务。
 */

export interface NavTab {
  path: string;
  label: string;
  /** 用于无障碍与调试的稳定 key */
  key: 'library' | 'tonight' | 'perform' | 'settings';
}

export const NAV_TABS: readonly NavTab[] = [
  { path: '/', label: '曲库', key: 'library' },
  { path: '/tonight', label: '今晚歌单', key: 'tonight' },
  { path: '/perform', label: '演出模式', key: 'perform' },
  { path: '/settings', label: '我的', key: 'settings' },
] as const;
