/**
 * 抖音来源 adapter（T054）。
 *
 * 安全边界：不实现通用抓取、不调用第三方解析站。
 * 当前不具备合法取得能力 → canAcquire=false → 上层返回 NEEDS_INPUT，
 * 用户可手动选择本地视频补充，原链接会被保留。
 */
const HOSTS = new Set(['v.douyin.com', 'www.douyin.com', 'douyin.com']);
export const douyinAdapter = {
  id: 'douyin',
  label: '抖音分享链接',
  canAcquire: false,
  matches(url) { try { return HOSTS.has(new URL(url).hostname); } catch { return false; } },
  capability() { return { canAcquire: false, reason: 'NEEDS_INPUT' }; },
};
