import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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
  const dir = mkdtempSync(join(tmpdir(), 'p040-v31-fixes-'));
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

function seedItem(db, { id, title = '旧曲', audioRole = 'REFERENCE', performance = null, original = null, accompaniment = null }) {
  saveRepertoire(db, null, { clientId: id, kind: 'VOCAL', title, language: 'zh' });
  db.prepare(
    'UPDATE repertoire_items SET audio_role=?,performance_clip_id=?,original_clip_id=?,accompaniment_clip_id=?,source_media_id=? WHERE id=?',
  ).run(
    audioRole,
    performance?.clipId ?? null,
    original?.clipId ?? null,
    accompaniment?.clipId ?? null,
    (original ?? accompaniment ?? performance)?.sourceId ?? null,
    id,
  );
}

async function enqueueOne(queue, rootId = 'music') {
  const enqueued = await queue.enqueueScan({ rootId, scanOptions: NO_PROBE });
  assert.equal(enqueued.created.length, 1);
  return { jobId: enqueued.created[0], songId: enqueued.jobs[0].songId, enqueued };
}

function setDuration(db, jobId, durationMs = 120000) {
  db.prepare('UPDATE vocal_import_jobs SET source_duration_ms=? WHERE id=?').run(durationMs, jobId);
}

test('1a 已有伴奏 READY_TO_IMPORT：先校验工件，再走同一入库路径', async () => {
  await withTempDir(async dir => {
    const { db, music, open } = makeEnv(dir);
    const sourcePath = put(music, 'Singer - Song.mp3', 'source-bytes');
    put(music, 'Singer - Song.lrc', LRC);
    const suppliedPath = put(music, 'Singer - Song (伴奏).mp3', 'supplied-accompaniment');
    let extractionCalls = 0;
    const queue = open({
      extractor: async () => {
        extractionCalls += 1;
        throw new Error('自带伴奏时不得调用分离器');
      },
    }).queue;
    try {
      const { jobId, songId } = await enqueueOne(queue);
      assert.equal(queue.getJob(jobId).status, 'READY_TO_IMPORT');
      setDuration(db, jobId);
      const result = await queue.runOnce();
      assert.equal(result.status, 'IMPORTED');
      assert.equal(extractionCalls, 0);
      const job = queue.getJob(jobId);
      assert.equal(job.status, 'IMPORTED');
      assert.equal(job.artifacts.accompaniment.sha256, sha256(readFileSync(suppliedPath)));
      const item = getRepertoire(db, songId);
      assert.ok(item.tracks.original?.media?.id);
      assert.ok(item.tracks.accompaniment?.media?.id);
      assert.equal(item.tracks.accompaniment.media.sha256, sha256(readFileSync(suppliedPath)));
      assert.deepEqual(item.lyrics.map(line => line.text), ['第一句', '第二句']);
      assert.equal(readFileSync(sourcePath, 'utf8'), 'source-bytes');
      assert.equal(readFileSync(suppliedPath, 'utf8'), 'supplied-accompaniment');
      assert.equal((await queue.runOnce()).reason, 'EMPTY');
    } finally {
      db.close();
    }
  });
});

test('1b 已有伴奏但未注入 importer：可校验并停在待入库，不反复处理', async () => {
  await withTempDir(async dir => {
    const { db, music, open } = makeEnv(dir);
    put(music, 'Singer - Song.mp3', 'source-bytes');
    put(music, 'Singer - Song.lrc', LRC);
    put(music, 'Singer - Song (伴奏).mp3', 'supplied-accompaniment');
    const queue = open({ importer: null, extractor: null }).queue;
    try {
      const { jobId } = await enqueueOne(queue);
      setDuration(db, jobId);
      const result = await queue.runOnce();
      assert.equal(result.status, 'READY_TO_IMPORT');
      const job = queue.getJob(jobId);
      assert.equal(job.stage, 'IMPORT');
      assert.ok(job.artifacts.accompaniment.relPath);
      assert.equal(db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, 0);
      assert.equal((await queue.runOnce()).reason, 'EMPTY');
    } finally {
      db.close();
    }
  });
});

