import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../server/db/database.mjs';
import { createApiServer } from '../server/index.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');

test('link import keeps original link when supplementing local video; manual cover works', async () => {
  const root = mkdtempSync(join(tmpdir(),'dance-link-'));
  const db = openDatabase(join(root,'db.sqlite'));
  const server = createApiServer({ db, mediaRoot:join(root,'media') });
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = p => fetch(base + p).then(async r => ({ status:r.status, data:await r.json() }));
  const json = (p, m, body) => fetch(base + p, { method:m, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }).then(async r => ({ status:r.status, data:await r.json() }));
  try {
    // 未注册 host 拒绝
    const bad = await json('/api/imports/link','POST',{ link:'https://example.com/x' });
    assert.equal(bad.status, 400);
    // 抖音 host → NEEDS_INPUT 且保留链接
    const link = 'https://v.douyin.com/abc123/';
    const need = await json('/api/imports/link','POST',{ link });
    assert.equal(need.status, 202);
    assert.equal(need.data.status,'NEEDS_INPUT');
    assert.equal(need.data.draft.capability.canAcquire,false);
    assert.equal(need.data.draft.link, link);
    // 补充本地视频，链接必须保留
    const source = join(root,'v.mp4');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=red:s=160x120:d=1','-f','lavfi','-i','sine=frequency=300:duration=1','-c:v','libx264','-c:a','aac','-shortest',source]);
    const sup = await fetch(`${base}/api/imports/${need.data.id}/supplement`,{ method:'POST', headers:{'Content-Type':'video/mp4','X-File-Name':encodeURIComponent('补充视频.mp4')}, body:readFileSync(source) });
    assert.equal(sup.status, 202);
    let job;
    for (let i=0;i<100;i++){ job=(await get(`/api/imports/${need.data.id}`)).data; if(job.status==='READY'||job.status==='FAILED') break; await new Promise(r=>setTimeout(r,20)); }
    assert.equal(job.status,'READY');
    assert.equal(job.draft.link, link);
    const saved = await json(`/api/imports/${need.data.id}/finalize`,'POST',{ title:'补充后的舞蹈' });
    assert.equal(saved.status,201);
    assert.equal(saved.data.source.sourceLocator, link, '最终条目必须保留原分享链接');
    // 人工封面
    const cover = await fetch(`${base}/api/dances/${saved.data.id}/cover`,{ method:'POST', headers:{'Content-Type':'image/png'}, body:PNG });
    assert.equal(cover.status,200);
    const withCover = await cover.json();
    assert.ok(withCover.cover?.url, '应返回封面地址');
    const fetched = await fetch(base + withCover.cover.url);
    assert.equal(fetched.status,200);
    assert.equal((await fetched.arrayBuffer()).byteLength, PNG.byteLength);
    // 伪图片被拒绝
    const fake = await fetch(`${base}/api/dances/${saved.data.id}/cover`,{ method:'POST', headers:{'Content-Type':'image/png'}, body:'not-an-image' });
    assert.equal(fake.status,415);
  } finally { await new Promise(r=>server.close(r)); db.close(); rmSync(root,{recursive:true,force:true}); }
});
