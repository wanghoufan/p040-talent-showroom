import type {
  LrcDocument, LrcMetadata, MediaFile, PerformanceSource, TalentItem, TimedLyric,
  VocalLineLoop, VocalPracticeSettings, VocalSection, VocalTimeRange, VocalTrack, VocalTrackRole, VocalTracks,
} from './types';

export * from './vocal/tracks';
export * from './vocal/import-contract';

const TIMESTAMP_SOURCE = /\[(\d{1,4}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const METADATA_SOURCE = /^\[([a-zA-Z]+):([^\]]*)\]$/;
const WORD_TIMING_SOURCE = /<\d{1,4}:\d{1,2}(?:[.:]\d{1,3})?>/g;
const VOCAL_SOURCE_ORDER: readonly PerformanceSource[] = ['original', 'accompaniment'];
const DEFAULT_SKIP_EPSILON_MS = 30;
const DEFAULT_MIN_LOOP_MS = 100;
const MAX_LOOP_BUFFER_MS = 300;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

/**
 * 解析 LRC。时间轴 = 原始时间戳 - [offset]（正 offset 使歌词提前，符合 LRC 惯例）。
 * 无时间戳的行进入 untimedLines，调用方应提示「需要校准」，不得伪造时间。
 */
export function parseLrc(text: string): LrcDocument {
  const metadata: LrcMetadata = { offsetMs: 0 };
  const issues: string[] = [];
  const staged: { rawMs: number; order: number; text: string }[] = [];
  const untimedLines: string[] = [];
  const source = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : '';
  if (!source.trim()) return { metadata, lines: [], untimedLines, hasUsableTiming: false, issues: ['EMPTY_LYRICS'] };

  let order = 0;
  for (const rawLine of source.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const meta = METADATA_SOURCE.exec(line);
    if (meta) {
      const key = meta[1].toLowerCase();
      const value = meta[2].trim();
      if (key === 'ti') metadata.title = value || undefined;
      else if (key === 'ar') metadata.artist = value || undefined;
      else if (key === 'by') metadata.by = value || undefined;
      else if (key === 'offset') {
        const offset = Number(value);
        if (Number.isFinite(offset)) metadata.offsetMs = Math.trunc(offset);
        else issues.push('INVALID_OFFSET');
      }
      continue;
    }

    const stamps: number[] = [];
    const withoutStamps = line.replace(TIMESTAMP_SOURCE, (_match, minutes: string, seconds: string, fraction?: string) => {
      if (Number(seconds) > 59) {
        issues.push('INVALID_TIMESTAMP');
        return '';
      }
      const fractionMs = fraction ? Number(fraction.padEnd(3, '0')) : 0;
      stamps.push(Number(minutes) * 60000 + Number(seconds) * 1000 + fractionMs);
      return '';
    });
    const content = withoutStamps.replace(WORD_TIMING_SOURCE, '').trim();

    if (!stamps.length) {
      if (content) untimedLines.push(content);
      continue;
    }
    if (!content) continue;
    for (const rawMs of stamps) staged.push({ rawMs, order: order++, text: content });
  }

  staged.sort((a, b) => a.rawMs - b.rawMs || a.order - b.order);
  let clamped = false;
  const lines: TimedLyric[] = staged.map((item, index) => {
    const startMs = item.rawMs - metadata.offsetMs;
    if (startMs < 0) clamped = true;
    return { id: `lrc-${index + 1}`, startMs: Math.max(0, startMs), text: item.text };
  });

  if (clamped) issues.push('NEGATIVE_TIME_CLAMPED');
  if (!lines.length && untimedLines.length) issues.push('NEEDS_CALIBRATION');
  if (!lines.length && !untimedLines.length) issues.push('EMPTY_LYRICS');
  return { metadata, lines, untimedLines, hasUsableTiming: lines.length > 0, issues: [...new Set(issues)] };
}

/** 补齐句尾：显式 endMs 优先，其次下一句起点，最后音乐总时长；都不存在则保持未知。 */
export function resolveLineTimings(lines: readonly TimedLyric[], durationMs?: number): TimedLyric[] {
  const duration = isPositiveNumber(durationMs) ? durationMs : undefined;
  return lines.map((line, index) => {
    if (isFiniteNumber(line.endMs) && line.endMs > line.startMs) return { ...line };
    const nextStart = lines[index + 1]?.startMs;
    const endMs = isPositiveNumber(nextStart) && nextStart > line.startMs
      ? nextStart
      : duration !== undefined && duration > line.startMs ? duration : undefined;
    return endMs === undefined ? { ...line } : { ...line, endMs };
  });
}

/** 返回 timeMs 所在句的下标（半开区间，句子须按时间升序）；早于第一句返回 -1。 */
export function lineAtTime(lines: readonly TimedLyric[], timeMs: number): number {
  if (!isFiniteNumber(timeMs)) return -1;
  let found = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const startMs = lines[index].startMs;
    if (!isFiniteNumber(startMs)) continue;
    if (startMs > timeMs) break;
    found = index;
  }
  return found;
}

