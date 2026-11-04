import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { initializeLocalDatabase, writeMetadata } from '../../src/lib/local-database';
import { flushOperations } from '../../src/lib/offline-editing';
import VocalPracticePlayer from '../../src/components/VocalPracticePlayer';
import type { TalentItem, TimedLyric } from '../../src/lib/types';

const lyrics: TimedLyric[] = [
  { id: 'line-1', startMs: 1000, text: '내가 달리는 길은' },
  { id: 'line-2', startMs: 3000, text: '허나 그 길엔 온통 덫' },
  { id: 'line-3', startMs: 5000, text: '피할 수 없는 함정' },
];

const translations = {
  version: 1 as const,
  language: 'zh' as const,
  source: 'ai' as const,
  lines: [
    { id: 'line-1', text: '我奔跑的那条路', source: 'ai' as const },
    { id: 'line-2', text: '然而那条路上满是陷阱', source: 'ai' as const },
  ],
};

function vocalItem(extra: Partial<TalentItem> = {}): TalentItem {
  return {
    id: 'vocal-tr-1', kind: 'VOCAL', title: '불면증', artist: '辉星', learningStatus: 'PRACTICING',
    originalKey: '', performanceKey: '', capo: 0, scoreText: '', notes: '', audioRole: 'REFERENCE',
    durationMs: 60000, language: 'ko', lyrics, translations, ...extra,
  } as TalentItem;
}

// 直接读 localStorage：组件与测试各自持有 memory 缓存，避免测到测试进程的旧副本。
const snapshot = (): TalentItem[] => JSON.parse(localStorage.getItem('dance.repertoire-snapshot') || '[]');

beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  vi.stubGlobal('indexedDB', new IDBFactory());
  await initializeLocalDatabase();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('练习页默认显示韩中双语，译文按行显示', () => {
  render(<VocalPracticePlayer item={vocalItem()} />);
  expect(screen.getByText('我奔跑的那条路')).toBeVisible();
  expect(screen.getByText('然而那条路上满是陷阱')).toBeVisible();
  expect(screen.getByRole('button', { name: /隐藏中文（韩中）/ })).toBeVisible();
  // 原文仍在，且没有被译文替换。
  expect(screen.getByText('내가 달리는 길은')).toBeVisible();
});

it('可切回只看原文，也能再切回双语', () => {
  render(<VocalPracticePlayer item={vocalItem()} />);
  fireEvent.click(screen.getByRole('button', { name: /隐藏中文（韩中）/ }));
  expect(screen.queryByText('我奔跑的那条路')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /显示中文（韩中）/ }));
  expect(screen.getByText('我奔跑的那条路')).toBeVisible();
});

it('没有译文时显示待翻译入口，不伪造对照', () => {
  render(<VocalPracticePlayer item={vocalItem({ translations: undefined })} />);
  expect(screen.getByRole('button', { name: '翻译缺失 3 句' })).toBeVisible();
  expect(screen.getByText(/还没有中文译文/)).toBeVisible();
});

it('人工纠错只改译文，不改原文与时间轴；保存后标记 manual', async () => {
  const item = vocalItem();
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([item]));
  render(<VocalPracticePlayer item={item} />);
  fireEvent.click(screen.getAllByRole('button', { name: /纠错第 1 句中文译文/ })[0]);
  const input = screen.getByRole('textbox', { name: '第 1 句中文译文' });
  fireEvent.change(input, { target: { value: '我奔跑的那条路（人工）' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => {
    const saved = snapshot()[0];
    expect(saved.translations?.lines.find(line => line.id === 'line-1')).toMatchObject({ text: '我奔跑的那条路（人工）', source: 'manual' });
  });
  await flushOperations().catch(() => undefined);
  const saved = snapshot()[0];
  expect(saved.lyrics).toEqual(lyrics);
});

it('老双语歌词里残留的中文行不会被算成缺译文，不显示假的翻译按钮', () => {
  const bilingual: TimedLyric[] = [
    { id: 'line-1', startMs: 1000, text: '내가 달리는 길은' },
    { id: 'line-2', startMs: 1000, text: '我奔跑的那条路' },
    { id: 'line-3', startMs: 3000, text: '허나 그 길엔 온통 덫' },
    { id: 'line-4', startMs: 3000, text: '然而那条路上满是陷阱' },
  ];
  const paired = {
    version: 1 as const,
    language: 'zh' as const,
    source: 'lrc' as const,
    lines: [
      { id: 'line-1', text: '我奔跑的那条路', source: 'lrc' as const },
      { id: 'line-3', text: '然而那条路上满是陷阱', source: 'lrc' as const },
    ],
  };
  render(<VocalPracticePlayer item={vocalItem({ lyrics: bilingual, translations: paired })} />);
  expect(screen.queryByRole('button', { name: /翻译缺失/ })).not.toBeInTheDocument();
  expect(screen.getByText('2/2 句 · LRC 自带译文')).toBeVisible();
});

it('批量翻译按钮成功后用服务端返回的曲目刷新本机缓存', async () => {
  const item = vocalItem({ translations: undefined });
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([item]));
  const translated = vocalItem({
    translations: {
      version: 1, language: 'zh', source: 'ai',
      lines: lyrics.map(line => ({ id: line.id, text: `译：${line.text}`, source: 'ai' as const })),
    },
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    status: 'COMPLETE', translated: 3, cached: 0, lrcReused: 0, remaining: 0, failed: [], item: translated,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  render(<VocalPracticePlayer item={item} />);
  fireEvent.click(screen.getByRole('button', { name: '翻译缺失 3 句' }));
  await waitFor(() => expect(screen.getByText(/已翻译 3 句/)).toBeVisible());
  await waitFor(() => expect(snapshot()[0]?.translations?.lines).toHaveLength(3));
});

it('翻译通道不可用时明确提示，不显示假译文', async () => {
  const item = vocalItem({ translations: undefined });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    status: 'CHANNEL_UNAVAILABLE', translated: 0, cached: 0, lrcReused: 0, remaining: 3,
    failed: [{ id: 'line-1', message: '翻译脚本不存在' }], item,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  render(<VocalPracticePlayer item={item} />);
  fireEvent.click(screen.getByRole('button', { name: '翻译缺失 3 句' }));
  await waitFor(() => expect(screen.getByText(/翻译通道不可用：翻译脚本不存在/)).toBeVisible());
  expect(screen.queryByText(/^译：/)).not.toBeInTheDocument();
});
