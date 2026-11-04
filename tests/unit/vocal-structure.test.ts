import { describe, expect, it } from 'vitest';
import {
  approveRapSection, clearRepeat, confirmedRapRanges, confirmRepeat, lyricsIdentical, mergeWithPrevious,
  previousSameType, relabelSections, revokeRapSection, setSectionType, splitSectionAt, unconfirmedRapCount,
} from '../../src/lib/vocal/structure';
import type { TimedLyric, VocalSection } from '../../src/lib/types';
import {
  buildSongMap, changeType, mergeAdjacent, splitAtTime, toP040Sections,
} from '../../server/vocal-structure/structure-map.mjs';
import { referenceCatalogFailureMessage } from '../../src/lib/vocal/reference';

/**
 * 前端地图编辑（V3.2 T5/T6）。
 * 关键约束：所有操作结果都要与 server/vocal-structure 的规则一致，
 * 否则界面说能存、后端说非法，用户会白改一遍。
 */

const section = (input: Partial<VocalSection> & Pick<VocalSection, 'id'>): VocalSection => ({
  type: 'verse', label: input.id, startMs: 0, endMs: 1000, source: 'manual', ...input,
});

const LYRICS: TimedLyric[] = [
  { id: 'l1', startMs: 1000, text: '第一句' },
  { id: 'l2', startMs: 6000, text: '第二句' },
  { id: 'l3', startMs: 11000, text: '第三句' },
  { id: 'l4', startMs: 16000, text: '第一句' },
];

function baseSections(): VocalSection[] {
  return [
    section({ id: 's1', type: 'verse', startMs: 0, endMs: 10000 }),
    section({ id: 's2', type: 'chorus', startMs: 10000, endMs: 20000 }),
    section({ id: 's3', type: 'verse', startMs: 20000, endMs: 30000 }),
  ];
}

describe('地图编号与编辑', () => {
  it('同类按出现顺序编号，前奏/尾奏用文字，未标注按顺序', () => {
    const labels = relabelSections([
      section({ id: 'a', type: 'intro', startMs: 0, endMs: 5000 }),
      section({ id: 'b', type: 'verse', startMs: 5000, endMs: 15000 }),
      section({ id: 'c', type: 'chorus', startMs: 15000, endMs: 25000 }),
      section({ id: 'd', type: 'verse', startMs: 25000, endMs: 35000 }),
      section({ id: 'e', type: 'unknown', startMs: 35000, endMs: 40000 }),
      section({ id: 'f', type: 'outro', startMs: 40000, endMs: 45000 }),
    ]).map((item) => item.label);
    expect(labels).toEqual(['前奏', 'A1', 'B1', 'A2', 'U1', '尾奏']);
  });

  it('拆分后重编号，合并回去恢复编号', () => {
    const split = splitSectionAt(baseSections(), 's1', 4000);
    expect(split.map((item) => item.label)).toEqual(['A1', 'A2', 'B1', 'A3']);
    expect(split.every((item) => item.source === 'manual')).toBe(true);
    const merged = mergeWithPrevious(split, split[1].id);
    expect(merged.map((item) => item.label)).toEqual(['A1', 'B1', 'A2']);
    expect(merged[0].endMs).toBe(10000);
  });

  it('拆分太靠边、合并不相邻都明确报错', () => {
    expect(() => splitSectionAt(baseSections(), 's1', 200)).toThrow(/SPLIT_TOO_CLOSE_TO_EDGE/);
    expect(() => mergeWithPrevious(baseSections(), 's1')).toThrow(/NO_PREVIOUS_SECTION/);
    const gapped = [section({ id: 'g1', startMs: 0, endMs: 1000 }), section({ id: 'g2', startMs: 2000, endMs: 3000 })];
    expect(() => mergeWithPrevious(gapped, 'g2')).toThrow(/NON_CONTIGUOUS/);
  });

  it('改类型会清掉指向它的不兼容关系，不留悬空引用', () => {
    const related = confirmRepeat(baseSections(), 's3', 's1', 'same-melody-new-lyrics', LYRICS);
    expect(related[2].repeatOf).toBe('s1');
    const retyped = setSectionType(related, 's1', 'chorus');
    expect(retyped.find((item) => item.id === 's3')?.repeatOf).toBeUndefined();
  });

  it('上一个同类型段按时间顺序查找', () => {
    expect(previousSameType(baseSections(), 's3')?.id).toBe('s1');
    expect(previousSameType(baseSections(), 's2')).toBeNull();
  });
});