export function sortSections(sections: readonly VocalSection[]): VocalSection[] {
  return [...sections].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
}

/** 结构校验：越界、开始 ≥ 结束、重复 id、重叠、重复目标缺失都应拒绝保存。 */
export function validateSections(sections: readonly VocalSection[], durationMs?: number): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const section of sections) {
    if (!section.id) issues.push('MISSING_ID');
    else if (ids.has(section.id)) issues.push(`DUPLICATE_ID:${section.id}`);
    else ids.add(section.id);

    if (!isFiniteNumber(section.startMs) || !isFiniteNumber(section.endMs)) {
      issues.push(`${section.id}:INVALID_TIME`);
    } else {
      if (section.startMs < 0) issues.push(`${section.id}:NEGATIVE_START`);
      if (section.endMs <= section.startMs) issues.push(`${section.id}:EMPTY_RANGE`);
      if (isPositiveNumber(durationMs) && section.endMs > durationMs) issues.push(`${section.id}:OUT_OF_RANGE`);
    }
    if (section.repeatOf === section.id) issues.push(`${section.id}:SELF_REPEAT`);
  }
  for (const section of sections) {
    if (section.repeatOf && section.repeatOf !== section.id && !ids.has(section.repeatOf)) {
      issues.push(`${section.id}:REPEAT_TARGET_MISSING`);
    }
  }
  const timed = sortSections(sections.filter((section) => isFiniteNumber(section.startMs) && isFiniteNumber(section.endMs)));
  for (let index = 1; index < timed.length; index += 1) {
    if (timed[index].startMs < timed[index - 1].endMs) issues.push(`${timed[index].id}:OVERLAP`);
  }
  return [...new Set(issues)];
}

/** 半开区间 [startMs, endMs) 命中；重叠数据取先命中者。 */
export function sectionAtTime(sections: readonly VocalSection[], timeMs: number): VocalSection | null {
  if (!isFiniteNumber(timeMs)) return null;
  for (const section of sections) {
    if (timeMs >= section.startMs && timeMs < section.endMs) return section;
  }
  return null;
}

/** 已有合法 sectionId 的手工标注优先，其余按时间落段。 */
export function assignSectionIds(lines: readonly TimedLyric[], sections: readonly VocalSection[]): TimedLyric[] {
  const known = new Set(sections.map((section) => section.id));
  const timedSections = sortSections(sections);
  return lines.map((line) => {
    if (line.sectionId && known.has(line.sectionId)) return { ...line };
    const section = sectionAtTime(timedSections, line.startMs);
    return section ? { ...line, sectionId: section.id } : { ...line };
  });
}

/**
 * 合并 Rap 区间：丢弃非法区间，按时间排序，重叠或相邻（next.start <= current.end）合并。
 * 传入 durationMs 时裁剪越界部分，避免跳到曲尾之外。
 */
export function mergeRapRanges(ranges: readonly VocalTimeRange[], durationMs?: number): VocalTimeRange[] {
  const limit = isPositiveNumber(durationMs) ? durationMs : undefined;
  const normalized: VocalTimeRange[] = [];
  for (const range of ranges) {
    if (!isFiniteNumber(range.startMs) || !isFiniteNumber(range.endMs)) continue;
    const startMs = Math.max(0, range.startMs);
    const endMs = limit === undefined ? range.endMs : Math.min(range.endMs, limit);
    if (endMs <= startMs) continue;
    normalized.push({ startMs, endMs });
  }
  normalized.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: VocalTimeRange[] = [];
  for (const range of normalized) {
    const last = merged[merged.length - 1];
    if (last && range.startMs <= last.endMs) last.endMs = Math.max(last.endMs, range.endMs);
    else merged.push({ ...range });
  }
  return merged;
}

export function rapRangesFromSections(sections: readonly VocalSection[], durationMs?: number): VocalTimeRange[] {
  return mergeRapRanges(
    sections.filter((section) => section.type === 'rap').map((section) => ({ startMs: section.startMs, endMs: section.endMs })),
    durationMs,
  );
}

export function rapRangeAt(timeMs: number, ranges: readonly VocalTimeRange[]): VocalTimeRange | null {
  if (!isFiniteNumber(timeMs)) return null;
  for (const range of ranges) {
    if (timeMs >= range.startMs && timeMs < range.endMs) return range;
  }
  return null;
}

export interface SkipRapOptions { enabled?: boolean; durationMs?: number; epsilonMs?: number }

