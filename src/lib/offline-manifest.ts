import {readMetadata,writeMetadata} from './local-database';
import {resolveTracks, trackPairStatus, uniqueTrackMedia} from './vocal';
import type { DanceItem, MediaFile, OfflineManifest, TalentItem, VocalTrackRole } from './types';

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
  kind: 'audio' | 'cover' | 'score' | 'reference';
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
    const raw = JSON.parse(readMetadata(MANIFEST_KEY) || 'null');
    return raw && Array.isArray(raw.items) ? (raw as OfflineManifest) : null;
  } catch { return null; }
}

export function saveOfflineManifest(manifest: OfflineManifest): void {
  writeMetadata(MANIFEST_KEY, JSON.stringify(manifest));
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

function entryOf(media: MediaFile, kind: MediaEntry['kind']): MediaEntry {
  return { key: media.url, url: media.url, sha256: media.sha256, version: media.version, sizeBytes: media.sizeBytes, kind };
}

export function isVocal(item: DanceItem | TalentItem): item is TalentItem {
  return 'kind' in item && item.kind === 'VOCAL';
}

/**
 * 一首歌需要缓存的媒体项（音频 + 可选封面/乐谱）。
 * VOCAL 额外收集原唱与伴奏，同一 URL 只缓存一次（同一原唱不会被当成两条音轨分别下载）；
 * 旧 `audio` 仍是合法回退项，因此只迁移了一半的曲目照样能离线播放。
 */
export function mediaEntries(item: DanceItem|TalentItem): MediaEntry[] {
  const list: MediaEntry[] = [];
  const seen = new Set<string>();
  const push = (media: MediaFile, kind: MediaEntry['kind']) => {
    if (!media.url || seen.has(media.url)) return;
    seen.add(media.url);
    list.push(entryOf(media, kind));
  };
  if (item.audio) push(item.audio, 'audio');
  if (isVocal(item) && item.tracks) for (const media of uniqueTrackMedia(resolveTracks(item))) push(media, 'audio');
  if (item.cover) push(item.cover, 'cover');
  for (const score of item.scores || []) push(score, 'score');
  return list;
}

/** 按角色列出的音轨就绪态：null 表示该轨本来就没有，不能用另一轨顶替。 */
export function vocalTrackReadiness(item: TalentItem, cached: CachedIndex): Record<VocalTrackRole, boolean | null> {
  const tracks = item.kind === 'VOCAL' ? resolveTracks(item) : {};
  const check = (role: VocalTrackRole) => {
    const media = tracks[role]?.media;
    return media ? isMediaReady(entryOf(media, 'audio'), cached) : null;
  };
  return { original: check('original'), accompaniment: check('accompaniment') };
}

/** 演出用媒体：VOCAL 只认伴奏，缺伴奏返回 null，绝不用原唱冒充。 */
export function performanceMedia(item: DanceItem | TalentItem): MediaFile | null {
  if (isVocal(item)) return resolveTracks(item).accompaniment?.media || null;
  return item.audio || null;
}

/**
 * 演出就绪：VOCAL 必须有伴奏且已缓存；只有原唱的曲目明确「未准备好」。
 * 原唱与伴奏指向同一文件时不是真双轨，同样判未准备好。
 * 纯文本曲目（无任何音频）无需下载，视为就绪。
 */
export function isPerformanceReady(item: DanceItem | TalentItem, cached: CachedIndex): boolean {
  if (!isVocal(item)) return item.audio ? isMediaReady(entryOf(item.audio, 'audio'), cached) : false;
  const tracks = resolveTracks(item);
  if (!tracks.original && !tracks.accompaniment && !item.audio) return true;
  if (trackPairStatus(tracks).state === 'same-media') return false;
  const accompaniment = tracks.accompaniment?.media;
  return accompaniment ? isMediaReady(entryOf(accompaniment, 'audio'), cached) : false;
}

/**
 * 原视频（source_media）的缓存项。刻意不进 mediaEntries：
 * 体积大（全库约 360MB）且不影响「可离线播放」判定，须由用户单独触发下载。
 */
export function referenceEntries(item: DanceItem|TalentItem): MediaEntry[] {
  const source = item.source;
  if (!source?.url || typeof source.sizeBytes !== 'number') return [];
  return [{ key: source.url, url: source.url, sha256: source.sha256, version: source.version ?? 1, sizeBytes: source.sizeBytes, kind: 'reference' }];
}

/** 单个媒体项是否就绪：缺失 / hash / version / 体积不符 / 无可用 URI 均判 false。 */
export function isMediaReady(entry: MediaEntry, cached: CachedIndex): boolean {
  const hit = cached[entry.key];
  if (!hit) return false;
  if (!hit.uri) return false;
  if (hit.version !== entry.version) return false;
  if (hit.sha256 !== entry.sha256) return false;
  // 索引记录了体积就必须与清单一致；早期索引没有该字段时跳过，避免把历史缓存一律判死。
  if (typeof hit.sizeBytes === 'number' && hit.sizeBytes !== entry.sizeBytes) return false;
  return true;
}

/**
 * 旧播放器口径：只看 `audio` 这一条媒体是否就绪。
 * VOCAL 双轨的演出就绪用 isPerformanceReady 单独判定，避免把「原唱没缓存」误判成整首不可播。
 */
export function isItemPlayable(item: DanceItem | TalentItem, cached: CachedIndex): boolean {
  return item.audio ? isMediaReady(entryOf(item.audio, 'audio'), cached) : true;
}

/** 需要下载的媒体项（缺失或已失效）。 */
export function pendingEntries(items: (DanceItem|TalentItem)[], cached: CachedIndex): MediaEntry[] {
  const pending: MediaEntry[] = [];
  for (const item of items) for (const entry of mediaEntries(item)) if (!isMediaReady(entry, cached)) pending.push(entry);
  return pending;
}
