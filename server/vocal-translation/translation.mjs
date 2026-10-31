import { createHash } from 'node:crypto';

/**
 * 歌词中文译文的纯规则层。
 *
 * 三条硬约束（与客户端 src/lib/vocal/translation.ts 同口径）：
 * 1. 原译分离：原文只留在 lyrics_json，译文只写 translations_json，绝不把中文行混进原文。
 * 2. 稳定关联：译文按歌词行 `id` 绑定，不按数组下标；原文时间轴一个字节都不改。
 * 3. 人工优先：manual 译文永远不被 lrc / ai 覆盖；ai 只填空或刷新 ai 自己产出的行。
 */
export const TRANSLATION_VERSION = 1;
export const TRANSLATION_LANGUAGE = 'zh';
export const TRANSLATION_SOURCES = Object.freeze(['lrc', 'ai', 'manual']);
export const TARGET_LANGUAGE = 'zh';
export const MAX_TRANSLATION_CHARS = 500;
export const MAX_TRANSLATION_LINES = 1000;

const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const LATIN = /[A-Za-z]/g;

export function textHash(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 32);
}

/**
 * 制作署名与段落标记不是歌词：LRC 里常见 `Chorus：김보아`、`All Programming by：…`、
 * `Recording Engineer：…`、`[Verse 1]`。旧逻辑把它们当歌词送翻译，得到「副歌：김보아」
 * 这种把「谁唱」译成「第几段」的结果（2026-10-31 审校 H5/M1/M2）。
 */
