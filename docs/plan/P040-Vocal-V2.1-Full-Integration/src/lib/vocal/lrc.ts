import type { TimedLyric } from './model';

export interface LrcParseResult {
  lyrics: TimedLyric[];
  metadata: Record<string, string>;
  warnings: string[];
}
/** Standard [mm:ss.xx], [mm:ss.xxx] and repeated tags; metadata is not mistaken for lyrics. */
export function parseLrc(raw: string, durationMs?: number): LrcParseResult {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const metadata: Record<string, string> = {};
  const warnings: string[] = [];
  const timed: Array<{ startMs: number; text: string; sourceOrder: number }> = [];
  // The LRC offset applies to every timestamp, even if the tag is placed after lyrics.
  const offsetTag = [...text.matchAll(/^\[offset:([^\]]*)\]\s*$/gim)].at(-1);
  let offsetMs = 0;
  if (offsetTag) {
    const parsed = Number(offsetTag[1]);
    if (Number.isFinite(parsed)) offsetMs = parsed;
    else warnings.push('无效的 LRC offset 已忽略');
  }
  let sourceOrder = 0;
  for (const line of text.split('\n')) {
    const metadataMatch = line.match(/^\[([A-Za-z][\w-]*):([^\]]*)\]\s*$/);
    if (metadataMatch) {
      metadata[metadataMatch[1].toLowerCase()] = metadataMatch[2].trim();
      continue;
    }
    const tags = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const lyricText = line.replace(/\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g, '').trim();
    if (!lyricText) continue;
    for (const tag of tags) {
      const seconds = Number(tag[2]);
      if (seconds >= 60) { warnings.push('超出范围的 LRC 秒数已忽略'); continue; }
      const fraction = tag[3] ? Number(tag[3].padEnd(3, '0')) : 0;
      const ms = Math.max(0, Number(tag[1]) * 60000 + seconds * 1000 + fraction + offsetMs);
      if (durationMs !== undefined && ms >= durationMs) { warnings.push('超出音频时长的 LRC 句已忽略'); continue; }
      timed.push({ startMs: ms, text: lyricText, sourceOrder: sourceOrder++ });
    }
  }
  timed.sort((a, b) => a.startMs - b.startMs || a.sourceOrder - b.sourceOrder);
  // Different strings at exactly the same timestamp are ambiguous for line loops.
  const unique: typeof timed = [];
  for (const line of timed) {
    if (unique.at(-1)?.startMs === line.startMs) {
      if (unique.at(-1)?.text === line.text) continue;
      warnings.push('部分歌词拥有相同时间戳，请校准后使用按句循环');
      continue;
    }
    unique.push(line);
  }
  const lyrics = unique.map((line, index): TimedLyric => ({
    id: `lyric-${index + 1}`,
    startMs: line.startMs,
    text: line.text,
    ...(unique[index + 1] ? { endMs: unique[index + 1].startMs } : durationMs !== undefined ? { endMs: durationMs } : {}),
  }));
  if (!lyrics.length) warnings.push('没有可用的逐句时间戳，需要手工校准');
  return { lyrics, metadata, warnings: [...new Set(warnings)] };
}
export function lyricIndexAt(lyrics: TimedLyric[], positionMs: number): number {
  if (!lyrics.length) return -1;
  let left = 0, right = lyrics.length - 1, answer = -1;
  while (left <= right) {
    const mid = (left + right) >>> 1;
    if (lyrics[mid].startMs <= positionMs) { answer = mid; left = mid + 1; }
    else right = mid - 1;
  }
  return answer;
}
