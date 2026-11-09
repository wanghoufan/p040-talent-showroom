import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  staged: [] as unknown[],
  stageVideo: vi.fn(),
  uploadStoredVideo: vi.fn(),
  discardStoredVideo: vi.fn(async () => {}),
  recoverStoredVideos: vi.fn(async () => 0),
}));

vi.mock('../../src/lib/video-store', () => ({
  VideoCopyError: class VideoCopyError extends Error {},
  stageVideo: store.stageVideo,
  uploadStoredVideo: store.uploadStoredVideo,
  listStagedVideos: () => store.staged,
  discardStoredVideo: store.discardStoredVideo,
  recoverStoredVideos: store.recoverStoredVideos,
}));

import ImportSheet from '../../src/components/ImportSheet';
import PendingImports from '../../src/components/PendingImports';
import { VideoCopyError } from '../../src/lib/video-store';

beforeEach(() => {
  store.staged = [];
  store.stageVideo.mockReset();
  store.uploadStoredVideo.mockReset();
  store.discardStoredVideo.mockReset();
  store.recoverStoredVideos.mockReset();
  store.recoverStoredVideos.mockResolvedValue(0);
  localStorage.clear();
});

function renderImport() {
  const close = vi.fn();
  render(<MemoryRouter initialEntries={['/']}><Routes>
    <Route path="/" element={<ImportSheet onClose={close} />} />
    <Route path="/imports/:id" element={<p>确认页</p>} />
  </Routes></MemoryRouter>);
  return close;
}

describe('单视频导入持久化', () => {
  it('先保存到手机并核对后再上传，成功后进入确认页', async () => {
    const file = new File(['video'], '舞蹈.mp4', { type: 'video/mp4' });
    const staged = { id: 'v1', name: '舞蹈.mp4', sizeBytes: 5, path: 'dance-videos/v1.mp4', verified: true };
    store.stageVideo.mockResolvedValue(staged);
    store.uploadStoredVideo.mockResolvedValue({ id: 'job-1' });
    const close = renderImport();

    const input = document.querySelector('input[type="file"][accept="video/*"]') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });

    expect(store.stageVideo).toHaveBeenCalledWith(file);
    expect(store.uploadStoredVideo).toHaveBeenCalledWith(staged);
    expect(await screen.findByText('确认页')).toBeVisible();
    expect(close).toHaveBeenCalled();
  });

  it('副本校验失败时直接说明，不发起上传', async () => {
    store.stageVideo.mockRejectedValue(new VideoCopyError('视频副本不完整（写入 1 / 5 字节），已保留现场，请重试'));
    renderImport();

    const input = document.querySelector('input[type="file"][accept="video/*"]') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['video'], '舞蹈.mp4', { type: 'video/mp4' })] } }); });

    expect(await screen.findByRole('alert')).toHaveTextContent('视频副本不完整');
    expect(store.uploadStoredVideo).not.toHaveBeenCalled();
  });

  it('上传失败时提示视频已留在手机，可从“未完成的收录”重试', async () => {
    store.stageVideo.mockResolvedValue({ id: 'v2', name: '舞蹈.mp4', sizeBytes: 5, path: 'dance-videos/v2.mp4', verified: true });
    store.uploadStoredVideo.mockRejectedValue(new Error('offline'));
    renderImport();

    const input = document.querySelector('input[type="file"][accept="video/*"]') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['video'], '舞蹈.mp4', { type: 'video/mp4' })] } }); });

    expect(await screen.findByRole('alert')).toHaveTextContent('已保存到手机');
  });
});

describe('未完成的收录：已落盘副本可继续上传', () => {
  it('冷启动恢复后列出等待上传的本地副本，点击可重试上传', async () => {
    store.staged = [{ id: 'v3', name: '已存视频.mp4', sizeBytes: 2048, path: 'dance-videos/v3.mp4', verified: true }];
    store.uploadStoredVideo.mockResolvedValue({ id: 'job-3' });
    render(<MemoryRouter initialEntries={['/']}><Routes>
      <Route path="/" element={<PendingImports />} />
      <Route path="/imports/:id" element={<p>确认页</p>} />
    </Routes></MemoryRouter>);

    expect(await screen.findByText('已存视频.mp4')).toBeVisible();
    expect(store.recoverStoredVideos).toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '继续上传' })); });
    await waitFor(() => expect(screen.getByText('确认页')).toBeVisible());
    expect(store.uploadStoredVideo).toHaveBeenCalledWith(store.staged[0]);
  });

  it('删除副本必须由用户明确点击，不会自动清理', async () => {
    store.staged = [{ id: 'v4', name: '保留视频.mp4', sizeBytes: 1, path: 'dance-videos/v4.mp4', verified: true }];
    render(<MemoryRouter><PendingImports /></MemoryRouter>);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除副本' })); });
    expect(store.discardStoredVideo).toHaveBeenCalledWith('v4');
  });
});
