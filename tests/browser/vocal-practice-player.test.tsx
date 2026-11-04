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
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // 沉浸入口由 URL 决定，用例结束必须复位，避免把 ?immersive=1 带给后续用例。
  window.history.replaceState({}, '', '/');
});

it('歌曲地图按段落渲染并可跳转，重复旋律标明来源段', () => {
  render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections })} />);
  expect(screen.getByRole('heading', { name: '歌曲地图' })).toBeVisible();
  expect(screen.getByText('4 段')).toBeVisible();
  // A2/B2 的重复关系写在地图按钮的无障碍标签里，避免小屏塞满文字。
  expect(screen.getByRole('button', { name: /跳到 B2.*旋律同 B1、歌词不同/ })).toBeVisible();
  const audio = loadMedia();
  fireEvent.click(screen.getByRole('button', { name: /跳到 R1/ }));
  expect(audio.currentTime).toBeCloseTo(29, 1);
});

it('整段循环从段首播到段尾回到段首，再点一次退出', () => {
  render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections })} />);
  const audio = loadMedia();
  fireEvent.click(screen.getByRole('button', { name: /跳到 B1/ }));
  fireEvent.click(screen.getByRole('button', { name: '整段循环' }));
  expect(screen.getByText(/整段循环 · B1/)).toBeVisible();
  expect(audio.currentTime).toBeCloseTo(6, 1);

  audio.currentTime = 20.5;
  fireEvent.timeUpdate(audio);
  expect(audio.currentTime).toBeCloseTo(6, 1);

  fireEvent.click(screen.getByRole('button', { name: '退出整段循环' }));
  expect(screen.queryByText(/整段循环 · B1/)).not.toBeInTheDocument();
  audio.currentTime = 25;
  fireEvent.timeUpdate(audio);
  expect(audio.currentTime).toBeCloseTo(25, 1);
});

it('播放中设置逐句循环不打断播放，暂停后设置只定位', () => {
  render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections })} />);
  const audio = loadMedia();
  fireEvent.click(screen.getByRole('button', { name: '播放' }));
  fireEvent.play(audio); // jsdom 的 play() 是桩，不派发事件；补上真实浏览器会有的 play 事件
  play.mockClear();

  fireEvent.click(screen.getByRole('button', { name: /第 5 句/ }));
  fireEvent.click(screen.getByRole('button', { name: '2 句' }));
  expect(play).toHaveBeenCalled();
  expect(screen.getByText(/循环第 4～5 句/)).toBeVisible();

  play.mockClear();
  fireEvent.click(screen.getByRole('button', { name: '暂停' }));
  fireEvent.pause(audio);
  audio.currentTime = 12;
  fireEvent.timeUpdate(audio);
  fireEvent.click(screen.getByRole('button', { name: '2 句' }));
  expect(play).not.toHaveBeenCalled();
});

it('只看本段歌词只显示该段句子，切回后恢复全部', () => {
  render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections })} />);
  loadMedia();
  fireEvent.click(screen.getByRole('button', { name: /跳到 B1/ }));
  fireEvent.click(screen.getByRole('button', { name: '只看本段歌词' }));
  expect(screen.getByRole('button', { name: /第三句/ })).toBeVisible();
  expect(screen.queryByRole('button', { name: /第一句/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '显示全部歌词' }));
  expect(screen.getByRole('button', { name: /第一句/ })).toBeVisible();
});

it('算法写入的 Rap 段显示待确认且不参与自动跳过', () => {
  const algorithmic = [
    section({ id: 'r1', type: 'rap', label: 'R1', startMs: 29000, endMs: 37000, source: 'algorithm' }),
    section({ id: 'a1', type: 'verse', label: 'A1', startMs: 0, endMs: 29000 }),
  ];
  render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections: algorithmic })} />);
  expect(screen.getByText(/1 段 Rap 为待确认/)).toBeVisible();
  /* 没有已确认的 Rap 段时按钮不再禁用：点它直接打开「地图与结构」并给出确认路径，
     用户自己决定把哪一段标成 Rap。 */
  const skipRap = screen.getByRole('button', { name: '跳过 Rap' });
  expect(skipRap).not.toBeDisabled();
  fireEvent.click(skipRap);
  expect(screen.getByText(/1 段 Rap 还未确认/)).toBeVisible();
  expect(screen.getByRole('dialog', { name: '地图抽屉' })).toBeVisible();
  expect(screen.getByText('待确认')).toBeVisible();
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
  const dialog = screen.getByRole('dialog', { name: '循环与练习设置' });
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

