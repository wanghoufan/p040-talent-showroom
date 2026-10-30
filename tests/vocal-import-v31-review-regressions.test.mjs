import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDatabase } from '../server/db/database.mjs';
import { createSourcePolicy } from '../server/vocal-import/source-policy.mjs';
import { openVocalImportQueue } from '../server/vocal-import/queue.mjs';
import { createRepertoireImporter } from '../server/vocal-import/importer.mjs';
import { songIdForAudioSha } from '../server/vocal-import/uuid5.mjs';
import { createTestAccompanimentVerifier } from './helpers/test-accompaniment-verifier.mjs';

/**
 * P040 V3.1 当前审查 P2 回归（定向，不跑全量）：
 * 1. 历史“只有旧伴奏、没有原唱”的曲目，遇到同一伴奏内容时不得直接标成 DUAL_TRACK；
 * 2. READY_TO_IMPORT 的自带伴奏在重扫后消失/变歧义，不能继续卡在不可领取状态。
 *
 * 边界：独立临时目录 + 临时 SQLite + 假校验器；不读写真实曲库、不调用真实 ffmpeg/分离模型。
 */

const NO_PROBE = { probe: false, fingerprint: false, deep: false };
const LRC = '[ti:审查回归]\n[ar:测试歌手]\n[00:01.00]第一句\n';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'p040-v31-review-'));
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

function makeRig(dir) {
  const db = openDatabase(join(dir, 'db.sqlite'));
  const mediaRoot = join(dir, 'media');
  const music = join(dir, 'music');
  mkdirSync(mediaRoot, { recursive: true });
  mkdirSync(music, { recursive: true });
  const policy = createSourcePolicy({ roots: [{ id: 'music', label: '临时音乐', path: music }] });
  const verifier = createTestAccompanimentVerifier();
  const importer = createRepertoireImporter({ db, mediaRoot, policy, verifyAccompaniment: verifier });
  const open = (options = {}) => openVocalImportQueue({
    db,
    policy,
    mediaRoot,
    importer,
    verifyAccompaniment: verifier,
    extractor: null,
    logger: null,
    ...options,
  }).queue;
  return { dir, db, mediaRoot, music, policy, importer, open };
}

test('P2-1 历史只有旧伴奏：同内容伴奏不得谎报 DUAL_TRACK，必须补上原唱', async () => {
  await withTempDir(async dir => {
    const rig = makeRig(dir);
    const originalBytes = Buffer.from('REVIEW-ORIGINAL-AUDIO');
    const accompanimentBytes = Buffer.from('REVIEW-LEGACY-ACCOMPANIMENT');
    put(rig.music, 'A - B.mp3', originalBytes);
    put(rig.music, 'A - B.lrc', LRC);
    put(rig.music, 'A - B 伴奏.mp3', accompanimentBytes);

    const songId = songIdForAudioSha(sha256(originalBytes));
    const sourceId = randomUUID();
    rig.db.prepare(
      'INSERT INTO source_media(id,source_kind,source_locator,internal_path,sha256,duration_ms,audio_codec) VALUES(?,?,?,?,?,?,?)',
    ).run(sourceId, 'AUDIO', 'legacy', 'legacy/acc.mp3', sha256(originalBytes), 120000, 'mp3');
    const legacyClip = join(rig.mediaRoot, 'legacy', 'acc.mp3');
    put(rig.mediaRoot, 'legacy/acc.mp3', accompanimentBytes);
    const clipId = randomUUID();
    rig.db.prepare(
      'INSERT INTO performance_clips(id,source_media_id,start_ms,end_ms,internal_audio_path,codec,source_preserving,sha256,size_bytes,duration_ms,version) VALUES(?,?,?,?,?,?,?,?,?,?,1)',
    ).run(clipId, sourceId, 0, 120000, 'legacy/acc.mp3', 'mp3', 0, sha256(accompanimentBytes), statSync(legacyClip).size, 120000);
    rig.db.prepare(
      "INSERT INTO repertoire_items(id,kind,title,artist,learning_status,audio_role,source_media_id,performance_clip_id,original_clip_id,accompaniment_clip_id) VALUES(?,'VOCAL','A - B','','WANT_TO_LEARN','ACCOMPANIMENT',?,?,NULL,NULL)",
    ).run(songId, sourceId, clipId);

    const queue = rig.open();
    try {
      const enqueued = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      assert.equal(enqueued.created.length, 1);
      const jobId = enqueued.created[0];
      rig.db.prepare('UPDATE vocal_import_jobs SET source_duration_ms=120000 WHERE id=?').run(jobId);
      const run = await queue.runOnce();
      assert.deepEqual({ processed: run.processed, status: run.status }, { processed: true, status: 'IMPORTED' });

      const job = queue.getJob(jobId);
      const item = rig.db.prepare(
        'SELECT original_clip_id,accompaniment_clip_id,performance_clip_id FROM repertoire_items WHERE id=?',
      ).get(songId);
      assert.equal(job.importMode, 'DUAL_TRACK');
      assert.ok(item.original_clip_id, '必须补上原唱轨，不能只有旧伴奏');
      assert.equal(item.accompaniment_clip_id, clipId, '同内容的旧伴奏应复用，不新增重复伴奏');
      assert.equal(item.performance_clip_id, clipId, '旧单轨只解绑/复用，不应被删除');
      assert.equal(rig.db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, 2);
    } finally {
      rig.db.close();
    }
  });
});

