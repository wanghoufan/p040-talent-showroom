import type { TalentItem, TimedLyric, VocalSection } from '../types';
import { isRapConfirmed, sectionHeading, sectionsSignature, sortByTime } from './structure';
import { isRedundantTranslation, translationIndex } from './translation';

/**
 * A4 分段学习稿的纯排版（P040 §6）。没有 DOM、没有网络、没有副作用：
 * 同一份 `{ meta, pages }` 既喂 HTML 预览，也喂 canvas → PDF，避免两套版式对不上。
 *
 * 硬约束：
 * - 只读 `item.lyrics` / `item.translations` / `sections`，不写回任何结构或译文；
 * - 中文原唱不输出译文行（`language === 'zh'` 或译文与原文同文）；
 * - 行高是固定度量（10.5pt 字 / 15pt 行），靠估算换行保证一行不会被页边界裁切。
 */

/** A4 纵向（pt）。1mm = 2.834645pt，14mm ≈ 39.69pt。 */
export const A4_SHEET_METRICS = {
  pageWidthPt: 595.28,
  pageHeightPt: 841.89,
  marginPt: 39.69,
  headerHeightPt: 38,
  fontSizePt: 10.5,
  lineHeightPt: 15,
  translationFontPt: 9,
  translationLineHeightPt: 13,
  metaFontPt: 8.5,
  headingFontPt: 11,
  sectionGapPt: 12,
  noteGutterPt: 58,
  /** 预览默认缩放：HTML 按 1:0.72 显示，和打印在同一坐标系下。 */
  previewScale: 0.72,
} as const;

/** canvas 与 HTML 用同一套字体，缺字时回落到系统字体，不嵌字体文件。 */
export const SHEET_FONT_STACK = '"Noto Sans SC", "Noto Sans KR", "PingFang SC", "Microsoft YaHei", "Malgun Gothic", sans-serif';

const PAGE_W = A4_SHEET_METRICS.pageWidthPt;
const PAGE_H = A4_SHEET_METRICS.pageHeightPt;
const MARGIN = A4_SHEET_METRICS.marginPt;
const HEADER_H = A4_SHEET_METRICS.headerHeightPt;
const CONTENT_TOP = MARGIN + HEADER_H;
const CONTENT_BOTTOM = PAGE_H - MARGIN;
const CONTENT_W = PAGE_W - MARGIN * 2;

const TIME_W = 36;
const GAP = 6;
const INDEX_W = 26;
const NOTE_W = A4_SHEET_METRICS.noteGutterPt;
const TEXT_LEFT = MARGIN + TIME_W + GAP;
const NOTE_X = MARGIN + CONTENT_W - NOTE_W;
const INDEX_RIGHT = NOTE_X - 4;
const TEXT_RIGHT = INDEX_RIGHT - INDEX_W;
const TEXT_W = TEXT_RIGHT - TEXT_LEFT;
/** 段标题 + 起止时间两行的高度。 */
const HEADING_H = 25;
const EMPTY_H = A4_SHEET_METRICS.lineHeightPt;
/** 段标题后面至少跟 2 行，避免标题孤零零留在页尾。 */
const MIN_ORPHAN_ROWS = 2;

export type A4RunKind = 'title' | 'meta' | 'page-number' | 'section' | 'section-meta'
  | 'time' | 'lyric' | 'translation' | 'index' | 'note-label' | 'empty';

/** 一行文字；`x` 是左边界（左对齐）或右边界（右对齐），`y` 是文字顶部。 */
export interface A4Run {
  kind: A4RunKind;
  x: number;
  y: number;
  size: number;
  weight: number;
  align: 'left' | 'right';
  text: string;
  /** 译文/时标/序号等次要信息：打印时用灰色，但黑白下仍靠字号区分。 */
  muted?: boolean;
}

export interface A4Rule {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  dashed?: boolean;
}

export interface A4SheetPage {
  index: number;
  total: number;
  runs: A4Run[];
  rules: A4Rule[];
}

export interface A4SheetLayout {
  pageWidthPt: number;
  pageHeightPt: number;
  marginPt: number;
  contentWidthPt: number;
  noteGutterPt: number;
  fontSizePt: number;
  lineHeightPt: number;
  previewScale: number;
}

export interface A4SheetMeta {
  songId: string;
  title: string;
  artist: string;
  versionLabel: string;
  revisionLabel: string;
  /** 「机器参考」或「人工已修订」——算法结论不能冒充官方。 */
  sourceLabel: string;
  structureSource: 'machine' | 'manual' | 'none';
  generatedAt: string;
  pageCount: number;
  lineCount: number;
  sectionCount: number;
  /** 没有可用分段：只按歌词行输出。 */
  noSections: boolean;
  layout: A4SheetLayout;
}

