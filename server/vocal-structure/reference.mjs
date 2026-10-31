/**
 * 参考结构草稿（P040 V3.3 结构参考最小闭环）。
 *
 * 边界（用户 2026-10-31 口径）：
 * - 参考标签只是**待确认草稿**，永远不直接写正式结构；只有用户显式保存才落 `source='manual'`；
 * - 结构参考必须先过身份核验：歌手、歌名、版本、时长、原音频 SHA 任一不符即拒绝，
 *   同名不同歌（石玺彤《Let Go》 vs BTS《Let Go》）绝不进入候选；
 * - 段首时间只用**用户自己的 LRC 行**做锚点，锚不上就保留原始秒数并标 `snapped:false`；
 * - 两个来源写法不一致的类型保留 `unknown` + `disputed`，不静默定型，也不自动建立重复关系；
 * - 不接收、不存储第三方歌词正文：载荷里出现 lyric/text/line 字段或超长字符串一律拒绝。
 *
 * 纯函数：不读文件、不联网、不写库。
 */

export const REFERENCE_SCHEMA = 'p040.structure-reference.v1';

const SECTION_TYPES = Object.freeze(['intro', 'verse', 'pre', 'chorus', 'bridge', 'rap', 'outro', 'unknown']);
const MIN_SECTION_MS = 500;
/** LRC 锚点容差：超过这个距离就认为参考秒数和歌词对不上，不硬吸。 */
const SNAP_WINDOW_MS = 1500;
/** 首个候选离 0 秒这么近时直接贴到 0，避免造一个无意义的碎片前奏。 */
const HEAD_FILL_MS = 2000;
const MAX_CANDIDATES = 200;
const MAX_TEXT = 200;

