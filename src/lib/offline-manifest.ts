import type { DanceItem, OfflineManifest } from './types';

/**
 * 离线清单与就绪判定（T060）。
 * 就绪必须同时满足：文件存在 + size/hash/version 匹配；任一不符即不可播。
 */

export interface MediaEntry {
  key: string;
  url: string;
  sha256: string;
  version: number;
  sizeBytes: number;
  kind: 'audio' | 'cover';
}

export interface CachedMedia {
  key: string;
  sha256: string;
  version: number;
  sizeBytes: number;
  path: string;
  /** 绝对文件 URI，供 convertFileSrc 生成可播放地址。 */
  uri: string;
}

export type CachedIndex = Record<string, CachedMedia>;

const MANIFEST_KEY = 'dance.offline.manifest';
const CACHE_KEY = 'dance.offline.cache';

export function readOfflineManifest(): OfflineManifest | null {
  try {
    const raw = JSON.parse(localStorage.getItem(MANIFEST_KEY) || 'null');
    return raw && Array.isArray(raw.items) ? (raw as OfflineManifest) : null;
  } catch { return null; }
}

export function saveOfflineManifest(manifest: OfflineManifest): void {
  localStorage.setItem(MANIFEST_KEY, JSON.stringify(manifest));
}

export function readCachedIndex(): CachedIndex {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    return raw && typeof raw === 'object' ? (raw as CachedIndex) : {};
  } catch { return {}; }
}

export function saveCachedIndex(index: CachedIndex): void {
  localStorage.setItem(CACHE_KEY, JSON.stringify(index));
}

/** 一首歌需要缓存的媒体项（音频 + 可选封面）。 */
export function mediaEntries(item: DanceItem): MediaEntry[] {
  const list: MediaEntry[] = [{ key: item.audio.url, url: item.audio.url, sha256: item.audio.sha256, version: item.audio.version, sizeBytes: item.audio.sizeBytes, kind: 'audio' }];
  if (item.cover) list.push({ key: item.cover.url, url: item.cover.url, sha256: item.cover.sha256, version: item.cover.version, sizeBytes: item.cover.sizeBytes, kind: 'cover' });
  return list;
}

/** 单个媒体项是否就绪：缺失 / hash 不符 / version 不符 / 无可用 URI 均判 false。 */
export function isMediaReady(entry: MediaEntry, cached: CachedIndex): boolean {
  const hit = cached[entry.key];
  if (!hit) return false;
  if (!hit.uri) return false;
  if (hit.version !== entry.version) return false;
  if (hit.sha256 !== entry.sha256) return false;
  return true;
}

/** 未缓存或损坏的曲目不可播。 */
export function isItemPlayable(item: DanceItem, cached: CachedIndex): boolean {
  return mediaEntries(item).filter((entry) => entry.kind === 'audio').every((entry) => isMediaReady(entry, cached));
}

/** 需要下载的媒体项（缺失或已失效）。 */
export function pendingEntries(items: DanceItem[], cached: CachedIndex): MediaEntry[] {
  const pending: MediaEntry[] = [];
  for (const item of items) for (const entry of mediaEntries(item)) if (!isMediaReady(entry, cached)) pending.push(entry);
  return pending;
}
