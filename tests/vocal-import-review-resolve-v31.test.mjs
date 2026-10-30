import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db/database.mjs';
import { createSourcePolicy } from '../server/vocal-import/source-policy.mjs';
import { openVocalImportQueue } from '../server/vocal-import/queue.mjs';

/**
 * BUG-B20-002：`filename-id3-title-conflict` / `filename-id3-artist-conflict` 曾无清除路径。
 *
 * 界面文案要求用户「确认以哪个为准」，但 `resolve()` 只清歌词/伴奏类 issue，
 * 于是传了 title/artist 之后 `needsReview` 仍为真，任务永远停在 NEEDS_REVIEW，
 * 既不能提取也不能入库。这里钉住「显式指定歌名/歌手即视为消解标签冲突」。
 */

const LRC = '[00:01.00]第一句\n[00:03.50]第二句\n';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'p040-v31-review-'));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function makeQueue(dir, issues) {
  const db = openDatabase(join(dir, 'db.sqlite'));
  const mediaRoot = join(dir, 'media');
  const music = join(dir, 'music');
  mkdirSync(mediaRoot, { recursive: true });
  mkdirSync(music, { recursive: true });
  writeFileSync(join(music, 'Singer - Song.mp3'), 'source-bytes');
  writeFileSync(join(music, 'Singer - Song.lrc'), LRC);
  const policy = createSourcePolicy({ roots: [{ id: 'music', label: '临时音乐', path: music }] });
  const { queue } = openVocalImportQueue({ db, policy, mediaRoot });
  // 直接落一条待核对任务：scan 侧生成 issues 需要真实音频标签，这里只验证 resolve 的消解规则。
  db.prepare(
    `INSERT INTO vocal_import_jobs(
       id,song_id,root_id,source_rel_path,source_sha256,title,artist,language,status,stage,
       issues_json,idempotency_key,lyrics_rel_path
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'job-1',
    'song-1',
    'music',
    'Singer - Song.mp3',
    'a'.repeat(64),
    'Let Go',
    '石玺彤',
    'zh',
    'NEEDS_REVIEW',
    'MATCH',
    JSON.stringify(issues),
    'idem-1',
    'Singer - Song.lrc',
  );
  return { db, queue };
}

test('待核对：显式指定歌名即消解「文件名与标签歌名不一致」，任务回到待提取', async () => {
  await withTempDir(dir => {
    const { db, queue } = makeQueue(dir, ['audio-role-unmarked-original-assumed', 'filename-id3-title-conflict']);
    try {
      const job = queue.resolve('job-1', { title: 'Let Go' });
      assert.equal(job.status, 'PENDING_EXTRACT');
      assert.equal(job.stage, 'EXTRACT');
      assert.deepEqual(JSON.parse(job.issues_json), ['audio-role-unmarked-original-assumed']);
      assert.equal(job.title, 'Let Go');
    } finally {
      db.close();
    }
  });
});

test('待核对：显式指定歌手即消解「文件名与标签歌手不一致」', async () => {
  await withTempDir(dir => {
    const { db, queue } = makeQueue(dir, ['filename-id3-artist-conflict']);
    try {
      const job = queue.resolve('job-1', { artist: '石玺彤' });
      assert.equal(job.status, 'PENDING_EXTRACT');
      assert.deepEqual(JSON.parse(job.issues_json), []);
    } finally {
      db.close();
    }
  });
});

test('待核对：只换歌词不碰歌名时，标签冲突仍保留，任务仍待核对', async () => {
  await withTempDir(dir => {
    const { db, queue } = makeQueue(dir, ['filename-id3-title-conflict', 'lyrics-needs-confirmation']);
    try {
      const job = queue.resolve('job-1', { lyricsRelPath: 'Singer - Song.lrc' });
      assert.equal(job.status, 'NEEDS_REVIEW');
      assert.equal(job.stage, 'MATCH');
      assert.deepEqual(JSON.parse(job.issues_json), ['filename-id3-title-conflict']);
    } finally {
      db.close();
    }
  });
});
