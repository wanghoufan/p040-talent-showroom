import { describe, expect, it } from 'vitest';
import {
  assignSectionIds, availableVocalSources, defaultVocalSource, hasVocalTrack, lineAtTime, lineLoopFor,
  mapLegacyAudioRole, mergeRapRanges, parseLrc, rapRangeAt, rapRangesFromSections, resolveLineTimings,
  sectionAtTime, skipRapTarget, sortSections, talentDurationMs, validateSections, vocalTracksFromLegacy,
} from '../../src/lib/vocal';
import type { MediaFile, TimedLyric, VocalSection } from '../../src/lib/types';

const media: MediaFile = { id: 'm1', url: '/api/media/audio/1', sha256: 'hash', sizeBytes: 10, version: 1, durationMs: 60000 };

const line = (startMs: number, text: string, extra: Partial<TimedLyric> = {}): TimedLyric => ({ id: `l-${startMs}`, startMs, text, ...extra });
const section = (input: Partial<VocalSection> & Pick<VocalSection, 'id'>): VocalSection => ({
  type: 'verse', label: input.id, startMs: 0, endMs: 1000, source: 'manual', ...input,
});

describe('parseLrc', () => {
  it('支持 BOM、CRLF、中英韩元数据、2/3 位毫秒与一行多时间戳', () => {
    const doc = parseLrc('\uFEFF[ti:海风来信]\r\n[ar:原创演示]\r\n[offset:+200]\r\n[00:06.80]第一句\r\n[00:12.15][00:20.5]重复句\r\n[00:24.155]三毫秒\r\n');
    expect(doc.metadata).toEqual({ title: '海风来信', artist: '原创演示', offsetMs: 200 });
    expect(doc.hasUsableTiming).toBe(true);
    expect(doc.lines.map((item) => [item.startMs, item.text])).toEqual([
      [6600, '第一句'],
      [11950, '重复句'],
      [20300, '重复句'],
      [23955, '三毫秒'],
    ]);
    expect(doc.lines.map((item) => item.id)).toEqual(['lrc-1', 'lrc-2', 'lrc-3', 'lrc-4']);
    expect(doc.untimedLines).toEqual([]);
  });

  it('无时间戳的纯文本不伪造时间，标记需要校准', () => {
    const doc = parseLrc('第一句\n\n第二句');
    expect(doc.lines).toEqual([]);
    expect(doc.hasUsableTiming).toBe(false);
    expect(doc.untimedLines).toEqual(['第一句', '第二句']);
    expect(doc.issues).toContain('NEEDS_CALIBRATION');
  });

  it('空文件、坏时间戳、逐字增强标签与负时间都按边界处理', () => {
    expect(parseLrc('   \n\n').issues).toContain('EMPTY_LYRICS');

    const bad = parseLrc('[00:75.00]坏时间\n[00:10.00]好句');
    expect(bad.lines.map((item) => [item.startMs, item.text])).toEqual([[10000, '好句']]);
    expect(bad.issues).toContain('INVALID_TIMESTAMP');
    expect(bad.untimedLines).toEqual(['坏时间']);

    const enhanced = parseLrc('[00:10.00]<00:10.00>Hel<00:10.50>lo');
    expect(enhanced.lines[0]).toMatchObject({ startMs: 10000, text: 'Hello' });

    const early = parseLrc('[offset:500]\n[00:00.20]早');
    expect(early.lines[0].startMs).toBe(0);
    expect(early.issues).toContain('NEGATIVE_TIME_CLAMPED');
    expect(parseLrc('[offset:abc]\n[00:01.00]句').issues).toContain('INVALID_OFFSET');
  });

  it('乱序按时间排序，同一时间戳保持原顺序', () => {
    const doc = parseLrc('[00:20.00]B\n[00:10.00]A\n[00:10.00]A2');
    expect(doc.lines.map((item) => item.text)).toEqual(['A', 'A2', 'B']);
  });
});

