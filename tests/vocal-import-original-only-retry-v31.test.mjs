import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { openDatabase } from '../server/db/database.mjs';
import { getRepertoire, saveRepertoire } from '../server/repertoire/service.mjs';
import { createSourcePolicy } from '../server/vocal-import/source-policy.mjs';
import { openVocalImportQueue } from '../server/vocal-import/queue.mjs';
import { createRepertoireImporter } from '../server/vocal-import/importer.mjs';
import { createTestAccompanimentVerifier } from './helpers/test-accompaniment-verifier.mjs';
import { songIdForAudioSha } from '../server/vocal-import/uuid5.mjs';

const NO_PROBE = { probe: false, fingerprint: false, deep: false };
const LRC = '[ti:测试歌]\n[ar:测试歌手]\n[00:01.00]第一句\n[00:03.50]第二句\n';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'p040-original-only-retry-'));
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
  const importer = createRepertoireImporter({ db, mediaRoot, policy, verifyAccompaniment: createTestAccompanimentVerifier() });
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

function insertTrack(db, mediaRoot, { relPath, content, sourcePreserving = 1, durationMs = 120000 }) {
  const absolute = join(mediaRoot, relPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  const sha = sha256(content);
  const sizeBytes = statSync(absolute).size;
  const sourceId = randomUUID();
  db.prepare(
    'INSERT INTO source_media(id,source_kind,source_locator,internal_path,sha256,duration_ms,audio_codec,video_codec,container) VALUES(?,?,?,?,?,?,?,?,?)',
  ).run(sourceId, 'AUDIO', null, relPath, sha, durationMs, 'mp3', null, null);
  const clipId = randomUUID();
  db.prepare(
    'INSERT INTO performance_clips(id,source_media_id,start_ms,end_ms,internal_audio_path,codec,source_preserving,sha256,size_bytes,duration_ms,version) VALUES(?,?,?,?,?,?,?,?,?,?,1)',
  ).run(clipId, sourceId, 0, durationMs, relPath, 'mp3', sourcePreserving ? 1 : 0, sha, sizeBytes, durationMs);
  return { clipId, sourceId, relPath, sha, sizeBytes, absolute, content };
}

function makeExtractor(mediaRoot) {
  let calls = 0;
  const extractor = async ({ job, outputDir }) => {
    calls += 1;
    const target = join(outputDir, 'accompaniment.flac');
    mkdirSync(dirname(target), { recursive: true });
    const content = Buffer.from(`ai-accompaniment:${job.songId}`);
    writeFileSync(target, content);
    return {
      relPath: relative(mediaRoot, target).split(sep).join('/'),
      sha256: sha256(content),
      sizeBytes: statSync(target).size,
      durationMs: 120000,
      codec: 'flac',
    };
  };
  extractor.calls = () => calls;
  return extractor;
}

async function enqueueOne(queue, rootId = 'music') {
  const enqueued = await queue.enqueueScan({ rootId, scanOptions: NO_PROBE });
  assert.equal(enqueued.created.length, 1);
  return { jobId: enqueued.created[0], songId: enqueued.jobs[0].songId, enqueued };
}

function setDuration(db, jobId, durationMs = 120000) {
  db.prepare('UPDATE vocal_import_jobs SET source_duration_ms=? WHERE id=?').run(durationMs, jobId);
}

async function importOriginalOnlyFallback(queue, db) {
  const { jobId, songId } = await enqueueOne(queue);
  setDuration(db, jobId);
  const run = await queue.runOnce();
  assert.equal(run.reason, 'EXTRACTOR_NOT_CONFIGURED');
  await queue.importOriginalOnly(jobId);
  return { jobId, songId };
}

test('仅原唱兜底后：重试只补跑提取，并入同一 songId 并完成双轨', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, open } = makeEnv(dir);
    const sourcePath = put(music, 'Singer - Song.mp3', 'source-bytes');
    put(music, 'Singer - Song.lrc', LRC);
    const fallbackQueue = open({ extractor: null }).queue;
    try {
      const { jobId, songId } = await importOriginalOnlyFallback(fallbackQueue, db);
      assert.equal(songId, songIdForAudioSha(sha256('source-bytes')));

      let job = fallbackQueue.getJob(jobId);
      assert.equal(job.status, 'IMPORTED');
      assert.equal(job.importMode, 'ORIGINAL_ONLY');
      let item = getRepertoire(db, songId);
      const originalClipId = item.tracks.original.media.id;
      assert.equal(item.tracks.accompaniment, undefined);
      assert.deepEqual(item.lyrics.map(line => line.text), ['第一句', '第二句']);
      assert.equal(db.prepare("SELECT count(*) AS n FROM repertoire_items WHERE kind='VOCAL'").get().n, 1);

      const extractor = makeExtractor(mediaRoot);
      const queue = open({ extractor }).queue;
      const retried = queue.retry(jobId);
      assert.equal(retried.status, 'PENDING_EXTRACT');
      assert.equal(retried.stage, 'EXTRACT');
      assert.equal(retried.import_mode, 'ORIGINAL_ONLY');

      const done = await queue.runOnce();
      assert.equal(done.status, 'IMPORTED', '提取与入库应一次完成');
      assert.equal(extractor.calls(), 1);

      job = queue.getJob(jobId);
      assert.equal(job.status, 'IMPORTED');
      assert.equal(job.importMode, 'DUAL_TRACK');
      assert.ok(job.events.some(event => event.event === 'retried' && event.detail.importMode === 'ORIGINAL_ONLY'));

      item = getRepertoire(db, songId);
      assert.equal(item.tracks.original.media.id, originalClipId, '重试不得替换既有原唱轨');
      assert.ok(item.tracks.accompaniment?.media?.id);
      assert.deepEqual(item.lyrics.map(line => line.text), ['第一句', '第二句']);
      assert.equal(db.prepare("SELECT count(*) AS n FROM repertoire_items WHERE kind='VOCAL'").get().n, 1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, 2);
      assert.equal(readFileSync(sourcePath, 'utf8'), 'source-bytes');
      assert.equal((await queue.runOnce()).reason, 'EMPTY');

      // 双轨完成后恢复终态保护。
      assert.throws(() => queue.retry(jobId), { code: 'CONFLICT' });
    } finally {
      db.close();
    }
  });
});

