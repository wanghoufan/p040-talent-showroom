import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { initializeLocalDatabase } from '../../src/lib/local-database';
import { cacheRepertoire, storedRepertoire } from '../../src/lib/repertoire-store';
import VocalSectionEditor from '../../src/components/VocalSectionEditor';
import VocalStructureDraftPanel from '../../src/components/VocalStructureDraftPanel';
import type { TalentItem, TimedLyric, VocalSection } from '../../src/lib/types';

/**
 * 结构校准与结构草稿面板（V3.2 T4/T5）。
 * 只验证交互与本地/接口调用，不代表真实音频准确率。
 */

const line = (startMs: number, text: string): TimedLyric => ({ id: `l-${startMs}`, startMs, text });
const section = (input: Partial<VocalSection> & Pick<VocalSection, 'id'>): VocalSection => ({ type: 'verse', label: input.id, startMs: 0, endMs: 1000, source: 'manual', ...input });

const LYRICS = [line(1000, '第一句'), line(5000, '第二句'), line(9000, '第三句'), line(50000, '第一句')];

function item(extra: Partial<TalentItem> = {}): TalentItem {
  return {
    id: 'vocal-1', kind: 'VOCAL', title: '海风来信', artist: '原创演示', learningStatus: 'PRACTICING',
    originalKey: 'C', performanceKey: 'C', capo: 0, scoreText: '', notes: '', audioRole: 'REFERENCE', durationMs: 66000,
    lyrics: LYRICS,
    sections: [
      section({ id: 's1', type: 'verse', label: 'A1', startMs: 0, endMs: 12000 }),
      section({ id: 's2', type: 'chorus', label: 'B1', startMs: 12000, endMs: 40000 }),
      section({ id: 's3', type: 'verse', label: 'A2', startMs: 40000, endMs: 66000 }),
    ],
    ...extra,
  } as TalentItem;
}

beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal('indexedDB', new IDBFactory());
  await initializeLocalDatabase();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('按歌词句拆分再合并，段数与编号同步变化', async () => {
  render(<VocalSectionEditor item={item()} onClose={() => undefined} onSaved={() => undefined} />);
  const dialog = screen.getByRole('dialog', { name: '校准歌曲结构' });
  fireEvent.click(within(dialog).getByRole('button', { name: /选择 A1/ }));

  fireEvent.change(within(dialog).getByLabelText('选择拆分用的歌词句'), { target: { value: 'l-5000' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '在这一句拆成两段' }));
  expect(within(dialog).getByRole('button', { name: /选择 A1/ })).toBeVisible();
  expect(within(dialog).getByRole('button', { name: /选择 A2/ })).toBeVisible();
  expect(within(dialog).getByRole('button', { name: /选择 B1/ })).toBeVisible();

  fireEvent.click(within(dialog).getByRole('button', { name: /选择 A2/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: '与上一段合并' }));
  // 合并后回到 A1(0–12)、B1、A2(40–66)：没有残留的 A3，也没有多出的一段。
  expect(within(dialog).getAllByRole('button', { name: /选择 A\d/ })).toHaveLength(2);
  expect(within(dialog).queryByRole('button', { name: /选择 A3/ })).not.toBeInTheDocument();
});

it('改类型立即生效，歌词不同的两段不能确认同词', () => {
  render(<VocalSectionEditor item={item()} onClose={() => undefined} onSaved={() => undefined} />);
  const dialog = screen.getByRole('dialog', { name: '校准歌曲结构' });
  fireEvent.click(within(dialog).getByRole('button', { name: /选择 A2/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: '副歌' }));
  expect(within(dialog).getByRole('button', { name: /选择 B2/ })).toBeVisible();

  // A2 的歌词（第一句）与 B1 不同，同词按钮必须禁用，只能选换词。
  expect(within(dialog).getByRole('button', { name: '同词重复' })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole('button', { name: '旋律同、换词' }));
  expect(within(dialog).getByRole('button', { name: '旋律同、换词' })).toHaveAttribute('aria-pressed', 'true');
});

