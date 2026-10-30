import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
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
import { getRepertoire, saveRepertoire } from '../server/repertoire/service.mjs';
import { createSourcePolicy } from '../server/vocal-import/source-policy.mjs';
import { openVocalImportQueue } from '../server/vocal-import/queue.mjs';
import { createRepertoireImporter } from '../server/vocal-import/importer.mjs';
import { createTestAccompanimentVerifier } from './helpers/test-accompaniment-verifier.mjs';

const NO_PROBE = { probe: false, fingerprint: false, deep: false };
const LRC = '[ti:测试歌]\n[ar:测试歌手]\n[00:01.00]第一句\n[00:03.50]第二句\n';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'p040-v31-conflict-'));
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
  return { db, mediaRoot, music, policy, importer };
}

function jobFor({ songId, sourcePath, lyricsName = null }) {
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
      durationMs: 120000,
    },
    lyrics: lyricsName ? { relPath: lyricsName, sha256: null, timedLines: 2 } : null,
    suppliedAccompaniment: null,
  };
}

/** 生成受控目录里的真实伴奏文件；name 可区分新旧两版，避免测试自己覆盖旧文件。 */
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

/** 直接落一条真实音轨（真实文件 + source_media + performance_clips），模拟旧版已有数据。 */
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

function seedItem(db, {
  id,
  title = '旧曲',
  audioRole = 'REFERENCE',
  performance = null,
  original = null,
  accompaniment = null,
  lyrics = [],
  sections = [],
}) {
  saveRepertoire(db, null, { clientId: id, kind: 'VOCAL', title, language: 'zh', lyrics, sections });
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

const OLD_LYRICS = [{ id: 'manual-line', startMs: 1000, text: '人工歌词' }];
const OLD_SECTIONS = [{ id: 'manual-section', type: 'verse', label: '主歌', startMs: 0, endMs: 60000, source: 'manual' }];

test('已有伴奏：AI 新伴奏不静默替换，保留旧轨与全部原始文件', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, importer } = makeEnv(dir);
    try {
      const sourcePath = put(music, 'Singer - Song.mp3', 'source-bytes');
      const songId = '11111111-1111-5111-8111-111111111111';
      const job = jobFor({ songId, sourcePath });

      const first = await importer({ job, artifact: artifactFor(mediaRoot, songId, 'user-accompaniment') });
      assert.equal(first.status, 'CREATED');

      const before = getRepertoire(db, songId);
      const oldAccId = before.tracks.accompaniment.media.id;
      const oldOriginalId = before.tracks.original.media.id;
      const oldAcc = db.prepare('SELECT * FROM performance_clips WHERE id=?').get(oldAccId);
      const oldAccPath = join(mediaRoot, oldAcc.internal_audio_path);
      const oldAccBytes = readFileSync(oldAccPath);
      const oldOriginal = db.prepare('SELECT * FROM performance_clips WHERE id=?').get(oldOriginalId);
      const oldOriginalPath = join(mediaRoot, oldOriginal.internal_audio_path);
      const oldOriginalBytes = readFileSync(oldOriginalPath);
      const clipCount = db.prepare('SELECT count(*) AS n FROM performance_clips').get().n;

      // 新提取结果换了文件名，模拟“新伴奏另存一份”而不是覆盖旧文件。
      const next = await importer({
        job,
        artifact: artifactFor(mediaRoot, songId, 'ai-new-accompaniment', 'ai-new.flac'),
      });
      assert.equal(next.status, 'CONFLICT_ACCOMPANIMENT');
      assert.equal(next.repertoireId, songId);
      assert.equal(next.existingAccompanimentClipId, oldAccId);

      const after = getRepertoire(db, songId);
      assert.equal(after.tracks.accompaniment.media.id, oldAccId);
      assert.equal(after.tracks.original.media.id, oldOriginalId);
      assert.equal(after.audioRole, before.audioRole);
      // 新伴奏没有登记成新音轨，旧伴奏指针不变。
      assert.equal(db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, clipCount);
      // 旧伴奏/旧原唱文件一个字节都没动，新工件文件也保留在受控目录里。
      assert.deepEqual(readFileSync(oldAccPath), oldAccBytes);
      assert.deepEqual(readFileSync(oldOriginalPath), oldOriginalBytes);
      assert.ok(existsSync(join(mediaRoot, 'vocal-import', songId, 'ai-new.flac')));
    } finally {
      db.close();
    }
  });
});

