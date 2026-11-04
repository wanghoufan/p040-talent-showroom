import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { initializeLocalDatabase } from '../../src/lib/local-database';
import { cacheRepertoire, storedRepertoire } from '../../src/lib/repertoire-store';
import VocalPracticePlayer from '../../src/components/VocalPracticePlayer';
import VocalStructureStudio from '../../src/components/VocalStructureStudio';
import TalentLibraryPage from '../../src/pages/TalentLibraryPage';
import App from '../../src/app/App';
import type { TalentItem, TimedLyric, VocalSection } from '../../src/lib/types';

/**
 * V1.2 沉浸练歌 + 地图抽屉 + 内置参考（P040）。
 * 只验证界面行为：不用选文件就能载入本机参考、沉浸/抽屉切换复用同一播放器、
 * BABE 类空结构从零打点、歌词行定界。
 * 不播放声音、不连真实库、不跑分析、不碰真实音频。
 */

const DURATION = 193328;
const line = (startMs: number, text: string): TimedLyric => ({ id: `l-${startMs}`, startMs, text });
const section = (input: Partial<VocalSection> & Pick<VocalSection, 'id'>): VocalSection =>
  ({ type: 'verse', label: input.id, startMs: 0, endMs: 1000, source: 'manual', ...input });

const babe = (extra: Partial<TalentItem> = {}): TalentItem => ({
  id: 'babe-1', kind: 'VOCAL', title: '베베 (BABE)', artist: '泫雅', learningStatus: 'PRACTICING',
  originalKey: 'C', performanceKey: 'C', capo: 0, scoreText: '', notes: '', audioRole: 'REFERENCE', durationMs: DURATION,
  lyrics: [line(0, '첫 소절'), line(35200, '둘째 소절'), line(70000, '셋째 소절')],
  sections: [], ...extra,
} as TalentItem);

const papillon = (extra: Partial<TalentItem> = {}): TalentItem => ({
  id: 'papillon-1', kind: 'VOCAL', title: 'Papillon', artist: '王嘉尔', learningStatus: 'PRACTICING',
  originalKey: 'C', performanceKey: 'C', capo: 0, scoreText: '', notes: '', audioRole: 'REFERENCE', durationMs: 195036,
  lyrics: [line(12180, 'Yeh'), line(34650, 'You got me feeling like a'), line(57150, 'Papillon')],
  sections: [
    section({ id: 'old-1', type: 'intro', label: '前奏', startMs: 0, endMs: 12000 }),
    section({ id: 'old-2', type: 'unknown', label: 'U1', startMs: 12000, endMs: 195036 }),
  ], ...extra,
} as TalentItem);

const CATALOG_ENTRY = {
  id: 'papillon-jackson-wang-studio', songTitle: 'Papillon', artist: 'Jackson Wang', version: 'studio',
  candidateCount: 10, disputedCount: 2, source: 'P040-Structure-Source-Validation-2026-10-31',
  note: '非官方标注', relevant: true,
  identity: {
    ok: true,
    checks: [
      { id: 'title', ok: true, expected: 'Papillon', actual: 'Papillon' },
      { id: 'artist', ok: true, expected: 'Jackson Wang', actual: '王嘉尔' },
      { id: 'version', ok: true, expected: '(无版本标记)', actual: '(无版本标记)' },
      { id: 'duration', ok: true, expected: '195036ms', actual: '195036ms' },
      { id: 'audioSha256', ok: true, expected: '0573…', actual: '0573…' },
    ],
    blockers: [],
  },
};

