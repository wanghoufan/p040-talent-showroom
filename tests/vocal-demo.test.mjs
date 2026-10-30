import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db/database.mjs';
import { importDemo, clearDemo, listDemo } from '../server/library/demo.mjs';
import { getRepertoire, saveRepertoire } from '../server/repertoire/service.mjs';
import { fileIdentity } from '../server/media/ffmpeg.mjs';

const root0 = new URL('../server/library/demo-assets/', import.meta.url);
const asset = name => fileURLToPath(new URL(name, root0));

const SONGS = {
  '城市慢半拍': { language: 'zh', lrc: 'city.lrc', lyrics: 10, sections: 7, rap: 1, durationMs: 66000 },
  '海风来信': { language: 'zh', lrc: 'harbor.lrc', lyrics: 8, sections: 6, rap: 0, durationMs: 60000 },
  'Open Windows': { language: 'en', lrc: 'window.lrc', lyrics: 9, sections: 7, rap: 0, durationMs: 66000 },
  'Neon Pulse': { language: 'en', lrc: 'pulse.lrc', lyrics: 12, sections: 6, rap: 2, durationMs: 72000 },
  '별빛 궤도': { language: 'ko', lrc: 'orbit.lrc', lyrics: 11, sections: 7, rap: 1, durationMs: 72000 },
};

/** 独立从 LRC 提取逐句时间，避免直接用被测算的解析函数自证。 */
function lrcLines(name) {
  const out = [];
  for (const raw of readFileSync(asset(name), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const times = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)\]/g)];
    if (!times.length) continue;
    const last = times[times.length - 1];
    const text = raw.slice(last.index + last[0].length).trim();
    if (text) out.push({ startMs: Math.round((Number(last[1]) * 60 + Number(last[2])) * 1000), text });
  }
  return out;
}

/** 建立一首不参与演示的真实曲目，带独立媒体文件，用于核对导入/清除前后完全不变。 */
async function seedRealItem(db, root) {
  const item = saveRepertoire(db, null, { kind: 'VOCAL', title: '真实曲目（不可污染）', artist: '真实歌手' });
  mkdirSync(join(root, 'real'), { recursive: true });
  const relativePath = 'real/real.mp3';
  copyFileSync(asset('harbor.mp3'), join(root, relativePath));
  const hash = await fileIdentity(join(root, relativePath));
  const sourceId = randomUUID();
  const clipId = randomUUID();
  db.prepare("INSERT INTO source_media(id,source_kind,internal_path,sha256,duration_ms,audio_codec,container) VALUES(?,'AUDIO',?,?,60000,'mp3','mp3')")
    .run(sourceId, relativePath, hash.sha256);
  db.prepare("INSERT INTO performance_clips(id,source_media_id,start_ms,end_ms,internal_audio_path,codec,source_preserving,sha256,size_bytes,duration_ms) VALUES(?,?,0,60000,?,'mp3',1,?,?,60000)")
    .run(clipId, sourceId, relativePath, hash.sha256, hash.sizeBytes);
  db.prepare('UPDATE repertoire_items SET source_media_id=?,performance_clip_id=? WHERE id=?').run(sourceId, clipId, item.id);
  return { item: getRepertoire(db, item.id), path: join(root, relativePath) };
}

function pathsFor(db, id) {
  const row = db.prepare('SELECT source_media_id,performance_clip_id,original_clip_id,accompaniment_clip_id FROM repertoire_items WHERE id=?').get(id);
  const ids = [row.source_media_id, row.performance_clip_id, row.original_clip_id, row.accompaniment_clip_id].filter(Boolean);
  const paths = new Set();
  for (const mediaId of ids) {
    const source = db.prepare('SELECT internal_path AS path FROM source_media WHERE id=?').get(mediaId);
    const clip = db.prepare('SELECT internal_audio_path AS path,source_media_id FROM performance_clips WHERE id=?').get(mediaId);
    if (source) paths.add(source.path);
    if (!clip) continue;
    paths.add(clip.path);
    const clipSource = db.prepare('SELECT internal_path AS path FROM source_media WHERE id=?').get(clip.source_media_id);
    if (clipSource) paths.add(clipSource.path);
  }
  return [...paths];
}

