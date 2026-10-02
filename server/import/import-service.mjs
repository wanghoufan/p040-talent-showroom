import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileIdentity,probeMedia,extractAudio,extractFrame } from '../media/ffmpeg.mjs';
import { recognizeSafely } from '../recognition/provider.mjs';
import { STATUSES,sceneMask,bumpCatalog,getDance } from '../catalog.mjs';
import { registerAdapter,selectAdapter } from './source-adapter.mjs';
import { localFileAdapter } from './local-file-adapter.mjs';
import { manualAudioAdapter } from './manual-audio-adapter.mjs';
import { douyinAdapter } from './douyin-adapter.mjs';

registerAdapter(localFileAdapter);
registerAdapter(manualAudioAdapter);
registerAdapter(douyinAdapter);

/** 链接收录：只走注册 adapter；adapter 无取得能力时返回 NEEDS_INPUT 并保留原链接。 */
export function startLinkImport(db, link) {
  const adapter = selectAdapter(link);
  if (!adapter) throw Object.assign(new Error('SOURCE_NOT_ALLOWED'), { status: 400 });
  const id = randomUUID();
  const capability = adapter.canAcquire ? { canAcquire: true } : { canAcquire: false, reason: 'NEEDS_INPUT' };
  db.prepare("INSERT INTO import_jobs(id,source_kind,status,stage,draft_json) VALUES(?,'LINK','NEEDS_INPUT','ACQUIRE',?)")
    .run(id, JSON.stringify({ link, adapter: adapter.id, capability, title: '待收录舞蹈' }));
  return publicJob(db, id);
}

