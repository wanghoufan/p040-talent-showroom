import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { openDatabase } from '../server/db/database.mjs';
import { createSourcePolicy } from '../server/vocal-import/source-policy.mjs';
import { openVocalImportQueue } from '../server/vocal-import/queue.mjs';
import { createRepertoireImporter } from '../server/vocal-import/importer.mjs';
import { createTestAccompanimentVerifier } from './helpers/test-accompaniment-verifier.mjs';

/**
 * P040 V3.1 租约过期并发专项（定向，不跑全量）。
 *
 * 复现两类旧 worker 覆盖新状态的竞态：
 * 1. 旧 worker 提取未结束，租约过期后被新 worker 接管并完成入库；
 *    旧 worker 随后仍尝试提交结果，不得把 IMPORTED 覆盖回 PENDING_EXTRACT/CONFLICT。
 * 2. 原唱兜底导入等待入库时，新 worker 已完成双轨入库；
 *    旧兜底返回后不得把 import_mode 从 DUAL_TRACK 覆盖成 ORIGINAL_ONLY。
 *
 * 边界：独立临时目录 + 独立临时 SQLite + 可控异步提取器，不读写真实曲库、
 * 不调用真实 FFmpeg/分离模型、不涉及 Android 真机或生产数据库。
 */

const NO_PROBE = { probe: false, fingerprint: false, deep: false };
const LRC = '[ti:租约竞态]\n[ar:测试歌手]\n[00:01.00]第一句\n[00:03.50]第二句\n';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'p040-lease-race-'));
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, rejectPromise) => {
    timer = setTimeout(() => rejectPromise(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function writeArtifact(mediaRoot, outputDir, name, content) {
  mkdirSync(outputDir, { recursive: true });
  const target = join(outputDir, name);
  writeFileSync(target, content);
  return {
    relPath: relative(mediaRoot, target).split(sep).join('/'),
    sha256: sha256(content),
    sizeBytes: statSync(target).size,
    durationMs: 120000,
    codec: 'flac',
  };
}

function libraryCounts(db) {
  return {
    items: db.prepare("SELECT count(*) AS n FROM repertoire_items WHERE kind='VOCAL'").get().n,
    clips: db.prepare('SELECT count(*) AS n FROM performance_clips').get().n,
    sources: db.prepare('SELECT count(*) AS n FROM source_media').get().n,
  };
}

function makeRig(dir) {
  const dbPath = join(dir, 'db.sqlite');
  const mediaRoot = join(dir, 'media');
  const music = join(dir, 'music');
  mkdirSync(mediaRoot, { recursive: true });
  mkdirSync(music, { recursive: true });
  const policy = createSourcePolicy({ roots: [{ id: 'music', label: '临时音乐', path: music }] });
  const seedDb = openDatabase(dbPath);
  return {
    dbPath,
    mediaRoot,
    music,
    policy,
    seedDb,
    openDb: () => openDatabase(dbPath),
  };
}

function seedQueue({ db, policy, mediaRoot }) {
  const queue = openVocalImportQueue({
    db,
    policy,
    mediaRoot,
    extractor: null,
    importer: null,
    verifyAccompaniment: createTestAccompanimentVerifier(),
    logger: null,
  }).queue;
  return queue;
}

async function enqueueOne({ artistSong }, rig) {
  const stem = artistSong;
  put(rig.music, `${stem}.mp3`, `lease-race-source:${stem}`);
  put(rig.music, `${stem}.lrc`, LRC);
  const queue = seedQueue({ db: rig.seedDb, policy: rig.policy, mediaRoot: rig.mediaRoot });
  const enqueued = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
  assert.equal(enqueued.created.length, 1, '临时目录内应只入队 1 首');
  const jobId = enqueued.created[0];
  rig.seedDb.prepare('UPDATE vocal_import_jobs SET source_duration_ms=? WHERE id=?').run(120000, jobId);
  return { jobId, songId: enqueued.jobs[0].songId };
}

test('旧提取 worker 租约过期：新 worker 已入库后旧 worker 不得覆盖为 PENDING_EXTRACT/CONFLICT', async () => {
  await withTempDir(async dir => {
    const rig = makeRig(dir);
    const { jobId } = await enqueueOne({ artistSong: 'Singer - Lease Race' }, rig);

    let clock = 1_700_000_000_000;
    const now = () => clock;
    const dbOld = rig.openDb();
    const dbNew = rig.openDb();

    const oldStarted = deferred();
    const oldGate = deferred();
    let oldArtifact = null;
    const extractorOld = async ({ outputDir }) => {
      oldStarted.resolve();
      await oldGate.promise;
      oldArtifact = writeArtifact(rig.mediaRoot, outputDir, 'old-worker-extract.flac', 'old-worker-accompaniment');
      return oldArtifact;
    };
    let newArtifact = null;
    const extractorNew = async ({ outputDir }) => {
      newArtifact = writeArtifact(rig.mediaRoot, outputDir, 'new-worker-extract.flac', 'new-worker-accompaniment');
      return newArtifact;
    };

    const queueOld = openVocalImportQueue({
      db: dbOld,
      policy: rig.policy,
      mediaRoot: rig.mediaRoot,
      extractor: extractorOld,
      importer: createRepertoireImporter({
        db: dbOld,
        mediaRoot: rig.mediaRoot,
        policy: rig.policy,
        verifyAccompaniment: createTestAccompanimentVerifier(),
        logger: null,
      }),
      verifyAccompaniment: createTestAccompanimentVerifier(),
      leaseMs: 1000,
      // 两个进程故意使用同一个 workerId：租约身份必须靠每次领取的 token 区分，不能靠名字。
      workerId: 'shared-worker',
      now,
      logger: null,
    }).queue;
    const queueNew = openVocalImportQueue({
      db: dbNew,
      policy: rig.policy,
      mediaRoot: rig.mediaRoot,
      extractor: extractorNew,
      importer: createRepertoireImporter({
        db: dbNew,
        mediaRoot: rig.mediaRoot,
        policy: rig.policy,
        verifyAccompaniment: createTestAccompanimentVerifier(),
        logger: null,
      }),
      verifyAccompaniment: createTestAccompanimentVerifier(),
      leaseMs: 1000,
      workerId: 'shared-worker',
      now,
      logger: null,
    }).queue;

    let oldRun = null;
    try {
      // 旧 worker 领取并进入提取，此时租约到期。
      oldRun = queueOld.runOnce();
      await withTimeout(oldStarted.promise, 5000, '旧 worker 提取开始');
      const claimed = dbNew.prepare('SELECT status,lease_owner,lease_expires_at FROM vocal_import_jobs WHERE id=?').get(jobId);
      assert.equal(claimed.status, 'EXTRACTING', '前置条件：旧 worker 应持有未完成的提取租约');
      assert.ok(
        claimed.lease_owner?.startsWith('shared-worker#'),
        `前置条件：租约应带不可复用的领取 token，实际为 ${claimed.lease_owner}`,
      );

      // 模拟进程停顿超过租约：新 worker 接管并完整走完提取→校验→双轨入库。
      clock += 5000;
      const newRun = await withTimeout(queueNew.runOnce(), 5000, '新 worker 接管任务');
      assert.deepEqual(
        { processed: newRun.processed, status: newRun.status },
        { processed: true, status: 'IMPORTED' },
        `前置条件：新 worker 应接管并完成入库；实际返回 ${JSON.stringify(newRun)}`,
      );
      assert.ok(newArtifact, '新 worker 应生成自己的伴奏工件');

      // 旧 worker 现在才结束提取并提交旧结果。
      oldGate.resolve();
      const oldResult = await withTimeout(oldRun, 5000, '旧 worker 提交过期提取结果');
      assert.ok(oldArtifact, '旧 worker 应已生成自己的伴奏工件');

      const finalJob = queueNew.getJob(jobId);
      const observed = {
        status: finalJob.status,
        importMode: finalJob.importMode,
        artifact: finalJob.artifacts.accompaniment?.relPath ?? null,
        errorCode: finalJob.error?.code ?? null,
        library: libraryCounts(dbNew),
      };
      assert.deepEqual(
        observed,
        {
          status: 'IMPORTED',
          importMode: 'DUAL_TRACK',
          artifact: newArtifact.relPath,
          errorCode: null,
          library: { items: 1, clips: 2, sources: 1 },
        },
        `旧 worker 返回 ${JSON.stringify(oldResult)}；过期 worker 不得覆盖新 worker 的入库状态，也不得重复入库`,
      );

      const importedEvents = dbNew
        .prepare("SELECT count(*) AS n FROM vocal_import_events WHERE job_id=? AND event='imported'")
        .get(jobId).n;
      assert.equal(importedEvents, 1, '同一任务只应产生一次成功入库事件');
    } finally {
      oldGate.resolve();
      if (oldRun) await oldRun.catch(() => {});
      dbOld.close();
      dbNew.close();
    }
  });
});

test('原唱兜底与提取并发：新 worker 已双轨入库时旧兜底不得覆盖 import_mode', async () => {
  await withTempDir(async dir => {
    const rig = makeRig(dir);
    const { jobId } = await enqueueOne({ artistSong: 'Singer - Original Only Race' }, rig);

    const dbFallback = rig.openDb();
    const dbWorker = rig.openDb();
    const importerFallback = createRepertoireImporter({
      db: dbFallback,
      mediaRoot: rig.mediaRoot,
      policy: rig.policy,
      verifyAccompaniment: createTestAccompanimentVerifier(),
      logger: null,
    });
    const importerWorker = createRepertoireImporter({
      db: dbWorker,
      mediaRoot: rig.mediaRoot,
      policy: rig.policy,
      verifyAccompaniment: createTestAccompanimentVerifier(),
      logger: null,
    });

    const fallbackStarted = deferred();
    const fallbackGate = deferred();
    const slowImporter = Object.assign(
      (...args) => importerFallback(...args),
      importerFallback,
      {
        importOriginalOnly: async args => {
          fallbackStarted.resolve();
          await fallbackGate.promise;
          return importerFallback.importOriginalOnly(args);
        },
      },
    );

    let workerArtifact = null;
    const extractorWorker = async ({ outputDir }) => {
      workerArtifact = writeArtifact(rig.mediaRoot, outputDir, 'worker-extract.flac', 'worker-accompaniment');
      return workerArtifact;
    };

    const queueFallback = openVocalImportQueue({
      db: dbFallback,
      policy: rig.policy,
      mediaRoot: rig.mediaRoot,
      extractor: null,
      importer: slowImporter,
      verifyAccompaniment: createTestAccompanimentVerifier(),
      workerId: 'fallback-worker',
      logger: null,
    }).queue;
    const queueWorker = openVocalImportQueue({
      db: dbWorker,
      policy: rig.policy,
      mediaRoot: rig.mediaRoot,
      extractor: extractorWorker,
      importer: importerWorker,
      verifyAccompaniment: createTestAccompanimentVerifier(),
      workerId: 'extract-worker',
      logger: null,
    }).queue;

    let fallbackRun = null;
    try {
      // 兜底请求已进入入库器但尚未返回；此时任务在库里仍是 PENDING_EXTRACT。
      fallbackRun = queueFallback.importOriginalOnly(jobId);
      await withTimeout(fallbackStarted.promise, 5000, '原唱兜底进入入库器');

      // 新 worker 在兜底等待期间完成提取与双轨入库。
      const workerRun = await withTimeout(queueWorker.runOnce(), 5000, '新 worker 完成双轨入库');
      assert.deepEqual(
        { processed: workerRun.processed, status: workerRun.status },
        { processed: true, status: 'IMPORTED' },
        `前置条件：新 worker 应先完成双轨入库；实际返回 ${JSON.stringify(workerRun)}`,
      );
      const afterWorker = queueWorker.getJob(jobId);
      assert.equal(afterWorker.importMode, 'DUAL_TRACK', '前置条件：新 worker 应写入 DUAL_TRACK');

      // 旧的兜底调用返回，不得把已经双轨入库的任务降级/改写成只有原唱。
      fallbackGate.resolve();
      const fallbackResult = await withTimeout(fallbackRun, 5000, '旧原唱兜底返回');

      const finalJob = queueWorker.getJob(jobId);
      const observed = {
        status: finalJob.status,
        importMode: finalJob.importMode,
        accompaniment: finalJob.artifacts.accompaniment?.relPath ?? null,
        library: libraryCounts(dbWorker),
      };
      assert.deepEqual(
        observed,
        {
          status: 'IMPORTED',
          importMode: 'DUAL_TRACK',
          accompaniment: workerArtifact?.relPath ?? null,
          library: { items: 1, clips: 2, sources: 1 },
        },
        `旧兜底返回 ${JSON.stringify({
          status: fallbackResult?.status,
          importMode: fallbackResult?.import_mode ?? fallbackResult?.importMode ?? null,
        })}；后到的原唱兜底不得覆盖新 worker 的双轨状态`,
      );
    } finally {
      fallbackGate.resolve();
      if (fallbackRun) await fallbackRun.catch(() => {});
      dbFallback.close();
      dbWorker.close();
    }
  });
});

test('旧 worker 租约过期时新 worker 仍在提取：旧 worker 不得提交工件或覆盖新租约', async () => {
  await withTempDir(async dir => {
    const rig = makeRig(dir);
    const { jobId } = await enqueueOne({ artistSong: 'Singer - Still Extracting Race' }, rig);

    let clock = 1_700_000_000_000;
    const now = () => clock;
    const dbOld = rig.openDb();
    const dbNew = rig.openDb();

    const oldStarted = deferred();
    const oldGate = deferred();
    const newStarted = deferred();
    const newGate = deferred();
    let oldArtifact = null;
    let newArtifact = null;
    const extractorOld = async ({ outputDir }) => {
      oldStarted.resolve();
      await oldGate.promise;
      // 故意与新 worker 使用同一文件名：若共用输出目录，晚到的旧 worker 会覆盖新文件。
      oldArtifact = writeArtifact(rig.mediaRoot, outputDir, 'accompaniment.flac', 'old-late-accompaniment');
      return oldArtifact;
    };
    const extractorNew = async ({ outputDir }) => {
      newArtifact = writeArtifact(rig.mediaRoot, outputDir, 'accompaniment.flac', 'new-still-accompaniment');
      newStarted.resolve();
      await newGate.promise;
      return newArtifact;
    };

    const open = (db, extractor) => openVocalImportQueue({
      db,
      policy: rig.policy,
      mediaRoot: rig.mediaRoot,
      extractor,
      importer: createRepertoireImporter({
        db,
        mediaRoot: rig.mediaRoot,
        policy: rig.policy,
        verifyAccompaniment: createTestAccompanimentVerifier(),
        logger: null,
      }),
      verifyAccompaniment: createTestAccompanimentVerifier(),
      leaseMs: 1000,
      workerId: 'shared-worker',
      now,
      logger: null,
    }).queue;
    const queueOld = open(dbOld, extractorOld);
    const queueNew = open(dbNew, extractorNew);

    let oldRun = null;
    let newRun = null;
    try {
      oldRun = queueOld.runOnce();
      await withTimeout(oldStarted.promise, 5000, '旧 worker 提取开始');
      const oldClaimToken = dbOld.prepare('SELECT lease_owner FROM vocal_import_jobs WHERE id=?').get(jobId).lease_owner;

      // 租约过期：新 worker 接管并进入提取，但还没完成。
      clock += 5000;
      newRun = queueNew.runOnce();
      await withTimeout(newStarted.promise, 5000, '新 worker 写出提取文件');
      const newClaim = dbNew.prepare('SELECT status,lease_owner FROM vocal_import_jobs WHERE id=?').get(jobId);
      assert.equal(newClaim.status, 'EXTRACTING');
      assert.ok(newClaim.lease_owner?.startsWith('shared-worker#'));
      assert.notEqual(oldClaimToken, newClaim.lease_owner, '新老领取必须使用不同 token');
      const newFileBeforeOld = readFileSync(join(rig.mediaRoot, newArtifact.relPath), 'utf8');

      // 旧 worker 在新 worker 已写出文件后才返回：不能覆盖新文件，也不能写工件/状态。
      oldGate.resolve();
      const oldResult = await withTimeout(oldRun, 5000, '旧 worker 提交过期结果');
      const afterOld = queueNew.getJob(jobId);
      assert.equal(afterOld.status, 'EXTRACTING', '旧 worker 不得改变新 worker 的提取中状态');
      assert.equal(afterOld.artifacts.accompaniment, undefined, '旧 worker 不得登记工件');
      assert.equal(oldResult.reason, 'STALE_CLAIM');

      const stillNewClaim = dbNew.prepare('SELECT lease_owner FROM vocal_import_jobs WHERE id=?').get(jobId).lease_owner;
      assert.equal(stillNewClaim, newClaim.lease_owner, '旧 worker 不得覆盖新 worker 的租约');

      // 新 worker 完成后必须使用自己的工件，且旧 worker 的文件不能顶替它。
      newGate.resolve();
      const newResult = await withTimeout(newRun, 5000, '新 worker 完成入库');
      assert.deepEqual({ processed: newResult.processed, status: newResult.status }, { processed: true, status: 'IMPORTED' });
      assert.ok(oldArtifact && newArtifact);
      assert.notEqual(oldArtifact.relPath, newArtifact.relPath, '并发提取必须使用独立输出路径');
      const finalJob = queueNew.getJob(jobId);
      assert.equal(finalJob.status, 'IMPORTED');
      assert.equal(finalJob.importMode, 'DUAL_TRACK');
      assert.equal(finalJob.artifacts.accompaniment.relPath, newArtifact.relPath);
      assert.equal(newFileBeforeOld, 'new-still-accompaniment');
      assert.equal(readFileSync(join(rig.mediaRoot, newArtifact.relPath), 'utf8'), 'new-still-accompaniment');
      assert.equal(readFileSync(join(rig.mediaRoot, oldArtifact.relPath), 'utf8'), 'old-late-accompaniment');
      assert.deepEqual(libraryCounts(dbNew), { items: 1, clips: 2, sources: 1 }, '旧 worker 不得重复入库');
    } finally {
      oldGate.resolve();
      newGate.resolve();
      if (oldRun) await oldRun.catch(() => {});
      if (newRun) await newRun.catch(() => {});
      dbOld.close();
      dbNew.close();
    }
  });
});
