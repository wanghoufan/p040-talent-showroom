import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../server/db/database.mjs';
import { createApiServer } from '../server/index.mjs';

test('empty library imports real video, disabled provider saves source, duplicate is explicit, fake MIME fails', async()=>{
  const root=mkdtempSync(join(tmpdir(),'dance-import-'));
  const db=openDatabase(join(root,'db.sqlite'));
  const server=createApiServer({db,mediaRoot:join(root,'media')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(path,init)=>{const res=await fetch(base+path,init);return {status:res.status,data:await res.json()};};
  try {
    assert.deepEqual((await request('/api/catalog')).data.items,[]);
    const source=join(root,'video.mp4');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=160x120:d=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-c:a','aac','-shortest',source]);
    const upload=()=>request('/api/imports/file',{method:'POST',headers:{'Content-Type':'video/mp4','X-File-Name':encodeURIComponent('中文视频.mp4')},body:readFileSync(source)});
    const accepted=await upload(); assert.equal(accepted.status,202);
    let job;
    for(let i=0;i<100;i++){
      job=(await request(`/api/imports/${accepted.data.id}`)).data;
      if(job.status==='READY'||job.status==='FAILED') break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(job.status,'READY'); assert.equal(job.draft.learningStatus,'WANT_TO_LEARN');
    const saved=await request(`/api/imports/${job.id}/finalize`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'我的舞',sceneTags:['COOL','OUTDOOR']})});
    assert.equal(saved.status,201);
    const item=saved.data;
    assert.equal(item.title,'我的舞');assert.ok(item.sourceMediaId);assert.ok(item.audio.sha256);
    const media=await fetch(base+item.audio.url,{headers:{Range:'bytes=0-9'}});
    assert.equal(media.status,206);assert.equal((await media.arrayBuffer()).byteLength,10);
    const changed=await request(`/api/dances/${item.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'改名',artist:'新歌手'})});
    assert.equal(changed.data.audio.sha256,item.audio.sha256);
    assert.equal((await request('/api/catalog?scene=COOL&scene=OUTDOOR')).data.items.length,1);
    assert.equal((await request('/api/catalog?scene=SEXY')).data.items.length,0);
    const duplicate=await upload();assert.equal(duplicate.data.duplicateId,item.id);
    const bad=await request('/api/imports/file',{method:'POST',headers:{'Content-Type':'video/mp4'},body:'fake-video'});
    assert.equal(bad.status,202);
    for(let i=0;i<100;i++){
      const failed=(await request(`/api/imports/${bad.data.id}`)).data;
      if(failed.status==='FAILED'){assert.equal(failed.errorCode,'INVALID_MEDIA');break;}
      if(i===99) assert.fail('fake MIME did not fail');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  } finally { await new Promise(resolve=>server.close(resolve));db.close();rmSync(root,{recursive:true,force:true}); }
});
