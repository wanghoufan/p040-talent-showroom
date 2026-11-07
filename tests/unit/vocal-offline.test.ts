import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isItemPlayable, isPerformanceReady, mediaEntries, vocalTrackReadiness, readOfflineManifest,
  type CachedIndex, type MediaEntry,
} from '../../src/lib/offline-manifest';
import { prepareOffline, syncLibrary } from '../../src/lib/sync';
import type { MediaFile, TalentItem } from '../../src/lib/types';

const native = vi.hoisted(() => ({ native: true, files: new Map<string, number>(), downloads: [] as string[] }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native.native, convertFileSrc: (uri: string) => uri } }));
vi.mock('@capacitor/filesystem', () => ({ Directory: { Data: 'DATA' }, Filesystem: {
  mkdir: async () => {},
  deleteFile: async ({ path }: { path: string }) => { native.files.delete(path); },
  stat: async ({ path }: { path: string }) => { if (!native.files.has(path)) throw Error('missing'); return { size: native.files.get(path) }; },
  downloadFile: async ({ url, path }: { url: string; path: string }) => { native.downloads.push(url); native.files.set(path, 10); return { path: 'file:///' + path }; },
  rename: async ({ from, to }: { from: string; to: string }) => { native.files.set(to, native.files.get(from)!); native.files.delete(from); },
} }));

const media = (id: string, extra: Partial<MediaFile> = {}): MediaFile => ({ id, url: `/api/media/audio/${id}`, sha256: `h-${id}`, sizeBytes: 10, version: 1, ...extra });

function vocalItem(extra: Partial<TalentItem> = {}): TalentItem {
  return {
    id: 'v1', kind: 'VOCAL', title: '夜航', artist: '自己', learningStatus: 'WANT_TO_LEARN',
    originalKey: '', performanceKey: '', capo: 0, scoreText: '', notes: '', audioRole: 'ACCOMPANIMENT',
    durationMs: 180000,
    tracks: { original: { media: media('o') }, accompaniment: { media: media('a') } },
    audio: media('a'), language: 'zh',
    lyrics: [{ id: 'l1', startMs: 0, text: '第一句' }],
    sections: [{ id: 's1', type: 'verse', label: 'A1', startMs: 0, endMs: 8000, source: 'manual' }],
    practice: { skipRap: true, wholeTrackLoop: false, backwardSeconds: 10, forwardSeconds: 15, rapRange: null, playbackRate: 0.8 },
    ...extra,
  };
}

const cachedFrom = (entries: MediaEntry[], present: string[]): CachedIndex =>
  Object.fromEntries(entries.filter(entry => present.includes(entry.url)).map(entry => [entry.key, { ...entry, path: `p/${entry.key}`, uri: `file:///${entry.key}` }]));

beforeEach(() => { localStorage.clear(); native.native = true; native.files.clear(); native.downloads = []; });

