import type { TalentItem, VocalRepetition, VocalSection, VocalSectionType } from '../types';
import {
  TYPE_ORDER, TYPE_TEXT, confirmRepeat, relabelSections, setSectionType, sortByTime,
} from './structure';
import { sectionRevision, shortRevision } from './structure-revision';

/**
 * 纸质人工标注 → 结构化修订建议（P040 §7）。
 *
 * 输入永远是「用户手写在 A4 上的改动」导出成的 JSON，不是模型猜出来的：
 * - 只描述改了什么（段落界线、类型、重复关系、Rap），不重写歌词；
 * - 没有可信时标就保持待确认，绝不按纸面比例编造秒数；
 * - 应用前必须核对 songId / 时长 / 修订号，任何一项对不上就整体拒绝。
 */

export type PaperEditKind = 'boundary' | 'type' | 'repeat' | 'rap';

export interface PaperBoundaryEdit {
  kind: 'boundary';
  /** 纸上印的段落编号，例如 A1 / 副歌 / 尾奏。 */
  sectionLabel: string;
  /** 该段的起始分界（毫秒）。与 lineIndex 二选一。 */
  startMs?: number;
  /** 该段的结束分界（毫秒）。 */
  endMs?: number;
  /** 1 起的歌词行号；按该行真实 LRC 时间对齐。 */
  lineIndex?: number;
}

export interface PaperTypeEdit {
  kind: 'type';
  sectionLabel: string;
  type: VocalSectionType;
}

export interface PaperRepeatEdit {
  kind: 'repeat';
  sectionLabel: string;
  repeatOfLabel: string;
  relation: VocalRepetition;
}

export interface PaperRapEdit {
  kind: 'rap';
  sectionLabel: string;
  /** confirm = 确认可自动跳过；skip = 保留 Rap 但不自动跳过。 */
  action: 'confirm' | 'skip';
}

export type PaperEdit = PaperBoundaryEdit | PaperTypeEdit | PaperRepeatEdit | PaperRapEdit;

export interface PaperDraft {
  songId: string;
  title: string;
  durationMs: number;
  /** 打印时的结构修订号（sectionRevision 的结果）。 */
  revision: string;
  /** 可选短校验码，由 songId + revision 派生。 */
  code?: string;
  edits: PaperEdit[];
}

export interface PaperDiffRow {
  label: string;
  before: string;
  after: string;
  /** 0～1；JSON 明确给出的时标为 1，按 LRC 行对齐为 0.85，待确认为 0.4。 */
  confidence: number;
  note: string;
}

export interface PaperConflict {
  code: 'SONG_MISMATCH' | 'DURATION_DRIFT' | 'REVISION_STALE' | 'CODE_MISMATCH';
  message: string;
}

export interface PaperDiff {
  rows: PaperDiffRow[];
  conflicts: PaperConflict[];
  warnings: string[];
}

export interface PaperApplyResult {
  sections: VocalSection[];
  /** 只有行号且该行没有可用时标：保持原样，等人工再确认。 */
  pending: string[];
  /** 找不到目标或会破坏结构、因此没有应用的项。 */
  skipped: string[];
}

const RELATIONS: VocalRepetition[] = ['exact-lyrics', 'same-melody-new-lyrics', 'unverified'];
const MIN_SECTION_MS = 500;

export const RELATION_TEXT: Record<VocalRepetition, string> = {
  'exact-lyrics': '同词重复',
  'same-melody-new-lyrics': '同曲不同词',
  unverified: '待核对',
};

/** 纸上短校验码：4 位大写，用于人工核对「这张纸确实是这首歌这个版本」。 */
export function paperCheckCode(songId: string, revision: string): string {
  return shortRevision(`${songId}\u001f${revision}`).slice(0, 4).toUpperCase();
}

