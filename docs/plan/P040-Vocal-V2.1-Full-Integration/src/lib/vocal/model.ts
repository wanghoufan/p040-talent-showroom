/** P040 VOCAL-only additive contract. All media fields match the existing MediaFile shape. */
export interface VocalMediaFile {
  id: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  version: number;
  durationMs?: number;
  startMs?: number;
  endMs?: number;
  sourcePreserving?: boolean;
}
export type VocalTrackRole = 'original' | 'accompaniment';
export interface VocalTrack {
  media: VocalMediaFile;
  /** Audio file clock minus canonical lyric timeline clock. */
  offsetMs?: number;
  /** True only when this particular file was separated from a supplied original. */
  source?: 'manual' | 'ai-separated' | 'legacy';
}
export interface VocalTracks {
  original?: VocalTrack;
  accompaniment?: VocalTrack;
}
export type VocalSectionType = 'intro' | 'verse' | 'pre' | 'chorus' | 'bridge' | 'rap' | 'outro' | 'unknown';
export interface VocalSection {
  id: string;
  type: VocalSectionType;
  label: string;
  startMs: number;
  endMs: number;
  repeatOf?: string;
  repetition?: 'exact-lyrics' | 'same-melody-new-lyrics' | 'unverified';
  source: 'manual' | 'algorithm';
}
export interface TimedLyric {
  id: string;
  startMs: number;
  text: string;
  endMs?: number;
  sectionId?: string;
}
export interface VocalAnalysis {
  lyrics: TimedLyric[];
  sections: VocalSection[];
  status: 'pending' | 'needs-review' | 'ready';
  updatedAt?: string;
  /** User corrections must not be overwritten by later automated analysis. */
  manualCorrections?: boolean;
}
/** Compatibility surface; does not modify the existing P040 model itself. */
export interface LegacyVocalAudio {
  kind: 'VOCAL' | 'GUITAR';
  audio?: VocalMediaFile;
  audioRole?: 'REFERENCE' | 'ACCOMPANIMENT';
  vocalTracks?: VocalTracks;
}

export function resolveVocalTracks(item: LegacyVocalAudio): VocalTracks {
  if (item.kind !== 'VOCAL') return {};
  const tracks: VocalTracks = { ...(item.vocalTracks || {}) };
  if (item.audio) {
    const legacyRole: VocalTrackRole = item.audioRole === 'ACCOMPANIMENT' ? 'accompaniment' : 'original';
    if (!tracks[legacyRole]) tracks[legacyRole] = { media: item.audio, source: 'legacy' };
  }
  return tracks;
}
/** Don't relabel a missing accompaniment as an original or vice versa. */
export function preferredVocalRole(
  tracks: VocalTracks,
  context: 'practice' | 'performance',
): VocalTrackRole | null {
  if (context === 'performance') return tracks.accompaniment ? 'accompaniment' : null;
  return tracks.original ? 'original' : tracks.accompaniment ? 'accompaniment' : null;
}
export function playableVocalTrack(tracks: VocalTracks, role: VocalTrackRole): VocalTrack | null {
  return tracks[role] || null;
}
/** Same physical media is downloaded once, but its distinct role remains explicit. */
export function uniqueVocalMedia(tracks: VocalTracks): VocalMediaFile[] {
  const result: VocalMediaFile[] = [];
  const keys = new Set<string>();
  for (const role of ['accompaniment', 'original'] as const) {
    const media = tracks[role]?.media;
    if (media && !keys.has(media.url)) {
      keys.add(media.url);
      result.push(media);
    }
  }
  return result;
}

export interface TrackPairCheck {
  state: 'ready' | 'one-track' | 'missing' | 'same-media' | 'needs-alignment';
  detail?: string;
}
export function checkVocalTrackPair(tracks: VocalTracks): TrackPairCheck {
  const {original,accompaniment} = tracks;
  if (!original && !accompaniment) return {state:'missing'};
  if (!original || !accompaniment) return {state:'one-track'};
  if (original.media.id === accompaniment.media.id || original.media.url === accompaniment.media.url ||
    (!!original.media.sha256 && original.media.sha256 === accompaniment.media.sha256)) {
    return {state:'same-media',detail:'原唱和伴奏引用了同一媒体，不能当作 KTV 双音轨'};
  }
  const o=original.media.durationMs, a=accompaniment.media.durationMs;
  if (typeof o==='number' && typeof a==='number' && o>0 && a>0) {
    // Files can have slightly different trailing padding. Larger drift requires alignment verification.
    const logicalDiff=Math.abs((o-(original.offsetMs??0))-(a-(accompaniment.offsetMs??0)));
    const tolerance=Math.max(1500,Math.min(o,a)*.02);
    if (logicalDiff>tolerance) return {state:'needs-alignment',detail:`两条音轨的有效时长相差 ${Math.round(logicalDiff)}ms，请校准`};
  }
  return {state:'ready'};
}
