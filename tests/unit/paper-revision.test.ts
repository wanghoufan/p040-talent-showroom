import { beforeEach, describe, expect, it } from 'vitest';
import type { PaperDraft, PaperEdit } from '../../src/lib/vocal/paper-revision';
import {
  applyPaperDraft, diffPaperDraft, paperCheckCode, parsePaperDraft,
} from '../../src/lib/vocal/paper-revision';
import {
  MAX_SNAPSHOTS, pushSnapshot, readSnapshots, restoreSnapshot, sectionRevision,
} from '../../src/lib/vocal/structure-revision';
import type { TalentItem, VocalSection } from '../../src/lib/types';

/**
 * 纸质修订回传（P040 §7）。
 * 重点不是「能解析 JSON」，而是任何版本对不上的稿子都不能静默改结构：
 * 拒绝要能被用户看懂，应用要能撤回，没有可信时标就不许编秒数。
 */

function section(input: Partial<VocalSection> & Pick<VocalSection, 'id'>): VocalSection {
  return { type: 'verse', label: input.id, startMs: 0, endMs: 1000, source: 'manual', ...input };
}

const SECTIONS: VocalSection[] = [
  section({ id: 's1', type: 'verse', label: 'A1', startMs: 0, endMs: 10000 }),
  section({ id: 's2', type: 'chorus', label: 'B1', startMs: 10000, endMs: 20000, source: 'algorithm' }),
  section({ id: 's3', type: 'verse', label: 'A2', startMs: 20000, endMs: 30000 }),
  section({ id: 's4', type: 'chorus', label: 'B2', startMs: 30000, endMs: 40000, source: 'algorithm' }),
  section({ id: 's5', type: 'rap', label: 'R1', startMs: 40000, endMs: 50000, rapApproved: false }),
];

const ITEM: TalentItem = {
  id: 'vocal-paper-1',
  kind: 'VOCAL',
  title: '测试曲',
  artist: '测试歌手',
  learningStatus: 'PRACTICING',
  originalKey: 'C',
  performanceKey: 'C',
  capo: 0,
  scoreText: '',
  notes: '',
  audioRole: 'REFERENCE',
  durationMs: 60000,
  lyrics: [
    { id: 'l1', startMs: 1000, text: '第一句' },
    { id: 'l2', startMs: 11000, text: '第二句' },
    { id: 'l3', startMs: 21000, text: '第三句' },
    { id: 'l4', startMs: 31000, text: '第四句' },
    { id: 'l5', startMs: 41000, text: '第五句' },
    /* 这一行没有可用时标：纸上只写行号时必须保持待确认。 */
    { id: 'l6', startMs: 0, text: '无时标行' },
  ],
  sections: SECTIONS,
};

const REVISION = sectionRevision(SECTIONS);

function draftOf(edits: PaperEdit[], overrides: Partial<PaperDraft> = {}): PaperDraft {
  return {
    songId: ITEM.id,
    title: ITEM.title,
    durationMs: ITEM.durationMs,
    revision: REVISION,
    edits,
    ...overrides,
  };
}

