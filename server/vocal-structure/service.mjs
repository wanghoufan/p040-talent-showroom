import { createHash } from 'node:crypto';
import { sha256File } from './analyzer.mjs';
import { buildSongMap, fromP040Sections, mapSummary, toP040Sections } from './structure-map.mjs';
import { applyReferenceToMap, detachReference, normalizeReference, verifyIdentity } from './reference.mjs';
import { catalogEntriesFor, catalogReference } from './reference-catalog.mjs';

/**
 * 结构草稿服务（V3.2 T4）。
 *
 * 数据职责：
 * - `vocal_structure_drafts` 只存「分析草稿」：原曲 SHA、模型版本、地图 JSON、旧结构快照；
 * - 正式 `repertoire_items.sections_json` 只在用户显式「应用」时写入，且一律 `source='manual'`；
 * - 应用前把旧结构完整存进草稿，可一键恢复；
 * - 完全不碰音轨、歌词与伴奏，也不启动任何分离流程。
 */

const MAX_SECTIONS = 200;
const STATE = Object.freeze({ DRAFT: 'DRAFT', NEEDS_REVIEW: 'NEEDS_REVIEW', APPLIED: 'APPLIED', DISCARDED: 'DISCARDED' });

function fail(code, message, status = 400) {
  return Object.assign(new Error(message ? `${code}: ${message}` : code), { code, status });
}