function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const tenths = Math.floor((total % 1000) / 100);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseEdit(raw: unknown, index: number): { ok: true; edit: PaperEdit } | { ok: false; error: string } {
  const at = `第 ${index + 1} 条修改`;
  if (!isRecord(raw)) return { ok: false, error: `${at}格式不对：应为对象。` };
  const kind = raw.kind;
  if (kind === 'boundary') {
    if (!nonEmptyString(raw.sectionLabel)) return { ok: false, error: `${at}缺少段落编号 sectionLabel。` };
    if (raw.startMs !== undefined && !finiteNumber(raw.startMs)) return { ok: false, error: `${at}的 startMs 必须是毫秒数字。` };
    if (raw.endMs !== undefined && !finiteNumber(raw.endMs)) return { ok: false, error: `${at}的 endMs 必须是毫秒数字。` };
    if (raw.lineIndex !== undefined && (!finiteNumber(raw.lineIndex) || raw.lineIndex < 1 || !Number.isInteger(raw.lineIndex))) {
      return { ok: false, error: `${at}的 lineIndex 必须是 1 起的整数行号。` };
    }
    if (raw.startMs === undefined && raw.endMs === undefined && raw.lineIndex === undefined) {
      return { ok: false, error: `${at}没有给出时间或歌词行号，无法定位分界。` };
    }
    return {
      ok: true,
      edit: {
        kind: 'boundary',
        sectionLabel: raw.sectionLabel,
        ...(raw.startMs !== undefined ? { startMs: raw.startMs } : {}),
        ...(raw.endMs !== undefined ? { endMs: raw.endMs } : {}),
        ...(raw.lineIndex !== undefined ? { lineIndex: raw.lineIndex } : {}),
      },
    };
  }
  if (kind === 'type') {
    if (!nonEmptyString(raw.sectionLabel)) return { ok: false, error: `${at}缺少段落编号 sectionLabel。` };
    if (typeof raw.type !== 'string' || !TYPE_ORDER.includes(raw.type as VocalSectionType)) {
      return { ok: false, error: `${at}的类型无效，可用值：${TYPE_ORDER.join(' / ')}。` };
    }
    return { ok: true, edit: { kind: 'type', sectionLabel: raw.sectionLabel, type: raw.type as VocalSectionType } };
  }
  if (kind === 'repeat') {
    if (!nonEmptyString(raw.sectionLabel)) return { ok: false, error: `${at}缺少段落编号 sectionLabel。` };
    if (!nonEmptyString(raw.repeatOfLabel)) return { ok: false, error: `${at}缺少重复目标 repeatOfLabel。` };
    if (typeof raw.relation !== 'string' || !RELATIONS.includes(raw.relation as VocalRepetition)) {
      return { ok: false, error: `${at}的重复关系无效，可用值：${RELATIONS.join(' / ')}。` };
    }
    return {
      ok: true,
      edit: {
        kind: 'repeat',
        sectionLabel: raw.sectionLabel,
        repeatOfLabel: raw.repeatOfLabel,
        relation: raw.relation as VocalRepetition,
      },
    };
  }
  if (kind === 'rap') {
    if (!nonEmptyString(raw.sectionLabel)) return { ok: false, error: `${at}缺少段落编号 sectionLabel。` };
    if (raw.action !== 'confirm' && raw.action !== 'skip') {
      return { ok: false, error: `${at}的 action 只能是 confirm 或 skip。` };
    }
    return { ok: true, edit: { kind: 'rap', sectionLabel: raw.sectionLabel, action: raw.action } };
  }
  return { ok: false, error: `${at}的 kind 无效，只能是 boundary / type / repeat / rap。` };
}