it('Rap 必须逐段显式确认，取消后回到未确认', () => {
  const withRap = item({
    sections: [
      section({ id: 's1', type: 'verse', label: 'A1', startMs: 0, endMs: 12000 }),
      section({ id: 's2', type: 'rap', label: 'R1', startMs: 12000, endMs: 40000, rapApproved: false }),
      section({ id: 's3', type: 'chorus', label: 'B1', startMs: 40000, endMs: 66000 }),
    ],
  });
  render(<VocalSectionEditor item={withRap} onClose={() => undefined} onSaved={() => undefined} />);
  const dialog = screen.getByRole('dialog', { name: '校准歌曲结构' });
  fireEvent.click(within(dialog).getByRole('button', { name: /选择 R1/ }));

  expect(within(dialog).getByText(/未确认：不会自动跳过/)).toBeVisible();
  fireEvent.click(within(dialog).getByRole('button', { name: '确认这段是 Rap（可跳过）' }));
  expect(within(dialog).getByText(/已确认这一段是 Rap/)).toBeVisible();
  expect(within(dialog).getByRole('button', { name: /选择 R1/ })).toHaveTextContent('Rap 已确认');

  fireEvent.click(within(dialog).getByRole('button', { name: '取消确认' }));
  expect(within(dialog).getByText(/未确认：不会自动跳过/)).toBeVisible();
});

it('结构草稿：分析结果先以草稿展示，应用后才写正式结构', async () => {
  const draft = {
    songId: 'vocal-1', state: 'NEEDS_REVIEW', generatedAt: '2026-10-31T00:00:00Z',
    modelName: 'p040-mix-structure', modelVersion: '1.1.0', baseRevision: 1, appliedRevision: null,
    legacySectionCount: 3, currentSectionCount: 3,
    summary: { sections: 2, pendingTypes: 2, typeCandidates: 1, pendingRelations: 1, pendingMerges: 0, uncovered: 0, needsReview: true },
    timing: { seconds: 3.2, peakMemoryMb: 610 }, separation: { used: false, modulesSeen: [] },
    map: {
      schema: 'p040.song-map.v1', songId: 'vocal-1', durationMs: 66000, status: 'draft', warnings: ['NEEDS_TYPE_CONFIRMATION'],
      relationCandidates: [],
      sections: [
        { id: 'analysis-1', type: 'intro', code: '前奏', startMs: 0, endMs: 11000 },
        { id: 'analysis-2', type: 'unknown', code: 'U1', startMs: 11000, endMs: 66000, typeCandidate: 'chorus' },
      ],
    },
  };
  const onUpdated = vi.fn();
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/structure-draft') && init?.method === 'POST') {
      return new Response(JSON.stringify({ draft, reused: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).endsWith('/structure-draft') && init?.method === 'PUT') {
      return new Response(JSON.stringify({ item: item(), applied: 2, draft: { ...draft, state: 'APPLIED' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<VocalStructureDraftPanel item={item()} hasOriginalTrack onUpdated={onUpdated} />);
  fireEvent.click(screen.getByRole('button', { name: '分析原唱结构' }));
  await waitFor(() => expect(screen.getByText(/草稿：2 段/)).toBeVisible());
  expect(screen.getByText(/待标注 2 段/)).toBeVisible();
  expect(screen.getByText(/未做音源分离/)).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: '应用为新结构' }));
  await waitFor(() => expect(screen.getByText(/已应用 2 段结构/)).toBeVisible());
  expect(onUpdated).toHaveBeenCalledTimes(1);
});

it('参考草稿无需逐段确认即可应用，未定类型保留待标注', async () => {
  const draft = {
    state: 'DRAFT', modelName: 'reference', modelVersion: '1', legacySectionCount: 0,
    summary: { sections: 1, pendingTypes: 1, typeCandidates: 0, pendingRelations: 0 },
    reference: { candidateCount: 1, disputedCount: 1, source: '参考来源', identity: { ok: true } },
    map: { sections: [{ id: 'r1', type: 'unknown', code: 'U1', startMs: 0, endMs: 66000 }] },
  };
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(
    init?.method === 'PUT' ? { item: item(), applied: 1, draft } : { draft, reused: true },
  ), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  render(<VocalStructureDraftPanel item={item()} hasOriginalTrack />);
  fireEvent.click(screen.getByRole('button', { name: '分析原唱结构' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '应用为新结构' })).toBeEnabled());
  expect(screen.queryByRole('button', { name: /逐段核对/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '应用为新结构' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const payload = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
  expect(payload.confirmReference).toBe(true);
  expect(payload.map.sections[0].type).toBe('unknown');
});

it('结构草稿：本机未配置分析时显示明确原因，不假装成功', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    error: { code: 'ANALYZER_NOT_CONFIGURED', message: '这台电脑还没有配置原曲结构分析（P040_STRUCTURE_PYTHON）；曲目保持「待分析」。' },
  }), { status: 503, headers: { 'Content-Type': 'application/json' } })));

  render(<VocalStructureDraftPanel item={item()} hasOriginalTrack onUpdated={() => undefined} />);
  fireEvent.click(screen.getByRole('button', { name: '分析原唱结构' }));
  await waitFor(() => expect(screen.getByText(/P040_STRUCTURE_PYTHON/)).toBeVisible());
});

