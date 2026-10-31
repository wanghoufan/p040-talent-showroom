import { api, apiWithTimeout, jsonBody } from '../api';
import type { TalentItem, VocalRepetition, VocalSection } from '../types';
import type { ReferenceView, StudioSection } from './reference';

/**
 * 结构草稿接口（V3.2 T4/T5）。
 *
 * 草稿只存在独立表里，只有用户点「应用」才会写回正式结构；
 * 分析在本机跑（Mac mini 的隔离 Python），手机只发请求与展示结果。
 */

export interface StructureDraftSection {
  id: string; type: VocalSection['type']; code: string; startMs: number; endMs: number;
  typeCandidate?: string; repeatOf?: string; repetition?: VocalRepetition;
  approvedRap?: boolean;
  /** 参考草稿溯源：只在草稿里，保存后不落库。 */
  source?: 'reference' | 'algorithm' | 'manual';
  referenceLabel?: string; disputed?: boolean; alternates?: string[];
  repeatCandidateOf?: string | null; endUnverified?: boolean;
  anchor?: { lineId: string | null; deltaMs: number; snapped: boolean };
  lines?: { id: string; startMs: number; text: string }[];
}

export interface StructureMap {
  schema: string; songId: string; durationMs: number; status: string;
  sections: StructureDraftSection[];
  relationCandidates: { from: string; to: string; score: number; method: string; status: string; note: string }[];
  mergeCandidates?: { leftId: string; rightId: string; score: number; status: string; note: string }[];
  warnings: string[];
}

export interface StructureDraft {
  songId: string; state: 'DRAFT' | 'NEEDS_REVIEW' | 'APPLIED' | 'DISCARDED';
  generatedAt: string; modelName: string; modelVersion: string;
  baseRevision: number | null; appliedRevision: number | null;
  legacySectionCount: number; currentSectionCount: number;
  summary: { sections: number; pendingTypes: number; typeCandidates: number; pendingRelations: number; pendingMerges: number; uncovered: number; needsReview: boolean };
  timing: { seconds: number; peakMemoryMb: number } | null;
  separation: { used: boolean; modulesSeen: string[] } | null;
  /** 参考结构草稿（身份核验 + 候选）；只有载入过参考才存在。 */
  reference?: ReferenceView | null;
  map: StructureMap;
}

export interface StructureWaveform {
  buckets: number; peaks: number[]; durationMs: number; sampleRate: number;
  source: string; separation: { used: boolean }; cached: boolean;
}

/**
 * 本机内置参考目录条目（P040 V1.2）。
 * `identity` 是服务端拿**当前**曲目元数据与现算文件摘要复核后的结果；
 * `identity.ok=false` 的条目只能看原因，不能载入。
 */
export interface ReferenceCatalogEntry {
  id: string; songTitle: string; artist: string; version: string;
  candidateCount: number; disputedCount: number;
  source: string; note: string;
  relevant: boolean;
  identity: ReferenceView['identity'];
}

const BASE = (songId: string) => `/api/repertoire/${encodeURIComponent(songId)}/structure-draft`;
/** 分析是长耗时操作（本机解码整首歌），不能用 api 的 15 秒兜底。 */
const ANALYZE_TIMEOUT_MS = 240_000;
/** 波形要整曲解码，给足时间但仍有限。 */
const WAVEFORM_TIMEOUT_MS = 60_000;

export async function readStructureDraft(songId: string): Promise<StructureDraft | null> {
  const result = await api<{ draft: StructureDraft | null }>(BASE(songId));
  return result.draft ?? null;
}

export async function generateStructureDraft(songId: string, force = false): Promise<{ draft: StructureDraft; reused: boolean }> {
  return apiWithTimeout(`${BASE(songId)}`, { method: 'POST', ...jsonBody({ force }) }, ANALYZE_TIMEOUT_MS);
}