/** 解析修订 JSON；所有错误都是中文，直接可以给用户看。 */
export function parsePaperDraft(input: string | unknown): { ok: true; draft: PaperDraft } | { ok: false; error: string } {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (cause) {
      return { ok: false, error: `JSON 格式错误：${cause instanceof Error ? cause.message : '无法解析'}。` };
    }
  }
  if (!isRecord(raw)) return { ok: false, error: '修订文件格式不对：顶层应为对象。' };
  if (!nonEmptyString(raw.songId)) return { ok: false, error: '修订文件缺少歌曲 ID（songId），无法核对是哪一首。' };
  if (typeof raw.title !== 'string') return { ok: false, error: '修订文件缺少歌曲名（title）。' };
  if (!finiteNumber(raw.durationMs) || raw.durationMs < 0) {
    return { ok: false, error: '修订文件缺少有效时长（durationMs，毫秒数字）。' };
  }
  const revision = typeof raw.revision === 'string'
    ? raw.revision.trim()
    : finiteNumber(raw.revision) ? String(raw.revision) : '';
  if (!revision) return { ok: false, error: '修订文件缺少结构修订号（revision）。' };
  if (raw.code !== undefined && typeof raw.code !== 'string') return { ok: false, error: '校验码（code）应为字符串。' };
  if (!Array.isArray(raw.edits)) return { ok: false, error: '修订文件缺少修改列表（edits），应为数组。' };

  const edits: PaperEdit[] = [];
  for (let index = 0; index < raw.edits.length; index += 1) {
    const parsed = parseEdit(raw.edits[index], index);
    if (!parsed.ok) return parsed;
    edits.push(parsed.edit);
  }

  return {
    ok: true,
    draft: {
      songId: raw.songId,
      title: raw.title,
      durationMs: raw.durationMs,
      revision,
      ...(raw.code !== undefined ? { code: raw.code } : {}),
      edits,
    },
  };
}

/** 纸上 label → 段落 id。纸上印的是存储里的 label，兼容重新编号后的写法。 */
function labelIndex(sections: readonly VocalSection[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const section of relabelSections(sections)) {
    if (!index.has(section.label)) index.set(section.label, section.id);
  }
  for (const section of sections) {
    if (!index.has(section.label)) index.set(section.label, section.id);
  }
  return index;
}

function conflictText(code: PaperConflict['code']): string {
  if (code === 'SONG_MISMATCH') return '歌曲不符';
  if (code === 'DURATION_DRIFT') return '时长漂移';
  if (code === 'REVISION_STALE') return '结构已变化';
  return '校验码不符';
}

export function paperConflicts(item: TalentItem, draft: PaperDraft): PaperConflict[] {
  const conflicts: PaperConflict[] = [];
  if (draft.songId !== item.id) {
    conflicts.push({
      code: 'SONG_MISMATCH',
      message: `这份修订属于 ${draft.songId}《${draft.title}》，不是当前这首《${item.title}》（${item.id}）。已拒绝应用。`,
    });
  }
  const duration = Number(item.durationMs) || 0;
  if (duration > 0 && Math.abs(duration - draft.durationMs) > 1000) {
    conflicts.push({
      code: 'DURATION_DRIFT',
      message: `音频时长不一致：纸上是 ${formatMs(draft.durationMs)}，当前曲目是 ${formatMs(duration)}（相差超过 1 秒）。可能换过音频版本，已拒绝应用。`,
    });
  }
  const current = sectionRevision(item.sections ?? []);
  if (draft.revision !== current) {
    conflicts.push({
      code: 'REVISION_STALE',
      message: `结构修订号不一致：纸上是 ${draft.revision}，当前是 ${current}。打印之后结构已被修改，请重新打印或人工逐项核对，不能直接覆盖。`,
    });
  }
  if (draft.code && draft.code.trim().toUpperCase() !== paperCheckCode(draft.songId, draft.revision)) {
    conflicts.push({
      code: 'CODE_MISMATCH',
      message: `校验码对不上：纸上是 ${draft.code}，按歌曲 ID 与修订号应为 ${paperCheckCode(draft.songId, draft.revision)}。`,
    });
  }
  return conflicts;
}

function lyricTimeAt(item: TalentItem, lineIndex: number): number | null {
  const line = (item.lyrics ?? [])[lineIndex - 1];
  if (!line || !Number.isFinite(line.startMs) || line.startMs <= 0) return null;
  return Math.round(line.startMs);
}