/**
 * 恢复旧结构 / 应用草稿后弹层必须跟着正式结构走。
 * 旧实现只在挂载时读一次 item.sections，弹层会停留在上一次的段数，刷新才恢复。
 */
it('恢复旧结构后，已打开的弹层同步为最新正式结构', () => {
  const applied = item({
    sections: [
      section({ id: 'u1', type: 'unknown', label: 'U1', startMs: 0, endMs: 12000 }),
      section({ id: 'u2', type: 'unknown', label: 'U2', startMs: 12000, endMs: 40000 }),
      section({ id: 'u3', type: 'unknown', label: 'U3', startMs: 40000, endMs: 66000 }),
    ],
  });
  const restored = item();
  const props = { onClose: () => undefined, onSaved: () => undefined };
  const { rerender } = render(<VocalSectionEditor item={applied} {...props} />);
  const dialog = screen.getByRole('dialog', { name: '校准歌曲结构' });
  expect(within(dialog).getAllByRole('button', { name: /选择 U\d/ })).toHaveLength(3);

  rerender(<VocalSectionEditor item={restored} {...props} />);

  expect(within(dialog).getByText(/已同步为最新结构/)).toBeVisible();
  expect(within(dialog).queryByRole('button', { name: /选择 U1/ })).not.toBeInTheDocument();
  expect(within(dialog).getAllByRole('button', { name: /选择 A\d/ })).toHaveLength(2);
  expect(within(dialog).getAllByRole('button', { name: /选择 B\d/ })).toHaveLength(1);
});

/** 外部更新不能把用户正在改的内容冲掉；已有段落保持原值，不因为同步被覆盖。 */
it('弹层有未保存改动时，外部恢复不覆盖本地编辑', () => {
  const applied = item({
    sections: [
      section({ id: 'u1', type: 'unknown', label: 'U1', startMs: 0, endMs: 12000 }),
      section({ id: 'u2', type: 'unknown', label: 'U2', startMs: 12000, endMs: 40000 }),
      section({ id: 'u3', type: 'unknown', label: 'U3', startMs: 40000, endMs: 66000 }),
    ],
  });
  const props = { onClose: () => undefined, onSaved: () => undefined };
  const { rerender } = render(<VocalSectionEditor item={applied} {...props} />);
  const dialog = screen.getByRole('dialog', { name: '校准歌曲结构' });

  fireEvent.change(within(dialog).getByLabelText('选择拆分用的歌词句'), { target: { value: 'l-5000' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '在这一句拆成两段' }));
  expect(within(dialog).getAllByRole('button', { name: /选择 U\d/ })).toHaveLength(4);

  rerender(<VocalSectionEditor item={item()} {...props} />);

  expect(within(dialog).getByText(/当前未保存的改动仍保留/)).toBeVisible();
  // 本地拆分结果仍在，没有被恢复出来的 A1/B1/A2 顶掉。
  expect(within(dialog).getAllByRole('button', { name: /选择 U\d/ })).toHaveLength(4);
  expect(within(dialog).queryByRole('button', { name: /选择 A1/ })).not.toBeInTheDocument();
  // 原有段落 u3（40.0–66.0s）边界保持原值，没被恢复出来的 A1/B1/A2 顶掉。
  expect(within(dialog).getByRole('button', { name: /选择 U4/ })).toHaveTextContent('40.0–66.0s');
});