function insist(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

function text(value, max = MAX_TEXT) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function norm(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 版本词表：只比对「明确写出来的版本标记」，没写就不猜。 */
const VERSION_TOKENS = [
  ['live', /(^|[^\p{L}])live([^\p{L}]|$)|现场/iu],
  ['remix', /remix|混音版|重混/iu],
  ['acoustic', /acoustic|不插电/iu],
  ['instrumental', /instrumental|(^|[^\p{L}])inst([^\p{L}]|$)|伴奏版/iu],
  ['cover', /cover|翻唱|翻自/iu],
  ['demo', /(^|[^\p{L}])demo([^\p{L}]|$)/iu],
];

function versionTokens(...values) {
  const found = new Set();
  for (const value of values) {
    const current = String(value ?? '');
    if (!current) continue;
    for (const [token, pattern] of VERSION_TOKENS) if (pattern.test(current)) found.add(token);
  }
  return [...found].sort();
}

/**
 * 递归拒绝歌词正文载荷。
 * 参考文件只允许「结构类型 + 秒数 + 标签」，任何 lyric/line/text 字段或超长字符串都当作越界内容。
 */
function assertNoLyricPayload(value, depth = 0, path = '') {
  if (depth > 6) insist(false, 'REFERENCE_SCHEMA_INVALID');
  if (typeof value === 'string') {
    insist(value.length <= MAX_TEXT, 'REFERENCE_LYRIC_PAYLOAD');
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    insist(!/lyric|transcript|^texts?$|^lines?$|words|_text$|text_/i.test(key), 'REFERENCE_LYRIC_PAYLOAD');
    assertNoLyricPayload(child, depth + 1, `${path}.${key}`);
  }
}

/** 校验并归一化参考文件；schema 必须显式声明，避免把随便一段 JSON 当成参考。 */
export function normalizeReference(raw) {
  insist(raw && typeof raw === 'object' && !Array.isArray(raw), 'REFERENCE_SCHEMA_INVALID');
  insist(raw.schema === REFERENCE_SCHEMA, 'REFERENCE_SCHEMA_INVALID');
  assertNoLyricPayload(raw);

  const songTitle = text(raw.songTitle);
  const artist = text(raw.artist);
  insist(songTitle, 'REFERENCE_TITLE_REQUIRED');
  insist(artist, 'REFERENCE_ARTIST_REQUIRED');

  const durationMs = Number.isInteger(raw.audioDurationMs ?? raw.durationMs) ? (raw.audioDurationMs ?? raw.durationMs) : null;
  insist(Number.isInteger(durationMs) && durationMs > 0, 'REFERENCE_DURATION_REQUIRED');

  const audioSha256 = String(raw.audioSha256 ?? '').toLowerCase();
  insist(/^[0-9a-f]{64}$/.test(audioSha256), 'REFERENCE_AUDIO_SHA_REQUIRED');

  const candidates = raw.candidates;
  insist(Array.isArray(candidates) && candidates.length > 0, 'REFERENCE_EMPTY');
  insist(candidates.length <= MAX_CANDIDATES, 'REFERENCE_TOO_MANY_CANDIDATES');

  const normalized = candidates.map((candidate, index) => {
    insist(candidate && typeof candidate === 'object' && !Array.isArray(candidate), 'REFERENCE_CANDIDATE_INVALID');
    const timeMs = Number(candidate.timeMs);
    insist(Number.isFinite(timeMs) && timeMs >= 0 && timeMs <= durationMs, `REFERENCE_CANDIDATE_RANGE:${index + 1}`);
    const declared = String(candidate.type ?? 'unknown');
    const type = SECTION_TYPES.includes(declared) ? declared : 'unknown';
    const alternates = Array.isArray(candidate.alternates)
      ? candidate.alternates.map((item) => text(item, 24)).filter(Boolean).slice(0, 4)
      : [];
    return {
      index,
      timeMs: Math.round(timeMs),
      type,
      label: text(candidate.label, 40) || '',
      alternates,
      disputed: candidate.disputed === true || alternates.length > 0,
      note: text(candidate.note, 120),
      repeatCandidateOf: text(candidate.repeatCandidateOf, 40) || null,
    };
  }).sort((a, b) => a.timeMs - b.timeMs || a.index - b.index);

  return {
    schema: REFERENCE_SCHEMA,
    songTitle,
    artist,
    artistAliases: Array.isArray(raw.artistAliases) ? raw.artistAliases.map((item) => text(item, 80)).filter(Boolean) : [],
    titleAliases: Array.isArray(raw.titleAliases) ? raw.titleAliases.map((item) => text(item, 120)).filter(Boolean) : [],
    version: text(raw.version, 40),
    audioDurationMs: durationMs,
    audioSha256,
    source: text(raw.source, 120),
    note: text(raw.note, 300),
    candidates: normalized,
  };
}

function splitArtists(value) {
  return String(value ?? '')
    .split(/[,，/&、;；]|\bfeat\.?\b|\bft\.?\b/iu)
    .map((part) => norm(part))
    .filter(Boolean);
}

/**
 * 身份核验。任何一项不过都 `ok=false`，由调用方拒绝载入；不做「大体相似就放行」。
 * @returns {{ok:boolean, checks:Array<{id:string,ok:boolean,expected:string,actual:string}>, blockers:Array<{code:string,detail:string}>}}
 */
export function verifyIdentity({ reference, item, audioSha256 } = {}) {
  const checks = [];
  const blockers = [];
  const record = (id, ok, expected, actual, code) => {
    checks.push({ id, ok, expected: String(expected ?? ''), actual: String(actual ?? '') });
    if (!ok) blockers.push({ code, detail: `${id}: 参考=${expected ?? '未提供'} / 本地=${actual ?? '未提供'}` });
  };

  const localTitle = text(item?.title);
  const titleOk = [localTitle, ...(reference.titleAliases ?? [])].some((candidate) => norm(candidate) === norm(reference.songTitle));
  record('title', titleOk, reference.songTitle, localTitle, 'IDENTITY_TITLE_MISMATCH');

  const localArtists = splitArtists(item?.artist);
  const referenceArtists = new Set([norm(reference.artist), ...(reference.artistAliases ?? []).map(norm)].filter(Boolean));
  const artistOk = localArtists.some((name) => referenceArtists.has(name));
  record('artist', artistOk, [reference.artist, ...(reference.artistAliases ?? [])].join(' / '), item?.artist,
    'IDENTITY_ARTIST_MISMATCH');

  // 版本标记必须一致：本地是 Live、参考没写 Live（或反过来）都不能算同一份录音。
  const localVersion = versionTokens(item?.title, item?.notes);
  const referenceVersion = versionTokens(reference.songTitle, reference.version);
  const versionOk = localVersion.join(',') === referenceVersion.join(',');
  record('version', versionOk, referenceVersion.join(',') || '(无版本标记)', localVersion.join(',') || '(无版本标记)',
    'IDENTITY_VERSION_MISMATCH');

  const localDuration = Number(item?.durationMs) || 0;
  const tolerance = Math.max(2000, Math.round(reference.audioDurationMs * 0.01));
  const durationOk = localDuration > 0 && Math.abs(localDuration - reference.audioDurationMs) <= tolerance;
  record('duration', durationOk, `${reference.audioDurationMs}ms ±${tolerance}`, `${localDuration}ms`, 'IDENTITY_DURATION_MISMATCH');

  const localSha = String(audioSha256 ?? '').toLowerCase();
  const shaOk = /^[0-9a-f]{64}$/.test(localSha) && localSha === reference.audioSha256;
  record('audioSha256', shaOk, reference.audioSha256, localSha || '未取到', 'IDENTITY_AUDIO_SHA_MISMATCH');

  return { ok: blockers.length === 0, checks, blockers, verifiedAt: new Date().toISOString() };
}

/** 用用户自己的 LRC 行做锚点；超出容差就不吸，返回 null。 */
export function snapToLyrics(timeMs, lyrics, windowMs = SNAP_WINDOW_MS) {
  let best = null;
  for (const line of lyrics ?? []) {
    if (!Number.isFinite(line?.startMs)) continue;
    const delta = Math.abs(line.startMs - timeMs);
    if (delta > windowMs) continue;
    if (!best || delta < Math.abs(best.deltaMs)) best = { lineId: line.id, startMs: line.startMs, deltaMs: line.startMs - timeMs };
  }
  return best;
}

const FAMILY = Object.freeze({ verse: 'A', chorus: 'B', pre: 'P', bridge: 'C', rap: 'R' });
const TYPE_TEXT = Object.freeze({
  intro: '前奏', verse: '主歌', pre: '预副歌', chorus: '副歌', bridge: '桥段', rap: 'Rap', outro: '尾奏', unknown: '待标注',
});

/** 与 structure-map.mjs 的 recode 同一套编号规则，但保留参考标签作为 referenceLabel。 */
function recode(sections) {
  const counts = new Map();
  let unknownCount = 0;
  return sections.map((section) => {
    const family = FAMILY[section.type];
    let code;
    if (family) {
      const next = (counts.get(family) ?? 0) + 1;
      counts.set(family, next);
      code = `${family}${next}`;
    } else if (section.type === 'intro' || section.type === 'outro') {
      code = TYPE_TEXT[section.type];
    } else {
      code = `U${++unknownCount}`;
    }
    return { ...section, code, label: code, typeLabel: TYPE_TEXT[section.type] };
  });
}

/**
 * 参考候选 → 可编辑草稿段（不是正式结构）。
 * 只负责切分、锚定、标注争议；不判断类型对错，也不建立重复关系。
 */
export function buildReferenceSections({ reference, durationMs, lyrics = [] } = {}) {
  insist(Number.isInteger(durationMs) && durationMs > 0, 'INVALID_DURATION');
  const warnings = [];
  const kept = [];
  for (const candidate of reference.candidates) {
    // 0 秒不是「歌词锚点」，是文件起点本身；不要因此报「没锚上」。
    const anchor = candidate.timeMs === 0
      ? { lineId: null, startMs: 0, deltaMs: 0, fileStart: true }
      : snapToLyrics(candidate.timeMs, lyrics);
    const startMs = anchor ? anchor.startMs : candidate.timeMs;
    if (startMs >= durationMs) {
      warnings.push(`CANDIDATE_OUT_OF_RANGE:${candidate.index + 1}`);
      continue;
    }
    const previous = kept[kept.length - 1];
    if (previous && startMs - previous.startMs < MIN_SECTION_MS) {
      warnings.push(`CANDIDATE_TOO_CLOSE:${candidate.index + 1}`);
      continue;
    }
    kept.push({ candidate, startMs, anchor });
  }
  insist(kept.length > 0, 'REFERENCE_NO_USABLE_CANDIDATE');

  const sections = [];
  let index = 0;
  if (kept[0].startMs > 0) {
    if (kept[0].startMs <= HEAD_FILL_MS) {
      kept[0].startMs = 0;
    } else {
      // 参考没写前奏但首段不在 0 秒：留一个未标注的头段，不替参考编前奏。
      sections.push({
        id: 'ref-head',
        type: 'unknown',
        startMs: 0,
        endMs: kept[0].startMs,
        source: 'reference',
        referenceLabel: '未标注开头',
        referenceIndex: null,
        anchor: null,
        disputed: false,
        alternates: [],
      });
      warnings.push('REFERENCE_HEAD_UNLABELED');
    }
  }

  kept.forEach((entry, position) => {
    const next = kept[position + 1];
    const endMs = next ? next.startMs : durationMs;
    const last = !next;
    const type = entry.candidate.type;
    sections.push({
      id: `ref-${index + 1}`,
      type,
      startMs: entry.startMs,
      endMs,
      source: 'reference',
      referenceLabel: entry.candidate.label || TYPE_TEXT[type],
      referenceIndex: entry.candidate.index,
      anchor: entry.anchor
        ? { lineId: entry.anchor.lineId, deltaMs: Math.round(entry.anchor.deltaMs), snapped: true }
        : { lineId: null, deltaMs: 0, snapped: false },
      disputed: entry.candidate.disputed || type === 'unknown',
      alternates: entry.candidate.alternates,
      repeatCandidateOf: entry.candidate.repeatCandidateOf,
      // 末段结束时间只能落到音频总长，不能声称「尾奏在 X 秒结束」。
      ...(last ? { endUnverified: true } : {}),
    });
    index += 1;
  });

  if (sections.some((section) => section.disputed)) warnings.push('REFERENCE_DISPUTED_TYPES');
  if (sections.some((section) => section.anchor && !section.anchor.snapped)) warnings.push('REFERENCE_UNSNAPPED_BOUNDARIES');

  // 末尾候选离曲尾太近：丢掉这一小片，把上一段延到结尾，不留 0.x 秒的非法段。
  const tail = sections[sections.length - 1];
  if (tail && sections.length > 1 && tail.endMs - tail.startMs < MIN_SECTION_MS) {
    sections.pop();
    sections[sections.length - 1].endMs = tail.endMs;
    sections[sections.length - 1].endUnverified = true;
    warnings.push('REFERENCE_TAIL_TOO_CLOSE');
  }

  return { sections: recode(sections), warnings };
}

/**
 * 把参考草稿挂到地图上：只改草稿地图，不碰正式结构。
 * `analysisSections` 保留载入前的段落，用户放弃参考时可以退回。
 */
export function applyReferenceToMap({ map, reference, identity, durationMs, lyrics = [] } = {}) {
  insist(identity?.ok === true, 'IDENTITY_NOT_VERIFIED');
  const built = buildReferenceSections({ reference, durationMs, lyrics });
  const candidates = built.sections.map((section) => ({
    code: section.code,
    type: section.type,
    typeLabel: section.typeLabel,
    startMs: section.startMs,
    endMs: section.endMs,
    referenceLabel: section.referenceLabel,
    anchor: section.anchor,
    disputed: section.disputed,
    alternates: section.alternates ?? [],
    repeatCandidateOf: section.repeatCandidateOf ?? null,
    ...(section.endUnverified ? { endUnverified: true } : {}),
  }));
  return {
    map: {
      ...map,
      schema: map.schema ?? 'p040.song-map.v1',
      songId: map.songId ?? '',
      durationMs: Number.isInteger(map.durationMs) && map.durationMs > 0 ? map.durationMs : durationMs,
      sections: built.sections,
      // 参考草稿不继承音频相似候选：那是另一份证据，混在一起会让人以为已经确认。
      relationCandidates: [],
      mergeCandidates: [],
      unassigned: [],
      status: 'draft',
      warnings: [...new Set([...(map.warnings ?? []).filter((item) => item !== 'NO_SECTIONS'), ...built.warnings])],
      lyrics: map.lyrics ?? [],
    },
    reference: {
      schema: reference.schema,
      songTitle: reference.songTitle,
      artist: reference.artist,
      version: reference.version,
      source: reference.source,
      note: reference.note,
      audioSha256: reference.audioSha256,
      audioDurationMs: reference.audioDurationMs,
      status: 'DRAFT_REVIEW_REQUIRED',
      identity,
      candidateCount: candidates.length,
      disputedCount: candidates.filter((candidate) => candidate.disputed).length,
      unsnappedCount: candidates.filter((candidate) => candidate.anchor && !candidate.anchor.snapped).length,
      loadedAt: new Date().toISOString(),
      warnings: built.warnings,
      sections: candidates,
    },
  };
}

/** 撤销参考草稿：恢复载入前的段落；没有快照时给出空地图而不是编一段。 */
export function detachReference(map) {
  const previous = Array.isArray(map?.analysisSections) ? map.analysisSections : [];
  return {
    ...map,
    sections: previous,
    status: previous.length ? 'draft' : 'insufficient-evidence',
    warnings: previous.length ? (map.warnings ?? []).filter((item) => !item.startsWith('REFERENCE_')) : ['NO_SECTIONS'],
    analysisSections: undefined,
  };
}