/** 沉浸页布局契约：歌词区与播放器必须同属一个竖向流容器，播放器不再用占位块压在歌词上。 */
it('曲库直达沉浸：地图收起，歌词区与播放器是同一容器的兄弟节点，不以占位块压住歌词', () => {
  window.history.replaceState({}, '', '/?immersive=1');
  const view = render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections })} />);
  const root = view.container.querySelector('.vocal-practice');
  expect(root).not.toBeNull();
  expect(root!.className).toContain('is-immersive');
  expect(screen.getByRole('button', { name: '退出沉浸' })).toBeVisible();
  // 沉浸页收起歌曲地图，把整块高度让给歌词
  expect(screen.queryByRole('heading', { name: '歌曲地图' })).not.toBeInTheDocument();
  const lyricBlock = view.container.querySelector('.vocal-lyrics')!.closest('.vocal-block');
  const dock = screen.getByRole('group', { name: '练唱播放器' });
  // 真实独立布局：两者是同一父容器下的兄弟，播放器排在歌词之后（流内占位，非覆盖）
  expect(lyricBlock!.parentElement).toBe(dock.parentElement);
  expect(dock.compareDocumentPosition(lyricBlock!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  // 沉浸页不再需要给 fixed 播放器留占位块
  expect(view.container.querySelector('.vocal-dock-spacer')).toBeNull();
  view.unmount();
  window.history.replaceState({}, '', '/');
});

/** 沉浸页按练歌原型整改后的契约：顶栏、段落标签条、分组歌词、底部三排控制。 */
function renderImmersive(item: TalentItem) {
  window.history.replaceState({}, '', '/?immersive=1');
  return render(<VocalPracticePlayer item={item} />);
}

const translationsDoc = {
  language: 'zh' as const,
  source: 'ai' as const,
  lines: lyrics.map((line, index) => ({ id: line.id, text: `译文${index + 1}`, source: 'ai' as const })),
};

it('沉浸页顶栏：返回/歌名/歌手/地图/更多齐备，地图一击开抽屉再击关回歌词', () => {
  const view = renderImmersive(vocalItem({ artist: '宋雨琦', tracks: { original: { media: media('orig') } }, lyrics, sections }));
  expect(screen.getByRole('button', { name: '退出沉浸' })).toBeVisible();
  expect(screen.getByRole('heading', { name: '海风来信' })).toBeVisible();
  expect(screen.getByText('宋雨琦')).toBeVisible();
  expect(screen.getByRole('button', { name: '更多' })).toBeVisible();
  const segments = screen.getByRole('group', { name: '段落标签' });
  expect(within(segments).getByRole('button', { name: /跳到 A1 主歌/ })).toBeVisible();
  expect(within(segments).getByRole('button', { name: /跳到 B1 副歌/ })).toBeVisible();

  // 地图是沉浸页唯一的结构入口：一击打开，再击关回歌词。
  const map = screen.getByRole('button', { name: '地图' });
  expect(map).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(map);
  expect(screen.getByRole('dialog', { name: '地图抽屉' })).toBeVisible();
  expect(map).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(map);
  expect(screen.queryByRole('dialog', { name: '地图抽屉' })).not.toBeInTheDocument();

  // 段落标签条仍可收起，但入口收到「更多」里，避免和地图抢同一排。
  fireEvent.click(screen.getByRole('button', { name: '更多' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: '更多' })).getByRole('button', { name: '收起段落标签' }));
  expect(screen.queryByRole('group', { name: '段落标签' })).not.toBeInTheDocument();
  view.unmount();
});

it('沉浸页歌词按结构分组：段标题 + 横线，点句定位并高亮，双语可关', () => {
  const view = renderImmersive(vocalItem({
    language: 'ko', translations: translationsDoc,
    tracks: { original: { media: media('orig') } }, lyrics, sections,
  }));
  const audio = loadMedia();
  expect(screen.getByText('A1 · 主歌')).toBeVisible();
  expect(screen.getByText('B1 · 副歌')).toBeVisible();
  // 只按结构分组，不给同一段重复造标题
  expect(view.container.querySelectorAll('.vocal-lyric-group__title')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: /第 3 句/ }));
  expect(audio.currentTime).toBeCloseTo(8, 1);
  expect(screen.getByRole('button', { name: /第 3 句/ })).toHaveAttribute('aria-current', 'true');
  expect(screen.getByText('译文3')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '双语' }));
  expect(screen.queryByText('译文3')).not.toBeInTheDocument();
  view.unmount();
});

