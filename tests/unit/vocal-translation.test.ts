import { describe, expect, it } from 'vitest';
import {
  defaultShowTranslation, isNonLyricLine, isRedundantTranslation, manualTranslationDoc, readTranslations,
  summarizeTranslations, translationIndex, translationToggleLabel,
} from '../../src/lib/vocal/translation';
import type { TalentItem, TimedLyric } from '../../src/lib/types';

const lyrics: TimedLyric[] = [
  { id: 'line-1', startMs: 1000, text: '첫 번째 줄' },
  { id: 'line-2', startMs: 3000, text: '두 번째 줄' },
  { id: 'line-3', startMs: 5000, text: '세 번째 줄' },
];

const translations = {
  version: 1 as const,
  language: 'zh' as const,
  source: 'ai' as const,
  lines: [
    { id: 'line-1', text: '第一句', source: 'ai' as const },
    { id: 'line-3', text: '第三句', source: 'manual' as const },
  ],
};

const item = (extra: Partial<TalentItem> = {}): TalentItem => ({
  id: 'vocal-1', kind: 'VOCAL', title: '테스트', artist: '', learningStatus: 'PRACTICING',
  originalKey: '', performanceKey: '', capo: 0, scoreText: '', notes: '', audioRole: 'REFERENCE',
  durationMs: 60000, language: 'ko', lyrics, translations, ...extra,
} as TalentItem);