describe('行时间与当前句', () => {
  it('句尾优先显式值，其次下一句起点，最后总时长', () => {
    const resolved = resolveLineTimings([line(1000, 'A'), line(5000, 'B', { endMs: 8000 })], 9000);
    expect(resolved.map((item) => item.endMs)).toEqual([5000, 8000]);
    expect(resolveLineTimings([line(1000, 'A')], 9000)[0].endMs).toBe(9000);
    expect(resolveLineTimings([line(1000, 'A')])[0].endMs).toBeUndefined();
  });

  it('lineAtTime 取当前句，早于首句返回 -1', () => {
    const lines = [line(1000, 'A'), line(5000, 'B'), line(9000, 'C')];
    expect(lineAtTime(lines, 0)).toBe(-1);
    expect(lineAtTime(lines, 1000)).toBe(0);
    expect(lineAtTime(lines, 8999)).toBe(1);
    expect(lineAtTime(lines, 9000)).toBe(2);
    expect(lineAtTime(lines, Number.NaN)).toBe(-1);
  });
});

describe('结构段', () => {
  it('非法区间、重复 id、重叠与重复目标被拒绝', () => {
    expect(validateSections([section({ id: 'A', startMs: 0, endMs: 1000 })])).toEqual([]);
    expect(validateSections([section({ id: 'A', startMs: 1000, endMs: 1000 })])).toContain('A:EMPTY_RANGE');
    expect(validateSections([section({ id: 'A', startMs: -1, endMs: 500 })])).toContain('A:NEGATIVE_START');
    expect(validateSections([section({ id: 'A', endMs: 5000 })], 4000)).toContain('A:OUT_OF_RANGE');
    expect(validateSections([section({ id: 'A' }), section({ id: 'A', startMs: 2000 })])).toContain('DUPLICATE_ID:A');
    expect(validateSections([section({ id: 'A', endMs: 1000 }), section({ id: 'B', startMs: 900, endMs: 2000 })])).toContain('B:OVERLAP');
    expect(validateSections([section({ id: 'A', repeatOf: 'B' })])).toContain('A:REPEAT_TARGET_MISSING');
    expect(validateSections([section({ id: 'A', repeatOf: 'A' })])).toContain('A:SELF_REPEAT');
  });

  it('旧边界：原样保留的历史尾段不判越界，改动过或新增的越界仍然拒绝', () => {
    const durationMs = 219572;
    // 旧数据段尾 219600 比真实音轨多 28ms；原样保留时不能挡住其它段落的保存。
    const persisted = [
      section({ id: 'A', startMs: 212740, endMs: 219600 }),
      section({ id: 'B', startMs: 200000, endMs: 212740 }),
    ];
    expect(validateSections(persisted, durationMs)).toContain('A:OUT_OF_RANGE');
    expect(validateSections(persisted, durationMs, { persisted })).toEqual([]);

    // 同 id 但边界被改成新的越界值：不再享受旧边界豁免。
    const edited = [section({ id: 'A', startMs: 212740, endMs: 220000 }), section({ id: 'B', startMs: 200000, endMs: 212740 })];
    expect(validateSections(edited, durationMs, { persisted })).toContain('A:OUT_OF_RANGE');

    // 新增段落越界同样拒绝。
    const added = [...persisted, section({ id: 'C', startMs: 219600, endMs: 220000 })];
    expect(validateSections(added, durationMs, { persisted })).toContain('C:OUT_OF_RANGE');
  });

  it('曲目最长时长按音轨算，不被较短的 item.durationMs 截断', () => {
    const base = {
      kind: 'VOCAL' as const, audioRole: 'REFERENCE' as const, durationMs: 219560,
      tracks: { original: { media: { ...media, id: 'm-original', durationMs: 219572 } } },
    };
    expect(talentDurationMs(base)).toBe(219572);
    expect(talentDurationMs({ ...base, tracks: undefined })).toBe(219560);
    // 不是唱歌曲目时不做音轨补位，避免把别的曲目时长算进来。
    expect(talentDurationMs({ kind: 'GUITAR', audioRole: 'REFERENCE', durationMs: 1000, tracks: { original: { media: { ...media, durationMs: 99999 } } } })).toBe(1000);
  });

  it('半开区间定位与排序稳定', () => {
    const sections = [section({ id: 'B', startMs: 1000, endMs: 2000 }), section({ id: 'A', startMs: 0, endMs: 1000 })];
    expect(sortSections(sections).map((item) => item.id)).toEqual(['A', 'B']);
    expect(sectionAtTime(sections, 0)?.id).toBe('A');
    expect(sectionAtTime(sections, 999)?.id).toBe('A');
    expect(sectionAtTime(sections, 1000)?.id).toBe('B');
    expect(sectionAtTime(sections, 2000)).toBeNull();
  });

  it('手工 sectionId 不被自动覆盖，其余按时间落段', () => {
    const sections = [section({ id: 'A', startMs: 0, endMs: 1000 }), section({ id: 'B', startMs: 1000, endMs: 2000 })];
    const assigned = assignSectionIds([line(100, '手工', { sectionId: 'B' }), line(1500, '自动'), line(3000, '无段')], sections);
    expect(assigned.map((item) => item.sectionId)).toEqual(['B', 'B', undefined]);
  });
});