test('五首唱歌演示：独立双轨、语言/ LRC / 手工结构，重复导入幂等，清除不碰真实数据', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p040-vocal-demo-'));
  const db = openDatabase(join(root, 'db.sqlite'));
  try {
    const real = await seedRealItem(db, root);
    const realBefore = JSON.stringify(real.item);

    const first = await importDemo(db, root);
    assert.equal(first.items.length, 8);
    const byTitle = new Map(first.items.map(item => [item.title, item]));
    for (const [title, expected] of Object.entries(SONGS)) {
      const item = byTitle.get(title);
      assert.ok(item, `${title} 应被导入`);
      assert.equal(item.kind, 'VOCAL');
      assert.equal(item.isDemo, true);
      assert.equal(item.language, expected.language);
      assert.equal(item.durationMs, expected.durationMs);
      assert.equal(item.audioRole, 'ACCOMPANIMENT');
      assert.equal(item.lyrics.length, expected.lyrics);
      assert.equal(item.sections.length, expected.sections);
      assert.equal(item.sections.filter(section => section.type === 'rap').length, expected.rap);
      assert.ok(item.sections.every(section => section.source === 'manual'));
      assert.ok(item.artist.includes('合成导唱') && item.artist.includes('非真人'));
      assert.ok(item.notes.includes('不是真人演唱'));

      // 伴随 / 导唱必须是两条不同的媒体，且不能互相冒充。
      assert.ok(item.tracks?.original?.media && item.tracks?.accompaniment?.media);
      assert.notEqual(item.tracks.original.media.id, item.tracks.accompaniment.media.id);
      assert.notEqual(item.tracks.original.media.sha256, item.tracks.accompaniment.media.sha256);
      assert.equal(item.tracks.original.media.durationMs, expected.durationMs);
      assert.equal(item.tracks.accompaniment.media.durationMs, expected.durationMs);

      // 逐句歌词来自配套 LRC，段落引用不悬空。
      const source = lrcLines(expected.lrc);
      assert.deepEqual(item.lyrics.map(line => line.text), source.map(line => line.text));
      assert.deepEqual(item.lyrics.map(line => line.startMs), source.map(line => line.startMs));
      const sectionIds = new Set(item.sections.map(section => section.id));
      for (const line of item.lyrics) {
        assert.ok(sectionIds.has(line.sectionId), `${title} 的 ${line.id} 段落应存在`);
        const section = item.sections.find(entry => entry.id === line.sectionId);
        assert.ok(line.startMs >= section.startMs && line.startMs < section.endMs);
      }
      for (const section of item.sections) if (section.repeatOf) assert.ok(sectionIds.has(section.repeatOf));

      const files = pathsFor(db, item.id);
      assert.equal(files.length, 4);
      assert.ok(files.every(path => existsSync(join(root, path))));
    }
    assert.equal(byTitle.get('Open Windows').sections.find(section => section.id === 'B2').repetition, 'same-melody-new-lyrics');

    // 真实曲目与它的文件不得被导入影响。
    assert.equal(JSON.stringify(getRepertoire(db, real.item.id)), realBefore);
    assert.ok(existsSync(real.path));
    assert.equal(db.prepare('SELECT count(*) AS n FROM repertoire_items').get().n, 8);

    const ids = new Map(first.items.map(item => [item.title, item.id]));
    const again = await importDemo(db, root);
    assert.equal(again.items.length, 8);
    for (const [title, id] of ids) assert.equal(again.items.find(item => item.title === title).id, id);

    const demoPaths = Object.keys(SONGS).flatMap(title => pathsFor(db, ids.get(title)));
    const demoIds = new Set(Object.keys(SONGS).map(title => ids.get(title)));
    const cleared = clearDemo(db, root);
    assert.equal(cleared.cleared.length, 8);
    assert.equal(cleared.cleared.filter(ref => demoIds.has(ref.id)).length, 5);
    assert.equal(listDemo(db).items.length, 0);
    assert.ok(demoPaths.every(path => !existsSync(join(root, path))));
    assert.equal(db.prepare('SELECT count(*) AS n FROM demo_records').get().n, 0);

    assert.equal(JSON.stringify(getRepertoire(db, real.item.id)), realBefore);
    assert.ok(existsSync(real.path));
    assert.equal(db.prepare('SELECT count(*) AS n FROM repertoire_items').get().n, 1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('清除演示时，被真实曲目引用的导唱文件与来源仍保留', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p040-vocal-shared-'));
  const db = openDatabase(join(root, 'db.sqlite'));
  try {
    await importDemo(db, root);
    const demoId = db.prepare("SELECT item_id AS id FROM demo_records WHERE slot='vocal-city-v1'").get().id;
    const guideClipId = db.prepare('SELECT original_clip_id FROM repertoire_items WHERE id=?').get(demoId).original_clip_id;
    const guideSourceId = db.prepare('SELECT source_media_id FROM performance_clips WHERE id=?').get(guideClipId).source_media_id;
    const guideClipPath = db.prepare('SELECT internal_audio_path AS path FROM performance_clips WHERE id=?').get(guideClipId).path;
    const guideSourcePath = db.prepare('SELECT internal_path AS path FROM source_media WHERE id=?').get(guideSourceId).path;
    assert.ok(existsSync(join(root, guideClipPath)) && existsSync(join(root, guideSourcePath)));

    const real = saveRepertoire(db, null, { kind: 'VOCAL', title: '真实曲目引用导唱' });
    db.prepare('UPDATE repertoire_items SET source_media_id=?,original_clip_id=? WHERE id=?').run(guideSourceId, guideClipId, real.id);

    clearDemo(db, root);
    assert.ok(existsSync(join(root, guideClipPath)));
    assert.ok(existsSync(join(root, guideSourcePath)));
    assert.ok(getRepertoire(db, real.id));
    assert.equal(listDemo(db).items.length, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
