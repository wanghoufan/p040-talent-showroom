import {getDance} from './catalog.mjs';import {getRepertoire,saveRepertoire} from './repertoire/service.mjs';
import {createHash} from 'node:crypto';
import {validateRefs,rowFor,itemFor,tableFor} from './library/refs.mjs';import {validateFields,bulkLibrary} from './library/service.mjs';import {STATUSES,sceneMask,bumpCatalog} from './catalog.mjs';import {getProgram,writeProgram,removeFromProgram} from './program/service.mjs';
const columns={title:'title',artist:'artist',learningStatus:'learning_status',sceneTags:'scene_mask',originalKey:'original_key',performanceKey:'performance_key',capo:'capo',scoreText:'score_text',notes:'notes',audioRole:'audio_role'};
// 唱歌元数据：只允许显式白名单字段，绝不把任意对象直接写进列映射。
const VOCAL_METADATA=['language','lyrics','sections','practice'];
const VOCAL_LANGUAGES=['zh','en','ko'];
// 离线队列只用于小改动；完整歌词/结构分析走专用接口，避免单条同步操作里塞大 JSON。
const MAX_VOCAL_BYTES=65536;

/**
 * 唱歌元数据的唯一同步写入路径：体积/类型先拦，baseRevision 必须精确匹配，
 * 再交给服务层 saveRepertoire 做结构、歌词、练习设置与人工覆盖校验（含事务）。
 */
