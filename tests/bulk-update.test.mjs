import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db/database.mjs';
import { createApiServer } from '../server/index.mjs';

function seed(db, mask = 1) {
  const source = randomUUID(), clip = randomUUID(), song = randomUUID(), id = randomUUID();
  db.prepare("INSERT INTO source_media(id,source_kind,sha256,duration_ms) VALUES(?,'AUDIO','source-original',1000)").run(source);
  db.prepare("INSERT INTO performance_clips(id,source_media_id,start_ms,end_ms,internal_audio_path,codec,source_preserving,sha256,size_bytes,duration_ms) VALUES(?,?,0,1000,'audio/x.m4a','aac',1,'audio-original',100,1000)").run(clip, source);
  db.prepare("INSERT INTO song_identities(id,title,artist,recognition_status) VALUES(?,'原歌名','原歌手','MATCHED')").run(song);
  db.prepare("INSERT INTO dance_items(id,song_identity_id,source_media_id,performance_clip_id,learning_status,scene_mask) VALUES(?,?,?,?,'WANT_TO_LEARN',?)").run(id, song, source, clip, mask);
  return id;
}
async function withServer(run) {
  const root = mkdtempSync(join(tmpdir(), 'dance-bulk-'));
  const db = openDatabase(join(root, 'db.sqlite'));
  const server = createApiServer({ db, mediaRoot: join(root, 'media') });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const update = async body => {
    const response = await fetch(base + '/api/dances/bulk', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const catalog = async () => (await fetch(base + '/api/catalog')).json();
  try { await run({ db, update, catalog }); }
  finally { await new Promise(r => server.close(r)); db.close(); rmSync(root, { recursive: true, force: true }); }
}

test('批量状态只修改所选曲目，三种状态均可持久化，媒体和识曲信息不变', async () => {
  await withServer(async ({ db, update, catalog }) => {
    const a = seed(db), b = seed(db, 4), c = seed(db);
    const before = await catalog();
    for (const learningStatus of ['PRACTICING', 'CAN_DANCE', 'WANT_TO_LEARN']) {
      const result = await update({ ids: [a, b], learningStatus });
      assert.equal(result.status, 200);
      const after = await catalog();
      for (const id of [a, b]) {
        const item = after.items.find(x => x.id === id);
        assert.equal(item.learningStatus, learningStatus);
        assert.equal(item.audio.sha256, 'audio-original');
        assert.equal(item.source.sha256, 'source-original');
        assert.equal(item.title, '原歌名');
        assert.deepEqual(item.sceneTags, id === a ? ['COOL'] : ['OUTDOOR']);
      }
      assert.equal(after.items.find(x => x.id === c).learningStatus, 'WANT_TO_LEARN');
    }
    assert.equal((await catalog()).catalogVersion, before.catalogVersion + 3);
    assert.ok(db.prepare('SELECT recognition_status FROM song_identities').all().every(x => x.recognition_status === 'MATCHED'));
  });
});
test('批量标签添加保留旧标签，移除仅删指定标签，替换可明确清空', async () => {
  await withServer(async ({ db, update, catalog }) => {
    const a = seed(db, 1), b = seed(db, 2), c = seed(db, 8);
    assert.equal((await update({ ids: [a, b], sceneMode: 'add', sceneTags: ['OUTDOOR'] })).status, 200);
    let items = (await catalog()).items;
    assert.deepEqual(items.find(x => x.id === a).sceneTags, ['COOL', 'OUTDOOR']);
    assert.deepEqual(items.find(x => x.id === b).sceneTags, ['SEXY', 'OUTDOOR']);
    assert.equal((await update({ ids: [a, b], sceneMode: 'remove', sceneTags: ['OUTDOOR'] })).status, 200);
    assert.deepEqual((await catalog()).items.find(x => x.id === a).sceneTags, ['COOL']);
    assert.equal((await update({ ids: [a, b], sceneMode: 'replace', sceneTags: ['TRANSITION'] })).status, 200);
    assert.deepEqual((await catalog()).items.find(x => x.id === b).sceneTags, ['TRANSITION']);
    assert.equal((await update({ ids: [a, b], sceneMode: 'replace', sceneTags: [] })).status, 200);
    items = (await catalog()).items;
    assert.deepEqual(items.find(x => x.id === a).sceneTags, []);
    assert.deepEqual(items.find(x => x.id === c).sceneTags, ['TRANSITION']);
  });
});
test('批量拒绝空选择、重复/未知/删除曲目、非法分类及无操作，整批不得部分写入', async () => {
  await withServer(async ({ db, update, catalog }) => {
    const a = seed(db), deleted = seed(db);
    db.prepare('UPDATE dance_items SET deleted_at=CURRENT_TIMESTAMP WHERE id=?').run(deleted);
    const before = await catalog();
    for (const body of [
      { ids: [], learningStatus: 'CAN_DANCE' }, { ids: [a, a], learningStatus: 'CAN_DANCE' },
      { ids: [a, randomUUID()], learningStatus: 'CAN_DANCE' }, { ids: [a, deleted], learningStatus: 'CAN_DANCE' },
      { ids: [a], learningStatus: 'OTHER' }, { ids: [a], sceneMode: 'add', sceneTags: ['OTHER'] },
      { ids: [a], sceneMode: 'add', sceneTags: [] }, { ids: [a], sceneTags: ['COOL'] },
      { ids: [a], sceneMode: 'add', sceneTags: ['COOL', 'COOL'] }, { ids: [a] },
      { ids: [a], title: '不能批量改音频元数据', learningStatus: 'CAN_DANCE' },
    ]) {
      assert.equal((await update(body)).status, 400);
      assert.deepEqual(await catalog(), before);
    }
  });
});
test('批量写入中途失败回滚全部分类与曲库版本', async () => {
  await withServer(async ({ db, update, catalog }) => {
    const a = seed(db), b = seed(db);
    const before = await catalog();
    db.exec(`CREATE TRIGGER fail_bulk BEFORE UPDATE ON dance_items WHEN OLD.id='${b}' BEGIN SELECT RAISE(ABORT,'test failure'); END`);
    assert.equal((await update({ ids: [a, b], learningStatus: 'CAN_DANCE' })).status, 400);
    assert.deepEqual(await catalog(), before);
  });
});
