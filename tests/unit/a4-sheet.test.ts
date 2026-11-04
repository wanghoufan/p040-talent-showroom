import { describe, expect, it } from 'vitest';
import { A4_SHEET_METRICS, buildA4Sheet, type A4Run } from '../../src/lib/vocal/a4-sheet';
import type { TalentItem, TimedLyric, VocalSection, VocalSectionType } from '../../src/lib/types';

/** A4 学习稿排版：中文不重复译文、外语译文紧随原文、无时标不伪造、长歌分页不孤立段标题。 */

function itemOf(extra: Partial<TalentItem>): TalentItem {
  return {
    id: 'vocal-print-1', kind: 'VOCAL', title: '테스트 곡', artist: '가수', learningStatus: 'PRACTICING',
    originalKey: '', performanceKey: '', capo: 0, scoreText: '', notes: '', audioRole: 'REFERENCE',
    durationMs: 240_000, ...extra,
  };
}

function lyric(id: string, startMs: number, text: string): TimedLyric {
  return { id, startMs, text };
}

function section(input: {
  id: string; type: VocalSectionType; label: string; startMs: number; endMs: number;
} & Partial<VocalSection>): VocalSection {
  return { source: 'manual', ...input };
}

const runsOf = (pages: ReturnType<typeof buildA4Sheet>['pages'], kind: A4Run['kind']): A4Run[] =>
  pages.flatMap(page => page.runs.filter(run => run.kind === kind));