describe('重复关系必须人工确认', () => {
  it('歌词一致才可判同词，清除后回到独立段', () => {
    const twinLyrics: TimedLyric[] = [
      { id: 't1', startMs: 1000, text: '同一句歌词' },
      { id: 't2', startMs: 6000, text: '同一句歌词' },
    ];
    const pair = [
      section({ id: 'p1', startMs: 0, endMs: 5000 }),
      section({ id: 'p2', startMs: 5000, endMs: 10000 }),
    ];
    expect(lyricsIdentical(pair[0], pair[1], twinLyrics)).toBe(true);
    expect(lyricsIdentical(baseSections()[0], baseSections()[2], LYRICS)).toBe(false);
    const same = confirmRepeat(pair, 'p2', 'p1', 'exact-lyrics', twinLyrics);
    expect(same[1].repetition).toBe('exact-lyrics');
    expect(clearRepeat(same, 'p2')[1].repeatOf).toBeUndefined();
  });

  it('韩文换空格算同词，韩文与中文译文不算同词', () => {
    const korean: TimedLyric[] = [
      { id: 'k1', startMs: 1000, text: '너는 나의 봄이야' },
      { id: 'k2', startMs: 6000, text: '너는  나의 봄이야!' },
      { id: 'k3', startMs: 11000, text: '你是我的春天' },
    ];
    const sections = [
      section({ id: 'k-1', startMs: 0, endMs: 5000 }),
      section({ id: 'k-2', startMs: 5000, endMs: 10000 }),
      section({ id: 'k-3', startMs: 10000, endMs: 15000 }),
    ];
    expect(lyricsIdentical(sections[0], sections[1], korean)).toBe(true);
    expect(lyricsIdentical(sections[0], sections[2], korean)).toBe(false);
    expect(() => confirmRepeat(sections, 'k-3', 'k-1', 'exact-lyrics', korean)).toThrow(/LYRICS_NOT_IDENTICAL/);
    expect(confirmRepeat(sections, 'k-3', 'k-1', 'same-melody-new-lyrics', korean)[2].repetition).toBe('same-melody-new-lyrics');
  });
});

describe('Rap 跳过只认人工确认', () => {
  it('算法写入的 rap 段不参与自动跳过', () => {
    const sections = [
      section({ id: 'r1', type: 'rap', startMs: 4000, endMs: 22000, source: 'algorithm' }),
      section({ id: 'r2', type: 'rap', startMs: 34000, endMs: 54000, source: 'manual' }),
    ];
    expect(confirmedRapRanges(sections)).toEqual([{ startMs: 34000, endMs: 54000 }]);
    expect(unconfirmedRapCount(sections)).toBe(1);
  });

  it('保存结构后的 manual 不等于确认：显式 false 绝不跳过', () => {
    const sections = [
      section({ id: 'r1', type: 'rap', startMs: 4000, endMs: 22000, source: 'manual', rapApproved: false }),
      section({ id: 'r2', type: 'rap', startMs: 34000, endMs: 54000, source: 'manual', rapApproved: true }),
    ];
    expect(confirmedRapRanges(sections)).toEqual([{ startMs: 34000, endMs: 54000 }]);
    expect(unconfirmedRapCount(sections)).toBe(1);
  });

  it('确认与取消立即改变可跳过区间', () => {
    const base = [section({ id: 'r1', type: 'rap', startMs: 4000, endMs: 22000, rapApproved: false })];
    expect(confirmedRapRanges(base)).toEqual([]);
    const approved = approveRapSection(base, 'r1');
    expect(confirmedRapRanges(approved)).toEqual([{ startMs: 4000, endMs: 22000 }]);
    expect(confirmedRapRanges(revokeRapSection(approved, 'r1'))).toEqual([]);
    expect(() => approveRapSection([section({ id: 'v1' })], 'v1')).toThrow(/NOT_RAP/);
  });

  it('拆分、合并、改类型都会撤销原 Rap 确认', () => {
    const base = [section({ id: 'r1', type: 'rap', startMs: 0, endMs: 20000, rapApproved: true })];
    const split = splitSectionAt(base, 'r1', 10000);
    expect(split.every((item) => item.rapApproved === false)).toBe(true);
    expect(confirmedRapRanges(split)).toEqual([]);

    const merged = mergeWithPrevious(split, split[1].id, 'rap');
    expect(merged[0].rapApproved).toBe(false);
    expect(confirmedRapRanges(merged)).toEqual([]);

    const retyped = setSectionType(merged, merged[0].id, 'rap');
    expect(retyped[0].rapApproved).toBe(false);
  });
});

