import type { TimedLyric, VocalRepetition, VocalSection, VocalSectionType, VocalTimeRange } from '../types';

/**
 * 歌曲地图的前端纯函数（P040 V3.2 T5/T6）。
 *
 * 与 `server/vocal-structure/structure-map.mjs` 同一套规则，但只做界面需要的编辑：
 * 分段/合并/改类型/确认重复都由用户触发，一切结果 `source='manual'`；
 * 这里不读音频、不猜类型、不自动建立重复关系。
 */

const FAMILY: Partial<Record<VocalSectionType, string>> = {
  verse: 'A', chorus: 'B', pre: 'P', bridge: 'C', rap: 'R',
};

export const TYPE_TEXT: Record<VocalSectionType, string> = {
  intro: '前奏', verse: '主歌', pre: '预副歌', chorus: '副歌', bridge: '桥段', rap: 'Rap', outro: '尾奏', unknown: '待标注',
};

export const TYPE_ORDER: VocalSectionType[] = ['intro', 'verse', 'pre', 'chorus', 'bridge', 'rap', 'outro', 'unknown'];

const MIN_SECTION_MS = 500;

/** 去掉重复关系字段（返回新对象，不改原段）。 */
function withoutRelation(section: VocalSection): VocalSection {
  const next: VocalSection = { ...section };
  delete next.repeatOf;
  delete next.repetition;
  return next;
}

/**
 * Rap 是否经「逐段显式确认」。
 * - `rapApproved` 为布尔值：以它为准（新数据必须显式 true 才可跳过）；
 * - 字段缺失：只对旧版人工结构（source='manual'）保留原行为，不破坏旧数据；
 *   旧算法段（source='algorithm'）一律视为未确认。
 */
export function isRapConfirmed(section: Pick<VocalSection, 'type' | 'source' | 'rapApproved'>): boolean {
  if (section.type !== 'rap') return false;
  if (section.rapApproved === true) return true;
  if (section.rapApproved === false) return false;
  return section.source === 'manual';
}

/** 显式确认 Rap 区间；只对 rap 段生效。 */
export function approveRapSection(sections: readonly VocalSection[], id: string): VocalSection[] {
  return finish(sections.map((section) => {
    if (section.id !== id) return section;
    if (section.type !== 'rap') throw new Error('NOT_RAP');
    return { ...section, rapApproved: true, source: 'manual' as const };
  }));
}

/** 取消 Rap 确认；取消后绝不参与自动跳过。 */
export function revokeRapSection(sections: readonly VocalSection[], id: string): VocalSection[] {
  return finish(sections.map((section) => (section.id === id ? { ...section, rapApproved: false } : section)));
}

/** 几何或类型一变，原确认区间就不再生效，必须重新确认。 */
function resetRapApproval(section: VocalSection): VocalSection {
  const next: VocalSection = { ...section };
  if (next.type === 'rap') next.rapApproved = false;
  else delete next.rapApproved;
  return next;
}

export function sortByTime(sections: readonly VocalSection[]): VocalSection[] {
  return [...sections].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
}

/**
 * 结构指纹：只比对「段落事实」（id/类型/边界/重复关系/来源/Rap 确认），
 * 不含 label——编号会随排序重算，不能因此把同一份结构当成变过。
 */
export function sectionsSignature(sections: readonly VocalSection[]): string {
  return JSON.stringify(sortByTime(sections).map((section) => [
    section.id,
    section.type,
    section.startMs,
    section.endMs,
    section.repeatOf ?? null,
    section.repetition ?? null,
    section.source ?? null,
    section.rapApproved ?? null,
  ]));
}

/**
 * 段落标题文字：编号与类型相同就只留一份。
 * 旧数据的 label 常被写成类型名（“主歌”“前奏”），直接拼「编号 + 类型」会变成「主歌 主歌」；
 * 这里只影响显示，不改 section.label，也不写回持久化结构。
 */