it('沉浸页上下句按歌词时间轴逐句定位，不伪造句尾时间', () => {
  const view = renderImmersive(vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections }));
  const audio = loadMedia();
  fireEvent.click(screen.getByRole('button', { name: '下一句' }));
  expect(audio.currentTime).toBeCloseTo(4, 1);
  fireEvent.click(screen.getByRole('button', { name: '下一句' }));
  expect(audio.currentTime).toBeCloseTo(8, 1);
  fireEvent.click(screen.getByRole('button', { name: '上一句' }));
  expect(audio.currentTime).toBeCloseTo(4, 1);
  view.unmount();
});

it('沉浸页自定义句数、本段循环、合练都接现有练习逻辑', () => {
  const view = renderImmersive(vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections }));
  const audio = loadMedia();
  fireEvent.click(screen.getByRole('button', { name: /第 5 句/ }));
  fireEvent.click(screen.getByRole('button', { name: /自定义循环句数/ }));
  fireEvent.click(screen.getByRole('button', { name: '3 句' }));
  expect(audio.currentTime).toBeCloseTo(8, 1);
  expect(screen.getByText(/逐句循环 · 第 3～5 句/)).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: '本段循环' }));
  expect(screen.getByText(/整段循环 · B1/)).toBeVisible();
  expect(audio.currentTime).toBeCloseTo(6, 1);

  fireEvent.click(screen.getByRole('button', { name: '合练一遍' }));
  expect(audio.currentTime).toBe(0);
  expect(screen.getByRole('button', { name: '跳过 Rap' })).toHaveAttribute('aria-pressed', 'true');
  view.unmount();
});

it('沉浸页倍速按钮循环切换、字号按钮切换歌词字号并记住', () => {
  const view = renderImmersive(vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections }));
  const audio = loadMedia();
  fireEvent.click(screen.getByRole('button', { name: /倍速，当前 1 倍/ }));
  expect(screen.getByRole('button', { name: /倍速，当前 1.25 倍/ })).toBeVisible();
  expect(audio.playbackRate).toBe(1.25);

  const lyricsBox = view.container.querySelector('.vocal-lyrics') as HTMLElement;
  expect(lyricsBox.className).toContain('vocal-lyrics--normal');
  fireEvent.click(screen.getByRole('button', { name: '字号：标准' }));
  expect(lyricsBox.className).toContain('vocal-lyrics--large');
  expect(screen.getByRole('button', { name: '字号：大' })).toBeVisible();
  expect(localStorage.getItem('dance.vocal-practice.font-size')).toBe('large');
  view.unmount();
});

