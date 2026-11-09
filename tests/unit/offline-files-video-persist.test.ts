import { beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

const native = vi.hoisted(() => ({
  files: new Map<string, { bytes: Uint8Array; text?: string }>(),
}));

const api = vi.hoisted(() => ({ request: vi.fn(), upload: vi.fn() }));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, convertFileSrc: (uri: string) => uri },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    mkdir: async () => {},
    writeFile: async ({ path, data, encoding }: { path: string; data: string; encoding?: string }) => {
      const text = encoding === 'utf8' ? String(data) : undefined;
      native.files.set(path, { bytes: text !== undefined ? new TextEncoder().encode(text) : Uint8Array.from(atob(String(data)), (c) => c.charCodeAt(0)), text });
    },
    appendFile: async ({ path, data }: { path: string; data: string }) => {
      const current = native.files.get(path);
      if (!current) throw Error('missing');
      const extra = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bytes = new Uint8Array(current.bytes.length + extra.length);
      bytes.set(current.bytes);
      bytes.set(extra, current.bytes.length);
      native.files.set(path, { ...current, bytes });
    },
    stat: async ({ path }: { path: string }) => {
      const file = native.files.get(path);
      if (!file) throw Error('missing');
      return { size: file.bytes.length };
    },
    readFile: async ({ path, encoding, offset, length }: { path: string; encoding?: string; offset?: number; length?: number }) => {
      const file = native.files.get(path);
      if (!file) throw Error('missing');
      if (encoding === 'utf8') return { data: file.text ?? '' };
      const start = offset ?? 0;
      const end = length === undefined ? file.bytes.length : start + length;
      const slice = file.bytes.subarray(start, end);
      let text = '';
      for (let i = 0; i < slice.length; i += 8192) text += String.fromCharCode(...slice.subarray(i, i + 8192));
      return { data: btoa(text) };
    },
    readdir: async ({ path }: { path: string }) => ({
      files: [...native.files.keys()]
        .filter((name) => name.startsWith(`${path}/`))
        .map((name) => ({ name: name.slice(path.length + 1), size: native.files.get(name)!.bytes.length })),
    }),
    getUri: async ({ path }: { path: string }) => ({ uri: 'file:///DATA/' + path }),
    rename: async ({ from, to }: { from: string; to: string }) => {
      const file = native.files.get(from);
      if (!file) throw Error('missing');
      native.files.delete(from);
      native.files.set(to, file);
    },
    deleteFile: async ({ path }: { path: string }) => { native.files.delete(path); },
  },
}));

vi.mock('../../src/lib/api', () => ({
  api: api.request,
  apiWithTimeout: api.upload,
  jsonBody: (value: unknown) => value,
  mediaUrl: (path: string) => path,
  ApiError: class ApiError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status; } },
}));

import { initializeLocalDatabase, localFiles } from '../../src/lib/local-database';
import { queueFile, flushLocalFiles, discardPendingFile, type PendingFile } from '../../src/lib/offline-files';
import { findStoredVideo, findStoredVideoBySource, listStagedVideos } from '../../src/lib/video-store';

beforeEach(async () => {
  native.files.clear();
  localStorage.clear();
  api.request.mockReset();
  api.upload.mockReset();
  vi.stubGlobal('indexedDB', new IDBFactory());
  await initializeLocalDatabase();
  api.request.mockImplementation(async (path: string) => {
    if (path === '/api/imports/job-1') return { id: 'job-1', status: 'READY', stage: 'REVIEW' };
    if (path.endsWith('/finalize')) return { id: 'dance-1', sourceMediaId: 'source-1' };
    throw Error(`unexpected ${path}`);
  });
  api.upload.mockResolvedValue({ id: 'job-1', status: 'READY', stage: 'REVIEW' });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).replace('file:///DATA/', '');
    const file = native.files.get(path);
    if (!file) throw Error('missing');
    return new Response(file.bytes);
  }));
});

