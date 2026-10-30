import {listScores} from '../scores/service.mjs';
import { removeFromProgram } from '../program/service.mjs';
import { randomUUID } from 'node:crypto';
import { STATUSES, bumpCatalog } from '../catalog.mjs';

const KINDS=['GUITAR','VOCAL'];
const BASE_FIELDS=['clientId','kind','title','artist','learningStatus','originalKey','performanceKey','capo','scoreText','notes','audioRole'];
const VOCAL_FIELDS=['language','lyrics','sections','practice'];
const fields=[...BASE_FIELDS,...VOCAL_FIELDS];
const TRACK_ROLES=['original','accompaniment'];
const LEGACY_ROLE={original:'REFERENCE',accompaniment:'ACCOMPANIMENT'};
const ROLE_OF={REFERENCE:'original',ACCOMPANIMENT:'accompaniment'};
const SECTION_TYPES=['intro','verse','pre','chorus','bridge','rap','outro','unknown'];
const REPETITIONS=['exact-lyrics','same-melody-new-lyrics','unverified'];
const SOURCES=['manual','algorithm'];
const LANGUAGES=['zh','en','ko'];
const STEPS=[5,10,15,30];
const PRACTICE_DEFAULTS={skipRap:false,wholeTrackLoop:false,backwardSeconds:5,forwardSeconds:10,customRepeatLines:2,playbackRate:1};
const PRACTICE_FIELDS=Object.keys(PRACTICE_DEFAULTS);
const MAX_SECTIONS=200,MAX_LYRICS=1000,MAX_OFFSET_MS=60000;

const isId=value=>typeof value==='string'&&value.length>0&&value.length<=64;
function parseJson(text,fallback){try{const value=JSON.parse(text);return value??fallback}catch{return fallback}}
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
 // 唱歌专属字段不得写入吉他，避免把旧吉他的单音轨结构当成双音轨。
 if(kind!=='VOCAL'&&VOCAL_FIELDS.some(key=>body[key]!==undefined))throw new Error('BAD_REQUEST');
}

/** 人工结构：半开区间、类型/标签/重复依据校验；相邻或重叠的 Rap 合并去重，其他重叠拒绝。 */
function normalizeSections(input){
 if(!Array.isArray(input)||input.length>MAX_SECTIONS)throw Error('INVALID_SECTIONS');
 const seen=new Set();
 const rows=input.map(raw=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('INVALID_SECTIONS');
  if(!isId(raw.id)||seen.has(raw.id))throw Error('INVALID_SECTIONS');seen.add(raw.id);
  if(!SECTION_TYPES.includes(raw.type)||typeof raw.label!=='string'||!raw.label.trim()||raw.label.length>40)throw Error('INVALID_SECTIONS');
  if(!Number.isInteger(raw.startMs)||!Number.isInteger(raw.endMs)||raw.startMs<0||raw.endMs<=raw.startMs)throw Error('INVALID_SECTIONS');
  if(raw.repetition!==undefined&&!REPETITIONS.includes(raw.repetition))throw Error('INVALID_SECTIONS');
  if(raw.repeatOf!==undefined&&(!isId(raw.repeatOf)||raw.repeatOf===raw.id))throw Error('INVALID_SECTIONS');
  const source=raw.source===undefined?'manual':raw.source;if(!SOURCES.includes(source))throw Error('INVALID_SECTIONS');
  return {id:raw.id,type:raw.type,label:raw.label.trim(),startMs:raw.startMs,endMs:raw.endMs,...(raw.repeatOf?{repeatOf:raw.repeatOf}:{}),...(raw.repetition?{repetition:raw.repetition}:{}),source};
 });
 const ordered=[...rows].sort((a,b)=>a.startMs-b.startMs||a.endMs-b.endMs||a.id.localeCompare(b.id));
 const alias=new Map(),merged=[];
 for(const row of ordered){
  const last=merged[merged.length-1];
  if(last&&row.type==='rap'&&last.type==='rap'&&row.startMs<=last.endMs){alias.set(row.id,last.id);last.endMs=Math.max(last.endMs,row.endMs);continue;}
  if(last&&row.startMs<last.endMs)throw Error('INVALID_SECTIONS');
  merged.push({...row});
 }
 const ids=new Set(merged.map(row=>row.id));
 // 被合并掉的 Rap id 仍可能被 repeatOf / 歌词引用，统一改指保留段。
 const remap=id=>alias.get(id)||id;
 return {sections:merged.map(row=>{const out={...row};if(out.repeatOf){const target=remap(out.repeatOf);if(target===out.id)delete out.repeatOf;else if(!ids.has(target))throw Error('INVALID_SECTIONS');else out.repeatOf=target;}return out}),alias};
}

