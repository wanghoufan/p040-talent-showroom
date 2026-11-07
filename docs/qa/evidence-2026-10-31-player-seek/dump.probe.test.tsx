/**
 * 临时取证用：把真实组件渲染出的沉浸页/地图抽屉 DOM 写成静态快照，
 * 交给 headless Chrome 量版式（不是产品测试，跑完即删）。
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { initializeLocalDatabase } from '../src/lib/local-database';
import VocalPracticePlayer from '../src/components/VocalPracticePlayer';
import type { MediaFile, TalentItem, TimedLyric, VocalSection, VocalTranslations } from '../src/lib/types';

const media = (id: string): MediaFile => ({ id, url: `/api/media/audio/${id}`, sha256: `sha-${id}`, sizeBytes: 10, version: 1, durationMs: 79000 });
const line = (startMs: number, text: string): TimedLyric => ({ id: `l-${startMs}`, startMs, text });

const texts = [
  ['언제나 꿈꿔 온 순간이', '一直梦想着的瞬间'],
  ['여기 지금 내게 시작되고 있어', '在这里，此刻正向我开始'],
  ['그렇게 너를 사랑했던', '那样爱过你的'],
  ['내 마음을 넌 받아 주었어', '我的心，你接受了'],
  ['오~ 내 기분만큼 밝은 태양과', 'Oh~ 和我心情一样明亮的太阳和'],
  ['시원한 바람들이 내게 다가와', '凉爽的风向我靠近'],
  ['머리 끝까지 짜릿한 이 기분', '从头到脚的这份心动'],
  ['하늘을 날아갈 것만 같아', '像是要飞上天空'],
  ['우리 함께라면 더 좋아', '只要我们在起就更美好'],
  ['서로의 웃음을 기억해', '记住彼此的笑容'],
];
const lyrics: TimedLyric[] = texts.map(([text], index) => line(index * 8000, text));
const translations: VocalTranslations = {
  version: 1, language: 'zh', source: 'manual',
  lines: texts.map(([, zh], index) => ({ id: `l-${index * 8000}`, text: zh, source: 'manual' as const })),
};
const sections: VocalSection[] = [
  { id: 's1', type: 'intro', label: '前奏', startMs: 0, endMs: 8000, source: 'manual' },
  { id: 's2', type: 'verse', label: '主歌', startMs: 8000, endMs: 79000, source: 'manual' },
];

function item(): TalentItem {
  return {
    id: 'vocal-1', kind: 'VOCAL', title: '여름 안에서 (Live)', artist: '宋雨琦,泳勋,Felix',
    learningStatus: 'PRACTICING', originalKey: 'C', performanceKey: 'C', capo: 0, scoreText: '', notes: '',
    audioRole: 'ACCOMPANIMENT', durationMs: 79000, tracks: { original: { media: media('orig') } },
    lyrics, sections, translations,
  } as TalentItem;
}

it('dump', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  vi.stubGlobal('indexedDB', new IDBFactory());
  await initializeLocalDatabase();
  window.history.replaceState({}, '', '/?immersive=1');
  const view = render(<VocalPracticePlayer item={item()} />);
  writeFileSync('.local/probe-seek/immersive.html', view.container.innerHTML, 'utf8');
  expect(screen.getByRole('button', { name: '分段' })).toBeVisible();

  window.history.replaceState({}, '', '/');
  const second = render(<VocalPracticePlayer item={item()} />);
  fireEvent.click(within(second.container).getByRole('button', { name: '地图抽屉' }));
  expect(within(second.container).getAllByText('歌曲分段').length).toBeGreaterThan(0);
  writeFileSync('.local/probe-seek/drawer.html', second.container.innerHTML, 'utf8');
});