function resolveStart(item: TalentItem, edit: PaperBoundaryEdit): { ms: number; via: 'explicit' | 'lyric' } | { pending: string } {
  if (edit.startMs !== undefined) return { ms: Math.round(edit.startMs), via: 'explicit' };
  if (edit.lineIndex !== undefined) {
    const ms = lyricTimeAt(item, edit.lineIndex);
    if (ms !== null) return { ms, via: 'lyric' };
    return { pending: `第 ${edit.lineIndex} 行没有可用的 LRC 时间` };
  }
  return { pending: '没有起始时间或行号' };
}

function boundaryRow(
  sections: readonly VocalSection[],
  id: string,
  edge: 'start' | 'end',
  nextMs: number,
  confidence: number,
  note: string,
): PaperDiffRow {
  const section = sections.find((entry) => entry.id === id) as VocalSection;
  const before = edge === 'start' ? section.startMs : section.endMs;
  return {
    label: `${section.label} ${edge === 'start' ? '起点' : '终点'}`,
    before: formatMs(before),
    after: formatMs(nextMs),
    confidence,
    note,
  };
}

/** 逐项差异：不改任何数据，只描述「纸上要求的」与「现在结构里的」。 */
export function diffPaperDraft(item: TalentItem, draft: PaperDraft): PaperDiff {
  const conflicts = paperConflicts(item, draft);
  if (conflicts.length) return { rows: [], conflicts, warnings: [] };

  const sections = item.sections ?? [];
  const index = labelIndex(sections);
  const warnings: string[] = [];
  const rows: PaperDiffRow[] = [];

  if (item.durationMs <= 0) warnings.push('当前曲目没有记录时长，已跳过时长核对。');
  if (!draft.code) warnings.push('纸上没有填校验码，只核对了歌曲 ID 与结构修订号。');
  if (draft.title.trim() && draft.title.trim() !== item.title.trim()) {
    warnings.push(`纸上歌名「${draft.title}」与当前「${item.title}」不同，请确认没有拿错稿。`);
  }
  if (!draft.edits.length) warnings.push('修订文件里没有任何修改项。');

  // 同一份稿里先改类型再确认重复/跳过是正常写法：按改后的类型判断，别给假警告。
  const projectedType = new Map<string, VocalSectionType>();
  for (const edit of draft.edits) {
    if (edit.kind !== 'type') continue;
    const id = index.get(edit.sectionLabel);
    if (id) projectedType.set(id, edit.type);
  }

  for (const edit of draft.edits) {
    const id = index.get(edit.sectionLabel);
    if (!id) {
      rows.push({
        label: edit.sectionLabel,
        before: '—',
        after: '（未应用）',
        confidence: 0,
        note: '当前结构里找不到这个段落编号，未应用。',
      });
      continue;
    }
    const section = sections.find((entry) => entry.id === id) as VocalSection;

    if (edit.kind === 'boundary') {
      if (edit.startMs !== undefined || edit.lineIndex !== undefined) {
        const resolved = resolveStart(item, edit);
        if ('pending' in resolved) {
          rows.push({
            label: `${section.label} 起点`,
            before: formatMs(section.startMs),
            after: '待确认',
            confidence: 0.4,
            note: `${resolved.pending}，不会按纸面比例猜秒数；保存后仍为待确认。`,
          });
        } else {
          rows.push(boundaryRow(
            sections, id, 'start', resolved.ms, resolved.via === 'explicit' ? 1 : 0.85,
            resolved.via === 'explicit'
              ? '纸面直接写了毫秒，按原值对齐。'
              : `按第 ${edit.lineIndex} 行的真实 LRC 时间对齐。`,
          ));
          if (resolved.ms <= section.startMs) {
            rows[rows.length - 1].note += ' 起点比原来更早，请确认没有把上一段吃掉。';
          }
        }
      }
      if (edit.endMs !== undefined) {
        rows.push(boundaryRow(sections, id, 'end', Math.round(edit.endMs), 1, '纸面直接写了毫秒，按原值对齐。'));
      }
      continue;
    }

    if (edit.kind === 'type') {
      const note = section.source === 'manual'
        ? '该段是人工结构；确认后会作为新的人工版本，机器推断不得覆盖它。'
        : '该段来自机器推断，确认后改为人工结构。';
      rows.push({
        label: section.label,
        before: TYPE_TEXT[section.type],
        after: TYPE_TEXT[edit.type],
        confidence: 1,
        note,
      });
      continue;
    }

    if (edit.kind === 'repeat') {
      const targetId = index.get(edit.repeatOfLabel);
      const target = targetId ? sections.find((entry) => entry.id === targetId) : undefined;
      const before = section.repeatOf
        ? `重复 ${sections.find((entry) => entry.id === section.repeatOf)?.label ?? section.repeatOf}`
        : '无重复';
      if (!target || !targetId) {
        rows.push({
          label: section.label,
          before,
          after: `重复 ${edit.repeatOfLabel}`,
          confidence: 0,
          note: `找不到被重复的段落 ${edit.repeatOfLabel}，未应用。`,
        });
        continue;
      }
      const problem = target.startMs >= section.startMs
        ? '目标段落不在它之前，重复关系只能在更早的同类段上建立。'
        : (projectedType.get(targetId) ?? target.type) !== (projectedType.get(id) ?? section.type)
          ? '两段类型不同，先改类型再确认重复。'
          : edit.relation === 'exact-lyrics' ? '' : '关系需要人工试听核对。';
      rows.push({
        label: section.label,
        before,
        after: `重复 ${target.label}（${RELATION_TEXT[edit.relation]}）`,
        confidence: problem ? 0.5 : 1,
        note: problem || `与 ${target.label} 建立重复关系。`,
      });
      continue;
    }

    if ((projectedType.get(id) ?? section.type) !== 'rap') {
      rows.push({
        label: section.label,
        before: TYPE_TEXT[projectedType.get(id) ?? section.type],
        after: edit.action === 'confirm' ? '确认 Rap' : '不跳过',
        confidence: 0.3,
        note: '该段当前不是 Rap，先改类型再确认是否跳过。',
      });
      continue;
    }
    rows.push({
      label: `${section.label} Rap`,
      before: section.rapApproved === true ? '已确认，可自动跳过' : '未确认，不自动跳过',
      after: edit.action === 'confirm' ? '已确认，可自动跳过' : '保留 Rap，不自动跳过',
      confidence: 1,
      note: edit.action === 'confirm' ? '逐段人工确认后才允许练唱自动跳过。' : '只记录为 Rap，不参与自动跳过。',
    });
  }

  return { rows, conflicts, warnings };
}

