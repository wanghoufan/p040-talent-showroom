import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../server/db/database.mjs';
import {getRepertoire,saveRepertoire} from '../server/repertoire/service.mjs';
import {syncOperation} from '../server/sync-operations.mjs';

function withDb(run){const root=mkdtempSync(join(tmpdir(),'p040-vocal-sync-'));const db=openDatabase(join(root,'db.sqlite'));try{return run(db)}finally{db.close();rmSync(root,{recursive:true,force:true})}}

test('离线排队改歌词/结构/练习：经服务层校验后落盘，revision 递增且精确重试幂等',()=>withDb(db=>{
 const item=saveRepertoire(db,null,{kind:'VOCAL',title:'同步歌词'});
 const op={operationId:randomUUID(),kind:'VOCAL',id:item.id,action:'update',baseRevision:item.revision,fields:{
  language:'ko',
  lyrics:[{startMs:0,text:'첫 소절'}],
  sections:[{id:'v1',type:'verse',label:'V1',startMs:0,endMs:12000}],
  practice:{skipRap:true},
 }};
 const result=syncOperation(db,op);
 assert.equal(result.status,'applied');
 assert.equal(result.revision,item.revision+1);
 assert.equal(result.item.language,'ko');
 assert.equal(result.item.lyrics[0].text,'첫 소절');
 assert.equal(result.item.sections[0].source,'manual');
 // 局部练习设置按服务端默认增量合并，不把未提交项清空。
 assert.equal(result.item.practice.skipRap,true);
 assert.equal(result.item.practice.forwardSeconds,10);
 assert.equal(result.item.practice.playbackRate,1);
 assert.equal(result.item.title,'同步歌词');
 // 同一 operationId 精确重试返回同一结果，不重复加版本。
 assert.deepEqual(syncOperation(db,op),result);
 assert.equal(getRepertoire(db,item.id).revision,result.revision);
}));

test('过期 baseRevision 不写入：返回服务器快照，本地待合并的是云端真值',()=>withDb(db=>{
 const item=saveRepertoire(db,null,{kind:'VOCAL',title:'冲突'});
 const applied=syncOperation(db,{operationId:randomUUID(),kind:'VOCAL',id:item.id,action:'update',baseRevision:item.revision,fields:{lyrics:[{startMs:0,text:'云端句'}]}});
 const stale=syncOperation(db,{operationId:randomUUID(),kind:'VOCAL',id:item.id,action:'update',baseRevision:item.revision,fields:{lyrics:[{startMs:0,text:'手机过期句'}]}});
 assert.equal(stale.status,'conflict');
 assert.equal(stale.revision,applied.revision);
 assert.equal(stale.server.lyrics[0].text,'云端句');
 assert.equal(getRepertoire(db,item.id).lyrics[0].text,'云端句');
 // 冲突后按服务器新版本重提即可正常保存。
 const retry=syncOperation(db,{operationId:randomUUID(),kind:'VOCAL',id:item.id,action:'update',baseRevision:applied.revision,fields:{lyrics:[{startMs:0,text:'合并后句'}]}});
 assert.equal(retry.status,'applied');
 assert.equal(retry.item.lyrics[0].text,'合并后句');
}));

test('唱歌字段拒绝越权：吉他、create、任意对象与媒体字段一律 BAD_REQUEST',()=>withDb(db=>{
 const guitar=saveRepertoire(db,null,{kind:'GUITAR',title:'吉他'});
 const vocal=saveRepertoire(db,null,{kind:'VOCAL',title:'唱歌'});
 const op=fields=>({operationId:randomUUID(),kind:'VOCAL',id:vocal.id,action:'update',baseRevision:vocal.revision,fields});
 assert.throws(()=>syncOperation(db,{operationId:randomUUID(),kind:'GUITAR',id:guitar.id,action:'update',baseRevision:guitar.revision,fields:{language:'zh'}}),/BAD_REQUEST/);
 assert.throws(()=>syncOperation(db,{operationId:randomUUID(),kind:'VOCAL',id:randomUUID(),action:'create',baseRevision:0,fields:{title:'新唱',lyrics:[{startMs:0,text:'句'}]}}),/BAD_REQUEST/);
 assert.throws(()=>syncOperation(db,op({lyrics:{not:'array'}})),/BAD_REQUEST/);
 assert.throws(()=>syncOperation(db,op({language:'fr'})),/BAD_REQUEST/);
 assert.throws(()=>syncOperation(db,op({practice:{backwardSeconds:7}})),/INVALID_PRACTICE/);
 assert.throws(()=>syncOperation(db,op({tracks:{original:{media:{id:'x'}}}})),/BAD_REQUEST/);
 assert.throws(()=>syncOperation(db,op({sections:[{id:'s1',type:'verse',label:'A',startMs:0,endMs:0}]})),/INVALID_SECTIONS/);
 // 全部被拒绝后数据保持原样。
 assert.deepEqual(getRepertoire(db,vocal.id).lyrics,[]);
 assert.equal(getRepertoire(db,vocal.id).language,undefined);
}));

test('过大歌词拒绝（413）且不改动数据，避免把完整分析塞进同步操作',()=>withDb(db=>{
 const item=saveRepertoire(db,null,{kind:'VOCAL',title:'大歌词'});
 const lyrics=Array.from({length:900},(_,index)=>({startMs:index*10,text:'字'.repeat(80)}));
 assert.throws(
  ()=>syncOperation(db,{operationId:randomUUID(),kind:'VOCAL',id:item.id,action:'update',baseRevision:item.revision,fields:{lyrics}}),
  error=>error.message==='PAYLOAD_TOO_LARGE'&&error.status===413,
 );
 assert.deepEqual(getRepertoire(db,item.id).lyrics,[]);
 assert.equal(getRepertoire(db,item.id).revision,item.revision);
}));

test('唱歌写入后旧字段通道继续可用，且不会抹掉歌词与结构',()=>withDb(db=>{
 const item=saveRepertoire(db,null,{kind:'VOCAL',title:'混合修改'});
 const vocal=syncOperation(db,{operationId:randomUUID(),kind:'VOCAL',id:item.id,action:'update',baseRevision:item.revision,fields:{language:'en',sections:[{id:'b1',type:'chorus',label:'B1',startMs:0,endMs:9000}]}});
 const plain=syncOperation(db,{operationId:randomUUID(),kind:'VOCAL',id:item.id,action:'update',baseRevision:vocal.revision,fields:{notes:'手机备注',performanceKey:'D'}});
 assert.equal(plain.status,'applied');
 assert.equal(plain.revision,vocal.revision+1);
 assert.equal(plain.item.notes,'手机备注');
 assert.equal(plain.item.language,'en');
 assert.equal(plain.item.sections[0].label,'B1');
}));