it('沉浸页「更多」保留音轨切换与译文纠错，缺轨时按钮禁用不假装可切', () => {
  const view = renderImmersive(vocalItem({
    language: 'ko', translations: translationsDoc,
    tracks: { original: { media: media('orig') } }, lyrics, sections,
  }));
  loadMedia();
  fireEvent.click(screen.getByRole('button', { name: '更多' }));
  const dialog = screen.getByRole('dialog', { name: '更多' });
  expect(within(dialog).getByRole('button', { name: '原唱' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(dialog).getByRole('button', { name: '伴奏（未提供）' })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole('button', { name: '纠错当前句译文' }));
  expect(screen.queryByRole('dialog', { name: '更多' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '第 1 句中文译文' })).toHaveValue('译文1');
  view.unmount();
});

/**
 * 用户原型要求底部文字完整。工具行曾在 381–430px 宽度下把「⇄ 循环设置」挤出按钮盒、压到「1×」上
 * （CSS 已改 minmax(auto, 1fr)）；这里锁住五键文案不被缩写，以及 2 句/4 句、循环设置的真实连线。
 */
it('沉浸页 2句/4句与循环设置都接现有循环逻辑，工具行五键文案完整', () => {
  const view = renderImmersive(vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections }));
  const audio = loadMedia();
  fireEvent.click(screen.getByRole('button', { name: /第 5 句/ }));
  expect(audio.currentTime).toBeCloseTo(16, 1);

  fireEvent.click(screen.getByRole('button', { name: '循环 2 句' }));
  expect(audio.currentTime).toBeCloseTo(12, 1);
  expect(screen.getByText(/逐句循环 · 第 4～5 句/)).toBeVisible();
  expect(screen.getByRole('button', { name: '循环 2 句' })).toHaveAttribute('aria-pressed', 'true');

  fireEvent.click(screen.getByRole('button', { name: '循环 4 句' }));
  expect(audio.currentTime).toBeCloseTo(0, 1);
  expect(screen.getByText(/逐句循环 · 第 1～4 句/)).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: '循环设置' }));
  const sheet = screen.getByRole('dialog', { name: '循环与练习设置' });
  // 「循环」分组与「自定义回退句数」分组都有「2 句」，这里只看第一个分组
  const loopGroup = sheet.querySelector('fieldset') as HTMLElement;
  for (const name of ['2 句', '4 句', '自定义 4 句', '本段循环', '整首循环', '关闭循环']) {
    expect(within(loopGroup).getByRole('button', { name })).toBeVisible();
  }
  fireEvent.click(within(sheet).getByRole('button', { name: '关闭练习设置' }));

  const tools = screen.getByRole('group', { name: '练习工具' });
  const labels = within(tools).getAllByRole('button').map((button) => (button.textContent || '').trim());
  expect(labels).toEqual(['↺ 重播', '⇄ 循环设置', '1×', '双语', 'Aa']);
  for (const label of labels) expect(label).not.toContain('…');
  view.unmount();
});

it('沉浸页「更多」里的翻译缺失按钮走真实接口，不伪造译文', async () => {
  // 译文统计会跳过中文行，所以这里用韩文原文，才能形成「6 句缺译」的真实状态。
  const korean = ['바람이 내게 말을 걸어', '작은 햇살이 창에 내려', '오늘의 길을 천천히 걸어', '어디선가 노래가 들려', '우리 함께라면 더 좋아', '서로의 웃음을 기억해'];
  const koreanLyrics = lyrics.map((line, index) => ({ ...line, text: korean[index] }));
  const item = vocalItem({ language: 'ko', lyrics: koreanLyrics, tracks: { original: { media: media('orig') } }, sections });
  writeMetadata('dance.repertoire-snapshot', JSON.stringify([item]));
  const translated = {
    ...item,
    translations: { version: 1, language: 'zh', source: 'ai', lines: koreanLyrics.map((line) => ({ id: line.id, text: `译：${line.text}`, source: 'ai' })) },
  };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    status: 'COMPLETE', translated: 6, cached: 0, lrcReused: 0, remaining: 0, failed: [], item: translated,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  const view = renderImmersive(item);
  loadMedia();
  fireEvent.click(screen.getByRole('button', { name: '更多' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: '更多' })).getByRole('button', { name: '翻译缺失 6 句' }));
  await waitFor(() => expect(screen.getByText(/已翻译 6 句/)).toBeVisible());
  // 落盘是异步的：提示先出现，快照要等一下再读，避免并行跑时抢跑。
  await waitFor(() => {
    const snapshot = JSON.parse(localStorage.getItem('dance.repertoire-snapshot') || '[]') as TalentItem[];
    expect(snapshot[0]?.translations?.lines).toHaveLength(6);
  }, { timeout: 3000 });
  view.unmount();
});

it('沉浸页无结构、无歌词、无译文时安全兜底，不伪造分段与可用状态', () => {
  const plain = renderImmersive(vocalItem({ tracks: { original: { media: media('orig') } }, lyrics }));
  // 没有结构也要能进地图：进去打点，而不是给个按不动的按钮。
  const map = screen.getByRole('button', { name: '地图（暂无分段，可打点）' });
  expect(map).not.toBeDisabled();
  fireEvent.click(map);
  expect(screen.getByRole('dialog', { name: '地图抽屉' })).toBeVisible();
  expect(screen.getByText(/这首歌还没有段落/)).toBeVisible();
  expect(screen.getByRole('button', { name: /播放位置打点/ })).toBeVisible();
  fireEvent.click(map);
  expect(screen.queryByRole('dialog', { name: '地图抽屉' })).not.toBeInTheDocument();

  expect(screen.queryByRole('group', { name: '段落标签' })).not.toBeInTheDocument();
  expect(document.querySelector('.vocal-lyric-group__title')).toBeNull();
  expect(screen.getByRole('button', { name: /第 1 句/ })).toBeVisible();
  expect(screen.getByRole('button', { name: '双语（暂无译文）' })).toBeDisabled();
  plain.unmount();

  const empty = renderImmersive(vocalItem({ tracks: { original: { media: media('orig') } } }));
  expect(screen.getByText(/还没有歌词/)).toBeVisible();
  expect(screen.getByRole('button', { name: '上一句' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '下一句' })).toBeDisabled();
  empty.unmount();
});

