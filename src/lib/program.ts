import {localOperations} from './local-database';
import {programLocally} from './offline-editing';
import {readMetadata,writeMetadata} from './local-database';
import {api} from './api';
import {storedCatalog} from './catalog-store';
import {storedRepertoire,playableTalent} from './repertoire-store';
import {readOfflineManifest,saveOfflineManifest} from './offline-manifest';
import type {ItemRef,LibraryKind} from './library-management';
import type {DanceItem,TalentItem} from './types';
export interface Program {revision:number;items:ItemRef[]}
export type ProgramItem=(DanceItem&{kind:'DANCE'})|TalentItem;
export const kindLabel=(kind:LibraryKind)=>kind==='DANCE'?'舞蹈':kind==='GUITAR'?'吉他':'唱歌';
export function storedProgram():Program{const manifest=readOfflineManifest();let saved:Program|null=null;try{saved=JSON.parse(readMetadata('dance.program')||'null');}catch{/* Use legacy manifest. */}return saved||manifest?.program||{revision:0,items:(manifest?.playlist||[]).map(id=>({kind:'DANCE',id}))};}
export function cacheProgram(program:Program){writeMetadata('dance.program',JSON.stringify(program));const manifest=readOfflineManifest();if(manifest)saveOfflineManifest({...manifest,program,playlist:program.items.filter(r=>r.kind==='DANCE').map(r=>r.id)});window.dispatchEvent(new Event('dance-program-changed'));}
export async function fetchProgram(){const program=await api<Program>('/api/programs/tonight');if((await localOperations<{action:string}>()).some(o=>o.action==='program'))return storedProgram();cacheProgram(program);return program;}
export async function saveProgram(program:Program){return programLocally({...program,revision:storedProgram().revision});}
export function allProgramItems():ProgramItem[]{const manifest=readOfflineManifest();return [...(storedCatalog().length?storedCatalog():manifest?.items||[]).map(i=>({...i,kind:'DANCE' as const})),...(storedRepertoire().length?storedRepertoire():manifest?.repertoire||[])];}
export function programAudio(item:ProgramItem){return item.kind==='DANCE'?item:playableTalent(item);}
