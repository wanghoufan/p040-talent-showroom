import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openDatabase } from '../server/db/database.mjs';
import { createApiServer } from '../server/index.mjs';

async function importOne(base, source) {
  const res = await fetch(base + '/api/imports/file', { method:'POST', headers:{'Content-Type':'video/mp4','X-File-Name':encodeURIComponent('裁剪测试.mp4')}, body:readFileSync(source) });
  const { id } = await res.json();
  for (let i = 0; i < 100; i++) {
    const job = await (await fetch(`${base}/api/imports/${id}`)).json();
    if (job.status === 'READY' || job.status === 'FAILED') return job;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('import timeout');
}

test('clip derivation is non-destructive: source hash stable, trim then restore', async () => {
  const root = mkdtempSync(join(tmpdir(),'dance-clip-'));
  const db = openDatabase(join(root,'db.sqlite'));
  const server = createApiServer({ db, mediaRoot:join(root,'media') });
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = (path, method, body) => fetch(base + path, { method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }).then(r=>r.json());
  try {
    const source = join(root,'src.mp4');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=160x120:d=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-c:a','aac','-shortest',source]);
    const sourceHash = createHash('sha256').update(readFileSync(source)).digest('hex');
    const job = await importOne(base, source);
    assert.equal(job.status,'READY');
    const item = await json(`/api/imports/${job.id}/finalize`,'POST',{title:'裁剪'});
    assert.equal(item.audio.sourcePreserving,true);
    const originalAudioHash = item.audio.sha256;

    const trimmed = await json(`/api/dances/${item.id}/clip`,'PUT',{startMs:200,endMs:700});
    assert.equal(trimmed.audio.sha256 !== originalAudioHash, true, '新片段应有不同 hash');
    assert.equal(trimmed.audio.startMs,200);
    assert.equal(trimmed.audio.endMs,700);
    assert.ok(trimmed.durationMs >= 450 && trimmed.durationMs <= 550, `期望约 500ms，实际 ${trimmed.durationMs}`);
    assert.equal(trimmed.source.sha256, item.source.sha256, '来源媒体 hash 必须不变');
    assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), sourceHash, '原始文件 hash 必须不变');

    const restored = await json(`/api/dances/${item.id}/clip`,'PUT',{startMs:0,endMs:item.source.durationMs});
    assert.equal(restored.audio.startMs,0);
    assert.ok(restored.durationMs >= 950, `恢复后应约 1000ms，实际 ${restored.durationMs}`);

    const renamed = await json(`/api/dances/${item.id}`,'PATCH',{title:'改名',artist:'歌手'});
    assert.equal(renamed.audio.sha256, restored.audio.sha256, '改名不得改变片段 hash');

    await assert.rejects(async () => {
      const res = await fetch(`${base}/api/dances/${item.id}/clip`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({startMs:900,endMs:800}) });
      if (!res.ok) throw new Error('INVALID_CLIP');
    });
  } finally { await new Promise(r=>server.close(r)); db.close(); rmSync(root,{recursive:true,force:true}); }
});