export function publicJob(db,id) {
  const job=db.prepare('SELECT * FROM import_jobs WHERE id=?').get(id);
  if(!job) return null;
  const draft=job.draft_json?JSON.parse(job.draft_json):null;
  return {id:job.id,status:job.status,stage:job.stage,errorCode:job.error_code||undefined,duplicateId:draft?.duplicateId,draft:draft?{title:draft.title,artist:draft.artist,link:draft.link,adapter:draft.adapter,capability:draft.capability,learningStatus:'WANT_TO_LEARN',sceneTags:[],sourceMediaId:draft.sourceId,audio:draft.clip?{id:draft.clip.id,url:`/api/media/audio/${draft.clip.id}`,sha256:draft.clip.sha256,sizeBytes:draft.clip.sizeBytes,version:1}:undefined,cover:draft.cover?{id:draft.cover.id,url:`/api/media/cover/${draft.cover.id}`,sha256:draft.cover.sha256,sizeBytes:draft.cover.sizeBytes,version:1}:undefined,durationMs:draft.probe?.durationMs,candidates:draft.recognition?.candidates||[]}:undefined};
}
export async function receiveFile(req,ctx,opts={}) {
  const {db,mediaRoot}=ctx;
  for(const dir of ['source','audio','covers']) mkdirSync(join(mediaRoot,dir),{recursive:true});
  let id,existing=null;
  if(opts.jobId){
    existing=db.prepare('SELECT id,source_kind,status,draft_json FROM import_jobs WHERE id=?').get(opts.jobId);
    if(!existing) throw Object.assign(new Error('NOT_FOUND'),{status:404});
    if(existing.status!=='NEEDS_INPUT') throw Object.assign(new Error('BAD_REQUEST'),{status:409});
    id=existing.id;
  } else id=randomUUID();
  const file=join(mediaRoot,'source',id+'.media');
  const limit=512*1024*1024; let size=0;
  if(Number(req.headers['content-length'])>limit) throw Object.assign(new Error('UPLOAD_TOO_LARGE'),{status:413});
  const declared=req.headers['content-type']?.split(';')[0]||'';
  if(!/^(video\/|audio\/|application\/octet-stream$)/.test(declared)) throw Object.assign(new Error('INVALID_MEDIA'),{status:415});
  try {
    await pipeline(req,new Transform({transform(chunk,_,callback){size+=chunk.length;callback(size>limit?new Error('UPLOAD_TOO_LARGE'):null,chunk);}}),createWriteStream(file,{flags:'wx'}));
  } catch(error) { try{unlinkSync(file);}catch{/* Keep the original upload error if cleanup fails. */} throw error; }
  const identity=await fileIdentity(file);
  const duplicate=db.prepare('SELECT d.id FROM dance_items d JOIN source_media m ON d.source_media_id=m.id WHERE m.sha256=? AND d.deleted_at IS NULL LIMIT 1').get(identity.sha256);
  let name='未识别舞蹈';
  try {name=decodeURIComponent(req.headers['x-file-name']||'').split(/[\\/]/).pop()?.replace(/\.[^.]+$/,'').slice(0,200)||name;}catch{/* Keep the original upload error if cleanup fails. */}
  const prior=existing?.draft_json?JSON.parse(existing.draft_json):{};
  // 补充本地视频时保留原分享链接与 adapter 能力信息（NEEDS_INPUT 不丢链接）。
  const draft={file,identity,title:name,duplicateId:duplicate?.id,link:prior.link,adapter:prior.adapter,capability:prior.capability};
  if(existing){
    db.prepare("UPDATE import_jobs SET status='PROCESSING',stage='ACQUIRE',error_code=NULL,draft_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(draft),id);
  } else {
    db.prepare("INSERT INTO import_jobs(id,source_kind,status,stage,draft_json) VALUES(?,'FILE','PROCESSING','ACQUIRE',?)").run(id,JSON.stringify(draft));
  }
  const processing=processFile(id,{...ctx,declared}).catch(()=>{
    db.prepare("UPDATE import_jobs SET status='FAILED',error_code='INVALID_MEDIA',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
  });
  ctx.pendingJobs.add(processing);
  void processing.finally(()=>ctx.pendingJobs.delete(processing));
  return {id,duplicateId:duplicate?.id};
}
async function processFile(id,ctx) {
  const {db,mediaRoot,declared}=ctx;
  const draft=JSON.parse(db.prepare('SELECT draft_json FROM import_jobs WHERE id=?').get(id).draft_json);
  const stage=name=>db.prepare('UPDATE import_jobs SET stage=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name,id);
  stage('PROBE'); const probe=await probeMedia(draft.file);
  if(declared.startsWith('video/')&&!probe.videoCodec) throw new Error('INVALID_MEDIA');
  stage('EXTRACT'); const clipId=randomUUID();
  const clip=await extractAudio(draft.file,join(mediaRoot,'audio',clipId),probe);
  stage('RECOGNIZE'); const recognition=await recognizeSafely(ctx.provider||null,clip.path);
  stage('COVER'); let cover;
  if(probe.videoCodec&&!ctx.forceCoverFailure) {
    try {const coverId=randomUUID();cover={id:coverId,...await extractFrame(draft.file,join(mediaRoot,'covers',coverId+'.jpg'))};}catch{/* Keep the original upload error if cleanup fails. */}
  }
  const sourceId=randomUUID();
  const complete={...draft,probe,sourceId,clip:{id:clipId,...clip},cover,recognition,artist:'未识别'};
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO source_media(id,source_kind,source_locator,internal_path,sha256,duration_ms,audio_codec,video_codec,container) VALUES(?,?,?,?,?,?,?,?,?)').run(sourceId,probe.videoCodec?'VIDEO':'AUDIO',draft.link||null,relative(mediaRoot,draft.file),draft.identity.sha256,probe.durationMs,probe.audioCodec,probe.videoCodec||null,probe.format||null);
    db.prepare('INSERT INTO performance_clips(id,source_media_id,start_ms,end_ms,internal_audio_path,codec,source_preserving,sha256,size_bytes,duration_ms) VALUES(?,?,0,?,?,?,?,?,?,?)').run(clipId,sourceId,probe.durationMs,relative(mediaRoot,clip.path),clip.codec,clip.sourcePreserving?1:0,clip.sha256,clip.sizeBytes,probe.durationMs);
    if(cover) db.prepare('INSERT INTO assets(id,kind,internal_path,sha256,size_bytes) VALUES(?,?,?,?,?)').run(cover.id,'COVER',relative(mediaRoot,cover.path),cover.sha256,cover.sizeBytes);
    db.prepare("UPDATE import_jobs SET status='READY',stage='REVIEW',draft_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(complete),id);
    db.exec('COMMIT');
  } catch(error) {db.exec('ROLLBACK');throw error;}
}
export function finalizeImport(db,id,body) {
  const row=db.prepare('SELECT status,draft_json FROM import_jobs WHERE id=?').get(id);
  if(!row) throw Object.assign(new Error('NOT_FOUND'),{status:404});
  const draft=JSON.parse(row.draft_json||'{}');
  if(draft.finalizedId) return getDance(db,draft.finalizedId);
  if(row.status!=='READY'||!draft.clip) throw Object.assign(new Error('IMPORT_NOT_READY'),{status:409});
  const status=body.learningStatus||'WANT_TO_LEARN'; if(!STATUSES.includes(status)) throw new Error('INVALID_STATUS');
  const mask=sceneMask(body.sceneTags||[]);
  if(body.title!==undefined&&(typeof body.title!=='string'||body.title.length>200)) throw new Error('INVALID_TITLE');
  if(body.artist!==undefined&&(typeof body.artist!=='string'||body.artist.length>200)) throw new Error('INVALID_ARTIST');
  const danceId=randomUUID(),songId=randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO song_identities(id,title,artist,recognition_status) VALUES(?,?,?,?)').run(songId,body.title?.trim()||draft.title,body.artist?.trim()||draft.artist,'MANUAL');
    db.prepare('INSERT INTO dance_items(id,song_identity_id,source_media_id,performance_clip_id,learning_status,scene_mask,cover_asset_id) VALUES(?,?,?,?,?,?,?)').run(danceId,songId,draft.sourceId,draft.clip.id,status,mask,draft.cover?.id||null);
    draft.finalizedId=danceId;
    db.prepare('UPDATE import_jobs SET draft_json=? WHERE id=?').run(JSON.stringify(draft),id);
    bumpCatalog(db); db.exec('COMMIT');
  } catch(error){db.exec('ROLLBACK');throw error;}
  return getDance(db,danceId);
}
