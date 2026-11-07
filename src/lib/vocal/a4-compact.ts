import type { TalentItem, TimedLyric, VocalSection } from '../types';
import type { A4Rule, A4Run, A4Sheet, A4SheetPage } from './a4-sheet';
import { translationIndex, isRedundantTranslation } from './translation';
import { sectionHeading, isRapConfirmed } from './structure';
import { sortSections } from '../vocal';

/**
 * 一页 A4「学习稿」紧凑版（用户 2026-11-04 口径）：
 * - 一首歌的歌词一页放下；打印学习材料不要时间轴、不要序号；
 * - **双栏**：重复的段落（副歌等）放右栏，并与它第一次出现的位置上下对齐，
 *   让用户一眼看出「这段是重复的、歌词一样」，不用再读一遍；
 * - 左栏只走新内容；右栏放重复段，右栏放不下才回落左栏末尾。
 */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
/** 12mm 页边距：比正式稿紧，但避开家用打印机不可打印边。 */
const MARGIN = 34;
const CONTENT_W = PAGE_W - MARGIN * 2;
const COL_GAP = 14;
/** 左栏承担新内容，给多一点宽度；右栏只放重复段。 */
const LEFT_W = Math.round((CONTENT_W - COL_GAP) * 0.58);
const RIGHT_W = CONTENT_W - COL_GAP - LEFT_W;
const RIGHT_X = MARGIN + LEFT_W + COL_GAP;
const HEADER_H = 40;
const CONTENT_TOP = MARGIN + HEADER_H;
const CONTENT_BOTTOM = PAGE_H - MARGIN;

const SIZE_LADDER = [20, 19, 18, 17, 16, 15, 14.5, 14, 13.5, 13, 12.5, 12, 11.5, 11, 10.5, 10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6] as const;
const MIN_SIZE = 6;
/** 单页稿低于这个字号就改两页（用户 2026-11-05 口径：7pt 太小）。 */
const MIN_SINGLE_PAGE_SIZE = 10;
const HEADING_SIZE = 7.5;
const HEADING_GAP = 1.5;
const ROW_GAP = 1;
const TRANSLATION_RATIO = 0.86;

export interface CompactLine {
  text: string;
  translation?: string;
}

export interface CompactBlock {
  /** 段在曲目里的稳定标识（section id 或 leftover）。 */
  key: string;
  heading: string;
  rap: boolean;
  lines: CompactLine[];
  /** 重复段：指向它复用的第一段；右栏会对齐到该段顶部。 */
  repeatOf?: string;
  sourceLabel?: string;
}

interface DrawItem {
  kind: 'heading' | 'lyric' | 'translation';
  text: string;
  x: number;
  y: number;
  width: number;
  size: number;
  weight: number;
  muted: boolean;
}

