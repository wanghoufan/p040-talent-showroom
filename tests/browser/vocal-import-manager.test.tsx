/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { initializeLocalDatabase } from '../../src/lib/local-database';
import VocalImportManager, { type VocalImportJob, type VocalImportJobStatus } from '../../src/components/VocalImportManager';
import VocalImportStatus from '../../src/components/VocalImportStatus';
import TalentLibraryPage from '../../src/pages/TalentLibraryPage';
import type { TalentItem } from '../../src/lib/types';

/**
 * V3.1 本地智能导入 UI 定向测试。
 * 全部使用模拟 API，不连接真实 Mac mini、不扫描真实音乐目录、不运行提取模型。
 */

type Call = { url: string; init?: RequestInit };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }));
  return calls;
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
    lyrics: { relPath: 'ncm/已转换/示例曲目.lrc', timedLines: 32 },
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

const renderManager = () => render(<MemoryRouter><VocalImportManager /></MemoryRouter>);

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('接口未挂载时如实提示未配置，不渲染扫描按钮、不假装可用', async () => {
  stubFetch(() => json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }, 404));
  renderManager();

  expect(await screen.findByText(/尚未启用本地智能导入接口/)).toBeVisible();
  expect(screen.getByText(/当前不能扫描、提取或入库/)).toBeVisible();
  expect(screen.queryByRole('button', { name: '扫描并入队' })).not.toBeInTheDocument();
});

it('只使用已登记 rootId 扫描：拒绝绝对子路径，请求体不含本机路径', async () => {
  const calls = stubFetch((url) => {
    if (url.includes('/api/vocal-import/roots')) {
      return json({ roots: [{ id: 'music', label: '本机音乐', available: true }, { id: 'external', label: '外置卷（未挂载）', available: false }] });
    }
    if (url.includes('/api/vocal-import/jobs')) return json({ jobs: [] });
    if (url.includes('/api/vocal-import/scan')) {
      return json({ created: 2, reused: 1, scan: { summary: { audioFiles: 3, lrcFiles: 3, readyToExtract: 2, needsReview: 1, duplicates: 0 } } }, 202);
    }
    return json({ error: { message: '未知接口' } }, 404);
  });

  renderManager();
  expect(await screen.findByRole('button', { name: /本机音乐/ })).toBeVisible();
  expect(screen.getByRole('button', { name: /外置卷（未挂载）/ })).toBeInTheDocument();
  expect(screen.getByText(/当前不可用/)).toBeVisible();

  const subPathInput = screen.getByLabelText('子目录（可选，相对路径）');
  fireEvent.change(subPathInput, { target: { value: '/Volumes/三星/网易云音乐' } });
  fireEvent.click(screen.getByRole('button', { name: '扫描并入队' }));
  expect(await screen.findByText(/只接受已登记目录下的相对路径/)).toBeVisible();
  expect(calls.filter((call) => call.url.includes('/scan'))).toHaveLength(0);

  fireEvent.change(subPathInput, { target: { value: 'ncm/已转换' } });
  fireEvent.click(screen.getByRole('button', { name: '扫描并入队' }));

  await waitFor(() => expect(screen.getByText(/新增任务 2 个/)).toBeVisible());
  const scanCall = calls.find((call) => call.url.includes('/api/vocal-import/scan'));
  expect(scanCall?.init?.method).toBe('POST');
  const body = JSON.parse(String(scanCall?.init?.body));
  expect(body).toEqual({ rootId: 'music', subPath: 'ncm/已转换' });
  expect(JSON.stringify(body)).not.toContain('/Volumes');
});

