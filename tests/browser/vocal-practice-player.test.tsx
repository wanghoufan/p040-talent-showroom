import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { initializeLocalDatabase, readMetadata, writeMetadata } from '../../src/lib/local-database';
import VocalPracticePlayer from '../../src/components/VocalPracticePlayer';
import TalentDetailPage from '../../src/pages/TalentDetailPage';
import type { MediaFile, TalentItem, TimedLyric, VocalSection } from '../../src/lib/types';

const media = (id: string): MediaFile => ({ id, url: `/api/media/audio/${id}`, sha256: `sha-${id}`, sizeBytes: 10, version: 1, durationMs: 66000 });
const line = (startMs: number, text: string): TimedLyric => ({ id: `l-${startMs}`, startMs, text });
const section = (input: Partial<VocalSection> & Pick<VocalSection, 'id'>): VocalSection => ({ type: 'verse', label: input.id, startMs: 0, endMs: 1000, source: 'manual', ...input });

const lyrics: TimedLyric[] = [line(0, '第一句'), line(4000, '第二句'), line(8000, '第三句'), line(12000, '第四句'), line(16000, '第五句'), line(20000, '第六句')];
const sections: VocalSection[] = [
  section({ id: 's1', type: 'verse', label: 'A1', startMs: 0, endMs: 6000 }),
  section({ id: 's2', type: 'chorus', label: 'B1', startMs: 6000, endMs: 20000 }),
  section({ id: 's3', type: 'rap', label: 'R1', startMs: 29000, endMs: 37000 }),
  section({ id: 's4', type: 'chorus', label: 'B2', startMs: 37000, endMs: 60000, repeatOf: 's2', repetition: 'same-melody-new-lyrics' }),
];

/** 与后端一致：tracks / lyrics / sections / practice 是唱歌曲目的真实字段。 */
function vocalItem(extra: Partial<TalentItem> = {}): TalentItem {
  return {
    id: 'vocal-1', kind: 'VOCAL', title: '海风来信', artist: '原创演示', learningStatus: 'PRACTICING',
    originalKey: 'C', performanceKey: 'C', capo: 0, scoreText: '', notes: '', audioRole: 'ACCOMPANIMENT', durationMs: 66000,
    ...extra,
  } as TalentItem;
}

const audioOf = (): HTMLAudioElement => {
  const element = document.querySelector('audio');
  if (!element) throw new Error('missing audio element');
  return element;
};

/** jsdom 不解析媒体：手动给出 duration 再触发元数据事件，模拟浏览器加载完成。 */
const loadMedia = (seconds = 66): HTMLAudioElement => {
  const element = audioOf();
  Object.defineProperty(element, 'duration', { configurable: true, value: seconds });
  fireEvent.loadedMetadata(element);
  return element;
};

let play: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  vi.stubGlobal('indexedDB', new IDBFactory());
  await initializeLocalDatabase();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('结构地图按段落渲染并可跳转，Rap 段标注可跳过，重复旋律不标成免学', () => {
  render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections })} />);
  expect(screen.getByRole('heading', { name: '歌曲结构' })).toBeVisible();
  expect(screen.getByText('旋律同 B1、歌词不同')).toBeVisible();
  expect(screen.getByText('可跳过')).toBeVisible();
  const audio = loadMedia();
  fireEvent.click(screen.getByRole('button', { name: '跳到 R1，0:29' }));
  expect(audio.currentTime).toBeCloseTo(29, 1);
});

it('没有结构数据时明确显示待分析，不伪造段落', () => {
  render(<VocalPracticePlayer item={vocalItem({ lyrics })} />);
  expect(screen.getByText(/待分析/)).toBeVisible();
  expect(screen.queryByRole('button', { name: /^跳到/ })).not.toBeInTheDocument();
});

