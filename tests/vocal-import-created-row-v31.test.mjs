import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { openDatabase } from '../server/db/database.mjs';
import { getRepertoire } from '../server/repertoire/service.mjs';
import { createSourcePolicy } from '../server/vocal-import/source-policy.mjs';
import { openVocalImportQueue } from '../server/vocal-import/queue.mjs';
import { createRepertoireImporter } from '../server/vocal-import/importer.mjs';
import { createTestAccompanimentVerifier } from './helpers/test-accompaniment-verifier.mjs';

/**
 * 回归靶点：`performImport` 里“新建曲目”的
 * `INSERT INTO repertoire_items(...16 列...) VALUES(...)`。
 *
 * 该语句一旦少一个占位符（曾出现 15 个值对 16 列），`.run()` 会在事务里抛
 * `ERR_SQLITE_ERROR: 15 values for 16 columns`，真实链路接口直接 500。
 * 这里用真实 sqlite + 真实文件走一遍新建分支，断言列值落位与 JSON 字段，
 * 任何占位符错位都会在断言之前先炸在 SQL 上。
 */

const NO_PROBE = { probe: false, fingerprint: false, deep: false };
const LRC = '[ti:测试歌]\n[ar:测试歌手]\n[00:01.00]第一句\n[00:03.50]第二句\n';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'p040-created-row-'));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function put(dir, name, content) {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function makeEnv(dir) {
  const db = openDatabase(join(dir, 'db.sqlite'));
  const mediaRoot = join(dir, 'media');
  const music = join(dir, 'music');
  mkdirSync(mediaRoot, { recursive: true });
  mkdirSync(music, { recursive: true });
  const policy = createSourcePolicy({ roots: [{ id: 'music', label: '临时音乐', path: music }] });
  const importer = createRepertoireImporter({
    db,
    mediaRoot,
    policy,
    verifyAccompaniment: createTestAccompanimentVerifier(),
  });
  const open = (options = {}) =>
    openVocalImportQueue({
      db,
      policy,
      mediaRoot,
      importer,
      verifyAccompaniment: createTestAccompanimentVerifier(),
      logger: null,
      ...options,
    });
  return { db, mediaRoot, music, policy, importer, open };
}

/** 与队列 `toPublicJob(row)` 同形的最小 job：真实入库只依赖这些字段。 */
function jobFor({ songId, sourcePath, lyricsName = null, title = '测试歌', artist = '测试歌手' }) {
  const bytes = readFileSync(sourcePath);
  return {
    id: `job-${songId.slice(0, 8)}`,
    songId,
    rootId: 'music',
    title,
    artist,
    language: 'zh',
    original: {
      relPath: basename(sourcePath),
      sha256: sha256(bytes),
      sizeBytes: bytes.length,
      durationMs: 120000,
    },
    lyrics: lyricsName ? { relPath: lyricsName, sha256: null, timedLines: 2 } : null,
    suppliedAccompaniment: null,
  };
}

function artifactFor(mediaRoot, songId, content, name = 'accompaniment.flac') {
  const absolute = join(mediaRoot, 'vocal-import', songId, name);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  return {
    relPath: relative(mediaRoot, absolute).split(sep).join('/'),
    sha256: sha256(content),
    sizeBytes: statSync(absolute).size,
    durationMs: 120000,
    codec: 'flac',
  };
}

function repertoireRow(db, id) {
  const row = db.prepare('SELECT * FROM repertoire_items WHERE id=?').get(id);
  assert.ok(row, `repertoire_items 里应有 ${id}`);
  return row;
}

/** 新建行的公共断言：列值落位 + 三个 JSON 字段合法。 */
function assertCreatedRowShape(row, { title = '测试歌', artist = '测试歌手', language = 'zh', expectsAccompaniment = false } = {}) {
  assert.equal(row.kind, 'VOCAL');
  // 参数顺序错位时最先崩在这里：值被挪到相邻列。
  assert.equal(row.title, title);
  assert.equal(row.artist, artist);
  assert.equal(row.learning_status, 'WANT_TO_LEARN');
  assert.equal(row.audio_role, expectsAccompaniment ? 'ACCOMPANIMENT' : 'REFERENCE');
  assert.equal(row.vocal_language, language);
  assert.equal(row.original_offset_ms, 0);
  assert.equal(row.accompaniment_offset_ms, 0);
  assert.ok(row.source_media_id, 'source_media_id 必须落位');
  assert.ok(row.original_clip_id, 'original_clip_id 必须落位');
  if (expectsAccompaniment) {
    assert.ok(row.accompaniment_clip_id, '伴奏轨指针必须落位');
    assert.equal(row.performance_clip_id, row.accompaniment_clip_id);
  } else {
    assert.equal(row.accompaniment_clip_id, null);
    assert.equal(row.performance_clip_id, null);
  }
  // practice_json 是常量 '{}'，不是占位符，不能被别的值挤掉。
  assert.equal(row.practice_json, '{}');
  assert.doesNotThrow(() => JSON.parse(row.lyrics_json), 'lyrics_json 必须是合法 JSON');
  assert.doesNotThrow(() => JSON.parse(row.sections_json), 'sections_json 必须是合法 JSON');
  assert.ok(Array.isArray(JSON.parse(row.lyrics_json)));
  assert.ok(Array.isArray(JSON.parse(row.sections_json)));
}

test('新建曲目：原唱兜底入库走 INSERT 分支，返回 CREATED_ORIGINAL_ONLY 且各列落位', async () => {
  await withTempDir(async dir => {
    const { db, music, open } = makeEnv(dir);
    put(music, 'Singer - Song.mp3', 'created-row-source');
    put(music, 'Singer - Song.lrc', LRC);
    const { queue } = open({ extractor: null });
    try {
      const enqueued = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      assert.equal(enqueued.created.length, 1);
      const jobId = enqueued.created[0];
      const job = enqueued.jobs[0];
      const songId = job.songId;
      // NO_PROBE 不探测时长，入库要求可核验时长，这里补一条与假音频一致的记录。
      db.prepare('UPDATE vocal_import_jobs SET source_duration_ms=? WHERE id=?').run(120000, jobId);

      const imported = await queue.importOriginalOnly(jobId);
      assert.equal(imported.status, 'IMPORTED');
      assert.equal(imported.import_mode, 'ORIGINAL_ONLY');

      // 入库器真实返回值藏在事件 detail 里：CREATE 分支必须是 CREATED_ORIGINAL_ONLY。
      const event = queue.getJob(jobId).events.find(item => item.event === 'imported');
      assert.equal(event.detail.status, 'CREATED_ORIGINAL_ONLY');

      // 只多一行 VOCAL，且就是这首歌。
      assert.equal(db.prepare("SELECT count(*) AS n FROM repertoire_items WHERE kind='VOCAL'").get().n, 1);
      const row = repertoireRow(db, songId);
      assertCreatedRowShape(row, {
        title: job.title,
        artist: job.artist,
        language: job.language,
        expectsAccompaniment: false,
      });

      // 歌词按 LRC 落进对应 JSON 列，不是被挤到相邻列。
      assert.deepEqual(JSON.parse(row.lyrics_json).map(line => line.text), ['第一句', '第二句']);
      // V3.2 起导入不猜结构：没有原唱音频分析就不写 sections_json，界面显示「待分析」。
      assert.deepEqual(JSON.parse(row.sections_json), [], '导入期不得用歌词重复推断主副歌');

      const item = getRepertoire(db, songId);
      assert.ok(item.tracks.original?.media?.id);
      assert.equal(item.tracks.accompaniment, undefined);
      assert.deepEqual(item.lyrics.map(line => line.text), ['第一句', '第二句']);
    } finally {
      db.close();
    }
  });
});

test('新建曲目：双轨入库同一条 INSERT，返回 CREATED 且伴奏指针落位', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, importer } = makeEnv(dir);
    try {
      const sourcePath = put(music, 'Dual - Song.mp3', 'dual-row-source');
      put(music, 'Dual - Song.lrc', LRC);
      const songId = '66666666-6666-5666-8666-666666666666';

      const created = await importer({
        job: jobFor({ songId, sourcePath, lyricsName: 'Dual - Song.lrc' }),
        artifact: artifactFor(mediaRoot, songId, 'ai-accompaniment-bytes'),
      });
      assert.equal(created.status, 'CREATED');

      assert.equal(db.prepare("SELECT count(*) AS n FROM repertoire_items WHERE kind='VOCAL'").get().n, 1);
      const row = repertoireRow(db, songId);
      assertCreatedRowShape(row, { expectsAccompaniment: true });
      assert.deepEqual(JSON.parse(row.lyrics_json).map(line => line.text), ['第一句', '第二句']);

      const item = getRepertoire(db, songId);
      assert.ok(item.tracks.original?.media?.id);
      assert.equal(item.tracks.accompaniment?.media?.id, row.accompaniment_clip_id);
      assert.equal(db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, 2);
    } finally {
      db.close();
    }
  });
});

