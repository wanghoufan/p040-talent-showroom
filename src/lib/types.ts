export interface ScoreAsset extends MediaFile {kind:'IMAGE'|'PDF';mime:string;pages:number}
export type LearningStatus = 'CAN_DANCE' | 'PRACTICING' | 'WANT_TO_LEARN';
export type SceneTag = 'COOL' | 'SEXY' | 'OUTDOOR' | 'TRANSITION';
export type ImportStage = 'ACQUIRE' | 'PROBE' | 'EXTRACT' | 'RECOGNIZE' | 'COVER' | 'REVIEW';
export interface MediaFile { id:string; url:string; sha256:string; sizeBytes:number; version:number; durationMs?:number; startMs?:number; endMs?:number; sourcePreserving?:boolean }
export interface SourceMedia { id:string; sourceKind:string; sourceLocator?:string; durationMs:number; sha256:string }
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

export type TalentKind = 'GUITAR' | 'VOCAL';
export interface TalentItem {
  scores?:ScoreAsset[]; isDemo?: boolean; revision?: number; id: string; kind: TalentKind; title: string; artist: string; learningStatus: LearningStatus;
  originalKey: string; performanceKey: string; capo: number; scoreText: string; notes: string;
  audioRole: 'REFERENCE' | 'ACCOMPANIMENT'; audio?: MediaFile; cover?: MediaFile;
  sourceMediaId?: string; performanceClipId?: string; source?: SourceMedia; durationMs: number;
}