/* 用户要求：沉浸页最下面不要再常驻「自由练习」四个字，把那行空间让给歌词；
   只有真的有提示（逐句练习不跳 Rap、或一次操作提示）时才出现状态行。 */
it('沉浸页不常驻「自由练习」状态行，只有真有提示时才出现', () => {
  const view = renderImmersive(vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections }));
  expect(view.container.querySelector('.vocal-dock__mode')).toBeNull();
  const practice = view.container.querySelector('.vocal-immersive__practice') as HTMLElement;
  const rap = within(practice).getByRole('button', { name: /Rap/ });
  /* 这首歌有已确认的 Rap 段：点一下只切换开关，不产生状态行，歌词区不再被那行占掉。 */
  fireEvent.click(rap);
  expect(rap).toHaveAttribute('aria-pressed', 'true');
  expect(view.container.querySelector('.vocal-dock__mode')).toBeNull();
});

/* 用户要求：没有已确认的 Rap 段时，点「跳Rap」要能把人带到怎么标 Rap 的地方。 */
it('沉浸页点「跳Rap」在没有已确认 Rap 段时打开地图与结构并给出确认路径', () => {
  const algorithmic = [
    section({ id: 'r1', type: 'rap', label: 'R1', startMs: 29000, endMs: 37000, source: 'algorithm' }),
    section({ id: 'a1', type: 'verse', label: 'A1', startMs: 0, endMs: 29000 }),
  ];
  const view = renderImmersive(vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections: algorithmic }));
  const practice = view.container.querySelector('.vocal-immersive__practice') as HTMLElement;
  fireEvent.click(within(practice).getByRole('button', { name: /Rap/ }));
  expect(screen.getByText(/1 段 Rap 还未确认/)).toBeVisible();
  expect(screen.getByRole('dialog', { name: '地图抽屉' })).toBeVisible();
});

it('详情页仍保留占位块，避免 fixed 播放器压住页面底部内容', () => {
  const view = render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics })} />);
  expect(view.container.querySelector('.vocal-dock-spacer')).not.toBeNull();
  expect(view.container.querySelector('.vocal-practice')!.className).not.toContain('is-immersive');
});

/** 用户痛点：旧版「跳过 Rap」「合练一遍」被挤成省略号。这里锁住分层与完整文案。 */
it('播放器控制分层完整：主控与练习按钮文案不被省略，倍速仍可直接切换', () => {
  render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections })} />);
  const transport = screen.getByRole('group', { name: '播放控制' });
  for (const name of ['重播', '后退 5 秒', '播放', '前进 10 秒', '单曲循环']) {
    expect(within(transport).getByRole('button', { name })).toBeVisible();
  }
  const practice = screen.getByRole('group', { name: '练习控制' });
  for (const name of ['跳过 Rap', '合练一遍', '练习设置']) {
    const button = within(practice).getByRole('button', { name });
    expect(button).toBeVisible();
    expect(button.textContent || '').not.toContain('…');
  }
  const rate = within(practice).getByRole('combobox', { name: '播放速度' });
  expect(rate).toHaveValue('1');
  fireEvent.change(rate, { target: { value: '1.25' } });
  expect(rate).toHaveValue('1.25');
});

/**
 * 用户痛点：401/旧服务报错被读成「本机没有参考」。
 * 这里按失败原因逐类断言：文案要说「查不到」，并且不得出现「没有已提供的参考」。
 */
/**
 * 用户痛点：歌词只有一小块可视高度，当前句滚出可视区就又被当成「被播放器挡住」。
 * 播放时只滚动歌词容器本身，把当前句带到中间；暂停时不干预用户手动滚动。
 */