/** 逐句歌词：时间非递减、句尾必须晚于句首、sectionId 必须指向已有段落。 */
function normalizeLyrics(input,sectionIds){
 if(!Array.isArray(input)||input.length>MAX_LYRICS)throw Error('INVALID_LYRICS');
 const seen=new Set();let lastStart=-1;
 return input.map((raw,index)=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('INVALID_LYRICS');
  const id=raw.id===undefined?`line-${index+1}`:raw.id;
  if(!isId(id)||seen.has(id))throw Error('INVALID_LYRICS');seen.add(id);
  if(!Number.isInteger(raw.startMs)||raw.startMs<0||raw.startMs<lastStart)throw Error('INVALID_LYRICS');lastStart=raw.startMs;
  if(typeof raw.text!=='string'||!raw.text.trim()||raw.text.length>500)throw Error('INVALID_LYRICS');
  if(raw.endMs!==undefined&&(!Number.isInteger(raw.endMs)||raw.endMs<=raw.startMs))throw Error('INVALID_LYRICS');
  if(raw.sectionId!==undefined&&(!isId(raw.sectionId)||!sectionIds.has(raw.sectionId)))throw Error('INVALID_LYRICS');
  return {id,startMs:raw.startMs,text:raw.text.trim(),...(raw.sectionId?{sectionId:raw.sectionId}:{}),...(raw.endMs!==undefined?{endMs:raw.endMs}:{})};
 });
}

function normalizePractice(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!PRACTICE_FIELDS.includes(key)))throw Error('INVALID_PRACTICE');
 const value={...PRACTICE_DEFAULTS,...input};
 if(typeof value.skipRap!=='boolean'||typeof value.wholeTrackLoop!=='boolean')throw Error('INVALID_PRACTICE');
 if(!STEPS.includes(value.backwardSeconds)||!STEPS.includes(value.forwardSeconds))throw Error('INVALID_PRACTICE');
 if(!Number.isInteger(value.customRepeatLines)||value.customRepeatLines<1||value.customRepeatLines>100)throw Error('INVALID_PRACTICE');
 if(typeof value.playbackRate!=='number'||!Number.isFinite(value.playbackRate)||value.playbackRate<0.5||value.playbackRate>2)throw Error('INVALID_PRACTICE');
 return value;
}

/** 结构/歌词编辑后清理失效的 sectionId，保证逐句与结构不互相悬空。 */
function reconcileLyrics(lyrics,alias,sectionIds){
 return lyrics.map(line=>{
  if(!line.sectionId)return line;
  const target=alias.get(line.sectionId)||line.sectionId;
  if(!sectionIds.has(target)){const rest={...line};delete rest.sectionId;return rest;}
  return target===line.sectionId?line:{...line,sectionId:target};
 });
}

function clipMedia(db,id){
 const clip=db.prepare('SELECT sha256,size_bytes,version,start_ms,end_ms,source_preserving,duration_ms FROM performance_clips WHERE id=?').get(id);
 return clip?{id,url:`/api/media/audio/${id}`,sha256:clip.sha256,sizeBytes:clip.size_bytes,version:clip.version,startMs:clip.start_ms,endMs:clip.end_ms,sourcePreserving:!!clip.source_preserving,durationMs:clip.duration_ms}:null;
}
/** 旧单音轨按 audioRole 精确映射：REFERENCE→原唱，ACCOMPANIMENT→伴奏，另一轨保持缺失。 */
function readTracks(db,row){
 let original=row.original_clip_id,accompaniment=row.accompaniment_clip_id;
 if(!original&&!accompaniment&&row.performance_clip_id){
  if(ROLE_OF[row.audio_role]==='accompaniment')accompaniment=row.performance_clip_id;else original=row.performance_clip_id;
 }
 const tracks={};
 const originalMedia=original?clipMedia(db,original):null;
 if(originalMedia)tracks.original={media:originalMedia,offsetMs:original===row.original_clip_id?row.original_offset_ms:0};
 const accompanimentMedia=accompaniment?clipMedia(db,accompaniment):null;
 if(accompanimentMedia)tracks.accompaniment={media:accompanimentMedia,offsetMs:accompaniment===row.accompaniment_clip_id?row.accompaniment_offset_ms:0};
 return tracks;
}
const maxDuration=item=>Math.max(item?.durationMs||0,...Object.values(item?.tracks||{}).map(track=>track.media?.durationMs||0));

