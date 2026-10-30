import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../server/db/database.mjs';
import {getRepertoire,saveRepertoire,attachRepertoireMedia} from '../server/repertoire/service.mjs';
import {syncOperation} from '../server/sync-operations.mjs';
import {createApiServer} from '../server/index.mjs';

/** 全部使用临时目录里的空库，绝不触碰 var/ 下的真实数据库。 */
function withDb(run){const root=mkdtempSync(join(tmpdir(),'p040-track-'));const db=openDatabase(join(root,'db.sqlite'));try{return run(db)}finally{db.close();rmSync(root,{recursive:true,force:true})}}

/** 直接造一条 READY 导入任务；clipSha 可指定，用来模拟「两份不同 clip、内容完全相同」。 */
function seedJob(db,{clipSha,durationMs=60000}={}){
 const sourceId=randomUUID(),clipId=randomUUID();
 const sourceSha=`src-${randomUUID().replace(/-/g,'')}`,sha=clipSha||`clip-${randomUUID().replace(/-/g,'')}`;
 db.prepare('INSERT INTO source_media(id,source_kind,internal_path,sha256,duration_ms) VALUES(?,?,?,?,?)').run(sourceId,'AUDIO',`audio/${clipId}.m4a`,sourceSha,durationMs);
 db.prepare('INSERT INTO performance_clips(id,source_media_id,start_ms,end_ms,internal_audio_path,codec,source_preserving,sha256,size_bytes,duration_ms) VALUES(?,?,?,?,?,?,?,?,?,?)').run(clipId,sourceId,0,durationMs,`audio/${clipId}.m4a`,'aac',0,sha,4096,durationMs);
 const jobId=randomUUID();
 db.prepare('INSERT INTO import_jobs(id,source_kind,status,stage,draft_json) VALUES(?,?,?,?,?)').run(jobId,'FILE','READY','REVIEW',JSON.stringify({title:'导入音轨',sourceId,clip:{id:clipId,sha256:sha,sizeBytes:4096,codec:'aac',durationMs}}));
 return {sourceId,clipId,sha,jobId};
}
const clipExists=(db,id)=>!!db.prepare('SELECT 1 FROM performance_clips WHERE id=?').get(id);

test('同角色已有音轨：没显式 replace 一律拒绝，旧音轨原样保留',()=>withDb(db=>{
 const item=saveRepertoire(db,null,{kind:'VOCAL',title:'拒绝静默覆盖'});
 const first=seedJob(db),second=seedJob(db);
 attachRepertoireMedia(db,item.id,{importJobId:first.jobId,track:'original'});
 const before=getRepertoire(db,item.id);
 assert.throws(
  ()=>attachRepertoireMedia(db,item.id,{importJobId:second.jobId,track:'original'}),
  error=>error.message==='TRACK_EXISTS'&&error.status===409,
 );
 const after=getRepertoire(db,item.id);
 assert.equal(after.tracks.original.media.id,first.clipId);
 assert.equal(after.revision,before.revision);
 assert.equal(after.tracks.accompaniment,undefined);
 // 被拒绝的那次导入没有落库，导入任务仍可继续使用。
 const draft=JSON.parse(db.prepare('SELECT draft_json FROM import_jobs WHERE id=?').get(second.jobId).draft_json);
 assert.equal(draft.finalizedRepertoireId,undefined);
}));

test('显式 replace 才替换音轨，旧文件与旧来源都被保留可回溯',()=>withDb(db=>{
 const item=saveRepertoire(db,null,{kind:'VOCAL',title:'显式替换'});
 const first=seedJob(db),second=seedJob(db);
 attachRepertoireMedia(db,item.id,{importJobId:first.jobId,track:'original'});
 const replaced=attachRepertoireMedia(db,item.id,{importJobId:second.jobId,track:'original',replace:true,offsetMs:40});
 assert.equal(replaced.tracks.original.media.id,second.clipId);
 assert.equal(replaced.tracks.original.offsetMs,40);
 // 旧 clip 行没有删：媒体文件不会被这次替换顺手抹掉。
 assert.ok(clipExists(db,first.clipId));
 assert.ok(db.prepare('SELECT 1 FROM source_media WHERE id=?').get(first.sourceId));
 const draft=JSON.parse(db.prepare('SELECT draft_json FROM import_jobs WHERE id=?').get(second.jobId).draft_json);
 assert.deepEqual(draft.replacedClipIds,[first.clipId]);
}));

test('两份不同 clip 但相同 sha256 的文件不能伪装成双轨',()=>withDb(db=>{
 const sha='b'.repeat(64);
 const item=saveRepertoire(db,null,{kind:'VOCAL',title:'同内容'});
 const a=seedJob(db,{clipSha:sha}),b=seedJob(db,{clipSha:sha});
 assert.notEqual(a.clipId,b.clipId);
 attachRepertoireMedia(db,item.id,{importJobId:a.jobId,track:'original'});
 assert.throws(
  ()=>attachRepertoireMedia(db,item.id,{importJobId:b.jobId,track:'accompaniment'}),
  error=>error.message==='DUPLICATE_TRACK'&&error.status===409,
 );
 const item2=getRepertoire(db,item.id);
 assert.equal(item2.tracks.accompaniment,undefined);
 assert.equal(item2.tracks.original.media.id,a.clipId);
 // 同角色用相同内容替换也不接受：内容一样，换 clip 只是障眼法。
 assert.throws(
  ()=>attachRepertoireMedia(db,item.id,{importJobId:b.jobId,track:'original',replace:true}),
  error=>error.message==='DUPLICATE_TRACK'&&error.status===409,
 );
}));