export async function applyStructureDraft(songId: string, map: StructureMap, replaceManual = false, confirmReference = false): Promise<{ item: TalentItem; applied: number; draft: StructureDraft }> {
  return apiWithTimeout(`${BASE(songId)}`, { method: 'PUT', ...jsonBody({ map, replaceManual, confirmReference }) }, 60_000);
}

export async function restoreLegacyStructure(songId: string): Promise<{ item: TalentItem; restored: number }> {
  return apiWithTimeout(`${BASE(songId)}/restore`, { method: 'POST' }, 60_000);
}

export async function discardStructureDraft(songId: string): Promise<void> {
  await api(`${BASE(songId)}`, { method: 'DELETE' });
}

/**
 * 载入参考结构草稿：只写草稿表，正式结构不动。
 * 身份核验不过时服务端返回 409，前端原样显示原因，不降级成「部分载入」。
 */
export async function loadStructureReference(songId: string, reference: unknown): Promise<{ draft: StructureDraft; identity: ReferenceView['identity'] }> {
  return apiWithTimeout(`${BASE(songId)}/reference`, { method: 'POST', ...jsonBody({ reference }) }, 30_000);
}

/**
 * 本机内置参考目录：服务端用当前曲目元数据 + 现算音频摘要逐条核对身份。
 * 不传文件、不联网，也不返回任何歌词正文。
 */
export async function readReferenceCatalog(songId: string): Promise<ReferenceCatalogEntry[]> {
  const result = await apiWithTimeout<{ entries: ReferenceCatalogEntry[] }>(
    `${BASE(songId)}/reference/catalog`, {}, 30_000,
  );
  return result.entries ?? [];
}

/** 一键载入内置参考：等价于用户亲手选那份已核对过的参考，身份不过仍整份拒绝。 */
export async function loadCatalogReference(songId: string, catalogId: string): Promise<{ draft: StructureDraft; identity: ReferenceView['identity'] }> {
  return apiWithTimeout(`${BASE(songId)}/reference/catalog`, { method: 'POST', ...jsonBody({ catalogId }) }, 30_000);
}

/** 重新载入上次的参考草稿（重新分析之后用）。 */
export async function reapplyStructureReference(songId: string): Promise<{ draft: StructureDraft }> {
  return apiWithTimeout(`${BASE(songId)}/reference/reapply`, { method: 'POST' }, 30_000);
}

/** 放弃参考草稿，回到载入前的地图；正式结构不变。 */
export async function clearStructureReference(songId: string): Promise<{ draft: StructureDraft }> {
  return apiWithTimeout(`${BASE(songId)}/reference`, { method: 'DELETE' }, 30_000);
}

/** 波形包络：只用于拖动校正，不参与任何类型判断。 */
export async function readWaveform(songId: string, buckets = 600): Promise<StructureWaveform> {
  return apiWithTimeout(`/api/repertoire/${encodeURIComponent(songId)}/structure-waveform?buckets=${buckets}`, {}, WAVEFORM_TIMEOUT_MS);
}

/** 草稿段 → 界面可编辑段（保留溯源字段，便于显示「争议/未锚上」）。 */
export function draftSectionsOf(draft: StructureDraft | null): StudioSection[] {
  if (!draft?.map?.sections) return [];
  return draft.map.sections.map((section) => ({
    id: section.id,
    type: section.type,
    label: section.code || section.id,
    startMs: section.startMs,
    endMs: section.endMs,
    source: section.source === 'reference' ? 'manual' : (section.source === 'algorithm' ? 'algorithm' : 'manual'),
    ...(section.repeatOf ? { repeatOf: section.repeatOf } : {}),
    ...(section.repetition ? { repetition: section.repetition } : {}),
    ...(section.type === 'rap' && typeof section.approvedRap === 'boolean' ? { rapApproved: section.approvedRap } : {}),
    referenceLabel: section.referenceLabel,
    disputed: section.disputed,
    alternates: section.alternates,
    repeatCandidateOf: section.repeatCandidateOf ?? null,
    endUnverified: section.endUnverified,
    anchor: section.anchor,
    fromReference: section.source === 'reference' || String(section.id).startsWith('ref-'),
  }));
}
