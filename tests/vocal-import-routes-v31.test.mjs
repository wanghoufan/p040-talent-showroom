import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { openDatabase } from '../server/db/database.mjs';
import { getRepertoire, saveRepertoire } from '../server/repertoire/service.mjs';
import { createSourcePolicy } from '../server/vocal-import/source-policy.mjs';
import { openVocalImportQueue } from '../server/vocal-import/queue.mjs';
import { createRepertoireImporter } from '../server/vocal-import/importer.mjs';
import { createTestAccompanimentVerifier } from './helpers/test-accompaniment-verifier.mjs';
import { mountVocalImportRoutes } from '../server/vocal-import/routes.mjs';
import { songIdForAudioSha } from '../server/vocal-import/uuid5.mjs';

const NO_PROBE = { probe: false, fingerprint: false, deep: false };
const LRC = '[ti:测试歌]\n[ar:测试歌手]\n[00:01.00]第一句\n[00:03.50]第二句\n';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'p040-v31-routes-'));
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

function insertTrack(db, mediaRoot, { relPath, content, durationMs = 120000 }) {
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
  ).run(clipId, sourceId, 0, durationMs, relPath, 'mp3', 1, sha, sizeBytes, durationMs);
  return { clipId, sourceId, relPath, sha, sizeBytes, absolute, content };
}

function seedItem(db, { id, audioRole, original, accompaniment }) {
  saveRepertoire(db, null, { clientId: id, kind: 'VOCAL', title: '旧曲', language: 'zh' });
  db.prepare(
    'UPDATE repertoire_items SET audio_role=?,performance_clip_id=?,original_clip_id=?,accompaniment_clip_id=?,source_media_id=? WHERE id=?',
  ).run(
    audioRole,
    (accompaniment ?? original)?.clipId ?? null,
    original?.clipId ?? null,
    accompaniment?.clipId ?? null,
    (original ?? accompaniment)?.sourceId ?? null,
    id,
  );
}

function setDuration(db, jobId, durationMs = 120000) {
  db.prepare('UPDATE vocal_import_jobs SET source_duration_ms=? WHERE id=?').run(durationMs, jobId);
}

