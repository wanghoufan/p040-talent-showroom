import {mergeRemote} from './offline-editing';
import {storedProgram} from './program';
import {writeMetadata,localOperations} from './local-database';
import { api } from './api';
import { createTimedSignal } from './abort-signal';
import { readCachedIndex, saveCachedIndex, readOfflineManifest, saveOfflineManifest, pendingEntries, mediaEntries, referenceEntries, isMediaReady, isItemPlayable, isPerformanceReady, isVocal, type CachedIndex, type MediaEntry } from './offline-manifest';
import { resolveTracks, trackPairStatus } from './vocal';
import { downloadMedia, isOfflineSupported, cachedFileValid } from '../native/filesystem';
import { readDeviceSettings, saveDeviceSettings } from './device-settings';
import type { DanceItem, OfflineManifest, TalentItem } from './types';

export interface SyncFailure { key: string; title: string; kind: MediaEntry['kind']; }
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
const MANIFEST_TIMEOUT_MS = 15000;
let syncing = false;
/** 清单请求沿用 15 秒时限，且与调用方取消信号合并；老 WebView 没有 AbortSignal.any。 */
async function fetchManifest(signal?: AbortSignal): Promise<OfflineManifest> {
  const timed = signal ? createTimedSignal(MANIFEST_TIMEOUT_MS, signal) : null;
  try { return await api<OfflineManifest>('/api/sync/manifest', timed ? { signal: timed.signal } : undefined); }
  finally { timed?.release(); }
}
export function isLibrarySyncRunning(): boolean { return syncing; }
function playableCatalog(manifest: OfflineManifest): (DanceItem|TalentItem)[] {
  return [...manifest.items, ...(manifest.repertoire || [])];
}
/**
 * 音频层是否可离线使用：唱歌按「演出音轨」判定（只认伴奏，缺伴奏不算可演出），
 * 舞蹈/吉他沿用旧单音轨口径。封面与乐谱不参与这里，避免把封面缺失当成音乐不可播。
 */
function audioReady(item: DanceItem|TalentItem, cached: CachedIndex): boolean {
  return isVocal(item) ? isPerformanceReady(item, cached) : isItemPlayable(item, cached);
}
/** 准备离线演出更严格：除音频外，封面/乐谱也必须真实落盘。 */
function allMediaReady(item: DanceItem|TalentItem, cached: CachedIndex): boolean {
  const entries = mediaEntries(item);
  const others = entries.filter(entry => entry.kind !== 'audio').every(entry => isMediaReady(entry, cached));
  return others && audioReady(item, cached);
}
/** 是否存在任何音频（唱歌可能只有双轨而不回填旧 audio）。 */
function hasAudio(item: DanceItem|TalentItem): boolean {
  if (item.audio) return true;
  if (!isVocal(item)) return false;
  const tracks = resolveTracks(item);
  return !!(tracks.original || tracks.accompaniment);
}
export interface MissingTrack { id: string; title: string; role: 'original' | 'accompaniment'; cause: 'absent' | 'not-cached' | 'duplicate' }
/**
 * 唱歌缺轨明细：缺失的轨单独列出，供节目单明确显示「未准备好」，不用原唱冒充伴奏。
 * `absent` = 本来就没有这条轨；`not-cached` = 有文件但未下载/已丢失；`duplicate` = 与原唱同一文件，不是真伴奏。
 */
function missingVocalTracks(items: (DanceItem|TalentItem)[], cached: CachedIndex): MissingTrack[] {
  const missing: MissingTrack[] = [];
  for (const item of items) {
    if (!isVocal(item)) continue;
    const tracks = resolveTracks(item);
    if (!tracks.original && !tracks.accompaniment) continue;
    const duplicated = trackPairStatus(tracks).state === 'same-media';
    for (const role of ['original', 'accompaniment'] as const) {
      const media = tracks[role]?.media;
      if (!media) missing.push({ id: item.id, title: item.title, role, cause: 'absent' });
      else if (role === 'accompaniment' && duplicated) missing.push({ id: item.id, title: item.title, role, cause: 'duplicate' });
      else if (!isMediaReady({ key: media.url, url: media.url, sha256: media.sha256, version: media.version, sizeBytes: media.sizeBytes, kind: 'audio' }, cached)) missing.push({ id: item.id, title: item.title, role, cause: 'not-cached' });
    }
  }
  return missing;
}
export function readSyncReport(): SyncResult | null {
  try { const raw = JSON.parse(localStorage.getItem(REPORT_KEY) || 'null'); return raw && Array.isArray(raw.failed) && typeof raw.items === 'number' ? raw : null; } catch { return null; }
}
export function clearSyncReport(): void { localStorage.removeItem(REPORT_KEY); }
function uniqueEntries(items: (DanceItem|TalentItem)[]): MediaEntry[] {
  return [...new Map(items.flatMap(mediaEntries).map(entry => [entry.key, entry])).values()];
}
async function validateCache(items: (DanceItem|TalentItem)[], cached: CachedIndex, signal?: AbortSignal): Promise<void> {
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
  if (!isOfflineSupported()) return { items: items.filter(hasAudio).length, readyItems: 0 };
  const cached = readCachedIndex();
  await validateCache(items, cached);
  return { items: items.filter(hasAudio).length, readyItems: items.filter(item => hasAudio(item) && audioReady(item, cached)).length };
}

