import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import LibraryPage from '../../src/pages/LibraryPage';
import type { DanceItem } from '../../src/lib/types';

const items: DanceItem[] = ['甲舞', '乙舞', '丙舞'].map((title, index) => ({
  id: `00000000-0000-4000-8000-00000000000${index + 1}`, title, artist: '歌手', learningStatus: 'WANT_TO_LEARN', sceneTags: ['COOL'], performanceClipId: `clip-${index}`, durationMs: 1000,
  audio: { id: `clip-${index}`, url: `/api/media/audio/clip-${index}`, sha256: `hash-${index}`, sizeBytes: 100, version: 1 },
}));
function mount() { return render(<MemoryRouter><LibraryPage /></MemoryRouter>); }
function respond(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('dance.catalog-snapshot', JSON.stringify(items));
  localStorage.setItem('dance.offline.manifest', JSON.stringify({ catalogVersion: 1, items, playlist: [] }));
  localStorage.setItem('dance.offline.cache', JSON.stringify({ '/api/media/audio/clip-0': { uri: 'file:///original.audio' } }));
  vi.stubGlobal('fetch', vi.fn(async () => respond({ catalogVersion: 1, items })));
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('曲库批量分类', () => {
  it('筛选后全选只选当前结果，改变筛选清空选择，选择卡片不进入详情', async () => {
    await act(async () => { mount(); });
    fireEvent.click(screen.getByRole('button', { name: '批量管理' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '乙' } });
    fireEvent.click(screen.getByRole('button', { name: '全选当前结果' }));
    expect(screen.getByRole('button', { name: '取消选择 乙舞' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('link', { name: '查看 乙舞' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '修改分类（1首）' })).toBeEnabled();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: '修改分类（0首）' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '退出批量' }));
    expect(screen.getByRole('link', { name: '查看 甲舞' })).toBeVisible();
  });
  it('批量保存仅发送所选 ID，并更新曲库/离线元数据而保留音乐缓存', async () => {
    const requests: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/dances/bulk')) {
        requests.push(JSON.parse(init?.body as string));
        return respond({ catalogVersion: 2, items: [{ ...items[0], learningStatus: 'PRACTICING', sceneTags: ['COOL', 'OUTDOOR'] }] });
      }
      return respond({ catalogVersion: 1, items });
    }));
    await act(async () => { mount(); });
    fireEvent.click(screen.getByRole('button', { name: '批量管理' }));
    fireEvent.click(screen.getByRole('button', { name: '选择 甲舞' }));
    fireEvent.click(screen.getByRole('button', { name: '修改分类（1首）' }));
    fireEvent.change(screen.getByLabelText('学习状态'), { target: { value: 'PRACTICING' } });
    fireEvent.change(screen.getByLabelText('标签操作'), { target: { value: 'add' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '户外' }));
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(requests).toEqual([{ ids: [items[0].id], learningStatus: 'PRACTICING', sceneMode: 'add', sceneTags: ['OUTDOOR'] }]);
    const catalog = JSON.parse(localStorage.getItem('dance.catalog-snapshot')!);
    expect(catalog[0].learningStatus).toBe('PRACTICING');
    expect(catalog[1].learningStatus).toBe('WANT_TO_LEARN');
    expect(JSON.parse(localStorage.getItem('dance.offline.manifest')!).items[0].sceneTags).toEqual(['COOL', 'OUTDOOR']);
    expect(JSON.parse(localStorage.getItem('dance.offline.cache')!)['/api/media/audio/clip-0'].uri).toBe('file:///original.audio');
  });
  it('连接失败保留选择和原分类，可重试；退出或取消不保存', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/api/dances/bulk')) throw new TypeError('offline');
      return respond({ catalogVersion: 1, items });
    }));
    await act(async () => { mount(); });
    fireEvent.click(screen.getByRole('button', { name: '批量管理' }));
    fireEvent.click(screen.getByRole('button', { name: '选择 甲舞' }));
    fireEvent.click(screen.getByRole('button', { name: '修改分类（1首）' }));
    fireEvent.change(screen.getByLabelText('学习状态'), { target: { value: 'CAN_DANCE' } });
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('未能保存');
    expect(screen.getByRole('button', { name: '确认修改' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByRole('button', { name: '取消选择 甲舞' })).toHaveAttribute('aria-pressed', 'true');
    expect(JSON.parse(localStorage.getItem('dance.catalog-snapshot')!)[0].learningStatus).toBe('WANT_TO_LEARN');
  });
});