function cloneSections(): VocalSection[] {
  return SECTIONS.map((entry) => ({ ...entry }));
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('修订 JSON 解析', () => {
  it('接受规范 JSON，并给出可选字段', () => {
    const parsed = parsePaperDraft(JSON.stringify({
      songId: ITEM.id,
      title: ITEM.title,
      durationMs: 60000,
      revision: REVISION,
      code: paperCheckCode(ITEM.id, REVISION),
      edits: [{ kind: 'rap', sectionLabel: 'R1', action: 'confirm' }],
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.draft.edits).toHaveLength(1);
    expect(parsed.draft.code).toBe(paperCheckCode(ITEM.id, REVISION));
  });

  it('缺字段和类型错误都有中文提示', () => {
    const missing = parsePaperDraft({ title: '测试曲', durationMs: 60000, revision: REVISION, edits: [] });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('歌曲 ID');

    const badKind = parsePaperDraft({
      songId: ITEM.id, title: ITEM.title, durationMs: 60000, revision: REVISION, edits: [{ kind: 'magic' }],
    });
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) expect(badKind.error).toContain('第 1 条');

    const badJson = parsePaperDraft('{oops');
    expect(badJson.ok).toBe(false);
    if (!badJson.ok) expect(badJson.error).toContain('JSON 格式错误');
  });
});

describe('差异预览', () => {
  it('正常稿逐项列出 before→after、置信度与备注', () => {
    const draft = draftOf([
      { kind: 'boundary', sectionLabel: 'B2', lineIndex: 4 },
      { kind: 'type', sectionLabel: 'A2', type: 'bridge' },
      { kind: 'repeat', sectionLabel: 'B2', repeatOfLabel: 'B1', relation: 'unverified' },
      { kind: 'rap', sectionLabel: 'R1', action: 'confirm' },
    ]);
    const diff = diffPaperDraft(ITEM, draft);
    expect(diff.conflicts).toEqual([]);
    expect(diff.rows).toHaveLength(4);

    const [boundary, type, repeat, rap] = diff.rows;
    expect(boundary.label).toBe('B2 起点');
    expect(boundary.before).toBe('0:30.0');
    expect(boundary.after).toBe('0:31.0');
    expect(boundary.confidence).toBeGreaterThan(0.8);
    expect(boundary.note).toContain('LRC');

    expect(type.before).toBe('主歌');
    expect(type.after).toBe('桥段');
    expect(type.confidence).toBe(1);

    expect(repeat.after).toContain('B1');
    expect(rap.after).toBe('已确认，可自动跳过');
  });

  it('歌曲 ID 不符时整体拒绝', () => {
    const draft = draftOf([{ kind: 'rap', sectionLabel: 'R1', action: 'confirm' }], { songId: 'other-song' });
    const diff = diffPaperDraft(ITEM, draft);
    expect(diff.rows).toEqual([]);
    expect(diff.conflicts.map((conflict) => conflict.code)).toEqual(['SONG_MISMATCH']);
    expect(diff.conflicts[0].message).toContain('不是当前这首');
    expect(() => applyPaperDraft(ITEM, draft)).toThrow(/歌曲不符/);
  });

  it('时长漂移超过 1 秒时整体拒绝', () => {
    const draft = draftOf([], { durationMs: ITEM.durationMs + 1001 });
    const diff = diffPaperDraft(ITEM, draft);
    expect(diff.conflicts.map((conflict) => conflict.code)).toEqual(['DURATION_DRIFT']);
    expect(() => applyPaperDraft(ITEM, draft)).toThrow(/时长漂移/);
  });

  it('修订号过期时整体拒绝，提示重新打印或人工核对', () => {
    const draft = draftOf([{ kind: 'rap', sectionLabel: 'R1', action: 'confirm' }], { revision: 'stale001' });
    const diff = diffPaperDraft(ITEM, draft);
    expect(diff.conflicts.map((conflict) => conflict.code)).toEqual(['REVISION_STALE']);
    expect(diff.conflicts[0].message).toContain('不能直接覆盖');
    expect(() => applyPaperDraft(ITEM, draft)).toThrow(/结构已变化/);
  });

  it('校验码对不上也拒绝', () => {
    const draft = draftOf([{ kind: 'rap', sectionLabel: 'R1', action: 'confirm' }], { code: 'ZZZZ' });
    const diff = diffPaperDraft(ITEM, draft);
    expect(diff.conflicts.map((conflict) => conflict.code)).toContain('CODE_MISMATCH');
  });
});

describe('应用修订', () => {
  it('只改动声明的段落，歌词与其它时轴原样保留', () => {
    const before = cloneSections();
    const lyricsBefore = ITEM.lyrics?.map((line) => ({ ...line }));
    const draft = draftOf([
      { kind: 'boundary', sectionLabel: 'B2', lineIndex: 4 },
      { kind: 'type', sectionLabel: 'A2', type: 'bridge' },
      { kind: 'rap', sectionLabel: 'R1', action: 'confirm' },
    ]);

    const result = applyPaperDraft(ITEM, draft);
    const byId = new Map(result.sections.map((entry) => [entry.id, entry]));

    expect(result.sections).toHaveLength(SECTIONS.length);
    expect(ITEM.sections).toEqual(before);
    expect(ITEM.lyrics).toEqual(lyricsBefore);

    expect(byId.get('s1')).toMatchObject({ startMs: 0, endMs: 10000, type: 'verse' });
    expect(byId.get('s2')).toMatchObject({ startMs: 10000, endMs: 20000 });
    expect(byId.get('s3')).toMatchObject({ type: 'bridge', startMs: 20000, endMs: 31000, source: 'manual' });
    expect(byId.get('s4')).toMatchObject({ startMs: 31000, endMs: 40000 });
    expect(byId.get('s5')).toMatchObject({ rapApproved: true, source: 'manual' });
    expect(result.pending).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('无时标的行号保持待确认，不按纸面比例猜秒数', () => {
    const draft = draftOf([{ kind: 'boundary', sectionLabel: 'A1', lineIndex: 6 }]);
    const diff = diffPaperDraft(ITEM, draft);
    expect(diff.rows[0].after).toBe('待确认');
    expect(diff.rows[0].confidence).toBeLessThan(0.5);

    const result = applyPaperDraft(ITEM, draft);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]).toContain('待确认');
    expect(result.sections.map((entry) => [entry.startMs, entry.endMs]))
      .toEqual(SECTIONS.map((entry) => [entry.startMs, entry.endMs]));
  });

  it('重复关系在类型改完之后才成立，同稿按顺序应用', () => {
    const draft = draftOf([
      { kind: 'type', sectionLabel: 'A2', type: 'chorus' },
      { kind: 'repeat', sectionLabel: 'A2', repeatOfLabel: 'B1', relation: 'unverified' },
    ]);
    const diff = diffPaperDraft(ITEM, draft);
    expect(diff.conflicts).toEqual([]);
    expect(diff.rows.map((row) => row.note).join(' ')).not.toContain('先改类型');

    const result = applyPaperDraft(ITEM, draft);
    const a2 = result.sections.find((entry) => entry.id === 's3');
    expect(a2).toMatchObject({ type: 'chorus', repeatOf: 's2', repetition: 'unverified', source: 'manual' });
    expect(result.skipped).toEqual([]);
  });

  it('人工结构不被悄悄改成机器来源', () => {
    const draft = draftOf([{ kind: 'rap', sectionLabel: 'R1', action: 'skip' }]);
    const result = applyPaperDraft(ITEM, draft);
    const untouched = result.sections.filter((entry) => entry.id !== 's5');
    expect(untouched.every((entry) => entry.source === (entry.id === 's2' || entry.id === 's4' ? 'algorithm' : 'manual')))
      .toBe(true);
    expect(result.sections.find((entry) => entry.id === 's5')).toMatchObject({ rapApproved: false, source: 'manual' });
  });
});

describe('结构快照', () => {
  it('应用前记下的快照可以原样取回', () => {
    pushSnapshot(ITEM.id, { revision: REVISION, sections: cloneSections(), at: '2026-01-01T00:00:00.000Z', source: 'paper' });
    const list = readSnapshots(ITEM.id);
    expect(list).toHaveLength(1);
    expect(list[0].revision).toBe(REVISION);

    const restored = restoreSnapshot(ITEM.id, REVISION);
    expect(restored?.sections).toEqual(cloneSections());
    expect(SECTIONS).toEqual(cloneSections());
  });

  it('同一首歌最多留 10 份，最新的在最前，且不碰正式结构', () => {
    const base = cloneSections();
    for (let index = 0; index < MAX_SNAPSHOTS + 3; index += 1) {
      pushSnapshot(ITEM.id, {
        revision: `rev-${index}`,
        sections: base,
        at: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        source: 'paper',
      });
    }
    const list = readSnapshots(ITEM.id);
    expect(list).toHaveLength(MAX_SNAPSHOTS);
    expect(list[0].revision).toBe(`rev-${MAX_SNAPSHOTS + 2}`);
    expect(list.at(-1)?.revision).toBe('rev-3');
    expect(ITEM.sections).toEqual(base);
    expect(restoreSnapshot(ITEM.id, 'rev-0')).toBeNull();
  });

  it('没有快照时不会伪造恢复结果', () => {
    expect(readSnapshots(ITEM.id)).toEqual([]);
    expect(restoreSnapshot(ITEM.id, 'whatever')).toBeNull();
  });
});
