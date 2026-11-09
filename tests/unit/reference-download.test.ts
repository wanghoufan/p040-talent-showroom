import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncReferences, readReferenceReport, referencePlan } from '../../src/lib/sync';
import { readCachedIndex } from '../../src/lib/offline-manifest';
import { downloadMedia, referenceSource } from '../../src/native/filesystem';
import { referenceEntries } from '../../src/lib/offline-manifest';
import type { DanceItem } from '../../src/lib/types';

const native = vi.hoisted(() => ({ supported: true, files: new Map<string, number>(), fail: new Set<string>(), failRenameTo: new Set<string>(), downloads: [] as string[], afterDownload: () => {} }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native.supported, convertFileSrc: (uri: string) => uri } }));
vi.mock('@capacitor/filesystem', () => ({ Directory: { Data: 'DATA' }, Filesystem: {
 mkdir: async () => {}, deleteFile: async ({ path }: { path: string }) => { native.files.delete(path); },
 stat: async ({ path }: { path: string }) => { if (!native.files.has(path)) throw Error('missing'); return { size: native.files.get(path) }; },
 downloadFile: async ({ url, path }: { url: string; path: string }) => { native.downloads.push(url); if (native.fail.has(url)) throw Error('network'); native.files.set(path, 10); native.afterDownload(); return { path: 'file:///' + path }; },
 rename: async ({ from, to }: { from: string; to: string }) => { if (native.failRenameTo.has(to)) { native.failRenameTo.delete(to); throw Error('rename'); } native.files.set(to, native.files.get(from)!); native.files.delete(from); },
 getUri: async ({ path }: { path: string }) => ({ uri: 'file:///DATA/' + path }),
 readdir: async () => ({ files: [] }),
} }));

const items: DanceItem[] = [1, 2].map(i => ({ id: String(i), title: `舞蹈${i}`, artist: '', learningStatus: 'CAN_DANCE', sceneTags: [], performanceClipId: String(i), durationMs: 1000,
 audio: { id: String(i), url: `/api/media/audio/${i}`, sha256: `hash${i}`, sizeBytes: 10, version: 1 },
 sourceMediaId: `s${i}`, source: { id: `s${i}`, sourceKind: 'VIDEO', durationMs: 1000, sha256: `src${i}`, url: `/api/media/reference/s${i}`, sizeBytes: 10, version: 1 } }));

beforeEach(() => { localStorage.clear(); native.supported = true; native.files.clear(); native.fail.clear(); native.failRenameTo.clear(); native.downloads = []; native.afterDownload = () => {}; vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ catalogVersion: 1, items, playlist: [] })))); });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('原视频（离线看）下载', () => {
 it('只下载原视频、不碰音乐；完成后索引含 reference 且断网可播', async () => {
  const progress: number[] = [];
  const result = await syncReferences(p => { if (p.stage === 'download' && !p.currentTitle) progress.push(p.processed); });
  expect(result.total).toBe(2); expect(result.downloaded).toBe(2); expect(result.complete).toBe(true);
  expect(native.downloads).toEqual([location.origin + '/api/media/reference/s1', location.origin + '/api/media/reference/s2']);
  expect(progress).toEqual([0, 1, 2]);
  const index = readCachedIndex();
  expect(index['/api/media/reference/s1']).toBeTruthy();
  expect(index['/api/media/audio/1']).toBeUndefined(); // 音乐未被顺手下载
 });

 it('失败计数且部分完成；重试只补缺失文件、保留已缓存', async () => {
  native.fail.add(location.origin + '/api/media/reference/s2');
  const result = await syncReferences();
  expect(result.downloaded).toBe(1); expect(result.failed).toBe(1); expect(result.complete).toBe(false);
  expect(readReferenceReport()?.failed).toBe(1);
  native.fail.clear(); native.downloads = [];
  const retry = await syncReferences(); expect(retry.complete).toBe(true);
  expect(native.downloads).toEqual([location.origin + '/api/media/reference/s2']);
 });

 it('浏览器环境不下载且不声称完成', async () => {
  native.supported = false; const result = await syncReferences();
  expect(result.mediaSupported).toBe(false); expect(result.complete).toBe(false); expect(native.downloads).toHaveLength(0);
 });

 it('referencePlan 给出总数/体积/就绪数', async () => {
  await syncReferences();
  const plan = referencePlan(); expect(plan.total).toBe(2); expect(plan.bytes).toBe(20); expect(plan.ready).toBe(2);
 });

 it('referenceSource 未缓存回落网络地址、已缓存改用本地并标记 offline', async () => {
  const before = await referenceSource('s1');
  expect(before.offline).toBe(false); expect(before.src).toContain('/api/media/reference/s1');
  await syncReferences();
  const after = await referenceSource('s1');
  expect(after.offline).toBe(true); expect(after.src).not.toContain('/api/media/reference/s1');
 });

 it('索引写入原生绝对 URI，不把下载临时路径 .tmp 留在元数据里', async () => {
  await syncReferences();
  const hit = readCachedIndex()['/api/media/reference/s1'];
  expect(hit.uri).toBe('file:///DATA/' + hit.path);
  expect(hit.uri).not.toContain('.tmp');
 });

 it('索引丢失但缓存文件仍在时按清单体积恢复，不重新下载', async () => {
  await syncReferences();
  const hit = readCachedIndex()['/api/media/reference/s1'];
  localStorage.removeItem('dance.offline.cache');
  native.downloads = [];

  const source = await referenceSource('s1');

  expect(source.offline).toBe(true);
  expect(native.downloads).toEqual([]);
  expect(readCachedIndex()['/api/media/reference/s1']).toMatchObject({ path: hit.path, sizeBytes: 10 });
 });

 it('替换旧缓存中途失败会还原旧副本，不静默删除用户已有文件', async () => {
  const entry = referenceEntries(items[0])[0];
  const first = await downloadMedia(entry);
  native.files.set(first.path, 10);
  native.failRenameTo.add(first.path);

  await expect(downloadMedia(entry)).rejects.toThrow('rename');

  expect(native.files.get(first.path)).toBe(10);
  expect(native.files.has(`${first.path}.old`)).toBe(false);
 });
});