test('2 分离未配置/失败时：原唱 + LRC 可显式先入库，且不伪造伴奏', async () => {
  await withTempDir(async dir => {
    const { db, music, open } = makeEnv(dir);
    const sourcePath = put(music, 'Singer - Song.mp3', 'source-bytes');
    put(music, 'Singer - Song.lrc', LRC);
    const queue = open({ extractor: null }).queue;
    try {
      const { jobId, songId } = await enqueueOne(queue);
      setDuration(db, jobId);
      const run = await queue.runOnce();
      assert.equal(run.reason, 'EXTRACTOR_NOT_CONFIGURED');
      assert.equal(queue.getJob(jobId).status, 'PENDING_EXTRACT');
      assert.equal(db.prepare("SELECT count(*) AS n FROM repertoire_items WHERE kind='VOCAL'").get().n, 0);

      const imported = await queue.importOriginalOnly(jobId);
      assert.equal(imported.status, 'IMPORTED');
      const job = queue.getJob(jobId);
      assert.ok(job.events.some(event => event.event === 'imported' && event.detail.originalOnly === true));
      const item = getRepertoire(db, songId);
      assert.ok(item.tracks.original?.media?.id);
      assert.equal(item.tracks.accompaniment, undefined);
      assert.deepEqual(item.lyrics.map(line => line.text), ['第一句', '第二句']);
      assert.equal(readFileSync(sourcePath, 'utf8'), 'source-bytes');
      assert.equal(db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, 1);
      // 仅原唱兜底入库后仍可重试补伴奏，重试回到待提取并保留同一任务。
      assert.equal(queue.getJob(jobId).importMode, 'ORIGINAL_ONLY');
      assert.equal(queue.retry(jobId).status, 'PENDING_EXTRACT');
    } finally {
      db.close();
    }
  });

  await withTempDir(async dir => {
    const { db, music, open } = makeEnv(dir);
    const sourcePath = put(music, 'Fail - Song.mp3', 'fail-source');
    put(music, 'Fail - Song.lrc', LRC);
    const queue = open({
      maxAttempts: 1,
      extractor: async () => {
        throw Object.assign(new Error('分离器崩溃'), { code: 'SEPARATOR_FAILED' });
      },
    }).queue;
    try {
      const { jobId, songId } = await enqueueOne(queue);
      setDuration(db, jobId);
      const run = await queue.runOnce();
      assert.equal(run.reason, 'SEPARATOR_FAILED');
      assert.equal(queue.getJob(jobId).status, 'FAILED');
      await queue.importOriginalOnly(jobId);
      const item = getRepertoire(db, songId);
      assert.ok(item.tracks.original?.media?.id);
      assert.equal(item.tracks.accompaniment, undefined);
      assert.equal(readFileSync(sourcePath, 'utf8'), 'fail-source');
    } finally {
      db.close();
    }
  });
});

test('3 运行中恢复过期的 EXTRACTING 租约；取消请求优先于重新提取', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, open } = makeEnv(dir);
    put(music, 'Recover - Song.mp3', 'recover-source');
    let extractionCalls = 0;
    const queue = open({
      importer: null,
      extractor: async ({ job, outputDir }) => {
        extractionCalls += 1;
        const target = join(outputDir, 'accompaniment.flac');
        const content = Buffer.from(`fake:${job.songId}`);
        writeFileSync(target, content);
        return {
          relPath: relative(mediaRoot, target).split(sep).join('/'),
          sha256: sha256(content),
          sizeBytes: statSync(target).size,
          durationMs: 120000,
        };
      },
    }).queue;
    try {
      const { jobId } = await enqueueOne(queue);
      setDuration(db, jobId);
      db.prepare(
        "UPDATE vocal_import_jobs SET status='EXTRACTING',stage='EXTRACT',lease_owner='dead-worker',lease_expires_at=1,attempts=0 WHERE id=?",
      ).run(jobId);
      const result = await queue.runOnce();
      assert.equal(result.status, 'READY_TO_IMPORT');
      assert.equal(extractionCalls, 1);
      const job = queue.getJob(jobId);
      assert.equal(job.status, 'READY_TO_IMPORT');
      assert.ok(job.events.some(event => event.event === 'recovered' && event.detail.reason === 'expired-lease-runtime'));
    } finally {
      db.close();
    }
  });

  await withTempDir(async dir => {
    const { db, music, open } = makeEnv(dir);
    put(music, 'Cancel - Expired.mp3', 'cancel-expired');
    let extractionCalls = 0;
    const queue = open({
      extractor: async () => {
        extractionCalls += 1;
        throw new Error('不应提取');
      },
    }).queue;
    try {
      const { jobId } = await enqueueOne(queue);
      db.prepare(
        "UPDATE vocal_import_jobs SET status='EXTRACTING',stage='EXTRACT',lease_owner='dead-worker',lease_expires_at=1,cancel_requested=1 WHERE id=?",
      ).run(jobId);
      const result = await queue.runOnce();
      // 取消请求优先于恢复提取：任务被直接置为 CANCELLED，本轮不再有可处理任务。
      assert.equal(result.reason, 'EMPTY');
      assert.equal(extractionCalls, 0);
      assert.equal(queue.getJob(jobId).status, 'CANCELLED');
    } finally {
      db.close();
    }
  });
});

