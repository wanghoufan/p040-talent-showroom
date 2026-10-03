import {ensureDemoScore} from './demo-scores.mjs';
import { randomUUID } from 'node:crypto';
import { mkdirSync,writeFileSync,unlinkSync,renameSync,existsSync } from 'node:fs';
import { join,relative } from 'node:path';
import { extractAudio,fileIdentity } from '../media/ffmpeg.mjs';
import { bumpCatalog,getDance } from '../catalog.mjs';
import { getRepertoire } from '../repertoire/service.mjs';
import { removeFromProgram } from '../program/service.mjs';
import { controlledPath } from '../security/paths.mjs';
const presets=[{kind:'DANCE',slot:'dance-v1',title:'示例 · 节拍练习',freq:220,text:''},{kind:'GUITAR',slot:'guitar-v1',title:'示例 · 四和弦练习',freq:330,text:'C        G\n每一拍慢慢弹响\nAm       F\n让指尖跟上节拍\n\n和弦：C → G → Am → F\n每个和弦四拍；先慢练，再循环。'},{kind:'VOCAL',slot:'vocal-v1',title:'示例 · 发声练习',freq:440,text:'轻轻吸气，慢慢唱起\n跟着节拍，保持呼吸\n啦——啦——\n让声音自然延续\n\n这是一段原创试用歌词，不代表真实歌曲。'}];
function wave(freq){const rate=16000,count=rate*8,buffer=Buffer.alloc(44+count*2);buffer.write('RIFF');buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(rate,24);buffer.writeUInt32LE(rate*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(count*2,40);for(let i=0;i<count;i++){const phase=(i%8000)/rate;const envelope=Math.max(0,1-phase*8);buffer.writeInt16LE(Math.round(3500*envelope*Math.sin(2*Math.PI*freq*i/rate)),44+i*2);}return buffer;}
export function listDemo(db){return {items:db.prepare('SELECT kind,item_id AS id,slot FROM demo_records').all().map(r=>r.kind==='DANCE'?getDance(db,r.id):getRepertoire(db,r.id)).filter(Boolean)};}
let importing=false;
export async function importDemo(db,mediaRoot){if(importing)throw Error('BUSY');importing=true;try{
 for(const p of presets){const prior=db.prepare('SELECT kind,item_id AS id FROM demo_records WHERE slot=?').get(p.slot);if(prior){await ensureDemoScore(db,mediaRoot,prior);continue;}
  const sourceId=randomUUID(),clipId=randomUUID(),id=randomUUID(),songId=randomUUID();mkdirSync(join(mediaRoot,'source'),{recursive:true});mkdirSync(join(mediaRoot,'audio'),{recursive:true});const source=join(mediaRoot,'source',sourceId+'.wav');writeFileSync(source,wave(p.freq));let clip,committed=false;
  try{clip=await extractAudio(source,join(mediaRoot,'audio',clipId),{audioCodec:'pcm_s16le',durationMs:8000});const hash=await fileIdentity(source);db.exec('BEGIN IMMEDIATE');
   db.prepare("INSERT INTO source_media(id,source_kind,internal_path,sha256,duration_ms,audio_codec,container) VALUES(?,'AUDIO',?,?,8000,'pcm_s16le','wav')").run(sourceId,relative(mediaRoot,source),hash.sha256);
   db.prepare("INSERT INTO performance_clips(id,source_media_id,start_ms,end_ms,internal_audio_path,codec,source_preserving,sha256,size_bytes,duration_ms) VALUES(?,?,0,8000,?,'aac',0,?,?,8000)").run(clipId,sourceId,relative(mediaRoot,clip.path),clip.sha256,clip.sizeBytes);
   if(p.kind==='DANCE'){db.prepare("INSERT INTO song_identities(id,title,artist,recognition_status) VALUES(?,?,'原创示例','MANUAL')").run(songId,p.title);db.prepare("INSERT INTO dance_items(id,song_identity_id,source_media_id,performance_clip_id,learning_status,scene_mask) VALUES(?,?,?,?,'WANT_TO_LEARN',0)").run(id,songId,sourceId,clipId);}
   else db.prepare("INSERT INTO repertoire_items(id,kind,title,artist,learning_status,original_key,performance_key,capo,score_text,audio_role,source_media_id,performance_clip_id) VALUES(?,?,?,'原创示例','WANT_TO_LEARN','C','C',0,?,?,?,?)").run(id,p.kind,p.title,p.text,p.kind==='VOCAL'?'ACCOMPANIMENT':'REFERENCE',sourceId,clipId);
   db.prepare('INSERT INTO demo_records(kind,item_id,slot,media_json) VALUES(?,?,?,?)').run(p.kind,id,p.slot,JSON.stringify([relative(mediaRoot,source),relative(mediaRoot,clip.path)]));bumpCatalog(db);db.exec('COMMIT');committed=true;await ensureDemoScore(db,mediaRoot,{kind:p.kind,id});
  }catch(e){if(db.isTransaction)db.exec('ROLLBACK');if(!committed)for(const path of [source,clip?.path].filter(Boolean))try{unlinkSync(path);}catch{/* Retain original error. */}throw e;}
 }return listDemo(db);
 }finally{importing=false;}}
export function clearDemo(db,mediaRoot){
 const records=db.prepare('SELECT * FROM demo_records').all(),refs=records.map(r=>({kind:r.kind,id:r.item_id}));const moved=[];const removedMedia=[];
 db.exec('BEGIN IMMEDIATE');try{
  removeFromProgram(db,refs);
  for(const r of records){const table=r.kind==='DANCE'?'dance_items':'repertoire_items';const row=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(r.item_id);if(r.kind==='DANCE')db.prepare('DELETE FROM tonight_playlist_items WHERE dance_item_id=?').run(r.item_id);db.prepare(`DELETE FROM ${table} WHERE id=?`).run(r.item_id);
   const scoreFiles=db.prepare('SELECT a.id,a.internal_path FROM score_links l JOIN score_assets a ON a.id=l.asset_id WHERE l.kind=? AND l.item_id=?').all(r.kind,r.item_id);db.prepare('DELETE FROM score_links WHERE kind=? AND item_id=?').run(r.kind,r.item_id);for(const score of scoreFiles){if(!JSON.parse(r.media_json).includes(score.internal_path)||db.prepare('SELECT count(*) AS n FROM score_links WHERE asset_id=?').get(score.id).n)continue;const path=controlledPath(mediaRoot,score.internal_path);if(existsSync(path)){const q=path+'.delete-'+randomUUID();renameSync(path,q);moved.push([path,q]);}removedMedia.push(score.id);}
   if(!row)continue;
   // 当前记录删除后检查两类曲库，包括回收站，任何引用都保护文件。
   const sources=row.source_media_id?db.prepare('SELECT internal_path FROM source_media WHERE id=?').get(row.source_media_id):null,clip=row.performance_clip_id?db.prepare('SELECT internal_audio_path AS internal_path FROM performance_clips WHERE id=?').get(row.performance_clip_id):null;
   for(const [col,value,file] of [['source_media_id',row.source_media_id,sources],['performance_clip_id',row.performance_clip_id,clip]]){
    if(!value||!file||!JSON.parse(r.media_json).includes(file.internal_path))continue;const count=['dance_items','repertoire_items'].reduce((n,t)=>n+db.prepare(`SELECT count(*) AS n FROM ${t} WHERE ${col}=?`).get(value).n,0);if(count)continue;
    const path=controlledPath(mediaRoot,file.internal_path);if(existsSync(path)){const quarantine=path+'.delete-'+randomUUID();renameSync(path,quarantine);moved.push([path,quarantine]);}removedMedia.push(value);
   }
  }db.exec('DELETE FROM demo_records');bumpCatalog(db);db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');for(const [path,q] of moved.reverse())renameSync(q,path);throw e;}
 for(const [,q] of moved)try{unlinkSync(q);}catch{/* Quarantined files are no longer served. */}
 return {cleared:refs,removedMedia};
}