describe('A4 学习稿排版', () => {
  it('中文原唱不输出译文行（含残留的同文译文）', () => {
    const sheet = buildA4Sheet(itemOf({
      language: 'zh',
      lyrics: [lyric('l1', 1000, '第一句歌词'), lyric('l2', 4000, '第二句歌词')],
      translations: {
        version: 1, language: 'zh', source: 'lrc',
        lines: [
          { id: 'l1', text: '第一句歌词', source: 'lrc' },
          { id: 'l2', text: '第二句歌词', source: 'lrc' },
        ],
      },
    }), [section({ id: 's1', type: 'verse', label: 'A1', startMs: 0, endMs: 20_000 })]);

    expect(runsOf(sheet.pages, 'translation')).toHaveLength(0);
    expect(sheet.meta.noSections).toBe(false);
  });

  it('韩文歌的译文行紧跟原文，且在原文下方', () => {
    const sheet = buildA4Sheet(itemOf({
      language: 'ko',
      lyrics: [lyric('k1', 17_048, 'Hey 느낌이 너무 이상한 걸 좀'), lyric('k2', 20_998, '나를 위해 보내준다는 말이')],
      translations: {
        version: 1, language: 'zh', source: 'ai',
        lines: [
          { id: 'k1', text: '嘿 感觉太奇怪了', source: 'ai' },
          { id: 'k2', text: '说是为我送来的话', source: 'ai' },
        ],
      },
    }), [section({ id: 's1', type: 'verse', label: 'A1', startMs: 0, endMs: 40_000 })]);

    const ordered = sheet.pages[0].runs.filter(run => run.kind === 'lyric' || run.kind === 'translation');
    expect(ordered.map(run => run.kind)).toEqual(['lyric', 'translation', 'lyric', 'translation']);
    expect(ordered[0].text).toContain('Hey');
    expect(ordered[1].text).toBe('嘿 感觉太奇怪了');
    expect(ordered[1].y).toBeGreaterThan(ordered[0].y);
    expect(ordered[2].text).toBe('나를 위해 보내준다는 말이');
    expect(ordered[3].text).toBe('说是为我送来的话');
  });

  it('没有真实时标时显示破折号，不伪造时间', () => {
    const untimed = buildA4Sheet(itemOf({
      language: 'zh',
      lyrics: [lyric('l1', 0, '第一句'), lyric('l2', 0, '第二句')],
    }), [section({ id: 's1', type: 'verse', label: 'A1', startMs: 0, endMs: 10_000 })]);

    const times = runsOf(untimed.pages, 'time');
    expect(times).toHaveLength(2);
    expect(times.every(run => run.text === '—')).toBe(true);
    expect(runsOf(untimed.pages, 'section-meta')[0].text).toContain('时间未标注');

    const timed = buildA4Sheet(itemOf({
      language: 'zh',
      lyrics: [lyric('l1', 17_048, '第一句'), lyric('l2', 75_500, '第二句')],
    }), [section({ id: 's1', type: 'verse', label: 'A1', startMs: 0, endMs: 90_000 })]);
    expect(runsOf(timed.pages, 'time').map(run => run.text)).toEqual(['00:17', '01:15']);
    expect(runsOf(timed.pages, 'section-meta')[0].text).toContain('00:00–01:30');
  });

  it('长歌自动分页，段标题不会孤零零留在页尾', () => {
    const lyrics: TimedLyric[] = [];
    const sections: VocalSection[] = [];
    for (let block = 0; block < 3; block += 1) {
      const startMs = block * 90_000;
      sections.push(section({
        id: `s${block}`, type: block === 1 ? 'chorus' : 'verse',
        label: block === 1 ? 'B1' : `A${block === 0 ? 1 : 2}`, startMs, endMs: startMs + 90_000,
      }));
      for (let i = 0; i < 27; i += 1) {
        lyrics.push(lyric(`l-${block}-${i}`, startMs + i * 3000 + 500, `第${block + 1}段第${i + 1}句歌词`));
      }
    }

    const sheet = buildA4Sheet(itemOf({ language: 'zh', lyrics }), sections, { hasUsableTiming: true });

    expect(sheet.meta.pageCount).toBeGreaterThan(1);
    expect(sheet.meta.lineCount).toBe(81);
    expect(sheet.pages).toHaveLength(sheet.meta.pageCount);

    for (const page of sheet.pages) {
      const content = page.runs.filter(run => run.kind === 'section' || run.kind === 'lyric');
      expect(content.length).toBeGreaterThan(1);
      // 页尾不能是段标题：最后一个内容 run 必须是歌词行。
      expect(content[content.length - 1].kind).toBe('lyric');

      let cursor = 0;
      while (cursor < content.length) {
        if (content[cursor].kind !== 'section') { cursor += 1; continue; }
        const continued = content[cursor].text.endsWith('（续）');
        const required = continued ? 1 : 2;
        let followed = 0;
        let next = cursor + 1;
        while (next < content.length && content[next].kind === 'lyric') { followed += 1; next += 1; }
        expect(followed).toBeGreaterThanOrEqual(required);
        cursor = next;
      }
    }

    const pageNumbers = runsOf(sheet.pages, 'page-number').map(run => run.text);
    expect(pageNumbers[0]).toBe(`1/${sheet.meta.pageCount}`);
    expect(pageNumbers[pageNumbers.length - 1]).toBe(`${sheet.meta.pageCount}/${sheet.meta.pageCount}`);

    // 每一行都留了右侧手写备注空白：文字右边界与页右边距之间有可见间隔。
    const lyrics1 = runsOf(sheet.pages, 'lyric');
    const layout = sheet.meta.layout;
    const rightEdge = A4_SHEET_METRICS.pageWidthPt - layout.marginPt;
    for (const run of lyrics1) expect(rightEdge - run.x).toBeGreaterThan(layout.noteGutterPt);
  });

  it('序号从 1 连续编号到末行', () => {
    const lyrics = Array.from({ length: 40 }, (_, i) => lyric(`l${i}`, i * 3000 + 1000, `第${i + 1}句`));
    const sheet = buildA4Sheet(itemOf({ language: 'zh', lyrics }), [
      section({ id: 's1', type: 'verse', label: 'A1', startMs: 0, endMs: 60_000 }),
      section({ id: 's2', type: 'chorus', label: 'B1', startMs: 60_000, endMs: 120_000 }),
    ]);

    const indexes = runsOf(sheet.pages, 'index').map(run => Number.parseInt(run.text, 10));
    expect(indexes).toHaveLength(40);
    expect(indexes).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it('结构标签：编号 + 类型、Rap 待确认、重复关系与来源标记', () => {
    const sheet = buildA4Sheet(itemOf({
      language: 'zh',
      lyrics: [lyric('l1', 1000, '第一句'), lyric('l2', 31_000, '第二句'), lyric('l3', 61_000, '第三句'), lyric('l4', 71_000, '第四句')],
    }), [
      section({ id: 'a1', type: 'verse', label: 'A1', startMs: 0, endMs: 30_000, source: 'algorithm' }),
      section({ id: 'b1', type: 'chorus', label: 'B1', startMs: 30_000, endMs: 60_000, source: 'algorithm' }),
      section({ id: 'r1', type: 'rap', label: 'R1', startMs: 60_000, endMs: 70_000, source: 'algorithm', rapApproved: false }),
      section({ id: 'b2', type: 'chorus', label: 'B2', startMs: 70_000, endMs: 100_000, source: 'algorithm', repeatOf: 'b1', repetition: 'exact-lyrics' }),
    ]);

    const headings = runsOf(sheet.pages, 'section').map(run => run.text);
    expect(headings).toEqual(['A1 主歌', 'B1 副歌', 'R1 Rap', 'B2 副歌']);

    const metas = runsOf(sheet.pages, 'section-meta').map(run => run.text);
    expect(metas[2]).toContain('Rap 待确认');
    expect(metas[3]).toContain('同词重复 B1');
    expect(sheet.meta.sourceLabel).toBe('机器参考');
    expect(sheet.meta.structureSource).toBe('machine');
  });

  it('人工修订的全段结构标记为人工已修订；不写回任何结构', () => {
    const sections = [
      section({ id: 'a1', type: 'verse', label: 'A1', startMs: 0, endMs: 30_000, source: 'manual' }),
      section({ id: 'b1', type: 'chorus', label: 'B1', startMs: 30_000, endMs: 60_000, source: 'manual' }),
    ];
    const snapshot = JSON.stringify(sections);
    const sheet = buildA4Sheet(itemOf({ language: 'zh', lyrics: [lyric('l1', 1000, '第一句')] }), sections);

    expect(sheet.meta.sourceLabel).toBe('人工已修订');
    expect(JSON.stringify(sections)).toBe(snapshot);
  });

  it('没有分段时仍按歌词行输出并明确标注', () => {
    const sheet = buildA4Sheet(itemOf({ language: 'zh', lyrics: [lyric('l1', 1000, '第一句'), lyric('l2', 5000, '第二句')] }), []);

    expect(sheet.meta.noSections).toBe(true);
    expect(sheet.meta.sourceLabel).toBe('无分段（仅歌词行）');
    expect(runsOf(sheet.pages, 'section')[0].text).toBe('歌词全文');
    expect(runsOf(sheet.pages, 'lyric')).toHaveLength(2);
    expect(sheet.pages[0].runs.some(run => run.kind === 'page-number' && run.text === '1/1')).toBe(true);
  });
});