it('任务状态如实显示，失败可重试、待核对可进入核对，不冒充提取成功', async () => {
  const failed = job({ id: 'job-failed', status: 'FAILED', title: '失败曲', attempts: 2, error: { code: 'EXTRACT_FAILED', message: '伴奏提取失败' }, issues: ['audio-damaged'] });
  const review = job({ id: 'job-review', status: 'NEEDS_REVIEW', title: '待核对曲', issues: ['multiple-lyrics-candidates', 'filename-id3-artist-conflict'] });
  const calls = stubFetch((url) => {
    if (url.includes('/roots')) return json({ roots: [{ id: 'music', label: '本机音乐', available: true }] });
    if (url.includes('/jobs/job-failed/retry')) return json({ ...failed, status: 'PENDING_EXTRACT' });
    if (url.includes('/jobs')) return json({ jobs: [failed, review] });
    return json({ error: { message: '未知接口' } }, 404);
  });

  renderManager();
  expect(await screen.findByText('失败曲')).toBeVisible();
  expect(screen.getByText('提取失败')).toBeVisible();
  expect(screen.getByText('需核对')).toBeVisible();
  expect(screen.getByText('同一首歌有多个歌词候选')).toBeVisible();
  expect(screen.getByText(/已尝试 2\/3 次/)).toBeVisible();
  expect(screen.getByText(/伴奏提取失败/)).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: '重试 失败曲' }));
  await waitFor(() => expect(calls.some((call) => call.url.includes('/jobs/job-failed/retry'))).toBe(true));
  const retryCall = calls.find((call) => call.url.includes('/jobs/job-failed/retry'));
  expect(retryCall?.init?.method).toBe('POST');

  fireEvent.click(screen.getByRole('button', { name: '核对 待核对曲' }));
  expect(screen.getByRole('dialog', { name: '核对导入任务：待核对曲' })).toBeVisible();
});