describe('离线双轨清单', () => {
  it('VOCAL 收集原唱与伴奏，同一 URL 只缓存一次，旧 audio 不重复计入', () => {
    const entries = mediaEntries(vocalItem());
    expect(entries.filter(entry => entry.kind === 'audio').map(entry => entry.url)).toEqual(['/api/media/audio/a', '/api/media/audio/o']);
    const legacyOnly = mediaEntries(vocalItem({ tracks: undefined }));
    expect(legacyOnly.filter(entry => entry.kind === 'audio').map(entry => entry.url)).toEqual(['/api/media/audio/a']);
    const sameFile = mediaEntries(vocalItem({ tracks: { original: { media: media('x') }, accompaniment: { media: media('x') } }, audio: media('x') }));
    expect(sameFile.filter(entry => entry.kind === 'audio')).toHaveLength(1);
  });

  it('按角色给就绪态：缺的轨是 null，没缓存是 false，绝不互相顶替', () => {
    const item = vocalItem();
    const entries = mediaEntries(item);
    expect(vocalTrackReadiness(item, cachedFrom(entries, ['/api/media/audio/a']))).toEqual({ original: false, accompaniment: true });
    const originalOnly = vocalItem({ tracks: { original: { media: media('o') } }, audio: media('o'), audioRole: 'REFERENCE' });
    expect(vocalTrackReadiness(originalOnly, cachedFrom(mediaEntries(originalOnly), ['/api/media/audio/o']))).toEqual({ original: true, accompaniment: null });
  });

  it('演出就绪只认伴奏；只有原唱时明确未准备好，纯文本曲目仍算就绪', () => {
    const item = vocalItem();
    const entries = mediaEntries(item);
    const originalCached = cachedFrom(entries, ['/api/media/audio/o']);
    expect(isPerformanceReady(item, originalCached)).toBe(false);
    expect(isPerformanceReady(item, cachedFrom(entries, ['/api/media/audio/a']))).toBe(true);
    // 旧播放器口径只看 audio，保持既有页面行为不变。
    expect(isItemPlayable({ ...item, tracks: undefined }, originalCached)).toBe(false);
    expect(isItemPlayable({ ...item, tracks: undefined }, cachedFrom(entries, ['/api/media/audio/a']))).toBe(true);
    expect(isPerformanceReady(vocalItem({ tracks: undefined, audio: undefined }), {})).toBe(true);
    // 旧单音轨且明确是伴奏，可以直接演出。
    expect(isPerformanceReady(vocalItem({ tracks: undefined }), cachedFrom(entries, ['/api/media/audio/a']))).toBe(true);
  });

  it('准备离线演出报告缺轨原因：没有伴奏说 absent，有文件但没下载说 not-cached', async () => {
    const originalOnly = vocalItem({ tracks: { original: { media: media('o') } }, audio: media('o'), audioRole: 'REFERENCE' });
    const first = await prepareOffline([originalOnly]);
    expect(first.ready).toBe(false);
    expect(first.missingTracks).toEqual([{ id: 'v1', title: '夜航', role: 'accompaniment', cause: 'absent' }]);

    const both = await prepareOffline([vocalItem()]);
    expect(both.ready).toBe(true);
    expect(both.missingTracks).toEqual([]);
    expect(native.downloads).toContain(location.origin + '/api/media/audio/o');
    expect(native.downloads).toContain(location.origin + '/api/media/audio/a');
  });

  it('索引说已缓存但文件已被删：重新下载，就绪必须依据真实文件', async () => {
    const item = vocalItem();
    const entries = mediaEntries(item);
    localStorage.setItem('dance.offline.cache', JSON.stringify(cachedFrom(entries, entries.map(entry => entry.url))));
    // 只保留伴奏文件，原唱文件在磁盘上已被删除。
    native.files.set(`p/${entries.find(entry => entry.url.endsWith('/a'))!.key}`, 10);
    native.downloads = [];
    const result = await prepareOffline([item]);
    expect(result.ready).toBe(true);
    expect(native.downloads).toContain(location.origin + '/api/media/audio/o');
  });

  it('非原生环境不谎报就绪，也不把浏览器索引当成已下载文件作废', async () => {
    native.native = false;
    const item = vocalItem();
    const entries = mediaEntries(item);
    const cached = cachedFrom(entries, entries.map(entry => entry.url));
    localStorage.setItem('dance.offline.cache', JSON.stringify(cached));
    const result = await prepareOffline([item]);
    expect(result.ready).toBe(false);
    expect(result.mediaSupported).toBe(false);
    expect(result.downloaded).toBe(0);
    expect(result.missingTracks).toEqual([]);
    // 浏览器端无法校验真实文件，索引原样保留，不能因「读不到文件」就把索引清空。
    expect(Object.keys(JSON.parse(localStorage.getItem('dance.offline.cache')!))).toHaveLength(entries.length);
  });

  it('同源原唱与伴奏不算可演出双轨，缺的是真伴奏而不是文件', async () => {
    const same = media('x');
    const item = vocalItem({ tracks: { original: { media: same }, accompaniment: { media: same } }, audio: same });
    const entries = mediaEntries(item);
    expect(entries.filter(entry => entry.kind === 'audio')).toHaveLength(1);
    expect(isPerformanceReady(item, cachedFrom(entries, ['/api/media/audio/x']))).toBe(false);
    const result = await prepareOffline([item]);
    expect(result.ready).toBe(false);
    expect(result.missingTracks).toEqual([{ id: 'v1', title: '夜航', role: 'accompaniment', cause: 'duplicate' }]);
  });
});

describe('离线元数据持久化', () => {
  it('同步清单把语言/逐句歌词/结构/练习设置一起保存，断网冷启动仍可读', async () => {
    const item = vocalItem();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ catalogVersion: 3, items: [], repertoire: [item], playlist: [] }))));
    const result = await syncLibrary();
    expect(result.items).toBe(1);
    const saved = JSON.parse(localStorage.getItem('dance.repertoire-snapshot')!)[0] as TalentItem;
    expect(saved).toMatchObject({ language: 'zh', lyrics: item.lyrics, sections: item.sections, practice: item.practice, tracks: item.tracks });
    const manifest = readOfflineManifest()!;
    expect(manifest.repertoire?.[0].lyrics?.[0].text).toBe('第一句');
    expect(manifest.repertoire?.[0].practice?.skipRap).toBe(true);
    vi.unstubAllGlobals();
  });
});