/** Retry rechecks current manifest and downloads only missing/invalid files. Stop after the current file. */
export async function syncLibrary(onProgress?: (progress: SyncProgress) => void, options: { signal?: AbortSignal; demoOnly?: boolean;includeScores?:boolean } = {}): Promise<SyncResult> {
  if (syncing) throw new Error('已有下载进行中，请稍后重试');
  syncing = true;
  try {
    onProgress?.({ stage: 'manifest', processed: 0, total: 0, downloaded: 0, failed: 0, pendingBytes: 0 });
    const manifest = await fetchManifest(options.signal);
    manifest.items=await mergeRemote('DANCE',manifest.items);manifest.repertoire=[...await mergeRemote('GUITAR',(manifest.repertoire||[]).filter(i=>i.kind==='GUITAR')),...await mergeRemote('VOCAL',(manifest.repertoire||[]).filter(i=>i.kind==='VOCAL'))];if((await localOperations<{action:string}>()).some(op=>op.action==='program'))manifest.program=storedProgram();else if(manifest.program)writeMetadata('dance.program',JSON.stringify(manifest.program));
    const supported = isOfflineSupported();
    const cached = readCachedIndex();
    // 清单先落盘：语言/逐句歌词/结构/练习设置随曲目对象一起持久化，下载中断也不会丢元数据。
    saveOfflineManifest(manifest);
    writeMetadata('dance.catalog-snapshot', JSON.stringify(manifest.items));
    writeMetadata('dance.repertoire-snapshot', JSON.stringify(manifest.repertoire || []));
    const items = playableCatalog(manifest).filter(item => !options.demoOnly || item.isDemo);
    onProgress?.({ stage: 'check', processed: 0, total: items.length, downloaded: 0, failed: 0, pendingBytes: 0 });
    if (supported) await validateCache(items, cached);
    const pending = uniqueEntries(items).filter(entry => (options.includeScores!==false||entry.kind!=='score')&&!isMediaReady(entry, cached));
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
    const readyItems = supported ? items.filter(item => hasAudio(item) && audioReady(item, cached)).length : 0;
    const result: SyncResult = { catalogVersion: manifest.catalogVersion, items: items.filter(hasAudio).length, downloaded, skipped: pending.length - downloaded, mediaSupported: supported, syncedAt, readyItems, failed, cancelled: !!options.signal?.aborted, complete: supported && processed === pending.length && failed.length === 0 };
    localStorage.setItem(REPORT_KEY, JSON.stringify(result));
    saveDeviceSettings({ ...readDeviceSettings(), lastSyncAt: syncedAt });
    window.dispatchEvent(new Event('dance-catalog-changed'));
    return result;
  } finally { syncing = false; }
}

export interface PrepareResult {
  downloaded: number; total: number; ready: boolean;
  /** 当前环境能否真正把文件落到本地；Web/调试环境为 false，此时 ready 恒为 false，不谎报就绪。 */
  mediaSupported: boolean;
  /** 唱歌缺轨明细；舞蹈/吉他一般为空。 */
  missingTracks: MissingTrack[];
}

/**
 * 准备离线演出（T076/T078）：校验本地文件真实存在，缺失则重下；全部通过才 Ready。
 * 唱歌会同时缓存原唱与伴奏，但「可演出」只要求伴奏就绪：只有原唱或原唱/伴奏同源时明确返回未准备好。
 */
export async function prepareOffline(items: (DanceItem|TalentItem)[], onProgress?: (done: number, total: number) => void): Promise<PrepareResult> {
  if (syncing) throw new Error('已有下载进行中，请稍后重试');
  syncing = true;
  try {
  const supported = isOfflineSupported();
  const cached: CachedIndex = readCachedIndex();
  // 1) 索引命中但文件已被删除/丢失的，先作废（readiness 必须反映真实文件）。
  //    非原生环境没有本地文件系统，不能据此把浏览器索引判死。
  let invalidated = false;
  if (supported) for (const item of items) for (const entry of mediaEntries(item)) {
    const hit = cached[entry.key];
    if (hit && !(await cachedFileValid(entry,hit))) { delete cached[entry.key]; invalidated = true; }
  }
  // 2) 下载缺失或失效的媒体。
  const pending = pendingEntries(items, cached);
  let downloaded = 0;
  if (supported) {
    for (const entry of pending) {
      try { cached[entry.key] = await downloadMedia(entry); downloaded += 1; } catch { /* 保持未就绪 */ }
      onProgress?.(downloaded, pending.length);
    }
  }
  // 作废结果立即落盘：否则删掉的文件在下次准备前仍会显示「已缓存」。
  if (invalidated || downloaded) saveCachedIndex(cached);
  // 3) 最终校验：每条媒体索引就绪且文件真实存在；没有文件系统时不谎报就绪。
  let ready = supported && items.length > 0;
  if (ready) for (const item of items) for (const entry of mediaEntries(item)) {
    const hit = cached[entry.key];
    if (!hit || !isMediaReady(entry, cached) || !(await cachedFileValid(entry,hit))) ready = false;
  }
  // 音频以外全部就绪还不够：唱歌必须有可播的伴奏，缺伴奏一律判未准备好。
  if (ready && items.some(item => !allMediaReady(item, cached))) ready = false;
  const missingTracks = missingVocalTracks(items, cached);
  return { downloaded, total: pending.length, ready, mediaSupported: supported, missingTracks };
  } finally { syncing = false; }
}

