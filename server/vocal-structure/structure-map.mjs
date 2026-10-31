/**
 * 歌曲结构地图核心（P040 V3.2）。
 *
 * 职责边界（§1.2 / §2.1）：
 * - 音频证据（model segments + 声学相似候选）只来自原唱混音分析，本文件不读音频、不联网、不开子进程；
 * - LRC 只用于句序、时间锚点与「这一段有没有人唱」，绝不据此判定主歌/副歌；
 * - 声学相似只生成 `pending-confirmation` 候选，不等于「同旋律」；
 * - 任何写回正式 `sections_json` 的动作都必须显式 confirmed，并由调用方标记 source='manual'。
 *
 * 纯函数、不可变：所有编辑返回新 map，原 map 不被修改（便于 Undo/Redo 引用不悬空）。
 */

export const MAP_SCHEMA = 'p040.song-map.v1';

/** 与 server/repertoire/service.mjs 的 SECTION_TYPES 保持一致。 */
export const SECTION_TYPES = Object.freeze(['intro', 'verse', 'pre', 'chorus', 'bridge', 'rap', 'outro', 'unknown']);

const FAMILY = Object.freeze({ verse: 'A', chorus: 'B', pre: 'P', bridge: 'C', rap: 'R' });
const TYPE_LABEL = Object.freeze({
  intro: '前奏', verse: '主歌', pre: '预副歌', chorus: '副歌', bridge: '桥段', rap: 'Rap', outro: '尾奏', unknown: '待标注',
});
/** 分析侧的标签 → 正式枚举。不认识的标签一律 unknown，不猜。 */
const LABEL_TO_TYPE = Object.freeze({
  intro: 'intro', start: 'intro',
  verse: 'verse', 'main-verse': 'verse',
  'pre-chorus': 'pre', prechorus: 'pre', pre: 'pre',
  chorus: 'chorus', hook: 'chorus',
  bridge: 'bridge', break: 'bridge',
  rap: 'rap',
  outro: 'outro', end: 'outro',
  instrumental: 'unknown', solo: 'unknown', unknown: 'unknown', segment: 'unknown',
});

const MIN_SECTION_MS = 500;
/** 声学相似低于这个分数不生成候选，避免把互补段落凑成「重复」。 */
const RELATION_THRESHOLD = 0.65;
/** 首段整段在首句歌词之前，且不短于 4 秒 ⇒ 前奏（「没人唱」的音频区间，不是旋律判断）。 */
const INTRO_MIN_MS = 4000;
/** 末段起点在最后一句歌词起点之后至少 2 秒 ⇒ 尾奏。 */
const OUTRO_GAP_MS = 2000;
const MAX_SECTIONS = 200;

