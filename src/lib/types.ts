export interface ScoreAsset extends MediaFile {kind:'IMAGE'|'PDF';mime:string;pages:number}
export type LearningStatus = 'CAN_DANCE' | 'PRACTICING' | 'WANT_TO_LEARN';
export type SceneTag = 'COOL' | 'SEXY' | 'OUTDOOR' | 'TRANSITION';
export type ImportStage = 'ACQUIRE' | 'PROBE' | 'EXTRACT' | 'RECOGNIZE' | 'COVER' | 'REVIEW';
export interface MediaFile { id:string; url:string; sha256:string; sizeBytes:number; version:number; durationMs?:number; startMs?:number; endMs?:number; sourcePreserving?:boolean }
export interface SourceMedia { id:string; sourceKind:string; sourceLocator?:string; durationMs:number; sha256:string; url?:string; sizeBytes?:number; version?:number }
export interface PerformanceClip extends MediaFile { sourceMediaId:string; startMs:number; endMs:number; sourcePreserving:boolean }
export interface SongIdentity { id:string; title:string; artist:string; recognitionStatus:'UNTRIED'|'MATCHED'|'AMBIGUOUS'|'FAILED'|'MANUAL' }
export interface DanceItem { scores?:ScoreAsset[]; isDemo?:boolean; revision?:number; id:string; title:string; artist:string; learningStatus:LearningStatus; sceneTags:SceneTag[]; sourceMediaId?:string; performanceClipId:string; coverAssetId?:string; audio:MediaFile; cover?:MediaFile; source?:SourceMedia; durationMs:number }
export interface RecognitionCandidate { title:string; artist:string; confidence:number }
export interface ImportDraft extends Partial<DanceItem> { link?:string; adapter?:string; capability?:{ canAcquire:boolean; reason?:string }; candidates?:RecognitionCandidate[] }
export interface ImportJob { duplicateRefs?:{kind:'DANCE'|TalentKind;id:string}[]; id:string; status:'PENDING'|'PROCESSING'|'NEEDS_INPUT'|'READY'|'FAILED'; stage:ImportStage; errorCode?:string; draft?:ImportDraft; duplicateId?:string }
export interface PendingShare { id:string; token?:string; sharedText?:string; streamUri?:string; mime?:string; normalizedUrl?:string; receivedAt:string; submitState:'PENDING'|'SUBMITTED'|'NEEDS_INPUT'|'OFFLINE_SAVED'; serverJobId?:string; lastError?:string }
export interface Playlist { items:string[] }
export interface OfflineManifest { program?:{revision:number;items:{kind:'DANCE'|TalentKind;id:string}[]}; catalogVersion:number; items:DanceItem[]; playlist:string[]; repertoire?:TalentItem[] }
export interface DeviceSettings { themeMode:'system'|'light'|'dark'; apiEndpoint:string; lastSyncAt?:string; cachePolicyVersion:number }

export type VocalSectionType = 'intro' | 'verse' | 'pre' | 'chorus' | 'bridge' | 'rap' | 'outro' | 'unknown';
export type VocalRepetition = 'exact-lyrics' | 'same-melody-new-lyrics' | 'unverified';
export interface VocalSection {
  id: string; type: VocalSectionType; label: string; startMs: number; endMs: number;
  repeatOf?: string; repetition?: VocalRepetition; source: 'manual' | 'algorithm';
}
export interface TimedLyric { id: string; startMs: number; text: string; sectionId?: string; endMs?: number }
export interface LrcMetadata { title?: string; artist?: string; by?: string; offsetMs: number }
export interface LrcDocument { metadata: LrcMetadata; lines: TimedLyric[]; untimedLines: string[]; hasUsableTiming: boolean; issues: string[] }
export interface VocalTimeRange { startMs: number; endMs: number }
export interface VocalLineLoop { startMs: number; endMs: number; startIndex: number; endIndex: number; count: number }
export interface VocalPracticeSettings {
  skipRap: boolean; wholeTrackLoop: boolean;
  backwardSeconds: 5 | 10 | 15 | 30; forwardSeconds: 5 | 10 | 15 | 30;
  customRepeatLines: number; playbackRate: number;
}
export type VocalTrackRole = 'original' | 'accompaniment';
export interface VocalTrack { media: MediaFile; offsetMs?: number }
export interface VocalTracks { original?: VocalTrack; accompaniment?: VocalTrack }
export type PerformanceSource = VocalTrackRole;
/** 与后端 server/repertoire/service.mjs 的 LANGUAGES 枚举一致；未标注时不猜。 */
export type VocalLanguage = 'zh' | 'en' | 'ko';

export type TalentKind = 'GUITAR' | 'VOCAL';
export interface TalentItem {
  scores?:ScoreAsset[]; isDemo?: boolean; revision?: number; id: string; kind: TalentKind; title: string; artist: string; learningStatus: LearningStatus;
  originalKey: string; performanceKey: string; capo: number; scoreText: string; notes: string;
  audioRole: 'REFERENCE' | 'ACCOMPANIMENT'; audio?: MediaFile; cover?: MediaFile;
  sourceMediaId?: string; performanceClipId?: string; source?: SourceMedia; durationMs: number;
  /**
   * 以下为后端 VOCAL 字段（server/repertoire/service.mjs）：吉他一律为 undefined。
   * `audio`/`audioRole` 仍是旧单音轨字段，与 `tracks` 中对应角色指向同一媒体，可安全并存。
   * 缺失的轨保持缺失：不用原唱冒充伴奏，也不把同一条媒体复制成两个角色。
   */
  tracks?: VocalTracks; language?: VocalLanguage; lyrics?: TimedLyric[]; sections?: VocalSection[]; practice?: VocalPracticeSettings;
}
