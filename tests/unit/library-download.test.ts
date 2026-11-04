import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncLibrary, readSyncReport, prepareOffline, planDownload } from '../../src/lib/sync';
import { readCachedIndex } from '../../src/lib/offline-manifest';
import type { DanceItem } from '../../src/lib/types';
const native = vi.hoisted(() => ({ supported: true, files: new Map<string, number>(), fail: new Set<string>(), downloads: [] as string[], afterDownload: () => {} }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native.supported, convertFileSrc: (uri: string) => uri } }));
vi.mock('@capacitor/filesystem', () => ({ Directory: { Data: 'DATA' }, Filesystem: {
 mkdir: async () => {}, deleteFile: async ({ path }: { path: string }) => { native.files.delete(path); },
 stat: async ({ path }: { path: string }) => { if (!native.files.has(path)) throw Error('missing'); return { size: native.files.get(path) }; },
 downloadFile: async ({ url, path }: { url: string; path: string }) => { native.downloads.push(url); if (native.fail.has(url)) throw Error('network'); native.files.set(path, 10); native.afterDownload(); return { path: 'file:///' + path }; },
 rename: async ({ from, to }: { from: string; to: string }) => { native.files.set(to, native.files.get(from)!); native.files.delete(from); },
} }));
const items: DanceItem[] = [1, 2, 3].map(i => ({ id: String(i), title: `舞蹈${i}`, artist: '', learningStatus: 'CAN_DANCE', sceneTags: [], performanceClipId: String(i), durationMs: 1000, audio: { id: String(i), url: `/api/media/audio/${i}`, sha256: `hash${i}`, sizeBytes: 10, version: 1 } }));
beforeEach(() => { localStorage.clear(); native.supported = true; native.files.clear(); native.fail.clear(); native.downloads = []; native.afterDownload = () => {}; vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ catalogVersion: 1, items, playlist: [] })))); });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
describe('全部音乐下载', () => {
 it('失败也推进进度，明确部分完成；重试只下载未完成文件并保留已缓存文件', async () => {
  native.fail.add(location.origin + '/api/media/audio/2');
  const progress: number[] = [];
  const result = await syncLibrary(p => { if (p.stage === 'download' && !p.currentTitle) progress.push(p.processed); });
  expect(result.readyItems).toBe(2); expect(result.failed).toHaveLength(1); expect(result.complete).toBe(false);
  expect(progress).toEqual([0, 1, 2, 3]); expect(readSyncReport()?.failed[0].title).toBe('舞蹈2');
  const first = readCachedIndex()['/api/media/audio/1']; native.fail.clear(); native.downloads = [];
  const retry = await syncLibrary(); expect(retry.readyItems).toBe(3); expect(retry.complete).toBe(true);
  expect(native.downloads).toEqual([location.origin + '/api/media/audio/2']); expect(readCachedIndex()['/api/media/audio/1']).toEqual(first);
 });
 it('取消在当前文件结束后停止，已完成缓存立即持久化，下一次接续剩余下载', async () => {
  const controller = new AbortController(); native.afterDownload = () => controller.abort();
  const result = await syncLibrary(undefined, { signal: controller.signal });
  expect(result.cancelled).toBe(true); expect(result.readyItems).toBe(1); expect(Object.keys(readCachedIndex())).toHaveLength(1);
  native.afterDownload = () => {}; native.downloads = []; const retry = await syncLibrary();
  expect(retry.complete).toBe(true); expect(native.downloads).toHaveLength(2);
 });
 it('索引命中但文件缺失或大小错误会重新下载，不能虚报全部可用', async () => {
  await syncLibrary(); const index = readCachedIndex(); native.files.delete(index[items[0].audio.url].path); native.files.set(index[items[1].audio.url].path, 3); native.downloads = [];
  const result = await syncLibrary(); expect(native.downloads).toHaveLength(2); expect(result.readyItems).toBe(3);
 });
 it('共享音频只下载一次，浏览器不声称音乐已落盘', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ catalogVersion: 1, items: [items[0], { ...items[1], audio: items[0].audio }], playlist: [] }))));
  const result = await syncLibrary(); expect(native.downloads).toHaveLength(1); expect(result.readyItems).toBe(2);
  native.supported = false; const browser = await syncLibrary(); expect(browser.complete).toBe(false); expect(browser.readyItems).toBe(0);
 });
 it('吉他/唱歌音频共用下载，纯文本歌词保存但不计入音乐总数', async () => {
  const scoreOnly = { id: 'score', kind: 'VOCAL', title: '文本歌词', scoreText: '第一行\n第二行' };
  const guitar = { ...items[1], kind: 'GUITAR', capo: 2, scoreText: 'C G Am' };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ catalogVersion: 2, items: [items[0]], repertoire: [guitar, scoreOnly], playlist: [] }))));
  const result = await syncLibrary(); expect(result.items).toBe(2); expect(result.readyItems).toBe(2); expect(native.downloads).toHaveLength(2);
  expect(JSON.parse(localStorage.getItem('dance.repertoire-snapshot')!)[1].scoreText).toBe('第一行\n第二行');
 });

 it('onlyIds 只下载指定曲目，其它曲目不动，已缓存的不重下', async () => {
  const result = await syncLibrary(undefined, { onlyIds: ['2'] });
  expect(native.downloads).toEqual([location.origin + '/api/media/audio/2']);
  expect(Object.keys(readCachedIndex())).toEqual(['/api/media/audio/2']);
  expect(result.items).toBe(1); expect(result.readyItems).toBe(1); expect(result.complete).toBe(true);
  // 再下一次同一首：全部命中，0 次网络请求。
  native.downloads = [];
  const again = await syncLibrary(undefined, { onlyIds: ['2'] });
  expect(native.downloads).toEqual([]); expect(again.readyItems).toBe(1); expect(again.complete).toBe(true);
  // 未指定的曲目仍保持未缓存，随后下载全部时才补齐。
  expect(readCachedIndex()['/api/media/audio/1']).toBeUndefined();
  await syncLibrary(); expect(native.downloads).toHaveLength(2);
 });
 it('onlyIds 不打扰其它曲目已有缓存', async () => {
  await syncLibrary();
  const first = readCachedIndex()['/api/media/audio/1'];
  native.files.delete(readCachedIndex()['/api/media/audio/2'].path); native.downloads = [];
  const result = await syncLibrary(undefined, { onlyIds: ['2'] });
  expect(native.downloads).toEqual([location.origin + '/api/media/audio/2']);
  expect(readCachedIndex()['/api/media/audio/1']).toEqual(first);
  expect(result.items).toBe(1); expect(result.readyItems).toBe(1);
 });
 it('onlyIds 仍尊重 includeScores=false，不下载谱件但仍下音频与封面', async () => {
  const withScore: DanceItem = { ...items[0], cover: { ...items[0].audio, id: 'c1', url: '/api/media/cover/1' }, scores: [{ ...items[0].audio, id: 's1', url: '/api/media/score/1', kind: 'IMAGE', mime: 'image/png', pages: 1 }] };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ catalogVersion: 1, items: [withScore], playlist: [] }))));
  const result = await syncLibrary(undefined, { onlyIds: ['1'], includeScores: false });
  expect(native.downloads).toEqual([location.origin + '/api/media/audio/1', location.origin + '/api/media/cover/1']);
  expect(result.complete).toBe(true);
 });
 it('planDownload 先算体积，只统计未缓存文件', async () => {
  await syncLibrary(undefined, { onlyIds: ['1'] });
  const plan = planDownload(['1', '3']);
  expect(plan.items).toBe(2); expect(plan.pending).toBe(1); expect(plan.bytes).toBe(10); expect(plan.ready).toBe(false);
  expect(planDownload(['1']).ready).toBe(true);
  expect(planDownload(['3']).bytes).toBe(10);
 });
 it('全部下载进行中不能启动歌单下载覆盖缓存索引，完成后锁释放', async () => {
  let release!: () => void;
  vi.stubGlobal('fetch', vi.fn(async () => { await new Promise<void>(r => { release = r; }); return new Response(JSON.stringify({ catalogVersion: 1, items, playlist: [] })); }));
  const download = syncLibrary();
  await expect(prepareOffline(items)).rejects.toThrow('已有下载进行中');
  release(); await download;
  expect((await prepareOffline(items)).ready).toBe(true);
 });

});