/** 与 structure.ts 的 finish 同口径：关系指向不存在/更晚/异类的目标时直接丢掉。 */
function pruneBrokenRepeats(sections: VocalSection[]): VocalSection[] {
  const byId = new Map(sections.map((section) => [section.id, section]));
  return sections.map((section) => {
    if (!section.repeatOf) return section;
    const target = byId.get(section.repeatOf);
    if (!target || target.startMs >= section.startMs || target.type !== section.type) {
      const next = { ...section };
      delete next.repeatOf;
      delete next.repetition;
      return next;
    }
    return section;
  });
}

function setBoundary(
  sections: VocalSection[],
  id: string,
  edge: 'start' | 'end',
  ms: number,
): { ok: true } | { ok: false; reason: string } {
  const ordered = sortByTime(sections);
  const index = ordered.findIndex((section) => section.id === id);
  const target = ordered[index];
  if (!target) return { ok: false, reason: '段落已不存在。' };
  if (edge === 'start') {
    if (target.endMs - ms < MIN_SECTION_MS) return { ok: false, reason: '起点离终点太近（不足 0.5 秒），未应用。' };
    const previous = index > 0 ? ordered[index - 1] : null;
    if (previous && previous.endMs === target.startMs) previous.endMs = ms;
    target.startMs = ms;
    return { ok: true };
  }
  if (ms - target.startMs < MIN_SECTION_MS) return { ok: false, reason: '终点离起点太近（不足 0.5 秒），未应用。' };
  const next = index + 1 < ordered.length ? ordered[index + 1] : null;
  if (next && next.startMs === target.endMs) next.startMs = ms;
  target.endMs = ms;
  return { ok: true };
}