const SECTION_MARKER = /^[\s[(（【]*((intro|verse|pre[- ]?chorus|chorus|hook|refrain|bridge|interlude|instrumental|outro|rap|dance break)\s*\d{0,2})[\s\]）)】]*[:：]?\s*$/i;
const CREDIT_LINE = /^([A-Za-z][A-Za-z0-9 .&'’\-]{0,32})\s*[:：]\s*(\S.{0,39})$/;
const CREDIT_ROLES = [
  /^(?:all\s+)?programming(?:\s+by)?$/i,
  /^(?:recording|mixing|mastering)(?:\s+engineer)?$/i,
  /^(?:produced|composed|arranged|written|mixed|mastered|engineered|directed)\s+by$/i,
  /^(?:producer|composer|lyricist|arranger|conductor)$/i,
  /^(?:vocal|vocals|background\s+vocals?|chorus|rap|hook)$/i,
  /^(?:guitar|bass|drums?|keyboard|keyboards|synthesizer|synth|strings|piano|percussion)$/i,
  /^(?:digital\s+editing|edited\s+by|director|artwork|photography|hair|makeup|stylist|music\s+video)$/i,
];

export function isNonLyricLine(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  if (SECTION_MARKER.test(value)) return true;
  const match = value.match(CREDIT_LINE);
  if (!match) return false;
  // 角色词里出现韩文/日文假名说明这是歌词正文，不是署名。
  if (HANGUL.test(match[1]) || /[\u3040-\u30ff]/.test(match[1])) return false;
  return CREDIT_ROLES.some(role => role.test(match[1].trim()));
}

/** 中文行判定：有汉字、无韩文，且汉字数不少于拉丁字母数（避免把英文夹一个汉字当译文）。 */
export function isChineseText(text) {
  const value = String(text ?? '');
  if (!value.trim() || HANGUL.test(value)) return false;
  const han = value.match(HAN)?.length ?? 0;
  const latin = value.match(LATIN)?.length ?? 0;
  return han > 0 && han >= latin;
}

/**
 * 从「已带 id 的歌词行」里找出相邻的中文译文行（老双语 LRC 已入库的情形）。
 * 只做关联，不删除任何行、不改时间轴；返回 originalId -> {text, sourceId}。
 * 匹配优先级：开始时间完全相同 → 时间差 ≤ 1000ms 且行距 ≤ 3 → 不匹配。
 */
export function associateExistingTranslations(lyrics, language) {
  if (!Array.isArray(lyrics) || !lyrics.length || language === 'zh') return [];
  const chinese = [];
  for (let index = 0; index < lyrics.length; index += 1) {
    const line = lyrics[index];
    if (line && typeof line.text === 'string' && isChineseText(line.text)) {
      chinese.push({ index, line });
    }
  }
  if (!chinese.length) return [];

  const used = new Set();
  const result = [];
  for (let index = 0; index < lyrics.length; index += 1) {
    const line = lyrics[index];
    if (!line || typeof line.text !== 'string' || !line.text.trim() || isChineseText(line.text)) continue;
    let best = null;
    for (const candidate of chinese) {
      if (used.has(candidate.index)) continue;
      const distance = Math.abs(candidate.index - index);
      if (distance === 0 || distance > 3) continue;
      const delta = Math.abs(Number(candidate.line.startMs) - Number(line.startMs));
      if (!Number.isFinite(delta) || delta > 1000) continue;
      const sameTime = delta === 0;
      if (!best || (sameTime && !best.sameTime) || (sameTime === best.sameTime && delta < best.delta)
        || (sameTime === best.sameTime && delta === best.delta && distance < best.distance)) {
        best = { ...candidate, delta, sameTime, distance };
      }
    }
    if (!best) continue;
    used.add(best.index);
    result.push({ id: line.id, text: best.line.text.trim().slice(0, MAX_TRANSLATION_CHARS), sourceLineId: best.line.id });
  }
  return result;
}

/**
 * LRC 初次导入时的双语拆行：把中文译文行从「原唱行」里拿走，时间轴保留原唱行。
 * entries: [{ startMs, text }]（按时间升序，来自 parseLrcText）。
 * 返回 { lines, translations }，translations[i] 对应 lines[i] 的译文。
 */
export function splitBilingualLrc(entries, language) {
  const rows = Array.isArray(entries) ? entries.filter(entry => entry && String(entry.text ?? '').trim()) : [];
  if (!rows.length || language === 'zh') return { lines: rows, translations: [] };

  const isTranslation = rows.map(row => isChineseText(row.text));
  if (!isTranslation.some(Boolean)) return { lines: rows, translations: [] };

  const paired = new Map();
  const used = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    if (isTranslation[index]) continue;
    let best = null;
    for (let other = 0; other < rows.length; other += 1) {
      if (!isTranslation[other] || used.has(other)) continue;
      const distance = Math.abs(other - index);
      if (distance === 0 || distance > 3) continue;
      const delta = Math.abs(Number(rows[other].startMs) - Number(rows[index].startMs));
      if (!Number.isFinite(delta) || delta > 1000) continue;
      const sameTime = delta === 0;
      if (!best || (sameTime && !best.sameTime) || (sameTime === best.sameTime && delta < best.delta)
        || (sameTime === best.sameTime && delta === best.delta && distance < best.distance)) {
        best = { other, delta, sameTime, distance };
      }
    }
    if (!best) continue;
    used.add(best.other);
    paired.set(index, rows[best.other].text.trim().slice(0, MAX_TRANSLATION_CHARS));
  }

  const lines = [];
  const translations = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (used.has(index)) continue;
    lines.push(rows[index]);
    translations.push(paired.get(index) ?? null);
  }
  return { lines, translations };
}

/**
 * 归一化译文文档：只保留仍存在于歌词里的行，按歌词顺序排列。
 * 输入形状 { lines: [{id,text,source,sourceHash}] } 或直接数组（兼容旧调用）。
 */
