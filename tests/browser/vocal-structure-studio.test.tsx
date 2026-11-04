import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { initializeLocalDatabase } from '../../src/lib/local-database';
import { cacheRepertoire, storedRepertoire } from '../../src/lib/repertoire-store';
import VocalStructureStudio from '../../src/components/VocalStructureStudio';
import type { TalentItem, TimedLyric, VocalSection } from '../../src/lib/types';

/**
 * 结构工作室（V3.3 参考草稿最小闭环）。
 * 只验证界面行为：候选展示、争议不定型、定位/循环、校正、撤销、显式保存为 manual。
 * 不播放声音、不跑真实分析、不连真实库。
 */

const DURATION = 195036;
const line = (startMs: number, text: string): TimedLyric => ({ id: `l-${startMs}`, startMs, text });
const section = (input: Partial<VocalSection> & Pick<VocalSection, 'id'>): VocalSection => ({ type: 'verse', label: input.id, startMs: 0, endMs: 1000, source: 'manual', ...input });

const item = (extra: Partial<TalentItem> = {}): TalentItem => ({
  id: 'papillon-1', kind: 'VOCAL', title: 'Papillon', artist: '王嘉尔', learningStatus: 'PRACTICING',
  originalKey: 'C', performanceKey: 'C', capo: 0, scoreText: '', notes: '', audioRole: 'REFERENCE', durationMs: DURATION,
  lyrics: [line(12180, 'Yeh'), line(34650, 'You got me feeling like a'), line(57150, 'Papillon')],
  sections: [
    section({ id: 'old-1', type: 'intro', label: '前奏', startMs: 0, endMs: 12000 }),
    section({ id: 'old-2', type: 'unknown', label: 'U1', startMs: 12000, endMs: DURATION }),
  ],
  ...extra,
} as TalentItem);

/** 服务端参考草稿的形状（10 段 Papillon 候选，2 段争议）。 */
const CANDIDATES = [
  { code: '前奏', type: 'intro', typeLabel: '前奏', startMs: 0, endMs: 12180, referenceLabel: '前奏', disputed: false, alternates: [], anchor: { lineId: null, deltaMs: 0, snapped: true } },
  { code: 'B1', type: 'chorus', typeLabel: '副歌', startMs: 12180, endMs: 34650, referenceLabel: 'B1 副歌', disputed: false, alternates: [], anchor: { lineId: 'l-12180', deltaMs: 180, snapped: true } },
  { code: 'A1', type: 'verse', typeLabel: '主歌', startMs: 34650, endMs: 57150, referenceLabel: 'A1 主歌', disputed: false, alternates: [], anchor: { lineId: 'l-34650', deltaMs: -350, snapped: true } },
  { code: 'U1', type: 'unknown', typeLabel: '待标注', startMs: 57150, endMs: 68560, referenceLabel: 'C1 叠句（待核对）', disputed: true, alternates: ['refrain', 'verse'], anchor: { lineId: 'l-57150', deltaMs: 150, snapped: true } },
  { code: 'P1', type: 'pre', typeLabel: '预副歌', startMs: 68560, endMs: 79870, referenceLabel: 'P1 预副歌', disputed: false, alternates: [], anchor: { lineId: null, deltaMs: 0, snapped: false } },
  { code: 'B2', type: 'chorus', typeLabel: '副歌', startMs: 79870, endMs: 103260, referenceLabel: 'B2 副歌', disputed: false, alternates: [], anchor: { lineId: null, deltaMs: 0, snapped: true } },
  { code: 'A2', type: 'verse', typeLabel: '主歌', startMs: 103260, endMs: 125290, referenceLabel: 'A2 主歌', disputed: false, alternates: [], anchor: { lineId: null, deltaMs: 0, snapped: true } },
  { code: 'U2', type: 'unknown', typeLabel: '待标注', startMs: 125290, endMs: 136400, referenceLabel: 'C2 叠句（待核对）', disputed: true, alternates: ['refrain', 'verse'], anchor: { lineId: null, deltaMs: 0, snapped: true } },
  { code: 'P2', type: 'pre', typeLabel: '预副歌', startMs: 136400, endMs: 147450, referenceLabel: 'P2 预副歌', disputed: false, alternates: [], anchor: { lineId: null, deltaMs: 0, snapped: true } },
  { code: 'B3', type: 'chorus', typeLabel: '副歌', startMs: 147450, endMs: DURATION, referenceLabel: 'B3 副歌', disputed: false, alternates: [], anchor: { lineId: null, deltaMs: 0, snapped: true }, endUnverified: true },
].map((entry, index) => ({ id: `ref-${index + 1}`, source: 'reference', referenceIndex: index, repeatCandidateOf: null as string | null, ...entry }));