test('4 人工核对 + 改名：重扫保留人工选择，并跟随源文件改名', async () => {
  await withTempDir(async dir => {
    const { db, music, open } = makeEnv(dir);
    const oldPath = put(music, 'Singer - Song.mp3', 'rename-source');
    put(music, 'Singer - Song.lrc', '[00:01.00]候选一\n');
    put(music, 'Singer - Song (1).lrc', '[00:02.00]候选二\n');
    put(music, '手动选的歌词.lrc', LRC);
    const queue = open({ extractor: null }).queue;
    try {
      const { jobId } = await enqueueOne(queue);
      assert.equal(queue.getJob(jobId).status, 'NEEDS_REVIEW');
      const resolved = queue.resolve(jobId, {
        lyricsRelPath: '手动选的歌词.lrc',
        title: '人工改名',
        artist: '人工歌手',
      });
      assert.equal(resolved.status, 'PENDING_EXTRACT');
      assert.equal(queue.getJob(jobId).title, '人工改名');

      const renamedPath = join(music, 'Singer - Song 改名.mp3');
      renameSync(oldPath, renamedPath);
      assert.equal(existsSync(oldPath), false);

      const rescanned = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      assert.equal(rescanned.created.length, 0);
      const job = queue.getJob(jobId);
      assert.equal(job.original.relPath, 'Singer - Song 改名.mp3');
      assert.equal(job.title, '人工改名');
      assert.equal(job.artist, '人工歌手');
      assert.equal(job.lyrics.relPath, '手动选的歌词.lrc');
      assert.equal(job.status, 'PENDING_EXTRACT');
      assert.deepEqual(job.manualReview, { lyrics: true, title: true, artist: true });
    } finally {
      db.close();
    }
  });
});

test('5a IMPORT 冲突：明确选择保留旧伴奏，旧轨与旧文件不变', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, open } = makeEnv(dir);
    const sourcePath = put(music, 'Singer - Song.mp3', 'conflict-source');
    put(music, 'Singer - Song.lrc', LRC);
    put(music, 'Singer - Song (伴奏).mp3', 'supplied-new-accompaniment');
    const sourceSha = sha256(readFileSync(sourcePath));
    const songId = songIdForAudioSha(sourceSha);
    const oldAccompaniment = insertTrack(db, mediaRoot, { relPath: 'user/old-accompaniment.mp3', content: 'old-accompaniment' });
    const oldOriginal = insertTrack(db, mediaRoot, { relPath: 'user/old-original.mp3', content: 'old-original' });
    seedItem(db, {
      id: songId,
      title: '旧曲',
      audioRole: 'ACCOMPANIMENT',
      original: oldOriginal,
      accompaniment: oldAccompaniment,
    });
    let extractionCalls = 0;
    const queue = open({
      extractor: async () => {
        extractionCalls += 1;
        throw new Error('已有伴奏时不应提取');
      },
    }).queue;
    try {
      const { jobId } = await enqueueOne(queue);
      setDuration(db, jobId);
      const run = await queue.runOnce();
      assert.equal(run.status, 'NEEDS_REVIEW');
      assert.equal(extractionCalls, 0);
      const job = queue.getJob(jobId);
      assert.equal(job.conflict.code, 'ACCOMPANIMENT_CONFLICT');
      assert.deepEqual(job.conflict.options, ['keep-existing', 'use-new']);
      assert.equal(job.conflict.existingAccompanimentClipId, oldAccompaniment.clipId);
      assert.ok(job.conflict.incomingAccompanimentRelPath);
      assert.equal(getRepertoire(db, songId).tracks.accompaniment.media.id, oldAccompaniment.clipId);

      const resolved = await queue.resolveImportConflict(jobId, { choice: 'keep-existing' });
      assert.equal(resolved.status, 'IMPORTED');
      const item = getRepertoire(db, songId);
      assert.equal(item.tracks.accompaniment.media.id, oldAccompaniment.clipId);
      assert.equal(item.tracks.original.media.id, oldOriginal.clipId);
      assert.deepEqual(item.lyrics.map(line => line.text), ['第一句', '第二句']);
      assert.equal(readFileSync(oldAccompaniment.absolute, 'utf8'), 'old-accompaniment');
      assert.equal(readFileSync(oldOriginal.absolute, 'utf8'), 'old-original');
      assert.equal(queue.getJob(jobId).conflict.code, undefined);
    } finally {
      db.close();
    }
  });
});

