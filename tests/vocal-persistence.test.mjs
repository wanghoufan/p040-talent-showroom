import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../server/db/database.mjs';
import {getRepertoire,saveRepertoire,attachRepertoireMedia,saveVocalAnalysis} from '../server/repertoire/service.mjs';
import {getManifest} from '../server/catalog.mjs';
import {syncOperation} from '../server/sync-operations.mjs';
import {createApiServer} from '../server/index.mjs';

const PRACTICE_DEFAULTS={skipRap:false,wholeTrackLoop:false,backwardSeconds:5,forwardSeconds:10,customRepeatLines:2,playbackRate:1};

function withDb(run){const root=mkdtempSync(join(tmpdir(),'p040-vocal-'));const db=openDatabase(join(root,'db.sqlite'));try{return run(db,root)}finally{db.close();rmSync(root,{recursive:true,force:true})}}
/** 直接造一条可绑定音轨的 READY 导入任务，避免测试依赖 ffmpeg 与真实媒体文件。 */
function seedJob(db,{durationMs=60000}={}){
 const sourceId=randomUUID(),clipId=randomUUID(),sha=randomUUID().replace(/-/g,'');
 db.prepare('INSERT INTO source_media(id,source_kind,internal_path,sha256,duration_ms) VALUES(?,?,?,?,?)').run(sourceId,'AUDIO',`audio/${clipId}.m4a`,sha,durationMs);
 db.prepare('INSERT INTO performance_clips(id,source_media_id,start_ms,end_ms,internal_audio_path,codec,source_preserving,sha256,size_bytes,duration_ms) VALUES(?,?,?,?,?,?,?,?,?,?)').run(clipId,sourceId,0,durationMs,`audio/${clipId}.m4a`,'aac',0,sha,4096,durationMs);
 const jobId=randomUUID();
 db.prepare('INSERT INTO import_jobs(id,source_kind,status,stage,draft_json) VALUES(?,?,?,?,?)').run(jobId,'FILE','READY','REVIEW',JSON.stringify({title:'导入音轨',sourceId,clip:{id:clipId,sha256:sha,sizeBytes:4096,codec:'aac',durationMs}}));
 return {sourceId,clipId,sha,jobId};
}

test('迁移新增vocal列；旧吉他曲目只有单音轨且行为不变',()=>withDb(db=>{
 const columns=db.prepare("SELECT name FROM pragma_table_info('repertoire_items')").all().map(row=>row.name);
 for(const name of ['vocal_language','lyrics_json','sections_json','practice_json','original_clip_id','accompaniment_clip_id','original_offset_ms','accompaniment_offset_ms'])assert.ok(columns.includes(name),name);
 const guitar=saveRepertoire(db,null,{kind:'GUITAR',title:'旧吉他',capo:2,scoreText:'[C]一'});
 assert.equal(guitar.tracks,undefined);assert.equal(guitar.lyrics,undefined);assert.equal(guitar.sections,undefined);assert.equal(guitar.language,undefined);assert.equal(guitar.practice,undefined);
 const job=seedJob(db);
 const linked=attachRepertoireMedia(db,guitar.id,{importJobId:job.jobId,audioRole:'ACCOMPANIMENT'});
 assert.equal(linked.tracks,undefined);assert.equal(linked.audio.id,job.clipId);assert.equal(linked.audioRole,'ACCOMPANIMENT');assert.equal(linked.capo,2);
 assert.equal(linked.audio.sha256,job.sha);
}));

