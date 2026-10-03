import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../server/db/database.mjs';
import {createApiServer} from '../server/index.mjs';
import {saveRepertoire} from '../server/repertoire/service.mjs';
test('实际HTTP隔离来宾与管理/媒体，限流明示且清理历史保留待处理项',async()=>{
 const root=mkdtempSync(join(tmpdir(),'p040-private-')),db=openDatabase(join(root,'db'));
 const refs=Array.from({length:6},(_,i)=>({kind:'VOCAL',id:saveRepertoire(db,null,{kind:'VOCAL',title:`公开${i}`,notes:'私密',scoreText:'私谱'}).id}));
 const server=createApiServer({db,mediaRoot:root,pairCode:'test-only'});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const call=(path,method='GET',body,token)=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
 try{
  assert.equal((await call('/api/request-sessions','POST',{items:refs})).status,401);
  const {token}=await (await call('/api/pair','POST',{code:'test-only'})).json();assert.equal(typeof token,'string');
  for(const path of ['/api/catalog','/api/library/trash','/api/media/audio/'+randomUUID(),'/api/media/score/'+randomUUID()])assert.equal((await call(path)).status,401);
  assert.equal((await call('/api/catalog?owner='+token)).status,401);
  const session=await (await call('/api/request-sessions','POST',{items:refs},token)).json();
  const publicData=await (await call('/api/public/request-sessions/'+session.token)).json();assert.ok(!JSON.stringify(publicData).includes('私密'));assert.ok(!JSON.stringify(publicData).includes('scoreText'));
  const visitor=randomUUID(),ids=[];for(const ref of refs.slice(0,5)){const res=await call('/api/public/request-sessions/'+session.token+'/requests','POST',{...ref,visitor,nickname:'验收',note:''});assert.equal(res.status,201);ids.push((await res.json()).id);}
  const limited=await call('/api/public/request-sessions/'+session.token+'/requests','POST',{...refs[5],visitor,nickname:'',note:''});assert.equal(limited.status,429);assert.equal((await limited.json()).error.code,'RATE_LIMIT');
  await call('/api/requests/'+ids[0],'POST',{decision:'REJECTED'},token);assert.equal((await (await call('/api/requests/history','DELETE',undefined,token)).json()).cleared,1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM guest_requests WHERE state='PENDING'").get().n,4);
  await call('/api/request-sessions/'+session.id,'DELETE',undefined,token);assert.equal((await call('/api/public/request-sessions/'+session.token)).status,404);
 }finally{await new Promise(r=>server.close(r));db.close();rmSync(root,{recursive:true,force:true});}
});
