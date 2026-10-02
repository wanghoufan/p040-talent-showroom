import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import SettingsPage from '../../src/pages/SettingsPage';
const stub = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../src/lib/sync', () => ({ syncLibrary: stub.run, inspectOfflineLibrary: async () => ({ items: 3, readyItems: 2 }), readSyncReport: () => null, clearSyncReport: () => {} }));
vi.mock('../../src/native/filesystem', () => ({ offlineBytes: async () => 1000, clearOfflineMedia: async () => {}, isOfflineSupported: () => true }));
beforeEach(() => { localStorage.clear(); stub.run.mockReset(); });
it('部分下载明确失败并提供名单与重试，不声称全部完成', async () => {
 stub.run.mockImplementation(async cb => { cb({ stage: 'download', processed: 3, total: 3, downloaded: 2, failed: 1, pendingBytes: 30 }); return { items: 3, readyItems: 2, mediaSupported: true, complete: false, cancelled: false, failed: [{ key: 'x', title: '失败曲目', kind: 'audio' }] }; });
 await act(async () => { render(<SettingsPage />); }); fireEvent.click(screen.getByRole('button', { name: '下载全部音乐到手机' }));
 expect(await screen.findByText(/部分完成：2\/3/)).toBeVisible(); expect(screen.getByText('失败曲目 · 音乐')).toBeInTheDocument();
 expect(screen.getByRole('button', { name: '重试未完成下载' })).toBeEnabled(); expect(screen.queryByText(/全部完成：/)).not.toBeInTheDocument();
});
it('停止按钮发出取消信号且等待当前文件结束，保留已完成缓存', async () => {
 let signal: AbortSignal; let finish: (value: unknown) => void;
 stub.run.mockImplementation((cb, options) => { signal = options.signal; cb({ stage: 'download', processed: 0, total: 3, downloaded: 0, failed: 0, pendingBytes: 30 }); return new Promise(resolve => { finish = resolve; }); });
 await act(async () => { render(<SettingsPage />); }); fireEvent.click(screen.getByRole('button', { name: '下载全部音乐到手机' }));
 fireEvent.click(screen.getByRole('button', { name: '停止下载' })); expect(signal!.aborted).toBe(true);
 expect(screen.getByRole('button', { name: '正在停止…' })).toBeDisabled();
 await act(async () => { finish!({ items: 3, readyItems: 1, mediaSupported: true, complete: false, cancelled: true, failed: [] }); });
 await waitFor(() => expect(screen.getByText(/已停止下载，已保存的 1 首/)).toBeVisible());
});
