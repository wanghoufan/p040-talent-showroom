import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
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
import { createAccompanimentVerifier } from '../server/vocal-import/accompaniment-verify.mjs';
import { createRepertoireImporter } from '../server/vocal-import/importer.mjs';
import { openVocalImportQueue } from '../server/vocal-import/queue.mjs';
import { createSourcePolicy } from '../server/vocal-import/source-policy.mjs';
import { createTestAccompanimentVerifier, makeProbe } from './helpers/test-accompaniment-verifier.mjs';

/**
 * P040 V3.1 入库安全复核：伴奏必须是“与原唱不同的、可真实解码的音频”，
 * 且时长与原曲在容差内；失败的伴奏不得登记成音轨，也不得覆盖旧轨。
 *
 * 边界：独立临时目录、独立临时 SQLite；规则使用生产同一份 verifier，
 * 只把 ffprobe/ffmpeg 探测替换为脚本化结果（另有真实 ffmpeg 用例在工具可用时执行）。
 */

const NO_PROBE = { probe: false, fingerprint: false, deep: false };
const LRC = '[ti:测试歌]\n[ar:测试歌手]\n[00:01.00]第一句\n[00:03.50]第二句\n';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'p040-accompaniment-verify-'));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function put(dir, name, content) {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function makeEnv(dir) {
  const db = openDatabase(join(dir, 'db.sqlite'));
  const mediaRoot = join(dir, 'media');
  const music = join(dir, 'music');
  mkdirSync(mediaRoot, { recursive: true });
  mkdirSync(music, { recursive: true });
  const policy = createSourcePolicy({ roots: [{ id: 'music', label: '临时音乐', path: music }] });
  return { db, mediaRoot, music, policy };
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

function jobFor({ songId, sourcePath, durationMs = 120000 }) {
  const bytes = readFileSync(sourcePath);
  return {
    id: `job-${songId.slice(0, 8)}`,
    songId,
    rootId: 'music',
    title: '测试歌',
    artist: '测试歌手',
    language: 'zh',
    original: {
      relPath: basename(sourcePath),
      sha256: sha256(bytes),
      sizeBytes: bytes.length,
      durationMs,
    },
    lyrics: null,
    suppliedAccompaniment: null,
  };
}

test('校验规则：LRC 等非音频即使探测正常也必须拒绝', async () => {
  await withTempDir(async dir => {
    const lrc = put(dir, 'lyrics.lrc', LRC);
    const verify = createTestAccompanimentVerifier();
    await assert.rejects(
      () => verify({ filePath: lrc, relPath: 'lyrics.lrc', sourceDurationMs: 120000 }),
      error => error.code === 'ACCOMPANIMENT_NOT_AUDIO' && error.status === 422,
    );
  });
});

test('校验规则：与原唱 SHA 相同必须拒绝（至少 SHA 层拦截）', async () => {
  await withTempDir(async dir => {
    const source = put(dir, 'original.mp3', 'same-bytes');
    const accompaniment = put(dir, 'accompaniment.flac', 'same-bytes');
    const verify = createTestAccompanimentVerifier();
    const bytes = readFileSync(source);
    await assert.rejects(
      () =>
        verify({
          filePath: accompaniment,
          relPath: 'accompaniment.flac',
          originalFilePath: source,
          originalSha256: sha256(bytes),
          sourceDurationMs: 120000,
        }),
      error => error.code === 'ACCOMPANIMENT_DUPLICATES_ORIGINAL' && error.status === 422,
    );
  });
});

test('校验规则：不能解码或缺少 ffmpeg 时拒绝，不把“未知”当通过', async () => {
  await withTempDir(async dir => {
    const file = put(dir, 'broken.flac', 'not-audio');
    await assert.rejects(
      () => createAccompanimentVerifier({ probe: makeProbe({ probeState: 'invalid' }) })({ filePath: file, sourceDurationMs: 120000 }),
      error => error.code === 'ACCOMPANIMENT_NOT_DECODABLE',
    );
    await assert.rejects(
      () =>
        createAccompanimentVerifier({ probe: makeProbe({ probeState: 'not-installed' }) })({
          filePath: file,
          sourceDurationMs: 120000,
        }),
      error => error.code === 'ACCOMPANIMENT_VERIFIER_UNAVAILABLE' && error.status === 503,
    );
  });
});

test('校验规则：时长超出容差拒绝，容差内通过并使用解码所得时长', async () => {
  await withTempDir(async dir => {
    const file = put(dir, 'accompaniment.flac', 'different-audio');
    const tooLong = createTestAccompanimentVerifier({ durationMs: 200000 });
    await assert.rejects(
      () => tooLong({ filePath: file, originalSha256: null, sourceDurationMs: 120000 }),
      error => error.code === 'ACCOMPANIMENT_DURATION_MISMATCH',
    );
    const near = createTestAccompanimentVerifier({ durationMs: 121000 });
    const verified = await near({ filePath: file, originalSha256: null, sourceDurationMs: 120000 });
    assert.equal(verified.durationMs, 121000);
    assert.equal(verified.sourceDurationMs, 120000);
  });
});

test('校验规则：记录里的 SHA 与实际文件不一致时拒绝', async () => {
  await withTempDir(async dir => {
    const file = put(dir, 'accompaniment.flac', 'real-bytes');
    const verify = createTestAccompanimentVerifier();
    await assert.rejects(
      () => verify({ filePath: file, sourceDurationMs: 120000, expectedSha256: sha256('other-bytes') }),
      error => error.code === 'CONFLICT',
    );
  });
});

test('队列：自带伴奏与原唱相同，退回人工核对且不登记工件/不写音轨', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, policy } = makeEnv(dir);
    const sourceBytes = 'identical-source-and-accompaniment';
    const sourcePath = put(music, 'Singer - Same.mp3', sourceBytes);
    put(music, 'Singer - Same.lrc', LRC);
    put(music, 'Singer - Same (伴奏).mp3', sourceBytes);
    const { queue } = openVocalImportQueue({
      db,
      policy,
      mediaRoot,
      verifyAccompaniment: createTestAccompanimentVerifier(),
      maxAttempts: 1,
      logger: null,
    });
    try {
      const enqueued = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      assert.equal(enqueued.created.length, 1);
      const jobId = enqueued.created[0];
      const songId = enqueued.jobs[0].songId;
      db.prepare(
        "UPDATE vocal_import_jobs SET supplied_accompaniment_rel_path=?,status='READY_TO_IMPORT',stage='VERIFY',source_duration_ms=120000 WHERE id=?",
      ).run('Singer - Same (伴奏).mp3', jobId);

      const result = await queue.runOnce();
      assert.equal(result.reason, 'ACCOMPANIMENT_DUPLICATES_ORIGINAL');
      const job = queue.getJob(jobId);
      assert.equal(job.status, 'NEEDS_REVIEW');
      assert.equal(job.stage, 'MATCH');
      assert.equal(job.error.code, 'ACCOMPANIMENT_DUPLICATES_ORIGINAL');
      assert.equal(job.suppliedAccompaniment, null);
      assert.deepEqual(job.artifacts, {});
      assert.equal(job.artifactRows.length, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, 0);
      assert.equal(existsSync(join(mediaRoot, 'vocal-import', songId, 'supplied-accompaniment.mp3')), false);
      assert.equal(readFileSync(sourcePath, 'utf8'), sourceBytes);
      void sourcePath;
    } finally {
      db.close();
    }
  });
});