test('旧 audioRole 精确映射为单轨；新增第二轨保留第一轨，重复文件不假装双轨',()=>withDb(db=>{
 const originalItem=saveRepertoire(db,null,{kind:'VOCAL',title:'参考',audioRole:'REFERENCE'});
 const a=seedJob(db);
 const onlyOriginal=attachRepertoireMedia(db,originalItem.id,{importJobId:a.jobId});
 assert.equal(onlyOriginal.tracks.original.media.id,a.clipId);assert.equal(onlyOriginal.tracks.accompaniment,undefined);
 assert.equal(onlyOriginal.audioRole,'REFERENCE');assert.equal(onlyOriginal.audio.id,a.clipId);

 // 旧单音轨再加第二轨：旧轨先 materialize，新增不会把旧轨顶掉。
 const legacy=saveRepertoire(db,null,{kind:'VOCAL',title:'旧单轨再加轨'});
 const e=seedJob(db),f=seedJob(db);
 attachRepertoireMedia(db,legacy.id,{importJobId:e.jobId});
 const both=attachRepertoireMedia(db,legacy.id,{importJobId:f.jobId,track:'accompaniment'});
 assert.equal(both.tracks.original.media.id,e.clipId);assert.equal(both.tracks.accompaniment.media.id,f.clipId);
 assert.equal(both.audioRole,'ACCOMPANIMENT');assert.equal(both.audio.id,f.clipId);

 const accompanimentItem=saveRepertoire(db,null,{kind:'VOCAL',title:'伴奏',audioRole:'ACCOMPANIMENT'});
 const b=seedJob(db);
 const onlyAccompaniment=attachRepertoireMedia(db,accompanimentItem.id,{importJobId:b.jobId});
 assert.equal(onlyAccompaniment.tracks.accompaniment.media.id,b.clipId);assert.equal(onlyAccompaniment.tracks.original,undefined);
 assert.equal(onlyAccompaniment.audioRole,'ACCOMPANIMENT');

 const c=seedJob(db),d=seedJob(db);
 // 已有原唱时再绑定同角色音轨必须显式 replace；旧文件保留，不被静默顶掉。
 let item=attachRepertoireMedia(db,originalItem.id,{importJobId:c.jobId,track:'original',offsetMs:120,replace:true});
 assert.ok(db.prepare('SELECT 1 FROM performance_clips WHERE id=?').get(a.clipId));
 item=attachRepertoireMedia(db,originalItem.id,{importJobId:d.jobId,track:'accompaniment',offsetMs:-80});
 assert.equal(item.tracks.original.media.id,c.clipId);assert.equal(item.tracks.original.offsetMs,120);
 assert.equal(item.tracks.accompaniment.media.id,d.clipId);assert.equal(item.tracks.accompaniment.offsetMs,-80);
 assert.equal(item.audioRole,'ACCOMPANIMENT');assert.equal(item.audio.id,d.clipId);
 // 同一轨重复提交幂等；同一导入换轨不得把同一 MP3 当成第二轨。
 const again=attachRepertoireMedia(db,originalItem.id,{importJobId:d.jobId,track:'accompaniment'});
 assert.equal(again.tracks.accompaniment.offsetMs,-80);
 assert.equal(again.revision,item.revision);
 assert.throws(()=>attachRepertoireMedia(db,originalItem.id,{importJobId:d.jobId,track:'original'}),error=>error.message==='DUPLICATE_TRACK'&&error.status===409);
 assert.equal(getRepertoire(db,originalItem.id).tracks.original.media.id,c.clipId);
 // 吉他仍不接受 track 语义。
 const guitar=saveRepertoire(db,null,{kind:'GUITAR',title:'吉他'}),guitarJob=seedJob(db);
 assert.throws(()=>attachRepertoireMedia(db,guitar.id,{importJobId:guitarJob.jobId,track:'original'}),/BAD_REQUEST/);
}));

test('语言、逐句歌词、人工结构与练习设置增量保存，局部更新不覆盖其他字段',()=>withDb(db=>{
 const item=saveRepertoire(db,null,{kind:'VOCAL',title:'增量'});
 assert.deepEqual(item.lyrics,[]);assert.deepEqual(item.sections,[]);assert.deepEqual(item.practice,PRACTICE_DEFAULTS);
 const saved=saveRepertoire(db,item.id,{
  language:'zh',
  lyrics:[{startMs:0,text:'第一句'},{startMs:2000,text:'第二句',endMs:3500}],
  sections:[{id:'s1',type:'verse',label:'主歌 A1',startMs:0,endMs:8000}],
  practice:{skipRap:true,wholeTrackLoop:false,backwardSeconds:10,forwardSeconds:15,customRepeatLines:4,playbackRate:0.8},
 });
 assert.equal(saved.language,'zh');assert.equal(saved.lyrics.length,2);assert.equal(saved.lyrics[0].id,'line-1');assert.equal(saved.lyrics[1].endMs,3500);
 assert.equal(saved.sections[0].source,'manual');assert.equal(saved.practice.forwardSeconds,15);
 const practiceOnly=saveRepertoire(db,item.id,{practice:{customRepeatLines:2}});
 assert.equal(practiceOnly.practice.customRepeatLines,2);assert.equal(practiceOnly.practice.skipRap,true);assert.equal(practiceOnly.practice.backwardSeconds,10);
 assert.equal(practiceOnly.language,'zh');assert.equal(practiceOnly.lyrics.length,2);assert.equal(practiceOnly.sections.length,1);
 const languageOnly=saveRepertoire(db,item.id,{language:'en'});
 assert.equal(languageOnly.language,'en');assert.equal(languageOnly.lyrics[1].text,'第二句');
}));

