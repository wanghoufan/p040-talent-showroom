import { expect, it } from 'vitest';
import { isItemPlayable, isMediaReady, mediaEntries, referenceEntries, type CachedIndex, type MediaEntry } from '../../src/lib/offline-manifest';
import type { DanceItem } from '../../src/lib/types';

const item: DanceItem = {
  id: 'd1', title: '测试', artist: '歌手', learningStatus: 'WANT_TO_LEARN', sceneTags: [],
  performanceClipId: 'c1', durationMs: 1000,
  audio: { id: 'c1', url: '/api/media/audio/c1', sha256: 'aaa', sizeBytes: 100, version: 1 },
  cover: { id: 'a1', url: '/api/media/cover/a1', sha256: 'bbb', sizeBytes: 50, version: 1 },
};
const audio = mediaEntries(item).find((e) => e.kind === 'audio') as MediaEntry;
const cachedOf = (media: MediaEntry): CachedIndex => ({ [media.key]: { ...media, path: 'x', uri: 'file:///x' } });

it('媒体就绪要求存在且 hash/version 完全一致', () => {
  expect(isMediaReady(audio, {})).toBe(false); // missing
  expect(isMediaReady(audio, { [audio.key]: { ...audio, sha256: 'other', path: 'x', uri: 'file:///x' } })).toBe(false); // hash mismatch
  expect(isMediaReady(audio, { [audio.key]: { ...audio, version: 2, path: 'x', uri: 'file:///x' } })).toBe(false); // version mismatch
  expect(isMediaReady(audio, { [audio.key]: { ...audio, path: 'x', uri: '' } })).toBe(false); // 无可用 URI
  expect(isMediaReady(audio, cachedOf(audio))).toBe(true);
});

it('未缓存或损坏的曲目不可播', () => {
  expect(isItemPlayable(item, {})).toBe(false);
  expect(isItemPlayable(item, cachedOf(audio))).toBe(true);
});

it('原视频缓存项来自 source，且不进 mediaEntries（不影响音频就绪）', () => {
  const withVideo: DanceItem = { ...item, sourceMediaId: 's1', source: { id: 's1', sourceKind: 'VIDEO', durationMs: 1000, sha256: 'src1', url: '/api/media/reference/s1', sizeBytes: 5000, version: 1 } };
  expect(mediaEntries(withVideo).some((e) => e.kind === 'reference')).toBe(false);
  const ref = referenceEntries(withVideo);
  expect(ref).toHaveLength(1);
  expect(ref[0]).toMatchObject({ key: '/api/media/reference/s1', url: '/api/media/reference/s1', sizeBytes: 5000, version: 1, kind: 'reference' });
  // 原视频未缓存时音频仍可就绪；无 source 的曲目没有原视频项。
  expect(isItemPlayable(withVideo, cachedOf(audio))).toBe(true);
  expect(referenceEntries(item)).toEqual([]);
});
