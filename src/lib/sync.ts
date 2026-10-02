import { api } from './api';
import { readCachedIndex, saveCachedIndex, readOfflineManifest, saveOfflineManifest, pendingEntries, mediaEntries, isMediaReady, isItemPlayable, type CachedIndex, type MediaEntry } from './offline-manifest';
import { downloadMedia, isOfflineSupported, fileExists, cachedFileValid } from '../native/filesystem';
import { readDeviceSettings, saveDeviceSettings } from './device-settings';
import type { DanceItem, OfflineManifest } from './types';

export interface SyncFailure { key: string; title: string; kind: 'audio' | 'cover'; }
export interface SyncProgress {
  stage: 'manifest' | 'check' | 'download'; processed: number; total: number;
  downloaded: number; failed: number; pendingBytes: number; currentTitle?: string;
}
export interface SyncResult {
  catalogVersion: number; items: number; downloaded: number; skipped: number;
  mediaSupported: boolean; syncedAt: string; readyItems: number;
  failed: SyncFailure[]; cancelled: boolean; complete: boolean;
}
const REPORT_KEY = 'dance.offline.sync-report';
let syncing = false;
export function isLibrarySyncRunning(): boolean { return syncing; }
function playableCatalog(manifest: OfflineManifest): DanceItem[] {
  return [...manifest.items, ...(manifest.repertoire || []).filter(item => item.audio).map(item => ({ ...item, audio: item.audio!, performanceClipId: item.performanceClipId!, sceneTags: [] }))];
}
export function readSyncReport(): SyncResult | null {
  try { const raw = JSON.parse(localStorage.getItem(REPORT_KEY) || 'null'); return raw && Array.isArray(raw.failed) && typeof raw.items === 'number' ? raw : null; } catch { return null; }
}
export function clearSyncReport(): void { localStorage.removeItem(REPORT_KEY); }
function uniqueEntries(items: DanceItem[]): MediaEntry[] {
  return [...new Map(items.flatMap(mediaEntries).map(entry => [entry.key, entry])).values()];
}
async function validateCache(items: DanceItem[], cached: CachedIndex, signal?: AbortSignal): Promise<void> {
  for (const entry of uniqueEntries(items)) {
    if (signal?.aborted) break;
    const hit = cached[entry.key];
    if (hit && (!isMediaReady(entry, cached) || !(await cachedFileValid(entry, hit)))) delete cached[entry.key];
  }
  saveCachedIndex(cached);
}
/** Offline status uses actual native files; never reports browser metadata as downloaded music. */
export async function inspectOfflineLibrary(): Promise<{ items: number; readyItems: number }> {
  const manifest = readOfflineManifest();
  const items = manifest ? playableCatalog(manifest) : [];
  if (syncing) throw new Error('下载尚未结束');
  if (!isOfflineSupported()) return { items: items.length, readyItems: 0 };
  const cached = readCachedIndex();
  await validateCache(items, cached);
  return { items: items.length, readyItems: items.filter(item => isItemPlayable(item, cached)).length };
}

/** Retry rechecks current manifest and downloads only missing/invalid files. Stop after the current file. */
export async function syncLibrary(onProgress?: (progress: SyncProgress) => void, options: { signal?: AbortSignal } = {}): Promise<SyncResult> {
  if (syncing) throw new Error('已有下载进行中，请稍后重试');
  syncing = true;
  try {
    onProgress?.({ stage: 'manifest', processed: 0, total: 0, downloaded: 0, failed: 0, pendingBytes: 0 });
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : undefined;
    const manifest = await api<OfflineManifest>('/api/sync/manifest', { signal });
    const supported = isOfflineSupported();
    const cached = readCachedIndex();
    saveOfflineManifest(manifest);
    localStorage.setItem('dance.catalog-snapshot', JSON.stringify(manifest.items));
    localStorage.setItem('dance.repertoire-snapshot', JSON.stringify(manifest.repertoire || []));
    const items = playableCatalog(manifest);
    onProgress?.({ stage: 'check', processed: 0, total: items.length, downloaded: 0, failed: 0, pendingBytes: 0 });
    if (supported) await validateCache(items, cached);
    const pending = uniqueEntries(items).filter(entry => !isMediaReady(entry, cached));
    const titles = new Map(items.flatMap(item => mediaEntries(item).map(entry => [entry.key, item.title] as const)));
    const pendingBytes = pending.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    let downloaded = 0, processed = 0;
    const failed: SyncFailure[] = [];
    const progress = (currentTitle?: string) => onProgress?.({ stage: 'download', processed, total: pending.length, downloaded, failed: failed.length, pendingBytes, currentTitle });
    progress();
    if (supported) for (const entry of pending) {
      if (options.signal?.aborted) break;
      progress(titles.get(entry.key));
      try { cached[entry.key] = await downloadMedia(entry); downloaded += 1; saveCachedIndex(cached); }
      catch { failed.push({ key: entry.key, title: titles.get(entry.key) || '未命名舞蹈', kind: entry.kind }); }
      processed += 1;
      progress();
    }
    const syncedAt = new Date().toISOString();
    const readyItems = supported ? items.filter(item => isItemPlayable(item, cached)).length : 0;
    const result: SyncResult = { catalogVersion: manifest.catalogVersion, items: items.length, downloaded, skipped: pending.length - downloaded, mediaSupported: supported, syncedAt, readyItems, failed, cancelled: !!options.signal?.aborted, complete: supported && processed === pending.length && failed.length === 0 };
    localStorage.setItem(REPORT_KEY, JSON.stringify(result));
    saveDeviceSettings({ ...readDeviceSettings(), lastSyncAt: syncedAt });
    window.dispatchEvent(new Event('dance-catalog-changed'));
    return result;
  } finally { syncing = false; }
}

export interface PrepareResult { downloaded: number; total: number; ready: boolean; }

/** 准备离线演出（T076/T078）：校验本地文件真实存在，缺失则重下；全部通过才 Ready。 */
export async function prepareOffline(items: DanceItem[], onProgress?: (done: number, total: number) => void): Promise<PrepareResult> {
  if (syncing) throw new Error('已有下载进行中，请稍后重试');
  syncing = true;
  try {
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
  } finally { syncing = false; }
}
