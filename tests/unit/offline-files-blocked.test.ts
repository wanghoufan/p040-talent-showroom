import { beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { initializeLocalDatabase, localFiles, localOperations, saveLocalFile, writeMetadata } from '../../src/lib/local-database';
import { flushLocalFiles, retryPendingFiles } from '../../src/lib/offline-files';
import { editLocally, flushOperations } from '../../src/lib/offline-editing';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const pending = (extra: Record<string, unknown>) => ({ mime: 'audio/mpeg', state: 'pending', ...extra }) as never;

beforeEach(async () => {
  await flushLocalFiles();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.stubGlobal('indexedDB', new IDBFactory());
  await initializeLocalDatabase();
});

function router(handlers: { importsFile?: () => Response; job?: () => Response; sync?: () => Response; media?: (body: Record<string, unknown>) => Response }, calls: string[]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/api/imports/file')) return handlers.importsFile?.() ?? json({ id: 'job-1' }, 202);
    if (url.includes('/api/imports/job-1')) return handlers.job?.() ?? json({ status: 'READY', duplicateRefs: [] });
    if (url.endsWith('/api/sync/operations')) return handlers.sync?.() ?? json({ status: 'applied', revision: 2 });
    if (url.includes('/media')) return handlers.media?.(JSON.parse(String(init?.body || '{}'))) ?? json({ id: 'x' });
    throw new Error(`unexpected ${url}`);
  }));
}

it('新曲创建失败时音频不绑定，任务转为明确阻断而不是永久静默等待', async () => {
  const calls: string[] = [];
  router({ sync: () => json({ error: { code: 'BAD_REQUEST', message: '歌名不能为空' } }, 400) }, calls);
  const songId = crypto.randomUUID();
  await saveLocalFile(pending({
    id: 'new-song-track', blob: new Blob(['a']), name: '原唱.mp3', kind: 'VOCAL', itemId: songId,
    title: '新歌', createFields: { title: '新歌', learningStatus: 'WANT_TO_LEARN' }, track: 'original',
  }));

  await flushLocalFiles();

  const [entry] = await localFiles<{ state: string; error?: string }>();
  expect(entry.state).toBe('blocked');
  expect(entry.error).toMatch(/创建失败|同步/);
  // 关键：曲目没建好就绝不去绑定音轨。
  expect(calls.some((url) => url.includes(`/api/repertoire/${songId}/media`))).toBe(false);
});

it('同曲歌词冲突不再把音频队列永久堵死，给出可操作提示', async () => {
  const id = crypto.randomUUID();
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([{ id, kind: 'VOCAL', title: '冲突歌', revision: 1 }]));
  const calls: string[] = [];
  router({ sync: () => json({ status: 'conflict', revision: 2, server: { id, kind: 'VOCAL', title: '冲突歌', revision: 2 } }) }, calls);
  await editLocally({ kind: 'VOCAL', id }, { lyrics: [{ startMs: 0, text: '手机句' }] });
  await flushLocalFiles();
  expect(calls.some((url) => url.endsWith('/api/sync/operations'))).toBe(true);

  calls.length = 0;
  await saveLocalFile(pending({ id: 'conflict-track', blob: new Blob(['b']), name: '伴奏.mp3', kind: 'VOCAL', itemId: id, title: '冲突歌', track: 'accompaniment' }));
  await flushLocalFiles();

  const entries = await localFiles<{ id: string; state: string; error?: string }>();
  const entry = entries.find((item) => item.id === 'conflict-track')!;
  expect(entry.state).toBe('blocked');
  expect(entry.error).toMatch(/同步与待办/);
  expect(calls.some((url) => url.includes('/api/imports/file'))).toBe(false);
});

it('同曲修改还在排队时先等待，不提前上传也不误报失败', async () => {
  const id = crypto.randomUUID();
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([{ id, kind: 'VOCAL', title: '排队歌', revision: 1 }]));
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { calls.push(String(input)); throw new TypeError('offline'); }));
  await editLocally({ kind: 'VOCAL', id }, { lyrics: [{ startMs: 0, text: '离线句' }] });
  await flushLocalFiles();

  calls.length = 0;
  await saveLocalFile(pending({ id: 'queued-track', blob: new Blob(['c']), name: '原唱.mp3', kind: 'VOCAL', itemId: id, title: '排队歌', track: 'original' }));
  await flushLocalFiles();

  const [entry] = await localFiles<{ state: string }>();
  expect(entry.state).toBe('pending');
  // 只会重试那条修改；音频上传必须等它成功后再开始。
  expect(calls.some((url) => url.includes('/api/imports'))).toBe(false);
});

it('用户明确替换时才把 replace 标记发给服务端', async () => {
  const id = crypto.randomUUID();
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([{ id, kind: 'VOCAL', title: '替换歌', revision: 2 }]));
  const calls: string[] = [];
  let body: Record<string, unknown> = {};
  router({
    media: (value) => { body = value; return json({ id, kind: 'VOCAL', title: '替换歌', revision: 3, tracks: { original: { media: { id: 'clip-new' } } } }); },
  }, calls);
  await saveLocalFile(pending({
    id: 'replace-track', blob: new Blob(['d']), name: '新原唱.mp3', kind: 'VOCAL', itemId: id, title: '替换歌', track: 'original', replace: true,
  }));

  await flushLocalFiles();

  expect(body).toMatchObject({ importJobId: 'job-1', track: 'original', replace: true });
  expect(await localFiles()).toEqual([]);
});

it('用户改正歌词后，被阻断的音频能继续上传', async () => {
  const id = crypto.randomUUID();
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([{ id, kind: 'VOCAL', title: '纠错歌', revision: 1 }]));
  const calls: string[] = [];
  let rejecting = true;
  router({
    sync: () => (rejecting
      ? json({ error: { code: 'BAD_REQUEST', message: '歌词格式无效' } }, 400)
      : json({ status: 'applied', revision: 2, item: { id, kind: 'VOCAL', title: '纠错歌', revision: 2 } })),
    media: () => json({ id, kind: 'VOCAL', title: '纠错歌', revision: 3 }),
  }, calls);

  await editLocally({ kind: 'VOCAL', id }, { lyrics: [{ startMs: 0, text: '错句' }] });
  await flushOperations();
  await saveLocalFile(pending({ id: 'fix-track', blob: new Blob(['e']), name: '伴奏.mp3', kind: 'VOCAL', itemId: id, title: '纠错歌', track: 'accompaniment' }));
  await flushLocalFiles();
  expect((await localFiles<{ state: string }>())[0].state).toBe('blocked');

  // 用户修改歌词再保存：失败的那条被取代，同步恢复。
  rejecting = false;
  await editLocally({ kind: 'VOCAL', id }, { lyrics: [{ startMs: 0, text: '修正句' }] });
  await flushOperations();
  expect(await localOperations()).toEqual([]);

  await retryPendingFiles('fix-track');
  expect(calls.some((url) => url.includes(`/api/repertoire/${id}/media`))).toBe(true);
  expect(await localFiles()).toEqual([]);
});
