import {listScores} from '../scores/service.mjs';
import { removeFromProgram } from '../program/service.mjs';
import { randomUUID } from 'node:crypto';
import { STATUSES, bumpCatalog } from '../catalog.mjs';
const KINDS=['GUITAR','VOCAL'];
const fields=['clientId','kind','title','artist','learningStatus','originalKey','performanceKey','capo','scoreText','notes','audioRole'];
function validate(body,kind,creating=false){
 if(body?.clientId!==undefined&&(!creating||typeof body.clientId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(body.clientId)))throw Error('BAD_REQUEST');
 if(!body||Object.keys(body).some(k=>!fields.includes(k))||(!creating&&body.kind!==undefined))throw new Error('BAD_REQUEST');
 if(!KINDS.includes(kind))throw new Error('BAD_REQUEST');
 for(const [key,max] of [['title',200],['artist',200],['originalKey',40],['performanceKey',40],['scoreText',50000],['notes',10000]]){
  if(body[key]!==undefined&&(typeof body[key]!=='string'||body[key].length>max||(key==='title'&&!body[key].trim())))throw new Error('BAD_REQUEST');
 }
 if(creating&&!body.title?.trim())throw new Error('INVALID_TITLE');
 if(body.learningStatus!==undefined&&!STATUSES.includes(body.learningStatus))throw new Error('INVALID_STATUS');
 if(body.capo!==undefined&&(!Number.isInteger(body.capo)||body.capo<0||body.capo>12||(kind==='VOCAL'&&body.capo!==0)))throw new Error('BAD_REQUEST');
 if(body.audioRole!==undefined&&!['REFERENCE','ACCOMPANIMENT'].includes(body.audioRole))throw new Error('BAD_REQUEST');
}
export function getRepertoire(db,id,includeDeleted=false){
 const r=db.prepare(`SELECT r.*,c.sha256 AS audio_hash,c.size_bytes AS audio_size,c.version AS audio_version,c.duration_ms,c.start_ms,c.end_ms,c.source_preserving,m.source_kind,m.source_locator,m.sha256 AS source_hash,m.duration_ms AS source_duration,a.sha256 AS cover_hash,a.size_bytes AS cover_size FROM repertoire_items r LEFT JOIN performance_clips c ON c.id=r.performance_clip_id LEFT JOIN source_media m ON m.id=r.source_media_id LEFT JOIN assets a ON a.id=r.cover_asset_id WHERE r.id=? AND (r.deleted_at IS NULL OR ?)`).get(id,includeDeleted?1:0);
 if(!r)return null;
 return {scores:listScores(db,{kind:r.kind,id:r.id}),revision:r.revision,isDemo:!!db.prepare("SELECT 1 FROM demo_records WHERE kind=? AND item_id=?").get(r.kind,r.id),id:r.id,kind:r.kind,title:r.title,artist:r.artist,learningStatus:r.learning_status,originalKey:r.original_key,performanceKey:r.performance_key,capo:r.capo,scoreText:r.score_text,notes:r.notes,audioRole:r.audio_role,sourceMediaId:r.source_media_id||undefined,performanceClipId:r.performance_clip_id||undefined,durationMs:r.duration_ms||0,
 audio:r.performance_clip_id?{id:r.performance_clip_id,url:`/api/media/audio/${r.performance_clip_id}`,sha256:r.audio_hash,sizeBytes:r.audio_size,version:r.audio_version,startMs:r.start_ms,endMs:r.end_ms,sourcePreserving:!!r.source_preserving}:undefined,
 cover:r.cover_asset_id?{id:r.cover_asset_id,url:`/api/media/cover/${r.cover_asset_id}`,sha256:r.cover_hash,sizeBytes:r.cover_size,version:1}:undefined,
 source:r.source_media_id?{id:r.source_media_id,sourceKind:r.source_kind,sourceLocator:r.source_locator||undefined,sha256:r.source_hash,durationMs:r.source_duration}:undefined};
}
export function listRepertoire(db,params=new URLSearchParams()){
 const kind=params.get('kind'),status=params.get('status'),q=(params.get('q')||'').toLowerCase();
 if((kind&&!KINDS.includes(kind))||(status&&!STATUSES.includes(status)))throw new Error('BAD_REQUEST');
 const rows=db.prepare('SELECT id FROM repertoire_items WHERE deleted_at IS NULL AND (? IS NULL OR kind=?) AND (? IS NULL OR learning_status=?) ORDER BY created_at DESC,id').all(kind,kind,status,status);
 return {items:rows.map(r=>getRepertoire(db,r.id)).filter(r=>!q||`${r.title} ${r.artist}`.toLowerCase().includes(q))};
}
export function saveRepertoire(db,id,body){
 const prior=id?getRepertoire(db,id):null;if(id&&!prior)throw Object.assign(new Error('NOT_FOUND'),{status:404});
 const kind=prior?.kind||body.kind;validate(body,kind,!id);
 const value={kind,title:'',artist:'',learningStatus:'WANT_TO_LEARN',originalKey:'',performanceKey:'',capo:0,scoreText:'',notes:'',audioRole:'REFERENCE',...prior,...body};
 const nextId=id||body.clientId||randomUUID();
 if(!id&&body.clientId){const exists=getRepertoire(db,nextId);if(exists){if(exists.kind!==kind)throw Error('BAD_REQUEST');return exists;}}
 db.exec('BEGIN IMMEDIATE');
 try{
  if(!id)db.prepare('INSERT INTO repertoire_items(id,kind,title) VALUES(?,?,?)').run(nextId,kind,value.title.trim());
  db.prepare('UPDATE repertoire_items SET title=?,artist=?,learning_status=?,original_key=?,performance_key=?,capo=?,score_text=?,notes=?,audio_role=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(value.title.trim(),value.artist.trim(),value.learningStatus,value.originalKey.trim(),value.performanceKey.trim(),value.capo,value.scoreText,value.notes,value.audioRole,nextId);
  bumpCatalog(db);db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 return getRepertoire(db,nextId);
}
export function attachRepertoireMedia(db,id,body){
 const item=getRepertoire(db,id);if(!item)throw Object.assign(new Error('NOT_FOUND'),{status:404});
 if(!body||Object.keys(body).some(k=>!['importJobId','audioRole'].includes(k))||typeof body.importJobId!=='string'||(body.audioRole!==undefined&&!['REFERENCE','ACCOMPANIMENT'].includes(body.audioRole)))throw new Error('BAD_REQUEST');
 const row=db.prepare('SELECT status,draft_json FROM import_jobs WHERE id=?').get(body.importJobId);
 const draft=row?JSON.parse(row.draft_json||'{}'):null;
 if(draft?.finalizedRepertoireId===id)return item;
 if(!draft?.clip||row.status!=='READY'||draft.finalizedId||draft.finalizedRepertoireId)throw new Error('IMPORT_NOT_READY');
 db.exec('BEGIN IMMEDIATE');
 try{
  db.prepare('UPDATE repertoire_items SET source_media_id=?,performance_clip_id=?,cover_asset_id=?,audio_role=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(draft.sourceId,draft.clip.id,draft.cover?.id||null,body.audioRole||item.audioRole,id);
  draft.finalizedRepertoireId=id;db.prepare('UPDATE import_jobs SET draft_json=? WHERE id=?').run(JSON.stringify(draft),body.importJobId);
  bumpCatalog(db);db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 return getRepertoire(db,id);
}
export function deleteRepertoire(db,id){
 if(!getRepertoire(db,id))throw Object.assign(new Error('NOT_FOUND'),{status:404});
 db.exec('BEGIN IMMEDIATE');try{removeFromProgram(db,[{kind:getRepertoire(db,id).kind,id}]);db.prepare('UPDATE repertoire_items SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(id);bumpCatalog(db);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 return {deleted:true,mediaDeleted:0};
}