const draft = () => ({
  songId: 'papillon-1', state: 'DRAFT', generatedAt: '2026-10-31T05:00:00Z',
  modelName: 'reference-draft', modelVersion: 'draft', baseRevision: 3,
  appliedRevision: null, legacySectionCount: 2, currentSectionCount: 2,
  summary: { sections: 10, pendingTypes: 2, typeCandidates: 0, pendingRelations: 0, pendingMerges: 0, uncovered: 0, needsReview: true },
  timing: null, separation: null,
  reference: {
    songTitle: 'Papillon', artist: 'Jackson Wang', version: 'studio', source: 'fan-reference-plus-user-LRC', note: 'Not official',
    audioSha256: '057306bf81c0c2e143848db6b90b416cdee3ad3c0cb218f1f0c35022585d63b7', audioDurationMs: DURATION,
    status: 'DRAFT_REVIEW_REQUIRED',
    identity: {
      ok: true,
      checks: [{ id: 'title', ok: true, expected: 'Papillon', actual: 'Papillon' }, { id: 'artist', ok: true, expected: '王嘉尔', actual: '王嘉尔' },
        { id: 'version', ok: true, expected: '', actual: '' }, { id: 'duration', ok: true, expected: '195036ms', actual: '195036ms' },
        { id: 'audioSha256', ok: true, expected: '0573…', actual: '0573…' }],
      blockers: [],
    },
    candidateCount: 10, disputedCount: 2, unsnappedCount: 0, loadedAt: '2026-10-31T05:00:00Z',
    warnings: ['REFERENCE_DISPUTED_TYPES'],
    sections: CANDIDATES,
  },
  map: {
    schema: 'p040.song-map.v1', songId: 'papillon-1', durationMs: DURATION, status: 'draft', warnings: ['REFERENCE_DISPUTED_TYPES'],
    relationCandidates: [], mergeCandidates: [], unassigned: [],
    sections: CANDIDATES.map((entry) => ({ ...entry })),
  },
});

const audioBridge = () => ({ timeMs: 0, playing: false, seek: vi.fn(), toggle: vi.fn() });