test('补伴奏不覆盖用户歌词、结构与旧轨', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, open } = makeEnv(dir);
    put(music, 'Manual - Song.mp3', 'manual-source');
    put(music, 'Manual - Song.lrc', LRC);
    const fallbackQueue = open({ extractor: null }).queue;
    try {
      const { jobId, songId } = await importOriginalOnlyFallback(fallbackQueue, db);
      const before = getRepertoire(db, songId);
      const originalClipId = before.tracks.original.media.id;
      saveRepertoire(db, songId, {
        title: '人工改过的标题',
        lyrics: [{ id: 'line-1', startMs: 500, text: '人工第一句' }],
        sections: [{ id: 'sec-1', type: 'verse', label: '主歌', startMs: 0, endMs: 60000, source: 'manual' }],
      });

      const queue = open({ extractor: makeExtractor(mediaRoot) }).queue;
      queue.retry(jobId);
      assert.equal((await queue.runOnce()).status, 'IMPORTED');

      const item = getRepertoire(db, songId);
      assert.equal(item.title, '人工改过的标题');
      assert.equal(item.tracks.original.media.id, originalClipId);
      assert.ok(item.tracks.accompaniment?.media?.id);
      assert.deepEqual(item.lyrics.map(line => line.text), ['人工第一句']);
      assert.equal(item.sections.length, 1);
      assert.equal(item.sections[0].label, '主歌');
      assert.equal(item.sections[0].source, 'manual');
    } finally {
      db.close();
    }
  });
});

test('补伴奏遇到用户旧伴奏：先冲突不分离，保留旧伴奏后可收尾为双轨', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, open } = makeEnv(dir);
    put(music, 'Conflict - Song.mp3', 'conflict-source');
    put(music, 'Conflict - Song.lrc', LRC);
    const fallbackQueue = open({ extractor: null }).queue;
    try {
      const { jobId, songId } = await importOriginalOnlyFallback(fallbackQueue, db);
      const userAccompaniment = insertTrack(db, mediaRoot, {
        relPath: 'user/my-accompaniment.mp3',
        content: 'user-accompaniment',
      });
      db.prepare('UPDATE repertoire_items SET accompaniment_clip_id=?,performance_clip_id=COALESCE(performance_clip_id,?) WHERE id=?')
        .run(userAccompaniment.clipId, userAccompaniment.clipId, songId);

      const extractor = makeExtractor(mediaRoot);
      const queue = open({ extractor }).queue;
      queue.retry(jobId);
      const conflict = await queue.runOnce();
      assert.equal(conflict.status, 'NEEDS_REVIEW');
      assert.equal(conflict.reason, 'ACCOMPANIMENT_CONFLICT');
      assert.equal(extractor.calls(), 0, '已有旧伴奏时不得重新分离');

      let item = getRepertoire(db, songId);
      assert.equal(item.tracks.accompaniment.media.id, userAccompaniment.clipId);
      assert.equal(readFileSync(userAccompaniment.absolute, 'utf8'), 'user-accompaniment');
      assert.equal(queue.getJob(jobId).importMode, 'ORIGINAL_ONLY');

      const resolved = await queue.resolveImportConflict(jobId, { choice: 'keep-existing' });
      assert.equal(resolved.status, 'IMPORTED');
      assert.equal(queue.getJob(jobId).importMode, 'DUAL_TRACK');
      item = getRepertoire(db, songId);
      assert.equal(item.tracks.accompaniment.media.id, userAccompaniment.clipId);
      assert.equal(readFileSync(userAccompaniment.absolute, 'utf8'), 'user-accompaniment');
    } finally {
      db.close();
    }
  });
});

