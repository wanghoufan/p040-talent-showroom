import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db/database.mjs';
import { saveRepertoire } from '../server/repertoire/service.mjs';
import { bulkLibrary,listTrash } from '../server/library/service.mjs';
import { getProgram,setProgram } from '../server/program/service.mjs';
function run(fn){const root=mkdtempSync(join(tmpdir(),'p040-library-'));const db=openDatabase(join(root,'db.sqlite'));try{return fn(db);}finally{db.close();rmSync(root,{recursive:true,force:true});}}
test('三类批量事务：删除进入回收站，节目单同步移除，恢复不恢复旧节目单，重复操作幂等',()=>run(db=>{
 const a=saveRepertoire(db,null,{kind:'GUITAR',title:'A'}),b=saveRepertoire(db,null,{kind:'VOCAL',title:'B'});const refs=[{kind:a.kind,id:a.id},{kind:b.kind,id:b.id}];setProgram(db,refs);
 const body={operationId:randomUUID(),action:'trash',refs};const first=bulkLibrary(db,body);assert.deepEqual(bulkLibrary(db,body),first);assert.equal(listTrash(db).items.length,2);assert.equal(getProgram(db).items.length,0);
 bulkLibrary(db,{operationId:randomUUID(),action:'restore',refs});assert.equal(listTrash(db).items.length,0);assert.equal(getProgram(db).items.length,0);
}));
test('批量非法字段/失效ID整批回滚，operationId不能复用于不同操作',()=>run(db=>{
 const a=saveRepertoire(db,null,{kind:'GUITAR',title:'A'});const ref={kind:'GUITAR',id:a.id};
 assert.throws(()=>bulkLibrary(db,{operationId:randomUUID(),action:'update',refs:[ref],fields:{capo:13}}));
 assert.throws(()=>bulkLibrary(db,{operationId:randomUUID(),action:'trash',refs:[ref,{kind:'GUITAR',id:randomUUID()}]}));assert.equal(db.prepare('SELECT deleted_at FROM repertoire_items WHERE id=?').get(a.id).deleted_at,null);
 const op=randomUUID();bulkLibrary(db,{operationId:op,action:'update',refs:[ref],fields:{capo:3}});assert.throws(()=>bulkLibrary(db,{operationId:op,action:'trash',refs:[ref]}));
}));
test('混合节目单保持顺序、禁止重复与不存在项，纯文本合法，失败不改变已有顺序',()=>run(db=>{
 const a=saveRepertoire(db,null,{kind:'GUITAR',title:'谱'}),b=saveRepertoire(db,null,{kind:'VOCAL',title:'词'});const refs=[{kind:b.kind,id:b.id},{kind:a.kind,id:a.id}];setProgram(db,refs);assert.deepEqual(getProgram(db).items,refs);
 assert.throws(()=>setProgram(db,[refs[0],refs[0]]));assert.deepEqual(getProgram(db).items,refs);
}));