/** 原视频（source_media）离线缓存：独立于音乐下载，体积大须用户单独触发。 */
const REFERENCE_REPORT_KEY = 'dance.offline.reference-report';
export interface ReferenceSyncProgress { stage: 'manifest' | 'check' | 'download'; processed: number; total: number; downloaded: number; failed: number; pendingBytes: number; currentTitle?: string; }
export interface ReferenceSyncResult { total: number; downloaded: number; skipped: number; mediaSupported: boolean; syncedAt: string; failed: number; cancelled: boolean; complete: boolean; }
export function readReferenceReport(): ReferenceSyncResult | null {
  try { const raw = JSON.parse(localStorage.getItem(REFERENCE_REPORT_KEY) || 'null'); return raw && typeof raw.total === 'number' ? (raw as ReferenceSyncResult) : null; } catch { return null; }
}
export function clearReferenceReport(): void { localStorage.removeItem(REFERENCE_REPORT_KEY); }
function uniqueReferenceEntries(items: (DanceItem|TalentItem)[]): MediaEntry[] {
  return [...new Map(items.flatMap(referenceEntries).map(entry => [entry.key, entry])).values()];
}
/** 原视频缓存计划：总数 / 已就绪 / 总体积。默认读本地清单；可传入刚拉取的清单以显示最新体积。 */
export function referencePlan(manifest: OfflineManifest | null = readOfflineManifest()): { total: number; ready: number; bytes: number } {
  const entries = manifest ? uniqueReferenceEntries(playableCatalog(manifest)) : [];
  const cached = readCachedIndex();
  return { total: entries.length, ready: entries.filter(entry => isMediaReady(entry, cached)).length, bytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0) };
}
/** 下载全部原视频到手机；与音乐下载共用互斥锁与缓存索引，互不覆盖。 */
export async function syncReferences(onProgress?: (progress: ReferenceSyncProgress) => void, options: { signal?: AbortSignal } = {}): Promise<ReferenceSyncResult> {
  if (syncing) throw new Error('已有下载进行中，请稍后重试');
  syncing = true;
  try {
    onProgress?.({ stage: 'manifest', processed: 0, total: 0, downloaded: 0, failed: 0, pendingBytes: 0 });
    const manifest = await fetchManifest(options.signal);
    // 仅下过原视频、还没下过音乐时，本地无清单：补种一份，供离线显示缓存计划；不覆盖已有清单（避免冲掉音乐同步的合并结果）。
    if (!readOfflineManifest()) saveOfflineManifest(manifest);
    const all = playableCatalog(manifest);
    const entries = uniqueReferenceEntries(all);
    const titles = new Map(all.flatMap(item => referenceEntries(item).map(entry => [entry.key, item.title] as const)));
    const cached = readCachedIndex();
    const supported = isOfflineSupported();
    onProgress?.({ stage: 'check', processed: 0, total: entries.length, downloaded: 0, failed: 0, pendingBytes: 0 });
    if (supported) for (const entry of entries) {
      const hit = cached[entry.key];
      if (hit && (!isMediaReady(entry, cached) || !(await cachedFileValid(entry, hit)))) delete cached[entry.key];
    }
    const pending = entries.filter(entry => !isMediaReady(entry, cached));
    const pendingBytes = pending.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    let downloaded = 0, processed = 0, failed = 0;
    const progress = (currentTitle?: string) => onProgress?.({ stage: 'download', processed, total: pending.length, downloaded, failed, pendingBytes, currentTitle });
    progress();
    if (supported) for (const entry of pending) {
      if (options.signal?.aborted) break;
      progress(titles.get(entry.key));
      try { cached[entry.key] = await downloadMedia(entry); downloaded += 1; saveCachedIndex(cached); }
      catch { failed += 1; }
      processed += 1;
      progress();
    }
    const syncedAt = new Date().toISOString();
    const result: ReferenceSyncResult = { total: entries.length, downloaded, skipped: pending.length - downloaded, mediaSupported: supported, syncedAt, failed, cancelled: !!options.signal?.aborted, complete: supported && processed === pending.length && failed === 0 };
    localStorage.setItem(REFERENCE_REPORT_KEY, JSON.stringify(result));
    return result;
  } finally { syncing = false; }
}