it('核对只接受相对路径；绝对路径不提交，合法路径提交到 resolve', async () => {
  const review = job({ id: 'job-review', status: 'NEEDS_REVIEW', title: '待核对曲', issues: ['multiple-lyrics-candidates'] });
  const calls = stubFetch((url) => {
    if (url.includes('/roots')) return json({ roots: [{ id: 'music', label: '本机音乐', available: true }] });
    if (url.includes('/jobs/job-review/resolve')) return json({ ...review, status: 'PENDING_EXTRACT' });
    if (url.includes('/jobs')) return json({ jobs: [review] });
    return json({ error: { message: '未知接口' } }, 404);
  });

  renderManager();
  await screen.findByText('待核对曲');
  fireEvent.click(screen.getByRole('button', { name: '核对 待核对曲' }));
  const dialog = screen.getByRole('dialog', { name: '核对导入任务：待核对曲' });

  fireEvent.change(within(dialog).getByLabelText('歌词相对路径（.lrc，可留空）'), { target: { value: '/Volumes/三星/网易云音乐/待核对曲.lrc' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存核对' }));
  expect(await within(dialog).findByText(/不接受本机绝对路径/)).toBeVisible();
  expect(calls.some((call) => call.url.includes('/resolve'))).toBe(false);

  fireEvent.change(within(dialog).getByLabelText('歌词相对路径（.lrc，可留空）'), { target: { value: 'ncm/已转换/待核对曲.lrc' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存核对' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  const resolveCall = calls.find((call) => call.url.includes('/jobs/job-review/resolve'));
  expect(resolveCall?.init?.method).toBe('POST');
  expect(JSON.parse(String(resolveCall?.init?.body))).toEqual({ lyricsRelPath: 'ncm/已转换/待核对曲.lrc' });
});

it('核对提交后仍有其他问题时不关闭对话框，也不假称完成', async () => {
  const review = job({
    id: 'job-review',
    status: 'NEEDS_REVIEW',
    title: '待核对曲',
    issues: ['multiple-lyrics-candidates', 'filename-id3-artist-conflict'],
  });
  const stillReview = job({
    ...review,
    issues: ['filename-id3-artist-conflict'],
  });
  stubFetch((url) => {
    if (url.includes('/roots')) return json({ roots: [{ id: 'music', label: '本机音乐', available: true }] });
    if (url.includes('/jobs/job-review/resolve')) return json(stillReview);
    if (url.includes('/jobs')) return json({ jobs: [review] });
    return json({ error: { message: '未知接口' } }, 404);
  });

  renderManager();
  await screen.findByText('待核对曲');
  fireEvent.click(screen.getByRole('button', { name: '核对 待核对曲' }));
  const dialog = screen.getByRole('dialog', { name: '核对导入任务：待核对曲' });
  fireEvent.change(within(dialog).getByLabelText('歌词相对路径（.lrc，可留空）'), { target: { value: 'ncm/已转换/待核对曲.lrc' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存核对' }));

  expect(await within(dialog).findByText(/仍有 1 项需要核对/)).toBeVisible();
  expect(screen.getByRole('dialog', { name: '核对导入任务：待核对曲' })).toBeVisible();
  expect(within(dialog).getByText('文件名与标签歌手不一致')).toBeVisible();
});

it('标签冲突时核对框出现歌名/歌手输入，默认取解析值且提交时带上 title', async () => {
  const review = job({
    id: 'job-tag',
    status: 'NEEDS_REVIEW',
    title: 'Let Go.',
    artist: '石玺彤',
    original: { relPath: 'ncm/已转换/石玺彤 - Let Go.mp3', durationMs: 200000 },
    lyrics: null,
    issues: ['filename-id3-title-conflict'],
  });
  const calls = stubFetch((url) => {
    if (url.includes('/roots')) return json({ roots: [{ id: 'music', label: '本机音乐', available: true }] });
    if (url.includes('/jobs/job-tag/resolve')) return json({ ...review, status: 'PENDING_EXTRACT', issues: [] });
    if (url.includes('/jobs')) return json({ jobs: [review] });
    return json({ error: { message: '未知接口' } }, 404);
  });

  renderManager();
  await screen.findByText('Let Go.');
  fireEvent.click(screen.getByRole('button', { name: '核对 Let Go.' }));
  const dialog = screen.getByRole('dialog', { name: '核对导入任务：Let Go.' });

  // 两侧取值都要摆在界面上，用户才知道在选什么。
  expect(within(dialog).getByText('石玺彤 - Let Go.mp3')).toBeVisible();
  expect(within(dialog).getByText(/歌名「Let Go\.」/)).toBeVisible();

  const titleInput = within(dialog).getByLabelText('歌名（不能为空，以此值为准）');
  expect(titleInput).toHaveValue('Let Go.');
  const artistInput = within(dialog).getByLabelText('歌手（可留空，以此值为准）');
  expect(artistInput).toHaveValue('石玺彤');

  fireEvent.change(titleInput, { target: { value: 'Let Go' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存核对' }));

  await waitFor(() => expect(calls.some((call) => call.url.includes('/jobs/job-tag/resolve'))).toBe(true));
  const resolveCall = calls.find((call) => call.url.includes('/jobs/job-tag/resolve'));
  expect(resolveCall?.init?.method).toBe('POST');
  const body = JSON.parse(String(resolveCall?.init?.body));
  expect(body.title).toBe('Let Go');
  expect(body.artist).toBe('石玺彤');
  // 没有歌词/伴奏路径时不应凭空造字段。
  expect(body).not.toHaveProperty('lyricsRelPath');
});

it('歌名为空时不提交，提示歌名不能为空', async () => {
  const review = job({ id: 'job-tag', status: 'NEEDS_REVIEW', title: 'Let Go.', issues: ['filename-id3-title-conflict'] });
  const calls = stubFetch((url) => {
    if (url.includes('/roots')) return json({ roots: [{ id: 'music', label: '本机音乐', available: true }] });
    if (url.includes('/jobs')) return json({ jobs: [review] });
    return json({ error: { message: '未知接口' } }, 404);
  });

  renderManager();
  await screen.findByText('Let Go.');
  fireEvent.click(screen.getByRole('button', { name: '核对 Let Go.' }));
  const dialog = screen.getByRole('dialog', { name: '核对导入任务：Let Go.' });

  fireEvent.change(within(dialog).getByLabelText('歌名（不能为空，以此值为准）'), { target: { value: '  ' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存核对' }));

  expect(await within(dialog).findByText(/歌名不能为空/)).toBeVisible();
  expect(calls.some((call) => call.url.includes('/resolve'))).toBe(false);
});

it('非标签冲突的核对不显示歌名/歌手输入，请求体也不带 title', async () => {
  const review = job({ id: 'job-lyrics', status: 'NEEDS_REVIEW', title: '待核对曲', issues: ['multiple-lyrics-candidates'] });
  const calls = stubFetch((url) => {
    if (url.includes('/roots')) return json({ roots: [{ id: 'music', label: '本机音乐', available: true }] });
    if (url.includes('/jobs/job-lyrics/resolve')) return json({ ...review, status: 'PENDING_EXTRACT', issues: [] });
    if (url.includes('/jobs')) return json({ jobs: [review] });
    return json({ error: { message: '未知接口' } }, 404);
  });

  renderManager();
  await screen.findByText('待核对曲');
  fireEvent.click(screen.getByRole('button', { name: '核对 待核对曲' }));
  const dialog = screen.getByRole('dialog', { name: '核对导入任务：待核对曲' });

  expect(within(dialog).queryByLabelText('歌名（不能为空，以此值为准）')).not.toBeInTheDocument();
  expect(within(dialog).queryByLabelText('歌手（可留空，以此值为准）')).not.toBeInTheDocument();

  fireEvent.change(within(dialog).getByLabelText('歌词相对路径（.lrc，可留空）'), { target: { value: 'ncm/已转换/待核对曲.lrc' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存核对' }));

  await waitFor(() => expect(calls.some((call) => call.url.includes('/jobs/job-lyrics/resolve'))).toBe(true));
  const body = JSON.parse(String(calls.find((call) => call.url.includes('/jobs/job-lyrics/resolve'))?.init?.body));
  expect(body).toEqual({ lyricsRelPath: 'ncm/已转换/待核对曲.lrc' });
});

it('入库已有伴奏冲突：明确选择保留旧伴奏才提交，不静默替换', async () => {
  const conflict = job({
    id: 'job-conflict',
    status: 'NEEDS_REVIEW',
    stage: 'IMPORT',
    title: '冲突曲',
    issues: ['existing-accompaniment-conflict'],
    error: { code: 'ACCOMPANIMENT_CONFLICT', message: '已有伴奏轨，已保留未替换；请人工核对要保留哪一条' },
    conflict: {
      code: 'ACCOMPANIMENT_CONFLICT',
      repertoireId: 'conflict-song',
      existingAccompanimentClipId: 'old-clip',
      incomingAccompanimentRelPath: 'vocal-import/conflict-song/new.flac',
      options: ['keep-existing', 'use-new'],
    },
  });
  const calls = stubFetch((url) => {
    if (url.includes('/roots')) return json({ roots: [{ id: 'music', label: '本机音乐', available: true }] });
    if (url.includes('/jobs/job-conflict/resolve-conflict')) {
      return json({ ...conflict, status: 'IMPORTED', stage: 'IMPORT', issues: [], error: null, conflict: {} });
    }
    if (url.includes('/jobs')) return json({ jobs: [conflict] });
    return json({ error: { message: '未知接口' } }, 404);
  });

  renderManager();
  expect(await screen.findByText('冲突曲')).toBeVisible();
  expect(screen.getByText('曲库已有伴奏轨，已保留旧轨，未替换')).toBeVisible();
  expect(screen.getByText(/系统没有自动替换/)).toBeVisible();
  expect(screen.getByText(/本次新伴奏：vocal-import\/conflict-song\/new.flac/)).toBeVisible();
  expect(screen.queryByRole('button', { name: '核对 冲突曲' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '重新检查 冲突曲' })).not.toBeInTheDocument();
  expect(calls.some((call) => call.url.includes('/resolve-conflict'))).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: '保留旧伴奏 冲突曲' }));
  await waitFor(() => expect(calls.some((call) => call.url.includes('/jobs/job-conflict/resolve-conflict'))).toBe(true));
  const resolveCall = calls.find((call) => call.url.includes('/jobs/job-conflict/resolve-conflict'));
  expect(resolveCall?.init?.method).toBe('POST');
  expect(JSON.parse(String(resolveCall?.init?.body))).toEqual({ choice: 'keep-existing' });
  expect(await screen.findByText(/只补原唱与歌词；旧轨未被替换/)).toBeVisible();
});

it('改用新伴奏必须二次确认，确认后才提交 use-new', async () => {
  const conflict = job({
    id: 'job-conflict',
    status: 'NEEDS_REVIEW',
    stage: 'IMPORT',
    title: '冲突曲',
    issues: ['existing-accompaniment-conflict'],
    error: { code: 'ACCOMPANIMENT_CONFLICT', message: '已有伴奏轨，已保留未替换' },
  });
  const calls = stubFetch((url) => {
    if (url.includes('/roots')) return json({ roots: [{ id: 'music', label: '本机音乐', available: true }] });
    if (url.includes('/jobs/job-conflict/resolve-conflict')) {
      return json({ ...conflict, status: 'IMPORTED', stage: 'IMPORT', issues: [], error: null, conflict: {} });
    }
    if (url.includes('/jobs')) return json({ jobs: [conflict] });
    return json({ error: { message: '未知接口' } }, 404);
  });

  renderManager();
  await screen.findByText('冲突曲');
  fireEvent.click(screen.getByRole('button', { name: '改用新伴奏 冲突曲' }));
  const dialog = screen.getByRole('alertdialog', { name: '确认改用新伴奏：冲突曲' });
  expect(dialog).toBeVisible();
  expect(within(dialog).getByText(/旧伴奏音轨只解除绑定/)).toBeVisible();
  expect(calls.some((call) => call.url.includes('/resolve-conflict'))).toBe(false);

  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('alertdialog', { name: '确认改用新伴奏：冲突曲' })).not.toBeInTheDocument();
  expect(calls.some((call) => call.url.includes('/resolve-conflict'))).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: '改用新伴奏 冲突曲' }));
  fireEvent.click(within(screen.getByRole('alertdialog', { name: '确认改用新伴奏：冲突曲' })).getByRole('button', { name: '确认改用新伴奏' }));

  await waitFor(() => expect(calls.some((call) => call.url.includes('/jobs/job-conflict/resolve-conflict'))).toBe(true));
  const resolveCall = calls.find((call) => call.url.includes('/jobs/job-conflict/resolve-conflict'));
  expect(resolveCall?.init?.method).toBe('POST');
  expect(JSON.parse(String(resolveCall?.init?.body))).toEqual({ choice: 'use-new' });
});

it('冲突处理失败时显示服务端错误，不假装完成', async () => {
  const conflict = job({
    id: 'job-conflict',
    status: 'NEEDS_REVIEW',
    stage: 'IMPORT',
    title: '冲突曲',
    issues: ['existing-accompaniment-conflict'],
    error: { code: 'ACCOMPANIMENT_CONFLICT', message: '已有伴奏轨，已保留未替换' },
  });
  stubFetch((url) => {
    if (url.includes('/roots')) return json({ roots: [{ id: 'music', label: '本机音乐', available: true }] });
    if (url.includes('/jobs/job-conflict/resolve-conflict')) {
      return json({ error: { code: 'CONFLICT', message: '任务不在入库冲突状态' } }, 409);
    }
    if (url.includes('/jobs')) return json({ jobs: [conflict] });
    return json({ error: { message: '未知接口' } }, 404);
  });

  renderManager();
  await screen.findByText('冲突曲');
  fireEvent.click(screen.getByRole('button', { name: '保留旧伴奏 冲突曲' }));
  expect(await screen.findByText('任务不在入库冲突状态')).toBeVisible();
  expect(screen.queryByText(/旧轨未被替换/)).not.toBeInTheDocument();
});

it('失败/模型不可用时提供只入库原唱 + 歌词，并保留失败重试', async () => {
  const failed = job({ id: 'job-failed', status: 'FAILED', title: '失败曲', attempts: 2, error: { code: 'EXTRACT_FAILED', message: '伴奏提取失败' } });
  const modelDown = job({ id: 'job-model', status: 'PENDING_EXTRACT', title: '模型不可用曲', error: { code: 'EXTRACTOR_NOT_CONFIGURED', message: '本机尚未配置本地伴奏提取器' } });
  const waiting = job({ id: 'job-waiting', status: 'PENDING_EXTRACT', title: '排队曲', error: null });
  const hasArtifact = job({ id: 'job-artifact', status: 'FAILED', title: '已有伴奏曲', artifacts: { accompaniment: { relPath: 'vocal-import/x/accompaniment.flac' } } });
  const importedOriginal = job({ id: 'job-imported-original', status: 'IMPORTED', importMode: 'ORIGINAL_ONLY', title: '已只入库曲' });
  const calls = stubFetch((url) => {
    if (url.includes('/roots')) return json({ roots: [{ id: 'music', label: '本机音乐', available: true }] });
    if (url.includes('/jobs/job-failed/original-only')) {
      return json({ ...failed, status: 'IMPORTED', stage: 'IMPORT', error: null, issues: [] });
    }
    if (url.includes('/jobs/job-imported-original/retry')) {
      return json({ ...importedOriginal, status: 'PENDING_EXTRACT', stage: 'EXTRACT' });
    }
    if (url.includes('/jobs')) return json({ jobs: [failed, modelDown, waiting, hasArtifact, importedOriginal] });
    return json({ error: { message: '未知接口' } }, 404);
  });

  renderManager();
  await screen.findByText('失败曲');
  expect(screen.getByRole('button', { name: '只入库原唱和歌词 失败曲' })).toBeVisible();
  expect(screen.getByRole('button', { name: '重试 失败曲' })).toBeVisible();
  expect(screen.getByRole('button', { name: '只入库原唱和歌词 模型不可用曲' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '只入库原唱和歌词 排队曲' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '只入库原唱和歌词 已有伴奏曲' })).not.toBeInTheDocument();
  expect(screen.getByText(/当前只入库了原唱与歌词，还没有伴奏/)).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: '只入库原唱和歌词 失败曲' }));
  await waitFor(() => expect(calls.some((call) => call.url.includes('/jobs/job-failed/original-only'))).toBe(true));
  const importCall = calls.find((call) => call.url.includes('/jobs/job-failed/original-only'));
  expect(importCall?.init?.method).toBe('POST');
  expect(await screen.findByText(/只入库原唱与歌词，没有写入伴奏/)).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: '继续提取伴奏 已只入库曲' }));
  await waitFor(() => expect(calls.some((call) => call.url.includes('/jobs/job-imported-original/retry'))).toBe(true));
  const retryCall = calls.find((call) => call.url.includes('/jobs/job-imported-original/retry'));
  expect(retryCall?.init?.method).toBe('POST');
});

it('只入库原唱失败时显示服务端错误，不假装已入库', async () => {
  const failed = job({ id: 'job-failed', status: 'FAILED', title: '失败曲', error: { code: 'EXTRACT_FAILED', message: '伴奏提取失败' } });
  stubFetch((url) => {
    if (url.includes('/roots')) return json({ roots: [{ id: 'music', label: '本机音乐', available: true }] });
    if (url.includes('/jobs/job-failed/original-only')) {
      return json({ error: { code: 'CONFLICT', message: '入库器不支持只入库原唱' } }, 409);
    }
    if (url.includes('/jobs')) return json({ jobs: [failed] });
    return json({ error: { message: '未知接口' } }, 404);
  });

  renderManager();
  await screen.findByText('失败曲');
  fireEvent.click(screen.getByRole('button', { name: '只入库原唱和歌词 失败曲' }));
  expect(await screen.findByText('入库器不支持只入库原唱')).toBeVisible();
  expect(screen.queryByText(/只入库原唱与歌词，没有写入伴奏/)).not.toBeInTheDocument();
});

it('未确认 worker 启用时不承诺后台正在处理', async () => {
  const pending = job({ id: 'job-pending', status: 'PENDING_EXTRACT', title: '待提取曲' });
  stubFetch((url) => {
    if (url.includes('/roots')) return json({ roots: [{ id: 'music', label: '本机音乐', available: true }] });
    if (url.includes('/jobs')) return json({ jobs: [pending] });
    return json({ error: { message: '未知接口' } }, 404);
  });

  renderManager();
  expect(await screen.findByText('待提取曲')).toBeVisible();
  expect(screen.getByText(/若服务端未启用 worker/)).toBeVisible();
  expect(screen.queryByText(/不会中断 Mac mini 的队列/)).not.toBeInTheDocument();
});

it('界面写明本地提取（人声分离），不写成 AI 生成伴奏', async () => {
  stubFetch((url) => {
    if (url.includes('/roots')) return json({ roots: [{ id: 'music', label: '本机音乐', available: true }] });
    if (url.includes('/jobs')) return json({ jobs: [] });
    return json({}, 404);
  });
  renderManager();
  const lead = await screen.findByText(/用本机模型/);
  expect(lead).toBeVisible();
  expect(lead.textContent).toContain('提取');
  expect(lead.textContent).toContain('人声分离');
  expect(lead.textContent).toContain('不是 AI 生成新伴奏');
  expect(screen.queryByText(/伴奏生成/)).not.toBeInTheDocument();
});

it('手机任务状态条汇总进度、异常与重试，并给出管理入口', async () => {
  const calls = stubFetch((url) => {
    if (url.includes('/jobs/job-failed/retry')) return json({ ...job({ id: 'job-failed', status: 'FAILED' }), status: 'PENDING_EXTRACT' });
    if (url.includes('/api/vocal-import/jobs')) {
      return json({
        jobs: [
          job({ id: 'job-running', status: 'EXTRACTING', title: '提取中曲' }),
          job({ id: 'job-review', status: 'NEEDS_REVIEW', title: '待核对曲' }),
          job({ id: 'job-failed', status: 'FAILED', title: '失败曲' }),
          job({ id: 'job-done', status: 'IMPORTED', title: '已入库曲' }),
        ],
      });
    }
    return json({}, 404);
  });

  render(<MemoryRouter><VocalImportStatus /></MemoryRouter>);
  expect(await screen.findByText(/提取中 1 · 需核对 1 · 失败 1 · 已入库 1/)).toBeVisible();
  expect(screen.getByText(/失败 · 失败曲/)).toBeVisible();
  expect(screen.getByText(/需核对 · 待核对曲/)).toBeVisible();
  expect(screen.getByRole('link', { name: '打开导入管理' })).toHaveAttribute('href', '/settings');

  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(calls.some((call) => call.url.includes('/jobs/job-failed/retry'))).toBe(true));
});

it('手机端未启用导入接口时只提示未启用，不伪造提取成功', async () => {
  stubFetch(() => json({ error: { code: 'NOT_FOUND' } }, 404));
  render(<MemoryRouter><VocalImportStatus /></MemoryRouter>);
  expect(await screen.findByText(/尚未启用本地智能导入/)).toBeVisible();
  expect(screen.getByRole('button', { name: '重试读取' })).toBeVisible();
  expect(screen.getByRole('link', { name: '去「我的」查看导入设置' })).toHaveAttribute('href', '/settings');
});

it('手机任务条自动刷新，并汇总所有出现的状态', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  let round = 0;
  const statuses: VocalImportJobStatus[] = [
    'PENDING_EXTRACT',
    'EXTRACTING',
    'VERIFYING',
    'READY_TO_IMPORT',
    'NEEDS_REVIEW',
    'FAILED',
    'IMPORTED',
    'CANCELLED',
  ];
  stubFetch((url) => {
    if (!url.includes('/api/vocal-import/jobs')) return json({}, 404);
    round += 1;
    const jobs = statuses.map((status, index) => job({ id: `job-${index}`, status, title: `曲${index}` }));
    if (round > 1) jobs[0] = job({ id: 'job-0', status: 'IMPORTED', title: '曲0' });
    return json({ jobs });
  });

  render(<MemoryRouter><VocalImportStatus /></MemoryRouter>);
  expect(await screen.findByText(/待提取 1 · 提取中 1 · 校验中 1 · 待入库 1 · 需核对 1 · 失败 1 · 已入库 1 · 已取消 1/)).toBeVisible();

  await act(async () => {
    vi.advanceTimersByTime(6000);
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitFor(() => expect(round).toBeGreaterThanOrEqual(2));
  expect(await screen.findByText(/提取中 1 · 校验中 1 · 待入库 1 · 需核对 1 · 失败 1 · 已入库 2 · 已取消 1/)).toBeVisible();
});

it('导入管理相关标题字号不低于 23px', () => {
  const css = readFileSync('src/styles/vocal-import-manager.css', 'utf8');
  const selectors = [
    '.vocal-import h2',
    '.vocal-import h3',
    '.vocal-import-job__title',
    '.vocal-import-review h3',
    '.vocal-import-status-bar__title',
  ];
  for (const selector of selectors) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`${escaped}\\s*\\{[^}]*font-size:\\s*(\\d+)px`).exec(css);
    expect(match, `${selector} 缺少 font-size`).not.toBeNull();
    expect(Number(match?.[1]), selector).toBeGreaterThanOrEqual(23);
  }
});

it('唱歌曲库保留两行筛选并显示任务状态条，吉他页不出现该状态条', async () => {
  localStorage.clear();
  vi.stubGlobal('indexedDB', new IDBFactory());
  await initializeLocalDatabase();
  const items: TalentItem[] = [
    { id: 'v1', kind: 'VOCAL', title: '海风来信', artist: '自己', learningStatus: 'PRACTICING', originalKey: 'C', performanceKey: 'C', capo: 0, scoreText: '', notes: '', audioRole: 'ACCOMPANIMENT', durationMs: 0, language: 'zh' },
    { id: 'g1', kind: 'GUITAR', title: '吉他曲', artist: '自己', learningStatus: 'WANT_TO_LEARN', originalKey: 'C', performanceKey: 'C', capo: 2, scoreText: '', notes: '', audioRole: 'REFERENCE', durationMs: 0 },
  ];
  stubFetch((url) => {
    if (url.includes('/api/vocal-import/jobs')) return json({ jobs: [] });
    return json({ items });
  });

  await act(async () => {
    render(<MemoryRouter initialEntries={['/repertoire/vocal']}><Routes><Route path="/repertoire/:kind" element={<TalentLibraryPage />} /></Routes></MemoryRouter>);
  });
  expect(await screen.findByText('海风来信')).toBeVisible();
  expect(document.querySelectorAll('.vocal-filters__row')).toHaveLength(2);
  expect(screen.getByLabelText('本地导入任务状态')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('link', { name: '吉他' }));
  expect(await screen.findByText('吉他曲')).toBeVisible();
  expect(document.querySelectorAll('.vocal-filters__row')).toHaveLength(0);
  expect(screen.queryByLabelText('本地导入任务状态')).not.toBeInTheDocument();
});