it('点击歌词跳句并高亮当前句，2 句循环从当前句向前取且首句处夹取', () => {
  render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections })} />);
  const audio = loadMedia();
  fireEvent.click(screen.getByRole('button', { name: /第五句/ }));
  expect(audio.currentTime).toBeCloseTo(16, 1);
  expect(screen.getByRole('button', { name: /第五句/ })).toHaveAttribute('aria-current', 'true');

  fireEvent.click(screen.getByRole('button', { name: '2 句' }));
  expect(audio.currentTime).toBeCloseTo(12, 1);
  expect(screen.getByText(/逐句循环 · 第 4～5 句/)).toBeVisible();

  audio.currentTime = 20.5;
  fireEvent.timeUpdate(audio);
  expect(audio.currentTime).toBeCloseTo(12, 1);

  fireEvent.click(screen.getByRole('button', { name: /第一句/ }));
  fireEvent.click(screen.getByRole('button', { name: '4 句' }));
  expect(audio.currentTime).toBe(0);
  expect(screen.getByText(/逐句循环 · 第 1～1 句/)).toBeVisible();
});

it('开启跳过 Rap 后全曲播放自动跳到区间之后，关闭后不再跳', () => {
  render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections })} />);
  const audio = loadMedia();
  fireEvent.click(screen.getByRole('button', { name: '跳过 Rap' }));

  audio.currentTime = 30;
  fireEvent.timeUpdate(audio);
  expect(audio.currentTime).toBeCloseTo(37.03, 2);

  fireEvent.click(screen.getByRole('button', { name: '跳过 Rap' }));
  audio.currentTime = 30;
  fireEvent.timeUpdate(audio);
  expect(audio.currentTime).toBeCloseTo(30, 2);
});

it('逐句循环期间不自动跳 Rap，并说明原因', () => {
  render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections })} />);
  const audio = loadMedia();
  fireEvent.click(screen.getByRole('button', { name: '跳过 Rap' }));
  fireEvent.click(screen.getByRole('button', { name: /第六句/ }));
  fireEvent.click(screen.getByRole('button', { name: '2 句' }));
  expect(screen.getByText(/逐句练习不自动跳 Rap/)).toBeVisible();
  audio.currentTime = 12;
  fireEvent.timeUpdate(audio);
  expect(audio.currentTime).toBeCloseTo(12, 1);
});

it('合练一遍从头播放、自动开跳过 Rap、关闭全曲循环，到结尾停止', () => {
  render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections })} />);
  const audio = loadMedia();
  fireEvent.click(screen.getByRole('button', { name: '单曲循环' }));
  expect(audio.loop).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: '合练一遍' }));
  expect(audio.currentTime).toBe(0);
  expect(audio.loop).toBe(false);
  expect(screen.getByRole('button', { name: '跳过 Rap' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: '单曲循环' })).toHaveAttribute('aria-pressed', 'false');
  expect(play).toHaveBeenCalled();

  fireEvent.ended(audio);
  expect(screen.getByText(/自由练习 · 合练一遍完成/)).toBeVisible();
});

it('练习设置可改前后跳秒数与自定义句数，并同时落到本机缓存和同曲 practice 字段', async () => {
  const item = vocalItem({ tracks: { original: { media: media('orig') } }, lyrics });
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([item]));
  render(<VocalPracticePlayer item={item} />);
  const audio = loadMedia();
  fireEvent.click(screen.getByRole('button', { name: '练习设置' }));
  const dialog = screen.getByRole('dialog', { name: '练习设置' });
  fireEvent.click(within(within(dialog).getByRole('group', { name: '后退秒数' })).getByRole('button', { name: '15 秒' }));
  fireEvent.click(within(within(dialog).getByRole('group', { name: '前进秒数' })).getByRole('button', { name: '30 秒' }));
  fireEvent.click(within(within(dialog).getByRole('group', { name: '自定义回退句数' })).getByRole('button', { name: '3 句' }));
  fireEvent.click(within(dialog).getByRole('button', { name: '完成' }));
  expect(screen.queryByRole('dialog', { name: '练习设置' })).not.toBeInTheDocument();

  expect(screen.getByRole('button', { name: '后退 15 秒' })).toBeVisible();
  expect(screen.getByText('自定义 3 句')).toBeVisible();

  audio.currentTime = 40;
  fireEvent.timeUpdate(audio);
  fireEvent.click(screen.getByRole('button', { name: '后退 15 秒' }));
  expect(audio.currentTime).toBeCloseTo(25, 1);
  expect(JSON.parse(localStorage.getItem('dance.vocal-practice.settings.vocal-1') || '{}')).toMatchObject({ backwardSeconds: 15, forwardSeconds: 30, customRepeatLines: 3 });

  await waitFor(() => {
    const stored = JSON.parse(readMetadata('dance.repertoire-snapshot') || '[]') as TalentItem[];
    expect(stored[0]?.practice).toMatchObject({ backwardSeconds: 15, forwardSeconds: 30, customRepeatLines: 3 });
  }, { timeout: 3000 });
});