it('批量舞蹈视频先落持久副本，上传终审后按 sourceMediaId 关联且不删副本', async () => {
  const file = new File([new Uint8Array(2048)], '批量舞蹈.mp4', { type: 'video/mp4' });
  const entry = await queueFile(file, { kind: 'DANCE', id: 'dance-1' }, 'MEDIA', { id: 'entry-1', title: '批量舞蹈' });

  expect(entry.videoId).toBeTruthy();
  expect(entry.path).toBeUndefined();
  expect([...native.files.keys()].some((name) => name.startsWith('dance-pending/'))).toBe(false);
  const media = [...native.files.keys()].find((name) => name.startsWith('dance-videos/') && name.endsWith('.mp4'))!;
  expect(media).toBeTruthy();

  await flushLocalFiles();

  expect(api.upload).toHaveBeenCalledTimes(1);
  const [path, init] = api.upload.mock.calls[0] as [string, RequestInit];
  expect(path).toBe('/api/imports/file');
  expect(((init.body as Blob).size)).toBe(2048);

  const stored = findStoredVideo(entry.videoId!);
  expect(stored).toMatchObject({ jobId: 'job-1', sourceMediaId: 'source-1', verified: true });
  expect(findStoredVideoBySource('source-1')?.id).toBe(stored?.id);
  expect(native.files.has(media)).toBe(true); // 成功后副本保留，供离线播放
  expect(native.files.has(`${media}.json`)).toBe(true);
  expect(await localFiles()).toEqual([]); // 待办已处理，但源副本没有一起消失
});

it('批量视频上传失败时保留待办与副本；移除待办不等于删除视频，持久副本保留可恢复', async () => {
  api.upload.mockRejectedValue(new Error('offline'));
  const file = new File([new Uint8Array(1024)], '离线舞蹈.mp4', { type: 'video/mp4' });
  const entry = await queueFile(file, { kind: 'DANCE', id: 'dance-1' }, 'MEDIA', { id: 'entry-2', title: '离线舞蹈' });
  const media = findStoredVideo(entry.videoId!)!.path;

  await flushLocalFiles();

  const pending = await localFiles<PendingFile>();
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ id: 'entry-2', videoId: entry.videoId });
  expect(native.files.has(media)).toBe(true);

  await discardPendingFile('entry-2');

  // 只移除待办；用户没点「删除副本」，视频不能跟着消失。
  expect(await localFiles()).toEqual([]);
  expect(native.files.has(media)).toBe(true);
  expect(native.files.has(`${media}.json`)).toBe(true);
  expect(findStoredVideo(entry.videoId!)).toMatchObject({ path: media, verified: true });
  expect(listStagedVideos().map((video) => video.id)).toContain(entry.videoId); // 仍可在「未完成收录」里恢复/继续上传
});

it('已关联任务但上传未完成的待办被移除后，持久副本与 jobId 关联仍保留可恢复', async () => {
  // 上传成功拿到 jobId，但轮询任务失败：待办停在 pending，视频已与 job 关联。
  api.request.mockImplementation(async (path: string) => {
    if (path === '/api/imports/job-1') throw new Error('offline');
    throw Error(`unexpected ${path}`);
  });
  const file = new File([new Uint8Array(1024)], '已关联舞蹈.mp4', { type: 'video/mp4' });
  const entry = await queueFile(file, { kind: 'DANCE', id: 'dance-1' }, 'MEDIA', { id: 'entry-3', title: '已关联舞蹈' });

  await flushLocalFiles();
  const pending = await localFiles<PendingFile>();
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ id: 'entry-3', jobId: 'job-1', videoId: entry.videoId });
  const media = findStoredVideo(entry.videoId!)!.path;

  await discardPendingFile('entry-3');

  expect(await localFiles()).toEqual([]);
  expect(native.files.has(media)).toBe(true);
  expect(native.files.has(`${media}.json`)).toBe(true);
  expect(findStoredVideo(entry.videoId!)).toMatchObject({ path: media, verified: true, jobId: 'job-1' });
});

it('冷启动索引丢失后，待办里已落盘的视频仍能上传（不能误判副本不存在）', async () => {
  api.upload.mockRejectedValueOnce(new Error('offline'));
  const file = new File([new Uint8Array(1536)], '冷启动舞蹈.mp4', { type: 'video/mp4' });
  const entry = await queueFile(file, { kind: 'DANCE', id: 'dance-1' }, 'MEDIA', { id: 'entry-cold', title: '冷启动舞蹈' });

  await flushLocalFiles(); // 第一次：断网，待办与副本都留下
  expect(await localFiles<PendingFile>()).toHaveLength(1);

  // 模拟重开 App 时 localStorage 索引被清理：私有目录里的视频与 sidecar 还在。
  localStorage.clear();
  api.upload.mockResolvedValue({ id: 'job-1', status: 'READY', stage: 'REVIEW' });

  await flushLocalFiles();

  expect(api.upload).toHaveBeenCalledTimes(2);
  expect(findStoredVideoBySource('source-1')?.id).toBe(entry.videoId);
  expect(await localFiles()).toEqual([]);
  expect(native.files.has(findStoredVideo(entry.videoId!)!.path)).toBe(true);
});