test('仅原唱兜底后取消仍生效，不得擅自提取', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, open } = makeEnv(dir);
    put(music, 'Cancel - Song.mp3', 'cancel-source');
    put(music, 'Cancel - Song.lrc', LRC);
    const fallbackQueue = open({ extractor: null }).queue;
    try {
      const { jobId } = await importOriginalOnlyFallback(fallbackQueue, db);
      const extractor = makeExtractor(mediaRoot);
      const queue = open({ extractor }).queue;
      assert.equal(queue.retry(jobId).status, 'PENDING_EXTRACT');
      assert.equal(queue.cancel(jobId).status, 'CANCELLED');
      assert.equal((await queue.runOnce()).reason, 'EMPTY');
      assert.equal(extractor.calls(), 0);
      assert.equal(queue.getJob(jobId).status, 'CANCELLED');
    } finally {
      db.close();
    }
  });
});

test('补伴奏失败仍保留仅原唱状态，可再次重试直到双轨', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, open } = makeEnv(dir);
    put(music, 'Retry - Song.mp3', 'retry-source');
    put(music, 'Retry - Song.lrc', LRC);
    const fallbackQueue = open({ extractor: null }).queue;
    try {
      const { jobId, songId } = await importOriginalOnlyFallback(fallbackQueue, db);
      let failingCalls = 0;
      db.prepare('UPDATE vocal_import_jobs SET max_attempts=1 WHERE id=?').run(jobId);
      const failingQueue = open({
        maxAttempts: 1,
        extractor: async () => {
          failingCalls += 1;
          throw Object.assign(new Error('分离器崩溃'), { code: 'SEPARATOR_FAILED' });
        },
      }).queue;
      failingQueue.retry(jobId);
      assert.equal((await failingQueue.runOnce()).reason, 'SEPARATOR_FAILED');
      assert.equal(failingCalls, 1);

      let job = failingQueue.getJob(jobId);
      assert.equal(job.status, 'FAILED');
      assert.equal(job.importMode, 'ORIGINAL_ONLY');
      let item = getRepertoire(db, songId);
      assert.ok(item.tracks.original?.media?.id);
      assert.equal(item.tracks.accompaniment, undefined);

      const queue = open({ extractor: makeExtractor(mediaRoot) }).queue;
      assert.equal(queue.retry(jobId).status, 'PENDING_EXTRACT');
      assert.equal((await queue.runOnce()).status, 'IMPORTED');
      job = queue.getJob(jobId);
      assert.equal(job.importMode, 'DUAL_TRACK');
      item = getRepertoire(db, songId);
      assert.ok(item.tracks.original?.media?.id);
      assert.ok(item.tracks.accompaniment?.media?.id);
      assert.equal(db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, 2);
    } finally {
      db.close();
    }
  });
});

test('重复扫描不篡改已完成双轨，也不把仅原唱改成双轨', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, open } = makeEnv(dir);
    put(music, 'Scan - Original.mp3', 'scan-original-source');
    put(music, 'Scan - Original.lrc', LRC);
    put(music, 'Scan - Dual.mp3', 'scan-dual-source');
    put(music, 'Scan - Dual.lrc', LRC);
    const fallbackQueue = open({ extractor: null }).queue;
    try {
      const enqueued = await fallbackQueue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      assert.equal(enqueued.created.length, 2);
      const originalJobId = enqueued.jobs.find(job => job.original.relPath.includes('Original')).id;
      const dualJobId = enqueued.jobs.find(job => job.original.relPath.includes('Dual')).id;
      const dualSongId = enqueued.jobs.find(job => job.original.relPath.includes('Dual')).songId;
      setDuration(db, originalJobId);
      setDuration(db, dualJobId);

      await fallbackQueue.importOriginalOnly(originalJobId);

      const queue = open({ extractor: makeExtractor(mediaRoot) }).queue;
      assert.equal((await queue.runOnce()).status, 'IMPORTED');
      const dualBefore = getRepertoire(db, dualSongId);
      const originalBefore = getRepertoire(db, enqueued.jobs.find(job => job.original.relPath.includes('Original')).songId);

      const rescanned = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      assert.equal(rescanned.created.length, 0);
      assert.equal(rescanned.reused.length, 2);

      const originalJob = queue.getJob(originalJobId);
      assert.equal(originalJob.status, 'IMPORTED');
      assert.equal(originalJob.importMode, 'ORIGINAL_ONLY');
      assert.equal(queue.getJob(dualJobId).importMode, 'DUAL_TRACK');

      const originalAfter = getRepertoire(db, originalBefore.id);
      assert.equal(originalAfter.tracks.accompaniment, undefined);
      assert.deepEqual(originalAfter.tracks.original.media.id, originalBefore.tracks.original.media.id);

      const dualAfter = getRepertoire(db, dualSongId);
      assert.equal(dualAfter.tracks.original.media.id, dualBefore.tracks.original.media.id);
      assert.equal(dualAfter.tracks.accompaniment.media.id, dualBefore.tracks.accompaniment.media.id);
      assert.deepEqual(dualAfter.lyrics, dualBefore.lyrics);
    } finally {
      db.close();
    }
  });
});