function charWidth(char: string, size: number): number {
  // 全角：汉字、假名、谚文（U+AC00–D7A3 等）都按 1em 算，否则韩文会被判成半角而撞边。
  const wide = /[\u1100-\u11ff\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/.test(char);
  return wide ? size : size * 0.56;
}

/**
 * 断行：中日韩逐字断，拉丁文按单词断（避免把 "vacant" 拆成 "v acant"）。
 * 单词本身比栏还宽时才退化成逐字断。
 */
function hardWrap(text: string, size: number, widthPt: number, maxLines = 4): string[] {
  const limit = widthPt - 2;
  const out: string[] = [];
  let current = '';
  let width = 0;
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    const advance = charWidth(char, size);
    if (width + advance > limit && current) {
      const lastSpace = current.lastIndexOf(' ');
      if (lastSpace > 0 && !/[\u1100-\u11ff\u2e80-\u33ff\u3400-\u9fff\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\uff00-\uffef]/.test(char)) {
        out.push(current.slice(0, lastSpace));
        current = current.slice(lastSpace + 1);
        width = Array.from(current).reduce((sum, c) => sum + charWidth(c, size), 0);
      } else {
        out.push(current);
        current = '';
        width = 0;
      }
    }
    current += char;
    width += advance;
  }
  if (current) out.push(current);
  if (out.length > maxLines) {
    const kept = out.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]}…`;
    return kept;
  }
  return out;
}

const signatureOf = (lines: CompactLine[]): string => lines
  .map((line) => line.text.replace(/[\s\p{P}]/gu, '').toLowerCase())
  .filter(Boolean)
  .slice(0, 2)
  .join('|');

/**
 * 曲目 → 紧凑块。重复判定优先用结构里的 `repeatOf`；没有显式关系时用
 * 「前两句歌词相同」兜底（副歌重复通常前两句一致）。只影响打印排版，不写回结构。
 */
export function compactBlocks(item: TalentItem, sections: readonly VocalSection[] = []): CompactBlock[] {
  const lyrics = (Array.isArray(item.lyrics) ? item.lyrics : [])
    .filter((line): line is TimedLyric => Boolean(line) && typeof line.text === 'string' && line.text.trim().length > 0);
  const index = translationIndex(item.translations ?? null);
  const ordered = sortSections(sections);
  const blocks: CompactBlock[] = [];
  const assigned = new Set<string>();

  const toLine = (line: TimedLyric): CompactLine => {
    const trans = index.get(line.id);
    return trans && !isRedundantTranslation(line.text, trans.text)
      ? { text: line.text, translation: trans.text }
      : { text: line.text };
  };

  const byId = new Map(ordered.map((section) => [section.id, section]));
  const firstBySignature = new Map<string, string>();

  for (const section of ordered) {
    const lines = lyrics.filter((line) => line.startMs >= section.startMs && line.startMs < Math.max(section.endMs, section.startMs + 1));
    lines.forEach((line) => assigned.add(line.id));
    const rap = section.type === 'rap' && isRapConfirmed(section);
    const block: CompactBlock = {
      key: section.id,
      heading: rap ? `${sectionHeading(section)} · Rap` : sectionHeading(section),
      rap,
      lines: lines.map(toLine),
      sourceLabel: section.label,
    };

    const explicit = section.repeatOf && section.repeatOf !== section.id ? byId.get(section.repeatOf) : undefined;
    const signature = signatureOf(block.lines);
    const earlier = signature ? firstBySignature.get(signature) : undefined;
    if (explicit) block.repeatOf = explicit.id;
    else if (earlier) block.repeatOf = earlier;

    if (signature && !firstBySignature.has(signature)) firstBySignature.set(signature, section.id);
    blocks.push(block);
  }

  const leftover = lyrics.filter((line) => !assigned.has(line.id));
  if (leftover.length) {
    blocks.push({
      key: ordered.length ? 'leftover' : 'all',
      heading: ordered.length ? '未收录段' : '歌词全文',
      rap: false,
      lines: leftover.map(toLine),
    });
  }
  return blocks;
}

function blockHeight(block: CompactBlock, size: number, width: number): number {
  const lineHeight = Math.round(size * 1.34 * 10) / 10;
  const transSize = Math.round(size * TRANSLATION_RATIO * 10) / 10;
  const transLine = Math.round(transSize * 1.34 * 10) / 10;
  let height = HEADING_SIZE + HEADING_GAP + 2;
  for (const line of block.lines) {
    height += hardWrap(line.text, size, width).length * lineHeight;
    if (line.translation) height += hardWrap(line.translation, transSize, width).length * transLine;
    height += ROW_GAP;
  }
  return height;
}

function emitBlock(
  block: CompactBlock,
  size: number,
  x: number,
  width: number,
  top: number,
  items: DrawItem[],
): number {
  const lineHeight = Math.round(size * 1.34 * 10) / 10;
  const transSize = Math.round(size * TRANSLATION_RATIO * 10) / 10;
  const transLine = Math.round(transSize * 1.34 * 10) / 10;
  let y = top;
  items.push({ kind: 'heading', text: block.heading, x, y, width, size: HEADING_SIZE, weight: 700, muted: false });
  y += HEADING_SIZE + HEADING_GAP + 2;
  for (const line of block.lines) {
    for (const piece of hardWrap(line.text, size, width)) {
      items.push({ kind: 'lyric', text: piece, x, y, width, size, weight: 600, muted: false });
      y += lineHeight;
    }
    if (line.translation) {
      for (const piece of hardWrap(line.translation, transSize, width)) {
        items.push({ kind: 'translation', text: piece, x, y, width, size: transSize, weight: 400, muted: true });
        y += transLine;
      }
    }
    y += ROW_GAP;
  }
  return y;
}

interface PageLayout {
  items: DrawItem[];
  bottom: number;
  repeatCount: number;
  placed: Set<string>;
}

/**
 * 单页双栏排版（三步，尽量把纸用满）：
 * 1) 新内容先顺序排左栏，排到页面底部为止；
 * 2) 重复段进右栏，对齐到它首次出现那段的顶部（右栏该高度被占就往下顺）；
 * 3) 左栏装不下的新内容接着排到右栏（从右栏已用高度下方继续），避免右下大片留白。
 * 本页放不下的段落由调用方带到下一页，绝不叠字、也不静默丢词。
 */
function layoutOnePage(blocks: CompactBlock[], size: number): PageLayout {
  const items: DrawItem[] = [];
  const positions = new Map<string, number>();
  const placed = new Set<string>();
  const overflow: CompactBlock[] = [];
  let leftY = CONTENT_TOP;
  let leftFull = false;

  for (const block of blocks) {
    if (block.repeatOf) continue;
    const height = blockHeight(block, size, LEFT_W);
    if (leftFull || leftY + height > CONTENT_BOTTOM) {
      leftFull = true;
      overflow.push(block);
      continue;
    }
    positions.set(block.key, leftY);
    leftY = emitBlock(block, size, MARGIN, LEFT_W, leftY, items);
    placed.add(block.key);
  }

  let rightY = CONTENT_TOP;
  let repeatCount = 0;
  const repeatFallback: CompactBlock[] = [];
  for (const block of blocks) {
    if (!block.repeatOf) continue;
    const anchor = positions.get(block.repeatOf);
    if (anchor === undefined) { repeatFallback.push(block); continue; }
    const height = blockHeight(block, size, RIGHT_W);
    const targetY = Math.max(anchor, rightY);
    if (targetY + height > CONTENT_BOTTOM) { repeatFallback.push(block); continue; }
    emitBlock({ ...block, heading: `${block.heading} · 重复` }, size, RIGHT_X, RIGHT_W, targetY, items);
    placed.add(block.key);
    rightY = targetY + height + 6;
    repeatCount += 1;
  }

  let bottom = Math.max(leftY, rightY);
  for (const block of [...overflow, ...repeatFallback]) {
    const height = blockHeight(block, size, RIGHT_W);
    if (rightY + height > CONTENT_BOTTOM) continue;
    rightY = emitBlock(block, size, RIGHT_X, RIGHT_W, rightY, items);
    placed.add(block.key);
    bottom = Math.max(bottom, rightY);
  }
  return { items, bottom, repeatCount, placed };
}

interface PagedLayout {
  pages: Array<PageLayout & { index: number }>;
  complete: boolean;
  repeatCount: number;
}

/** 单个段落比整页还高（长歌+译文）时，按行切成多段，保证「一页装不下就分页」而不是整段消失。 */
function splitBlockToFit(block: CompactBlock, size: number): CompactBlock[] {
  const usable = CONTENT_BOTTOM - CONTENT_TOP - (HEADING_SIZE + HEADING_GAP + 2);
  const parts: CompactBlock[] = [];
  let current: CompactLine[] = [];
  const heightOf = (lines: CompactLine[]): number => blockHeight({ ...block, lines }, size, LEFT_W);
  for (const line of block.lines) {
    const next = [...current, line];
    if (current.length && heightOf(next) > usable) {
      parts.push({ ...block, key: `${block.key}#${parts.length + 1}`, lines: current, repeatOf: undefined });
      current = [line];
    } else {
      current = next;
    }
  }
  if (current.length) parts.push({ ...block, key: `${block.key}#${parts.length + 1}`, lines: current, repeatOf: undefined });
  return parts.map((part, index) => (index === 0 ? { ...part, key: block.key } : { ...part, heading: `${part.heading}（续）` }));
}