test('结构校验：半开区间、Rap 相邻合并、重叠与越界拒绝，歌词与段落引用不悬空',()=>withDb(db=>{
 const item=saveRepertoire(db,null,{kind:'VOCAL',title:'校验'});
 const save=body=>saveRepertoire(db,item.id,body);
 assert.throws(()=>save({sections:[{id:'s1',type:'verse',label:'A1',startMs:5000,endMs:5000}]}),/INVALID_SECTIONS/);
 assert.throws(()=>save({sections:[{id:'s1',type:'verse',label:'A1',startMs:0,endMs:8000},{id:'s2',type:'chorus',label:'B1',startMs:7000,endMs:12000}]}),/INVALID_SECTIONS/);
 assert.throws(()=>save({sections:[{id:'s1',type:'dance',label:'A1',startMs:0,endMs:8000}]}),/INVALID_SECTIONS/);
 assert.throws(()=>save({sections:[{id:'s1',type:'verse',label:'A1',startMs:0,endMs:8000,repeatOf:'missing'}]}),/INVALID_SECTIONS/);
 assert.throws(()=>save({sections:[{id:'s1',type:'verse',label:'A1',startMs:0,endMs:8000},{id:'s1',type:'verse',label:'A2',startMs:9000,endMs:12000}]}),/INVALID_SECTIONS/);
 // Rap 相邻合并为一段，保留首段 id；旧歌词引用被合并段时改指保留段。
 const first=save({sections:[{id:'r1',type:'rap',label:'R1',startMs:4000,endMs:20000},{id:'r2',type:'rap',label:'R2',startMs:30000,endMs:34000}],lyrics:[{startMs:30000,text:'说唱句',sectionId:'r2'}]});
 assert.equal(first.sections.length,2);
 const merged=save({sections:[{id:'r1',type:'rap',label:'R1',startMs:4000,endMs:20000},{id:'r2',type:'rap',label:'R2',startMs:20000,endMs:34000}]});
 assert.equal(merged.sections.length,1);assert.equal(merged.sections[0].id,'r1');assert.equal(merged.sections[0].endMs,34000);
 assert.equal(merged.lyrics[0].sectionId,'r1');
 assert.throws(()=>save({lyrics:[{startMs:5000,text:'后'},{startMs:1000,text:'前'}]}),/INVALID_LYRICS/);
 assert.throws(()=>save({lyrics:[{startMs:0,text:'   '}]}),/INVALID_LYRICS/);
 assert.throws(()=>save({lyrics:[{startMs:0,text:'句',sectionId:'nope'}]}),/INVALID_LYRICS/);
 assert.throws(()=>save({language:'fr'}),/INVALID_LANGUAGE/);
 assert.throws(()=>save({practice:{backwardSeconds:7}}),/INVALID_PRACTICE/);
 assert.throws(()=>save({practice:{customRepeatLines:0}}),/INVALID_PRACTICE/);
 const guitar=saveRepertoire(db,null,{kind:'GUITAR',title:'不许唱'});
 assert.throws(()=>saveRepertoire(db,guitar.id,{language:'zh'}),/BAD_REQUEST/);
 assert.throws(()=>saveRepertoire(db,guitar.id,{lyrics:[]}),/BAD_REQUEST/);
 // 已知媒体时长时，结构/歌词越界拒绝保存。
 const timed=saveRepertoire(db,null,{kind:'VOCAL',title:'时长'}),job=seedJob(db,{durationMs:60000});
 attachRepertoireMedia(db,timed.id,{importJobId:job.jobId,track:'original'});
 assert.throws(()=>saveRepertoire(db,timed.id,{sections:[{id:'s1',type:'verse',label:'A1',startMs:0,endMs:61000}]}),/INVALID_SECTIONS/);
 assert.throws(()=>saveRepertoire(db,timed.id,{lyrics:[{startMs:61000,text:'越界'}]}),/INVALID_LYRICS/);
}));