test('旧 audioRole=ACCOMPANIMENT 单轨：识别为已有伴奏并阻止替换，REFERENCE 旧轨不误判', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, importer } = makeEnv(dir);
    try {
      const sourcePath = put(music, 'Legacy - Song.mp3', 'legacy-source');

      // A. 旧单轨 audioRole=ACCOMPANIMENT：必须当成已有伴奏，拒绝新伴奏。
      const accompanimentSongId = '22222222-2222-5222-8222-222222222222';
      const legacyAccompaniment = insertTrack(db, mediaRoot, {
        relPath: 'legacy/accompaniment.mp3',
        content: 'legacy-accompaniment',
      });
      seedItem(db, {
        id: accompanimentSongId,
        title: '旧伴奏曲',
        audioRole: 'ACCOMPANIMENT',
        performance: legacyAccompaniment,
      });
      const accompanimentJob = jobFor({ songId: accompanimentSongId, sourcePath });
      const blocked = await importer({
        job: accompanimentJob,
        artifact: artifactFor(mediaRoot, accompanimentSongId, 'ai-accompaniment'),
      });
      assert.equal(blocked.status, 'CONFLICT_ACCOMPANIMENT');
      assert.equal(blocked.existingAccompanimentClipId, legacyAccompaniment.clipId);
      const legacyRow = db.prepare('SELECT * FROM repertoire_items WHERE id=?').get(accompanimentSongId);
      assert.equal(legacyRow.performance_clip_id, legacyAccompaniment.clipId);
      assert.equal(legacyRow.accompaniment_clip_id, null);
      assert.equal(legacyRow.audio_role, 'ACCOMPANIMENT');
      assert.equal(readFileSync(legacyAccompaniment.absolute).toString(), legacyAccompaniment.content);

      // B. 旧单轨 audioRole=REFERENCE 是原唱，不是伴奏：可以合并新伴奏，旧轨与角色保持不变。
      const referenceSongId = '33333333-3333-5333-8333-333333333333';
      const legacyReference = insertTrack(db, mediaRoot, {
        relPath: 'legacy/original.mp3',
        content: 'legacy-original',
      });
      seedItem(db, {
        id: referenceSongId,
        title: '旧原唱曲',
        audioRole: 'REFERENCE',
        performance: legacyReference,
      });
      const merged = await importer({
        job: jobFor({ songId: referenceSongId, sourcePath }),
        artifact: artifactFor(mediaRoot, referenceSongId, 'new-accompaniment'),
      });
      assert.equal(merged.status, 'MERGED');
      const referenceRow = db.prepare('SELECT * FROM repertoire_items WHERE id=?').get(referenceSongId);
      assert.equal(referenceRow.performance_clip_id, legacyReference.clipId);
      assert.equal(referenceRow.audio_role, 'REFERENCE');
      assert.equal(referenceRow.accompaniment_clip_id, merged.accompanimentClipId);
      assert.equal(readFileSync(legacyReference.absolute).toString(), legacyReference.content);
    } finally {
      db.close();
    }
  });
});

test('无现有伴奏才合并：保留原唱/歌词/结构，新曲与重跑保持幂等', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, importer } = makeEnv(dir);
    try {
      const sourcePath = put(music, 'Manual - Song.mp3', 'manual-source');
      put(music, 'Manual - Song.lrc', LRC);

      // 已有原唱轨、人工歌词与结构，但没有伴奏。
      const songId = '44444444-4444-5444-8444-444444444444';
      const existingOriginal = insertTrack(db, mediaRoot, {
        relPath: 'manual/original.mp3',
        content: 'manual-original',
      });
      seedItem(db, {
        id: songId,
        title: '人工标题',
        audioRole: 'REFERENCE',
        performance: existingOriginal,
        original: existingOriginal,
        lyrics: OLD_LYRICS,
        sections: OLD_SECTIONS,
      });

      const job = jobFor({ songId, sourcePath, lyricsName: 'Manual - Song.lrc' });
      const merged = await importer({ job, artifact: artifactFor(mediaRoot, songId, 'ai-accompaniment') });
      assert.equal(merged.status, 'MERGED');

      const item = getRepertoire(db, songId);
      assert.equal(item.tracks.original.media.id, existingOriginal.clipId);
      assert.ok(item.tracks.accompaniment.media.id);
      assert.equal(item.title, '人工标题');
      assert.deepEqual(item.lyrics.map(line => line.text), ['人工歌词']);
      assert.deepEqual(item.sections.map(section => section.id), ['manual-section']);
      assert.equal(readFileSync(existingOriginal.absolute).toString(), existingOriginal.content);

      // 同一工件重跑：幂等，不新增音轨、不改人工内容。
      const clipCount = db.prepare('SELECT count(*) AS n FROM performance_clips').get().n;
      const again = await importer({ job, artifact: artifactFor(mediaRoot, songId, 'ai-accompaniment') });
      assert.equal(again.status, 'UNCHANGED');
      assert.equal(db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, clipCount);
      assert.deepEqual(getRepertoire(db, songId).lyrics.map(line => line.text), ['人工歌词']);

      // 新曲仍然正常创建。
      const newSongId = '55555555-5555-5555-8555-555555555555';
      const created = await importer({
        job: jobFor({ songId: newSongId, sourcePath }),
        artifact: artifactFor(mediaRoot, newSongId, 'fresh-accompaniment'),
      });
      assert.equal(created.status, 'CREATED');
      const createdAgain = await importer({
        job: jobFor({ songId: newSongId, sourcePath }),
        artifact: artifactFor(mediaRoot, newSongId, 'fresh-accompaniment'),
      });
      assert.equal(createdAgain.status, 'UNCHANGED');
      assert.equal(db.prepare("SELECT count(*) AS n FROM repertoire_items WHERE id=?").get(newSongId).n, 1);
    } finally {
      db.close();
    }
  });
});