export interface A4Sheet {
  meta: A4SheetMeta;
  pages: A4SheetPage[];
}

export interface A4SheetOptions {
  /** 音频/曲目版本文字；缺省时用原唱轨版本号推导。 */
  version?: string;
  /** 结构修订号；缺省时按结构指纹算一个短哈希，只用于核对纸上版本。 */
  revision?: string;
  generatedAt?: string;
  /** 覆盖「有无真实时标」的判断；默认看是否至少一行 startMs > 0。 */
  hasUsableTiming?: boolean;
  /** 单行最多换几行，防止极端长句撑破一页。 */
  maxWrapLines?: number;
}

const LAYOUT: A4SheetLayout = {
  pageWidthPt: PAGE_W,
  pageHeightPt: PAGE_H,
  marginPt: MARGIN,
  contentWidthPt: CONTENT_W,
  noteGutterPt: NOTE_W,
  fontSizePt: A4_SHEET_METRICS.fontSizePt,
  lineHeightPt: A4_SHEET_METRICS.lineHeightPt,
  previewScale: A4_SHEET_METRICS.previewScale,
};

const WIDE_CHAR = /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

/** 固定度量的字宽估算：全角按 1em，拉丁按 0.55em，空格更窄。 */
function charWidth(ch: string, size: number): number {
  if (/\s/.test(ch)) return size * 0.32;
  if (WIDE_CHAR.test(ch)) return size;
  return size * 0.55;
}

export function estimateTextWidth(text: string, size: number): number {
  let total = 0;
  for (const ch of text) total += charWidth(ch, size);
  return total;
}