export function sectionHeading(section: Pick<VocalSection, 'label' | 'type'>, separator = ' '): string {
  const type = TYPE_TEXT[section.type];
  return section.label === type ? type : `${section.label}${separator}${type}`;
}

/** 重新编号：同类按出现顺序 A1/A2…；前奏/尾奏用文字；未标注按顺序 U1… */
export function relabelSections(sections: readonly VocalSection[]): VocalSection[] {
  const counts = new Map<string, number>();
  let unknown = 0;
  return sortByTime(sections).map((section) => {
    const family = FAMILY[section.type];
    let label: string;
    if (family) {
      const next = (counts.get(family) ?? 0) + 1;
      counts.set(family, next);
      label = `${family}${next}`;
    } else if (section.type === 'intro' || section.type === 'outro') {
      label = TYPE_TEXT[section.type];
    } else {
      label = `U${++unknown}`;
    }
    return { ...section, label };
  });
}

/** 关系目标必须还存在、更早、类型一致；坏关系直接丢弃，不让图断裂。 */
function pruneRelations(sections: readonly VocalSection[]): VocalSection[] {
  const byId = new Map(sections.map((section) => [section.id, section]));
  return sections.map((section) => {
    if (!section.repeatOf) return section;
    const target = byId.get(section.repeatOf);
    if (!target || target.startMs >= section.startMs || target.type !== section.type) {
      return withoutRelation(section);
    }
    return section;
  });
}

function finish(sections: VocalSection[]): VocalSection[] {
  return relabelSections(pruneRelations(sections));
}

/** 在给定时间拆分；两侧都必须 ≥ 500ms。 */
export function splitSectionAt(sections: readonly VocalSection[], id: string, atMs: number): VocalSection[] {
  const target = sections.find((section) => section.id === id);
  if (!target) throw new Error('SECTION_NOT_FOUND');
  const cut = Math.round(atMs);
  if (!Number.isFinite(cut)) throw new Error('INVALID_SPLIT_TIME');
  if (cut - target.startMs < MIN_SECTION_MS || target.endMs - cut < MIN_SECTION_MS) throw new Error('SPLIT_TOO_CLOSE_TO_EDGE');
  const first = resetRapApproval({ ...target, endMs: cut, source: 'manual' });
  const second = resetRapApproval({
    ...target, id: `manual-${target.id.slice(0, 24)}-${cut}`, startMs: cut, source: 'manual',
    repeatOf: undefined, repetition: undefined,
  });
  return finish([...sections.filter((section) => section.id !== id), first, second]);
}

/** 与上一段合并（同类型直接合；类型不同必须显式给类型）。 */
export function mergeWithPrevious(sections: readonly VocalSection[], id: string, chosenType?: VocalSectionType): VocalSection[] {
  const ordered = sortByTime(sections);
  const index = ordered.findIndex((section) => section.id === id);
  if (index < 0) throw new Error('SECTION_NOT_FOUND');
  if (index === 0) throw new Error('NO_PREVIOUS_SECTION');
  const left = ordered[index - 1];
  const right = ordered[index];
  if (left.endMs !== right.startMs) throw new Error('NON_CONTIGUOUS_SECTIONS');
  const type = chosenType ?? left.type;
  if (left.type !== right.type && !chosenType) throw new Error('MIXED_TYPES_REQUIRES_CHOICE');
  const merged = resetRapApproval({ ...left, type, endMs: right.endMs, source: 'manual', repeatOf: undefined, repetition: undefined });
  const rest = ordered.filter((section) => section.id !== left.id && section.id !== right.id);
  const rebound = [...rest, merged].map((section) => {
    if (section.repeatOf === right.id) return { ...section, repeatOf: left.id, source: 'manual' as const };
    return section;
  });
  return finish(rebound);
}

/** 改类型：清掉该段的关系，并清掉指向它的不兼容关系；Rap 确认状态一律重置。 */
export function setSectionType(sections: readonly VocalSection[], id: string, type: VocalSectionType): VocalSection[] {
  const next = sections.map((section) => {
    if (section.id === id) {
      return resetRapApproval({ ...withoutRelation(section), type, source: 'manual' as const });
    }
    if (section.repeatOf === id && section.type !== type) {
      return { ...withoutRelation(section), source: 'manual' as const };
    }
    return section;
  });
  return finish(next);
}

