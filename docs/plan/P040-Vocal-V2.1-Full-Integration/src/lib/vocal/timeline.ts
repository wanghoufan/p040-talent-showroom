import type { TimedLyric, VocalSection } from './model';

export interface TimeRange { startMs: number; endMs: number; }
function validRange(r: TimeRange, durationMs: number): boolean {
  return Number.isFinite(r.startMs) && Number.isFinite(r.endMs) && r.startMs >= 0 && r.endMs <= durationMs && r.startMs < r.endMs;
}
export function validateSections(sections: VocalSection[], durationMs: number): string[] {
  const errors: string[] = [];
  for (const s of sections) if (!validRange(s, durationMs)) errors.push(`段落 ${s.id} 时间越界或无效`);
  const ids = new Set<string>();
  for (const s of sections) {
    if (ids.has(s.id)) errors.push(`段落 id 重复: ${s.id}`);
    ids.add(s.id);
  }
  for (const s of sections) if (s.repeatOf && !ids.has(s.repeatOf)) errors.push(`重复引用不存在: ${s.repeatOf}`);
  return errors;
}
/** Rap ranges are half-open and merged; seeking at the end never re-triggers the same skip. */
export function rapRanges(sections: VocalSection[], durationMs: number): TimeRange[] {
  const sorted = sections.filter(s => s.type === 'rap' && validRange(s, durationMs))
    .map(s => ({startMs:s.startMs,endMs:s.endMs})).sort((a,b)=>a.startMs-b.startMs);
  const merged: TimeRange[] = [];
  for (const range of sorted) {
    const prev = merged.at(-1);
    if (prev && range.startMs <= prev.endMs) prev.endMs = Math.max(prev.endMs, range.endMs);
    else merged.push({...range});
  }
  return merged;
}
export function skipRapTarget(positionMs: number, sections: VocalSection[], durationMs: number): number | null {
  if (!Number.isFinite(positionMs)) return null;
  for (const r of rapRanges(sections, durationMs))
    if (positionMs >= r.startMs && positionMs < r.endMs) return r.endMs;
  return null;
}
export function lyricRepeatRange(lyrics: TimedLyric[], selectedIndex: number, count: number, durationMs: number): TimeRange | null {
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= lyrics.length || !Number.isInteger(count) || count < 1 || !Number.isFinite(durationMs)) return null;
  const first = lyrics[Math.max(0, selectedIndex - count + 1)];
  const current = lyrics[selectedIndex];
  const endMs = current.endMs ?? lyrics[selectedIndex + 1]?.startMs ?? durationMs;
  const range = { startMs: first.startMs, endMs: Math.min(endMs, durationMs) };
  return validRange(range, durationMs) ? range : null;
}
export function clampSeek(positionMs: number, deltaSeconds: number, durationMs: number): number {
  if (![positionMs, deltaSeconds, durationMs].every(Number.isFinite)) return 0;
  return Math.min(Math.max(0, positionMs + deltaSeconds * 1000), durationMs);
}
export type PracticeMode = 'normal' | 'line-repeat' | 'rehearsal-once';
/** Single deterministic playback decision used by timeupdate and seeked handlers. */
export function nextPlaybackAction(params: {
  positionMs: number; durationMs: number; mode: PracticeMode; skipRap: boolean;
  sections: VocalSection[]; lineRange?: TimeRange | null; wholeTrackLoop?: boolean;
}): { kind: 'seek'; positionMs: number } | { kind: 'stop' } | { kind: 'none' } {
  const { positionMs, durationMs, mode, skipRap, sections, lineRange, wholeTrackLoop } = params;
  if (mode === 'line-repeat' && lineRange && validRange(lineRange, durationMs)) {
    if (positionMs >= lineRange.endMs) return {kind:'seek',positionMs:lineRange.startMs};
    if (positionMs < lineRange.startMs) return {kind:'seek',positionMs:lineRange.startMs};
    return {kind:'none'};
  }
  if (positionMs >= durationMs) return mode === 'rehearsal-once' ? {kind:'stop'} : {kind:'none'};
  if (skipRap || mode === 'rehearsal-once') {
    const target = skipRapTarget(positionMs, sections, durationMs);
    if (target !== null) return target >= durationMs
      ? mode === 'rehearsal-once' || !wholeTrackLoop ? {kind:'stop'} : {kind:'seek',positionMs:0}
      : {kind:'seek',positionMs:target};
  }
  return {kind:'none'};
}
