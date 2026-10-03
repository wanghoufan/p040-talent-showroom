import {getDance} from '../catalog.mjs';
import {getRepertoire} from '../repertoire/service.mjs';
import { createHash } from 'node:crypto';
import { STATUSES,sceneMask,bumpCatalog } from '../catalog.mjs';
import { validateRefs,rowFor,tableFor,itemFor } from './refs.mjs';
import { getProgram,removeFromProgram } from '../program/service.mjs';
export function validateFields(kind,fields){
 if(!fields||typeof fields!=='object'||Array.isArray(fields)||!Object.keys(fields).length)throw Error('BAD_REQUEST');
 const allowed=kind==='DANCE'?['learningStatus','sceneMode','sceneTags']:['learningStatus','originalKey','performanceKey',...(kind==='GUITAR'?['capo']:['audioRole'])];
 if(Object.keys(fields).some(k=>!allowed.includes(k)))throw Error('BAD_REQUEST');
 if(fields.learningStatus!==undefined&&!STATUSES.includes(fields.learningStatus))throw Error('INVALID_STATUS');
 if(fields.sceneTags!==undefined){sceneMask(fields.sceneTags);if(!['add','remove','replace'].includes(fields.sceneMode)||(fields.sceneMode!=='replace'&&!fields.sceneTags.length))throw Error('INVALID_TAGS');}else if(fields.sceneMode!==undefined)throw Error('BAD_REQUEST');
 for(const k of ['originalKey','performanceKey'])if(fields[k]!==undefined&&(typeof fields[k]!=='string'||fields[k].length>40))throw Error('BAD_REQUEST');
 if(fields.capo!==undefined&&(!Number.isInteger(fields.capo)||fields.capo<0||fields.capo>12))throw Error('BAD_REQUEST');
 if(fields.audioRole!==undefined&&!['REFERENCE','ACCOMPANIMENT'].includes(fields.audioRole))throw Error('BAD_REQUEST');
}
export function listTrash(db){return {items:[...db.prepare(`SELECT d.id,'DANCE' AS kind,COALESCE(d.title_override,s.title,'舞蹈') AS title,d.deleted_at AS deletedAt,d.revision FROM dance_items d LEFT JOIN song_identities s ON s.id=d.song_identity_id WHERE d.deleted_at IS NOT NULL`).all(),...db.prepare('SELECT id,kind,title,deleted_at AS deletedAt,revision FROM repertoire_items WHERE deleted_at IS NOT NULL').all()].map(r=>({...r,...(r.kind==='DANCE'?getDance(db,r.id,true):getRepertoire(db,r.id,true))}))};}
export function bulkLibrary(db,body,options={}){
 if(!body||Object.keys(body).some(k=>!['operationId','action','refs','fields'].includes(k))||typeof body.operationId!=='string'||!/^[0-9a-f-]{36}$/.test(body.operationId)||!['update','trash','restore','purge'].includes(body.action))throw Error('BAD_REQUEST');
 validateRefs(body.refs);const fingerprint=options.fingerprint||createHash('sha256').update(JSON.stringify(body)).digest('hex');const prior=db.prepare('SELECT * FROM operation_results WHERE id=?').get(body.operationId);if(prior){if(prior.fingerprint!==fingerprint)throw Error('BAD_REQUEST');return JSON.parse(prior.result_json);}
 if(body.action==='update')body.refs.forEach(r=>validateFields(r.kind,body.fields));else if(body.fields!==undefined)throw Error('BAD_REQUEST');
 db.exec('BEGIN IMMEDIATE');try{
  const rows=body.refs.map(ref=>{const row=rowFor(db,ref);if(!row||(['update','trash'].includes(body.action)?row.deleted_at!==null:row.deleted_at===null))throw Error('NOT_FOUND');return {ref,row};});
  if(['trash','purge'].includes(body.action)){removeFromProgram(db,body.refs);for(const r of body.refs)if(r.kind==='DANCE')db.prepare('DELETE FROM tonight_playlist_items WHERE dance_item_id=?').run(r.id);}
  for(const {ref,row} of rows){const table=tableFor(ref.kind);
   if(body.action==='purge'){db.prepare('DELETE FROM score_links WHERE kind=? AND item_id=?').run(ref.kind,ref.id);db.prepare('DELETE FROM demo_records WHERE kind=? AND item_id=?').run(ref.kind,ref.id);db.prepare(`DELETE FROM ${table} WHERE id=?`).run(ref.id);}
   else if(body.action!=='update')db.prepare(`UPDATE ${table} SET deleted_at=${body.action==='restore'?'NULL':'CURRENT_TIMESTAMP'},updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(ref.id);
   else{const fields=body.fields;const values={};if(fields.learningStatus!==undefined)values.learning_status=fields.learningStatus;
    if(ref.kind==='DANCE'&&fields.sceneTags!==undefined){const mask=sceneMask(fields.sceneTags);values.scene_mask=fields.sceneMode==='add'?row.scene_mask|mask:fields.sceneMode==='remove'?row.scene_mask&~mask:mask;}
    for(const [key,col] of [['originalKey','original_key'],['performanceKey','performance_key'],['capo','capo'],['audioRole','audio_role']])if(fields[key]!==undefined)values[col]=fields[key];
    const cols=Object.keys(values);db.prepare(`UPDATE ${table} SET ${cols.map(k=>`${k}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...Object.values(values),ref.id);
   }
  }
  bumpCatalog(db);const result={...(options.sync?{status:'applied',revision:0}:{}),action:body.action,refs:body.refs,items:body.refs.map(r=>itemFor(db,r)).filter(Boolean),revisions:body.refs.map(r=>({...r,revision:rowFor(db,r)?.revision||0})),programRevision:getProgram(db).revision,...(body.action==='trash'?{program:getProgram(db)}:{}),catalogVersion:db.prepare('SELECT catalog_version FROM catalog_meta WHERE singleton=1').get().catalog_version};db.prepare('INSERT INTO operation_results(id,fingerprint,result_json) VALUES(?,?,?)').run(body.operationId,fingerprint,JSON.stringify(result));db.exec('COMMIT');return JSON.parse(JSON.stringify(result));
 }catch(e){db.exec('ROLLBACK');throw e;}
}