/**
 * 全曲播放时的 Rap 跳段目标。位于 [start, end) 内则跳到 end + epsilon（默认 30ms，
 * 防止半开区间边界反复触发），并夹取到总时长；未命中或关闭开关时原样返回。
 */
export function skipRapTarget(timeMs: number, ranges: readonly VocalTimeRange[], options: SkipRapOptions = {}): number {
  if (!isFiniteNumber(timeMs)) return timeMs;
  if (options.enabled === false) return timeMs;
  const range = rapRangeAt(timeMs, ranges);
  if (!range) return timeMs;
  const epsilon = isFiniteNumber(options.epsilonMs) && options.epsilonMs >= 0 ? options.epsilonMs : DEFAULT_SKIP_EPSILON_MS;
  let target = range.endMs + epsilon;
  if (isPositiveNumber(options.durationMs)) target = Math.min(target, options.durationMs);
  return target > timeMs ? target : timeMs;
}

export interface LineLoopOptions { durationMs?: number; bufferMs?: number; minDurationMs?: number }

/**
 * 逐句循环：以 endIndex（0 基）为最后一句，向前取 N 句（不足则从第 1 句起）。
 * 句尾优先用显式 endMs，其次下一句起点，最后总时长；无可靠时间戳返回 null，
 * 由调用方提示「需要校准」，不得按时间均分伪造。
 */
export function lineLoopFor(
  lines: readonly TimedLyric[],
  endIndex: number,
  repeatLines: number,
  options: LineLoopOptions = {},
): VocalLineLoop | null {
  if (!lines.length || !Number.isInteger(endIndex) || endIndex < 0 || endIndex >= lines.length) return null;
  if (!isFiniteNumber(repeatLines)) return null;

  const count = Math.max(1, Math.floor(repeatLines));
  const startIndex = Math.max(0, endIndex - count + 1);
  let previous = -1;
  for (let index = startIndex; index <= endIndex; index += 1) {
    const startMs = lines[index].startMs;
    if (!isFiniteNumber(startMs) || startMs < 0 || startMs <= previous) return null;
    previous = startMs;
  }

  const startMs = lines[startIndex].startMs;
  const last = lines[endIndex];
  const nextStart = lines[endIndex + 1]?.startMs;
  const nextLimit = isPositiveNumber(nextStart) && nextStart > startMs ? nextStart : Number.POSITIVE_INFINITY;
  const durationLimit = isPositiveNumber(options.durationMs) && options.durationMs > startMs ? options.durationMs : Number.POSITIVE_INFINITY;
  const limit = Math.min(nextLimit, durationLimit);

  let endMs: number | undefined;
  if (isFiniteNumber(last.endMs) && last.endMs > last.startMs) endMs = last.endMs;
  else if (limit !== Number.POSITIVE_INFINITY) endMs = limit;
  if (endMs === undefined) return null;

  const buffer = isFiniteNumber(options.bufferMs) ? Math.min(Math.max(options.bufferMs, 0), MAX_LOOP_BUFFER_MS) : 0;
  if (buffer > 0) {
    const extended = endMs + buffer;
    endMs = limit === Number.POSITIVE_INFINITY ? extended : Math.max(endMs, Math.min(extended, limit));
  }
  const minDuration = isFiniteNumber(options.minDurationMs) ? Math.max(0, options.minDurationMs) : DEFAULT_MIN_LOOP_MS;
  if (endMs - startMs <= minDuration) return null;

  return { startMs, endMs, startIndex, endIndex, count: endIndex - startIndex + 1 };
}

/**
 * 旧 audioRole 精确映射：REFERENCE → 原唱，ACCOMPANIMENT → 伴奏。
 * 未知值返回 null，绝不猜测；迁移时另一轨保持 null。
 */
export function mapLegacyAudioRole(role: string): VocalTrackRole | null {
  switch (role) {
    case 'REFERENCE': return 'original';
    case 'ACCOMPANIMENT': return 'accompaniment';
    default: return null;
  }
}

/** 旧单音频只落到对应一轨；无音频返回空轨；未知 audioRole 直接抛错，不静默降级。 */
export function vocalTracksFromLegacy(item: Pick<TalentItem, 'audio' | 'audioRole'>): VocalTracks {
  if (!item.audio) return {};
  const role = mapLegacyAudioRole(item.audioRole);
  if (!role) throw new Error(`UNKNOWN_AUDIO_ROLE:${item.audioRole}`);
  return role === 'original' ? { original: { media: item.audio } } : { accompaniment: { media: item.audio } };
}

export function hasVocalTrack(tracks: VocalTracks, source: PerformanceSource): boolean {
  return Boolean(tracks[source]?.media);
}

export function availableVocalSources(tracks: VocalTracks): PerformanceSource[] {
  return VOCAL_SOURCE_ORDER.filter((source) => hasVocalTrack(tracks, source));
}