/** 按页重复排版：上一页放不下的段落顺延到下一页，重复关系只在同页内对齐。 */
function layoutPages(blocks: CompactBlock[], size: number, maxPages: number): PagedLayout {
  const pages: Array<PageLayout & { index: number }> = [];
  let pending = blocks;
  let repeatCount = 0;
  while (pending.length && pages.length < maxPages) {
    const page = layoutOnePage(pending, size);
    if (!page.placed.size) {
      // 整段比一页还高：按行切段后重排，避免整首变成空白页。
      const parts = splitBlockToFit(pending[0], size);
      if (parts.length <= 1) break;
      pending = [...parts, ...pending.slice(1)];
      continue;
    }
    pages.push({ ...page, index: pages.length + 1 });
    repeatCount += page.repeatCount;
    const next = pending.filter((block) => !page.placed.has(block.key));
    if (next.length === pending.length) break; // 一页连一段都放不下：停手，交给字号下调
    pending = next;
  }
  return { pages, complete: pending.length === 0, repeatCount };
}

function buildPage(items: DrawItem[], header: { title: string; meta: string }, index: number, total: number): A4SheetPage {
  const runs: A4Run[] = [
    { kind: 'title', x: MARGIN, y: MARGIN, size: 11, weight: 700, align: 'left', text: header.title },
    { kind: 'meta', x: MARGIN, y: MARGIN + 14, size: 6.5, weight: 400, align: 'left', muted: true, text: header.meta },
    { kind: 'page-number', x: PAGE_W - MARGIN, y: MARGIN + 14, size: 6.5, weight: 400, align: 'right', muted: true, text: `第 ${index} / ${total} 页` },
  ];
  for (const item of items) {
    runs.push({
      kind: item.kind === 'heading' ? 'section' : item.kind,
      x: item.x,
      y: item.y,
      size: item.size,
      weight: item.weight,
      align: 'left',
      muted: item.muted,
      text: item.text,
    });
  }
  const rules: A4Rule[] = [
    { x1: MARGIN, y1: MARGIN + 26, x2: PAGE_W - MARGIN, y2: MARGIN + 26 },
  ];
  if (items.some((item) => item.x >= RIGHT_X)) {
    rules.push({ x1: RIGHT_X - COL_GAP / 2, y1: CONTENT_TOP - 2, x2: RIGHT_X - COL_GAP / 2, y2: CONTENT_BOTTOM - 4, dashed: true });
  }
  return { index, total, runs, rules };
}

