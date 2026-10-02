/**
 * SourceAdapter registry（T029/T054）。
 *
 * 唯一的外部来源取得入口：不做通用 URL 抓取，不绕过平台限制。
 * 每个 adapter 描述自己是否能合法取得媒体；不能取得时返回 NEEDS_INPUT，
 * 由用户手动补充本地视频。adapter 只做声明式匹配 + 可选受限取得。
 */
const adapters = new Map();

export function registerAdapter(adapter) {
  if (!adapter || typeof adapter.id !== 'string' || typeof adapter.matches !== 'function') throw new Error('INVALID_ADAPTER');
  adapters.set(adapter.id, adapter);
  return adapter;
}
export function getAdapter(id) { return adapters.get(id) || null; }
export function listAdapters() { return [...adapters.values()].map(({ id, label, canAcquire }) => ({ id, label, canAcquire: !!canAcquire })); }

/** 按已规范化链接选择 adapter；未注册 host 一律拒绝。 */
export function selectAdapter(normalizedUrl) {
  for (const adapter of adapters.values()) if (adapter.matches(normalizedUrl)) return adapter;
  return null;
}