describe('Rap 区间', () => {
  it('丢弃非法区间、排序、合并重叠与相邻、按总时长裁剪', () => {
    expect(mergeRapRanges([
      { startMs: 2000, endMs: 4000 }, { startMs: 3000, endMs: 5000 }, { startMs: 5000, endMs: 6000 },
      { startMs: 7000, endMs: 7000 }, { startMs: Number.NaN, endMs: 9000 },
    ])).toEqual([{ startMs: 2000, endMs: 6000 }]);
    expect(mergeRapRanges([{ startMs: 0, endMs: 5000 }], 3000)).toEqual([{ startMs: 0, endMs: 3000 }]);
    expect(mergeRapRanges([{ startMs: -100, endMs: 500 }])).toEqual([{ startMs: 0, endMs: 500 }]);
  });

  it('只收集 rap 类型段落并保持两段独立', () => {
    const ranges = rapRangesFromSections([
      section({ id: 'R1', type: 'rap', startMs: 4000, endMs: 22000 }),
      section({ id: 'A1', type: 'verse', startMs: 22000, endMs: 34000 }),
      section({ id: 'R2', type: 'rap', startMs: 34000, endMs: 54000 }),
    ]);
    expect(ranges).toEqual([{ startMs: 4000, endMs: 22000 }, { startMs: 34000, endMs: 54000 }]);
    expect(rapRangeAt(21999, ranges)?.endMs).toBe(22000);
    expect(rapRangeAt(22000, ranges)).toBeNull();
  });

  it('算法写的 rap 段在用户确认前不参与跳过', () => {
    const ranges = rapRangesFromSections([
      section({ id: 'R1', type: 'rap', startMs: 4000, endMs: 22000, source: 'algorithm' }),
      section({ id: 'R2', type: 'rap', startMs: 34000, endMs: 54000 }),
    ]);
    expect(ranges).toEqual([{ startMs: 34000, endMs: 54000 }]);
  });

  it('草稿应用后的 manual 段不算确认：只有 rapApproved=true 才跳过', () => {
    const ranges = rapRangesFromSections([
      section({ id: 'R1', type: 'rap', startMs: 4000, endMs: 22000, source: 'manual', rapApproved: false }),
      section({ id: 'R2', type: 'rap', startMs: 34000, endMs: 54000, source: 'manual', rapApproved: true }),
    ]);
    expect(ranges).toEqual([{ startMs: 34000, endMs: 54000 }]);
  });

  it('跳段带 30ms 缓冲、可关闭、夹取总时长且不制造回跳', () => {
    const ranges = [{ startMs: 4350, endMs: 22000 }, { startMs: 34000, endMs: 54000 }];
    expect(skipRapTarget(5000, ranges)).toBe(22030);
    expect(skipRapTarget(34000, ranges)).toBe(54030);
    expect(skipRapTarget(22000, ranges)).toBe(22000);
    expect(skipRapTarget(5000, ranges, { enabled: false })).toBe(5000);
    expect(skipRapTarget(5000, ranges, { epsilonMs: 100 })).toBe(22100);
    expect(skipRapTarget(5000, [{ startMs: 0, endMs: 60000 }], { durationMs: 60000 })).toBe(60000);
    expect(skipRapTarget(0, [{ startMs: 0, endMs: 0 }])).toBe(0);
  });
});

