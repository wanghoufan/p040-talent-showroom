import type { TimedLyric, VocalSection, VocalSectionType } from '../types';

/**
 * 参考结构草稿的界面侧纯函数（P040 V3.3）。
 *
 * 参考标签只是候选：这里不判断类型对错，也不自动建立重复关系；
 * 只负责「边界怎么挪」和「草稿段怎么转成可编辑段」。
 */

export interface ReferenceAnchor {
  lineId: string | null;
  deltaMs: number;
  snapped: boolean;
}

/** 草稿段比正式段多带溯源字段；保存时会被剥掉，只留 manual 段。 */
export interface StudioSection extends VocalSection {
  referenceLabel?: string;
  disputed?: boolean;
  alternates?: string[];
  repeatCandidateOf?: string | null;
  endUnverified?: boolean;
  anchor?: ReferenceAnchor;
  /** 来自参考草稿（`source` 只能是 manual/algorithm，故另存标记）。 */
  fromReference?: boolean;
}

export interface ReferenceCandidateView {
  code: string;
  type: VocalSectionType;
  typeLabel: string;
  startMs: number;
  endMs: number;
  referenceLabel: string;
  anchor: ReferenceAnchor;
  disputed: boolean;
  alternates: string[];
  repeatCandidateOf: string | null;
  endUnverified?: boolean;
}

export interface ReferenceView {
  songTitle: string; artist: string; version: string;
  source: string; note: string; status: string;
  audioSha256: string; audioDurationMs: number;
  identity: { ok: boolean; checks: { id: string; ok: boolean; expected: string; actual: string }[]; blockers: { code: string; detail: string }[] };
  candidateCount: number; disputedCount: number; unsnappedCount: number;
  loadedAt: string; warnings: string[];
  sections: ReferenceCandidateView[];
}

export const IDENTITY_TEXT: Record<string, string> = {
  title: '歌名', artist: '歌手', version: '版本', duration: '时长', audioSha256: '原音频摘要',
};

const MIN_SECTION_MS = 500;