/** 按固定度量贪心换行；返回的每一段都是完整的一行，渲染端不再二次折行。 */
export function wrapText(text: string, size: number, maxWidth: number, maxLines = 3): string[] {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return [''];
  const lines: string[] = [];
  let current = '';
  let width = 0;
  for (const ch of value) {
    const next = charWidth(ch, size);
    if (current && width + next > maxWidth) {
      lines.push(current.trimEnd());
      current = '';
      width = 0;
      if (ch === ' ') continue;
    }
    current += ch;
    width += next;
  }
  if (current.trim()) lines.push(current.trim());
  if (!lines.length) lines.push('');
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].replace(/…$/, '')}…`;
    return kept;
  }
  return lines;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `mm:ss`；分钟不封顶，超长歌曲也不会回绕。 */
export function sheetClock(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/** 结构指纹 → 短修订号。只用于让纸面与当前结构对得上，不是数据库修订。 */
function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(6, '0').slice(0, 6);
}

/** 重复关系说明（与练习页同一口径，但这里只输出文字）。 */
function repetitionText(section: VocalSection, labelOf: Map<string, string>): string | null {
  const target = section.repeatOf ? labelOf.get(section.repeatOf) ?? section.repeatOf : null;
  switch (section.repetition) {
    case 'exact-lyrics': return target ? `同词重复 ${target}` : '同词重复';
    case 'same-melody-new-lyrics': return target ? `旋律同 ${target}、歌词不同` : '旋律重复、歌词不同';
    case 'unverified': return target ? `重复 ${target}（未校验）` : '重复未校验';
    default: return target ? `重复 ${target}` : null;
  }
}

/** Rap 标签：纸上必须能看出「这是算法猜的、还没被确认」。未标注类型已写在段标题里，不重复。 */
function sectionTags(section: VocalSection): string[] {
  return section.type === 'rap' ? [isRapConfirmed(section) ? 'Rap 已确认' : 'Rap 待确认'] : [];
}

interface SheetRow {
  number: number;
  time: string;
  originalLines: string[];
  translationLines: string[];
  height: number;
}

interface SheetBlock {
  heading: string;
  meta: string;
  rows: SheetRow[];
  emptyText?: string;
}

function lineInSection(line: TimedLyric, section: VocalSection): boolean {
  const start = Number.isFinite(line.startMs) ? line.startMs : 0;
  return start >= section.startMs && start < section.endMs;
}

function rowsOf(
  lines: readonly TimedLyric[],
  timed: boolean,
  options: {
    translations: Map<string, { text: string; source: string; stale?: boolean }>;
    hideTranslation: boolean;
    maxWrapLines: number;
    nextNumber: () => number;
  },
): SheetRow[] {
  return lines.map((line) => {
    const rawText = String(line.text ?? '').replace(/\s+/g, ' ').trim();
    const originalLines = wrapText(rawText, A4_SHEET_METRICS.fontSizePt, TEXT_W, options.maxWrapLines);
    let translationLines: string[] = [];
    if (!options.hideTranslation) {
      const translated = options.translations.get(line.id)?.text?.trim() ?? '';
      if (translated && !isRedundantTranslation(rawText, translated)) {
        translationLines = wrapText(translated, A4_SHEET_METRICS.translationFontPt, TEXT_W, options.maxWrapLines);
      }
    }
    const height = originalLines.length * A4_SHEET_METRICS.lineHeightPt
      + translationLines.length * A4_SHEET_METRICS.translationLineHeightPt
      + 4;
    return {
      number: options.nextNumber(),
      time: timed ? sheetClock(line.startMs) : '—',
      originalLines,
      translationLines,
      height,
    };
  });
}

function metaLine(parts: (string | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part && String(part).trim())).join(' · ');
}

/**
 * 生成 A4 学习稿。
 * @param item 只读曲目（lyrics/translations/language）
 * @param sections 当前结构；为空时整首按「未分段」输出
 */
export function buildA4Sheet(
  item: TalentItem,
  sections: readonly VocalSection[] = [],
  options: A4SheetOptions = {},
): A4Sheet {
  const lyrics = (Array.isArray(item.lyrics) ? item.lyrics : [])
    .filter((line): line is TimedLyric => Boolean(line) && typeof line.text === 'string' && line.text.trim().length > 0);
  const ordered = sortByTime(sections);
  const labelOf = new Map(ordered.map((section) => [section.id, section.label]));
  const translations = translationIndex(item.translations ?? null);
  const hideTranslation = item.language === 'zh';
  const timed = options.hasUsableTiming ?? lyrics.some((line) => Number.isFinite(line.startMs) && line.startMs > 0);
  const maxWrapLines = options.maxWrapLines ?? 3;

  let counter = 0;
  const nextNumber = (): number => { counter += 1; return counter; };
  const rowOptions = { translations, hideTranslation, maxWrapLines, nextNumber };

  const blocks: SheetBlock[] = [];
  const assigned = new Set<string>();

  for (const section of ordered) {
    const lines = lyrics.filter((line) => lineInSection(line, section));
    lines.forEach((line) => assigned.add(line.id));
    const tags = sectionTags(section);
    const repetition = repetitionText(section, labelOf);
    blocks.push({
      heading: sectionHeading(section),
      meta: metaLine([
        timed ? `${sheetClock(section.startMs)}–${sheetClock(section.endMs)}` : '时间未标注',
        ...tags,
        repetition,
      ]),
      rows: rowsOf(lines, timed, rowOptions),
      emptyText: lines.length ? undefined : '（本段无歌词行）',
    });
  }

  const leftover = lyrics.filter((line) => !assigned.has(line.id));
  if (leftover.length) {
    blocks.push({
      heading: ordered.length ? '未收录段' : '歌词全文',
      meta: ordered.length ? '不在任何分段范围内 · 待人工校准' : '暂无分段，只按歌词行输出',
      rows: rowsOf(leftover, timed, rowOptions),
    });
  }

  if (!blocks.length) {
    blocks.push({ heading: '歌词全文', meta: '暂无分段，只按歌词行输出', rows: [], emptyText: '（没有可打印的歌词）' });
  }

  const manualCount = ordered.filter((section) => section.source === 'manual').length;
  const structureSource: A4SheetMeta['structureSource'] = !ordered.length
    ? 'none'
    : manualCount === ordered.length ? 'manual' : 'machine';
  const sourceLabel = structureSource === 'none'
    ? '无分段（仅歌词行）'
    : structureSource === 'manual' ? '人工已修订' : manualCount > 0 ? '机器参考（含人工段）' : '机器参考';

  const versionLabel = options.version
    ?? (item.tracks?.original?.media.version ? `音频版本 ${item.tracks.original.media.version}` : '版本未标注');
  const revisionLabel = options.revision
    ?? `结构 ${ordered.length ? shortHash(sectionsSignature(ordered)) : '无'}`;

  const title = String(item.title ?? '').trim() || '未命名';
  const artist = String(item.artist ?? '').trim();
  const headerTitle = artist ? `《${title}》 · ${artist}` : `《${title}》`;
  const headerMeta = metaLine([versionLabel, revisionLabel, sourceLabel]);

  const pages: A4SheetPage[] = [];
  let runs: A4Run[] = [];
  let rules: A4Rule[] = [];
  let y = CONTENT_TOP;

  const pushPage = (): void => {
    pages.push({ index: pages.length + 1, total: 0, runs, rules });
  };

  const newPage = (): void => {
    if (runs.length) pushPage();
    runs = [];
    rules = [
      { x1: MARGIN, y1: MARGIN + 30, x2: MARGIN + CONTENT_W, y2: MARGIN + 30 },
      { x1: NOTE_X, y1: CONTENT_TOP - 4, x2: NOTE_X, y2: CONTENT_BOTTOM, dashed: true },
    ];
    runs.push({ kind: 'title', x: MARGIN, y: MARGIN, size: 13, weight: 700, align: 'left', text: headerTitle });
    runs.push({ kind: 'meta', x: MARGIN, y: MARGIN + 16, size: A4_SHEET_METRICS.metaFontPt, weight: 400, align: 'left', muted: true, text: headerMeta });
    runs.push({ kind: 'note-label', x: NOTE_X + 4, y: MARGIN + 16, size: 7, weight: 400, align: 'left', muted: true, text: '备注' });
    y = CONTENT_TOP;
  };

  const drawHeading = (block: SheetBlock, continued: boolean): void => {
    runs.push({
      kind: 'section',
      x: MARGIN,
      y,
      size: A4_SHEET_METRICS.headingFontPt,
      weight: 700,
      align: 'left',
      text: continued ? `${block.heading}（续）` : block.heading,
    });
    runs.push({
      kind: 'section-meta',
      x: MARGIN,
      y: y + 14,
      size: A4_SHEET_METRICS.metaFontPt,
      weight: 400,
      align: 'left',
      muted: true,
      text: block.meta,
    });
    y += HEADING_H;
  };

  newPage();

  for (const block of blocks) {
    const first = block.rows.slice(0, MIN_ORPHAN_ROWS);
    const needed = HEADING_H + (first.length
      ? first.reduce((sum, row) => sum + row.height, 0)
      : EMPTY_H);
    if (y + needed > CONTENT_BOTTOM) newPage();
    drawHeading(block, false);

    if (!block.rows.length) {
      runs.push({
        kind: 'empty',
        x: TEXT_LEFT,
        y,
        size: A4_SHEET_METRICS.fontSizePt,
        weight: 400,
        align: 'left',
        muted: true,
        text: block.emptyText ?? '（无内容）',
      });
      y += EMPTY_H;
    }

    for (const row of block.rows) {
      if (y + row.height > CONTENT_BOTTOM) {
        newPage();
        drawHeading(block, true);
      }
      const rowY = y;
      runs.push({ kind: 'time', x: MARGIN, y: rowY, size: A4_SHEET_METRICS.metaFontPt, weight: 400, align: 'left', muted: true, text: row.time });
      row.originalLines.forEach((text, i) => {
        runs.push({
          kind: 'lyric',
          x: TEXT_LEFT,
          y: rowY + i * A4_SHEET_METRICS.lineHeightPt,
          size: A4_SHEET_METRICS.fontSizePt,
          weight: 400,
          align: 'left',
          text,
        });
      });
      const translationTop = rowY + row.originalLines.length * A4_SHEET_METRICS.lineHeightPt;
      row.translationLines.forEach((text, i) => {
        runs.push({
          kind: 'translation',
          x: TEXT_LEFT,
          y: translationTop + i * A4_SHEET_METRICS.translationLineHeightPt,
          size: A4_SHEET_METRICS.translationFontPt,
          weight: 400,
          align: 'left',
          muted: true,
          text,
        });
      });
      runs.push({
        kind: 'index',
        x: INDEX_RIGHT,
        y: rowY + 1,
        size: A4_SHEET_METRICS.metaFontPt,
        weight: 400,
        align: 'right',
        muted: true,
        text: String(row.number).padStart(3, '0'),
      });
      y += row.height;
    }

    y += A4_SHEET_METRICS.sectionGapPt;
  }

  pushPage();

  const total = pages.length;
  pages.forEach((page, i) => {
    page.total = total;
    page.runs.push({
      kind: 'page-number',
      x: MARGIN + CONTENT_W,
      y: MARGIN,
      size: 9,
      weight: 400,
      align: 'right',
      muted: true,
      text: `${i + 1}/${total}`,
    });
  });

  return {
    meta: {
      songId: item.id,
      title,
      artist,
      versionLabel,
      revisionLabel,
      sourceLabel,
      structureSource,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      pageCount: pages.length,
      lineCount: counter,
      sectionCount: ordered.length,
      noSections: ordered.length === 0,
      layout: LAYOUT,
    },
    pages,
  };
}