describe('与后端结构规则一致', () => {
  const map = buildSongMap({
    songId: 'parity',
    durationMs: 30000,
    lyrics: LYRICS,
    modelSegments: [
      { start: 0, end: 10, label: 'verse' },
      { start: 10, end: 20, label: 'chorus' },
      { start: 20, end: 30, label: 'verse' },
    ],
  });

  it('拆分后的编号与 P040 字段完全一致', () => {
    const server = splitAtTime(map, 'analysis-1', 4000);
    const client = splitSectionAt(map.sections, 'analysis-1', 4000);
    expect(client.map((item) => item.label)).toEqual(server.sections.map((item: { code: string }) => item.code));
    expect(client.map((item) => [item.startMs, item.endMs])).toEqual(server.sections.map((item: { startMs: number; endMs: number }) => [item.startMs, item.endMs]));
  });

  it('合并与改类型的编号一致，且导出仍然合法', () => {
    const serverMerged = mergeAdjacent(map, 'analysis-1', 'analysis-2', 'verse');
    const clientMerged = mergeWithPrevious(map.sections, 'analysis-2', 'verse');
    expect(clientMerged.map((item) => item.label)).toEqual(serverMerged.sections.map((item: { code: string }) => item.code));

    const serverTyped = changeType(map, 'analysis-2', 'bridge');
    const clientTyped = setSectionType(map.sections, 'analysis-2', 'bridge');
    expect(clientTyped.map((item) => item.label)).toEqual(serverTyped.sections.map((item: { code: string }) => item.code));

    const exported = toP040Sections({
      ...map,
      sections: clientTyped.map((item) => ({ ...item, code: item.label })),
    }, { confirmed: true });
    expect(exported).toHaveLength(clientTyped.length);
    expect(exported.every((item: { source: string }) => item.source === 'manual')).toBe(true);
  });
});

/**
 * 参考目录查不到 ≠ 本机没有参考。
 * 401、旧服务 404、断网都要单独说明原因，任何一条都不能落回「没有参考」的口径。
 */
describe('参考目录读取失败的文案', () => {
  const cases: { name: string; error: unknown; expect: RegExp }[] = [
    { name: '401 未授权', error: Object.assign(new Error('unauthorized'), { status: 401 }), expect: /需要授权（服务返回 401）/ },
    { name: '403 无权限', error: Object.assign(new Error('forbidden'), { status: 403 }), expect: /需要授权（服务返回 403）/ },
    { name: '旧服务没有接口', error: Object.assign(new Error('Not Found'), { status: 404 }), expect: /没有参考目录接口（返回 404）/ },
    { name: '连不上服务', error: Object.assign(new Error('无法连接本地服务'), { status: 0 }), expect: /连不上本地服务/ },
    { name: '服务端 500', error: Object.assign(new Error('boom'), { status: 500 }), expect: /参考目录读取失败（服务返回 500：boom）/ },
    { name: '未知错误', error: new Error('weird'), expect: /参考目录读取失败：weird/ },
  ];

  for (const item of cases) {
    it(`${item.name}：只说查不到，并明确不等于没有参考`, () => {
      const message = referenceCatalogFailureMessage(item.error);
      expect(message).toMatch(item.expect);
      expect(message).toContain('不等于没有参考');
      expect(message).not.toContain('本机没有');
    });
  }
});