/**
 * 默认音轨：练唱有原唱优先原唱，否则伴奏；演出只认伴奏，
 * 伴奏缺失返回 null，由界面明确提示缺轨，绝不用原唱冒充伴奏。
 */
export function defaultVocalSource(tracks: VocalTracks, scene: 'practice' | 'performance'): PerformanceSource | null {
  if (scene === 'performance') return hasVocalTrack(tracks, 'accompaniment') ? 'accompaniment' : null;
  if (hasVocalTrack(tracks, 'original')) return 'original';
  return hasVocalTrack(tracks, 'accompaniment') ? 'accompaniment' : null;
}

/** 与后端 PRACTICE_DEFAULTS 一致；缺失的项按服务端默认补齐，避免离线首帧读到 undefined。 */
export const VOCAL_PRACTICE_DEFAULTS: Readonly<VocalPracticeSettings> = {
  skipRap: false, wholeTrackLoop: false, backwardSeconds: 5, forwardSeconds: 10, customRepeatLines: 2, playbackRate: 1,
};

export function resolvePractice(item: Pick<TalentItem, 'practice'>): VocalPracticeSettings {
  return { ...VOCAL_PRACTICE_DEFAULTS, ...(item.practice || {}) };
}

/**
 * 有效音轨：`tracks` 是服务端分角色持久化的真源，直接采用。
 * 仅当该角色尚无媒体时才用旧 `audio` + `audioRole` 精确补位；已完成角色映射的媒体不会重复计入另一轨，
 * 因此缺失的伴奏始终是缺失，不会被原唱顶替。
 */
export function resolveTracks(item: Pick<TalentItem, 'kind' | 'audio' | 'audioRole' | 'tracks'>): VocalTracks {
  if (item.kind !== 'VOCAL') return {};
  const tracks: VocalTracks = { ...(item.tracks || {}) };
  const audio = item.audio;
  if (!audio) return tracks;
  const used = (['original', 'accompaniment'] as const).some((role) => {
    const media = tracks[role]?.media;
    return !!media && (media.id === audio.id || (!!media.url && media.url === audio.url));
  });
  if (used) return tracks;
  const role = mapLegacyAudioRole(item.audioRole);
  if (role && !tracks[role]) tracks[role] = { media: audio };
  return tracks;
}

export interface TrackPairCheck {
  state: 'ready' | 'one-track' | 'missing' | 'same-media' | 'needs-alignment';
  detail?: string;
}

/** 双轨一致性：同一媒体不得充当两轨；有效时长差过大的两条音轨需要先校准。 */
export function trackPairStatus(tracks: VocalTracks): TrackPairCheck {
  const { original, accompaniment } = tracks;
  if (!original && !accompaniment) return { state: 'missing' };
  if (!original || !accompaniment) return { state: 'one-track' };
  if (original.media.id === accompaniment.media.id || original.media.url === accompaniment.media.url
    || (!!original.media.sha256 && original.media.sha256 === accompaniment.media.sha256)) {
    return { state: 'same-media', detail: '原唱和伴奏引用了同一媒体，不能当作双音轨' };
  }
  const originalDuration = original.media.durationMs, accompanimentDuration = accompaniment.media.durationMs;
  if (typeof originalDuration === 'number' && typeof accompanimentDuration === 'number' && originalDuration > 0 && accompanimentDuration > 0) {
    // 结尾静音会带来少量差异；超过容差说明两条文件本身没对齐，必须人工校准。
    const logicalDiff = Math.abs((originalDuration - (original.offsetMs ?? 0)) - (accompanimentDuration - (accompaniment.offsetMs ?? 0)));
    const tolerance = Math.max(1500, Math.min(originalDuration, accompanimentDuration) * 0.02);
    if (logicalDiff > tolerance) return { state: 'needs-alignment', detail: `两条音轨的有效时长相差 ${Math.round(logicalDiff)}ms，请校准` };
  }
  return { state: 'ready' };
}

/** 需要落盘的唯一媒体：同一文件只缓存一次，但两条轨的角色仍各自保留。 */
export function uniqueTrackMedia(tracks: VocalTracks): MediaFile[] {
  const result: MediaFile[] = [];
  const seen = new Set<string>();
  for (const role of ['accompaniment', 'original'] as const) {
    const media = tracks[role]?.media;
    const key = media?.url || media?.id;
    if (!media || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(media);
  }
  return result;
}

/** 单轨访问器：缺轨返回 null，调用方据此显示「缺伴奏」而不是回退到另一轨。 */
export function trackFor(tracks: VocalTracks, role: VocalTrackRole): VocalTrack | null {
  return tracks[role] ? tracks[role] : null;
}
