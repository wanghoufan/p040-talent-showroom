import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { openDatabase } from '../server/db/database.mjs';
import { getRepertoire } from '../server/repertoire/service.mjs';
import { createSourcePolicy } from '../server/vocal-import/source-policy.mjs';
import { openVocalImportQueue } from '../server/vocal-import/queue.mjs';
import { createLocalSeparator } from '../server/vocal-import/separator.mjs';
import { createRepertoireImporter } from '../server/vocal-import/importer.mjs';
import { createTestAccompanimentVerifier } from './helpers/test-accompaniment-verifier.mjs';

/**
 * P040 V3.1 专项集成测试：20+ 歌曲批量隔离 / 服务重启恢复 / 重复入库幂等。
 *
 * 边界声明：
 * - 使用独立临时目录、独立临时 SQLite 与假分离器（真实子进程，但输出是假音频）；
 * - 结论只覆盖队列、恢复与入库契约，不代表真实人声分离音质、真实 FFmpeg/模型耗时，
 *   也不代表 Android 真机或生产数据库表现；
 * - 不读取、不写入任何真实音乐目录与设备数据。
 */

const NO_PROBE = { probe: false, fingerprint: false, deep: false };
const lrcFor = stem => `[ti:${stem}]\n[ar:测试歌手]\n[00:01.00]第一句 ${stem}\n[00:03.50]第二句\n`;

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'p040-v31-batch-'));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function put(dir, name, content) {
  const path = join(dir, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function executable(dir, name, source) {
  const path = join(dir, name);
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

/** 真实子进程的假分离器：可按文件名注入失败，并记录每次调用。 */
function fakeSeparatorScript(dir) {
  return executable(dir, 'fake-batch-separator.mjs', `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const args = process.argv.slice(2);
const value = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
const outputDir = value('--output_dir');
const source = args.at(-1);
const name = basename(source);
if (process.env.SEP_LOG) appendFileSync(process.env.SEP_LOG, name + '\\n');
if (name.includes(process.env.FAIL_MARKER || 'Broken Audio')) process.exit(7);
await new Promise(resolve => setTimeout(resolve, 5));
if (value('--single_stem') !== 'Instrumental') process.exit(3);
writeFileSync(join(outputDir, name.replace(/\\.[^.]+$/, '') + '_(Instrumental)_fake.flac'), 'inst:' + name);
`);
}

function fakeFfprobe(dir, durationSeconds = 120) {
  return executable(dir, 'fake-batch-ffprobe.mjs', `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ format: { duration: '${durationSeconds}', tags: {} } }));
`);
}

function seedBatch(music, { count, prefix }) {
  const songs = [];
  for (let index = 1; index <= count; index += 1) {
    const pad = String(index).padStart(2, '0');
    const stem = `${prefix} ${pad} - 测试歌手 ${pad}`;
    const content = `audio-${prefix}-${pad}`;
    put(music, `${stem}.mp3`, content);
    put(music, `${stem}.lrc`, lrcFor(stem));
    songs.push({ stem, path: join(music, `${stem}.mp3`), bytes: content });
  }
  return songs;
}

function buildSeparator(dir, musicLog) {
  return createLocalSeparator({
    mediaRoot: join(dir, 'media'),
    command: fakeSeparatorScript(dir),
    ffprobeBin: fakeFfprobe(dir),
    env: { ...process.env, SEP_LOG: musicLog, FAIL_MARKER: 'Broken Audio' },
  });
}

function makeRig(dir, { maxAttempts = 3 } = {}) {
  const dbPath = join(dir, 'db.sqlite');
  const mediaRoot = join(dir, 'media');
  const music = join(dir, 'music');
  mkdirSync(mediaRoot, { recursive: true });
  mkdirSync(music, { recursive: true });
  const db = openDatabase(dbPath);
  const policy = createSourcePolicy({ roots: [{ id: 'music', label: '临时音乐', path: music }] });
  const separatorLog = join(dir, 'separator.log');
  const extractor = buildSeparator(dir, separatorLog);
  const importer = createRepertoireImporter({
    db,
    mediaRoot,
    policy,
    verifyAccompaniment: createTestAccompanimentVerifier(),
  });
  const { queue, recovered } = openVocalImportQueue({
    db,
    policy,
    mediaRoot,
    extractor,
    importer,
    verifyAccompaniment: createTestAccompanimentVerifier(),
    maxAttempts,
    logger: null,
  });
  return { db, dbPath, mediaRoot, music, policy, separatorLog, extractor, importer, queue, recovered };
}

function readRunCount(logPath) {
  try {
    return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function statusCounts(db) {
  const rows = db.prepare('SELECT status, count(*) AS n FROM vocal_import_jobs GROUP BY status').all();
  return Object.fromEntries(rows.map(row => [row.status, row.n]));
}

function libraryCounts(db) {
  return {
    items: db.prepare("SELECT count(*) AS n FROM repertoire_items WHERE kind='VOCAL'").get().n,
    clips: db.prepare('SELECT count(*) AS n FROM performance_clips').get().n,
    sources: db.prepare('SELECT count(*) AS n FROM source_media').get().n,
  };
}

async function drain(queue, limit = 200) {
  const results = [];
  for (let index = 0; index < limit; index += 1) {
    const result = await queue.runOnce();
    if (result.reason === 'EMPTY') return results;
    results.push(result);
  }
  throw new Error('队列在预期次数内没有清空');
}

test('20+ 歌曲批量：坏音频与歌词冲突只落在单个任务，不阻断其余曲目', async () => {
  await withTempDir(async dir => {
    const rig = makeRig(dir, { maxAttempts: 1 });
    const { db, music, queue } = rig;
    const good = seedBatch(music, { count: 21, prefix: 'Batch' });
    const brokenAudioPath = put(music, 'Broken Audio - 测试歌手.mp3', 'broken-audio-bytes');
    put(music, 'Broken Audio - 测试歌手.lrc', lrcFor('Broken Audio - 测试歌手'));
    const conflictPath = put(music, 'Broken Lyrics - 测试歌手.mp3', 'lyrics-conflict-audio');
    put(music, 'Broken Lyrics - 测试歌手.lrc', '[bad-tag: 未知标签]\n[00:02.00]坏歌词\n');
    const before = new Map([
      ...good.map(song => [song.path, song.bytes]),
      [brokenAudioPath, 'broken-audio-bytes'],
      [conflictPath, 'lyrics-conflict-audio'],
    ]);

    try {
      const enqueued = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      assert.equal(enqueued.created.length, 23);
      assert.equal(enqueued.scan.summary.needsReview, 1);

      // 固定处理顺序，把坏音频放在批次中段，确定性地证明失败后仍会继续处理后续任务。
      const rows = db.prepare('SELECT id, source_rel_path FROM vocal_import_jobs').all();
      const brokenRow = rows.find(row => row.source_rel_path.includes('Broken Audio'));
      const reviewRow = rows.find(row => row.source_rel_path.includes('Broken Lyrics'));
      const healthyRows = rows.filter(row => row !== brokenRow && row !== reviewRow);
      assert.equal(healthyRows.length, 21);
      const sequence = [
        ...healthyRows.slice(0, 10),
        brokenRow,
        ...healthyRows.slice(10),
        reviewRow,
      ];
      const reorder = db.prepare('UPDATE vocal_import_jobs SET created_at=? WHERE id=?');
      sequence.forEach((row, index) => {
        reorder.run(`2026-01-01 00:00:${String(index).padStart(2, '0')}`, row.id);
      });

      const results = await drain(queue);
      const failedIndex = results.findIndex(result => result.jobId === brokenRow.id);
      assert.ok(failedIndex >= 0, '坏音频任务应当被处理');
      assert.equal(results[failedIndex].reason, 'SEPARATOR_FAILED');
      const importedAfterFailure = results
        .slice(failedIndex + 1)
        .filter(result => result.status === 'IMPORTED').length;
      assert.equal(importedAfterFailure, 11, '坏音频之后的 11 首仍应全部入库');

      const counts = statusCounts(db);
      assert.deepEqual(counts, { IMPORTED: 21, FAILED: 1, NEEDS_REVIEW: 1 });
      assert.deepEqual(libraryCounts(db), { items: 21, clips: 42, sources: 21 });

      const brokenJob = queue.getJob(brokenRow.id);
      assert.equal(brokenJob.status, 'FAILED');
      assert.equal(brokenJob.attempts, 1);
      assert.equal(brokenJob.error.code, 'SEPARATOR_FAILED');
      assert.ok(brokenJob.events.some(event => event.event === 'failed'));

      const reviewJob = queue.getJob(reviewRow.id);
      assert.equal(reviewJob.status, 'NEEDS_REVIEW');
      assert.equal(reviewJob.stage, 'MATCH');
      assert.ok(reviewJob.issues.includes('lyrics-invalid-tags'));
      assert.equal(getRepertoire(db, reviewJob.songId), null);

      for (const row of healthyRows) {
        const job = queue.getJob(row.id);
        assert.equal(job.status, 'IMPORTED');
        const item = getRepertoire(db, job.songId);
        assert.ok(item, `${job.title} 应已入库`);
        assert.equal(item.kind, 'VOCAL');
        assert.ok(item.tracks.original?.media?.id);
        assert.ok(item.tracks.accompaniment?.media?.id);
        assert.equal(item.lyrics.length, 2);
      }

      for (const [path, bytes] of before) {
        assert.equal(readFileSync(path, 'utf8'), bytes, `${basename(path)} 的源文件不应被改动`);
      }
    } finally {
      db.close();
    }
  });
});

test('服务重启：过期租约恢复，已校验任务只补入库、不重新提取', async () => {
  await withTempDir(async dir => {
    const rig = makeRig(dir, { maxAttempts: 2 });
    const { db, dbPath, mediaRoot, music, separatorLog } = rig;
    const songs = seedBatch(music, { count: 10, prefix: 'Restart' });

    try {
      const enqueued = await rig.queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      assert.equal(enqueued.created.length, 10);
      for (let index = 0; index < 2; index += 1) {
        const result = await rig.queue.runOnce();
        assert.equal(result.status, 'IMPORTED');
      }

      const rows = db
        .prepare('SELECT id, song_id, source_rel_path, status FROM vocal_import_jobs ORDER BY created_at, id')
        .all();
      const pending = rows.filter(row => row.status !== 'IMPORTED');
      assert.equal(pending.length, 8);
      const crashExtract = pending[0];
      const resumeImport = pending[1];
      const resumeStem = basename(resumeImport.source_rel_path).replace(/\.[^.]+$/, '');

      const artifactRelative = relative(mediaRoot, join(mediaRoot, 'vocal-import', resumeImport.song_id, 'resume-accompaniment.flac'))
        .split(sep)
        .join('/');
      const artifactAbsolute = join(mediaRoot, 'vocal-import', resumeImport.song_id, 'resume-accompaniment.flac');
      const artifactContent = `resume-accompaniment-${resumeImport.song_id}`;
      put(mediaRoot, artifactRelative, artifactContent);
      const artifact = {
        relPath: artifactRelative,
        sha256: sha256(artifactContent),
        sizeBytes: statSync(artifactAbsolute).size,
        durationMs: 120000,
        codec: 'flac',
      };
      const artifactBefore = readFileSync(artifactAbsolute);

      // 模拟进程在“提取中”和“校验完成待入库”两个时点被杀，租约已过期。
      db.prepare(
        "UPDATE vocal_import_jobs SET status='EXTRACTING',stage='EXTRACT',lease_owner='dead',lease_expires_at=1,artifacts_json='{}',source_duration_ms=120000 WHERE id=?",
      ).run(crashExtract.id);
      db.prepare(
        "UPDATE vocal_import_jobs SET status='VERIFYING',stage='VERIFY',lease_owner='dead',lease_expires_at=1,artifacts_json=?,source_duration_ms=120000 WHERE id=?",
      ).run(JSON.stringify({ accompaniment: artifact }), resumeImport.id);

      const runsBeforeRestart = readRunCount(separatorLog);
      db.close();

      const reopenedDb = openDatabase(dbPath);
      const reopenedPolicy = createSourcePolicy({
        roots: [{ id: 'music', label: '临时音乐', path: music }],
      });
      const reopenedExtractor = buildSeparator(dir, separatorLog);
      const reopenedImporter = createRepertoireImporter({
        db: reopenedDb,
        mediaRoot,
        policy: reopenedPolicy,
        verifyAccompaniment: createTestAccompanimentVerifier(),
      });
      const reopened = openVocalImportQueue({
        db: reopenedDb,
        policy: reopenedPolicy,
        mediaRoot,
        extractor: reopenedExtractor,
        importer: reopenedImporter,
        verifyAccompaniment: createTestAccompanimentVerifier(),
        maxAttempts: 2,
        logger: null,
      });

      try {
        assert.equal(reopened.recovered, 2);
        assert.equal(reopened.queue.getJob(crashExtract.id).status, 'PENDING_EXTRACT');
        assert.equal(reopened.queue.getJob(resumeImport.id).status, 'VERIFYING');
        assert.ok(
          reopened.queue
            .getJob(crashExtract.id)
            .events.some(event => event.event === 'recovered'),
        );

        await drain(reopened.queue);

        // 8 个剩余任务中，只有“提取中”的那个需要重新提取；已校验的只补入库。
        const runsAfterRestart = readRunCount(separatorLog);
        assert.equal(runsAfterRestart - runsBeforeRestart, 7);
        const calledNames = readFileSync(separatorLog, 'utf8').split('\n').filter(Boolean);
        assert.equal(calledNames.includes(`${resumeStem}.mp3`), false);

        const counts = statusCounts(reopenedDb);
        assert.deepEqual(counts, { IMPORTED: 10 });
        assert.deepEqual(libraryCounts(reopenedDb), { items: 10, clips: 20, sources: 10 });
        assert.deepEqual(readFileSync(artifactAbsolute), artifactBefore);

        for (const song of songs) {
          assert.equal(readFileSync(song.path, 'utf8'), song.bytes);
        }

        const reopenedRow = reopenedDb
          .prepare('SELECT song_id FROM vocal_import_jobs WHERE id=?')
          .get(resumeImport.id);
        const item = getRepertoire(reopenedDb, reopenedRow.song_id);
        assert.ok(item?.tracks.accompaniment?.media?.id);
      } finally {
        reopenedDb.close();
      }
    } finally {
      try {
        db.close();
      } catch {
        // 已在模拟重启时关闭
      }
    }
  });
});

test('重复入库幂等：重扫不新增任务，重复调用入库器不复制曲目、不改歌词', async () => {
  await withTempDir(async dir => {
    const rig = makeRig(dir, { maxAttempts: 2 });
    const { db, music, importer, queue } = rig;
    const songs = seedBatch(music, { count: 6, prefix: 'Idem' });

    try {
      const enqueued = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      assert.equal(enqueued.created.length, 6);
      await drain(queue);
      assert.deepEqual(statusCounts(db), { IMPORTED: 6 });
      assert.deepEqual(libraryCounts(db), { items: 6, clips: 12, sources: 6 });

      for (let index = 0; index < 2; index += 1) {
        const rescanned = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
        assert.equal(rescanned.created.length, 0);
        assert.equal(rescanned.reused.length, 6);
      }
      assert.equal(db.prepare('SELECT count(*) AS n FROM vocal_import_jobs').get().n, 6);
      assert.equal((await queue.runOnce()).reason, 'EMPTY');
      assert.deepEqual(libraryCounts(db), { items: 6, clips: 12, sources: 6 });

      for (const jobId of enqueued.created) {
        const job = queue.getJob(jobId);
        const result = await importer({ job, artifact: job.artifacts.accompaniment });
        assert.equal(result.status, 'UNCHANGED');
        assert.equal(queue.getJob(jobId).status, 'IMPORTED');
      }

      assert.deepEqual(libraryCounts(db), { items: 6, clips: 12, sources: 6 });
      for (const song of songs) {
        const job = db
          .prepare('SELECT song_id FROM vocal_import_jobs WHERE source_rel_path=?')
          .get(basename(song.path));
        const item = getRepertoire(db, job.song_id);
        assert.deepEqual(item.lyrics.map(line => line.text), [`第一句 ${song.stem}`, '第二句']);
        assert.equal(readFileSync(song.path, 'utf8'), song.bytes);
      }
    } finally {
      db.close();
    }
  });
});
