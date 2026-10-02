import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { mediaUrl } from '../lib/api';
import { isItemPlayable, type CachedIndex, type CachedMedia, type MediaEntry } from '../lib/offline-manifest';
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
  const ext = entry.kind === 'cover' ? 'img' : 'audio';
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

/** 下载单个媒体到本地缓存；成功返回 CachedMedia。 */
export async function downloadMedia(entry: MediaEntry): Promise<CachedMedia> {
  const dir = ROOT;
  try { await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true }); } catch { /* 已存在 */ }
  const target = filePath(entry);
  const temp = `${target}.tmp`;
  await Filesystem.deleteFile({ path: temp, directory: Directory.Data }).catch(() => undefined);
  const result = await Filesystem.downloadFile({ url: mediaUrl(entry.url), path: temp, directory: Directory.Data });
  const size = await sizeOf(temp);
  if (size == null || size !== entry.sizeBytes) {
    await Filesystem.deleteFile({ path: temp, directory: Directory.Data }).catch(() => undefined);
    throw new Error('文件校验失败');
  }
  // 原子替换：先删旧目标，再把临时文件改名为目标。
  await Filesystem.deleteFile({ path: target, directory: Directory.Data }).catch(() => undefined);
  await Filesystem.rename({ from: temp, to: target, directory: Directory.Data, toDirectory: Directory.Data });
  // 原生返回的是绝对路径；去掉 .tmp 得到目标文件的绝对 URI，供播放地址转换。
  const uri = (result.path || temp).replace(/\.tmp$/, '');
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
