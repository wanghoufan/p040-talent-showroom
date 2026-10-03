import {storedProgram,saveProgram} from './program';
import {bulkLocally} from './offline-editing';
import {writeMetadata} from './local-database';
import { api,jsonBody } from './api';
import { catalogChanged } from './catalog-store';
import { cacheRepertoire } from './repertoire-store';
import { readOfflineManifest,saveOfflineManifest } from './offline-manifest';
import type { DanceItem,TalentItem,TalentKind } from './types';
export type LibraryKind='DANCE'|TalentKind;
export interface ItemRef {kind:LibraryKind;id:string}
export interface TrashItem extends ItemRef {title:string;deletedAt:string;revision:number}
export function bulkRequest(action:'update'|'trash'|'restore'|'purge',refs:ItemRef[],fields?:object){return {operationId:crypto.randomUUID(),action,refs,...(fields?{fields}:{})};}
export async function runBulk(body:ReturnType<typeof bulkRequest>){
 if(body.action!=='purge')return bulkLocally(body.action,body.refs,body.fields as Record<string,unknown>|undefined);
 const result=await api<{items:(DanceItem|TalentItem)[];catalogVersion:number}>('/api/library/bulk',{method:'POST',...jsonBody(body)});
 const [dance,talent]=await Promise.all([api<{items:DanceItem[]}>('/api/catalog'),api<{items:TalentItem[]}>('/api/repertoire')]);
 writeMetadata('dance.catalog-snapshot',JSON.stringify(dance.items));cacheRepertoire(talent.items);
 const manifest=readOfflineManifest();if(manifest)saveOfflineManifest({...manifest,catalogVersion:result.catalogVersion,items:dance.items,repertoire:talent.items,playlist:manifest.playlist.filter(id=>dance.items.some(i=>i.id===id))});catalogChanged();return result;
}
export async function addToProgram(refs:ItemRef[]){const program=storedProgram();const items=[...program.items,...refs.filter(r=>!program.items.some(p=>p.kind===r.kind&&p.id===r.id))];return saveProgram({...program,items});}