function parseJson(text, fallback) {
  try {
    const value = JSON.parse(text ?? '');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * 正式结构的指纹：只取「段本身」的字段，用来判断草稿生成后结构有没有被改过。
 * 不用曲目 revision——练习设置、歌词、译文都会推进 revision，它们跟结构无关，
 * 拿 revision 做闸门会把「只改了倍速」也当成冲突，让草稿永远应用不上。
 */
export function sectionsFingerprint(sections) {
  const rows = (Array.isArray(sections) ? sections : []).map((section) => [
    String(section?.id ?? ''),
    String(section?.type ?? ''),
    Number(section?.startMs ?? 0),
    Number(section?.endMs ?? 0),
    section?.repeatOf ?? null,
    section?.repetition ?? null,
    section?.source ?? 'manual',
    section?.rapApproved ?? null,
  ]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 32);
}

/** 原唱音轨在受控 mediaRoot 内的只读路径；越界一律拒绝。 */export function resolveOriginalAudio(db, mediaRoot, songId) {
  const row = db.prepare(
    `SELECT r.id, r.original_clip_id, r.performance_clip_id, r.audio_role, c.internal_audio_path, c.sha256, c.duration_ms
     FROM repertoire_items r
     LEFT JOIN performance_clips c ON c.id = COALESCE(r.original_clip_id, r.performance_clip_id)
     WHERE r.id = ? AND r.deleted_at IS NULL`,
  ).get(String(songId));
  if (!row) throw fail('NOT_FOUND', '曲目不存在', 404);
  if (!row.internal_audio_path) throw fail('NO_AUDIO', '这条曲目还没有原唱音轨', 409);
  const absolute = `${mediaRoot}/${row.internal_audio_path}`.replace(/\/+/g, '/');
  if (!absolute.startsWith(`${mediaRoot}/`)) throw fail('PATH_NOT_ALLOWED', '音轨路径越出受控目录', 403);
  return { absolute, sha256: row.sha256 || null, durationMs: row.duration_ms || null, clipId: row.original_clip_id || row.performance_clip_id };
}

export function readDraft(db, songId) {
  const row = db.prepare('SELECT * FROM vocal_structure_drafts WHERE song_id=?').get(String(songId));
  if (!row) return null;
  return {
    songId: row.song_id,
    state: row.state,
    sourceSha256: row.source_sha256,
    modelName: row.model_name,
    modelVersion: row.model_version,
    generatedAt: row.generated_at,
    updatedAt: row.updated_at,
    baseRevision: row.base_revision,
    appliedRevision: row.applied_revision,
    appliedAt: row.applied_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    map: parseJson(row.map_json, null),
    analysis: parseJson(row.analysis_json, {}),
    legacySections: parseJson(row.legacy_sections_json, []),
  };
}

function writeDraft(db, row) {
  db.prepare(
    `INSERT INTO vocal_structure_drafts(
       song_id, source_sha256, model_name, model_version, generated_at, updated_at, state,
       base_revision, map_json, analysis_json, legacy_sections_json, last_error_code, last_error_message
     ) VALUES(?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?,?,?,?,?,?,?)
     ON CONFLICT(song_id) DO UPDATE SET
       source_sha256=excluded.source_sha256,
       model_name=excluded.model_name,
       model_version=excluded.model_version,
       updated_at=CURRENT_TIMESTAMP,
       state=excluded.state,
       base_revision=excluded.base_revision,
       map_json=excluded.map_json,
       analysis_json=excluded.analysis_json,
       legacy_sections_json=excluded.legacy_sections_json,
       last_error_code=excluded.last_error_code,
       last_error_message=excluded.last_error_message`,
  ).run(
    row.songId,
    row.sourceSha256,
    row.modelName,
    row.modelVersion,
    row.state,
    row.baseRevision ?? null,
    JSON.stringify(row.map ?? {}),
    JSON.stringify(row.analysis ?? {}),
    JSON.stringify(row.legacySections ?? []),
    row.lastErrorCode ?? null,
    row.lastErrorMessage ?? null,
  );
  return readDraft(db, row.songId);
}

function toView(draft, item) {
  const map = draft.map ?? {};
  return {
    songId: draft.songId,
    state: draft.state,
    generatedAt: draft.generatedAt,
    modelName: draft.modelName,
    modelVersion: draft.modelVersion,
    baseRevision: draft.baseRevision,
    appliedRevision: draft.appliedRevision,
    appliedAt: draft.appliedAt,
    legacySectionCount: Array.isArray(draft.legacySections) ? draft.legacySections.length : 0,
    currentSectionCount: Array.isArray(item?.sections) ? item.sections.length : 0,
    summary: mapSummary(map),
    timing: draft.analysis?.timing ?? null,
    separation: draft.analysis?.separation ?? null,
    /** 参考结构草稿：身份核验结果与候选清单；只存在于草稿，不写正式结构。 */
    reference: draft.analysis?.reference ?? null,
    map,
  };
}

/**
 * 生成/重算草稿。同一首歌同一份原曲+同一模型版本默认幂等，
 * 只有显式 force 才重跑（避免每次打开详情都拉起分析）。
 */
export async function generateStructureDraft({
  db, mediaRoot, analyzer, getRepertoire, songId, lyrics, force = false, workDir = 'var/vocal-v31-work/structure',
} = {}) {
  const item = getRepertoire(db, songId);
  if (!item) throw fail('NOT_FOUND', '曲目不存在', 404);
  if (item.kind !== 'VOCAL') throw fail('BAD_REQUEST', '只有唱歌曲目有结构地图', 400);
  const audio = resolveOriginalAudio(db, mediaRoot, songId);
  const existing = readDraft(db, songId);

  const sha = sha256File(audio.absolute);
  if (existing && !force && existing.sourceSha256 === sha && existing.modelVersion === analyzer.modelVersion
    && existing.state !== STATE.DISCARDED) {
    return { draft: toView(existing, item), reused: true };
  }

  const outPath = `${workDir.replace(/\/$/, '')}/${String(songId).replace(/[^A-Za-z0-9_-]/g, '_')}-analysis.json`;
  const analysis = await analyzer.analyze({ audioPath: audio.absolute, outPath, expectedSha256: audio.sha256 || undefined });

  const map = buildSongMap({
    songId,
    durationMs: analysis.durationMs,
    modelSegments: analysis.segments,
    audioEvidence: analysis.relations,
    mergeCandidates: analysis.mergeCandidates,
    lyrics: lyrics ?? item.lyrics ?? [],
    provenance: {
      modelName: analysis.modelName,
      modelVersion: analysis.modelVersion,
      librosaVersion: analysis.librosaVersion,
      generatedAt: new Date().toISOString(),
      sourceSha256: analysis.audioSha256,
      separationUsed: false,
    },
  });

  // 只要还有「待标注」的段，就必须人工确认过类型才算可用草稿；全都有类型才是普通草稿。
  const state = map.sections.some((section) => section.type === 'unknown') ? STATE.NEEDS_REVIEW : STATE.DRAFT;
  const draft = writeDraft(db, {
    songId,
    sourceSha256: analysis.audioSha256,
    modelName: analysis.modelName,
    modelVersion: analysis.modelVersion,
    state,
    baseRevision: item.revision ?? null,
    map,
    analysis: {
      timing: analysis.timing,
      separation: analysis.separation,
      tempoBpm: analysis.tempoBpm,
      decoder: analysis.decoder,
      segmentCount: analysis.segments.length,
      relationCount: analysis.relations?.length ?? 0,
      // 生成时的正式结构指纹；应用时只比对它，结构没动就允许应用（不看 revision）。
      baseSectionsHash: sectionsFingerprint(item.sections ?? []),
      // 重新分析只替换音频段落，参考草稿的快照保留，用户可再恢复，不被静默丢掉。
      reference: existing?.analysis?.reference ?? null,
    },
    // 第一次生成时冻结旧结构；重复重算不覆盖，避免丢掉最早的可回退快照。
    legacySections: existing?.legacySections?.length ? existing.legacySections : (item.sections ?? []),
  });
  return { draft: toView(draft, item), reused: false };
}

/**
 * 应用草稿：把用户确认后的地图写回正式结构。
 * - 只接受整张 map（界面编辑后的结果），服务端重新编号与校验，不信任客户端 label；
 * - 已有人工结构时必须显式 `replaceManual: true`，否则 409；
 * - 写入后 source 全部为 manual，AI 来源只保留在草稿里。
 */
export function applyStructureDraft({ db, getRepertoire, saveRepertoire, songId, map, replaceManual = false, confirmReference = false } = {}) {
  const draft = readDraft(db, songId);
  if (!draft) throw fail('DRAFT_NOT_FOUND', '还没有结构草稿，请先生成', 404);
  if (draft.state === STATE.DISCARDED) throw fail('DRAFT_DISCARDED', '草稿已丢弃，请重新生成', 409);
  if (!map || !Array.isArray(map.sections) || !map.sections.length) throw fail('INVALID_MAP', '草稿没有可用段落', 400);
  if (map.sections.length > MAX_SECTIONS) throw fail('INVALID_MAP', '段落过多', 400);
  // 参考草稿不能「一键应用」：必须由用户逐段核对后显式确认，否则争议类型会被悄悄定型。
  if (map.sections.some((section) => section?.source === 'reference' || section?.disputed === true) && confirmReference !== true) {
    throw fail('REFERENCE_CONFIRMATION_REQUIRED', '这是参考草稿，需先逐段核对再应用', 409);
  }

  const durationMs = Number.isInteger(map.durationMs) && map.durationMs > 0 ? map.durationMs : draft.map?.durationMs;
  const rebuilt = fromP040Sections(map.sections, {
    durationMs,
    lyrics: map.lyrics ?? draft.map?.lyrics ?? [],
    songId,
    provenance: draft.map?.provenance ?? null,
    // 应用草稿是「新写入」：Rap 必须逐段显式确认，不能拿 source='manual' 兜底。
    legacyRapFallback: false,
  });
  const item = getRepertoire(db, songId);
  if (!item) throw fail('NOT_FOUND', '曲目不存在', 404);
  const priorSections = item.sections ?? [];
  if (priorSections.some((section) => section.source === 'manual') && replaceManual !== true) {
    throw fail('MANUAL_OVERRIDE', '这首曲目已有手工校准结构，需显式确认覆盖', 409);
  }
  // 结构确实被改过才拒绝；只改练习设置/歌词/译文不算。旧草稿没有指纹时退回 revision 比对。
  const baseHash = draft.analysis?.baseSectionsHash;
  if (typeof baseHash === 'string') {
    if (sectionsFingerprint(priorSections) !== baseHash) {
      throw fail('CONFLICT', '曲目结构在生成草稿后被改动，请重新生成草稿', 409);
    }
  } else if (Number.isInteger(draft.baseRevision) && Number.isInteger(item.revision) && draft.baseRevision !== item.revision) {
    throw fail('CONFLICT', '曲目在生成草稿后已被修改，请重新生成草稿', 409);
  }

  const sections = toP040Sections(rebuilt, { confirmed: true });
  const saved = saveRepertoire(db, songId, { sections });
  db.prepare(
    `UPDATE vocal_structure_drafts SET state=?, applied_revision=?, applied_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
     WHERE song_id=?`,
  ).run(STATE.APPLIED, saved.revision ?? null, songId);
  return { item: saved, applied: sections.length, draft: readDraft(db, songId) };
}

/** 恢复生成草稿时冻结的旧结构（用户反悔时使用）。 */
export function restoreLegacySections({ db, getRepertoire, saveRepertoire, songId } = {}) {
  const draft = readDraft(db, songId);
  if (!draft) throw fail('DRAFT_NOT_FOUND', '没有可恢复的历史结构', 404);
  const legacy = Array.isArray(draft.legacySections) ? draft.legacySections : [];
  if (!legacy.length) throw fail('NO_LEGACY_SECTIONS', '生成草稿时这首歌本来就没有结构', 409);
  const sections = legacy.map((section) => ({
    ...section,
    source: 'manual',
    // 旧快照里的算法 Rap 从未经用户确认；恢复时不能借「改成 manual」变成可跳过。
    ...(section.type === 'rap' && section.rapApproved === undefined && section.source !== 'manual' ? { rapApproved: false } : {}),
  }));
  const saved = saveRepertoire(db, songId, { sections }, {
    // 快照本身就是之前落过库的结构；恢复时不能因为旧尾段比当前音轨长几十毫秒就恢复不了。
    allowLegacyOverhangIds: new Set(sections.map((section) => section.id)),
  });
  db.prepare('UPDATE vocal_structure_drafts SET state=?, applied_revision=?, applied_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE song_id=?')
    .run(STATE.DISCARDED, saved.revision ?? null, songId);
  return { item: saved, restored: sections.length };
}

export function discardStructureDraft({ db, songId } = {}) {
  const draft = readDraft(db, songId);
  if (!draft) throw fail('DRAFT_NOT_FOUND', '没有草稿', 404);
  db.prepare('UPDATE vocal_structure_drafts SET state=?, updated_at=CURRENT_TIMESTAMP WHERE song_id=?').run(STATE.DISCARDED, songId);
  return { songId: String(songId), state: STATE.DISCARDED };
}

export function getDraftView({ db, getRepertoire, songId } = {}) {
  const item = getRepertoire(db, songId);
  if (!item) throw fail('NOT_FOUND', '曲目不存在', 404);
  const draft = readDraft(db, songId);
  if (!draft) return null;
  return toView(draft, item);
}

/** 记录失败（分析器异常），让界面能显示「待分析 + 原因」，而不是静默空白。 */
export function recordDraftFailure({ db, songId, code, message, item }) {
  const existing = readDraft(db, songId);
  const emptyMap = { sections: [], warnings: ['ANALYSIS_FAILED'], durationMs: 0 };
  writeDraft(db, {
    songId,
    sourceSha256: existing?.sourceSha256 ?? '',
    modelName: existing?.modelName ?? 'p040-mix-structure',
    modelVersion: existing?.modelVersion ?? 'unknown',
    state: STATE.DRAFT,
    baseRevision: item?.revision ?? existing?.baseRevision ?? null,
    map: existing?.map ?? emptyMap,
    analysis: existing?.analysis ?? {},
    legacySections: existing?.legacySections?.length ? existing.legacySections : (item?.sections ?? []),
    lastErrorCode: code ?? 'ANALYSIS_FAILED',
    lastErrorMessage: String(message ?? '').slice(0, 300),
  });
}

/** 供界面直接编辑既有结构：不跑分析，只把当前正式结构转成地图。 */
export function draftFromCurrentSections({ db, getRepertoire, songId } = {}) {
  const item = getRepertoire(db, songId);
  if (!item) throw fail('NOT_FOUND', '曲目不存在', 404);
  if (!Array.isArray(item.sections) || !item.sections.length) return null;
  const durationMs = Math.max(1, item.durationMs || 0, ...item.sections.map((section) => section.endMs));
  // 旧正式结构没有 rapApproved：载入编辑时沿用旧行为（source='manual' 视为已确认），
  // 但再次保存会写入显式状态，之后不再靠推断。
  return fromP040Sections(item.sections, { durationMs, lyrics: item.lyrics ?? [], songId, legacyRapFallback: true });
}

function emptyDraftMap(songId, durationMs, lyrics) {
  return {
    schema: 'p040.song-map.v1',
    songId: String(songId),
    durationMs,
    provenance: null,
    status: 'insufficient-evidence',
    sections: [],
    relationCandidates: [],
    mergeCandidates: [],
    unassigned: [],
    warnings: ['NO_SECTIONS'],
    lyrics: lyrics ?? [],
  };
}

/**
 * 载入参考结构草稿（P040 V3.3）。
 *
 * 只写 `vocal_structure_drafts`，正式 `sections_json` 一个字节都不动；
 * 身份核验不过（歌手/歌名/版本/时长/原音频 SHA）直接 409，不落任何候选。
 */
export function setStructureReference({ db, mediaRoot, getRepertoire, songId, reference, shaProvider = sha256File } = {}) {
  const item = getRepertoire(db, songId);
  if (!item) throw fail('NOT_FOUND', '曲目不存在', 404);
  if (item.kind !== 'VOCAL') throw fail('BAD_REQUEST', '只有唱歌曲目有结构参考', 400);
  const audio = resolveOriginalAudio(db, mediaRoot, songId);
  /** `shaProvider` 只供定向测试注入固定摘要；HTTP 路由永远走默认的真实文件摘要。 */
  const sha = shaProvider(audio.absolute);
  /**
   * 曲目行本身没有时长列，时长以音轨为准。
   * 身份核验拿不到时长就等于无法核对，不能退回「0 秒也算过」。
   */
  const localDurationMs = Math.max(Number(item.durationMs) || 0, Number(audio.durationMs) || 0);

  const normalized = normalizeReference(reference);
  const identity = verifyIdentity({
    reference: normalized,
    item: { ...item, durationMs: localDurationMs },
    audioSha256: sha,
  });
  if (!identity.ok) {
    throw Object.assign(
      fail('IDENTITY_MISMATCH', identity.blockers.map((item2) => item2.detail).join('；'), 409),
      { identity },
    );
  }

  const durationMs = Math.max(1, item.durationMs || 0, audio.durationMs || 0, normalized.audioDurationMs);
  const existing = readDraft(db, songId);
  /** 参考草稿自己不作为「载入前结构」：重复载入时仍退回最初的分析段/空地图。 */
  const priorSections = existing?.map?.analysisSections ?? existing?.map?.sections ?? [];
  const baseMap = existing?.map
    ? { ...existing.map, sections: priorSections, analysisSections: undefined }
    : emptyDraftMap(songId, durationMs, item.lyrics);

  const applied = applyReferenceToMap({
    map: { ...baseMap, durationMs, lyrics: item.lyrics ?? baseMap.lyrics ?? [] },
    reference: normalized,
    identity,
    durationMs,
    lyrics: item.lyrics ?? [],
  });

  const draft = writeDraft(db, {
    songId,
    sourceSha256: sha,
    modelName: existing?.modelName || 'reference-draft',
    modelVersion: existing?.modelVersion || 'draft',
    state: STATE.DRAFT,
    baseRevision: item.revision ?? null,
    map: applied.map,
    analysis: {
      ...(existing?.analysis ?? {}),
      // 规范化后的参考原文一并留存，重新分析把草稿段落换成音频段落后还能一键恢复参考。
      reference: { ...applied.reference, payload: normalized },
    },
    legacySections: existing?.legacySections?.length ? existing.legacySections : (item.sections ?? []),
  });
  return { draft: toView(draft, item), identity };
}

/** 重新载入上次保存的参考草稿（重新分析之后使用）。 */
export function reapplyStructureReference({ db, getRepertoire, songId } = {}) {
  const draft = readDraft(db, songId);
  if (!draft) throw fail('DRAFT_NOT_FOUND', '还没有结构草稿', 404);
  const stored = draft.analysis?.reference;
  if (!stored?.payload) throw fail('REFERENCE_NOT_FOUND', '草稿里没有参考结构', 409);
  const item = getRepertoire(db, songId);
  if (!item) throw fail('NOT_FOUND', '曲目不存在', 404);
  const durationMs = Number.isInteger(draft.map?.durationMs) && draft.map.durationMs > 0
    ? draft.map.durationMs
    : Math.max(1, item.durationMs || 0);
  const priorSections = draft.map?.analysisSections ?? [];
  const applied = applyReferenceToMap({
    map: { ...draft.map, durationMs, sections: priorSections, analysisSections: undefined },
    reference: stored.payload,
    identity: stored.identity,
    durationMs,
    lyrics: item.lyrics ?? [],
  });
  const next = writeDraft(db, {
    songId,
    sourceSha256: draft.sourceSha256,
    modelName: draft.modelName,
    modelVersion: draft.modelVersion,
    state: STATE.DRAFT,
    baseRevision: draft.baseRevision ?? null,
    map: applied.map,
    analysis: { ...draft.analysis, reference: { ...applied.reference, payload: stored.payload } },
    legacySections: draft.legacySections,
  });
  return { draft: toView(next, item) };
}

/** 放弃参考草稿：回到载入前的地图，正式结构不变。 */
export function clearStructureReference({ db, getRepertoire, songId } = {}) {
  const draft = readDraft(db, songId);
  if (!draft) throw fail('DRAFT_NOT_FOUND', '还没有结构草稿', 404);
  const item = getRepertoire(db, songId);
  if (!item) throw fail('NOT_FOUND', '曲目不存在', 404);
  const analysis = { ...(draft.analysis ?? {}) };
  delete analysis.reference;
  const next = writeDraft(db, {
    songId,
    sourceSha256: draft.sourceSha256,
    modelName: draft.modelName,
    modelVersion: draft.modelVersion,
    state: STATE.DRAFT,
    baseRevision: draft.baseRevision ?? null,
    map: detachReference(draft.map ?? {}),
    analysis,
    legacySections: draft.legacySections,
  });
  return { draft: toView(next, item) };
}

/**
 * 本机身份上下文：曲目行、原曲文件、现算 SHA、可用时长。
 * 目录匹配和参考载入都用它，保证「界面看到的匹配结果」与「真正载入时的核验」是同一份数据。
 */
function localIdentityContext({ db, mediaRoot, getRepertoire, songId, shaProvider = sha256File } = {}) {
  const item = getRepertoire(db, songId);
  if (!item) throw fail('NOT_FOUND', '曲目不存在', 404);
  if (item.kind !== 'VOCAL') throw fail('BAD_REQUEST', '只有唱歌曲目有结构参考', 400);
  const audio = resolveOriginalAudio(db, mediaRoot, songId);
  const sha = shaProvider(audio.absolute);
  const localDurationMs = Math.max(Number(item.durationMs) || 0, Number(audio.durationMs) || 0);
  return { item: { ...item, durationMs: localDurationMs }, audio, sha, localDurationMs };
}

/**
 * 本机内置参考目录 × 这首曲目（P040 V1.2）。
 *
 * 只返回与本曲相关（歌名相同或身份已全过）的条目，并附五项核验结果；
 * 不返回任何歌词、不返回参考文件路径，也不写任何草稿。
 */
export function listStructureReferences({ db, mediaRoot, getRepertoire, songId, shaProvider = sha256File } = {}) {
  const { item, sha } = localIdentityContext({ db, mediaRoot, getRepertoire, songId, shaProvider });
  const entries = catalogEntriesFor({ item, audioSha256: sha }).filter((entry) => entry.relevant);
  return { entries, songId: String(songId) };
}

/**
 * 一键载入本机内置参考：等价于用户亲手选那份已核对过的文件，仍走同一套身份核验与草稿写入。
 * 身份任何一项不符都整份 409，不落候选、不留草稿。
 */
export function setStructureReferenceFromCatalog({ db, mediaRoot, getRepertoire, songId, catalogId, shaProvider = sha256File } = {}) {
  const reference = catalogReference(catalogId);
  if (!reference) throw fail('REFERENCE_CATALOG_NOT_FOUND', '本机没有这份参考结构', 404);
  return setStructureReference({ db, mediaRoot, getRepertoire, songId, reference, shaProvider });
}
