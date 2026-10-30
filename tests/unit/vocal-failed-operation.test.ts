import { beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { editLocally, flushOperations, type LocalOperation } from '../../src/lib/offline-editing';
import { initializeLocalDatabase, localOperations, readMetadata, writeMetadata } from '../../src/lib/local-database';

const id = '00000000-0000-4000-8000-0000000000b7';

beforeEach(async () => {
  await flushOperations();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.stubGlobal('indexedDB', new IDBFactory());
  await initializeLocalDatabase();
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([{ id, kind: 'VOCAL', title: '夜航', revision: 2 }]));
});

it('被服务器拒绝的歌词修改会被用户后一次保存取代，不会永久堵住这首歌的同步', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: '歌词格式无效' } }), { status: 400, headers: { 'Content-Type': 'application/json' } })));
  await editLocally({ kind: 'VOCAL', id }, { lyrics: [{ startMs: 0, text: '旧句' }] });
  await flushOperations();
  const failed = await localOperations<LocalOperation>();
  expect(failed).toHaveLength(1);
  expect(failed[0].state).toBe('failed');

  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: 'applied', revision: 3, item: { id, kind: 'VOCAL', title: '夜航', revision: 3, lyrics: [{ id: 'line-1', startMs: 0, text: '修正句' }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  await editLocally({ kind: 'VOCAL', id }, { lyrics: [{ startMs: 0, text: '修正句' }] });
  await flushOperations();

  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({ action: 'update', baseRevision: 2, fields: { lyrics: [{ startMs: 0, text: '修正句' }] } });
  expect(await localOperations()).toEqual([]);
  expect(JSON.parse(readMetadata('dance.repertoire-snapshot')!).find((item: { id: string }) => item.id === id)).toMatchObject({ revision: 3 });
});

it('冲突不会被后一次编辑悄悄吞掉，仍需用户当面选择', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'conflict', revision: 5, server: { id, kind: 'VOCAL', title: '夜航', revision: 5 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  await editLocally({ kind: 'VOCAL', id }, { lyrics: [{ startMs: 0, text: '手机句' }] });
  await flushOperations();
  expect((await localOperations<LocalOperation>())[0].state).toBe('conflict');

  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: 'applied', revision: 6 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  await editLocally({ kind: 'VOCAL', id }, { lyrics: [{ startMs: 0, text: '再改句' }] });
  await flushOperations();

  expect(bodies).toEqual([]);
  const ops = await localOperations<LocalOperation>();
  expect(ops.map((op) => op.state)).toEqual(['conflict', undefined]);
});