export function normalizeTranslations(input, lyrics) {
  const empty = { version: TRANSLATION_VERSION, language: TRANSLATION_LANGUAGE, lines: [] };
  if (!input || typeof input !== 'object') return empty;
  const rawLines = Array.isArray(input) ? input : input.lines;
  if (!Array.isArray(rawLines)) return empty;
  if (rawLines.length > MAX_TRANSLATION_LINES) throw new Error('INVALID_TRANSLATIONS');

  const lyricList = Array.isArray(lyrics) ? lyrics : [];
  const lyricById = new Map(lyricList.map(line => [line.id, line]));
  const seen = new Set();
  const byId = new Map();
  for (const raw of rawLines) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_TRANSLATIONS');
    const id = typeof raw.id === 'string' ? raw.id : '';
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!id || !text || text.length > MAX_TRANSLATION_CHARS || !lyricById.has(id)) continue;
    if (seen.has(id)) throw new Error('INVALID_TRANSLATIONS');
    seen.add(id);
    const source = TRANSLATION_SOURCES.includes(raw.source) ? raw.source : 'ai';
    const sourceHash = typeof raw.sourceHash === 'string' && /^[0-9a-f]{32}$/.test(raw.sourceHash)
      ? raw.sourceHash : textHash(lyricById.get(id).text);
    byId.set(id, { id, text, source, sourceHash });
  }
  const lines = lyricList.filter(line => byId.has(line.id)).map(line => byId.get(line.id));
  return { version: TRANSLATION_VERSION, language: TRANSLATION_LANGUAGE, lines };
}

/** 文档级别的来源汇总，用于界面说明「人工/歌词自带/AI」。 */
export function translationSourceOf(lines) {
  const sources = new Set((lines || []).map(line => line.source));
  if (!sources.size) return 'none';
  if (sources.size === 1) return [...sources][0];
  return 'mixed';
}

/**
 * 合并译文。不可覆盖规则集中在服务端一处，任何调用方（AI、导入、人工）都过这里：
 * - manual 覆盖一切；
 * - lrc 覆盖 ai，但不覆盖 manual；
 * - ai 只填空或刷新 ai 自己，不碰 manual / lrc。
 */
export function mergeTranslations(existingLines, incomingLines) {
  const merged = new Map();
  for (const line of existingLines || []) {
    if (line && line.id) merged.set(line.id, { ...line });
  }
  for (const line of incomingLines || []) {
    if (!line || !line.id || !line.text) continue;
    const current = merged.get(line.id);
    if (!current) { merged.set(line.id, { ...line }); continue; }
    const incoming = line.source || 'ai';
    const present = current.source || 'ai';
    if (incoming === 'manual') { merged.set(line.id, { ...line }); continue; }
    if (incoming === 'lrc' && present !== 'manual') { merged.set(line.id, { ...line }); continue; }
    if (incoming === 'ai' && present === 'ai') { merged.set(line.id, { ...line }); }
  }
  return [...merged.values()];
}

/** 缺译文的歌词行（只按 id 判断，不看旧双语行，调用方先做 associate）。 */
export function missingTranslationLines(lyrics, translationLines, excludeIds = null) {
  const known = new Set((translationLines || []).map(line => line.id));
  return (lyrics || []).filter(line => line && line.text && line.text.trim() && !known.has(line.id) && !excludeIds?.has(line.id));
}

/**
 * 真正需要翻译的原文行：空行不算；非中文歌里本身就是中文的行（老双语 LRC 残留、
 * 或「（副歌）」这类中文提示）不算——它们已经是中文，再送去翻译只会拿到垃圾结果，
 * 也会让「还差几句」永远清不掉；制作署名与段落标记同理不算（它们不是歌词）。
 */
export function translatableLines(lyrics, language) {
  const excludeChinese = Boolean(language) && language !== 'zh';
  return (lyrics || []).filter(line => (
    line && typeof line.text === 'string' && line.text.trim()
    && !isNonLyricLine(line.text)
    && !(excludeChinese && isChineseText(line.text))
  ));
}

/** 读时计算「原文已改」，不落库，避免把派生状态写进数据。 */
export function withStaleness(lines, lyrics) {
  const lyricById = new Map((lyrics || []).map(line => [line.id, line]));
  return (lines || []).map(line => {
    const lyric = lyricById.get(line.id);
    return lyric && line.sourceHash && line.sourceHash !== textHash(lyric.text) ? { ...line, stale: true } : { ...line };
  });
}