async function withHttpServer(handler, run) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    Promise.resolve(handler(req, res, url, {})).catch(() => {
      res.writeHead(500).end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function postJson(base, path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('路由：分离器不可用时只入库原唱 + 歌词，鉴权生效且保留后续重试', async () => {
  await withTempDir(async dir => {
    const { db, music, policy, open } = makeEnv(dir);
    put(music, 'Singer - Song.mp3', 'original-only-source');
    put(music, 'Singer - Song.lrc', LRC);
    const queue = open({ extractor: null }).queue;
    try {
      const enqueued = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const jobId = enqueued.created[0];
      const songId = enqueued.jobs[0].songId;
      setDuration(db, jobId);
      assert.equal((await queue.runOnce()).reason, 'EXTRACTOR_NOT_CONFIGURED');
      assert.equal(queue.getJob(jobId).error.code, 'EXTRACTOR_NOT_CONFIGURED');

      const handler = mountVocalImportRoutes({ policy, queue, authorize: () => true });
      await withHttpServer(handler, async base => {
        assert.equal((await fetch(`${base}/api/vocal-import/jobs/${jobId}/original-only`)).status, 405);

        // 非冲突状态提交冲突选择必须得到可读的 409，而不是静默成功。
        const notConflict = await postJson(base, `/api/vocal-import/jobs/${jobId}/resolve-conflict`, { choice: 'keep-existing' });
        assert.equal(notConflict.status, 409);
        const notConflictBody = await notConflict.json();
        assert.equal(notConflictBody.error.code, 'CONFLICT');
        assert.equal(notConflictBody.error.message, '任务不在入库冲突状态');

        const imported = await postJson(base, `/api/vocal-import/jobs/${jobId}/original-only`);
        assert.equal(imported.status, 200);
        const payload = await imported.json();
        assert.equal(payload.status, 'IMPORTED');
        assert.equal(payload.artifacts.accompaniment, undefined);
        assert.equal(payload.error, null);

        const item = getRepertoire(db, songId);
        assert.ok(item.tracks.original?.media?.id);
        assert.equal(item.tracks.accompaniment, undefined);
        assert.deepEqual(item.lyrics.map(line => line.text), ['第一句', '第二句']);

        const retry = await postJson(base, `/api/vocal-import/jobs/${jobId}/retry`);
        const retryBody = await retry.json();
        assert.equal(retry.status, 200, JSON.stringify(retryBody));
        assert.equal(retryBody.status, 'PENDING_EXTRACT');
        assert.equal(retryBody.importMode, 'ORIGINAL_ONLY');
        assert.ok(retryBody.events.some(event => event.event === 'retried' && event.detail?.resume === 'extract-accompaniment'));
      });

      const guarded = mountVocalImportRoutes({
        policy: createSourcePolicy({ roots: [{ id: 'music', label: '临时', path: music }] }),
        queue,
        authorize: () => false,
      });
      await withHttpServer(guarded, async base => {
        assert.equal((await postJson(base, `/api/vocal-import/jobs/${jobId}/original-only`)).status, 401);
      });
    } finally {
      db.close();
    }
  });
});

test('路由：已有伴奏冲突必须显式选择保留旧伴奏，非法输入与非冲突状态有明确错误', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, open } = makeEnv(dir);
    const sourcePath = put(music, 'Singer - Song.mp3', 'keep-old-source');
    put(music, 'Singer - Song.lrc', LRC);
    const songId = songIdForAudioSha(sha256(readFileSync(sourcePath)));
    const oldAccompaniment = insertTrack(db, mediaRoot, { relPath: 'user/old-accompaniment.mp3', content: 'old-accompaniment' });
    const oldOriginal = insertTrack(db, mediaRoot, { relPath: 'user/old-original.mp3', content: 'old-original' });
    seedItem(db, { id: songId, audioRole: 'ACCOMPANIMENT', original: oldOriginal, accompaniment: oldAccompaniment });

    const queue = open({
      extractor: async () => {
        throw new Error('保留旧伴奏时不得提取');
      },
    }).queue;
    const policy = createSourcePolicy({ roots: [{ id: 'music', label: '临时', path: music }] });
    try {
      const enqueued = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const jobId = enqueued.created[0];
      setDuration(db, jobId);
      assert.equal((await queue.runOnce()).status, 'NEEDS_REVIEW');
      assert.equal(queue.getJob(jobId).conflict.code, 'ACCOMPANIMENT_CONFLICT');

      const handler = mountVocalImportRoutes({ policy, queue, authorize: () => true });
      await withHttpServer(handler, async base => {
        const absolute = await postJson(base, `/api/vocal-import/jobs/${jobId}/resolve-conflict`, { path: '/Volumes/音乐' });
        assert.equal(absolute.status, 403);
        assert.equal((await absolute.json()).error.code, 'PATH_NOT_ALLOWED');

        const invalid = await postJson(base, `/api/vocal-import/jobs/${jobId}/resolve-conflict`, { choice: 'replace' });
        assert.equal(invalid.status, 400);
        assert.equal((await invalid.json()).error.code, 'BAD_REQUEST');
        assert.equal(queue.getJob(jobId).status, 'NEEDS_REVIEW');

        const resolved = await postJson(base, `/api/vocal-import/jobs/${jobId}/resolve-conflict`, { choice: 'keep-existing' });
        assert.equal(resolved.status, 200);
        const payload = await resolved.json();
        assert.equal(payload.status, 'IMPORTED');
        assert.equal(payload.conflict.code, undefined);

        const item = getRepertoire(db, songId);
        assert.equal(item.tracks.accompaniment.media.id, oldAccompaniment.clipId);
        assert.equal(item.tracks.original.media.id, oldOriginal.clipId);
        assert.deepEqual(item.lyrics.map(line => line.text), ['第一句', '第二句']);
        assert.equal(readFileSync(oldAccompaniment.absolute, 'utf8'), 'old-accompaniment');

        // 已入库后再次提交冲突选择是幂等的，不会二次替换或删除旧轨。
        const again = await postJson(base, `/api/vocal-import/jobs/${jobId}/resolve-conflict`, { choice: 'use-new' });
        assert.equal(again.status, 200);
        assert.equal((await again.json()).status, 'IMPORTED');
        assert.equal(getRepertoire(db, songId).tracks.accompaniment.media.id, oldAccompaniment.clipId);
      });
    } finally {
      db.close();
    }
  });
});

test('路由：明确选择 use-new 才提取并替换，旧音轨只解绑不删除', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, open } = makeEnv(dir);
    const sourcePath = put(music, 'Singer - Song.mp3', 'use-new-source');
    put(music, 'Singer - Song.lrc', LRC);
    const songId = songIdForAudioSha(sha256(readFileSync(sourcePath)));
    const oldAccompaniment = insertTrack(db, mediaRoot, { relPath: 'user/old-accompaniment.mp3', content: 'old-accompaniment' });
    const oldOriginal = insertTrack(db, mediaRoot, { relPath: 'user/old-original.mp3', content: 'old-original' });
    seedItem(db, { id: songId, audioRole: 'ACCOMPANIMENT', original: oldOriginal, accompaniment: oldAccompaniment });

    let extractionCalls = 0;
    const queue = open({
      extractor: async ({ job, outputDir }) => {
        extractionCalls += 1;
        const absolute = join(outputDir, 'accompaniment.flac');
        const content = Buffer.from(`new-ai:${job.songId}`);
        writeFileSync(absolute, content);
        return {
          relPath: relative(mediaRoot, absolute).split(sep).join('/'),
          sha256: sha256(content),
          sizeBytes: statSync(absolute).size,
          durationMs: 120000,
          codec: 'flac',
        };
      },
    }).queue;
    const policy = createSourcePolicy({ roots: [{ id: 'music', label: '临时', path: music }] });
    try {
      const enqueued = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const jobId = enqueued.created[0];
      setDuration(db, jobId);
      assert.equal((await queue.runOnce()).status, 'NEEDS_REVIEW');
      assert.equal(extractionCalls, 0);

      const handler = mountVocalImportRoutes({ policy, queue, authorize: () => true });
      await withHttpServer(handler, async base => {
        const resolved = await postJson(base, `/api/vocal-import/jobs/${jobId}/resolve-conflict`, { choice: 'use-new' });
        assert.equal(resolved.status, 200);
        assert.equal((await resolved.json()).status, 'IMPORTED');
      });

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
