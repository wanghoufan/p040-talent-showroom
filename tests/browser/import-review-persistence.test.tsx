import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const flow = vi.hoisted(() => ({
  job: {} as Record<string, unknown>,
  video: undefined as undefined | Record<string, unknown>,
  pending: undefined as undefined | Record<string, unknown>,
  finalize: vi.fn(),
  supplement: vi.fn(async (_path: string, _options?: RequestInit) => ({})),
  link: vi.fn(async (_id: string, _changes: Record<string, unknown>) => ({})),
  forget: vi.fn(),
  remember: vi.fn(),
}));

vi.mock('../../src/lib/api', () => ({
  api: vi.fn(async (path: string) => (path.endsWith('/finalize') ? flow.finalize() : flow.job)),
  apiWithTimeout: flow.supplement,
  jsonBody: (value: unknown) => value,
  mediaUrl: (path: string) => path,
  ApiError: class ApiError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status; } },
}));
vi.mock('../../src/lib/pending-imports', () => ({
  findPendingImport: () => flow.pending,
  forgetImport: flow.forget,
  rememberImport: flow.remember,
}));
vi.mock('../../src/lib/pending-shares', () => ({ removeShareByJob: vi.fn(), updateShareByJob: vi.fn() }));
vi.mock('../../src/lib/catalog-store', () => ({ catalogChanged: vi.fn() }));
vi.mock('../../src/lib/video-store', () => ({
  VideoCopyError: class VideoCopyError extends Error {},
  stageVideo: vi.fn(),
  readStoredVideo: vi.fn(async () => new Blob([new Uint8Array(2048)])),
  findStoredVideoByJob: () => flow.video,
  findStoredVideo: (id: string) => (flow.video?.id === id ? flow.video : undefined),
  linkStoredVideo: flow.link,
  recoverStoredVideos: vi.fn(async () => 0),
  discardStoredVideo: vi.fn(async () => {}),
}));

import ImportReviewPage from '../../src/pages/ImportReviewPage';

function renderAt(id = 'j1') {
  render(<MemoryRouter initialEntries={[`/imports/${id}`]}><Routes>
    <Route path="/imports/:id" element={<ImportReviewPage />} />
    <Route path="/dances/:id" element={<p>舞蹈详情</p>} />
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  // jsdom 不实现整页刷新；用替身避免第一个用例把测试环境导航走。
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload: vi.fn() } });
  flow.video = undefined;
  flow.pending = undefined;
  flow.finalize.mockReset();
  flow.supplement.mockClear();
  flow.link.mockClear();
  flow.forget.mockReset();
  flow.remember.mockReset();
});

describe('收录确认页：已落盘视频的继续上传与来源登记', () => {
  it('NEEDS_INPUT 时优先使用私有副本继续上传，不再要求重新选文件', async () => {
    flow.job = { id: 'j1', status: 'NEEDS_INPUT', stage: 'ACQUIRE' };
    flow.video = { id: 'v1', name: '已存.mp4', mime: 'video/mp4', sizeBytes: 2048, path: 'dance-videos/v1.mp4', verified: true };
    renderAt();

    expect(await screen.findByText(/视频已保存在手机/)).toBeVisible();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '继续上传已保存的视频' })); });

    expect(flow.supplement).toHaveBeenCalledTimes(1);
    expect(String(flow.supplement.mock.calls[0][0])).toContain('/api/imports/j1/supplement');
  });

  it('保存成功把私有副本登记为该曲目的原视频来源', async () => {
    flow.job = { id: 'j1', status: 'READY', stage: 'REVIEW', draft: { title: '测试舞', artist: '测试' } };
    flow.video = { id: 'v1', name: '测试舞.mp4', mime: 'video/mp4', sizeBytes: 2048, path: 'dance-videos/v1.mp4', verified: true };
    flow.pending = { jobId: 'j1', videoId: 'v1', name: '测试舞.mp4', createdAt: '' };
    flow.finalize.mockResolvedValue({ id: 'd1', sourceMediaId: 's1' });
    renderAt();

    const saveButton = await screen.findByRole('button', { name: '保存到我的舞蹈库' });
    await act(async () => { fireEvent.click(saveButton); });

    await waitFor(() => expect(screen.getByText('舞蹈详情')).toBeVisible());
    expect(flow.link).toHaveBeenCalledWith('v1', { sourceMediaId: 's1' });
    expect(flow.forget).toHaveBeenCalledWith('j1');
  });
});