describe('歌词译文展示规则', () => {
  it('译文按歌词行 id 关联，不按下标', () => {
    const index = translationIndex(translations);
    expect(index.get('line-1')?.text).toBe('第一句');
    expect(index.get('line-2')).toBeUndefined();
    expect(index.get('line-3')?.source).toBe('manual');
  });

  it('练习默认韩中双语，演出默认只看原文', () => {
    expect(defaultShowTranslation(item(), 'practice')).toBe(true);
    expect(defaultShowTranslation(item(), 'performance')).toBe(false);
  });

  it('没有译文时练习也不强行显示空对照', () => {
    expect(defaultShowTranslation(item({ translations: undefined }), 'practice')).toBe(false);
    expect(readTranslations(item({ translations: undefined }))).toBeNull();
  });

  it('中文歌不把中文当译文', () => {
    expect(defaultShowTranslation(item({ language: 'zh' }), 'practice')).toBe(false);
  });

  it('统计能区分缺失、人工、AI 与原文已改', () => {
    const summary = summarizeTranslations(lyrics, {
      ...translations,
      lines: translations.lines.map(line => line.id === 'line-1' ? { ...line, stale: true } : line),
    });
    expect(summary).toMatchObject({ total: 3, translated: 2, missing: 1, manual: 1, ai: 1, stale: 1 });
  });

  it('老双语 LRC 里残留的中文行不算缺译文，也不把统计撑成负进度', () => {
    const bilingual: TimedLyric[] = [
      { id: 'line-1', startMs: 1000, text: '내가 달리는 길은' },
      { id: 'line-2', startMs: 1000, text: '我奔跑的那条路' },
      { id: 'line-3', startMs: 3000, text: '허나 그 길엔 온통 덫' },
    ];
    const summary = summarizeTranslations(bilingual, {
      version: 1, language: 'zh',
      lines: [
        { id: 'line-1', text: '我奔跑的那条路', source: 'lrc' },
        { id: 'line-3', text: '然而那条路上满是陷阱', source: 'lrc' },
      ],
    }, 'ko');
    expect(summary).toMatchObject({ total: 2, translated: 2, missing: 0, lrc: 2 });
  });

  it('中文歌不累计缺译文，绝不触发「翻译缺失 N 句」', () => {
    const chinese = [{ id: 'c1', startMs: 0, text: '第一句中文' }, { id: 'c2', startMs: 2000, text: '第二句中文' }];
    expect(summarizeTranslations(chinese, null, 'zh')).toMatchObject({ total: 0, translated: 0, missing: 0 });
    // 旧数据里残留的同文中文字段也不能把它撑出缺失。
    expect(summarizeTranslations(chinese, {
      version: 1, language: 'zh',
      lines: [{ id: 'c1', text: '第一句中文', source: 'ai' }],
    }, 'zh')).toMatchObject({ missing: 0 });
    expect(summarizeTranslations(chinese, null, 'ko')).toMatchObject({ total: 0, missing: 0 });
  });

  it('韩/英歌曲仍逐行累计缺失，译文按行 id 配对不串行', () => {
    const english: TimedLyric[] = [
      { id: 'e1', startMs: 0, text: 'Hold me tight' },
      { id: 'e2', startMs: 1000, text: 'Never let me go' },
      { id: 'e3', startMs: 2000, text: 'Into the night' },
    ];
    const summary = summarizeTranslations(english, {
      version: 1, language: 'zh',
      lines: [
        { id: 'e1', text: '抱紧我', source: 'ai' },
        { id: 'e3', text: '走进夜色', source: 'manual' },
      ],
    }, 'en');
    expect(summary).toMatchObject({ total: 3, translated: 2, missing: 1, manual: 1, ai: 1 });

    const index = translationIndex({ version: 1, language: 'zh', lines: [
      { id: 'e1', text: '抱紧我', source: 'ai' },
      { id: 'e3', text: '走进夜色', source: 'manual' },
    ] });
    expect(index.get('e1')?.text).toBe('抱紧我');
    expect(index.get('e3')?.text).toBe('走进夜色');
    expect(index.get('e2')).toBeUndefined();

    expect(summarizeTranslations(lyrics, null, 'ko')).toMatchObject({ total: 3, missing: 3 });
  });

  it('同文译文（含空白/标点差异）判为冗余，外语真译文不被误杀', () => {
    expect(isRedundantTranslation('第一句中文', '第一句中文')).toBe(true);
    expect(isRedundantTranslation('第一句中文', ' 第一句 中文。')).toBe(true);
    expect(isRedundantTranslation('Hold me tight', 'hold me tight!')).toBe(true);
    expect(isRedundantTranslation('내가 달리는 길은', '我奔跑的那条路')).toBe(false);
    expect(isRedundantTranslation('第一句中文', '')).toBe(false);
  });

  it('制作署名与段落标记不算缺译文，真歌词行不被误判', () => {
    const mixed: TimedLyric[] = [
      { id: 'line-1', startMs: 0, text: 'Chorus：김보아' },
      { id: 'line-2', startMs: 100, text: 'All Programming by：신사동호랭이' },
      { id: 'line-3', startMs: 200, text: 'Recording Engineer：전부연' },
      { id: 'line-4', startMs: 300, text: '[Verse 1]' },
      { id: 'line-5', startMs: 400, text: '나 I am just 26 26 26' },
      { id: 'line-6', startMs: 500, text: 'Tell me I am your babe babe' },
    ];
    const summary = summarizeTranslations(mixed, null, 'ko');
    expect(summary).toMatchObject({ total: 2, missing: 2 });
    expect(isNonLyricLine('Chorus：김보아')).toBe(true);
    expect(isNonLyricLine('Mastering Engineer：권남우')).toBe(true);
    expect(isNonLyricLine('울고 있는 너에게：말해')).toBe(false);
    expect(isNonLyricLine('Tell me I am your babe babe')).toBe(false);
  });

  it('开关文案按语言区分韩中 / 英中', () => {
    expect(translationToggleLabel('ko', true)).toContain('隐藏中文');
    expect(translationToggleLabel('en', false)).toContain('英中');
    expect(translationToggleLabel(undefined, false)).toContain('原文 + 中文');
  });
});

describe('人工纠错文档', () => {
  it('只把被编辑的行标为 manual，其他译文来源保持不变', () => {
    const doc = manualTranslationDoc(item(), 'line-2', '  第二句  ');
    expect(doc.replace).toBe(true);
    expect(doc.lines).toEqual([
      { id: 'line-1', text: '第一句', source: 'ai' },
      { id: 'line-2', text: '第二句', source: 'manual' },
      { id: 'line-3', text: '第三句', source: 'manual' },
    ]);
  });

  it('空文本只删除该句译文，不整份清空', () => {
    const doc = manualTranslationDoc(item(), 'line-1', '   ');
    expect(doc.lines.map(line => line.id)).toEqual(['line-3']);
  });

  it('按歌词顺序输出，悬空行被丢弃', () => {
    const doc = manualTranslationDoc(item({ lyrics: [lyrics[2], lyrics[0], lyrics[1]] }), 'line-2', '第二句');
    expect(doc.lines.map(line => line.id)).toEqual(['line-3', 'line-1', 'line-2']);
    const dangling = manualTranslationDoc(item({ lyrics: [lyrics[0]] }), 'line-2', '第二句');
    expect(dangling.lines.map(line => line.id)).toEqual(['line-1']);
  });
});