it('已有 practice 字段时按曲目恢复，不读别的歌的设置', () => {
  const item = vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, practice: { skipRap: false, wholeTrackLoop: false, backwardSeconds: 30, forwardSeconds: 5, customRepeatLines: 6, playbackRate: 1.25 } });
  localStorage.setItem('dance.vocal-practice.settings.other', JSON.stringify({ backwardSeconds: 5, forwardSeconds: 10, customRepeatLines: 2, playbackRate: 1 }));
  render(<VocalPracticePlayer item={item} />);
  expect(screen.getByRole('button', { name: '后退 30 秒' })).toBeVisible();
  expect(screen.getByText('自定义 6 句')).toBeVisible();
});

it('切轨复用统一切换逻辑：保持当前位置、播放状态与音轨选择', async () => {
  const tracks = { original: { media: media('orig') }, accompaniment: { media: media('acc') } };
  render(<VocalPracticePlayer item={vocalItem({ tracks, lyrics })} />);
  const audio = loadMedia();
  expect(audio.getAttribute('src')).toContain('/api/media/audio/orig');

  audio.currentTime = 12;
  Object.defineProperty(audio, 'paused', { configurable: true, get: () => false });
  fireEvent.play(audio);
  fireEvent.click(screen.getByRole('button', { name: '伴奏' }));

  await waitFor(() => expect(audio.getAttribute('src')).toContain('/api/media/audio/acc'));
  loadMedia();
  await waitFor(() => expect(audio.currentTime).toBeCloseTo(12, 1));
  expect(play).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: '伴奏' })).toHaveAttribute('aria-pressed', 'true');
});

it('切轨失败时回滚原轨并明确提示，不静默换歌', async () => {
  const tracks = { original: { media: media('orig') }, accompaniment: { media: media('acc') } };
  render(<VocalPracticePlayer item={vocalItem({ tracks, lyrics })} />);
  const audio = loadMedia();
  audio.currentTime = 8;
  fireEvent.timeUpdate(audio);

  fireEvent.click(screen.getByRole('button', { name: '伴奏' }));
  await waitFor(() => expect(audio.getAttribute('src')).toContain('/api/media/audio/acc'));
  fireEvent.error(audio);

  await waitFor(() => expect(audio.getAttribute('src')).toContain('/api/media/audio/orig'));
  loadMedia();
  await waitFor(() => expect(screen.getByText(/已保留原音轨/)).toBeVisible());
  expect(screen.getByRole('button', { name: '原唱' })).toHaveAttribute('aria-pressed', 'true');
});

it('切轨按两条音轨各自的 offset 还原到同一歌词位置', async () => {
  const tracks = { original: { media: media('orig'), offsetMs: 500 }, accompaniment: { media: media('acc'), offsetMs: 1000 } };
  render(<VocalPracticePlayer item={vocalItem({ tracks, lyrics })} />);
  const audio = loadMedia();
  audio.currentTime = 2;
  fireEvent.timeUpdate(audio);

  fireEvent.click(screen.getByRole('button', { name: '伴奏' }));
  await waitFor(() => expect(audio.getAttribute('src')).toContain('/api/media/audio/acc'));
  loadMedia();
  // 歌词时间轴 1500ms：原唱文件 2.0s（offset 500）→ 伴奏文件 2.5s（offset 1000）。
  await waitFor(() => expect(audio.currentTime).toBeCloseTo(2.5, 2));
});