test('更新音轨不无故更换 source_media_id（唱歌与吉他都不换）',()=>withDb(db=>{
 const item=saveRepertoire(db,null,{kind:'VOCAL',title:'来源不换'});
 const original=seedJob(db),accompaniment=seedJob(db);
 const first=attachRepertoireMedia(db,item.id,{importJobId:original.jobId,track:'original'});
 assert.equal(first.sourceMediaId,original.sourceId);
 const second=attachRepertoireMedia(db,item.id,{importJobId:accompaniment.jobId,track:'accompaniment'});
 assert.equal(second.sourceMediaId,original.sourceId);
 assert.equal(second.tracks.original.media.id,original.clipId);
 assert.equal(second.tracks.accompaniment.media.id,accompaniment.clipId);

 const guitar=saveRepertoire(db,null,{kind:'GUITAR',title:'吉他来源'});
 const g1=seedJob(db),g2=seedJob(db);
 const guitarFirst=attachRepertoireMedia(db,guitar.id,{importJobId:g1.jobId});
 assert.equal(guitarFirst.sourceMediaId,g1.sourceId);
 const guitarSecond=attachRepertoireMedia(db,guitar.id,{importJobId:g2.jobId});
 assert.equal(guitarSecond.sourceMediaId,g1.sourceId);
}));

test('歌词业务数据与 operation_results 同事务：写入失败不留半套，重试幂等',()=>withDb(db=>{
 const item=saveRepertoire(db,null,{kind:'VOCAL',title:'同事务'});
 const op={operationId:randomUUID(),kind:'VOCAL',id:item.id,action:'update',baseRevision:item.revision,fields:{lyrics:[{startMs:0,text:'同事务句'}]}};
 // 模拟提交前崩溃：写 operation_results 时整条事务被中止。
 db.exec("CREATE TRIGGER fail_operation_result BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'crash'); END");
 assert.throws(()=>syncOperation(db,op));
 db.exec('DROP TRIGGER fail_operation_result');
 const rolledBack=getRepertoire(db,item.id);
 assert.deepEqual(rolledBack.lyrics,[]);
 assert.equal(rolledBack.revision,item.revision);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operation_results WHERE id=?').get(op.operationId).n,0);

 // 崩溃后原样重试：数据与结果一起落盘。
 const applied=syncOperation(db,op);
 assert.equal(applied.status,'applied');
 assert.equal(applied.revision,item.revision+1);
 assert.equal(getRepertoire(db,item.id).lyrics[0].text,'同事务句');
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operation_results WHERE id=?').get(op.operationId).n,1);

 // 完全相同请求再发一次 = 幂等回放，不重复加版本。
 assert.deepEqual(syncOperation(db,op),applied);
 assert.equal(getRepertoire(db,item.id).revision,applied.revision);
}));

test('HTTP 接口把 TRACK_EXISTS / DUPLICATE_TRACK 原样回给客户端，不折叠成 BAD_REQUEST',async()=>{
 const root=mkdtempSync(join(tmpdir(),'p040-track-http-'));const db=openDatabase(join(root,'db.sqlite'));const server=createApiServer({db,mediaRoot:join(root,'media')});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 const post=async(path,body)=>{const res=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:res.status,data:await res.json()}};
 try{
  const item=saveRepertoire(db,null,{kind:'VOCAL',title:'错误码'});
  const first=seedJob(db),second=seedJob(db);
  assert.equal((await post(`/api/repertoire/${item.id}/media`,{importJobId:first.jobId,track:'original'})).status,200);

  // 同角色已有音轨且未显式替换 → TRACK_EXISTS（409）。
  const exists=await post(`/api/repertoire/${item.id}/media`,{importJobId:second.jobId,track:'original'});
  assert.equal(exists.status,409);
  assert.equal(exists.data.error.code,'TRACK_EXISTS');
  assert.ok(exists.data.error.message);

  // 同一份音频换角色冒充双轨 → DUPLICATE_TRACK（409）。
  const sha='c'.repeat(64);
  const third=seedJob(db,{clipSha:sha}),fourth=seedJob(db,{clipSha:sha});
  const other=saveRepertoire(db,null,{kind:'VOCAL',title:'同内容错误码'});
  assert.equal((await post(`/api/repertoire/${other.id}/media`,{importJobId:third.jobId,track:'original'})).status,200);
  const duplicate=await post(`/api/repertoire/${other.id}/media`,{importJobId:fourth.jobId,track:'accompaniment'});
  assert.equal(duplicate.status,409);
  assert.equal(duplicate.data.error.code,'DUPLICATE_TRACK');
  assert.ok(duplicate.data.error.message);
 }finally{await new Promise(resolve=>server.close(resolve));db.close();rmSync(root,{recursive:true,force:true});}
});
