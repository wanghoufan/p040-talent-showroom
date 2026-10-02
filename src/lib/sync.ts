import { api } from './api';
import { readCachedIndex, saveCachedIndex, saveOfflineManifest, pendingEntries, mediaEntries, isMediaReady, type CachedIndex } from './offline-manifest';
import { downloadMedia, isOfflineSupported, fileExists } from '../native/filesystem';
import { readDeviceSettings, saveDeviceSettings } from './device-settings';
import type { DanceItem, OfflineManifest } from './types';

export interface SyncResult {
  catalogVersion: number;
  items: number;
  downloaded: number;
  skipped: number;
  mediaSupported: boolean;
  syncedAt: string;
}

/** 拉取清单并缓存未就绪的音频/封面。原生平台才真正下载媒体。 */
export async function syncLibrary(onProgress?: (done: number, total: number) => void): Promise<SyncResult> {
  const manifest = await api<OfflineManifest>('/api/sync/manifest');
  saveOfflineManifest(manifest);
  const cached: CachedIndex = readCachedIndex();
  const pending = pendingEntries(manifest.items, cached);
  let downloaded = 0;
  if (isOfflineSupported()) {
    for (const entry of pending) {
      try {
        const media = await downloadMedia(entry);
        cached[entry.key] = media;
        downloaded += 1;
      } catch { /* 单条失败不阻断整体；保持未就绪状态 */ }
      onProgress?.(downloaded, pending.length);
    }
    saveCachedIndex(cached);
  }
  const settings = readDeviceSettings();
  saveDeviceSettings({ ...settings, lastSyncAt: new Date().toISOString() });
  return {
    catalogVersion: manifest.catalogVersion,
    items: manifest.items.length,
    downloaded,
    skipped: pending.length - downloaded,
    mediaSupported: isOfflineSupported(),
    syncedAt: new Date().toISOString(),
  };
}

export interface PrepareResult { downloaded: number; total: number; ready: boolean; }

/** 准备离线演出（T076/T078）：校验本地文件真实存在，缺失则重下；全部通过才 Ready。 */
export async function prepareOffline(items: DanceItem[], onProgress?: (done: number, total: number) => void): Promise<PrepareResult> {
  const cached: CachedIndex = readCachedIndex();
  // 1) 索引命中但文件已被删除/丢失的，先作废（readiness 必须反映真实文件）。
  for (const item of items) for (const entry of mediaEntries(item)) {
    const hit = cached[entry.key];
    if (hit && !(await fileExists(hit.path))) delete cached[entry.key];
  }
  // 2) 下载缺失或失效的媒体。
  const pending = pendingEntries(items, cached);
  let downloaded = 0;
  if (isOfflineSupported()) {
    for (const entry of pending) {
      try { cached[entry.key] = await downloadMedia(entry); downloaded += 1; } catch { /* 保持未就绪 */ }
      onProgress?.(downloaded, pending.length);
    }
    saveCachedIndex(cached);
  }
  // 3) 最终校验：每条媒体索引就绪且文件真实存在。
  let ready = items.length > 0;
  for (const item of items) for (const entry of mediaEntries(item)) {
    const hit = cached[entry.key];
    if (!hit || !isMediaReady(entry, cached) || !(await fileExists(hit.path))) ready = false;
  }
  return { downloaded, total: pending.length, ready };
}
