/**
 * 轻量歌词重复候选（P040 T5 / SDD 3.3）。
 *
 * 边界（刻意保守）：
 * - 只读取已有 LRC 的**文本行与时间行**，按整行归一化文本分组；
 * - 不推断旋律、不判断 Rap、不划分主歌/副歌，也不生成或改写 `sections`；
 * - 候选只是建议：`source` 固定为 `lrc-repeat`，`status` 为 `pending-confirmation`，
 *   `sectionType` 为 `unknown`，必须由人工确认；
 * - 所有时间取自 LRC 原时间戳，不插值、不补 endMs；没有可靠重复时返回空候选。
 *
 * 该模块是纯函数，不读写数据库，也不会覆盖任何手工段落。调用方若已有手工
 * `sections`，应保持原样，只把本模块结果当作只读提示展示。
 */
export const LYRIC_REPEAT_SCHEMA = 'p040.vocal-import.lyric-repeat.v1';
export const LYRIC_REPEAT_SOURCE = 'lrc-repeat';
export const LYRIC_REPEAT_STATUS = 'pending-confirmation';
export const LYRIC_REPEAT_UNKNOWN = 'unknown';

const MIN_TEXT_LENGTH = 2;
const MAX_CANDIDATES = 20;
const MAX_OCCURRENCES = 100;
const MAX_DISPLAY_CHARS = 200;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

/** 仅做保守归一：NFKC、去首尾空白、合并空白、大小写；不删标点，避免把不同歌词合并。 */
export function normalizeRepeatText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isReliableText(normalized) {
  return [...normalized].length >= MIN_TEXT_LENGTH && LETTER_OR_NUMBER.test(normalized);
}

function emptyResult(analyzedLines) {
  return {
    schema: LYRIC_REPEAT_SCHEMA,
    source: LYRIC_REPEAT_SOURCE,
    status: LYRIC_REPEAT_UNKNOWN,
    analyzedLines,
    candidates: [],
    note: '仅分析 LRC 文本与时间行；没有可靠的整行重复，候选为空，不推断旋律或段落。',
  };
}

/**
 * @param {ReadonlyArray<{startMs:number,text:string}>} timedLines
 *   `parseLrcText().timedLines`（已按时间升序）。无时间行时返回空候选。
 * @returns {{schema:string,source:string,status:string,analyzedLines:number,candidates:Array,note:string}}
 */
export function buildLyricRepeatSuggestions(timedLines) {
  const lines = Array.isArray(timedLines) ? timedLines : [];
  if (!lines.length) return emptyResult(0);

  const groups = new Map();
  let analyzedLines = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? {};
    const startMs = Number(line.startMs);
    if (!Number.isFinite(startMs) || startMs < 0) continue;
    const normalized = normalizeRepeatText(line.text);
    if (!isReliableText(normalized)) continue;
    analyzedLines += 1;
    if (!groups.has(normalized)) {
      groups.set(normalized, {
        text: String(line.text).trim().slice(0, MAX_DISPLAY_CHARS),
        occurrences: [],
      });
    }
    groups.get(normalized).occurrences.push({ startMs: Math.round(startMs), lineIndex: index });
  }

  const candidates = [];
  for (const group of groups.values()) {
    if (group.occurrences.length < 2) continue;
    const occurrences = group.occurrences.slice(0, MAX_OCCURRENCES);
    candidates.push({
      id: `lrc-repeat-${candidates.length + 1}`,
      kind: 'lyric-repeat',
      source: LYRIC_REPEAT_SOURCE,
      status: LYRIC_REPEAT_STATUS,
      sectionType: LYRIC_REPEAT_UNKNOWN,
      text: group.text,
      count: group.occurrences.length,
      occurrences,
      occurrencesTruncated: group.occurrences.length > occurrences.length,
    });
  }

  candidates.sort((a, b) =>
    b.count - a.count ||
    a.occurrences[0].startMs - b.occurrences[0].startMs ||
    a.text.localeCompare(b.text));

  const limited = candidates.slice(0, MAX_CANDIDATES).map((candidate, index) => ({
    ...candidate,
    id: `lrc-repeat-${index + 1}`,
  }));

  if (!limited.length) return emptyResult(analyzedLines);

  return {
    schema: LYRIC_REPEAT_SCHEMA,
    source: LYRIC_REPEAT_SOURCE,
    status: LYRIC_REPEAT_STATUS,
    analyzedLines,
    candidates: limited,
    note: '仅根据 LRC 文本与时间行统计重复整行；不推断旋律、Rap 或主副歌，也不覆盖手工段落，需人工确认。',
  };
}
