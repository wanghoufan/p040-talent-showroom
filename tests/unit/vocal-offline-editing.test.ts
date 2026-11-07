import { beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { flushOperations, editLocally, bulkLocally, type LocalOperation } from '../../src/lib/offline-editing';
import { initializeLocalDatabase, localOperations, readMetadata, writeMetadata } from '../../src/lib/local-database';

const id = '00000000-0000-4000-8000-0000000000a1';
const practice = { skipRap: false, wholeTrackLoop: false, backwardSeconds: 5, forwardSeconds: 10, rapRange: null, playbackRate: 1 };

beforeEach(async () => {
  await flushOperations();
  localStorage.clear();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('fetch', vi.fn(async () => { throw Error('offline'); }));
  await initializeLocalDatabase();
});

it('离线改歌词/练习设置：单条 update 带 baseRevision，练习设置增量合并后交给服务器', async () => {
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([{ id, kind: 'VOCAL', title: '夜航', revision: 4, practice }]));
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    bodies.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({ status: 'applied', revision: 5, item: { id, kind: 'VOCAL', title: '夜航', revision: 5, lyrics: [{ id: 'l1', startMs: 0, text: '改写句' }] } }));
  }));
  await editLocally({ kind: 'VOCAL', id }, { lyrics: [{ id: 'l1', startMs: 0, text: '改写句' }], practice: { skipRap: true } });
  await flushOperations();
  expect(bodies[0]).toMatchObject({ kind: 'VOCAL', action: 'update', baseRevision: 4, fields: { lyrics: [{ id: 'l1', startMs: 0, text: '改写句' }], practice: { ...practice, skipRap: true } } });
  expect(await localOperations()).toEqual([]);
  expect(JSON.parse(readMetadata('dance.repertoire-snapshot')!)[0]).toMatchObject({ revision: 5, lyrics: [{ text: '改写句' }] });
});

it('吉他和新建都不接受唱歌字段，避免同步时才 400', async () => {
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([{ id, kind: 'GUITAR', title: '吉他', revision: 1 }]));
  await expect(editLocally({ kind: 'GUITAR', id }, { language: 'zh' })).rejects.toThrow('歌词和结构只能逐首保存');
  await expect(editLocally({ kind: 'VOCAL', id: crypto.randomUUID() }, { lyrics: [{ startMs: 0, text: '句' }] }, 'create')).rejects.toThrow('歌词和结构只能逐首保存');
  expect(await localOperations()).toEqual([]);
});

it('超大歌词与格式错误的练习设置在本地就被拒绝，不进入队列', async () => {
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([{ id, kind: 'VOCAL', title: '夜航', revision: 1, practice }]));
  const huge = Array.from({ length: 2000 }, (_, index) => ({ startMs: index * 10, text: '字'.repeat(60) }));
  await expect(editLocally({ kind: 'VOCAL', id }, { lyrics: huge })).rejects.toThrow('歌词或结构过大');
  await expect(editLocally({ kind: 'VOCAL', id }, { practice: [] })).rejects.toThrow('练习设置格式无效');
  await expect(editLocally({ kind: 'VOCAL', id }, { language: 'fr' })).rejects.toThrow('语言取值无效');
  expect(await localOperations()).toEqual([]);
});

it('音轨与媒体字段不能经离线队列改写，只能走导入关联接口', async () => {
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([{ id, kind: 'VOCAL', title: '夜航', revision: 1 }]));
  await expect(editLocally({ kind: 'VOCAL', id }, { tracks: { original: { media: { id: 'x' } } } })).rejects.toThrow('音轨与媒体只能在联网时导入');
  await expect(editLocally({ kind: 'VOCAL', id }, { audio: { id: 'x' } })).rejects.toThrow('音轨与媒体只能在联网时导入');
  expect(await localOperations()).toEqual([]);
});

it('整批通道拒绝唱歌元数据，逐句改动不会被批处理静默覆盖', async () => {
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([{ id, kind: 'VOCAL', title: '夜航', revision: 1 }]));
  await expect(bulkLocally('update', [{ kind: 'VOCAL', id }], { lyrics: [{ startMs: 0, text: '句' }] })).rejects.toThrow('歌词和结构只能逐首保存');
  const [operation] = await localOperations<LocalOperation>();
  expect(operation).toBeUndefined();
});
