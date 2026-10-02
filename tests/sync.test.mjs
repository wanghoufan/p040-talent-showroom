import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db/database.mjs';
import { createApiServer } from '../server/index.mjs';

test('sync manifest 输出快照与媒体元数据，且不含绝对路径', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dance-sync-'));
  const db = openDatabase(join(root, 'db.sqlite'));
  const server = createApiServer({ db, mediaRoot: join(root, 'media') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const sourceId = randomUUID(), clipId = randomUUID(), songId = randomUUID(), danceId = randomUUID();
    db.prepare("INSERT INTO source_media(id,source_kind,sha256,duration_ms) VALUES(?,'AUDIO','s',1000)").run(sourceId);
    db.prepare("INSERT INTO performance_clips(id,source_media_id,start_ms,end_ms,internal_audio_path,codec,source_preserving,sha256,size_bytes,duration_ms) VALUES(?,?,0,1000,'audio/x.m4a','aac',1,'ah',100,1000)").run(clipId, sourceId);
    db.prepare("INSERT INTO song_identities(id,title,artist,recognition_status) VALUES(?,'歌','手','MANUAL')").run(songId);
    db.prepare("INSERT INTO dance_items(id,song_identity_id,source_media_id,performance_clip_id,learning_status,scene_mask) VALUES(?,?,?,?, 'CAN_DANCE',1)").run(danceId, songId, sourceId, clipId);
    db.prepare('INSERT INTO tonight_playlist_items(dance_item_id,position) VALUES(?,0)').run(danceId);

    const res = await fetch(`${base}/api/sync/manifest`);
    assert.equal(res.status, 200);
    const value = await res.json();
    assert.equal(value.count, 1);
    assert.equal(value.items[0].id, danceId);
    assert.equal(value.items[0].audio.sha256, 'ah');
    assert.equal(value.items[0].audio.version, 1);
    assert.deepEqual(value.playlist, [danceId]);
    assert.ok(!JSON.stringify(value).includes(root));
    assert.ok(JSON.stringify(value).indexOf('internal_audio_path') === -1);
  } finally { await new Promise((resolve) => server.close(resolve)); db.close(); rmSync(root, { recursive: true, force: true }); }
});