/**
 * 秒数精调按 0.1 秒显示；只改一端时，另一端必须保留原值。
 * 旧实现会把 219572ms 按显示值回写成 219600ms，凭空造出越界边界，保存失败。
 */
it('改旧尾段起点不会把另一端的 219572ms 改成 219600ms', async () => {
  const long = item({
    durationMs: 219560,
    tracks: {
      original: { media: { id: 'm-original', url: '/api/media/audio/original', sha256: 'h', sizeBytes: 10, version: 1, durationMs: 219572 }, offsetMs: 0 },
    },
    sections: [
      section({ id: 's1', type: 'verse', label: 'A1', startMs: 0, endMs: 12000 }),
      section({ id: 's2', type: 'chorus', label: 'B1', startMs: 12000, endMs: 212740 }),
      section({ id: 's3', type: 'verse', label: 'A2', startMs: 212740, endMs: 219572 }),
    ],
  });
  cacheRepertoire([long]);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'applied', revision: 2 }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  const onSaved = vi.fn();

  render(<VocalSectionEditor item={long} onClose={() => undefined} onSaved={onSaved} />);
  const dialog = screen.getByRole('dialog', { name: '校准歌曲结构' });
  fireEvent.click(within(dialog).getByRole('button', { name: /选择 A2/ }));
  fireEvent.change(within(dialog).getByLabelText('本段开始秒数'), { target: { value: '212.8' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存结构' }));

  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(3));
  const saved = storedRepertoire().find((entry) => entry.id === 'vocal-1');
  expect(saved?.sections?.at(-1)).toMatchObject({ id: 's3', startMs: 212800, endMs: 219572 });
});

/**
 * 旧尾段 219600ms 比真实音轨（219572ms）多 28ms：原样保留时不能挡住保存，
 * 也不能把 219600 悄悄改成 219572。
 */
it('旧尾段原样保留可保存，且保存值不被改写', async () => {
  const long = item({
    durationMs: 219560,
    tracks: {
      original: { media: { id: 'm-original', url: '/api/media/audio/original', sha256: 'h', sizeBytes: 10, version: 1, durationMs: 219572 }, offsetMs: 0 },
      accompaniment: { media: { id: 'm-acc', url: '/api/media/audio/acc', sha256: 'h', sizeBytes: 10, version: 1, durationMs: 219560 }, offsetMs: 0 },
    },
    sections: [
      section({ id: 's1', type: 'verse', label: 'A1', startMs: 0, endMs: 12000 }),
      section({ id: 's2', type: 'chorus', label: 'B1', startMs: 12000, endMs: 200000 }),
      section({ id: 's3', type: 'verse', label: 'A2', startMs: 200000, endMs: 219600 }),
    ],
  });
  cacheRepertoire([long]);
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'applied', revision: 2 }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  const onSaved = vi.fn();

  render(<VocalSectionEditor item={long} onClose={() => undefined} onSaved={onSaved} />);
  const dialog = screen.getByRole('dialog', { name: '校准歌曲结构' });
  fireEvent.change(within(dialog).getByLabelText('选择拆分用的歌词句'), { target: { value: 'l-5000' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '在这一句拆成两段' }));
  fireEvent.click(within(dialog).getByRole('button', { name: '保存结构' }));

  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(4));
  expect(within(dialog).queryByText(/段落超出歌曲总时长/)).not.toBeInTheDocument();
  const saved = storedRepertoire().find((entry) => entry.id === 'vocal-1');
  expect(saved?.sections?.at(-1)).toMatchObject({ id: 's3', startMs: 200000, endMs: 219600 });
  expect(saved?.sections?.map((entry) => entry.endMs)).toEqual([5000, 12000, 200000, 219600]);
});