test('5b IMPORT 冲突：明确选择新伴奏，旧音轨只解绑不删除', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, open } = makeEnv(dir);
    put(music, 'Singer - Song.mp3', 'conflict-source');
    put(music, 'Singer - Song.lrc', LRC);
    const sourceSha = sha256(readFileSync(join(music, 'Singer - Song.mp3')));
    const songId = songIdForAudioSha(sourceSha);
    const oldAccompaniment = insertTrack(db, mediaRoot, { relPath: 'user/old-accompaniment.mp3', content: 'old-accompaniment' });
    const oldOriginal = insertTrack(db, mediaRoot, { relPath: 'user/old-original.mp3', content: 'old-original' });
    seedItem(db, {
      id: songId,
      title: '旧曲',
      audioRole: 'ACCOMPANIMENT',
      original: oldOriginal,
      accompaniment: oldAccompaniment,
    });
    let extractionCalls = 0;
    const queue = open({
      extractor: async ({ job, outputDir }) => {
        extractionCalls += 1;
        const target = join(outputDir, 'accompaniment.flac');
        const content = Buffer.from(`new-ai:${job.songId}`);
        writeFileSync(target, content);
        return {
          relPath: relative(mediaRoot, target).split(sep).join('/'),
          sha256: sha256(content),
          sizeBytes: statSync(target).size,
          durationMs: 120000,
        };
      },
    }).queue;
    try {
      const { jobId } = await enqueueOne(queue);
      setDuration(db, jobId);
      const run = await queue.runOnce();
      assert.equal(run.status, 'NEEDS_REVIEW');
      assert.equal(extractionCalls, 0, '预检冲突时仍不得擅自提取');
      assert.equal(queue.getJob(jobId).artifacts.accompaniment, undefined);

      const resolved = await queue.resolveImportConflict(jobId, { choice: 'use-new' });
      assert.equal(resolved.status, 'IMPORTED');
      assert.equal(extractionCalls, 1);
      const item = getRepertoire(db, songId);
      assert.notEqual(item.tracks.accompaniment.media.id, oldAccompaniment.clipId);
      assert.equal(item.tracks.accompaniment.media.sha256, sha256(`new-ai:${songId}`));
      assert.ok(db.prepare('SELECT 1 FROM performance_clips WHERE id=?').get(oldAccompaniment.clipId));
      assert.equal(readFileSync(oldAccompaniment.absolute, 'utf8'), 'old-accompaniment');
      assert.equal(item.tracks.original.media.id, oldOriginal.clipId);
    } finally {
      db.close();
    }
  });
});

test('6 已完成任务不重新提取：retry/重扫/worker 都不再调用分离器', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, open } = makeEnv(dir);
    put(music, 'Done - Song.mp3', 'done-source');
    put(music, 'Done - Song.lrc', LRC);
    let extractionCalls = 0;
    const queue = open({
      extractor: async ({ job, outputDir }) => {
        extractionCalls += 1;
        const target = join(outputDir, 'accompaniment.flac');
        const content = Buffer.from(`done:${job.songId}`);
        writeFileSync(target, content);
        return {
          relPath: relative(mediaRoot, target).split(sep).join('/'),
          sha256: sha256(content),
          sizeBytes: statSync(target).size,
          durationMs: 120000,
        };
      },
    }).queue;
    try {
      const { jobId } = await enqueueOne(queue);
      setDuration(db, jobId);
      const run = await queue.runOnce();
      assert.equal(run.status, 'IMPORTED');
      assert.equal(extractionCalls, 1);
      assert.throws(() => queue.retry(jobId), { code: 'CONFLICT' });
      assert.equal((await queue.runOnce()).reason, 'EMPTY');
      const rescanned = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      assert.equal(rescanned.created.length, 0);
      assert.equal(queue.getJob(jobId).status, 'IMPORTED');
      assert.equal(extractionCalls, 1);
    } finally {
      db.close();
    }
  });
});