function insist(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

export function isSectionType(value) {
  return SECTION_TYPES.includes(value);
}

/** 类型 → 该类型在 map 里的显示文案；未知类型返回 null。 */
export function typeLabel(type) {
  return TYPE_LABEL[type] ?? null;
}

function normalizeText(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function toLyrics(lyrics) {
  insist(Array.isArray(lyrics), 'INVALID_LYRICS');
  return lyrics
    .filter((line) => line && Number.isFinite(line.startMs) && line.startMs >= 0 && typeof line.text === 'string')
    .map((line, index) => ({
      id: String(line.id ?? `line-${index + 1}`),
      startMs: Math.round(line.startMs),
      text: line.text,
    }))
    .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
}

function linesWithin(lyrics, startMs, endMs) {
  return lyrics.filter((line) => line.startMs >= startMs && line.startMs < endMs);
}

function linesContent(lines) {
  return lines.map((line) => normalizeText(line.text)).filter(Boolean).join('|');
}

/**
 * 重新编号：同类按出现顺序编号（A1/A2/B1…），intro/outro 固定文字，
 * unknown 按声学 cluster 编号（同一 cluster 同一 U 号），没有 cluster 时按出现顺序。
 */
function recode(sections) {
  const counts = new Map();
  const clusterCode = new Map();
  let unknownCount = 0;
  return sections.map((section) => {
    const family = FAMILY[section.type];
    let code;
    if (family) {
      const next = (counts.get(family) ?? 0) + 1;
      counts.set(family, next);
      code = `${family}${next}`;
    } else if (section.type === 'intro' || section.type === 'outro') {
      code = SECTION_LABEL(section.type);
    } else if (section.clusterId) {
      if (!clusterCode.has(section.clusterId)) clusterCode.set(section.clusterId, `U${++unknownCount}`);
      code = clusterCode.get(section.clusterId);
    } else {
      code = `U${++unknownCount}`;
    }
    return { ...section, code, label: code, typeLabel: TYPE_LABEL[section.type] ?? '待标注' };
  });
}

function SECTION_LABEL(type) {
  return TYPE_LABEL[type];
}

function checkSections(sections, durationMs) {
  insist(Number.isInteger(durationMs) && durationMs > 0 && durationMs <= 24 * 3600 * 1000, 'INVALID_DURATION');
  insist(Array.isArray(sections) && sections.length <= MAX_SECTIONS, 'INVALID_SECTIONS');
  const ids = new Set();
  let lastEnd = 0;
  for (const section of sections) {
    insist(typeof section.id === 'string' && section.id.length > 0 && section.id.length <= 64, 'INVALID_SECTION_ID');
    insist(!ids.has(section.id), 'DUPLICATE_SECTION_ID');
    ids.add(section.id);
    insist(Number.isInteger(section.startMs) && Number.isInteger(section.endMs), 'INVALID_SECTION_RANGE');
    insist(section.startMs >= 0 && section.endMs <= durationMs, 'INVALID_SECTION_RANGE');
    insist(section.endMs - section.startMs >= MIN_SECTION_MS, 'INVALID_SECTION_RANGE');
    insist(section.startMs >= lastEnd, 'OVERLAPPING_SECTIONS');
    insist(isSectionType(section.type), 'UNKNOWN_SECTION_TYPE');
    lastEnd = section.endMs;
  }
  for (const section of sections) {
    if (!section.repeatOf) continue;
    const target = sections.find((item) => item.id === section.repeatOf);
    insist(Boolean(target), 'DANGLING_RELATION');
    insist(target.startMs < section.startMs, 'INVALID_RELATION_TARGET');
    insist(target.type === section.type, 'INVALID_RELATION_TARGET');
  }
}

function sortSections(sections) {
  return [...sections].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
}

function withLines(sections, lyrics) {
  return sections.map((section) => ({ ...section, lines: linesWithin(lyrics, section.startMs, section.endMs) }));
}

function findIndex(map, id) {
  const index = map.sections.findIndex((section) => section.id === id);
  insist(index >= 0, 'SECTION_NOT_FOUND');
  return index;
}

/** 边界或类型一变，原 Rap 确认区间就失效；必须重新逐段确认。 */
function resetRapApproval(section) {
  if (section.type === 'rap') return { ...section, approvedRap: false };
  const next = { ...section };
  delete next.approvedRap;
  return next;
}

/** 重排/改类型后统一重建：编号稳定、歌词绑定、关系自检；失效候选一并清掉。 */
function rebuild(map, sections) {
  const ordered = sortSections(sections);
  checkSections(ordered, map.durationMs);
  const ids = new Set(ordered.map((section) => section.id));
  return {
    ...map,
    sections: withLines(recode(ordered), map.lyrics ?? []),
    relationCandidates: (map.relationCandidates ?? []).filter((item) => ids.has(item.from) && ids.has(item.to)),
    // 分段一旦被手工改动，原来的「相邻建议合并」就已经过期，不能继续显示。
    mergeCandidates: [],
    status: ordered.length ? 'draft' : 'insufficient-evidence',
  };
}

function emptyMap(input) {
  return {
    schema: MAP_SCHEMA,
    songId: String(input?.songId ?? ''),
    durationMs: input?.durationMs,
    provenance: input?.provenance ?? null,
    status: 'insufficient-evidence',
    sections: [],
    relationCandidates: [],
    mergeCandidates: [],
    unassigned: [],
    warnings: ['NO_SECTIONS'],
    lyrics: [],
  };
}

/**
 * 音频结构 → 歌曲地图草稿。
 *
 * @param {object} input
 * @param {string} [input.songId]
 * @param {number} input.durationMs 原曲总时长（毫秒）
 * @param {Array<{start:number,end:number,label?:string,clusterId?:string,confidence?:number}>} input.modelSegments
 *        由真实混音分析产出的分段（秒）；空数组表示没有音频证据 ⇒ 不造段。
 * @param {Array<{startMs:number,text:string}>} [input.lyrics] 只用于句锚点与前后奏判断
 * @param {Array<{left:number,right:number,score:number,method?:string}>} [input.audioEvidence]
 *        声学相似候选，left/right 是 modelSegments 的下标；只生成待确认候选。
 */
export function buildSongMap(input) {
  insist(Number.isInteger(input?.durationMs) && input.durationMs > 0, 'INVALID_DURATION');
  const lyrics = toLyrics(input.lyrics ?? []);
  insist(Array.isArray(input.modelSegments), 'NO_AUDIO_STRUCTURE_EVIDENCE');
  if (!input.modelSegments.length) {
    return { ...emptyMap({ ...input, durationMs: input.durationMs }), lyrics, warnings: ['NO_SECTIONS', 'NO_AUDIO_STRUCTURE_EVIDENCE'] };
  }

  const filtered = [];
  input.modelSegments.forEach((raw, index) => {
    if (!raw) return;
    insist(Number.isFinite(raw.start) && Number.isFinite(raw.end), 'INVALID_MODEL_SEGMENT');
    let startMs = Math.round(raw.start * 1000);
    let endMs = Math.round(raw.end * 1000);
    if (endMs <= startMs) return;
    if (startMs >= input.durationMs) return;
    // 尾部超出 1 秒内的分析误差允许夹取到总时长；超得多说明数据本身不可信。
    insist(endMs <= input.durationMs + 1000, 'MODEL_SEGMENT_OUT_OF_BOUNDS');
    startMs = Math.max(0, startMs);
    endMs = Math.min(endMs, input.durationMs);
    if (endMs - startMs < MIN_SECTION_MS) return;
    const label = String(raw.label ?? 'unknown').trim().toLowerCase().replaceAll('_', '-');
    const type = LABEL_TO_TYPE[label] ?? 'unknown';
    filtered.push({
      id: `analysis-${index + 1}`,
      originIndex: index,
      type,
      startMs,
      endMs,
      source: 'algorithm',
      evidence: 'audio-boundary',
      clusterId: typeof raw.clusterId === 'string' && raw.clusterId ? raw.clusterId : null,
      confidence: Number.isFinite(raw.confidence) ? raw.confidence : null,
      rms: Number.isFinite(raw.rms) ? raw.rms : null,
      approvedRap: false,
    });
  });
  filtered.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  // 重叠/越界一律抛错，不悄悄挪边界（否则用户看到的边界和音频不一致）。
  checkSections(filtered, input.durationMs);

  const refined = inferEdges(filtered, lyrics, input.durationMs);
  const sections = withLines(recode(inferTypeCandidates(refined)), lyrics);

  const byIndex = new Map(sections.map((section) => [section.originIndex, section]));
  const relationCandidates = [];
  const seenPairs = new Set();
  for (const evidence of input.audioEvidence ?? []) {
    const left = byIndex.get(evidence?.left);
    const right = byIndex.get(evidence?.right);
    if (!left || !right || left.id === right.id) continue;
    if (!Number.isFinite(evidence.score) || evidence.score < RELATION_THRESHOLD || evidence.score > 1) continue;
    if (left.type !== right.type) continue;
    const [from, to] = left.startMs < right.startMs ? [right, left] : [left, right];
    const key = `${from.id}->${to.id}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    relationCandidates.push({
      from: from.id,
      to: to.id,
      score: Number(evidence.score.toFixed(4)),
      method: evidence.method || 'audio-feature-similarity',
      status: 'pending-confirmation',
      lyricMatch: Boolean(linesContent(to.lines)) && linesContent(to.lines) === linesContent(from.lines),
      note: '音频特征相似不等于旋律相同；必须听辨确认后才算重复',
    });
  }

  const mergeCandidates = [];
  for (const hint of input.mergeCandidates ?? []) {
    const left = byIndex.get(hint?.left);
    const right = byIndex.get(hint?.right);
    if (!left || !right || left.endMs !== right.startMs) continue;
    if (!Number.isFinite(hint.score) || hint.score < 0.7 || hint.score > 1) continue;
    mergeCandidates.push({
      leftId: left.id,
      rightId: right.id,
      score: Number(hint.score.toFixed(4)),
      status: 'pending-confirmation',
      note: '相邻段声学相近，可能是同一段被切碎；合并前请听辨',
    });
  }

  const unassigned = [];
  let cursor = 0;
  for (const section of sections) {
    if (section.startMs > cursor + 50) unassigned.push({ startMs: cursor, endMs: section.startMs });
    cursor = section.endMs;
  }
  if (cursor < input.durationMs - 50) unassigned.push({ startMs: cursor, endMs: input.durationMs });

  const warnings = [];
  if (unassigned.length) warnings.push('UNCOVERED_AUDIO_RANGES');
  if (sections.some((section) => section.type === 'unknown')) warnings.push('NEEDS_TYPE_CONFIRMATION');
  if (!sections.length) warnings.push('NO_SECTIONS');

  return {
    schema: MAP_SCHEMA,
    songId: String(input.songId ?? ''),
    durationMs: input.durationMs,
    provenance: input.provenance ?? null,
    status: sections.length ? 'draft' : 'insufficient-evidence',
    sections,
    relationCandidates,
    mergeCandidates,
    unassigned,
    warnings,
    lyrics,
  };
}

/**
 * 前奏/尾奏：只看「这一段有没有人唱」的音频区间，不看歌词内容，也不推断副歌。
 * 首段整体落在首句之前且够长 ⇒ 前奏；末段起点在最后一句之后且整体到尾 ⇒ 尾奏。
 */
function inferEdges(sections, lyrics, durationMs) {
  if (!sections.length || !lyrics.length) return sections;
  const firstLyricMs = lyrics[0].startMs;
  const lastLyricMs = lyrics[lyrics.length - 1].startMs;
  return sections.map((section, index) => {
    if (index === 0 && section.type === 'unknown'
      && section.endMs <= firstLyricMs && section.endMs - section.startMs >= INTRO_MIN_MS) {
      return { ...section, type: 'intro', evidence: 'no-lyrics-region' };
    }
    const isLast = index === sections.length - 1;
    if (isLast && section.type === 'unknown'
      && section.startMs >= lastLyricMs + OUTRO_GAP_MS && durationMs - section.startMs >= INTRO_MIN_MS) {
      return { ...section, type: 'outro', evidence: 'no-lyrics-region' };
    }
    return section;
  });
}

/**
 * 候选类型：同一声学簇重复出现时，平均音量最高的簇标「候选副歌」、次高标「候选主歌」。
 * 这只是提示（typeCandidate），不写正式 type；用户一键确认后才生效（SDD §2.1）。
 */
function inferTypeCandidates(sections) {
  const stats = new Map();
  for (const section of sections) {
    if (!section.clusterId) continue;
    const entry = stats.get(section.clusterId) ?? { count: 0, rmsSum: 0 };
    entry.count += 1;
    entry.rmsSum += Number.isFinite(section.rms) ? section.rms : 0;
    stats.set(section.clusterId, entry);
  }
  const ranked = [...stats.entries()]
    .filter(([, entry]) => entry.count >= 2)
    .sort((a, b) => (b[1].rmsSum / b[1].count) - (a[1].rmsSum / a[1].count));
  const candidates = new Map();
  ranked.forEach(([clusterId], index) => {
    if (index === 0) candidates.set(clusterId, 'chorus');
    else if (index === 1) candidates.set(clusterId, 'verse');
  });
  return sections.map((section) => (
    section.type === 'unknown' && section.clusterId && candidates.has(section.clusterId)
      ? { ...section, typeCandidate: candidates.get(section.clusterId), typeCandidateReason: '同一声学簇重复出现且音量偏高，待听辨确认' }
      : section
  ));
}

/**
 * 现有正式结构（人工或旧算法）→ 可编辑地图，供旧歌直接校正，不重写任何数据。
 * 旧数据里的失效关系（目标不存在 / 更晚 / 类型不同）只丢弃该关系，不阻断载入。
 */
export function fromP040Sections(sections, options = {}) {
  insist(Array.isArray(sections), 'INVALID_SECTIONS');
  const durationMs = options.durationMs;
  insist(Number.isInteger(durationMs) && durationMs > 0, 'INVALID_DURATION');
  // 旧正式结构没有 rapApproved 字段：仅在显式要求兼容时，按 source='manual' 沿用旧行为。
  // 应用草稿等新写入路径不得走兼容，否则「保存过结构」会被误当成「已确认 Rap」。
  const legacyRapFallback = options.legacyRapFallback === true;
  const normalized = sortSections(sections.map((section, index) => {
    const explicit = section.rapApproved !== undefined ? section.rapApproved : section.approvedRap;
    const source = section.source === 'algorithm' ? 'algorithm' : 'manual';
    const approvedRap = section.type === 'rap'
      ? explicit === true || (explicit === undefined && legacyRapFallback && source === 'manual')
      : false;
    return {
      id: String(section.id ?? `legacy-${index + 1}`),
      type: isSectionType(section.type) ? section.type : 'unknown',
      startMs: Math.round(section.startMs),
      endMs: Math.round(section.endMs),
      source,
      originIndex: null,
      clusterId: null,
      confidence: null,
      rms: null,
      approvedRap,
      ...(section.repeatOf ? { repeatOf: section.repeatOf } : {}),
      ...(section.repetition ? { repetition: section.repetition } : {}),
    };
  }));
  // 旧库可能存着目标已被删/类型已改的关系；载入时丢弃，不让一条坏关系挡住整张图。
  const byId = new Map(normalized.map((section) => [section.id, section]));
  for (const section of normalized) {
    if (!section.repeatOf) continue;
    const target = byId.get(section.repeatOf);
    if (!target || target.startMs >= section.startMs || target.type !== section.type) {
      delete section.repeatOf;
      delete section.repetition;
    }
  }
  checkSections(normalized, durationMs);
  const lyrics = toLyrics(options.lyrics ?? []);
  return {
    schema: MAP_SCHEMA,
    songId: String(options.songId ?? ''),
    durationMs,
    provenance: options.provenance ?? null,
    status: normalized.length ? 'draft' : 'insufficient-evidence',
    sections: withLines(recode(normalized), lyrics),
    relationCandidates: [],
    unassigned: [],
    warnings: [],
    lyrics,
  };
}

/** 在已有歌词句处拆分：不要求用户手输秒数。 */
export function splitAtLyric(map, id, lineId) {
  const index = findIndex(map, id);
  const section = map.sections[index];
  const line = (section.lines ?? []).find((item) => item.id === lineId);
  insist(Boolean(line), 'LYRIC_NOT_IN_SECTION');
  return splitAtTime(map, id, line.startMs);
}

/** 在指定时间拆分（播放位置也会用到）。两侧都必须 ≥ 500ms，且边距不小于 500ms。 */
export function splitAtTime(map, id, atMs) {
  const index = findIndex(map, id);
  const section = map.sections[index];
  const cut = Math.round(atMs);
  insist(Number.isFinite(cut), 'INVALID_SPLIT_TIME');
  insist(cut - section.startMs >= MIN_SECTION_MS && section.endMs - cut >= MIN_SECTION_MS, 'SPLIT_TOO_CLOSE_TO_EDGE');
  const first = resetRapApproval({ ...section, endMs: cut, source: 'manual', evidence: 'manual-split' });
  const second = resetRapApproval({
    ...section,
    id: `manual-${String(section.id).slice(0, 30)}-${cut}`,
    startMs: cut,
    source: 'manual',
    evidence: 'manual-split',
    repeatOf: undefined,
    repetition: undefined,
  });
  const next = [...map.sections];
  next.splice(index, 1, first, second);
  return rebuild(map, next);
}

/** 合并相邻两段；类型不同必须显式给 chosenType。 */
export function mergeAdjacent(map, leftId, rightId, chosenType) {
  const a = findIndex(map, leftId);
  const b = findIndex(map, rightId);
  insist(b === a + 1, 'NOT_ADJACENT');
  const left = map.sections[a];
  const right = map.sections[b];
  insist(left.endMs === right.startMs, 'NON_CONTIGUOUS_SECTIONS');
  insist(left.type === right.type || Boolean(chosenType), 'MIXED_TYPES_REQUIRES_CHOICE');
  const type = chosenType ?? left.type;
  insist(isSectionType(type), 'UNKNOWN_SECTION_TYPE');
  const merged = resetRapApproval({
    ...left,
    type,
    endMs: right.endMs,
    source: 'manual',
    evidence: 'manual-merge',
    repeatOf: undefined,
    repetition: undefined,
  });
  const next = [...map.sections];
  next.splice(a, 2, merged);
  // 指向被合并段的重复关系重绑到保留段；类型不兼容的旧关系直接清掉，绝不悬空。
  for (const section of next) {
    if (section.id === merged.id) continue;
    if ((section.repeatOf === left.id || section.repeatOf === right.id) && section.type !== type) {
      delete section.repeatOf;
      delete section.repetition;
      section.source = 'manual';
    } else if (section.repeatOf === right.id) {
      section.repeatOf = left.id;
      section.source = 'manual';
    }
  }
  return rebuild(map, next);
}

/** 改类型：清掉不再成立的重复关系与 Rap 确认状态。 */
export function changeType(map, id, type) {
  insist(isSectionType(type), 'UNKNOWN_SECTION_TYPE');
  const index = findIndex(map, id);
  const next = [...map.sections];
  next[index] = { ...next[index], type, source: 'manual', approvedRap: false, repeatOf: undefined, repetition: undefined };
  for (const section of next) {
    if (section.repeatOf === id && section.type !== type) {
      delete section.repeatOf;
      delete section.repetition;
      section.source = 'manual';
    }
  }
  return rebuild(map, next);
}

/**
 * 采纳「候选类型」：分析给的 typeCandidate 只是提示，必须用户点一下才变成正式类型。
 * 没有候选的段不做任何猜测。
 */
export function acceptTypeCandidate(map, id) {
  const index = findIndex(map, id);
  const section = map.sections[index];
  insist(section.type === 'unknown', 'SECTION_ALREADY_TYPED');
  insist(isSectionType(section.typeCandidate) && section.typeCandidate !== 'unknown', 'NO_TYPE_CANDIDATE');
  return changeType(map, id, section.typeCandidate);
}

/** 人工确认重复关系；「同词」必须先核对歌词文字确实一致。 */
export function confirmRelation(map, fromId, toId, relation) {
  insist(['exact-lyrics', 'same-melody-new-lyrics'].includes(relation), 'INVALID_RELATION');
  const from = findIndex(map, fromId);
  const to = findIndex(map, toId);
  insist(to < from, 'TARGET_MUST_BE_EARLIER');
  const a = map.sections[from];
  const b = map.sections[to];
  insist(a.type === b.type, 'TYPE_MISMATCH');
  if (relation === 'exact-lyrics') insist(linesContent(a.lines ?? []) && linesContent(a.lines ?? []) === linesContent(b.lines ?? []), 'LYRICS_NOT_IDENTICAL');
  const next = [...map.sections];
  next[from] = { ...next[from], repeatOf: toId, repetition: relation, source: 'manual' };
  // 该段（及同段）确认后，相关候选不再提示。
  return { ...rebuild(map, next), relationCandidates: (map.relationCandidates ?? []).filter((item) => item.from !== fromId) };
}

export function clearRelation(map, id) {
  const index = findIndex(map, id);
  const next = [...map.sections];
  next[index] = { ...next[index], source: 'manual' };
  delete next[index].repeatOf;
  delete next[index].repetition;
  return rebuild(map, next);
}

/** Rap 只有人工确认时间区间后才可跳过；未确认时一律不参与自动跳段。 */
export function approveRap(map, id) {
  const index = findIndex(map, id);
  insist(map.sections[index].type === 'rap', 'NOT_RAP');
  const next = [...map.sections];
  next[index] = { ...next[index], approvedRap: true, source: 'manual' };
  return rebuild(map, next);
}

export function revokeRap(map, id) {
  const index = findIndex(map, id);
  const next = [...map.sections];
  next[index] = { ...next[index], approvedRap: false };
  return rebuild(map, next);
}

export function approvedRapRanges(map) {
  return map.sections.filter((section) => section.type === 'rap' && section.approvedRap)
    .map((section) => ({ startMs: section.startMs, endMs: section.endMs }));
}

export function sectionSeekMs(map, id) {
  return map.sections[findIndex(map, id)].startMs;
}

export function sectionLoop(map, id) {
  const section = map.sections[findIndex(map, id)];
  return { startMs: section.startMs, endMs: section.endMs };
}

/** 当前播放位置所在段（半开区间）；不在任何段内返回 null。 */
export function sectionAtTime(map, timeMs) {
  if (!Number.isFinite(timeMs)) return null;
  return map.sections.find((section) => timeMs >= section.startMs && timeMs < section.endMs) ?? null;
}

export function sectionLines(map, id) {
  return map.sections[findIndex(map, id)].lines ?? [];
}

/** 导出既有 P040 结构字段。未显式 confirmed 一律拒绝，避免算法结果冒充用户确认。 */
export function toP040Sections(map, { confirmed = false } = {}) {
  insist(confirmed, 'CONFIRMATION_REQUIRED');
  checkSections(map.sections, map.durationMs);
  return map.sections.map((section) => ({
    id: section.id,
    type: section.type,
    label: section.code,
    startMs: section.startMs,
    endMs: section.endMs,
    source: 'manual',
    // 保存结构不等于确认 Rap：这里必须显式持久化每一段的确认状态。
    ...(section.type === 'rap' ? { rapApproved: section.approvedRap === true } : {}),
    ...(section.repeatOf ? { repeatOf: section.repeatOf } : {}),
    ...(section.repetition ? { repetition: section.repetition } : {}),
  }));
}

/** 给界面用的摘要：段数、待确认类型数、重复候选数、是否覆盖全曲。 */
export function mapSummary(map) {
  const sections = map?.sections ?? [];
  return {
    sections: sections.length,
    pendingTypes: sections.filter((section) => section.type === 'unknown').length,
    typeCandidates: sections.filter((section) => section.type === 'unknown' && section.typeCandidate).length,
    pendingRelations: (map?.relationCandidates ?? []).length,
    pendingMerges: (map?.mergeCandidates ?? []).length,
    uncovered: (map?.unassigned ?? []).length,
    needsReview: sections.some((section) => section.type === 'unknown'),
  };
}
