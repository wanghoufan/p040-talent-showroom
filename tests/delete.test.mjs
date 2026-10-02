import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db/database.mjs';
import { createApiServer } from '../server/index.mjs';

/** 造一条可删除的曲目：默认自带 source + clip 文件；传入共享 sourceId 则复用同一原始媒体。 */
function seed(db, mediaRoot, { sourceId: sharedSource } = {}) {
  mkdirSync(join(mediaRoot, 'source'), { recursive: true });
  mkdirSync(join(mediaRoot, 'audio'), { recursive: true });
  const sourceId = sharedSource || randomUUID();
  const clipId = randomUUID(), songId = randomUUID(), danceId = randomUUID();
  const sourcePath = `source/${sourceId}.mp4`, clipPath = `audio/${clipId}.m4a`;
  if (!sharedSource) {
    writeFileSync(join(mediaRoot, sourcePath), 'source');
    db.prepare("INSERT INTO source_media(id,source_kind,internal_path,sha256,duration_ms) VALUES(?,'VIDEO',?,?,1000)").run(sourceId, sourcePath, `s-${sourceId}`);
  }
  writeFileSync(join(mediaRoot, clipPath), 'clip');
  db.prepare("INSERT INTO performance_clips(id,source_media_id,start_ms,end_ms,internal_audio_path,codec,source_preserving,sha256,size_bytes,duration_ms) VALUES(?,?,0,1000,?,'aac',1,?,100,1000)").run(clipId, sourceId, clipPath, `ah-${clipId}`);
  db.prepare("INSERT INTO song_identities(id,title,artist,recognition_status) VALUES(?,'歌','手','MANUAL')").run(songId);
  db.prepare("INSERT INTO dance_items(id,song_identity_id,source_media_id,performance_clip_id,learning_status,scene_mask) VALUES(?,?,?,?,'CAN_DANCE',1)").run(danceId, songId, sourceId, clipId);
  return { danceId, sourceId, clipId, sourcePath, clipPath };
}

async function withServer(run) {
  const root = mkdtempSync(join(tmpdir(), 'dance-delete-'));
  const mediaRoot = join(root, 'media');
  mkdirSync(mediaRoot, { recursive: true });
  const db = openDatabase(join(root, 'db.sqlite'));
  const server = createApiServer({ db, mediaRoot });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ base, db, mediaRoot }); }
  finally { await new Promise((resolve) => server.close(resolve)); db.close(); rmSync(root, { recursive: true, force: true }); }
}

test('安全删除：默认仅记录，媒体文件保留，曲库减少并移出歌单', async () => {
  await withServer(async ({ base, db, mediaRoot }) => {
    const { danceId, sourcePath, clipPath } = seed(db, mediaRoot);
    await fetch(`${base}/api/playlists/tonight`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [danceId] }) });
    const res = await fetch(`${base}/api/dances/${danceId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deleted: true, mediaDeleted: 0 });
    // 媒体文件原样保留
    assert.equal(existsSync(join(mediaRoot, sourcePath)), true);
    assert.equal(existsSync(join(mediaRoot, clipPath)), true);
    // 软删除：详情 404，曲库不再返回，歌单被移出
    assert.equal((await fetch(`${base}/api/dances/${danceId}`)).status, 404);
    const catalog = await (await fetch(`${base}/api/catalog`)).json();
    assert.equal(catalog.items.some((i) => i.id === danceId), false);
    assert.deepEqual((await (await fetch(`${base}/api/playlists/tonight`)).json()).items, []);
  });
});

test('安全删除：deleteMedia 且无其他引用时回收原始媒体与派生片段', async () => {
  await withServer(async ({ base, db, mediaRoot }) => {
    const { danceId, sourcePath, clipPath } = seed(db, mediaRoot);
    const res = await fetch(`${base}/api/dances/${danceId}?media=1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deleted: true, mediaDeleted: 2 });
    assert.equal(existsSync(join(mediaRoot, sourcePath)), false);
    assert.equal(existsSync(join(mediaRoot, clipPath)), false);
  });
});

test('安全删除：仍被其他曲目引用的原始媒体不被回收', async () => {
  await withServer(async ({ base, db, mediaRoot }) => {
    const first = seed(db, mediaRoot);
    const second = seed(db, mediaRoot, { sourceId: first.sourceId });
    await fetch(`${base}/api/dances/${first.danceId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deleteMedia: true }) });
    // 共享的原始媒体仍被 second 引用 → 保留；first 自己的片段被回收。
    assert.equal(existsSync(join(mediaRoot, first.sourcePath)), true);
    assert.equal(existsSync(join(mediaRoot, first.clipPath)), false);
    assert.equal(existsSync(join(mediaRoot, second.clipPath)), true);
  });
});
