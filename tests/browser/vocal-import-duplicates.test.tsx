import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { initializeLocalDatabase, readMetadata, writeMetadata } from '../../src/lib/local-database';
import VocalImportPanel from '../../src/components/VocalImportPanel';
import MultiImportSheet from '../../src/components/MultiImportSheet';
import type { TalentItem } from '../../src/lib/types';

const queueFile = vi.hoisted(() => vi.fn(async () => undefined as unknown));
vi.mock('../../src/lib/offline-files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/offline-files')>();
  return { ...actual, queueFile };
});

const audio = (id: string) => ({ id, url: `/api/media/audio/${id}`, sha256: `${id}-sha`, sizeBytes: 4096, version: 1 });

function item(extra: Partial<TalentItem> = {}): TalentItem {
  return {
    id: 'song-1', kind: 'VOCAL', title: '海风来信', artist: '原创演示', learningStatus: 'PRACTICING', revision: 3,
    originalKey: 'C', performanceKey: 'C', capo: 0, scoreText: '', notes: '', audioRole: 'REFERENCE', durationMs: 66000,
    ...extra,
  } as TalentItem;
}

beforeEach(async () => {
  localStorage.clear();
  queueFile.mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  vi.stubGlobal('indexedDB', new IDBFactory());
  await initializeLocalDatabase();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('批量导入同一首歌的两份原唱：只排队一份，另一份明确拒绝而不是静默覆盖', async () => {
  const { container } = render(<MultiImportSheet kind="VOCAL" onClose={() => undefined} />);
  const input = container.querySelector('input[type="file"][multiple]') as HTMLInputElement;
  fireEvent.change(input, {
    target: {
      files: [
        new File(['o1'], '海风来信 原唱.mp3', { type: 'audio/mpeg' }),
        new File(['o2'], '海风来信(原唱).mp3', { type: 'audio/mpeg' }),
        new File(['a'], '海风来信 伴奏.mp3', { type: 'audio/mpeg' }),
      ],
    },
  });

  expect(screen.getByText(/同一首歌只能有一个原唱文件/)).toBeVisible();
  // 被拒绝的重复文件不提供“重试”，不能靠按钮把它重新排回队列。
  expect(screen.queryByRole('button', { name: '重试此项' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '确认并开始收录' }));

  await waitFor(() => expect(queueFile).toHaveBeenCalledTimes(2));
  const calls = queueFile.mock.calls as unknown as [File, { kind: string; id: string }, string, { track?: string }][];
  expect(calls.filter((call) => call[3].track === 'original')).toHaveLength(1);
  expect(calls.filter((call) => call[3].track === 'accompaniment')).toHaveLength(1);
  // 同一首歌仍然只有一首曲目。
  expect(new Set(calls.map((call) => call[1].id)).size).toBe(1);
});

it('已有原唱时点替换先要求确认，确认后才带 replace 标记排队', async () => {
  const current = item({ tracks: { original: { media: audio('clip-original'), offsetMs: 0 } } });
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([current]));
  render(<MemoryRouter><VocalImportPanel item={current} /></MemoryRouter>);
  const fileInput = screen.getByLabelText('选择音轨文件');

  fireEvent.click(screen.getByRole('button', { name: '替换原唱音频' }));
  expect(screen.getByRole('alertdialog', { name: '确认替换音轨' })).toBeInTheDocument();
  expect(queueFile).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: '确认替换原唱' }));
  fireEvent.change(fileInput, { target: { files: [new File(['new'], '新原唱.mp3', { type: 'audio/mpeg' })] } });

  await waitFor(() => expect(queueFile).toHaveBeenCalledTimes(1));
  const [, ref, , options] = queueFile.mock.calls[0] as unknown as [File, { kind: string; id: string }, string, { track?: string; replace?: boolean }];
  expect(ref).toEqual({ kind: 'VOCAL', id: current.id });
  expect(options).toMatchObject({ track: 'original', replace: true });
  expect(screen.getByText(/旧文件保留在服务器上/)).toBeVisible();
});

it('取消替换不会悄悄顶掉原音轨', async () => {
  const current = item({ tracks: { original: { media: audio('clip-original'), offsetMs: 0 } } });
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([current]));
  render(<MemoryRouter><VocalImportPanel item={current} /></MemoryRouter>);

  fireEvent.click(screen.getByRole('button', { name: '替换原唱音频' }));
  fireEvent.click(screen.getByRole('button', { name: '取消替换' }));

  expect(screen.queryByRole('alertdialog', { name: '确认替换音轨' })).not.toBeInTheDocument();
  expect(queueFile).not.toHaveBeenCalled();
  expect(JSON.parse(readMetadata('dance.repertoire-snapshot')!)[0].tracks.original.media.id).toBe('clip-original');
});