test('P2-2 READY_TO_IMPORT 的自带伴奏重扫后消失：不得继续停在不可领取状态', async () => {
  await withTempDir(async dir => {
    const rig = makeRig(dir);
    put(rig.music, 'C - D.mp3', 'REVIEW-ORIGINAL-C');
    put(rig.music, 'C - D.lrc', LRC);
    const supplied = put(rig.music, 'C - D 伴奏.mp3', 'REVIEW-ACCOMPANIMENT-C');
    const queue = rig.open();
    try {
      const first = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      assert.equal(first.created.length, 1);
      const jobId = first.created[0];
      const before = queue.getJob(jobId);
      assert.deepEqual(
        { status: before.status, stage: before.stage, supplied: before.suppliedAccompaniment },
        { status: 'READY_TO_IMPORT', stage: 'VERIFY', supplied: 'C - D 伴奏.mp3' },
      );

      unlinkSync(supplied);
      await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const after = queue.getJob(jobId);
      assert.equal(after.suppliedAccompaniment, null);
      assert.notEqual(after.status, 'READY_TO_IMPORT', '伴奏消失后不得保留 READY_TO_IMPORT');
      assert.equal(after.stage, 'EXTRACT');
      assert.equal(after.status, 'PENDING_EXTRACT');
      assert.ok(queue.claimNext({ owner: 'review-regression' }), '回退后必须能被 worker 领取，不能卡死');
    } finally {
      rig.db.close();
    }
  });
});

test('P2-2 READY_TO_IMPORT 的自带伴奏重扫后变歧义：退回可人工核对状态', async () => {
  await withTempDir(async dir => {
    const rig = makeRig(dir);
    put(rig.music, 'E - F.mp3', 'REVIEW-ORIGINAL-E');
    put(rig.music, 'E - F.lrc', LRC);
    put(rig.music, 'E - F 伴奏.mp3', 'REVIEW-ACCOMPANIMENT-E1');
    const queue = rig.open();
    try {
      const first = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      assert.equal(first.created.length, 1);
      const jobId = first.created[0];
      assert.equal(queue.getJob(jobId).status, 'READY_TO_IMPORT');

      put(rig.music, 'E - F 伴奏 (1).mp3', 'REVIEW-ACCOMPANIMENT-E2');
      await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const after = queue.getJob(jobId);
      assert.equal(after.suppliedAccompaniment, null);
      assert.notEqual(after.status, 'READY_TO_IMPORT', '歧义后不得保留不可领取的 READY_TO_IMPORT');
      assert.deepEqual({ status: after.status, stage: after.stage }, { status: 'NEEDS_REVIEW', stage: 'MATCH' });
      assert.ok(after.issues.includes('multiple-accompaniment-candidates'));
    } finally {
      rig.db.close();
    }
  });
});
