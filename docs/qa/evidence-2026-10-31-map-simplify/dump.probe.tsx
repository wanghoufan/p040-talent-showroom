import { writeFileSync } from 'node:fs';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { initializeLocalDatabase } from '../../src/lib/local-database';
import { cacheRepertoire } from '../../src/lib/repertoire-store';
import VocalPracticePlayer from '../../src/components/VocalPracticePlayer';
import VocalStructureStudio from '../../src/components/VocalStructureStudio';
import type { TalentItem, TimedLyric, VocalSection } from '../../src/lib/types';

/** 只读探针：渲染真实播放器 → 沉浸 → 地图抽屉 → 落盘 DOM，供 headless Chrome 量版式。 */

const DURATION = 195036;
const OUT = '/Users/zzymima0000/Developer/coding/1.Active/040-ing-才艺展示厅/.local/map-probe';

const line = (startMs: number, text: string): TimedLyric => ({ id: `l-${startMs}`, startMs, text });
const section = (input: Partial<VocalSection> & Pick<VocalSection, 'id'>): VocalSection =>
  ({ type: 'verse', label: input.id, startMs: 0, endMs: 1000, source: 'manual', ...input });

const song = (extra: Partial<TalentItem> = {}): TalentItem => ({
  id: 'papillon-1', kind: 'VOCAL', title: 'Papillon', artist: '王嘉尔', learningStatus: 'PRACTICING',
  originalKey: 'C', performanceKey: 'C', capo: 0, scoreText: '', notes: '', audioRole: 'REFERENCE', durationMs: DURATION,
  lyrics: [line(12180, 'Yeh'), line(34650, 'You got me feeling like a'), line(57150, 'Papillon')],
  sections: [
    section({ id: 'old-1', type: 'intro', label: '前奏', startMs: 0, endMs: 12000 }),
    section({ id: 'old-2', type: 'unknown', label: 'U1', startMs: 12000, endMs: DURATION }),
  ], ...extra,
} as TalentItem);

const STARTS = [0, 12180, 34650, 57150, 68560, 79870, 103260, 125290, 136400, 147450];
const TYPES = ['intro', 'chorus', 'verse', 'unknown', 'pre', 'chorus', 'verse', 'unknown', 'pre', 'chorus'];
const CANDIDATES = STARTS.map((startMs, index) => ({
  id: `ref-${index + 1}`, code: `S${index + 1}`, type: TYPES[index],
  source: 'reference', startMs, endMs: STARTS[index + 1] ?? DURATION,
  referenceLabel: `候选 ${index + 1}`, disputed: index === 3 || index === 7,
  alternates: index === 3 || index === 7 ? ['refrain', 'verse'] : [],
  anchor: { lineId: null, deltaMs: 0, snapped: true },
  repeatCandidateOf: null,
}));

const identity = {
  ok: true,
  checks: [
    { id: 'title', ok: true, expected: 'Papillon', actual: 'Papillon' },
    { id: 'artist', ok: true, expected: 'Jackson Wang', actual: '王嘉尔' },
    { id: 'version', ok: true, expected: '(无版本标记)', actual: '(无版本标记)' },
    { id: 'duration', ok: true, expected: '195036ms', actual: '195036ms' },
    { id: 'audioSha256', ok: true, expected: '0573…', actual: '0573…' },
  ],
  blockers: [],
};

const draft = () => ({
  songId: 'papillon-1', state: 'DRAFT', generatedAt: '2026-10-31T05:00:00Z', modelName: 'reference-draft',
  modelVersion: 'draft', baseRevision: 3, appliedRevision: null, legacySectionCount: 2, currentSectionCount: 2,
  summary: { sections: 10, pendingTypes: 2, typeCandidates: 0, pendingRelations: 0, pendingMerges: 0, uncovered: 0, needsReview: true },
  timing: null, separation: null,
  reference: {
    songTitle: 'Papillon', artist: 'Jackson Wang', version: 'studio', source: 'P040-Structure-Source-Validation-2026-10-31',
    note: '非官方标注', audioSha256: '0'.repeat(64), audioDurationMs: DURATION, status: 'DRAFT_REVIEW_REQUIRED',
    identity, candidateCount: 10, disputedCount: 2, unsnappedCount: 0,
    loadedAt: '2026-10-31T05:00:00Z', warnings: ['REFERENCE_DISPUTED_TYPES'], sections: CANDIDATES,
  },
  map: {
    schema: 'p040.song-map.v1', songId: 'papillon-1', durationMs: DURATION, status: 'draft',
    warnings: [], relationCandidates: [], mergeCandidates: [], unassigned: [], sections: CANDIDATES,
  },
});

const PEAKS = Array.from({ length: 600 }, (_, index) => 0.2 + Math.abs(Math.sin(index / 7)) * 0.75);

function mockFetch(withDraft: boolean) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (String(url).includes('/structure-waveform')) {
      return new Response(JSON.stringify({ peaks: PEAKS, durationMs: DURATION, source: 'ffmpeg' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).endsWith('/structure-draft/reference/catalog') && method === 'GET') {
      return new Response(JSON.stringify({ entries: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).endsWith('/structure-draft')) {
      return new Response(JSON.stringify({ draft: withDraft ? draft() : null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }));
}

beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal('indexedDB', new IDBFactory());
  await initializeLocalDatabase();
});

async function dump(dom: TalentItem, withDraft: boolean, file: string): Promise<void> {
  cacheRepertoire([dom]);
  mockFetch(withDraft);
  const { container } = render(<VocalPracticePlayer item={dom} />);
  fireEvent.click(screen.getByRole('button', { name: '沉浸练歌' }));
  fireEvent.click(screen.getByRole('button', { name: '更多' }));
  fireEvent.click(screen.getByRole('button', { name: '地图与结构' }));
  const drawer = screen.getByRole('dialog', { name: '地图抽屉' });
  await waitFor(() => expect(drawer.querySelector('.vocal-studio__save')).not.toBeNull());
  // 空结构没有波形（没选中段就没有第 ③ 步），改等空状态提示。
  await waitFor(() => expect(drawer.querySelector('.vocal-wave, .vocal-map__empty')).not.toBeNull());
  writeFileSync(`${OUT}/${file}`, container.innerHTML, 'utf8');
}

it('dump：有参考候选（10 段 / 2 段待核对）', async () => {
  await dump(song(), true, 'dom-ref.html');
});

it('dump：真正空结构（无参考）', async () => {
  await dump(song({ sections: [] }), false, 'dom-empty.html');
});

it('dump：弹层形态（练歌页「结构工作室」）', async () => {
  cacheRepertoire([song()]);
  mockFetch(true);
  const { container } = render(
    <VocalStructureStudio
      item={song()}
      audio={{ timeMs: 0, playing: false, seek: vi.fn(), toggle: vi.fn() }}
      onLoop={() => undefined}
      onClose={() => undefined}
      onSaved={() => undefined}
    />,
  );
  await waitFor(() => expect(document.querySelector('.vocal-studio__save')).not.toBeNull());
  await waitFor(() => expect(document.querySelector('.vocal-wave')).not.toBeNull());
  writeFileSync(`${OUT}/dom-modal.html`, container.innerHTML, 'utf8');
});