it('切轨前已暂停时，切轨后仍保持暂停', async () => {
  const tracks = { original: { media: media('orig') }, accompaniment: { media: media('acc') } };
  render(<VocalPracticePlayer item={vocalItem({ tracks, lyrics })} />);
  const audio = loadMedia();
  audio.currentTime = 21;
  fireEvent.timeUpdate(audio);
  fireEvent.click(screen.getByRole('button', { name: '伴奏' }));
  await waitFor(() => expect(audio.getAttribute('src')).toContain('/api/media/audio/acc'));
  loadMedia();
  await waitFor(() => expect(audio.currentTime).toBeCloseTo(21, 1));
  expect(play).not.toHaveBeenCalled();
});

it('只有原唱时伴奏不可选并显示未提供，不做假切换', () => {
  render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics })} />);
  expect(screen.getByRole('button', { name: '伴奏（未提供）' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '原唱' })).toHaveAttribute('aria-pressed', 'true');
});

it('缺失练唱数据时兼容旧音频与纯文本：单轨可播、逐句循环禁用并提示校准', () => {
  render(<VocalPracticePlayer item={vocalItem({ audio: media('legacy'), audioRole: 'ACCOMPANIMENT', scoreText: '第一行歌词\n第二行歌词' })} />);
  expect(screen.getByRole('button', { name: '伴奏' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: '原唱（未提供）' })).toBeDisabled();
  expect(screen.getByText(/纯文本歌词/)).toBeVisible();
  expect(screen.getByRole('button', { name: '2 句' })).toBeDisabled();
  expect(screen.getByText('第一行歌词')).toBeVisible();
});

it('完全没有音轨时给出明确提示并可引导导入，纯文本仍可读', () => {
  const onRequestImport = vi.fn();
  render(<VocalPracticePlayer item={vocalItem({ scoreText: '只有歌词' })} onRequestImport={onRequestImport} />);
  expect(screen.getByText(/还没有原唱或伴奏音轨/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '导入音频' }));
  expect(onRequestImport).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '合练一遍' })).toBeDisabled();
});

it('旧音频用途无法识别时不猜测轨道，提示补充用途', () => {
  render(<VocalPracticePlayer item={vocalItem({ audio: media('legacy'), audioRole: 'MIXED' as 'REFERENCE' })} />);
  expect(screen.getByText(/用途未标注/)).toBeVisible();
  expect(screen.getByRole('button', { name: '原唱（未提供）' })).toBeDisabled();
});

it('唱歌详情使用练唱播放器并提供同曲补录入口，吉他详情保留原播放控件', async () => {
  const vocal = vocalItem({ id: 'vocal-page', tracks: { original: { media: media('orig') } }, lyrics, sections });
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([vocal]));
  const view = render(<MemoryRouter initialEntries={['/repertoire/item/vocal-page']}><Routes><Route path="/repertoire/item/:id" element={<TalentDetailPage />} /></Routes></MemoryRouter>);
  expect(await screen.findByRole('group', { name: '练唱播放器' })).toBeVisible();
  expect(screen.getByRole('heading', { name: '补录音轨与歌词' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '播放音乐' })).not.toBeInTheDocument();
  view.unmount();

  const guitar: TalentItem = { ...vocalItem({ id: 'guitar-page', kind: 'GUITAR', audio: media('guitar-audio'), audioRole: 'ACCOMPANIMENT', scoreText: '[C]第一行' }) };
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([guitar]));
  render(<MemoryRouter initialEntries={['/repertoire/item/guitar-page']}><Routes><Route path="/repertoire/item/:id" element={<TalentDetailPage />} /></Routes></MemoryRouter>);
  expect(await screen.findByRole('button', { name: '播放音乐' })).toBeVisible();
  expect(screen.queryByRole('group', { name: '练唱播放器' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '补录音轨与歌词' })).not.toBeInTheDocument();
});
