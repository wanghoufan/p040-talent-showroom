import { readFileSync } from 'node:fs';

/**
 * LRC 解析：只读、保留原文，不伪造时间戳。
 * 支持 UTF-8 BOM、`[mm:ss]` / `[mm:ss.xx]` / `[mm:ss.xxx]`、一行多标签、`[offset:]`。
 * 与计划包 Python `parse_lrc` 的字段一一对应，额外给出 `text` 供语言判定使用。
 */
// 与客户端 `src/lib/vocal.ts` 的 TIMESTAMP_SOURCE 保持同样的位数容忍度。
const TIME_PATTERN = /\[(\d{1,4}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_PATTERN = /^\[(ar|ti|al|offset|by|length):([^\]]*)\]\s*$/i;
const MAX_LINE_CHARS = 4000;

function fractionMs(digits) {
  if (!digits) return 0;
  if (digits.length === 3) return Number(digits);
  if (digits.length === 1) return Number(digits) * 100;
  return Number(digits) * 10;
}

export function parseLrcText(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '');
  const metadata = {};
  const timedLines = [];
  const plainLines = [];
  let invalidTags = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().slice(0, MAX_LINE_CHARS);
    if (!line) continue;
    const meta = META_PATTERN.exec(line);
    if (meta) {
      metadata[meta[1].toLowerCase()] = meta[2].trim();
      continue;
    }
    TIME_PATTERN.lastIndex = 0;
    const stamps = [...line.matchAll(TIME_PATTERN)];
    if (!stamps.length) {
      // 纯文本歌词保留；`[...]` 开头的未知标签视为无效标签，不伪装成歌词。
      if (!line.startsWith('[')) plainLines.push(line);
      else invalidTags += 1;
      continue;
    }
    const content = line.replace(TIME_PATTERN, '').trim();
    // 与客户端 `parseLrc` 一致：只有时间戳没有歌词的行不制造空句。
    if (!content) continue;
    for (const stamp of stamps) {
      const minute = Number(stamp[1]);
      const second = Number(stamp[2]);
      if (second > 59) {
        invalidTags += 1;
        continue;
      }
      timedLines.push({ startMs: (minute * 60 + second) * 1000 + fractionMs(stamp[3]), text: content });
    }
  }

  let offset = 0;
  if (metadata.offset !== undefined) {
    const parsed = Number.parseInt(metadata.offset, 10);
    if (Number.isInteger(parsed)) offset = parsed;
    else invalidTags += 1;
  }
  if (offset !== 0) {
    // LRC 惯例：正 offset 让歌词提前。必须与 `src/lib/vocal.ts` 的
    // `startMs = rawMs - offsetMs` 保持同一方向，否则服务端入库歌词与手机端会错位。
    for (const line of timedLines) line.startMs = Math.max(0, line.startMs - offset);
  }
  timedLines.sort((a, b) => a.startMs - b.startMs);

  return {
    metadata,
    timedLines,
    plainLines,
    invalidTags,
    hasTiming: timedLines.length > 0,
    maxStartMs: timedLines.length ? timedLines[timedLines.length - 1].startMs : null,
    text: [...timedLines.map(line => line.text), ...plainLines].join('\n').slice(0, 20000),
  };
}

export function parseLrcFile(path) {
  return parseLrcText(readFileSync(path, 'utf8'));
}

/** `[length:03:12]` 之类的声明时长，仅供交叉核验，不作为播放时长。 */
export function declaredLengthMs(metadata = {}) {
  const length = metadata.length;
  if (!length) return null;
  const match = /^(\d{1,3}):(\d{1,2})$/.exec(length.trim());
  return match ? (Number(match[1]) * 60 + Number(match[2])) * 1000 : null;
}