describe('逐句循环', () => {
  const lines = Array.from({ length: 8 }, (_, index) => line(index * 1000, `第${index + 1}句`));

  it('第 8 句回退 4 句得到第 5～8 句，末句用总时长收尾', () => {
    expect(lineLoopFor(lines, 7, 4, { durationMs: 8000 })).toEqual({ startMs: 4000, endMs: 8000, startIndex: 4, endIndex: 7, count: 4 });
  });

  it('开头不足 N 句时从第 1 句起，最后一句优先显式句尾', () => {
    expect(lineLoopFor(lines, 1, 4, { durationMs: 8000 })).toMatchObject({ startIndex: 0, endIndex: 1, count: 2, startMs: 0, endMs: 2000 });
    const explicit = [...lines.slice(0, 3)];
    explicit[2] = { ...explicit[2], endMs: 2900 };
    expect(lineLoopFor(explicit, 2, 1, { durationMs: 8000 })?.endMs).toBe(2900);
  });

  it('0.1～0.3 秒缓冲只向句间空隙延伸，不越过下一句', () => {
    const gap = [line(0, 'A', { endMs: 1500 }), line(2000, 'B'), line(3000, 'C')];
    expect(lineLoopFor(gap, 0, 1, { bufferMs: 300 })?.endMs).toBe(1800);
    expect(lineLoopFor(gap, 0, 1, { bufferMs: 900 })?.endMs).toBe(1800);
    expect(lineLoopFor(gap, 0, 1, { bufferMs: 0 })?.endMs).toBe(1500);
  });

  it('无可靠时间戳、乱序、区间过短、越界一律返回 null 而不按时间均分', () => {
    expect(lineLoopFor([], 0, 2)).toBeNull();
    expect(lineLoopFor([line(Number.NaN, '坏')], 0, 1, { durationMs: 9000 })).toBeNull();
    expect(lineLoopFor([line(0, 'A'), line(2000, 'B'), line(1000, 'C')], 2, 3, { durationMs: 9000 })).toBeNull();
    expect(lineLoopFor([line(1000, 'A')], 0, 1, { durationMs: 1050 })).toBeNull();
    expect(lineLoopFor([line(5000, 'A')], 0, 1)).toBeNull();
    expect(lineLoopFor(lines, 8, 2, { durationMs: 8000 })).toBeNull();
    expect(lineLoopFor(lines, 3, Number.NaN)).toBeNull();
    expect(lineLoopFor(lines, 3, 0, { durationMs: 8000 })).toMatchObject({ count: 1, startIndex: 3, endIndex: 3 });
  });
});

describe('旧 audioRole 映射与双音轨默认值', () => {
  it('REFERENCE 只映射原唱，ACCOMPANIMENT 只映射伴奏，另一轨保持缺失', () => {
    expect(mapLegacyAudioRole('REFERENCE')).toBe('original');
    expect(mapLegacyAudioRole('ACCOMPANIMENT')).toBe('accompaniment');
    expect(mapLegacyAudioRole('reference')).toBeNull();

    const reference = vocalTracksFromLegacy({ audio: media, audioRole: 'REFERENCE' });
    expect(reference.original?.media).toBe(media);
    expect(reference.accompaniment).toBeUndefined();

    const accompaniment = vocalTracksFromLegacy({ audio: media, audioRole: 'ACCOMPANIMENT' });
    expect(accompaniment.accompaniment?.media).toBe(media);
    expect(accompaniment.original).toBeUndefined();

    expect(vocalTracksFromLegacy({ audio: undefined, audioRole: 'REFERENCE' })).toEqual({});
    expect(() => vocalTracksFromLegacy({ audio: media, audioRole: 'MIXED' as 'REFERENCE' })).toThrow('UNKNOWN_AUDIO_ROLE:MIXED');
  });

  it('练唱优先原唱，演出只认伴奏，缺伴奏不拿原唱冒充', () => {
    const both = { original: { media }, accompaniment: { media } };
    expect(defaultVocalSource(both, 'practice')).toBe('original');
    expect(defaultVocalSource(both, 'performance')).toBe('accompaniment');
    expect(defaultVocalSource({ original: { media } }, 'practice')).toBe('original');
    expect(defaultVocalSource({ original: { media } }, 'performance')).toBeNull();
    expect(defaultVocalSource({ accompaniment: { media } }, 'practice')).toBe('accompaniment');
    expect(defaultVocalSource({ accompaniment: { media } }, 'performance')).toBe('accompaniment');
    expect(defaultVocalSource({}, 'practice')).toBeNull();
    expect(defaultVocalSource({}, 'performance')).toBeNull();

    expect(hasVocalTrack(both, 'original')).toBe(true);
    expect(hasVocalTrack({}, 'accompaniment')).toBe(false);
    expect(availableVocalSources(both)).toEqual(['original', 'accompaniment']);
    expect(availableVocalSources({ accompaniment: { media } })).toEqual(['accompaniment']);
  });
});
