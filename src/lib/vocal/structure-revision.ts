import type { VocalSection } from '../types';

/**
 * 结构修订号与本地快照（P040 §7）。
 *
 * 纸质学习稿上印的修订号必须能由当前结构重算出来：纸上写的号与现在的号不一致，
 * 就说明打印之后结构被人改过，回传必须进冲突审查，不能静默覆盖。
 *
 * 快照只写 localStorage，不碰曲目本身：撤销是「再写一次结构」，不是删除用户数据。
 */

export const SNAPSHOT_KEY = 'dance.vocal-structure-snapshots.v1';
/** 每首歌最多留 10 份；超出只裁掉最旧的快照，正式结构始终在曲目里。 */
export const MAX_SNAPSHOTS = 10;

export type SnapshotSource = 'paper' | 'manual' | 'restore';

export interface StructureSnapshot {
  /** 生成这份快照时结构的修订号。 */
  revision: string;
  sections: VocalSection[];
  /** ISO 时间。 */
  at: string;
  source: SnapshotSource;
}

type SnapshotBook = Record<string, StructureSnapshot[]>;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 32 位 FNV-1a → 36 进制，补足 8 位。 */
export function shortRevision(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(36).padStart(8, '0');
}

/**
 * 段落在指纹里的样子：不含 id，重复关系换成目标的起始时间，
 * 这样重新导入同一份结构（id 可能被重建）仍然得到同一个修订号。
 */
function sectionFacts(section: VocalSection, startOf: (id: string) => number | null): string {
  return [
    section.type,
    section.label,
    section.startMs,
    section.endMs,
    section.repeatOf ? startOf(section.repeatOf) ?? 'missing' : '',
    section.repetition ?? '',
    section.source,
    section.rapApproved === undefined ? '' : String(section.rapApproved),
  ].join('\u001f');
}

/**
 * 结构修订号（8 位）：按内容排序后取短哈希。
 * 只看「段落事实」和纸上印的 label，不依赖 id，也不依赖数组顺序。
 */
export function sectionRevision(sections: readonly VocalSection[]): string {
  const byId = new Map(sections.map((section) => [section.id, section.startMs]));
  const startOf = (id: string): number | null => (byId.has(id) ? byId.get(id) as number : null);
  const rows = sections.map((section) => sectionFacts(section, startOf)).sort();
  return shortRevision(rows.join('\n'));
}

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function readBook(): SnapshotBook {
  const store = storage();
  if (!store) return {};
  try {
    const raw = store.getItem(SNAPSHOT_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as SnapshotBook;
  } catch {
    return {};
  }
}

function writeBook(book: SnapshotBook): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(SNAPSHOT_KEY, JSON.stringify(book));
  } catch {
    // 存储满或隐私模式：快照写不进去也不该阻断用户确认结构变更。
  }
}

function isSnapshot(value: unknown): value is StructureSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StructureSnapshot>;
  return typeof candidate.revision === 'string'
    && typeof candidate.at === 'string'
    && Array.isArray(candidate.sections);
}

/** 从新到旧。损坏的条目直接跳过，不影响其它快照。 */
export function readSnapshots(itemId: string): StructureSnapshot[] {
  if (!itemId) return [];
  const list = readBook()[itemId];
  if (!Array.isArray(list)) return [];
  return list.filter(isSnapshot).map((snapshot) => ({
    revision: snapshot.revision,
    sections: snapshot.sections.map((section) => ({ ...section })),
    at: snapshot.at,
    source: snapshot.source,
  }));
}

/**
 * 记一份快照再返回该曲的最新列表。
 * 同一修订号不重复堆叠；只裁本曲的快照，不动曲目自身的 sections。
 */
export function pushSnapshot(
  itemId: string,
  input: { revision: string; sections: readonly VocalSection[]; at: string; source: SnapshotSource },
): StructureSnapshot[] {
  if (!itemId) return [];
  const book = readBook();
  const previous = (Array.isArray(book[itemId]) ? book[itemId] : []).filter(isSnapshot);
  const entry: StructureSnapshot = {
    revision: input.revision,
    sections: input.sections.map((section) => ({ ...section })),
    at: input.at,
    source: input.source,
  };
  const next = [entry, ...previous.filter((snapshot) => snapshot.revision !== entry.revision)].slice(0, MAX_SNAPSHOTS);
  book[itemId] = next;
  writeBook(book);
  return readSnapshots(itemId);
}

/**
 * 取回某份快照，只返回数据，不写任何地方。
 * 调用方拿到 sections 后自己走一次正式保存，撤销才同样留下痕迹。
 */
export function restoreSnapshot(itemId: string, revision: string): StructureSnapshot | null {
  const found = readSnapshots(itemId).find((snapshot) => snapshot.revision === revision);
  return found ?? null;
}