test('同曲二次入库：并入既有曲目返回 MERGED_ORIGINAL_ONLY，不新增行', async () => {
  await withTempDir(async dir => {
    const { db, music, importer } = makeEnv(dir);
    try {
      const sourcePath = put(music, 'Merge - Song.mp3', 'merge-row-source');
      put(music, 'Merge - Song.lrc', LRC);
      const songId = '77777777-7777-5777-8777-777777777777';

      // 第一次：只有原唱、还没选歌词 → 走新建分支。
      const first = await importer.importOriginalOnly({ job: jobFor({ songId, sourcePath }) });
      assert.equal(first.status, 'CREATED_ORIGINAL_ONLY');
      const beforeRow = repertoireRow(db, songId);
      assertCreatedRowShape(beforeRow, { expectsAccompaniment: false });
      assert.deepEqual(JSON.parse(beforeRow.lyrics_json), []);

      // 第二次：同曲补歌词 → 必须并入同一行，不插新行。
      const second = await importer.importOriginalOnly({
        job: jobFor({ songId, sourcePath, lyricsName: 'Merge - Song.lrc' }),
      });
      assert.equal(second.status, 'MERGED_ORIGINAL_ONLY');
      assert.equal(second.repertoireId, songId);
      assert.equal(second.lyricsFilled, true);

      assert.equal(db.prepare("SELECT count(*) AS n FROM repertoire_items WHERE kind='VOCAL'").get().n, 1);
      const afterRow = repertoireRow(db, songId);
      assert.equal(afterRow.id, songId);
      assert.equal(afterRow.original_clip_id, beforeRow.original_clip_id, '二次入库不得替换既有原唱轨');
      assert.equal(afterRow.source_media_id, beforeRow.source_media_id);
      assert.equal(afterRow.practice_json, '{}');
      assert.deepEqual(JSON.parse(afterRow.lyrics_json).map(line => line.text), ['第一句', '第二句']);
      // UPDATE 分支不新增音轨。
      assert.equal(db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, 1);
    } finally {
      db.close();
    }
  });
});