export function getRepertoire(db,id,includeDeleted=false){
 const r=db.prepare(`SELECT r.*,c.sha256 AS audio_hash,c.size_bytes AS audio_size,c.version AS audio_version,c.duration_ms,c.start_ms,c.end_ms,c.source_preserving,m.source_kind,m.source_locator,m.sha256 AS source_hash,m.duration_ms AS source_duration,a.sha256 AS cover_hash,a.size_bytes AS cover_size FROM repertoire_items r LEFT JOIN performance_clips c ON c.id=r.performance_clip_id LEFT JOIN source_media m ON m.id=r.source_media_id LEFT JOIN assets a ON a.id=r.cover_asset_id WHERE r.id=? AND (r.deleted_at IS NULL OR ?)`).get(id,includeDeleted?1:0);
 if(!r)return null;
 const item={scores:listScores(db,{kind:r.kind,id:r.id}),revision:r.revision,isDemo:!!db.prepare("SELECT 1 FROM demo_records WHERE kind=? AND item_id=?").get(r.kind,r.id),id:r.id,kind:r.kind,title:r.title,artist:r.artist,learningStatus:r.learning_status,originalKey:r.original_key,performanceKey:r.performance_key,capo:r.capo,scoreText:r.score_text,notes:r.notes,audioRole:r.audio_role,sourceMediaId:r.source_media_id||undefined,performanceClipId:r.performance_clip_id||undefined,durationMs:r.duration_ms||0,
  audio:r.performance_clip_id?{id:r.performance_clip_id,url:`/api/media/audio/${r.performance_clip_id}`,sha256:r.audio_hash,sizeBytes:r.audio_size,version:r.audio_version,startMs:r.start_ms,endMs:r.end_ms,sourcePreserving:!!r.source_preserving}:undefined,
  cover:r.cover_asset_id?{id:r.cover_asset_id,url:`/api/media/cover/${r.cover_asset_id}`,sha256:r.cover_hash,sizeBytes:r.cover_size,version:1}:undefined,
  source:r.source_media_id?{id:r.source_media_id,sourceKind:r.source_kind,sourceLocator:r.source_locator||undefined,sha256:r.source_hash,durationMs:r.source_duration}:undefined};
 if(r.kind==='VOCAL'){
  const tracks=readTracks(db,r);
  item.language=r.vocal_language||undefined;
  item.lyrics=parseJson(r.lyrics_json,[]);
  item.sections=parseJson(r.sections_json,[]);
  item.practice={...PRACTICE_DEFAULTS,...parseJson(r.practice_json,{})};
  item.tracks=Object.keys(tracks).length?tracks:undefined;
 }
 return item;
}
export function listRepertoire(db,params=new URLSearchParams()){
 const kind=params.get('kind'),status=params.get('status'),q=(params.get('q')||'').toLowerCase();
 if((kind&&!KINDS.includes(kind))||(status&&!STATUSES.includes(status)))throw new Error('BAD_REQUEST');
 const rows=db.prepare('SELECT id FROM repertoire_items WHERE deleted_at IS NULL AND (? IS NULL OR kind=?) AND (? IS NULL OR learning_status=?) ORDER BY created_at DESC,id').all(kind,kind,status,status);
 return {items:rows.map(r=>getRepertoire(db,r.id)).filter(r=>!q||`${r.title} ${r.artist}`.toLowerCase().includes(q))};
}
/**
 * `options.inTransaction` 由调用方（离线同步操作）在已开启的事务里调用，
 * 保证业务数据与 operation_results 同生共死，崩溃重试不会只落一半。
 */
