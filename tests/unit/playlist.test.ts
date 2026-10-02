import { expect, it } from 'vitest';
import { moveItem } from '../../src/lib/playlist';
import { isItemPlayable, type CachedIndex, type MediaEntry, mediaEntries } from '../../src/lib/offline-manifest';
import type { DanceItem } from '../../src/lib/types';

it('moveItem 保持其余顺序不变地重排', () => {
  expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b']); // 同位置不动
  expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']); // 越界不动
});

const item: DanceItem = {
  id: 'd1', title: '测试', artist: '歌手', learningStatus: 'WANT_TO_LEARN', sceneTags: [],
  performanceClipId: 'c1', durationMs: 1000,
  audio: { id: 'c1', url: '/api/media/audio/c1', sha256: 'aaa', sizeBytes: 100, version: 1 },
};
const audio = mediaEntries(item).find((e) => e.kind === 'audio') as MediaEntry;

it('人为删除一个本地文件后 readiness 立即失效', () => {
  const cached: CachedIndex = { [audio.key]: { ...audio, path: 'x', uri: 'file:///x' } };
  expect(isItemPlayable(item, cached)).toBe(true);
  const afterDelete = { ...cached };
  delete afterDelete[audio.key]; // 相当于本地文件被删 / 索引丢失
  expect(isItemPlayable(item, afterDelete)).toBe(false);
});
