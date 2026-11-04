import {MemoryRouter} from 'react-router-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import SettingsPage from '../../src/pages/SettingsPage';
import DownloadItemButton from '../../src/components/DownloadItemButton';
const stub = vi.hoisted(() => ({ run: vi.fn() }));
const plan = vi.hoisted(() => ({ next: { items: 1, entries: 1, pending: 1, bytes: 2048, ready: false } }));
vi.mock('../../src/lib/sync', () => ({ syncLibrary: stub.run, planDownload: () => plan.next, planMedia: () => plan.next, inspectOfflineLibrary: async () => ({ items: 3, readyItems: 2 }), readSyncReport: () => null, clearSyncReport: () => {}, syncReferences: vi.fn(async () => ({ total: 0, downloaded: 0, skipped: 0, mediaSupported: true, syncedAt: '', failed: 0, cancelled: false, complete: true })), readReferenceReport: () => null, clearReferenceReport: () => {}, referencePlan: () => ({ total: 0, ready: 0, bytes: 0 }) }));
vi.mock('../../src/native/filesystem', () => ({ offlineBytes: async () => 1000, clearOfflineMedia: async () => {}, isOfflineSupported: () => true }));
vi.mock('../../src/lib/api', () => ({ api: vi.fn(async () => ({ catalogVersion: 1, items: [], playlist: [] })), jsonBody: (value: unknown) => value }));
beforeEach(() => { localStorage.clear(); stub.run.mockReset(); plan.next = { items: 1, entries: 1, pending: 1, bytes: 2048, ready: false }; });
/** 造一份本地快照：2 首想学（舞蹈 d1 / 唱歌 v1）、1 首已会（d2）、1 首想学吉他 g1（不该进歌单），节目单 v1 + d2。 */
function seedLibrary() {
 localStorage.setItem('dance.catalog-snapshot', JSON.stringify([{ id: 'd1', title: '想学的舞', learningStatus: 'WANT_TO_LEARN' }, { id: 'd2', title: '已会的舞', learningStatus: 'CAN_DANCE' }]));
 localStorage.setItem('dance.repertoire-snapshot', JSON.stringify([{ id: 'v1', kind: 'VOCAL', title: '想学的歌', learningStatus: 'WANT_TO_LEARN' }, { id: 'g1', kind: 'GUITAR', title: '想学的吉他', learningStatus: 'WANT_TO_LEARN' }]));
 localStorage.setItem('dance.program', JSON.stringify({ revision: 1, items: [{ kind: 'VOCAL', id: 'v1' }, { kind: 'DANCE', id: 'd2' }] }));
}
const danceItem = { id: 'd1', title: '想学的舞', artist: '', learningStatus: 'WANT_TO_LEARN' as const, sceneTags: [] as [], performanceClipId: 'p1', durationMs: 1000, audio: { id: 'a1', url: '/api/media/audio/1', sha256: 'h1', sizeBytes: 2048, version: 1 } };
it('部分下载明确失败并提供名单与重试，不声称全部完成', async () => {
 stub.run.mockImplementation(async cb => { cb({ stage: 'download', processed: 3, total: 3, downloaded: 2, failed: 1, pendingBytes: 30 }); return { items: 3, readyItems: 2, mediaSupported: true, complete: false, cancelled: false, failed: [{ key: 'x', title: '失败曲目', kind: 'audio' }] }; });
 await act(async () => { render(<MemoryRouter><SettingsPage /></MemoryRouter>); }); fireEvent.click(screen.getByRole('button', { name: '下载全部音乐到手机' }));
 expect(await screen.findByText(/部分完成：2\/3/)).toBeVisible(); expect(screen.getByText('失败曲目 · 音乐')).toBeInTheDocument();
 expect(screen.getByRole('button', { name: '重试未完成下载' })).toBeEnabled(); expect(screen.queryByText(/全部完成：/)).not.toBeInTheDocument();
});
it('停止按钮发出取消信号且等待当前文件结束，保留已完成缓存', async () => {
 let signal: AbortSignal; let finish: (value: unknown) => void;
 stub.run.mockImplementation((cb, options) => { signal = options.signal; cb({ stage: 'download', processed: 0, total: 3, downloaded: 0, failed: 0, pendingBytes: 30 }); return new Promise(resolve => { finish = resolve; }); });
 await act(async () => { render(<MemoryRouter><SettingsPage /></MemoryRouter>); }); fireEvent.click(screen.getByRole('button', { name: '下载全部音乐到手机' }));
 fireEvent.click(screen.getByRole('button', { name: '停止下载' })); expect(signal!.aborted).toBe(true);
 expect(screen.getByRole('button', { name: '正在停止…' })).toBeDisabled();
 await act(async () => { finish!({ items: 3, readyItems: 1, mediaSupported: true, complete: false, cancelled: true, failed: [] }); });
 await waitFor(() => expect(screen.getByText(/已停止下载，已保存的 1 首/)).toBeVisible());
});

it('下载想学歌单只传想学的唱歌/舞蹈 id，不动其它曲目', async () => {
 seedLibrary();
 stub.run.mockResolvedValue({ items: 2, readyItems: 2, mediaSupported: true, complete: true, cancelled: false, failed: [] });
 await act(async () => { render(<MemoryRouter><SettingsPage /></MemoryRouter>); });
 fireEvent.click(await screen.findByRole('button', { name: /下载想学歌单/ }));
 await waitFor(() => expect(stub.run).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ onlyIds: ['d1', 'v1'] })));
});
it('下载今晚节目单按节目单顺序传 id', async () => {
 seedLibrary();
 stub.run.mockResolvedValue({ items: 2, readyItems: 2, mediaSupported: true, complete: true, cancelled: false, failed: [] });
 await act(async () => { render(<MemoryRouter><SettingsPage /></MemoryRouter>); });
 fireEvent.click(await screen.findByRole('button', { name: /下载今晚节目单/ }));
 await waitFor(() => expect(stub.run).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ onlyIds: ['v1', 'd2'] })));
});
it('单曲下载按钮先显示体积，点击只下载这一首，已离线后禁用', async () => {
 stub.run.mockResolvedValue({ items: 1, readyItems: 1, mediaSupported: true, complete: true, cancelled: false, failed: [] });
 await act(async () => { render(<DownloadItemButton item={danceItem} />); });
 fireEvent.click(screen.getByRole('button', { name: '下载这首歌：想学的舞' }));
 await waitFor(() => expect(stub.run).toHaveBeenCalledWith(undefined, expect.objectContaining({ onlyIds: ['d1'] })));
 expect(screen.getByText('下载这首歌 · 2.0 KB')).toBeInTheDocument();
 plan.next = { items: 1, entries: 1, pending: 0, bytes: 0, ready: true };
 await act(async () => { render(<DownloadItemButton item={danceItem} />); });
 expect(screen.getAllByRole('button', { name: '想学的舞 已离线' })[0]).toBeDisabled();
});