test('队列：自带伴奏是 LRC，退回人工核对且不复制进受控目录', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, policy } = makeEnv(dir);
    put(music, 'Singer - LrcSupplied.mp3', 'source-for-lrc-supplied');
    put(music, 'Singer - LrcSupplied.lrc', LRC);
    const { queue } = openVocalImportQueue({
      db,
      policy,
      mediaRoot,
      verifyAccompaniment: createTestAccompanimentVerifier(),
      maxAttempts: 1,
      logger: null,
    });
    try {
      const enqueued = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const jobId = enqueued.created[0];
      const songId = enqueued.jobs[0].songId;
      db.prepare(
        "UPDATE vocal_import_jobs SET supplied_accompaniment_rel_path=?,status='READY_TO_IMPORT',stage='VERIFY',source_duration_ms=120000 WHERE id=?",
      ).run('Singer - LrcSupplied.lrc', jobId);

      const result = await queue.runOnce();
      assert.equal(result.reason, 'ACCOMPANIMENT_NOT_AUDIO');
      const job = queue.getJob(jobId);
      assert.equal(job.status, 'NEEDS_REVIEW');
      assert.equal(job.error.code, 'ACCOMPANIMENT_NOT_AUDIO');
      assert.equal(job.artifacts.accompaniment, undefined);
      assert.equal(job.artifactRows.length, 0);
      assert.equal(existsSync(join(mediaRoot, 'vocal-import', songId, 'supplied-accompaniment.lrc')), false);
      assert.equal(db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, 0);
    } finally {
      db.close();
    }
  });
});

test('队列：分离产物与原唱相同，失败且不登记成可播放伴奏', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, policy } = makeEnv(dir);
    const sourceBytes = 'separator-must-not-return-source';
    put(music, 'Singer - Echo.mp3', sourceBytes);
    const extractor = async ({ outputDir, sourceFile }) => {
      const target = join(outputDir, 'accompaniment.flac');
      copyFileSync(sourceFile, target);
      return {
        relPath: relative(mediaRoot, target).split(sep).join('/'),
        sha256: sha256(readFileSync(target)),
        sizeBytes: statSync(target).size,
        durationMs: 120000,
        codec: 'flac',
      };
    };
    const { queue } = openVocalImportQueue({
      db,
      policy,
      mediaRoot,
      extractor,
      verifyAccompaniment: createTestAccompanimentVerifier(),
      maxAttempts: 3,
      logger: null,
    });
    try {
      const enqueued = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const jobId = enqueued.created[0];
      db.prepare('UPDATE vocal_import_jobs SET source_duration_ms=120000 WHERE id=?').run(jobId);
      const result = await queue.runOnce();
      assert.equal(result.reason, 'ACCOMPANIMENT_DUPLICATES_ORIGINAL');
      const job = queue.getJob(jobId);
      assert.equal(job.status, 'FAILED');
      assert.equal(job.error.code, 'ACCOMPANIMENT_DUPLICATES_ORIGINAL');
      assert.deepEqual(job.artifacts, {});
      assert.equal(job.artifactRows.length, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM vocal_import_artifacts').get().n, 0);
    } finally {
      db.close();
    }
  });
});

