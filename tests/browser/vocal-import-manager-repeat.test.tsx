import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import VocalImportManager, {
  type VocalImportJob,
  type VocalImportJobStatus,
} from '../../src/components/VocalImportManager';

/**
 * 歌词重复候选在导入管理界面的定向 UI 测试。
 * 全部使用模拟接口，不连接真实服务、不读真实音乐库。
 */

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => handler(String(input))));
}

function job(overrides: Partial<VocalImportJob> & { id: string; status: VocalImportJobStatus }): VocalImportJob {
  return {
    songId: `${overrides.id}-song`,
    rootId: 'music',
    stage: 'EXTRACT',
    title: '示例曲目',
    artist: '示例歌手',
    language: 'zh',
    original: { relPath: 'ncm/已转换/示例曲目.mp3', durationMs: 200000 },
    lyrics: { relPath: 'ncm/已转换/示例曲目.lrc', timedLines: 12 },
    suppliedAccompaniment: null,
    issues: [],
    attempts: 0,
    maxAttempts: 3,
    cancelRequested: false,
    error: null,
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('有重复行时默认折叠显示次数、来源与 LRC 原时间，且不再出现待确认 / unknown 字样', async () => {
  const withRepeat = job({
    id: 'job-repeat',
    status: 'PENDING_EXTRACT',
    title: '有重复曲',
    repeatCandidateStatus: 'pending-confirmation',
    repeatCandidates: [
      {
        id: 'lrc-repeat-1',
        kind: 'lyric-repeat',
        source: 'lrc-repeat',
        status: 'pending-confirmation',
        sectionType: 'unknown',
        text: '重复句',
        count: 2,
        occurrences: [{ startMs: 1000, lineIndex: 0 }, { startMs: 61000, lineIndex: 3 }],
      },
    ],
  });
  stubFetch((url) => {
    if (url.includes('/roots')) return json({ roots: [{ id: 'music', label: '本机音乐', available: true }] });
    if (url.includes('/jobs')) return json({ jobs: [withRepeat] });
    return json({}, 404);
  });

  render(<MemoryRouter><VocalImportManager /></MemoryRouter>);
  expect(await screen.findByText('有重复曲')).toBeInTheDocument();
  const summary = screen.getByText(/歌词重复行清单：1 组/);
  expect(summary).toBeInTheDocument();
  expect(summary.closest('details')?.open).toBe(false);
  expect(screen.getByText(/仅供参照，无需逐条确认/)).toBeInTheDocument();
  expect(screen.getByText(/已用于自动推测歌曲结构/)).toBeInTheDocument();
  expect(screen.getByText(/不会阻塞导入/)).toBeInTheDocument();
  expect(screen.getByText('重复句')).toBeInTheDocument();
  expect(screen.getByText(/2 次 · 来源：lrc-repeat/)).toBeInTheDocument();
  expect(screen.queryByText(/状态：待确认/)).not.toBeInTheDocument();
  expect(screen.queryByText(/结构：unknown/)).not.toBeInTheDocument();
  expect(screen.getByText(/时间：0:01.000、1:01.000/)).toBeInTheDocument();
});

it('无可靠重复时不渲染候选区块', async () => {
  const noRepeat = job({
    id: 'job-none',
    status: 'PENDING_EXTRACT',
    title: '无重复曲',
    repeatCandidateStatus: 'unknown',
    repeatCandidates: [],
  });
  stubFetch((url) => {
    if (url.includes('/roots')) return json({ roots: [{ id: 'music', label: '本机音乐', available: true }] });
    if (url.includes('/jobs')) return json({ jobs: [noRepeat] });
    return json({}, 404);
  });

  render(<MemoryRouter><VocalImportManager /></MemoryRouter>);
  await screen.findByText('无重复曲');
  expect(screen.queryByText(/歌词重复行清单/)).not.toBeInTheDocument();
});

it('没有歌词的任务不显示重复候选区域', async () => {
  const noLyrics = job({ id: 'job-no-lyrics', status: 'PENDING_EXTRACT', title: '无歌词曲', lyrics: null });
  stubFetch((url) => {
    if (url.includes('/roots')) return json({ roots: [{ id: 'music', label: '本机音乐', available: true }] });
    if (url.includes('/jobs')) return json({ jobs: [noLyrics] });
    return json({}, 404);
  });

  render(<MemoryRouter><VocalImportManager /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText('无歌词曲')).toBeInTheDocument());
  expect(screen.queryByText(/歌词重复候选/)).not.toBeInTheDocument();
});