it('播放时把当前句滚进歌词可视区，且只滚歌词容器', () => {
  const view = render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections })} />);
  const audio = loadMedia();
  const list = view.container.querySelector('.vocal-lyrics') as HTMLOListElement;
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });
  list.getBoundingClientRect = () => ({ top: 100, height: 200, bottom: 300, left: 0, right: 0, width: 0, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;

  fireEvent.click(screen.getByRole('button', { name: /第三句/ }));
  const active = view.container.querySelector('.vocal-line--active')!.closest('li') as HTMLLIElement;
  active.getBoundingClientRect = () => ({ top: 520, height: 40, bottom: 560, left: 0, right: 0, width: 0, x: 0, y: 520, toJSON: () => ({}) }) as DOMRect;

  expect(list.scrollTop).toBe(0);
  fireEvent.play(audio);
  // 520 - 100（相对容器顶）+ 0（已滚动量）- 80（居中偏移）= 340
  expect(list.scrollTop).toBe(340);

  fireEvent.pause(audio);
  list.scrollTop = 600;
  fireEvent.timeUpdate(audio);
  expect(list.scrollTop).toBe(600);
});

/**
 * 真机复现（1.1.14）：歌词滚回顶部后把进度点到 0:44，第 7 句已经是 DOM active，
 * 但它停在可视区最底部（y≈579）被播放器（y≈593）压住，scrollTop 仍是 0 —— 高亮有了，句子没看见。
 * 这里用真实几何复现：暂停状态下只做定位，必须滚动歌词容器本身，且整句落在可视区内。
 */
it('暂停时定位到当前句也把整句滚进可视区，而不是只改高亮', () => {
  const longLyrics = Array.from({ length: 10 }, (_, index) => line(index * 4000, `第${index + 1}句`));
  const view = render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics: longLyrics, sections })} />);
  const audio = loadMedia();
  const list = view.container.querySelector('.vocal-lyrics') as HTMLOListElement;
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1800 });
  list.getBoundingClientRect = () => ({ top: 100, height: 200, bottom: 300, left: 0, right: 0, width: 0, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
  // 第 n 句在页面坐标 120 + n×80，高 60：第 7 句 top≈600，相对容器顶 500，早就越过 200 的可视高度。
  [...view.container.querySelectorAll('.vocal-lyric-item')].forEach((item, index) => {
    const top = 120 + index * 80;
    item.getBoundingClientRect = () => ({ top, height: 60, bottom: top + 60, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  });

  expect(list.scrollTop).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: /第7句/ }));

  // 定位后必须真的滚了：500（相对容器顶）- 70（居中偏移）= 430；不是 0，也不是只加 active 类。
  expect(list.scrollTop).toBe(430);
  const active = view.container.querySelector('.vocal-line--active');
  expect(active).not.toBeNull();
  expect(active!.textContent).toContain('第7句');
  const topInList = 500 - list.scrollTop;
  expect(topInList).toBeGreaterThanOrEqual(0);
  expect(topInList + 60).toBeLessThanOrEqual(200);
  // 可证伪：暂停且没有定位时不动用户滚动位置。
  fireEvent.pause(audio);
  list.scrollTop = 120;
  fireEvent.timeUpdate(audio);
  expect(list.scrollTop).toBe(120);
});

/**
 * 用户痛点：边播边被自动滚动拽回当前句，手动往上翻根本读不了上一段。
 * 规则：手动滚动后停止跟随，直到用户自己再点句/上下句/进度条。
 */
