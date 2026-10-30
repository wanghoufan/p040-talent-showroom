/**
 * 由 LRC 歌词推歌曲结构（只做可解释的推测，不猜旋律、不编造 Rap）。
 *
 * 判据只有三条：
 * 1. 第一句开唱之前 ≥ 4 秒 ⇒ 前奏；
 * 2. 同一句歌词在全曲出现 ≥ 2 次 ⇒ 该句所在段判为副歌（重复组）；
 * 3. 最后一句之后仍有 ≥ 5 秒 ⇒ 尾奏；中间连续同类的句子合并成一段，其余为主歌。
 *
 * 结果用于详情页的结构条与节目单的结构说明；用户可在结构编辑器里改。
 */

/** 低于这个长度的句子（"啊""Yeah"）不算有效重复，避免把口水句误判成副歌。 */
const MIN_REPEAT_KEY_LENGTH = 4;
const INTRO_MIN_MS = 4000;
const OUTRO_MIN_MS = 5000;
/** 最后一句没有结束时间，按这个长度估算它何时唱完。 */
const LAST_LINE_ESTIMATE_MS = 5000;
const MAX_SECTIONS = 40;

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

/**
 * @param {Array<{startMs:number,text:string}>} lyrics 歌词（按时间升序）
 * @param {number} durationMs 音频总时长
 * @returns {Array<{id:string,type:string,label:string,startMs:number,endMs:number,reason:string}>}
 */
export function buildSections(lyrics, durationMs) {
  const lines = (Array.isArray(lyrics) ? lyrics : [])
    .filter(line => line && Number.isFinite(line.startMs) && String(line.text ?? '').trim())
    .sort((a, b) => a.startMs - b.startMs);
  const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null;
  if (lines.length === 0) return [];

  const counts = new Map();
  for (const line of lines) {
    const key = normalize(line.text);
    if (key.length < MIN_REPEAT_KEY_LENGTH) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeated = new Set([...counts].filter(([, count]) => count >= 2).map(([key]) => key));

  const sections = [];
  const push = (type, label, startMs, endMs, reason) => {
    const start = Math.max(0, Math.round(startMs));
    const end = Math.round(endMs);
    if (end - start < 500) return;
    if (sections.length >= MAX_SECTIONS) return;
    sections.push({ id: `section-${sections.length + 1}`, type, label, startMs: start, endMs: end, reason });
  };

  const firstStart = lines[0].startMs;
  if (firstStart >= INTRO_MIN_MS) push('intro', '前奏', 0, firstStart, '开唱前留白');

  let cursor = firstStart;
  let current = null;
  for (const line of lines) {
    const key = normalize(line.text);
    const isChorus = repeated.has(key);
    const label = isChorus ? '副歌' : '主歌';
    if (!current || current.label !== label) {
      if (current) push(current.type, current.label, current.startMs, line.startMs, current.reason);
      current = {
        type: isChorus ? 'chorus' : 'verse',
        label,
        startMs: line.startMs,
        reason: isChorus ? '同一句歌词重复出现' : '非重复段落',
      };
    }
    cursor = line.startMs;
  }
  const lastLine = lines[lines.length - 1];
  const lastEnd = Math.min(duration ?? lastLine.startMs + LAST_LINE_ESTIMATE_MS, lastLine.startMs + LAST_LINE_ESTIMATE_MS);
  if (current) push(current.type, current.label, current.startMs, Math.max(lastEnd, current.startMs + 500), current.reason);
  if (duration && duration - lastEnd >= OUTRO_MIN_MS) push('outro', '尾奏', lastEnd, duration, '最后一句之后的留白');
  else if (duration && sections.length > 0) {
    // 音频在最后一句附近结束：把最后一段延伸到结尾，避免结构条留缺口。
    sections[sections.length - 1].endMs = Math.max(sections[sections.length - 1].endMs, Math.round(duration));
  }
  return sections;
}