test('AI 分析写入标为 algorithm 且进入清单；人工结构不被静默覆盖',()=>withDb(db=>{
 const item=saveRepertoire(db,null,{kind:'VOCAL',title:'AI'});
 const first=saveVocalAnalysis(db,item.id,{
  language:'ko',
  lyrics:[{startMs:0,text:'첫 소절'}],
  sections:[{id:'a1',type:'verse',label:'V1',startMs:0,endMs:10000}],
 });
 assert.equal(first.applied,true);assert.equal(first.sectionsSkipped,false);
 assert.equal(first.item.sections[0].source,'algorithm');assert.equal(first.item.language,'ko');
 const manual=saveRepertoire(db,item.id,{sections:[{id:'m1',type:'verse',label:'人工 V1',startMs:0,endMs:12000}]});
 assert.equal(manual.sections[0].source,'manual');
 const blocked=saveVocalAnalysis(db,item.id,{sections:[{id:'a2',type:'verse',label:'V1',startMs:0,endMs:9000}]});
 assert.equal(blocked.applied,false);assert.equal(blocked.reason,'MANUAL_OVERRIDE');
 assert.equal(getRepertoire(db,item.id).sections[0].id,'m1');
 // 直接 PATCH 纯算法段也必须显式冲突，不能悄悄覆盖人工校准。
 assert.throws(()=>saveRepertoire(db,item.id,{sections:[{id:'a2',type:'verse',label:'V1',startMs:0,endMs:9000,source:'algorithm'}]}),error=>error.message==='MANUAL_OVERRIDE'&&error.status===409);
 const lyricsOnly=saveVocalAnalysis(db,item.id,{lyrics:[{startMs:0,text:'새 가사'}],sections:[{id:'a3',type:'verse',label:'V1',startMs:0,endMs:9000}]});
 assert.equal(lyricsOnly.applied,true);assert.equal(lyricsOnly.sectionsSkipped,true);
 assert.equal(lyricsOnly.item.lyrics[0].text,'새 가사');assert.equal(lyricsOnly.item.sections[0].id,'m1');
 assert.throws(()=>saveVocalAnalysis(db,saveRepertoire(db,null,{kind:'GUITAR',title:'吉他'}).id,{language:'zh'}),/BAD_REQUEST/);
}));

test('同步清单包含语言/歌词/结构/双轨，旧同步操作仍可更新且不抹掉新数据',()=>withDb(db=>{
 const item=saveRepertoire(db,null,{kind:'VOCAL',title:'同步唱歌'}),job=seedJob(db);
 attachRepertoireMedia(db,item.id,{importJobId:job.jobId,track:'accompaniment'});
 saveRepertoire(db,item.id,{language:'en',lyrics:[{startMs:500,text:'Open windows'}],sections:[{id:'s1',type:'chorus',label:'B1',startMs:0,endMs:9000}]});
 const manifest=getManifest(db);
 const found=manifest.repertoire.find(row=>row.id===item.id);
 assert.equal(found.language,'en');assert.equal(found.lyrics[0].text,'Open windows');assert.equal(found.sections[0].label,'B1');
 assert.equal(found.tracks.accompaniment.media.id,job.clipId);assert.ok(found.revision>=2);
 // 旧客户端仍走原有同步 update 通道：只改旧列，不破坏 vocal 新字段。
 const updated=syncOperation(db,{operationId:randomUUID(),kind:'VOCAL',id:item.id,action:'update',baseRevision:found.revision,fields:{notes:'手机备注'}});
 assert.equal(updated.item.notes,'手机备注');assert.equal(updated.item.language,'en');assert.equal(updated.item.lyrics[0].text,'Open windows');assert.equal(updated.item.tracks.accompaniment.media.id,job.clipId);
}));

test('HTTP 接口保存vocal数据、绑定第二轨并回传，非法换轨返回409',async()=>{
 const root=mkdtempSync(join(tmpdir(),'p040-vocal-http-'));const db=openDatabase(join(root,'db.sqlite'));const server=createApiServer({db,mediaRoot:join(root,'media')});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 const request=async(path,method='GET',body)=>{const res=await fetch(base+path,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()}};
 try{
  const created=await request('/api/repertoire','POST',{kind:'VOCAL',title:'HTTP唱',language:'en',lyrics:[{startMs:0,text:'Hello'}],sections:[{id:'s1',type:'intro',label:'Intro',startMs:0,endMs:4000}]});
  assert.equal(created.status,201);assert.equal(created.data.language,'en');assert.equal(created.data.sections[0].id,'s1');
  const patched=await request('/api/repertoire/'+created.data.id,'PATCH',{practice:{skipRap:true}});
  assert.equal(patched.status,200);assert.equal(patched.data.practice.skipRap,true);assert.equal(patched.data.lyrics[0].text,'Hello');
  const job=seedJob(db);
  const attached=await request('/api/repertoire/'+created.data.id+'/media','POST',{importJobId:job.jobId,track:'accompaniment',offsetMs:60});
  assert.equal(attached.status,200);assert.equal(attached.data.tracks.accompaniment.media.id,job.clipId);assert.equal(attached.data.tracks.accompaniment.offsetMs,60);
  const reread=await request('/api/repertoire/'+created.data.id);
  assert.equal(reread.data.tracks.accompaniment.media.url,`/api/media/audio/${job.clipId}`);
  const manifest=await request('/api/sync/manifest');
  assert.equal(manifest.data.repertoire.find(row=>row.id===created.data.id).sections[0].label,'Intro');
  const duplicate=await request('/api/repertoire/'+created.data.id+'/media','POST',{importJobId:job.jobId,track:'original'});
  assert.equal(duplicate.status,409);
 }finally{await new Promise(resolve=>server.close(resolve));db.close();rmSync(root,{recursive:true,force:true});}
});