it('手动滚动歌词后播放不再抢滚动位置，下一次明确跳句才恢复跟随', () => {
  const longLyrics = Array.from({ length: 10 }, (_, index) => line(index * 4000, `第${index + 1}句`));
  const view = render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics: longLyrics, sections })} />);
  const audio = loadMedia();
  const list = view.container.querySelector('.vocal-lyrics') as HTMLOListElement;
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1800 });
  list.getBoundingClientRect = () => ({ top: 100, height: 200, bottom: 300, left: 0, right: 0, width: 0, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
  [...view.container.querySelectorAll('.vocal-lyric-item')].forEach((item, index) => {
    const top = 120 + index * 80;
    item.getBoundingClientRect = () => ({ top, height: 60, bottom: top + 60, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  });

  fireEvent.play(audio);
  fireEvent.touchStart(list);
  list.scrollTop = 600;
  audio.currentTime = 24; // 第 7 句
  fireEvent.timeUpdate(audio);
  // 当前句换了三句，但用户已经手动滚开：滚动位置必须原样保留。
  expect(list.scrollTop).toBe(600);

  fireEvent.change(screen.getByRole('slider', { name: '播放进度' }), { target: { value: '32000' } });
  // 明确拖动进度：恢复跟随，把第 9 句（相对容器顶 660）带到中间。
  expect(list.scrollTop).toBe(660 + 600 - 70);
});

/**
 * 旧结构把 label 存成类型名（“主歌”）：界面会变成「主歌 主歌」「主歌 · 主歌」。
 * 只在显示层按类型/顺序规范成 A1 主歌；未知仍是「待标注」；持久化结构一个字都不改。
 */
it('旧结构 label 为类型名时显示层规范成 A1 主歌，且不改持久化结构', () => {
  const legacy: VocalSection[] = [
    section({ id: 'l1', type: 'intro', label: '前奏', startMs: 0, endMs: 4000 }),
    section({ id: 'l2', type: 'verse', label: '主歌', startMs: 4000, endMs: 20000 }),
    section({ id: 'l3', type: 'unknown', label: '待标注', startMs: 20000, endMs: 26000 }),
  ];
  const item = vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections: legacy });
  render(<VocalPracticePlayer item={item} />);

  // 地图与段标题都按「编号 + 类型」显示，且编号来自类型与顺序，不是把旧 label 原样拼上去。
  expect(screen.getByRole('button', { name: /跳到 A1 主歌/ })).toBeVisible();
  expect(screen.getByText('A1 · 主歌')).toBeVisible();
  expect(screen.queryByText(/主歌 主歌/)).not.toBeInTheDocument();
  expect(screen.queryByText(/主歌 · 主歌/)).not.toBeInTheDocument();
  // 前奏不重复显示两遍。
  expect(screen.queryByText(/前奏 前奏/)).not.toBeInTheDocument();
  // 未知类型保持「待标注」，不冒充主歌/副歌。
  expect(screen.getByRole('button', { name: /跳到 U1 待标注/ })).toBeVisible();
  // 显示层归一化不落回数据：持久化结构保持原样。
  expect(item.sections).toBe(legacy);
  expect(item.sections?.map((entry) => entry.label)).toEqual(['前奏', '主歌', '待标注']);
});

it('参考目录 401 时明确说明查不到，不冒充「本机没有参考」', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'unauthorized' } }) })));
  render(<VocalPracticePlayer item={vocalItem({ lyrics })} />);
  const banner = await screen.findByText(/参考目录需要授权（服务返回 401）/);
  expect(banner).toBeVisible();
  expect(banner.textContent).toContain('不等于没有参考');
  expect(screen.queryByText(/没有已提供的参考/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重新核对' })).toBeVisible();
});

it('旧服务没有参考目录接口时说明「查不到」，而不是「没有参考」', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: { message: 'Not Found' } }) })));
  render(<VocalPracticePlayer item={vocalItem({ lyrics })} />);
  const banner = await screen.findByText(/没有参考目录接口（返回 404）/);
  expect(banner.textContent).toContain('不等于没有参考');
  expect(screen.queryByText(/没有已提供的参考/)).not.toBeInTheDocument();
});

it('唱歌详情使用练唱播放器并提供同曲补录入口，吉他详情保留原播放控件', async () => {  const vocal = vocalItem({ id: 'vocal-page', tracks: { original: { media: media('orig') } }, lyrics, sections });
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

/* ===== V1.3-R2：地图入口、循环同键开关与范围高亮、沉浸页左右信息 ===== */

it('同键二次点击退出逐句循环：不 seek、不暂停、不重开播', () => {
  render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections })} />);
  const audio = loadMedia();
  fireEvent.click(screen.getByRole('button', { name: /第五句/ }));
  fireEvent.click(screen.getByRole('button', { name: '2 句' }));
  expect(audio.currentTime).toBeCloseTo(12, 1);
  expect(screen.getByText(/循环第 4～5 句/)).toBeVisible();

  // 播到范围中段再点同一个键：应当原地取消，不跳回句首
  audio.currentTime = 14.2;
  fireEvent.timeUpdate(audio);
  play.mockClear();
  fireEvent.click(screen.getByRole('button', { name: '2 句' }));
  expect(audio.currentTime).toBeCloseTo(14.2, 1);
  expect(play).not.toHaveBeenCalled();
  expect(screen.queryByText(/循环第 4～5 句/)).not.toBeInTheDocument();
  expect(screen.getByText(/已退出逐句循环/)).toBeVisible();
  expect(screen.getByRole('button', { name: '2 句' })).toHaveAttribute('aria-pressed', 'false');
});

