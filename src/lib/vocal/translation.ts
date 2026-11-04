import type { TalentItem, TimedLyric, VocalLanguage, VocalTranslations } from '../types';

/**
 * 客户端译文规则（与 server/vocal-translation/translation.mjs 同口径）：
 * 译文按歌词行 id 绑定，不按下标；原文时间轴与原文文本永不被译文改写。
 */
export type TranslationScene = 'practice' | 'performance';

export interface TranslationSummary {
  total: number;
  translated: number;
  missing: number;
  manual: number;
  ai: number;
  lrc: number;
  stale: number;
}

const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const LATIN = /[A-Za-z]/g;

/** 段落标记与制作署名（`[Verse 1]`、`Chorus：김보아`、`Recording Engineer：…`）的识别规则。 */
const SECTION_MARKER = /^[\s[(（【]*((intro|verse|pre[- ]?chorus|chorus|hook|refrain|bridge|interlude|instrumental|outro|rap|dance break)\s*\d{0,2})[\s\]）)】]*[:：]?\s*$/i;
const CREDIT_LINE = /^([A-Za-z][A-Za-z0-9 .&'’\-]{0,32})\s*[:：]\s*(\S.{0,39})$/;
const CREDIT_ROLES = [
  /^(?:all\s+)?programming(?:\s+by)?$/i,
  /^(?:recording|mixing|mastering)(?:\s+engineer)?$/i,
  /^(?:produced|composed|arranged|written|mixed|mastered|engineered|directed)\s+by$/i,
  /^(?:producer|composer|lyricist|arranger|conductor)$/i,
  /^(?:vocal|vocals|background\s+vocals?|chorus|rap|hook)$/i,
  /^(?:guitar|bass|drums?|keyboard|keyboards|synthesizer|synth|strings|piano|percussion)$/i,
  /^(?:digital\s+editing|edited\s+by|director|artwork|photography|hair|makeup|stylist|music\s+video)$/i,
];

/**
 * 制作署名与段落标记不是歌词（与服务端 `isNonLyricLine` 同口径）。
 * 不一致会让练习页把「Recording Engineer：…」算成缺译文，永远挂着一个假的翻译按钮。
 */
export function isNonLyricLine(text: string): boolean {
  const value = String(text ?? '').trim();
  if (!value) return false;
  if (SECTION_MARKER.test(value)) return true;
  const match = value.match(CREDIT_LINE);
  if (!match) return false;
  if (HANGUL.test(match[1]) || /[\u3040-\u30ff]/.test(match[1])) return false;
  return CREDIT_ROLES.some(role => role.test(match[1].trim()));
}

/** 中文行判定：有汉字、无韩文，且汉字数不少于拉丁字母数（避免把英文夹一个汉字当译文）。 */
export function isChineseText(text: string): boolean {
  const value = String(text ?? '');
  if (!value.trim() || HANGUL.test(value)) return false;
  const han = value.match(HAN)?.length ?? 0;
  const latin = value.match(LATIN)?.length ?? 0;
  return han > 0 && han >= latin;
}

export function readTranslations(item: Pick<TalentItem, 'translations'>): VocalTranslations | null {
  const doc = item.translations;
  if (!doc || !Array.isArray(doc.lines) || !doc.lines.length) return null;
  return doc;
}

export function translationIndex(translations: VocalTranslations | null): Map<string, { text: string; source: string; stale?: boolean }> {
  return new Map((translations?.lines || []).map(line => [line.id, { text: line.text, source: line.source, stale: line.stale }]));
}

/**
 * 统计「还差几句译文」。口径与服务端 `translatableLines` 一致：
 * 空行不算；非中文歌里本身就是中文的行（老双语 LRC 残留）已经是译文，不算缺；
 * 制作署名与段落标记不是歌词，也不算缺。
 * 不一致会让练习页永远挂着「翻译缺失 1 句」的假按钮（点下去服务端回 NOTHING_TO_DO）。
 */
export function summarizeTranslations(
  lyrics: TimedLyric[],
  translations: VocalTranslations | null,
  language?: VocalLanguage,
): TranslationSummary {
  // 中文原唱只有一个中文层：没有「译文」这个概念，绝不给 UI 累计缺译文。
  if (language === 'zh') {
    return { total: 0, translated: 0, missing: 0, manual: 0, ai: 0, lrc: 0, stale: 0 };
  }
  const nonEmpty = lyrics.filter(line => line.text && line.text.trim());
  const sourceLines = nonEmpty.filter(line => !isNonLyricLine(line.text) && !isChineseText(line.text));
  const ids = new Set(sourceLines.map(line => line.id));
  const lines = (translations?.lines || []).filter(line => ids.has(line.id));
  return {
    total: sourceLines.length,
    translated: lines.length,
    missing: Math.max(0, sourceLines.length - lines.length),
    manual: lines.filter(line => line.source === 'manual').length,
    ai: lines.filter(line => line.source === 'ai').length,
    lrc: lines.filter(line => line.source === 'lrc').length,
    stale: lines.filter(line => line.stale).length,
  };
}

/**
 * 同文译文判定：去掉空白、标点与大小写差异后，译文与原文完全一致即视为冗余。
 * 中文原唱下旧数据里可能残留「中文 → 同一句中文」的译文，渲染层必须不显示。
 */
export function isRedundantTranslation(source: string, target: string): boolean {
  const normalize = (value: string): string => String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}]/gu, '');
  const left = normalize(source);
  return left.length > 0 && left === normalize(target);
}

/**
 * 默认显示：练习按用户口径默认「原文 + 中文」双语（有译文时）；
 * 演出默认只看原文，需要时手动切换，避免现场误点或误联网。
 */
export function defaultShowTranslation(item: Pick<TalentItem, 'language' | 'translations'>, scene: TranslationScene): boolean {
  if (!readTranslations(item)) return false;
  if (scene === 'performance') return false;
  return item.language !== 'zh';
}

/** 练习页开关文案：韩文歌说「韩中」，英文歌说「英中」，未标语言说「原文 + 中文」。 */
export function translationToggleLabel(language: VocalLanguage | undefined, showing: boolean): string {
  const pair = language === 'ko' ? '韩中' : language === 'en' ? '英中' : '原文 + 中文';
  return showing ? `隐藏中文（${pair}）` : `显示中文（${pair}）`;
}

/** 人工纠错：生成整份译文文档（replace 语义），空文本表示删除该句译文。未改动的行保留原来源。 */
export function manualTranslationDoc(
  item: Pick<TalentItem, 'lyrics' | 'translations'>,
  lineId: string,
  text: string,
): { lines: { id: string; text: string; source: 'lrc' | 'ai' | 'manual' }[]; replace: true } {
  const current = new Map((item.translations?.lines || []).map(line => [line.id, { ...line }]));
  const trimmed = text.trim();
  if (trimmed) current.set(lineId, { id: lineId, text: trimmed, source: 'manual' });
  else current.delete(lineId);
  const order = new Map((item.lyrics || []).map((line, index) => [line.id, index]));
  const lines = [...current.values()]
    .filter(line => order.has(line.id))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map(line => ({ id: line.id, text: line.text, source: line.source }));
  return { lines, replace: true };
}
