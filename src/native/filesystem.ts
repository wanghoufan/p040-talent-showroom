import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { mediaUrl } from '../lib/api';
import { isItemPlayable, readCachedIndex, readOfflineManifest, referenceEntries, saveCachedIndex, type CachedIndex, type CachedMedia, type MediaEntry } from '../lib/offline-manifest';
import { findStoredVideoBySource, recoverStoredVideos, verifiedVideoUri } from '../lib/video-store';
import type { DanceItem } from '../lib/types';

/**
 * 离线媒体落盘（T060）。
 * 下载先写临时文件，校验通过后再原子替换目标文件，避免半包文件被当成可用缓存。
 */

const ROOT = 'dance-offline';

export function isOfflineSupported(): boolean {
  return Capacitor.isNativePlatform();
}

function slot(key: string): string {
  // 用稳定 key 派生文件名，避免 URL 中的斜杠进入路径。
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function filePath(entry: MediaEntry): string {
  const ext = entry.kind === 'cover' ? 'img' : entry.kind==='score'?'score':entry.kind==='reference'?'mp4':'audio';
  return `${ROOT}/${entry.kind}-${slot(entry.key)}.${ext}`;
}

/** 本地文件在 WebView 中可播放的地址（原生转 file:// 桥接）。 */
export function offlineUrl(uri: string): string {
  return Capacitor.convertFileSrc(uri);
}

/**
 * 播放地址解析：离线文件就绪时优先用本地缓存，否则回落到网络地址。
 * 曲库与演出模式共用，保证「已缓存条目离线冷启动仍可播放」（US5）。
 */
export function playbackSource(item: DanceItem, cached: CachedIndex): string {
  if (isOfflineSupported()) {
    const hit = cached[item.audio.url];
    if (hit?.uri && isItemPlayable(item, cached)) return offlineUrl(hit.uri);
  }
  return mediaUrl(item.audio.url);
}

/**
 * 原视频播放地址解析：已缓存到手机且文件真实存在时用本地地址，否则回落网络。
 * 与音乐播放解耦，原视频是否就绪不影响曲库离线可用。
 * 优先使用「导入时保存到私有目录的源视频」；该类副本独立于离线下载索引，重启后仍可播放。
 */
export async function referenceSource(sourceMediaId: string): Promise<{ src: string; offline: boolean }> {
  const key = `/api/media/reference/${sourceMediaId}`;
  let stored = findStoredVideoBySource(sourceMediaId);
  if (!stored) {
    // 索引可能被清理，sidecar 仍在：先补登记再判断，避免把已保存的视频当成没导入。
    await recoverStoredVideos();
    stored = findStoredVideoBySource(sourceMediaId);
  }
  if (stored) {
    const uri = await verifiedVideoUri(stored);
    if (uri) return { src: offlineUrl(uri), offline: true };
  }
  if (isOfflineSupported()) {
    const hit = readCachedIndex()[key];
    if (hit?.uri && await fileExists(hit.path)) return { src: offlineUrl(hit.uri), offline: true };
    const recovered = await recoverReferenceCache(key);
    if (recovered) return { src: offlineUrl(recovered.uri), offline: true };
  }
  return { src: mediaUrl(key), offline: false };
}

function referenceEntry(key: string): MediaEntry | undefined {
  const manifest = readOfflineManifest();
  if (!manifest) return undefined;
  for (const item of [...(manifest.items || []), ...(manifest.repertoire || [])]) {
    for (const entry of referenceEntries(item)) if (entry.key === key) return entry;
  }
  return undefined;
}

/**
 * 索引丢失但缓存文件还在时按确定性路径重建一条索引。
 * 只接受体积与清单一致的文件；不删除任何现存文件。
 */
async function recoverReferenceCache(key: string): Promise<CachedMedia | null> {
  const entry = referenceEntry(key);
  if (!entry) return null;
  const path = filePath(entry);
  // 上次原子替换中断会留下 .old：体积相符时先还原，不把可用副本判死。
  if (await sizeOf(path) !== entry.sizeBytes) {
    const backup = `${path}.old`;
    if (await sizeOf(backup) === entry.sizeBytes) {
      await Filesystem.rename({ from: backup, to: path, directory: Directory.Data, toDirectory: Directory.Data }).catch(() => undefined);
    }
  }
  if (await sizeOf(path) !== entry.sizeBytes) return null;
  try {
    const uri = (await Filesystem.getUri({ path, directory: Directory.Data })).uri;
    const record: CachedMedia = { key, sha256: entry.sha256, version: entry.version, sizeBytes: entry.sizeBytes, path, uri };
    const index = readCachedIndex();
    index[key] = record;
    saveCachedIndex(index);
    return record;
  } catch { return null; }
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const stat = await Filesystem.stat({ path, directory: Directory.Data });
    return stat.size;
  } catch { return null; }
}

