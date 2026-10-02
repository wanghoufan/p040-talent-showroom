import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db/database.mjs';
import { createApiServer } from '../server/index.mjs';

function seed(db, status = 'CAN_DANCE') {
  const sourceId = randomUUID(), clipId = randomUUID(), songId = randomUUID(), danceId = randomUUID();
  db.prepare("INSERT INTO source_media(id,source_kind,sha256,duration_ms) VALUES(?,'AUDIO','s',1000)").run(sourceId);
  db.prepare("INSERT INTO performance_clips(id,source_media_id,start_ms,end_ms,internal_audio_path,codec,source_preserving,sha256,size_bytes,duration_ms) VALUES(?,?,0,1000,'audio/x.m4a','aac',1,'ah',100,1000)").run(clipId, sourceId);
  db.prepare("INSERT INTO song_identities(id,title,artist,recognition_status) VALUES(?,'歌','手','MANUAL')").run(songId);
  db.prepare("INSERT INTO dance_items(id,song_identity_id,source_media_id,performance_clip_id,learning_status,scene_mask) VALUES(?,?,?,?,?,1)").run(danceId, songId, sourceId, clipId, status);
  return danceId;
}

async function withServer(run) {
  const root = mkdtempSync(join(tmpdir(), 'dance-playlist-'));
  const db = openDatabase(join(root, 'db.sqlite'));
  const server = createApiServer({ db, mediaRoot: join(root, 'media') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ base, db }); }
  finally { await new Promise((resolve) => server.close(resolve)); db.close(); rmSync(root, { recursive: true, force: true }); }
}

test('今晚歌单：PUT 覆盖顺序稳定、GET 按 position 返回', async () => {
  await withServer(async ({ base, db }) => {
    const a = seed(db), b = seed(db), c = seed(db);
    let res = await fetch(`${base}/api/playlists/tonight`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [c, a, b] }) });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).items, [c, a, b]);
    res = await fetch(`${base}/api/playlists/tonight`);
    assert.deepEqual((await res.json()).items, [c, a, b]);
    // 重排后顺序不变地持久化
    await fetch(`${base}/api/playlists/tonight`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [b, c, a] }) });
    const again = await (await fetch(`${base}/api/playlists/tonight`)).json();
    assert.deepEqual(again.items, [b, c, a]);
    // 清空
    await fetch(`${base}/api/playlists/tonight`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [] }) });
    assert.deepEqual((await (await fetch(`${base}/api/playlists/tonight`)).json()).items, []);
  });
});

test('今晚歌单：重复 id / 未知 id 被拒绝，且不破坏已有歌单', async () => {
  await withServer(async ({ base, db }) => {
    const a = seed(db), b = seed(db);
    await fetch(`${base}/api/playlists/tonight`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [a, b] }) });
    const dup = await fetch(`${base}/api/playlists/tonight`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [a, a] }) });
    assert.equal(dup.status, 400);
    const missing = await fetch(`${base}/api/playlists/tonight`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [a, randomUUID()] }) });
    assert.equal(missing.status, 400);
    assert.deepEqual((await (await fetch(`${base}/api/playlists/tonight`)).json()).items, [a, b]);
  });
});

test('今晚歌单：软删除的曲目不可入单', async () => {
  await withServer(async ({ base, db }) => {
    const a = seed(db);
    db.prepare("UPDATE dance_items SET deleted_at=CURRENT_TIMESTAMP WHERE id=?").run(a);
    const res = await fetch(`${base}/api/playlists/tonight`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [a] }) });
    assert.equal(res.status, 400);
  });
});