/** 10 段候选（服务端吸附 LRC 后的形状）——只用于界面渲染断言。 */
const CANDIDATES = [0, 12180, 34650, 57150, 68560, 79870, 103260, 125290, 136400, 147450].map((startMs, index, list) => ({
  id: `ref-${index + 1}`, code: `S${index + 1}`, type: index === 3 || index === 7 ? 'unknown' : 'chorus',
  source: 'reference', startMs, endMs: list[index + 1] ?? 195036,
  referenceLabel: `候选 ${index + 1}`, disputed: index === 3 || index === 7,
  alternates: index === 3 || index === 7 ? ['refrain', 'verse'] : [],
  anchor: { lineId: null, deltaMs: 0, snapped: true },
  repeatCandidateOf: null,
}));

const draft = () => ({
  songId: 'papillon-1', state: 'DRAFT', generatedAt: '2026-10-31T05:00:00Z', modelName: 'reference-draft',
  modelVersion: 'draft', baseRevision: 3, appliedRevision: null, legacySectionCount: 2, currentSectionCount: 2,
  summary: { sections: 10, pendingTypes: 2, typeCandidates: 0, pendingRelations: 0, pendingMerges: 0, uncovered: 0, needsReview: true },
  timing: null, separation: null,
  reference: {
    songTitle: 'Papillon', artist: 'Jackson Wang', version: 'studio', source: CATALOG_ENTRY.source,
    note: CATALOG_ENTRY.note, audioSha256: '0'.repeat(64), audioDurationMs: 195036, status: 'DRAFT_REVIEW_REQUIRED',
    identity: CATALOG_ENTRY.identity, candidateCount: 10, disputedCount: 2, unsnappedCount: 0,
    loadedAt: '2026-10-31T05:00:00Z', warnings: ['REFERENCE_DISPUTED_TYPES'], sections: CANDIDATES,
  },
  map: {
    schema: 'p040.song-map.v1', songId: 'papillon-1', durationMs: 195036, status: 'draft',
    warnings: [], relationCandidates: [], mergeCandidates: [], unassigned: [], sections: CANDIDATES,
  },
});

function mockFetch(options: { catalog?: unknown[]; draft?: unknown } = {}) {
  const calls: string[] = [];
  /** 载入成功后 GET 草稿要能读回同一份；静态 mock 也要保持这个先后关系。 */
  let loaded = Boolean(options.draft);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
    if (String(url).includes('/structure-waveform')) {
      return new Response(JSON.stringify({ error: { code: 'FFMPEG_UNAVAILABLE', message: '没有 ffmpeg' } }), { status: 503 });
    }
    if (String(url).endsWith('/structure-draft/reference/catalog') && (init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify({ entries: options.catalog ?? [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).endsWith('/structure-draft/reference/catalog') && init?.method === 'POST') {
      loaded = true;
      return new Response(JSON.stringify({ draft: draft(), identity: CATALOG_ENTRY.identity }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).endsWith('/structure-draft')) {
      return new Response(JSON.stringify({ draft: loaded ? draft() : null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).includes('/api/sync/operations')) {
      return new Response(JSON.stringify({ status: 'applied', revision: 4 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }));
  return calls;
}

const audioBridge = (timeMs = 0) => ({ timeMs, playing: false, seek: vi.fn(), toggle: vi.fn() });

beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal('indexedDB', new IDBFactory());
  await initializeLocalDatabase();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });

it('练歌页直接显示本机 Papillon 参考，点一下就载入，不需要选文件', async () => {
  cacheRepertoire([papillon()]);
  const calls = mockFetch({ catalog: [CATALOG_ENTRY] });
  render(<VocalPracticePlayer item={papillon()} />);

  await waitFor(() => expect(screen.getByText(/本机已有《Papillon》参考候选 10 段/)).toBeVisible());
  expect(screen.getByText(/身份五项已核对一致/)).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: '载入参考候选' }));

  await waitFor(() => expect(screen.getByRole('dialog', { name: '结构工作室' })).toBeVisible());
  await waitFor(() => expect(within(screen.getByRole('group', { name: '结构段落' })).getAllByRole('button')).toHaveLength(10));
  expect(calls.some((call) => call === 'POST /api/repertoire/papillon-1/structure-draft/reference/catalog')).toBe(true);
  expect(calls.some((call) => call.startsWith('POST /api/repertoire/papillon-1/structure-draft/reference'))).toBe(true);
  expect(calls.some((call) => call.startsWith('PUT') || call.startsWith('POST /api/sync/operations'))).toBe(false);
});

it('沉浸练歌不复制播放器；地图收进抽屉，可进可退', () => {
  cacheRepertoire([babe({ sections: [section({ id: 's1', type: 'verse', label: 'A1', startMs: 0, endMs: DURATION })] })]);
  mockFetch();
  const { container } = render(<VocalPracticePlayer item={babe({ sections: [section({ id: 's1', type: 'verse', label: 'A1', startMs: 0, endMs: DURATION })] })} />);

  fireEvent.click(screen.getByRole('button', { name: '沉浸练歌' }));
  const root = container.querySelector('.vocal-practice');
  expect(root?.className).toContain('is-immersive');
  expect(screen.getByRole('button', { name: '退出沉浸' })).toBeVisible();
  // 只有一个 audio 元素：沉浸只是换呈现，没有重造播放器。
  expect(document.querySelectorAll('audio')).toHaveLength(1);

  // 顶栏按原型只留「后退 / 分段 / 更多」，地图从「更多」进，不再与歌名抢位置
  fireEvent.click(screen.getByRole('button', { name: '更多' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: '更多' })).getByRole('button', { name: '地图与结构' }));
  const drawer = screen.getByRole('dialog', { name: '地图抽屉' });
  expect(drawer).toBeVisible();
  expect(within(drawer).getByRole('button', { name: '播放位置打点' })).toBeVisible();

  fireEvent.click(within(drawer).getByRole('button', { name: '关闭地图抽屉' }));
  expect(screen.queryByRole('dialog', { name: '地图抽屉' })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '退出沉浸' }));
  expect(root?.className).not.toContain('is-immersive');
});