/** 最近一个更早的同类型段：重复关系只能指向它，避免用户选到随机段。 */
export function previousSameType<T extends Pick<VocalSection, 'id' | 'type' | 'startMs'>>(sections: readonly T[], id: string): T | null {
  const sorted = [...sections].sort((a, b) => a.startMs - b.startMs);
  const index = sorted.findIndex((section) => section.id === id);
  if (index <= 0) return null;
  const current = sorted[index];
  for (let at = index - 1; at >= 0; at -= 1) {
    if (sorted[at].type === current.type) return sorted[at];
  }
  return null;
}

function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function linesOf(section: VocalSection, lyrics: readonly TimedLyric[]): string[] {
  return lyrics.filter((line) => line.startMs >= section.startMs && line.startMs < section.endMs).map((line) => normalizeText(line.text)).filter(Boolean);
}

/** 两段歌词文字是否完全一致（韩文换空格/标点仍算一致，韩文与中文译文不算）。 */
export function lyricsIdentical(a: VocalSection, b: VocalSection, lyrics: readonly TimedLyric[]): boolean {
  const left = linesOf(a, lyrics);
  return left.length > 0 && left.join('|') === linesOf(b, lyrics).join('|');
}

/** 人工确认重复关系；「同词」必须先核对歌词文字。传 null 表示解除重复。 */
export function confirmRepeat(
  sections: readonly VocalSection[],
  id: string,
  targetId: string,
  relation: VocalRepetition,
  lyrics: readonly TimedLyric[],
): VocalSection[] {
  const current = sections.find((section) => section.id === id);
  const target = sections.find((section) => section.id === targetId);
  if (!current || !target) throw new Error('SECTION_NOT_FOUND');
  if (target.startMs >= current.startMs) throw new Error('TARGET_MUST_BE_EARLIER');
  if (target.type !== current.type) throw new Error('TYPE_MISMATCH');
  if (relation === 'exact-lyrics' && !lyricsIdentical(current, target, lyrics)) throw new Error('LYRICS_NOT_IDENTICAL');
  return finish(sections.map((section) => (section.id === id
    ? { ...section, repeatOf: targetId, repetition: relation, source: 'manual' as const }
    : section)));
}

export function clearRepeat(sections: readonly VocalSection[], id: string): VocalSection[] {
  return finish(sections.map((section) => {
    if (section.id !== id) return section;
    return { ...withoutRelation(section), source: 'manual' as const };
  }));
}

/**
 * Rap 跳过只认「逐段显式确认」的区间。
 * 草稿应用后所有段都是 source='manual'，这不能等同于 Rap 已确认；
 * 新数据必须 `rapApproved === true`，未确认（含 false / 旧算法段）绝不跳过。
 */
export function confirmedRapRanges(sections: readonly VocalSection[], durationMs?: number): VocalTimeRange[] {
  const limit = Number.isFinite(durationMs) && (durationMs ?? 0) > 0 ? durationMs as number : undefined;
  return sortByTime(sections)
    .filter(isRapConfirmed)
    .map((section) => ({ startMs: section.startMs, endMs: Math.min(section.endMs, limit ?? section.endMs) }))
    .filter((range) => range.endMs - range.startMs >= MIN_SECTION_MS);
}

/** 段内是否有 Rap 等到确认：用于界面提示「Rap 未确认，不自动跳过」。 */
export function unconfirmedRapCount(sections: readonly VocalSection[]): number {
  return sections.filter((section) => section.type === 'rap' && !isRapConfirmed(section)).length;
}

export function sectionProgress(sections: readonly VocalSection[], id: string): { index: number; total: number } {
  const ordered = sortByTime(sections);
  const index = ordered.findIndex((section) => section.id === id);
  return { index: index < 0 ? 0 : index + 1, total: ordered.length };
}