function mockFetch(handlers: { load?: () => Response; draft?: unknown } = {}) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
    if (String(url).includes('/structure-waveform')) {
      return new Response(JSON.stringify({ error: { code: 'FFMPEG_UNAVAILABLE', message: '没有 ffmpeg' } }), { status: 503 });
    }
    if (String(url).endsWith('/structure-draft/reference') && init?.method === 'POST') {
      if (handlers.load) return handlers.load();
      return new Response(JSON.stringify({ draft: draft(), identity: draft().reference.identity }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).endsWith('/structure-draft/reference') && init?.method === 'DELETE') {
      return new Response(JSON.stringify({ draft: { ...draft(), reference: null, map: { ...draft().map, sections: [] } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).endsWith('/structure-draft')) {
      return new Response(JSON.stringify({ draft: handlers.draft ?? null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).includes('/api/sync/operations')) {
      return new Response(JSON.stringify({ status: 'applied', revision: 4 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const jsonFile = (value: unknown, name = 'papillon-candidates.json') =>
  new File([JSON.stringify(value)], name, { type: 'application/json' });

beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal('indexedDB', new IDBFactory());
  await initializeLocalDatabase();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('载入参考文件后展示 10 段候选，争议段落保持待标注，正式结构未变', async () => {
  const item0 = item();
  cacheRepertoire([item0]);
  mockFetch();
  const seek = vi.fn();
  render(<VocalStructureStudio item={item0} audio={{ ...audioBridge(), seek }} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);

  fireEvent.change(screen.getByLabelText('载入参考文件'), { target: { files: [jsonFile({ schema: 'p040.structure-reference.v1' })] } });

  await waitFor(() => expect(screen.getByText(/已载入参考候选 10 段/)).toBeVisible());
  await waitFor(() => expect(screen.getByRole('group', { name: '结构段落' }).querySelectorAll('button')).toHaveLength(10));
  const chips = within(screen.getByRole('group', { name: '结构段落' })).getAllByRole('button');
  expect(chips).toHaveLength(10);
  expect(screen.getAllByText('待核对', { selector: '.vocal-map__flag' })).toHaveLength(2);
  expect(screen.getAllByText('待标注', { selector: '.vocal-map__type' })).toHaveLength(2);
  // 身份核验属于技术细节：默认收起，展开后仍完整可见。
  const details = screen.getByText('参考与导入（可选）').closest('details');
  expect(details?.open).toBe(false);
  fireEvent.click(screen.getByText('参考与导入（可选）'));
  expect(details?.open).toBe(true);
  expect(screen.getByText(/全部一致/)).toBeVisible();
  expect(screen.getByText(/Refrain \/ Verse/)).toBeVisible();
  // 正式结构仍是两条旧段，没被候选顶掉。
  expect(storedRepertoire().find((entry) => entry.id === 'papillon-1')?.sections).toHaveLength(2);
});

it('点候选定位、整段循环都复用外层播放器，不自己造音频', async () => {
  cacheRepertoire([item()]);
  mockFetch({ draft: draft() });
  const seek = vi.fn();
  const onLoop = vi.fn();
  render(<VocalStructureStudio item={item()} audio={{ ...audioBridge(), seek }} onLoop={onLoop} onClose={() => undefined} onSaved={() => undefined} />);

  const chip = await screen.findByRole('button', { name: /选择 B1，副歌/ });
  fireEvent.click(chip);
  expect(seek).toHaveBeenCalledWith(12180);

  fireEvent.click(screen.getByRole('button', { name: '整段循环' }));
  expect(onLoop).toHaveBeenCalledWith({ startMs: 12180, endMs: 34650 });
  expect(document.querySelector('audio')).toBeNull();
});

it('微调分界点只改一处，撤销后回到原值', async () => {
  cacheRepertoire([item()]);
  mockFetch({ draft: draft() });
  const item0 = item();
  const { rerender } = render(<VocalStructureStudio item={item0} audio={audioBridge()} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);

  fireEvent.click(await screen.findByRole('button', { name: /选择 B1，副歌，0:12 到 0:35/ }));
  const detail = () => screen.getByText(/参考写法：B1 副歌/);
  expect(detail()).toHaveTextContent('12.2s–34.6s');

  fireEvent.click(screen.getByRole('button', { name: '起点 −0.1s' }));
  expect(detail()).toHaveTextContent('12.1s–34.6s');

  fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  expect(screen.getByText(/参考写法：B1 副歌/)).toHaveTextContent('12.2s–34.6s');
  rerender(<VocalStructureStudio item={item0} audio={audioBridge()} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);
});

it('争议段落点选类型才算确认，未点选前不自动定型', async () => {
  cacheRepertoire([item()]);
  mockFetch({ draft: draft() });
  render(<VocalStructureStudio item={item()} audio={audioBridge()} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);

  fireEvent.click(await screen.findByRole('button', { name: /选择 U1，待标注，0:57/ }));
  expect(screen.getByText(/这段在两个来源里写法不同/)).toBeVisible();
  expect(screen.getAllByText('待核对', { selector: '.vocal-map__flag' })).toHaveLength(2);

  fireEvent.click(screen.getByRole('button', { name: '副歌' }));
  expect(screen.getAllByText('待核对', { selector: '.vocal-map__flag' })).toHaveLength(1);
});

it('用户显式保存后才落库，且全部记作 manual', async () => {
  cacheRepertoire([item()]);
  mockFetch({ draft: draft() });
  const onSaved = vi.fn();
  render(<VocalStructureStudio item={item()} audio={audioBridge()} onLoop={() => undefined} onClose={() => undefined} onSaved={onSaved} />);

  await waitFor(() => expect(screen.getByRole('group', { name: '结构段落' }).querySelectorAll('button')).toHaveLength(10));
  fireEvent.click(screen.getByRole('button', { name: '保存为人工结构' }));

  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(10));
  const saved = storedRepertoire().find((entry) => entry.id === 'papillon-1');
  expect(saved?.sections).toHaveLength(10);
  expect(saved?.sections?.every((entry) => entry.source === 'manual')).toBe(true);
  // 争议段保存前没点类型，落库仍是 unknown，不被静默改成副歌。
  expect(saved?.sections?.filter((entry) => entry.type === 'unknown')).toHaveLength(2);
});

it('身份核验不通过时整份拒绝，并把不一致项说清楚', async () => {
  cacheRepertoire([item()]);
  mockFetch({
    load: () => new Response(JSON.stringify({
      error: {
        code: 'IDENTITY_MISMATCH', message: '参考结构核验不通过：歌手/歌名/版本/时长/原音频摘要与本地不一致，已拒绝载入',
        identity: { ok: false, checks: [], blockers: [{ code: 'IDENTITY_ARTIST_MISMATCH', detail: 'artist: 参考=BTS / 本地=石玺彤' }] },
      },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
  });
  render(<VocalStructureStudio item={item()} audio={audioBridge()} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);

  fireEvent.change(screen.getByLabelText('载入参考文件'), { target: { files: [jsonFile({ songTitle: 'Let Go' })] } });

  await waitFor(() => expect(screen.getByText(/已拒绝载入/)).toBeVisible());
  expect(screen.getByText(/参考=BTS \/ 本地=石玺彤/)).toBeVisible();
  // 没有候选被塞进地图，正式结构还是旧的两段。
  expect(within(screen.getByRole('group', { name: '结构段落' })).getAllByRole('button')).toHaveLength(2);
});

/**
 * 重复关系标题必须反映真实状态：
 * 只有 `repeatOf` + 具体 `repetition` 才算「已确认」；候选 `repeatCandidateOf` 只是提示，不得显示成确认。
 */
it('确认前标题只说待确认，候选 repeatCandidateOf 不会被当成已确认', async () => {
  cacheRepertoire([item()]);
  const candidate = draft();
  candidate.map.sections = candidate.map.sections.map((entry) => (
    entry.id === 'ref-6' ? { ...entry, repeatCandidateOf: 'ref-2' } : entry
  ));
  mockFetch({ draft: candidate });
  render(<VocalStructureStudio item={item()} audio={audioBridge()} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);

  fireEvent.click(await screen.findByRole('button', { name: /选择 B2，副歌/ }));

  expect(screen.getByText('与上一段 B1 的重复关系（待确认）')).toBeVisible();
  expect(screen.queryByText(/已确认/)).toBeNull();
  expect(screen.getByRole('button', { name: '同词重复' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: '旋律同、换词' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: '不重复' })).toBeDisabled();
});

it('点「旋律同、换词」后标题改为已确认，点「不重复」回到待确认', async () => {
  cacheRepertoire([item()]);
  mockFetch({ draft: draft() });
  render(<VocalStructureStudio item={item()} audio={audioBridge()} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);

  fireEvent.click(await screen.findByRole('button', { name: /选择 B2，副歌/ }));
  fireEvent.click(screen.getByRole('button', { name: '旋律同、换词' }));

  expect(screen.getByText('与 B1 的重复关系（已确认：旋律同、换词）')).toBeVisible();
  expect(screen.getByRole('button', { name: '旋律同、换词' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: '同词重复' })).toHaveAttribute('aria-pressed', 'false');

  fireEvent.click(screen.getByRole('button', { name: '不重复' }));

  expect(screen.getByText('与上一段 B1 的重复关系（待确认）')).toBeVisible();
  expect(screen.getByRole('button', { name: '旋律同、换词' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: '不重复' })).toBeDisabled();
});

it('确认并保存后重新载入，标题仍显示已确认而不是待确认', async () => {  cacheRepertoire([item()]);
  mockFetch({ draft: draft() });
  const onSaved = vi.fn();
  const { unmount } = render(<VocalStructureStudio item={item()} audio={audioBridge()} onLoop={() => undefined} onClose={() => undefined} onSaved={onSaved} />);

  fireEvent.click(await screen.findByRole('button', { name: /选择 B2，副歌/ }));
  fireEvent.click(screen.getByRole('button', { name: '旋律同、换词' }));
  fireEvent.click(screen.getByRole('button', { name: '保存为人工结构' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(10));

  const saved = storedRepertoire().find((entry) => entry.id === 'papillon-1');
  const savedB2 = saved?.sections?.find((entry) => entry.label === 'B2');
  expect(savedB2?.repeatOf).toBe('ref-2');
  expect(savedB2?.repetition).toBe('same-melody-new-lyrics');
  unmount();

  // 重新载入：模拟下次打开工作室，正式结构里已经带着确认过的关系。
  mockFetch({ draft: null });
  render(<VocalStructureStudio item={item({ sections: saved?.sections ?? [] })} audio={audioBridge()} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);
  fireEvent.click(await screen.findByRole('button', { name: /选择 B2，副歌/ }));

  expect(screen.getByText('与 B1 的重复关系（已确认：旋律同、换词）')).toBeVisible();
  expect(screen.getByRole('button', { name: '旋律同、换词' })).toHaveAttribute('aria-pressed', 'true');
});

/**
 * 2026-10-31 用户反馈：进地图后「信息乱七八糟，不知道要干什么」。
 * 这一组守住新的信息层次：只留一套标题与关闭、四步顺序、试听直达段首、技术说明默认收起、保存栏常驻。
 */
it('抽屉里只有一套标题和关闭，并按「选段→试听→调整→保存」排布', async () => {
  cacheRepertoire([item()]);
  mockFetch({ draft: draft() });
  render(<VocalStructureStudio presentation="drawer" item={item()} audio={audioBridge()} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);

  await screen.findByRole('heading', { name: '歌曲分段' });
  // 标题先出现、草稿后到；不等一下就会读到「正在读取…」（旧用例的既有竞态，顺手修掉）。
  await waitFor(() => expect(document.querySelector('.vocal-map__sub')?.textContent).toContain('10 段'));
  // 不再出现第二个标题、第二个关闭按钮
  expect(screen.queryByRole('heading', { name: '结构工作室' })).toBeNull();
  expect(screen.queryByRole('heading', { name: '地图' })).toBeNull();
  expect(screen.getAllByRole('button', { name: /关闭/ })).toHaveLength(1);
  // 四步按顺序出现，且首屏先讲分段
  const labels = Array.from(document.querySelectorAll('.vocal-map__steplabel')).map((node) => node.textContent);
  expect(labels).toEqual(['1选一段', '2试听这一段', '3调整边界和类型']);
  expect(document.querySelector('.vocal-map__sub')?.textContent).toContain('10 段');
  // 保存栏常驻且是唯一的显式保存入口
  expect(screen.getAllByRole('button', { name: '保存为人工结构' })).toHaveLength(1);
});

it('点「试听」从选中段段首开始，而不是从当前播放位置', async () => {
  cacheRepertoire([item()]);
  mockFetch({ draft: draft() });
  const seek = vi.fn();
  render(<VocalStructureStudio item={item()} audio={{ ...audioBridge(), timeMs: 60000, seek }} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);

  fireEvent.click(await screen.findByRole('button', { name: /选择 B2，副歌/ }));
  fireEvent.click(screen.getByRole('button', { name: '▶ 试听' }));
  expect(seek).toHaveBeenCalledWith(79870, true);
});

it('循环状态如实显示：选中段循环时给「停止循环」，退出后回到「整段循环」', async () => {
  cacheRepertoire([item()]);
  mockFetch({ draft: draft() });
  const onLoop = vi.fn();
  render(<VocalStructureStudio item={item()} audio={audioBridge()} onLoop={onLoop} onClose={() => undefined} onSaved={() => undefined} />);

  fireEvent.click(await screen.findByRole('button', { name: /选择 B2，副歌/ }));
  fireEvent.click(screen.getByRole('button', { name: '整段循环' }));
  expect(onLoop).toHaveBeenLastCalledWith({ startMs: 79870, endMs: 103260 });
  expect(screen.getByText(/循环中/)).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: '停止循环' }));
  expect(onLoop).toHaveBeenLastCalledWith(null);
  expect(screen.getByRole('button', { name: '整段循环' })).toBeVisible();
});

it('删掉最后一段后没有选中段，仍能用同屏「撤销」退回', async () => {
  cacheRepertoire([item()]);
  mockFetch({ draft: null });
  render(<VocalStructureStudio item={item({ sections: [section({ id: 'only', type: 'intro', label: '前奏', startMs: 0, endMs: 12000 })] })} audio={audioBridge()} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);

  fireEvent.click(await screen.findByRole('button', { name: /选择 前奏/ }));
  fireEvent.click(screen.getByRole('button', { name: '删除这一段' }));
  expect(screen.getByText(/还没有段落/)).toBeVisible();

  const undo = screen.getByRole('button', { name: '撤销' });
  expect(undo).toBeEnabled();
  fireEvent.click(undo);
  expect(within(screen.getByRole('group', { name: '结构段落' })).getAllByRole('button')).toHaveLength(1);
});

it('参考候选与正式结构的切换仍在（收在「参考与导入」里），切换不写库', async () => {
  const item0 = item();
  cacheRepertoire([item0]);
  mockFetch({ draft: draft() });
  render(<VocalStructureStudio item={item0} audio={audioBridge()} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);

  await waitFor(() => expect(within(screen.getByRole('group', { name: '结构段落' })).getAllByRole('button')).toHaveLength(10));
  fireEvent.click(screen.getByText('参考与导入（可选）'));
  fireEvent.click(screen.getByRole('button', { name: '当前正式结构' }));

  const chips = within(screen.getByRole('group', { name: '结构段落' })).getAllByRole('button');
  expect(chips).toHaveLength(2);
  expect(document.querySelector('.vocal-map__sub')?.textContent).toContain('当前正式结构');
  expect(storedRepertoire().find((entry) => entry.id === 'papillon-1')?.sections).toHaveLength(2);
});

/**
 * 2026-10-31 真机问题（QA evidence-2026-10-31-prototype-phone-v114）：
 * 播放器停在 0:49 主歌时打开地图，默认选中的却是前奏，状态不一致。
 * 下面这组守住：打开/切换数据时按当前位置选段、无匹配不硬选、手动选段不被覆盖、只读不 seek。
 */
const QA_SECTIONS: VocalSection[] = [
  section({ id: 'qa-1', type: 'intro', label: '前奏', startMs: 0, endMs: 16000 }),
  section({ id: 'qa-2', type: 'verse', label: 'A1', startMs: 16000, endMs: 79000 }),
];

const chip = (name: RegExp) => screen.getByRole('button', { name });

it('打开地图时按当前位置选中相应段（0:49 → A1 主歌），且不触发播放或跳转', async () => {
  cacheRepertoire([item({ sections: QA_SECTIONS })]);
  mockFetch({ draft: null });
  const seek = vi.fn();
  render(<VocalStructureStudio presentation="drawer" item={item({ sections: QA_SECTIONS })} audio={{ ...audioBridge(), timeMs: 49000, seek }} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);

  // 等首次读取草稿结束，确认是「读取完成后」也按位置选，而不是退回第一段。
  await waitFor(() => expect(screen.queryByText('正在读取…')).toBeNull());
  expect(chip(/选择 A1，主歌/)).toHaveAttribute('aria-pressed', 'true');
  expect(chip(/选择 前奏/)).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByText(/A1 · 主歌/)).toBeVisible();
  expect(seek).not.toHaveBeenCalled();
});

it('播放中打开地图同样按位置选段（0:40 → A1），不影响播放状态', async () => {
  cacheRepertoire([item({ sections: QA_SECTIONS })]);
  mockFetch({ draft: null });
  const toggle = vi.fn();
  render(<VocalStructureStudio presentation="drawer" item={item({ sections: QA_SECTIONS })} audio={{ ...audioBridge(), timeMs: 40000, playing: true, toggle }} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);

  await waitFor(() => expect(screen.queryByText('正在读取…')).toBeNull());
  expect(chip(/选择 A1，主歌/)).toHaveAttribute('aria-pressed', 'true');
  expect(toggle).not.toHaveBeenCalled();
});

it('位置变化不会覆盖用户手动选段', async () => {
  cacheRepertoire([item({ sections: QA_SECTIONS })]);
  mockFetch({ draft: null });
  const seek = vi.fn();
  const view = render(<VocalStructureStudio presentation="drawer" item={item({ sections: QA_SECTIONS })} audio={{ ...audioBridge(), timeMs: 40000, seek }} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);

  await waitFor(() => expect(screen.queryByText('正在读取…')).toBeNull());
  expect(chip(/选择 A1，主歌/)).toHaveAttribute('aria-pressed', 'true');

  fireEvent.click(chip(/选择 前奏/));
  expect(seek).toHaveBeenCalledWith(0);
  expect(chip(/选择 前奏/)).toHaveAttribute('aria-pressed', 'true');

  // 播放位置继续前进（模拟 timeupdate 引起的重渲染），手动选择必须保住。
  view.rerender(<VocalStructureStudio presentation="drawer" item={item({ sections: QA_SECTIONS })} audio={{ ...audioBridge(), timeMs: 60000, playing: true, seek }} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);
  expect(chip(/选择 前奏/)).toHaveAttribute('aria-pressed', 'true');
  expect(chip(/选择 A1，主歌/)).toHaveAttribute('aria-pressed', 'false');
  expect(seek).toHaveBeenCalledTimes(1);
});

it('位置不落在任何一段里时不硬选，明确说明后可手动选段', async () => {
  cacheRepertoire([item({ sections: QA_SECTIONS })]);
  mockFetch({ draft: null });
  const seek = vi.fn();
  render(<VocalStructureStudio presentation="drawer" item={item({ sections: QA_SECTIONS })} audio={{ ...audioBridge(), timeMs: DURATION + 2000, seek }} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);

  await waitFor(() => expect(screen.queryByText('正在读取…')).toBeNull());
  const chips = within(screen.getByRole('group', { name: '结构段落' })).getAllByRole('button');
  expect(chips.every((node) => node.getAttribute('aria-pressed') === 'false')).toBe(true);
  expect(screen.getByText(/不在任何一段内/)).toBeVisible();
  // 没选中就不显示第 ②③ 步，避免对着错误段落试听或调边界。
  expect(screen.queryByText('试听这一段', { selector: '.vocal-map__steplabel' })).toBeNull();

  fireEvent.click(chip(/选择 A1，主歌/));
  expect(chip(/选择 A1，主歌/)).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByText(/不在任何一段内/)).toBeNull();
});

it('载入参考候选后按当前位置选段，而不是退回第一段', async () => {
  cacheRepertoire([item({ sections: QA_SECTIONS })]);
  mockFetch();
  const seek = vi.fn();
  render(<VocalStructureStudio presentation="drawer" item={item({ sections: QA_SECTIONS })} audio={{ ...audioBridge(), timeMs: 60000, seek }} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);

  await waitFor(() => expect(screen.queryByText('正在读取…')).toBeNull());
  fireEvent.change(screen.getByLabelText('载入参考文件'), { target: { files: [jsonFile({ schema: 'p040.structure-reference.v1' })] } });

  await waitFor(() => expect(screen.getByText(/已载入参考候选 10 段/)).toBeVisible());
  expect(chip(/选择 U1，待标注，0:57/)).toHaveAttribute('aria-pressed', 'true');
  expect(chip(/选择 前奏，前奏/)).toHaveAttribute('aria-pressed', 'false');
  expect(seek).not.toHaveBeenCalled();
});

it('还没有任何段落时保持空态，不自动编造选中段', async () => {
  cacheRepertoire([item({ sections: [] })]);
  mockFetch({ draft: null });
  render(<VocalStructureStudio presentation="drawer" item={item({ sections: [] })} audio={{ ...audioBridge(), timeMs: 49000 }} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);

  await waitFor(() => expect(screen.queryByText('正在读取…')).toBeNull());
  expect(screen.getByText(/这首歌还没有段落/)).toBeVisible();
  expect(screen.queryByRole('group', { name: '结构段落' })).toBeNull();
  expect(screen.queryByText(/不在任何一段内/)).toBeNull();
});

/**
 * P040 V1.3 R2 §5：手机上「Rap 拖不动」的回归用例。
 * 旧实现按「时长的 1.5%」判命中（195 秒的歌在 360px 屏上只有 ±5px），
 * 现在改成屏幕像素：±24px 内算按住分界线，超出就只当定位。
 */
const stubWave = (width = 1000): void => {
  const rect = { left: 0, top: 0, right: width, bottom: 96, width, height: 96, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue(rect);
};

const waveSvg = (): SVGSVGElement => {
  const svg = document.querySelector('.vocal-wave');
  if (!svg) throw new Error('波形没渲染出来');
  return svg as SVGSVGElement;
};

/**
 * jsdom 没有 PointerEvent：用 MouseEvent 带上 pointerId 手工构造，
 * 这样 clientX 才是真的（否则命中判定拿到 NaN，测出来的是假绿）。
 */
const pointer = (type: string, clientX: number, pointerId = 7): MouseEvent => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 40 });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  return event;
};

it('分界线 ±24px 内按下并拖动，分界时间真的跟着变（旧实现这里会落空成 seek）', async () => {
  cacheRepertoire([item()]);
  mockFetch({ draft: draft() });
  stubWave();
  const seek = vi.fn();
  render(<VocalStructureStudio item={item()} audio={{ ...audioBridge(), seek }} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);

  await waitFor(() => expect(screen.getByRole('group', { name: '结构段落' }).querySelectorAll('button')).toHaveLength(10));
  const svg = waveSvg();
  // 12180ms 的分界在 1000px 宽的波形上约 62px：手指按在 70px 只差 8px。
  expect(svg.querySelector('[data-testid="boundary-12180"]')).not.toBeNull();

  fireEvent(svg, pointer('pointerdown', 70, 7));
  fireEvent(svg, pointer('pointermove', 120, 7));
  fireEvent(svg, pointer('pointerup', 120, 7));

  // 120px → 23404ms：B1 的起点被拖到 0:23，而不是把播放位置跳过去。
  expect(screen.getByRole('button', { name: /选择 B1，副歌，0:23 到 0:35/ })).toBeVisible();
  expect(svg.querySelector('[data-testid="boundary-12180"]')).toBeNull();
  expect(seek).not.toHaveBeenCalled();
});

it('离分界线超过 24px 时只定位不拖动，分界时间不变', async () => {
  cacheRepertoire([item()]);
  mockFetch({ draft: draft() });
  stubWave();
  const seek = vi.fn();
  render(<VocalStructureStudio item={item()} audio={{ ...audioBridge(), seek }} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);

  await waitFor(() => expect(screen.getByRole('group', { name: '结构段落' }).querySelectorAll('button')).toHaveLength(10));
  const svg = waveSvg();
  // 250px → 48759ms，离最近的分界（177px）还有 72px，属于「只想听这里」。
  fireEvent(svg, pointer('pointerdown', 250, 9));
  fireEvent(svg, pointer('pointermove', 400, 9));
  fireEvent(svg, pointer('pointerup', 400, 9));

  expect(seek).toHaveBeenCalledWith(48759);
  expect(svg.querySelector('[data-testid="boundary-12180"]')).not.toBeNull();
  expect(screen.getByRole('button', { name: /选择 B1，副歌，0:12 到 0:35/ })).toBeVisible();
});

it('±0.5s 微调按钮真实改变起点/终点，且都能撤销', async () => {
  cacheRepertoire([item()]);
  mockFetch({ draft: draft() });
  render(<VocalStructureStudio item={item()} audio={audioBridge()} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);

  fireEvent.click(await screen.findByRole('button', { name: /选择 B1，副歌，0:12 到 0:35/ }));
  const svg = waveSvg();
  expect(svg.querySelector('[data-testid="boundary-12180"]')).not.toBeNull();
  expect(svg.querySelector('[data-testid="boundary-34650"]')).not.toBeNull();

  fireEvent.click(screen.getByRole('button', { name: '起点 −0.5s' }));
  expect(svg.querySelector('[data-testid="boundary-11680"]')).not.toBeNull();
  expect(screen.getByText(/参考写法：B1 副歌/)).toHaveTextContent('11.7s–34.6s');

  fireEvent.click(screen.getByRole('button', { name: '起点 +0.5s' }));
  expect(svg.querySelector('[data-testid="boundary-12180"]')).not.toBeNull();

  fireEvent.click(screen.getByRole('button', { name: '终点 −0.5s' }));
  expect(svg.querySelector('[data-testid="boundary-34150"]')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '终点 +0.5s' }));
  expect(svg.querySelector('[data-testid="boundary-34650"]')).not.toBeNull();

  // 微调同样进撤销栈：连点三次后撤销一步，只回退最后一次。
  fireEvent.click(screen.getByRole('button', { name: '终点 +0.5s' }));
  expect(svg.querySelector('[data-testid="boundary-35150"]')).not.toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: '撤销' })[0]);
  expect(svg.querySelector('[data-testid="boundary-34650"]')).not.toBeNull();
});

it('Rap 确认后保存 payload 带确认标记，重开地图仍然有效', async () => {
  cacheRepertoire([item()]);
  mockFetch({ draft: draft() });
  const onSaved = vi.fn();
  const { unmount } = render(<VocalStructureStudio item={item()} audio={audioBridge()} onLoop={() => undefined} onClose={() => undefined} onSaved={onSaved} />);

  // 先等参考草稿替换掉正式结构的两段，否则点到的是马上会被换掉的旧节点。
  await waitFor(() => expect(screen.getByRole('group', { name: '结构段落' }).querySelectorAll('button')).toHaveLength(10));
  fireEvent.click(screen.getByRole('button', { name: /选择 U1，待标注，0:57/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Rap' }));
  // 只改类型不算确认：这里必须先明确说明，避免用户以为已经能跳过。
  expect(screen.getByText(/还没确认：只改类型不算数/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '确认这段是 Rap（可跳过）' }));
  expect(screen.getByText(/已确认这一段是 Rap/)).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: '保存为人工结构' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(10));

  const saved = storedRepertoire().find((entry) => entry.id === 'papillon-1');
  const savedRap = saved?.sections?.filter((entry) => entry.type === 'rap') ?? [];
  expect(savedRap).toHaveLength(1);
  expect(savedRap[0]?.rapApproved).toBe(true);
  // 未确认的段绝不能带上确认标记。
  expect(saved?.sections?.filter((entry) => entry.rapApproved === true)).toHaveLength(1);
  unmount();

  mockFetch({ draft: null });
  render(<VocalStructureStudio item={item({ sections: saved?.sections ?? [] })} audio={audioBridge()} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);
  fireEvent.click(await screen.findByRole('button', { name: /选择 R1，Rap/ }));
  expect(screen.getByText(/已确认这一段是 Rap/)).toBeVisible();
  expect(screen.getByRole('button', { name: '确认这段是 Rap（可跳过）' })).toBeDisabled();
});