export function saveRepertoire(db,id,body,options={}){
 const prior=id?getRepertoire(db,id):null;if(id&&!prior)throw Object.assign(new Error('NOT_FOUND'),{status:404});
 const kind=prior?.kind||body.kind;validate(body,kind,!id);
 const value={kind,title:'',artist:'',learningStatus:'WANT_TO_LEARN',originalKey:'',performanceKey:'',capo:0,scoreText:'',notes:'',audioRole:'REFERENCE',...prior,...body};
 let vocal=null;
 if(kind==='VOCAL'){
  if(body.practice!==undefined&&(!body.practice||typeof body.practice!=='object'||Array.isArray(body.practice)))throw Error('INVALID_PRACTICE');
  // 纯算法结构不得覆盖已有人工校准；重跑分析必须显式冲突，不能静默改写。
  if(body.sections!==undefined&&Array.isArray(body.sections)&&body.sections.length&&body.sections.every(section=>section?.source==='algorithm')&&(prior?.sections||[]).some(section=>section.source==='manual'))throw Object.assign(new Error('MANUAL_OVERRIDE'),{status:409});
  const {sections,alias}=body.sections===undefined?{sections:prior?.sections||[],alias:new Map()}:normalizeSections(body.sections);
  const sectionIds=new Set(sections.map(section=>section.id));
  const lyrics=body.lyrics===undefined?reconcileLyrics(prior?.lyrics||[],alias,sectionIds):normalizeLyrics(body.lyrics,sectionIds);
  const practice=normalizePractice({...(prior?.practice||{}),...(body.practice||{})});
  if(body.language!==undefined&&body.language!==null&&!LANGUAGES.includes(body.language))throw Error('INVALID_LANGUAGE');
  const duration=maxDuration(prior);
  if(duration>0&&sections.some(section=>section.endMs>duration))throw Error('INVALID_SECTIONS');
  if(duration>0&&lyrics.some(line=>line.startMs>=duration))throw Error('INVALID_LYRICS');
  vocal={language:body.language===undefined?(prior?.language??null):body.language,lyrics,sections,practice};
 }
 const nextId=id||body.clientId||randomUUID();
 if(!id&&body.clientId){const exists=getRepertoire(db,nextId);if(exists){if(exists.kind!==kind)throw Error('BAD_REQUEST');return exists;}}
 const write=()=>{
  if(!id)db.prepare('INSERT INTO repertoire_items(id,kind,title) VALUES(?,?,?)').run(nextId,kind,value.title.trim());
  if(vocal)db.prepare('UPDATE repertoire_items SET title=?,artist=?,learning_status=?,original_key=?,performance_key=?,capo=?,score_text=?,notes=?,audio_role=?,vocal_language=?,lyrics_json=?,sections_json=?,practice_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(value.title.trim(),value.artist.trim(),value.learningStatus,value.originalKey.trim(),value.performanceKey.trim(),value.capo,value.scoreText,value.notes,value.audioRole,vocal.language,JSON.stringify(vocal.lyrics),JSON.stringify(vocal.sections),JSON.stringify(vocal.practice),nextId);
  else db.prepare('UPDATE repertoire_items SET title=?,artist=?,learning_status=?,original_key=?,performance_key=?,capo=?,score_text=?,notes=?,audio_role=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(value.title.trim(),value.artist.trim(),value.learningStatus,value.originalKey.trim(),value.performanceKey.trim(),value.capo,value.scoreText,value.notes,value.audioRole,nextId);
  // audioRole 变更时让旧单音轨指针继续指向该角色对应音轨，保持字段与文件精确一致。
  if(kind==='VOCAL'&&body.audioRole!==undefined){const target=prior?.tracks?.[ROLE_OF[value.audioRole]]?.media.id;if(target)db.prepare('UPDATE repertoire_items SET performance_clip_id=? WHERE id=?').run(target,nextId);}
  bumpCatalog(db);
 };
 if(options.inTransaction){write();return getRepertoire(db,nextId);}
 db.exec('BEGIN IMMEDIATE');
 try{write();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 return getRepertoire(db,nextId);
}
/**
 * AI/算法侧写入入口：默认把段落标为 algorithm；已有非算法人工结构时跳过段落、不静默覆盖，
 * 语言与歌词仍可落盘。数据随后由 /api/sync/manifest 带出，进入同步。
 */
export function saveVocalAnalysis(db,id,body){
 const item=getRepertoire(db,id);if(!item)throw Object.assign(new Error('NOT_FOUND'),{status:404});
 if(item.kind!=='VOCAL')throw Error('BAD_REQUEST');
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['language','lyrics','sections'].includes(key)))throw Error('BAD_REQUEST');
 const payload={};
 if(body.language!==undefined)payload.language=body.language;
 if(body.lyrics!==undefined)payload.lyrics=body.lyrics;
 let sectionsSkipped=false;
 if(body.sections!==undefined){
  if(item.sections.some(section=>section.source==='manual'))sectionsSkipped=true;
  else payload.sections=body.sections.map(section=>({...section,source:'algorithm'}));
 }
 if(sectionsSkipped&&!Object.keys(payload).length)return {applied:false,reason:'MANUAL_OVERRIDE',item};
 return {applied:true,sectionsSkipped,item:saveRepertoire(db,id,payload)};
}
export function attachRepertoireMedia(db,id,body){
 const item=getRepertoire(db,id);if(!item)throw Object.assign(new Error('NOT_FOUND'),{status:404});
 if(!body||Object.keys(body).some(k=>!['importJobId','audioRole','track','offsetMs','replace'].includes(k))||typeof body.importJobId!=='string'||(body.audioRole!==undefined&&!['REFERENCE','ACCOMPANIMENT'].includes(body.audioRole))||(body.track!==undefined&&!TRACK_ROLES.includes(body.track))||(item.kind!=='VOCAL'&&body.track!==undefined)||(body.replace!==undefined&&typeof body.replace!=='boolean'))throw new Error('BAD_REQUEST');
 if(body.offsetMs!==undefined&&(!Number.isInteger(body.offsetMs)||Math.abs(body.offsetMs)>MAX_OFFSET_MS))throw new Error('BAD_REQUEST');
 const role=item.kind==='VOCAL'?(body.track||ROLE_OF[body.audioRole||item.audioRole]):null;
 const row=db.prepare('SELECT status,draft_json FROM import_jobs WHERE id=?').get(body.importJobId);
 const draft=row?JSON.parse(row.draft_json||'{}'):null;
 if(draft?.finalizedRepertoireId===id){
  if(!role)return item;
  // 同一导入只能落一轨，重复提交同一轨幂等；换角色等于把同一 MP3 假装成两条音轨，拒绝。
  if(item.tracks?.[role]?.media.id===draft.clip?.id)return item;
  throw Object.assign(new Error('DUPLICATE_TRACK'),{status:409});
 }
 if(!draft?.clip||row.status!=='READY'||draft.finalizedId||draft.finalizedRepertoireId)throw new Error('IMPORT_NOT_READY');
 const otherRole=role&&(role==='original'?'accompaniment':'original');
 // 不同导入可能落到两个不同 clip 但内容完全一致（同 sha256）：那是同一份音频，不能伪装双轨。
 const clipSha=draft.clip.sha256||db.prepare('SELECT sha256 FROM performance_clips WHERE id=?').get(draft.clip.id)?.sha256||null;
 const sameContent=media=>!!media&&(media.id===draft.clip.id||(clipSha&&media.sha256===clipSha));
 if(otherRole&&sameContent(item.tracks?.[otherRole]?.media))throw Object.assign(new Error('DUPLICATE_TRACK'),{status:409});
 const existing=role?item.tracks?.[role]?.media:null;
 // 已有同角色音轨：内容相同视为重复；内容不同必须显式 replace，绝不静默顶掉旧轨。
 if(existing&&sameContent(existing))throw Object.assign(new Error('DUPLICATE_TRACK'),{status:409});
 if(existing&&body.replace!==true)throw Object.assign(new Error('TRACK_EXISTS'),{status:409});
 // 旧文件只被解绑，不被删除：保留 clip/source 行，替换后可回溯，也避免误删仍在播放的媒体。
 const replaced=draft.replacedClipIds||[];
 if(existing&&!replaced.includes(existing.id))replaced.push(existing.id);
 // 更新音轨不无故更换原始来源：首次绑定才记录本次导入的 source。
 const sourceId=item.sourceMediaId||draft.sourceId;
 db.exec('BEGIN IMMEDIATE');
 try{
  if(item.kind==='VOCAL'){
   const tracks=item.tracks||{};
   const next={original:{id:tracks.original?.media.id||null,offsetMs:tracks.original?.offsetMs||0},accompaniment:{id:tracks.accompaniment?.media.id||null,offsetMs:tracks.accompaniment?.offsetMs||0}};
   next[role]={id:draft.clip.id,offsetMs:body.offsetMs??0};
   // 写入前把旧单音轨materialize到显式列，另一轨因此不会被新音轨顶掉。
   db.prepare('UPDATE repertoire_items SET source_media_id=?,performance_clip_id=?,cover_asset_id=?,audio_role=?,original_clip_id=?,accompaniment_clip_id=?,original_offset_ms=?,accompaniment_offset_ms=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(sourceId,draft.clip.id,draft.cover?.id||item.cover?.id||null,LEGACY_ROLE[role],next.original.id,next.accompaniment.id,next.original.offsetMs,next.accompaniment.offsetMs,id);
  }else db.prepare('UPDATE repertoire_items SET source_media_id=?,performance_clip_id=?,cover_asset_id=?,audio_role=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(sourceId,draft.clip.id,draft.cover?.id||null,body.audioRole||item.audioRole,id);
  if(replaced.length)draft.replacedClipIds=replaced;
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