/** 本地缓存文件是否真实存在（用于 readiness gate，防止文件被删后仍误判就绪）。 */
export async function fileExists(path: string): Promise<boolean> {
  try { await Filesystem.stat({ path, directory: Directory.Data }); return true; } catch { return false; }
}

/** Existing cache must match expected size on disk; metadata alone cannot establish readiness. */
export async function cachedFileValid(entry: MediaEntry, cached: CachedMedia): Promise<boolean> {
  return (await sizeOf(cached.path)) === entry.sizeBytes;
}

/** 下载单个媒体到本地缓存；成功返回 CachedMedia。 */
export async function downloadMedia(entry: MediaEntry): Promise<CachedMedia> {
  const dir = ROOT;
  try { await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true }); } catch { /* 已存在 */ }
  const target = filePath(entry);
  const temp = `${target}.tmp`;
  const backup = `${target}.old`;
  // 上次替换在改名中途被杀掉时，先把备份还原成正式缓存，避免把可用副本当成缺失重新下载。
  if (!(await fileExists(target)) && await fileExists(backup)) {
    await Filesystem.rename({ from: backup, to: target, directory: Directory.Data, toDirectory: Directory.Data }).catch(() => undefined);
  }
  await Filesystem.deleteFile({ path: temp, directory: Directory.Data }).catch(() => undefined);
  const result = await Filesystem.downloadFile({ url: mediaUrl(entry.url), path: temp, directory: Directory.Data, connectTimeout: 10000, readTimeout: 20000 });
  const size = await sizeOf(temp);
  if (size == null || size !== entry.sizeBytes) {
    await Filesystem.deleteFile({ path: temp, directory: Directory.Data }).catch(() => undefined);
    throw new Error('文件校验失败');
  }
  // 原子替换：旧文件先改名备份，新文件落位成功后才删备份；中途失败必须把旧副本还原。
  let backedUp = false;
  if (await fileExists(target)) {
    await Filesystem.deleteFile({ path: backup, directory: Directory.Data }).catch(() => undefined);
    try {
      await Filesystem.rename({ from: target, to: backup, directory: Directory.Data, toDirectory: Directory.Data });
      backedUp = true;
    } catch {
      throw new Error('旧缓存文件无法替换，已保留原文件');
    }
  }
  try {
    await Filesystem.rename({ from: temp, to: target, directory: Directory.Data, toDirectory: Directory.Data });
  } catch (error) {
    if (backedUp) await Filesystem.rename({ from: backup, to: target, directory: Directory.Data, toDirectory: Directory.Data }).catch(() => undefined);
    throw error;
  }
  if (backedUp) await Filesystem.deleteFile({ path: backup, directory: Directory.Data }).catch(() => undefined);
  // 用原生解析出的绝对 URI，绝不把下载临时路径写进索引；重启后仍指向真实文件。
  const uri = await Filesystem.getUri({ path: target, directory: Directory.Data })
    .then((value) => value.uri)
    .catch(() => (result.path || temp).replace(/\.tmp$/, ''));
  return { key: entry.key, sha256: entry.sha256, version: entry.version, sizeBytes: entry.sizeBytes, path: target, uri };
}

/** 删除某条缓存（用于缓存管理 / 失效清理）。 */
export async function removeCached(path: string): Promise<void> {
  await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => undefined);
}

/** 删除整个离线缓存目录。 */
export async function clearOfflineMedia(): Promise<void> {
  await Filesystem.rmdir({ path: ROOT, directory: Directory.Data, recursive: true }).catch(() => undefined);
}

/** 缓存目录已用字节数（用于缓存管理展示）。 */
export async function offlineBytes(): Promise<number> {
  try {
    const result = await Filesystem.readdir({ path: ROOT, directory: Directory.Data });
    let total = 0;
    for (const file of result.files) if (typeof file.size === 'number') total += file.size;
    return total;
  } catch { return 0; }
}