export function sortByStart<T extends { startMs: number; endMs: number }>(sections: readonly T[]): T[] {
  return [...sections].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/** 所有可拖动的分界点：每段的起点（0 除外）。 */
export function boundaryTimes(sections: readonly StudioSection[]): number[] {
  return sortByStart(sections).map((section) => section.startMs).filter((time) => time > 0);
}

/**
 * 把一个分界点挪到新位置：左右两段同时改，用户只需要动一次。
 * 夹在两侧留白之内，避免把段落挤成 0 秒。
 */
export function moveBoundary(
  sections: readonly StudioSection[],
  boundaryMs: number,
  atMs: number,
  durationMs = 0,
): StudioSection[] {
  const ordered = sortByStart(sections);
  const index = ordered.findIndex((section) => section.startMs === boundaryMs);
  if (index <= 0) throw new Error('BOUNDARY_NOT_FOUND');
  const left = ordered[index - 1];
  const right = ordered[index];
  const upper = durationMs > 0 ? Math.min(right.endMs, durationMs) : right.endMs;
  const next = Math.min(Math.max(Math.round(atMs), left.startMs + MIN_SECTION_MS), upper - MIN_SECTION_MS);
  if (!Number.isFinite(next) || next === boundaryMs) return ordered.map((section) => ({ ...section }));
  return ordered.map((section) => {
    if (section.id === left.id) return { ...section, endMs: next, source: 'manual' as const };
    if (section.id === right.id) return { ...section, startMs: next, source: 'manual' as const };
    return { ...section };
  });
}

/** 按段 id + 端点微调（键盘/按钮用，不依赖指针坐标）。 */
export function nudgeEdge(
  sections: readonly StudioSection[],
  id: string,
  edge: 'start' | 'end',
  deltaMs: number,
  durationMs = 0,
): StudioSection[] {
  const target = sections.find((section) => section.id === id);
  if (!target) throw new Error('SECTION_NOT_FOUND');
  return moveBoundary(sections, edge === 'start' ? target.startMs : target.endMs, (edge === 'start' ? target.startMs : target.endMs) + deltaMs, durationMs);
}

/**
 * 「歌词行定界」：把一个分界点吸附到最近的歌词行首。
 * 只吸附，不判断乐句对错；超出容差就原样返回，让用户自己听。
 */
export function snapBoundaryToLyrics(
  sections: readonly StudioSection[],
  boundaryMs: number,
  lyrics: readonly TimedLyric[],
  windowMs = 1500,
  durationMs = 0,
): StudioSection[] {
  let best: { startMs: number; deltaMs: number } | null = null;
  for (const line of lyrics ?? []) {
    if (!Number.isFinite(line?.startMs)) continue;
    const deltaMs = line.startMs - boundaryMs;
    if (Math.abs(deltaMs) > windowMs) continue;
    if (!best || Math.abs(deltaMs) < Math.abs(best.deltaMs)) best = { startMs: line.startMs, deltaMs };
  }
  const ordered = sortByStart(sections);
  if (!best || best.startMs === boundaryMs) return ordered.map((section) => ({ ...section }));
  return moveBoundary(ordered, boundaryMs, best.startMs, durationMs);
}

/** 草稿段 → 可保存的正式段：只留服务端白名单字段，来源一律 manual。 */
export function toSavableSections(sections: readonly StudioSection[]): VocalSection[] {
  return sortByStart(sections).map((section) => ({
    id: section.id,
    type: section.type,
    label: section.label,
    startMs: section.startMs,
    endMs: section.endMs,
    source: 'manual' as const,
    ...(section.repeatOf ? { repeatOf: section.repeatOf } : {}),
    ...(section.repetition ? { repetition: section.repetition } : {}),
    ...(section.type === 'rap' ? { rapApproved: section.rapApproved === true } : {}),
  }));
}

/** 草稿里的段落是否来自参考（用于显示「参考草稿」而不是「分析草稿」）。 */
export function isReferenceSection(section: Pick<StudioSection, 'fromReference' | 'disputed'> | null | undefined): boolean {
  return Boolean(section && (section.fromReference === true || section.disputed === true));
}

export function referenceHeadline(reference: ReferenceView | null | undefined): string {
  if (!reference) return '';
  return `${reference.artist}《${reference.songTitle}》· 参考候选 ${reference.candidateCount} 段`
    + (reference.disputedCount ? ` · ${reference.disputedCount} 段类型有争议` : '')
    + (reference.unsnappedCount ? ` · ${reference.unsnappedCount} 段未锚上歌词` : '');
}

/**
 * 「这份参考草稿是否已被用户保存过」。
 * 保存过就默认显示正式结构，避免每次打开工作室又把参考候选摆出来、诱导重复保存。
 * 只记时间戳，不记内容；存储不可用时按「未保存」处理（宁多提示一次，不误判已保存）。
 */
const SAVED_PREFIX = 'dance.vocal-structure.reference-saved.';

export function markReferenceSaved(songId: string, at: string = new Date().toISOString()): void {
  try { localStorage.setItem(`${SAVED_PREFIX}${songId}`, at); } catch { /* 存储不可用只影响默认视图 */ }
}

export function referencePending(songId: string, loadedAt?: string | null): boolean {
  if (!loadedAt) return true;
  try {
    const saved = localStorage.getItem(`${SAVED_PREFIX}${songId}`);
    return !saved || saved < loadedAt;
  } catch { return true; }
}

/**
 * 参考目录读取失败时的界面文案（P040 V1.2）。
 *
 * 401/403、旧服务没有该接口（404）、连不上服务都不能读成「本机没有参考」——
 * 那会让用户以为参考真的不存在，从而去手工重新打点。这里按失败原因逐类说明，
 * 只描述「查不到」，绝不冒充「查过了，没有」。
 */
export function referenceCatalogFailureMessage(error: unknown): string {
  const status = typeof (error as { status?: unknown } | null)?.status === 'number'
    ? (error as { status: number }).status
    : -1;
  const detail = error instanceof Error && error.message ? error.message : '';
  if (status === 401 || status === 403) {
    return `参考目录需要授权（服务返回 ${status}），暂时查不到本机有没有参考；这不等于没有参考，请先在「我的」完成登录/授权后重试。`;
  }
  if (status === 404) {
    return '当前本地服务版本没有参考目录接口（返回 404），暂时查不到本机有没有参考；这不等于没有参考，请升级本地服务后重试。';
  }
  if (status === 0) {
    return '连不上本地服务，暂时查不到本机有没有参考；这不等于没有参考，请检查服务地址与网络后重试。';
  }
  if (status >= 500) {
    return `参考目录读取失败（服务返回 ${status}${detail ? `：${detail}` : ''}），暂时查不到本机有没有参考；这不等于没有参考。`;
  }
  return `参考目录读取失败${detail ? `：${detail}` : ''}，暂时查不到本机有没有参考；这不等于没有参考。`;
}