it('4 句与自定义循环同样支持同键退出，切换档位只保留一档', () => {
  render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections })} />);
  loadMedia();
  fireEvent.click(screen.getByRole('button', { name: /第六句/ }));

  fireEvent.click(screen.getByRole('button', { name: '4 句' }));
  expect(screen.getByRole('button', { name: '4 句' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: '2 句' }));
  expect(screen.getByRole('button', { name: '4 句' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: '2 句' })).toHaveAttribute('aria-pressed', 'true');

  fireEvent.click(screen.getByRole('button', { name: '2 句' }));
  expect(screen.queryByText(/循环第/)).not.toBeInTheDocument();
});

it('循环范围按 startIndex/endIndex 上色，当前句另有更强高亮', () => {
  render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections })} />);
  loadMedia();
  fireEvent.click(screen.getByRole('button', { name: /第五句/ }));
  fireEvent.click(screen.getByRole('button', { name: '2 句' }));

  expect(screen.getByRole('button', { name: /第四句/ })).toHaveClass('vocal-line--loop-range');
  expect(screen.getByRole('button', { name: /第五句/ })).toHaveClass('vocal-line--loop-range');
  expect(screen.getByRole('button', { name: /第三句/ })).not.toHaveClass('vocal-line--loop-range');
  // 定位到 12s，当前句是第 4 句：范围里再分出「正在唱」的那一句
  expect(screen.getByRole('button', { name: /第四句/ })).toHaveClass('vocal-line--loop-current');
  expect(screen.getByRole('button', { name: /第五句/ })).not.toHaveClass('vocal-line--loop-current');
});

it('沉浸页恢复左侧真实时标与右侧序号，中文歌不出现双语开关', () => {
  const view = renderImmersive(vocalItem({ language: 'zh', tracks: { original: { media: media('orig') } }, lyrics, sections }));
  const row = screen.getByRole('button', { name: /第三句/ });
  expect(within(row).getByText('0:08')).toBeVisible();
  expect(within(row).getByText('3')).toBeVisible();
  expect(screen.queryByRole('button', { name: /双语/ })).not.toBeInTheDocument();
  view.unmount();
});

it('沉浸页地图入口常驻：断网、无结构都能打开，且不中断播放', () => {
  const view = renderImmersive(vocalItem({ tracks: { original: { media: media('orig') } }, lyrics }));
  const audio = loadMedia();
  fireEvent.click(screen.getByRole('button', { name: '播放' }));
  fireEvent.play(audio);
  expect(screen.getByRole('button', { name: '暂停' })).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: '地图（暂无分段，可打点）' }));
  expect(screen.getByRole('dialog', { name: '地图抽屉' })).toBeVisible();
  // 开关地图不碰媒体：仍在播放态，位置没被重置
  expect(screen.getByRole('button', { name: '暂停' })).toBeVisible();
  expect(audio.currentTime).toBeCloseTo(0, 1);
  view.unmount();
});

it('循环范围是一个整框：首尾行带 is-loop-first/last，中间行左右边框连成一体', () => {
  render(<VocalPracticePlayer item={vocalItem({ tracks: { original: { media: media('orig') } }, lyrics, sections })} />);
  loadMedia();
  fireEvent.click(screen.getByRole('button', { name: /第六句/ }));
  fireEvent.click(screen.getByRole('button', { name: '4 句' }));

  const first = screen.getByRole('button', { name: /第三句/ });
  const middle = screen.getByRole('button', { name: /第四句/ });
  const last = screen.getByRole('button', { name: /第六句/ });
  expect(first).toHaveClass('vocal-line--loop-range', 'is-loop-first');
  expect(last).toHaveClass('vocal-line--loop-range', 'is-loop-last');
  expect(middle).toHaveClass('vocal-line--loop-range');
  expect(middle).not.toHaveClass('is-loop-first');
  expect(middle).not.toHaveClass('is-loop-last');
  // 框外的句子不被圈进去
  expect(screen.getByRole('button', { name: /第二句/ })).not.toHaveClass('vocal-line--loop-range');
});