test('队列：已有伴奏时不重新分离，任务标记待核对，恢复/重扫/重试都不无限重跑', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, policy, importer } = makeEnv(dir);
    let extractionCalls = 0;
    const extractor = async ({ job, outputDir }) => {
      extractionCalls += 1;
      const absolute = join(outputDir, 'accompaniment.flac');
      const content = Buffer.from(`ai:${job.songId}`);
      writeFileSync(absolute, content);
      return {
        relPath: relative(mediaRoot, absolute).split(sep).join('/'),
        sha256: sha256(content),
        sizeBytes: statSync(absolute).size,
        durationMs: 120000,
        codec: 'flac',
      };
    };
    const open = () =>
      openVocalImportQueue({
        db,
        policy,
        mediaRoot,
        extractor,
        importer,
        verifyAccompaniment: createTestAccompanimentVerifier(),
        logger: null,
      });
    const { queue } = open();
    try {
      put(music, 'Queue - Song.mp3', 'queue-source');
      const enqueued = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const jobId = enqueued.created[0];
      const songId = enqueued.jobs[0].songId;

      // 用户在曲库里已经有一条真实伴奏。
      const existing = insertTrack(db, mediaRoot, {
        relPath: 'user/own-accompaniment.mp3',
        content: 'owner-accompaniment',
      });
      seedItem(db, {
        id: songId,
        title: '已有伴奏',
        audioRole: 'ACCOMPANIMENT',
        original: insertTrack(db, mediaRoot, { relPath: 'user/own-original.mp3', content: 'owner-original' }),
        accompaniment: existing,
      });

      const result = await queue.runOnce();
      assert.equal(result.status, 'NEEDS_REVIEW');
      assert.equal(result.reason, 'ACCOMPANIMENT_CONFLICT');
      assert.equal(extractionCalls, 0, '已有伴奏时不得重新分离，避免覆盖旧文件');

      let job = queue.getJob(jobId);
      assert.equal(job.status, 'NEEDS_REVIEW');
      assert.equal(job.stage, 'IMPORT');
      assert.equal(job.error.code, 'ACCOMPANIMENT_CONFLICT');
      assert.ok(job.issues.includes('existing-accompaniment-conflict'));
      assert.ok(job.events.some(event => event.event === 'needs-review' && event.status === 'NEEDS_REVIEW'));
      assert.ok(!job.events.some(event => event.event === 'imported'));
      assert.equal(readFileSync(existing.absolute).toString(), existing.content);
      assert.equal(getRepertoire(db, songId).tracks.accompaniment.media.id, existing.clipId);

      // 恢复、重启、重扫都不得把它变回待提取而反复分离。
      assert.equal(queue.recover(), 0);
      const reopened = open();
      assert.equal(reopened.recovered, 0);
      assert.equal((await reopened.queue.runOnce()).reason, 'EMPTY');
      const rescanned = await reopened.queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      assert.equal(rescanned.created.length, 0);
      assert.equal(reopened.queue.getJob(jobId).status, 'NEEDS_REVIEW');
      assert.equal(extractionCalls, 0);

      // 用户点击重试：仍先检查已有伴奏，不进入分离阶段。
      const retried = reopened.queue.retry(jobId);
      assert.equal(retried.status, 'PENDING_EXTRACT');
      assert.equal((await reopened.queue.runOnce()).status, 'NEEDS_REVIEW');
      assert.equal(extractionCalls, 0);
      job = reopened.queue.getJob(jobId);
      assert.equal(job.status, 'NEEDS_REVIEW');
      assert.ok(job.issues.includes('existing-accompaniment-conflict'));
    } finally {
      db.close();
    }
  });
});