function applyVocalOperation(db,op,vocal,hash){
 if(op.action!=='update')throw Error('BAD_REQUEST');
 if(JSON.stringify(op.fields).length>MAX_VOCAL_BYTES)throw Object.assign(new Error('PAYLOAD_TOO_LARGE'),{status:413});
 if(vocal.language!==undefined&&!VOCAL_LANGUAGES.includes(vocal.language))throw Error('BAD_REQUEST');
 if(vocal.lyrics!==undefined&&!Array.isArray(vocal.lyrics))throw Error('BAD_REQUEST');
 if(vocal.sections!==undefined&&!Array.isArray(vocal.sections))throw Error('BAD_REQUEST');
 if(vocal.practice!==undefined&&(!vocal.practice||typeof vocal.practice!=='object'||Array.isArray(vocal.practice)))throw Error('BAD_REQUEST');
 const ref={kind:op.kind,id:op.id},current=rowFor(db,ref),revision=current?.revision||0;
 if(!current||current.deleted_at||revision!==op.baseRevision)return {status:'conflict',revision,server:current?{...getRepertoire(db,op.id,true),deletedAt:current.deleted_at}:null};
 const plain=Object.fromEntries(Object.entries(op.fields).filter(([key])=>!VOCAL_METADATA.includes(key)));
 // 业务数据与 operation_results 必须同事务提交：崩溃后重试要么都生效（走幂等回放），要么都没发生。
 db.exec('BEGIN IMMEDIATE');
 try{
  const item=saveRepertoire(db,op.id,{...plain,...vocal},{inTransaction:true});
  const row=rowFor(db,ref),result={status:'applied',revision:row.revision,programRevision:getProgram(db).revision,item};
  db.prepare('INSERT INTO operation_results(id,fingerprint,result_json) VALUES(?,?,?)').run(op.operationId,hash,JSON.stringify(result));
  db.exec('COMMIT');
  return JSON.parse(JSON.stringify(result));
 }catch(error){db.exec('ROLLBACK');throw error;}
}
export function syncOperation(db,op){
 if(!op||Object.keys(op).some(k=>!['operationId','kind','id','action','baseRevision','fields'].includes(k))||typeof op.operationId!=='string'||!/^[0-9a-f-]{36}$/.test(op.operationId)||!['create','update','trash','restore','program','bulk'].includes(op.action)||!Number.isInteger(op.baseRevision)||op.baseRevision<0)throw Error('BAD_REQUEST');
 const hash=createHash('sha256').update(JSON.stringify(op)).digest('hex'),prior=db.prepare('SELECT * FROM operation_results WHERE id=?').get(op.operationId);if(prior){if(prior.fingerprint!==hash)throw Error('BAD_REQUEST');return JSON.parse(prior.result_json);}
 if(op.action==='bulk'){
 const f=op.fields;if(!f||!['update','trash','restore'].includes(f.action))throw Error('BAD_REQUEST');validateRefs(f.refs);if(!f.baseRevisions||typeof f.baseRevisions!=='object')throw Error('BAD_REQUEST');if(f.action==='update')f.refs.forEach(r=>validateFields(r.kind,f.fields));
 const changed=f.refs.filter(r=>rowFor(db,r)?.revision!==f.baseRevisions[r.id]);if(changed.length)return {status:'conflict',revision:0,server:{items:f.refs.map(r=>({...(r.kind==='DANCE'?getDance(db,r.id,true):getRepertoire(db,r.id,true)),kind:r.kind,id:r.id,revision:rowFor(db,r)?.revision||0,deletedAt:rowFor(db,r)?.deleted_at}))}};
 return bulkLibrary(db,{operationId:op.operationId,action:f.action,refs:f.refs,...(f.fields?{fields:f.fields}:{})},{fingerprint:hash,sync:true});
 }
 const ref={kind:op.kind,id:op.id};if(op.action!=='program')validateRefs([ref]);let fields=op.fields;
 if(['create','update'].includes(op.action)||op.action==='restore'&&fields){
  if(!fields||typeof fields!=='object'||Array.isArray(fields)||!Object.keys(fields).length)throw Error('BAD_REQUEST');
  const allowed=op.kind==='DANCE'?['title','artist','learningStatus','sceneTags']:[...Object.keys(columns).filter(k=>k!=='sceneTags'),...VOCAL_METADATA];if(Object.keys(fields).some(k=>!allowed.includes(k)))throw Error('BAD_REQUEST');
  // 吉他不接受唱歌字段，避免把旧单音轨结构当成双音轨/歌词数据。
  if(op.kind!=='VOCAL'&&VOCAL_METADATA.some(k=>fields[k]!==undefined))throw Error('BAD_REQUEST');
  if(op.action==='create'&&(op.kind==='DANCE'||!fields.title?.trim()))throw Error('BAD_REQUEST');
  for(const [key,max] of [['title',200],['artist',200],['originalKey',40],['performanceKey',40],['scoreText',50000],['notes',10000]])if(fields[key]!==undefined&&(typeof fields[key]!=='string'||fields[key].length>max||(key==='title'&&!fields[key].trim())))throw Error('BAD_REQUEST');
  if(fields.learningStatus!==undefined&&!STATUSES.includes(fields.learningStatus))throw Error('BAD_REQUEST');if(fields.sceneTags!==undefined)sceneMask(fields.sceneTags);
  const classification=Object.fromEntries(Object.entries(fields).filter(([k])=>['learningStatus','originalKey','performanceKey','capo','audioRole'].includes(k)));if(op.kind==='GUITAR'&&classification.audioRole!==undefined){if(!['REFERENCE','ACCOMPANIMENT'].includes(classification.audioRole))throw Error('BAD_REQUEST');delete classification.audioRole;}if(op.kind==='VOCAL'&&classification.capo!==undefined){if(classification.capo!==0)throw Error('BAD_REQUEST');delete classification.capo;}if(Object.keys(classification).length)validateFields(op.kind,classification);
  const vocal=op.kind==='VOCAL'?Object.fromEntries(Object.entries(fields).filter(([key])=>VOCAL_METADATA.includes(key))):null;
  if(vocal&&Object.keys(vocal).length)return applyVocalOperation(db,op,vocal,hash);
 }else if(op.action==='program'){if(!fields||Object.keys(fields).some(k=>k!=='items'))throw Error('BAD_REQUEST');validateRefs(fields.items,{empty:true,max:200});}else if(fields!==undefined)throw Error('BAD_REQUEST');
 db.exec('BEGIN IMMEDIATE');try{
  const current=op.action==='program'?getProgram(db):rowFor(db,ref);const revision=current?.revision||0;
  if((op.action==='update'&&current?.deleted_at)||revision!==op.baseRevision||(op.action!=='create'&&!current)||(op.action==='create'&&current)){db.exec('ROLLBACK');return {status:'conflict',revision,server:op.action==='program'?current:current?{...(op.kind==='DANCE'?getDance(db,op.id,true):getRepertoire(db,op.id,true)),deletedAt:current.deleted_at}:null};}
  if(op.action==='program'){if(fields.items.some(r=>!itemFor(db,r)))throw Error('NOT_FOUND');writeProgram(db,fields.items);}
  else{const table=tableFor(op.kind);if(op.action==='create')db.prepare('INSERT INTO repertoire_items(id,kind,title) VALUES(?,?,?)').run(op.id,op.kind,fields.title.trim());
   if(['create','update'].includes(op.action)||op.action==='restore'&&fields){if(op.action==='restore')db.prepare(`UPDATE ${table} SET deleted_at=NULL WHERE id=?`).run(op.id);if(current?.deleted_at&&op.action!=='restore')throw Error('NOT_FOUND');const values={};for(const [key,value] of Object.entries(fields)){if(op.kind==='DANCE'&&key==='artist'){db.prepare('UPDATE song_identities SET artist=? WHERE id=?').run(value,current.song_identity_id);continue;}values[op.kind==='DANCE'&&key==='title'?'title_override':columns[key]]=key==='sceneTags'?sceneMask(value):value;}const keys=Object.keys(values);if(keys.length)db.prepare(`UPDATE ${table} SET ${keys.map(k=>k+'=?').join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...Object.values(values),op.id);else db.prepare(`UPDATE ${table} SET updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(op.id);}
   else{if(op.action==='trash'){removeFromProgram(db,[ref]);if(op.kind==='DANCE')db.prepare('DELETE FROM tonight_playlist_items WHERE dance_item_id=?').run(op.id);}db.prepare(`UPDATE ${table} SET deleted_at=${op.action==='restore'?'NULL':'CURRENT_TIMESTAMP'},updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(op.id);}
  }bumpCatalog(db);const row=op.action==='program'?getProgram(db):rowFor(db,ref);const result={status:'applied',revision:row.revision,programRevision:getProgram(db).revision,...(op.action==='trash'?{program:getProgram(db)}:{}),item:op.action==='program'?getProgram(db):itemFor(db,ref)};db.prepare('INSERT INTO operation_results(id,fingerprint,result_json) VALUES(?,?,?)').run(op.operationId,hash,JSON.stringify(result));db.exec('COMMIT');return JSON.parse(JSON.stringify(result));
 }catch(e){db.exec('ROLLBACK');throw e;}
}