it('BABE 真正空结构：从零打点两段并保存为人工结构', async () => {
  cacheRepertoire([babe()]);
  mockFetch();
  const onSaved = vi.fn();
  render(
    <VocalStructureStudio
      item={babe()}
      audio={audioBridge(35200)}
      onLoop={() => undefined}
      onClose={() => undefined}
      onSaved={onSaved}
    />,
  );

  await waitFor(() => expect(screen.getByText(/还没有段落/)).toBeVisible());
  fireEvent.click(screen.getByRole('button', { name: '播放位置打点' }));
  expect(within(screen.getByRole('group', { name: '结构段落' })).getAllByRole('button')).toHaveLength(1);

  // 再打一次同一个播放位置：切开刚建的段，形成两段，验证空状态可继续生长。
  fireEvent.click(screen.getByRole('button', { name: '播放位置打点' }));
  expect(within(screen.getByRole('group', { name: '结构段落' })).getAllByRole('button')).toHaveLength(2);

  fireEvent.click(screen.getByRole('button', { name: '保存为人工结构' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(2));
  const saved = storedRepertoire().find((entry) => entry.id === 'babe-1')?.sections ?? [];
  expect(saved).toHaveLength(2);
  expect(saved.every((entry) => entry.source === 'manual')).toBe(true);
  expect(saved.some((entry) => entry.type === 'chorus')).toBe(false);
});

it('歌词行定界：分界点吸附到 1.5 秒内最近的歌词行首', async () => {
  const item = babe({
    lyrics: [line(0, '一'), line(35000, '二'), line(70000, '三')],
    sections: [
      section({ id: 'a', type: 'verse', label: 'A1', startMs: 0, endMs: 35200 }),
      section({ id: 'b', type: 'chorus', label: 'B1', startMs: 35200, endMs: DURATION }),
    ],
  });
  cacheRepertoire([item]);
  mockFetch();
  render(<VocalStructureStudio item={item} audio={audioBridge()} onLoop={() => undefined} onClose={() => undefined} onSaved={() => undefined} />);

  fireEvent.click(await screen.findByRole('button', { name: /选择 B1/ }));
  expect(screen.getByText(/35\.2s–193\.3s/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '分界对齐歌词行' }));
  expect(screen.getByText(/35\.0s–193\.3s/)).toBeVisible();
});

it('唱歌曲库点歌直达沉浸；吉他仍进详情页', async () => {
  const vocalItem = babe();
  const guitarItem = { ...babe(), id: 'guitar-1', title: '吉他曲', kind: 'GUITAR' as const } as TalentItem;
  cacheRepertoire([vocalItem, guitarItem]);
  mockFetch();

  const vocalView = render(
    <MemoryRouter initialEntries={['/repertoire/vocal']}>
      <Routes><Route path="/repertoire/:kind" element={<TalentLibraryPage />} /></Routes>
    </MemoryRouter>,
  );
  const vocalLink = await screen.findByRole('link', { name: '查看 베베 (BABE)' });
  expect(vocalLink).toHaveAttribute('href', '/repertoire/item/babe-1?immersive=1');
  vocalView.unmount();

  render(
    <MemoryRouter initialEntries={['/repertoire/guitar']}>
      <Routes><Route path="/repertoire/:kind" element={<TalentLibraryPage />} /></Routes>
    </MemoryRouter>,
  );
  const guitarLink = await screen.findByRole('link', { name: '查看 吉他曲' });
  expect(guitarLink).toHaveAttribute('href', '/repertoire/item/guitar-1');
});

it('直链沉浸：一进来就是沉浸，返回走曲库，抽屉里能回详情，都不复制播放器', () => {
  cacheRepertoire([babe()]);
  mockFetch();
  window.history.replaceState({}, '', '/repertoire/item/babe-1?immersive=1');
  const onExitToLibrary = vi.fn();
  const onOpenDetail = vi.fn();
  const { container } = render(
    <VocalPracticePlayer item={babe()} onExitToLibrary={onExitToLibrary} onOpenDetail={onOpenDetail} />,
  );

  const root = container.querySelector('.vocal-practice');
  expect(root?.className).toContain('is-immersive');
  expect(document.querySelectorAll('audio')).toHaveLength(1);

  fireEvent.click(screen.getByRole('button', { name: '返回曲库' }));
  expect(onExitToLibrary).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole('button', { name: '更多' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: '更多' })).getByRole('button', { name: '地图与结构' }));
  const drawer = screen.getByRole('dialog', { name: '地图抽屉' });
  fireEvent.click(within(drawer).getByRole('button', { name: '曲目详情' }));
  expect(onOpenDetail).toHaveBeenCalledTimes(1);
  expect(root?.className).not.toContain('is-immersive');
  expect(document.querySelectorAll('audio')).toHaveLength(1);
});

it('真实路由：直链一进来就是沉浸，点返回落到唱歌曲库', async () => {
  cacheRepertoire([babe()]);
  mockFetch();
  window.history.replaceState({}, '', '/repertoire/item/babe-1?immersive=1');
  const { container } = render(
    <MemoryRouter initialEntries={['/repertoire/item/babe-1?immersive=1']}><App /></MemoryRouter>,
  );

  await waitFor(() => expect(container.querySelector('.vocal-practice')).not.toBeNull());
  expect(container.querySelector('.vocal-practice')?.className).toContain('is-immersive');
  // 详情页的封面/标题被沉浸层覆盖前仍在 DOM，但沉浸层只有一套播放器
  expect(document.querySelectorAll('audio')).toHaveLength(1);

  fireEvent.click(screen.getByRole('button', { name: '返回曲库' }));
  const returned = await screen.findByRole('link', { name: '查看 베베 (BABE)' });
  expect(returned).toHaveAttribute('href', '/repertoire/item/babe-1?immersive=1');
  expect(container.querySelector('.vocal-practice')).toBeNull();
});
