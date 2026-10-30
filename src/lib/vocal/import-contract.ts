import type { MediaFile, TalentItem, TimedLyric, VocalLanguage, VocalSection, VocalTracks } from '../types';

/**
 * AI 智能导入统一数据契约（本轮只冻结接口，不发起任何付费或外部模型调用）。
 * 用户只投原唱 MP3；识别/分离/歌词对时/结构识别完成后，把结果写回「同一个 songId」的曲目对象，
 * 不再把一首歌的原唱、伴奏、LRC 当成三首。手动/批量导入走同一对象，仅是过渡与兜底。
 */

export type VocalImportStatus = 'queued' | 'identifying' | 'separating' | 'lyrics' | 'aligning' | 'ready' | 'needs-review' | 'failed';

export interface VocalSmartImportJob {
  jobId: string;
  /** 必须是目标曲目 id：所有输出都并入这一首，不新建曲目。 */
  songId: string;
  suppliedOriginal: MediaFile;
  status: VocalImportStatus;
  outputs: {
    original?: MediaFile;
    accompaniment?: MediaFile;
    lyricText?: string;
    lyrics?: TimedLyric[];
    sections?: VocalSection[];
  };
  failureReason?: string;
}

export interface VocalImportResult {
  songId: string;
  title: string;
  artist: string;
  language?: VocalLanguage;
  tracks: VocalTracks;
  lyricsLrc?: string;
  lyrics?: TimedLyric[];
  sections?: VocalSection[];
  /** 需要人工确认的点；非空时界面必须显示「需复核」，不得当成已完成。 */
  needReview: string[];
}

const IMPORT_LANGUAGES: readonly VocalLanguage[] = ['zh', 'en', 'ko'];

/** 分析器给的语言不在后端枚举内时不猜，交给人工确认。 */
export function normalizeImportLanguage(raw: unknown): VocalLanguage | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  return (IMPORT_LANGUAGES as readonly string[]).includes(value) ? (value as VocalLanguage) : undefined;
}

const ROLE_SUFFIXES = [
  { role: 'accompaniment', regexp: /(?:[\s._-]+|\s*\()[\s]*(?:伴奏|instrumental|karaoke|backing(?:[ -]?track)?)(?:\s*\))?$/i },
  { role: 'original', regexp: /(?:[\s._-]+|\s*\()[\s]*(?:原唱|原声|original|vocal|guide)(?:\s*\))?$/i },
] as const;

/** 从文件名推断音轨用途；无法判断时返回 unknown，由智能识别或人工确认，不默认猜测。 */
export function guessLocalFileRole(filename: string): { baseName: string; role: 'original' | 'accompaniment' | 'unknown' } {
  const stem = filename.replace(/\.[^.]+$/, '').trim();
  for (const { role, regexp } of ROLE_SUFFIXES) {
    if (regexp.test(stem)) return { baseName: stem.replace(regexp, '').trim(), role };
  }
  return { baseName: stem, role: 'unknown' };
}

/** 归一化后的同曲键：全角/半角与分隔符差异不会把一首歌拆成两首。 */
export function normalizedSongKey(filename: string): string {
  const { baseName } = guessLocalFileRole(filename);
  return baseName.normalize('NFKC').replace(/[\s_—–]+/g, ' ').trim().toLowerCase();
}

/** 稳定内部命名，避免中文/空格进入媒体路径；songId 必须是合法曲目 id。 */
export function canonicalImportNames(songId: string): { original: string; accompaniment: string; lyrics: string; analysis: string } {
  const safe = songId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
  if (!safe) throw new Error('无效歌曲 ID');
  return { original: `${safe}.original.mp3`, accompaniment: `${safe}.accompaniment.mp3`, lyrics: `${safe}.lrc`, analysis: `${safe}.analysis.json` };
}

export interface FileBundleCandidate {
  songKey: string;
  original?: string;
  accompaniment?: string;
  lyrics?: string;
  needsReview: string[];
}

/** 批量导入分组：同一首歌的原唱、伴奏、LRC 归入一个候选，不生成三首曲目。 */
export function groupVocalFiles(filenames: string[]): FileBundleCandidate[] {
  const bundles = new Map<string, FileBundleCandidate>();
  for (const filename of filenames) {
    const extension = filename.split('.').at(-1)?.toLowerCase();
    if (!['mp3', 'm4a', 'wav', 'flac', 'lrc'].includes(extension || '')) continue;
    const songKey = normalizedSongKey(filename);
    if (!songKey) continue;
    const entry = bundles.get(songKey) || { songKey, needsReview: [] };
    if (extension === 'lrc') {
      if (entry.lyrics) entry.needsReview.push('同一首歌有多个歌词文件');
      else entry.lyrics = filename;
    } else {
      const guessed = guessLocalFileRole(filename).role;
      // 未标注的音频按惯例视为原唱，但必须经识别或人工确认后才能当作确定原唱。
      const role = guessed === 'accompaniment' ? 'accompaniment' : 'original';
      if (entry[role]) entry.needsReview.push(`同一首歌有多个${role === 'original' ? '原唱' : '伴奏'}文件`);
      else entry[role] = filename;
      if (guessed === 'unknown') entry.needsReview.push('音轨用途未标注，需要智能识别或确认');
    }
    bundles.set(songKey, entry);
  }
  return [...bundles.values()].sort((a, b) => a.songKey.localeCompare(b.songKey));
}

export type VocalImportFields = Pick<TalentItem, 'language' | 'lyrics' | 'sections' | 'tracks'>;

/**
 * 导入结果 → 曲目字段（后端 `tracks` / `language` / `lyrics` / `sections`）。
 * 只带确实拿到的内容：缺失的伴奏不补、没对齐的歌词不给假时间戳。
 */
export function vocalFieldsFromImport(result: VocalImportResult): VocalImportFields {
  const fields: VocalImportFields = { tracks: result.tracks };
  const language = normalizeImportLanguage(result.language);
  if (language) fields.language = language;
  if (result.lyrics?.length) fields.lyrics = result.lyrics;
  if (result.sections?.length) fields.sections = result.sections;
  return fields;
}

/** 任务未完成时能落盘的部分字段；`ready` 之外的状态一律要求人工复核。 */
export function vocalFieldsFromJob(job: VocalSmartImportJob): VocalImportFields {
  const tracks: VocalTracks = {};
  const original = job.outputs.original ?? job.suppliedOriginal;
  if (original) tracks.original = { media: original };
  if (job.outputs.accompaniment) tracks.accompaniment = { media: job.outputs.accompaniment };
  const fields: VocalImportFields = { tracks };
  if (job.outputs.lyrics?.length) fields.lyrics = job.outputs.lyrics;
  if (job.outputs.sections?.length) fields.sections = job.outputs.sections;
  return fields;
}

export function importNeedsReview(job: VocalSmartImportJob): string[] {
  const notes: string[] = [];
  if (!job.outputs.accompaniment) notes.push('伴奏尚未生成，演出不可用');
  if (!job.outputs.lyrics?.length) notes.push('歌词尚未对时');
  if (!job.outputs.sections?.length) notes.push('歌曲结构尚未识别');
  if (job.status === 'failed') notes.push(job.failureReason || '导入失败');
  return notes;
}