test('入库器：LRC 冒充伴奏直接拒绝，不写曲目/音轨/原唱副本', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, policy } = makeEnv(dir);
    const sourcePath = put(music, 'Singer - Lrc.mp3', 'real-source');
    const importer = createRepertoireImporter({
      db,
      mediaRoot,
      policy,
      verifyAccompaniment: createTestAccompanimentVerifier(),
    });
    const songId = '66666666-6666-5666-8666-666666666666';
    const lrcArtifact = artifactFor(mediaRoot, songId, LRC, 'fake-accompaniment.lrc');
    try {
      await assert.rejects(
        () => importer({ job: jobFor({ songId, sourcePath }), artifact: lrcArtifact }),
        error => error.code === 'ACCOMPANIMENT_NOT_AUDIO',
      );
      assert.equal(db.prepare('SELECT count(*) AS n FROM repertoire_items').get().n, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, 0);
      assert.equal(existsSync(join(mediaRoot, 'vocal-import', songId, 'original.mp3')), false);
    } finally {
      db.close();
    }
  });
});

test('入库器：时长不符的新伴奏失败，且不覆盖旧伴奏/旧原唱', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, policy } = makeEnv(dir);
    const sourcePath = put(music, 'Singer - Duration.mp3', 'duration-source');
    const songId = '77777777-7777-5777-8777-777777777777';
    const job = jobFor({ songId, sourcePath });
    const firstArtifact = artifactFor(mediaRoot, songId, 'first-accompaniment', 'first.flac');
    const firstImporter = createRepertoireImporter({
      db,
      mediaRoot,
      policy,
      verifyAccompaniment: createTestAccompanimentVerifier(),
    });
    try {
      const created = await firstImporter({ job, artifact: firstArtifact });
      assert.equal(created.status, 'CREATED');
      const before = getRepertoire(db, songId);
      const oldAccId = before.tracks.accompaniment.media.id;
      const oldOriginalId = before.tracks.original.media.id;
      const oldAccRow = db.prepare('SELECT * FROM performance_clips WHERE id=?').get(oldAccId);
      const oldAccBytes = readFileSync(join(mediaRoot, oldAccRow.internal_audio_path));

      const wrongDurationImporter = createRepertoireImporter({
        db,
        mediaRoot,
        policy,
        verifyAccompaniment: createTestAccompanimentVerifier({ durationMs: 200000 }),
      });
      const nextArtifact = artifactFor(mediaRoot, songId, 'second-accompaniment', 'second.flac');
      await assert.rejects(
        () => wrongDurationImporter({ job, artifact: nextArtifact, choice: 'use-new' }),
        error => error.code === 'ACCOMPANIMENT_DURATION_MISMATCH',
      );

      const after = getRepertoire(db, songId);
      assert.equal(after.tracks.accompaniment.media.id, oldAccId);
      assert.equal(after.tracks.original.media.id, oldOriginalId);
      assert.deepEqual(readFileSync(join(mediaRoot, oldAccRow.internal_audio_path)), oldAccBytes);
      assert.equal(db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, 2);
    } finally {
      db.close();
    }
  });
});

test('生产默认：真实 ffprobe/ffmpeg 下确实解码、识别重复与时长不符', async t => {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    t.skip('本机没有 ffprobe/ffmpeg，跳过真实解码用例（生产部署仍必须有）');
    return;
  }
  await withTempDir(async dir => {
    const original = join(dir, 'original.wav');
    const accompaniment = join(dir, 'accompaniment.wav');
    const duplicate = join(dir, 'duplicate.wav');
    const longOne = join(dir, 'too-long.wav');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:a', 'pcm_s16le', original]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=6', '-c:a', 'pcm_s16le', accompaniment]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=520:duration=12', '-c:a', 'pcm_s16le', longOne]);
    copyFileSync(original, duplicate);

    const verify = createAccompanimentVerifier();
    const originalSha256 = sha256(readFileSync(original));

    const verified = await verify({
      filePath: accompaniment,
      relPath: 'accompaniment.wav',
      originalFilePath: original,
      originalSha256,
    });
    assert.ok(verified.durationMs >= 5000 && verified.durationMs <= 7000);
    assert.notEqual(verified.sha256, originalSha256);

    await assert.rejects(
      () => verify({ filePath: duplicate, relPath: 'duplicate.wav', originalFilePath: original, originalSha256 }),
      error => error.code === 'ACCOMPANIMENT_DUPLICATES_ORIGINAL',
    );
    await assert.rejects(
      () => verify({ filePath: longOne, relPath: 'too-long.wav', originalFilePath: original, originalSha256 }),
      error => error.code === 'ACCOMPANIMENT_DURATION_MISMATCH',
    );
  });
});
