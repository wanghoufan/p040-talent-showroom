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

function item(extra: Partial<TalentItem> = {}): TalentItem {
  return {
    id: 'song-1', kind: 'VOCAL', title: '海风来信', artist: '原创演示', learningStatus: 'PRACTICING', revision: 3,
    originalKey: 'C', performanceKey: 'C', capo: 0, scoreText: '', notes: '', audioRole: 'REFERENCE', durationMs: 66000,
    ...extra,
  } as TalentItem;
}

const snapshot = (): TalentItem[] => JSON.parse(readMetadata('dance.repertoire-snapshot') || '[]');

function renderPanel(current: TalentItem) {
  return render(<MemoryRouter><VocalImportPanel item={current} /></MemoryRouter>);
}

beforeEach(async () => {
  localStorage.clear();
  queueFile.mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  vi.stubGlobal('indexedDB', new IDBFactory());
  await initializeLocalDatabase();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('LRC 按同曲写入 lyrics，不新建曲目', async () => {
  const current = item();
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([current]));
  renderPanel(current);

  const file = new File(['[00:01.00]第一句\n[00:04.50]第二句\n'], '海风来信.lrc', { type: 'text/plain' });
  fireEvent.change(screen.getByLabelText('选择 LRC 歌词文件'), { target: { files: [file] } });

  await waitFor(() => expect(screen.getByText(/已保存 2 句同步歌词/)).toBeVisible());
  const stored = snapshot();
  expect(stored).toHaveLength(1);
  expect(stored[0].id).toBe(current.id);
  expect(stored[0].lyrics?.map((line) => line.text)).toEqual(['第一句', '第二句']);
  expect(stored[0].lyrics?.[1]?.startMs).toBe(4500);
});

it('没有时间戳的 LRC 明确拒绝保存，不伪造时间轴', async () => {
  const current = item();
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([current]));
  renderPanel(current);

  const file = new File(['只有一句没有时间\n'], '海风来信.lrc', { type: 'text/plain' });
  fireEvent.change(screen.getByLabelText('选择 LRC 歌词文件'), { target: { files: [file] } });

  await waitFor(() => expect(screen.getByText(/没有可用的 \[mm:ss\] 时间戳/)).toBeVisible());
  expect(snapshot()[0].lyrics).toBeUndefined();
});

it('手动补录按角色排队：原唱与伴奏分别落到同一 songId 的对应轨', async () => {
  const current = item();
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([current]));
  renderPanel(current);
  const input = screen.getByLabelText('选择音轨文件');

  fireEvent.click(screen.getByRole('button', { name: '导入伴奏音频' }));
  fireEvent.change(input, { target: { files: [new File(['a'], '伴奏.mp3', { type: 'audio/mpeg' })] } });
  await waitFor(() => expect(queueFile).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole('button', { name: '导入原唱音频' }));
  fireEvent.change(input, { target: { files: [new File(['b'], '原唱.mp3', { type: 'audio/mpeg' })] } });
  await waitFor(() => expect(queueFile).toHaveBeenCalledTimes(2));

  const calls = queueFile.mock.calls as unknown as [File, { kind: string; id: string }, string, { track?: string }][];
  expect(calls[0][1]).toEqual({ kind: 'VOCAL', id: current.id });
  expect(calls[0][3].track).toBe('accompaniment');
  expect(calls[1][1]).toEqual({ kind: 'VOCAL', id: current.id });
  expect(calls[1][3].track).toBe('original');
  expect(snapshot()).toHaveLength(1);
});

it('结构人工校准保存为 manual，非法区间明确报错且不落盘', async () => {
  const current = item();
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([current]));
  renderPanel(current);

  fireEvent.click(screen.getByRole('button', { name: '手工标注歌曲结构' }));
  const dialog = screen.getByRole('dialog', { name: '校准歌曲结构' });
  fireEvent.click(screen.getByRole('button', { name: '新增一段' }));
  fireEvent.change(screen.getByLabelText('第 1 段名称'), { target: { value: 'A1' } });
  fireEvent.change(screen.getByLabelText('第 1 段开始秒数'), { target: { value: '5' } });
  fireEvent.change(screen.getByLabelText('第 1 段结束秒数'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: '保存结构' }));

  await waitFor(() => expect(screen.getByText(/结束时间必须晚于开始时间/)).toBeVisible());
  expect(snapshot()[0].sections).toBeUndefined();

  fireEvent.change(screen.getByLabelText('第 1 段结束秒数'), { target: { value: '30' } });
  fireEvent.click(screen.getByRole('button', { name: '保存结构' }));

  await waitFor(() => expect(dialog.isConnected).toBe(false));
  const sections = snapshot()[0].sections || [];
  expect(sections).toHaveLength(1);
  expect(sections[0]).toMatchObject({ label: 'A1', startMs: 5000, endMs: 30000, source: 'manual' });
});

it('本地智能导入提供通往设置页的有效入口，并保留手动导入备用', () => {
  renderPanel(item());
  const entry = screen.getByRole('link', { name: '前往「我的」使用本地智能导入' });
  expect(entry).toHaveAttribute('href', '/settings');
  expect(screen.getByText(/本地智能导入已在「我的 → 本地智能导入」可用/)).toBeVisible();
  expect(screen.getByText(/不是生成新伴奏/)).toBeVisible();
  expect(screen.queryByText(/尚未接入|只预留了数据契约/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '导入原唱音频' })).toBeEnabled();
});

it('批量导入把同一首歌的原唱、伴奏、LRC 归到一首曲目', async () => {
  const { container } = render(<MultiImportSheet kind="VOCAL" onClose={() => undefined} />);
  const input = container.querySelector('input[type="file"][multiple]') as HTMLInputElement;
  fireEvent.change(input, {
    target: {
      files: [
        new File(['o'], '海风来信 原唱.mp3', { type: 'audio/mpeg' }),
        new File(['a'], '海风来信 伴奏.mp3', { type: 'audio/mpeg' }),
        new File(['[00:01.00]第一句\n[00:05.00]第二句\n'], '海风来信.lrc', { type: 'text/plain' }),
      ],
    },
  });

  expect(screen.getByText(/不会生成三首/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '确认并开始收录' }));

  await waitFor(() => expect(snapshot()).toHaveLength(1));
  const calls = queueFile.mock.calls as unknown as [File, { kind: string; id: string }, string, { track?: string }][];
  expect(calls).toHaveLength(2);
  const ids = new Set(calls.map((call) => call[1].id));
  expect(ids.size).toBe(1);
  expect(new Set(calls.map((call) => call[3].track))).toEqual(new Set(['original', 'accompaniment']));

  const stored = snapshot();
  expect(stored).toHaveLength(1);
  expect(stored[0].lyrics?.map((line) => line.text)).toEqual(['第一句', '第二句']);
});

it('只有歌词没有音频时不单独建曲目，给出明确错误', () => {
  const { container } = render(<MultiImportSheet kind="VOCAL" onClose={() => undefined} />);
  const input = container.querySelector('input[type="file"][multiple]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['[00:01.00]一句\n'], '孤单歌词.lrc', { type: 'text/plain' })] } });
  expect(screen.getByText(/只有歌词文件，缺少音频/)).toBeVisible();
  expect(screen.getByRole('button', { name: '确认并开始收录' })).toBeDisabled();
});
