import type { VocalAnalysis, VocalMediaFile, VocalTracks } from './model';

/** A user imports one original MP3; separated accompaniment and lyrics can arrive later. */
export interface VocalSmartImportJob {
  jobId: string;
  songId: string;
  suppliedOriginal: VocalMediaFile;
  status: 'queued' | 'identifying' | 'separating' | 'lyrics' | 'aligning' | 'ready' | 'needs-review' | 'failed';
  outputs: {
    original?: VocalMediaFile;
    accompaniment?: VocalMediaFile;
    lyricText?: string;
    analysis?: VocalAnalysis;
  };
  failureReason?: string;
}
/** No external AI call is implemented here. The later worker must use this stable contract. */
export interface VocalImportResult {
  songId: string;
  title: string;
  artist: string;
  language?: 'zh' | 'en' | 'ko' | 'other';
  tracks: VocalTracks;
  lyricsLrc?: string;
  analysis?: VocalAnalysis;
  needReview: string[];
}
const ROLE_SUFFIXES = [
  {role:'accompaniment', regexp:/(?:[\s._-]+|\s*\()[\s]*(?:伴奏|instrumental|karaoke|backing(?:[ -]?track)?)(?:\s*\))?$/i},
  {role:'original', regexp:/(?:[\s._-]+|\s*\()[\s]*(?:原唱|原声|original|vocal|guide)(?:\s*\))?$/i},
] as const;
export function guessLocalFileRole(filename: string): {baseName:string;role:'original'|'accompaniment'|'unknown'} {
  let stem = filename.replace(/\.[^.]+$/, '').trim();
  for (const {role,regexp} of ROLE_SUFFIXES) {
    if (regexp.test(stem)) return {baseName:stem.replace(regexp,'').trim(),role};
  }
  return {baseName:stem,role:'unknown'};
}
export function normalizedSongKey(filename: string): string {
  const {baseName} = guessLocalFileRole(filename);
  return baseName.normalize('NFKC').replace(/[\s_—–]+/g,' ').trim().toLowerCase();
}
export function canonicalImportNames(songId: string): { original: string; accompaniment: string; lyrics: string; analysis: string } {
  const safe = songId.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,100);
  if (!safe) throw new Error('无效歌曲 ID');
  return {original:`${safe}.original.mp3`,accompaniment:`${safe}.accompaniment.mp3`,lyrics:`${safe}.lrc`,analysis:`${safe}.analysis.json`};
}

export interface FileBundleCandidate {
  songKey: string;
  original?: string;
  accompaniment?: string;
  lyrics?: string;
  needsReview: string[];
}
/** Bulk/manual compatibility mode. AI imports should attach to song IDs, never rely only on names. */
export function groupVocalFiles(filenames: string[]): FileBundleCandidate[] {
  const bundles = new Map<string, FileBundleCandidate>();
  for (const filename of filenames) {
    const extension = filename.split('.').at(-1)?.toLowerCase();
    if (!['mp3','m4a','wav','flac','lrc'].includes(extension||'')) continue;
    const songKey = normalizedSongKey(filename);
    if (!songKey) continue;
    const entry = bundles.get(songKey) || {songKey,needsReview:[]};
    if (extension === 'lrc') {
      if (entry.lyrics) entry.needsReview.push('同一首歌有多个歌词文件');
      else entry.lyrics = filename;
    } else {
      const guessed = guessLocalFileRole(filename).role;
      // An unlabeled MP3 is conventionally an original, but this must be confirmed
      // by metadata/analysis before presenting as guaranteed original audio.
      const role = guessed === 'accompaniment' ? 'accompaniment' : 'original';
      if (entry[role]) entry.needsReview.push(`同一首歌有多个${role === 'original' ? '原唱' : '伴奏'}文件`);
      else entry[role] = filename;
      if (guessed === 'unknown') entry.needsReview.push('音轨用途未标注，需要智能识别或确认');
    }
    bundles.set(songKey,entry);
  }
  return [...bundles.values()].sort((a,b)=>a.songKey.localeCompare(b.songKey));
}