test('7 恢复/取消/幂等：已提取工件不丢，补跑入库不重新提取，重复入库不复制', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, policy, importer, open } = makeEnv(dir);
    const sourcePath = put(music, 'Resume - Song.mp3', 'resume-source');
    put(music, 'Resume - Song.lrc', LRC);
    const sourceBytes = readFileSync(sourcePath);
    let extractionCalls = 0;
    const extractor = async ({ job, outputDir }) => {
      extractionCalls += 1;
      const target = join(outputDir, 'accompaniment.flac');
      const content = Buffer.from(`resume:${job.songId}`);
      writeFileSync(target, content);
      return {
        relPath: relative(mediaRoot, target).split(sep).join('/'),
        sha256: sha256(content),
        sizeBytes: statSync(target).size,
        durationMs: 120000,
      };
    };
    try {
      const noImporter = open({ extractor, importer: null }).queue;
      const { jobId, songId } = await enqueueOne(noImporter);
      setDuration(db, jobId);
      const first = await noImporter.runOnce();
      assert.equal(first.status, 'READY_TO_IMPORT');
      assert.equal(extractionCalls, 1);
      const artifact = noImporter.getJob(jobId).artifacts.accompaniment;
      assert.ok(existsSync(join(mediaRoot, artifact.relPath)));
      assert.equal(db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, 0);

      const resumed = openVocalImportQueue({
        db,
        policy,
        mediaRoot,
        extractor: async () => {
          throw new Error('恢复入库不应重新提取');
        },
        importer,
        verifyAccompaniment: createTestAccompanimentVerifier(),
        logger: null,
      });
      const result = await resumed.queue.runOnce();
      assert.equal(result.status, 'IMPORTED');
      assert.equal(extractionCalls, 1);
      const item = getRepertoire(db, songId);
      assert.ok(item.tracks.original?.media?.id);
      assert.ok(item.tracks.accompaniment?.media?.id);
      assert.deepEqual(item.lyrics.map(line => line.text), ['第一句', '第二句']);
      assert.deepEqual(readFileSync(sourcePath), sourceBytes);

      const counts = {
        items: db.prepare('SELECT count(*) AS n FROM repertoire_items').get().n,
        sources: db.prepare('SELECT count(*) AS n FROM source_media').get().n,
        clips: db.prepare('SELECT count(*) AS n FROM performance_clips').get().n,
      };
      const again = await importer({
        job: resumed.queue.getJob(jobId),
        artifact: resumed.queue.getJob(jobId).artifacts.accompaniment,
      });
      assert.equal(again.status, 'UNCHANGED');
      assert.deepEqual(
        {
          items: db.prepare('SELECT count(*) AS n FROM repertoire_items').get().n,
          sources: db.prepare('SELECT count(*) AS n FROM source_media').get().n,
          clips: db.prepare('SELECT count(*) AS n FROM performance_clips').get().n,
        },
        counts,
      );
      assert.deepEqual(readFileSync(sourcePath), sourceBytes);
    } finally {
      db.close();
    }
  });
});

test('5c IMPORT 冲突：尚无新伴奏工件时也能明确保留旧伴奏并补原唱/歌词', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, open } = makeEnv(dir);
    const sourcePath = put(music, 'Singer - Song.mp3', 'keep-old-source');
    put(music, 'Singer - Song.lrc', LRC);
    const sourceSha = sha256(readFileSync(sourcePath));
    const songId = songIdForAudioSha(sourceSha);
    const oldAccompaniment = insertTrack(db, mediaRoot, { relPath: 'user/old-accompaniment.mp3', content: 'old-accompaniment' });
    const oldOriginal = insertTrack(db, mediaRoot, { relPath: 'user/old-original.mp3', content: 'old-original' });
    seedItem(db, {
      id: songId,
      title: '旧曲',
      audioRole: 'ACCOMPANIMENT',
      original: oldOriginal,
      accompaniment: oldAccompaniment,
    });
    let extractionCalls = 0;
    const queue = open({
      extractor: async () => {
        extractionCalls += 1;
        throw new Error('保留旧伴奏时不得提取');
      },
    }).queue;
    try {
      const { jobId } = await enqueueOne(queue);
      setDuration(db, jobId);
      const run = await queue.runOnce();
      assert.equal(run.status, 'NEEDS_REVIEW');
      assert.equal(extractionCalls, 0);
      const conflictJob = queue.getJob(jobId);
      assert.equal(conflictJob.artifacts.accompaniment, undefined);
      assert.equal(conflictJob.conflict.incomingAccompanimentRelPath, null);

      const resolved = await queue.resolveImportConflict(jobId, { choice: 'keep-existing' });
      assert.equal(resolved.status, 'IMPORTED');
      const item = getRepertoire(db, songId);
      assert.equal(item.tracks.accompaniment.media.id, oldAccompaniment.clipId);
      assert.deepEqual(item.lyrics.map(line => line.text), ['第一句', '第二句']);
      assert.equal(readFileSync(oldAccompaniment.absolute, 'utf8'), 'old-accompaniment');
      assert.equal(extractionCalls, 0);
    } finally {
      db.close();
    }
  });
});