export interface CompactSheetOptions {
  revision?: string;
  generatedAt?: string;
  /** 强制字号（导出时「先排、再看页数」的自动择优用）。 */
  size?: number;
  /** 最多几页；缺省：带译文的外语歌 2 页，其余 1 页。 */
  maxPages?: number;
}

export function buildCompactSheet(
  item: TalentItem,
  sections: readonly VocalSection[] = [],
  options: CompactSheetOptions = {},
): A4Sheet {
  const blocks = compactBlocks(item, sections);
  /* 带中文译文的外语歌行数翻倍：允许 2 页，否则字号会被压到 7pt 看不清。 */
  const bilingual = blocks.some((block) => block.lines.some((line) => Boolean(line.translation)));
  const maxPages = bilingual ? (options.maxPages ?? 2) : 1;
  const pick = (limit: number): { size: number; layout: PagedLayout } | null => {
    for (const candidate of SIZE_LADDER) {
      const attempt = layoutPages(blocks, candidate, limit);
      if (attempt.complete && attempt.pages.every((page) => page.bottom <= CONTENT_BOTTOM)) return { size: candidate, layout: attempt };
    }
    return null;
  };
  let size = options.size ?? MIN_SIZE;
  // 显式字号也要遵守「低于 10pt 就允许两页」，否则导出端按字号逐档试时会得到半页内容。
  const pageLimitFor = (candidate: number): number => (bilingual || candidate < MIN_SINGLE_PAGE_SIZE)
    ? (options.maxPages ?? 2)
    : 1;
  let layout = layoutPages(blocks, size, pageLimitFor(size));
  if (!options.size) {
    const single = pick(maxPages);
    if (single) { size = single.size; layout = single.layout; }
    // 大字优先：一页要压到 10pt 以下才装得下，就改出两页，别让人贴着纸看。
    if (!bilingual && size < MIN_SINGLE_PAGE_SIZE) {
      const two = pick(2);
      if (two && two.size > size) { size = two.size; layout = two.layout; }
    }
  }

  const title = String(item.title ?? '').trim() || '未命名';
  const artist = String(item.artist ?? '').trim();
  const headerTitle = artist ? `《${title}》 · ${artist}` : `《${title}》`;
  const revision = options.revision ? `修订 ${options.revision}` : '';
  const totalPages = Math.max(1, layout.pages.length);
  const meta = [
    revision,
    `字号 ${size}pt`,
    layout.repeatCount ? `右栏 ${layout.repeatCount} 段重复` : '无重复段',
    '无时间轴 · 无序号',
  ].filter(Boolean).join(' · ');
  const pages = layout.pages.map((page) => buildPage(page.items, { title: headerTitle, meta }, page.index, totalPages));
  const lineCount = blocks.reduce((sum, block) => sum + block.lines.length, 0);

  return {
    meta: {
      songId: item.id,
      title,
      artist,
      versionLabel: '紧凑一页',
      revisionLabel: options.revision ? `结构 ${options.revision}` : '结构 未标注',
      sourceLabel: sections.length ? '机器参考' : '无分段（仅歌词）',
      structureSource: sections.length ? 'machine' : 'none',
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      pageCount: totalPages,
      lineCount,
      sectionCount: sections.length,
      noSections: !sections.length,
      layout: {
        pageWidthPt: PAGE_W,
        pageHeightPt: PAGE_H,
        marginPt: MARGIN,
        contentWidthPt: CONTENT_W,
        noteGutterPt: RIGHT_W,
        fontSizePt: size,
        lineHeightPt: Math.round(size * 1.34 * 10) / 10,
        previewScale: 0.72,
      },
    },
    pages,
  };
}
