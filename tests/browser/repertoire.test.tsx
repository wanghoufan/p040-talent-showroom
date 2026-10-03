import {flushOperations} from '../../src/lib/offline-editing';
import {IDBFactory} from 'fake-indexeddb';
import {initializeLocalDatabase,localOperations,writeMetadata} from '../../src/lib/local-database';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import TalentDetailPage from '../../src/pages/TalentDetailPage';
import TalentLibraryPage from '../../src/pages/TalentLibraryPage';
import type { TalentItem } from '../../src/lib/types';
const guitar: TalentItem = { id: '00000000-0000-4000-8000-000000000001', kind: 'GUITAR', title: '吉他曲', artist: '自己', learningStatus: 'WANT_TO_LEARN', capo: 2, originalKey: 'C', performanceKey: 'D', scoreText: '[C]第一行\n[G]第二行', notes: '记得换和弦', audioRole: 'REFERENCE', durationMs: 0 };
function app(path: string) { return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/repertoire/:kind/new" element={<TalentDetailPage />} /><Route path="/repertoire/item/:id" element={<TalentDetailPage />} /><Route path="/repertoire/:kind" element={<TalentLibraryPage />} /></Routes></MemoryRouter>); }
beforeEach(async () => { localStorage.clear();vi.stubGlobal('indexedDB',new IDBFactory());await initializeLocalDatabase(); }); afterEach(async () => {await flushOperations();vi.unstubAllGlobals();});
it('吉他创建保存Capo和文本谱后进入详情，纯文本不会出现播放按钮', async () => {
 let items: TalentItem[] = []; let body: unknown;
 vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => {
  if (init?.method === 'POST') { body = JSON.parse(init.body as string); const op=body as {id:string};items=[{...guitar,id:op.id}];return new Response(JSON.stringify({status:'applied',revision:2,item:items[0]})); }
  return new Response(JSON.stringify({ items }));
 }));
 await act(async () => { app('/repertoire/guitar/new'); });
 fireEvent.change(screen.getByLabelText('歌名'), { target: { value: '吉他曲' } });
 fireEvent.change(screen.getByLabelText('Capo（变调夹品位）'), { target: { value: '2' } });
 fireEvent.change(screen.getByLabelText('和弦 / 歌词文本谱'), { target: { value: '[C]第一行\n[G]第二行' } });
 fireEvent.click(screen.getByRole('button', { name: '保存曲目' }));
 expect(await screen.findByText('吉他详情')).toBeVisible(); expect(screen.getByText('[C]第一行 [G]第二行')).toBeVisible();
 await waitFor(()=>expect(body).toBeDefined());expect(body).toMatchObject({kind:'GUITAR',action:'create',fields:{capo:2,scoreText:'[C]第一行\n[G]第二行'}});
 expect(screen.queryByRole('button', { name: '播放音乐' })).not.toBeInTheDocument();
 expect(JSON.parse(localStorage.getItem('dance.repertoire-snapshot')!)[0].kind).toBe('GUITAR');
});
it('唱歌表单展示歌词和演唱调、伴奏用途，隐藏吉他Capo', async () => {
 vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }))));
 await act(async () => { app('/repertoire/vocal/new'); });
 expect(screen.getByLabelText('歌词')).toBeVisible(); expect(screen.getByLabelText('演唱调')).toBeVisible(); expect(screen.getByLabelText('音频用途')).toHaveValue('ACCOMPANIMENT');
 expect(screen.queryByLabelText('Capo（变调夹品位）')).not.toBeInTheDocument();
});
it('断网可查看谱、保存修改并进入持久队列', async () => {
 writeMetadata('dance.repertoire-snapshot', JSON.stringify([guitar])); vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
 await act(async () => { app('/repertoire/item/' + guitar.id); });
 expect(screen.getByText('[C]第一行 [G]第二行')).toBeVisible(); fireEvent.click(screen.getByRole('button', { name: '编辑曲目' }));
 fireEvent.change(screen.getByLabelText('歌名'), { target: { value: '离线新名字' } }); fireEvent.click(screen.getByRole('button', { name: '保存曲目' }));
 await waitFor(()=>expect(screen.getByRole('heading',{name:'离线新名字'})).toBeVisible());expect((await localOperations()).length).toBe(1);
 expect(JSON.parse(localStorage.getItem('dance.repertoire-snapshot')!)[0].title).toBe('离线新名字');
});
it('才艺卡片在媒体真实播放和暂停事件后同步按钮与高亮', async () => {
 const withAudio = { ...guitar, performanceClipId: 'clip', audio: { id: 'clip', url: '/api/media/audio/clip', sha256: 'hash', sizeBytes: 10, version: 1 } };
 vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [withAudio] }))));
 const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
 try {
  await act(async () => { app('/repertoire/guitar'); });
  fireEvent.click(screen.getByRole('button', { name: '播放 吉他曲' }));
  const media = document.querySelector('audio')!; fireEvent.play(media);
  expect(screen.getByRole('button', { name: '暂停 吉他曲' })).toBeVisible();
  expect(document.querySelector('.dance-card--active')).toBeInTheDocument();
  fireEvent.pause(media); expect(screen.getByRole('button', { name: '播放 吉他曲' })).toBeVisible();
 } finally { play.mockRestore(); }
});