/**
 * 把建议落成新的 sections 数组（不写库、不动歌词）。
 * 冲突时直接抛错：调用方必须先让用户看清差异。
 */
export function applyPaperDraft(item: TalentItem, draft: PaperDraft): PaperApplyResult {
  const conflicts = paperConflicts(item, draft);
  if (conflicts.length) throw new Error(conflicts.map((conflict) => `${conflictText(conflict.code)}：${conflict.message}`).join('\n'));

  const working = sortByTime(item.sections ?? []).map((section) => ({ ...section }));
  const index = labelIndex(working);
  const pending: string[] = [];
  const skipped: string[] = [];

  for (const edit of draft.edits) {
    const id = index.get(edit.sectionLabel);
    if (!id) {
      skipped.push(`${edit.sectionLabel}：当前结构里找不到这个段落编号。`);
      continue;
    }
    const current = (): VocalSection | undefined => working.find((section) => section.id === id);

    if (edit.kind === 'boundary') {
      const resolved = resolveStart(item, edit);
      if ('pending' in resolved) {
        pending.push(`${edit.sectionLabel} 起点：${resolved.pending}，保持待确认。`);
      } else {
        const result = setBoundary(working, id, 'start', resolved.ms);
        if (result.ok) {
          const section = current();
          if (section) section.source = 'manual';
        } else {
          skipped.push(`${edit.sectionLabel} 起点：${result.reason}`);
        }
      }
      if (edit.endMs !== undefined) {
        const result = setBoundary(working, id, 'end', Math.round(edit.endMs));
        if (result.ok) {
          const section = current();
          if (section) section.source = 'manual';
        } else {
          skipped.push(`${edit.sectionLabel} 终点：${result.reason}`);
        }
      }
      continue;
    }

    if (edit.kind === 'type') {
      const section = current();
      if (!section) continue;
      if (section.type === edit.type) continue;
      const next = setSectionType(working, id, edit.type);
      working.splice(0, working.length, ...next);
      continue;
    }

    if (edit.kind === 'repeat') {
      const targetId = index.get(edit.repeatOfLabel);
      const section = current();
      if (!targetId || !section) {
        skipped.push(`${edit.sectionLabel}：找不到被重复的段落 ${edit.repeatOfLabel}。`);
        continue;
      }
      try {
        const next = confirmRepeat(working, id, targetId, edit.relation, item.lyrics ?? []);
        working.splice(0, working.length, ...next);
      } catch (cause) {
        const code = cause instanceof Error ? cause.message : 'UNKNOWN';
        const reason = code === 'TARGET_MUST_BE_EARLIER'
          ? '目标段落不在它之前。'
          : code === 'TYPE_MISMATCH'
            ? '两段类型不同，先改类型再确认重复。'
            : code === 'LYRICS_NOT_IDENTICAL'
              ? '两段歌词并不完全一致，「同词重复」需要人工核对。'
              : '重复关系无法建立。';
        skipped.push(`${edit.sectionLabel}：${reason}`);
      }
      continue;
    }

    const section = current();
    if (!section) continue;
    if (section.type !== 'rap') {
      skipped.push(`${edit.sectionLabel}：该段不是 Rap，先改类型再确认是否跳过。`);
      continue;
    }
    section.rapApproved = edit.action === 'confirm';
    section.source = 'manual';
  }

  return {
    sections: relabelSections(pruneBrokenRepeats(working)),
    pending,
    skipped,
  };
}
