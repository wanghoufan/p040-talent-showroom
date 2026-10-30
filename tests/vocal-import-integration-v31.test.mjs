import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
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
import { createApiServer } from '../server/index.mjs';
import { pairOwner } from '../server/requests/service.mjs';
import { saveRepertoire } from '../server/repertoire/service.mjs';
import { getRepertoire } from '../server/repertoire/service.mjs';
import { readVocalImportConfig } from '../server/vocal-import/config.mjs';
import { createSourcePolicy } from '../server/vocal-import/source-policy.mjs';
import { openVocalImportQueue } from '../server/vocal-import/queue.mjs';
import { createLocalSeparator } from '../server/vocal-import/separator.mjs';
import { createRepertoireImporter } from '../server/vocal-import/importer.mjs';
import { createVocalImportIntegration } from '../server/vocal-import/integration.mjs';
import { createTestAccompanimentVerifier } from './helpers/test-accompaniment-verifier.mjs';

const NO_PROBE = { probe: false, fingerprint: false, deep: false };
const LRC = '[ti:测试歌]\n[ar:测试歌手]\n[00:01.00]第一句\n[00:03.50]第二句\n';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'p040-v31-integration-'));
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

/** 真实子进程的假分离器：验证参数、串行锁与输出目录契约，不冒充真实模型音质。 */
function fakeSeparatorScript(dir) {
  return executable(dir, 'fake-separator.mjs', `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const args = process.argv.slice(2);
const value = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
const outputDir = value('--output_dir');
const source = args.at(-1);
appendFileSync(process.env.LOCK_LOG, 'start\\n');
await new Promise(resolve => setTimeout(resolve, 60));
if (value('--single_stem') !== 'Instrumental') process.exit(3);
writeFileSync(join(outputDir, basename(source).replace(/\\.[^.]+$/, '') + '_(Instrumental)_fake.flac'), 'fake-instrumental');
appendFileSync(process.env.LOCK_LOG, 'end\\n');
`);
}

function fakeFfprobe(dir, durationSeconds = 120) {
  return executable(dir, 'fake-ffprobe.mjs', `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ format: { duration: '${durationSeconds}', tags: {} } }));
`);
}

function makeQueue(dir, { extractor = null, importer = null, maxAttempts = 3 } = {}) {
  const db = openDatabase(join(dir, 'db.sqlite'));
  const mediaRoot = join(dir, 'media');
  const music = join(dir, 'music');
  mkdirSync(mediaRoot, { recursive: true });
  mkdirSync(music, { recursive: true });
  const policy = createSourcePolicy({ roots: [{ id: 'music', label: '临时音乐', path: music }] });
  const { queue } = openVocalImportQueue({
    db,
    policy,
    mediaRoot,
    extractor,
    importer,
    verifyAccompaniment: createTestAccompanimentVerifier(),
    maxAttempts,
    logger: null,
  });
  return { db, mediaRoot, music, policy, queue };
}

function artifactFor(mediaRoot, songId, content = 'fake-accompaniment', name = 'accompaniment.flac') {
  const absolute = join(mediaRoot, 'vocal-import', songId, name);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
  return {
    relPath: relative(mediaRoot, absolute).split(sep).join('/'),
    sha256: sha256(content),
    sizeBytes: statSync(absolute).size,
    durationMs: 120000,
    codec: 'flac',
  };
}

function publicJobFor({ songId, sourcePath, lyricsPath }) {
  const bytes = readFileSync(sourcePath);
  return {
    id: 'job-direct',
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
    lyrics: lyricsPath ? { relPath: lyricsPath, sha256: null, timedLines: 2 } : null,
    suppliedAccompaniment: null,
  };
}

test('本机分离器：真实子进程契约、输出在受控目录、并发强制为一、源只读', async () => {
  await withTempDir(async dir => {
    const mediaRoot = join(dir, 'media');
    const music = join(dir, 'music');
    mkdirSync(mediaRoot, { recursive: true });
    mkdirSync(music, { recursive: true });
    const sourceA = put(music, 'A - 歌.mp3', 'source-a');
    const sourceB = put(music, 'B - 歌.mp3', 'source-b');
    const log = join(dir, 'lock.log');
    const separator = createLocalSeparator({
      mediaRoot,
      command: fakeSeparatorScript(dir),
      model: 'test-model.ckpt',
      outputFormat: 'flac',
      ffprobeBin: fakeFfprobe(dir),
      env: { ...process.env, LOCK_LOG: log },
    });
    const outA = join(mediaRoot, 'vocal-import', 'song-a');
    const outB = join(mediaRoot, 'vocal-import', 'song-b');

    const [a, b] = await Promise.all([
      separator({ job: { songId: 'song-a' }, sourceFile: sourceA, outputDir: outA }),
      separator({ job: { songId: 'song-b' }, sourceFile: sourceB, outputDir: outB }),
    ]);

    assert.equal(readFileSync(log, 'utf8'), 'start\nend\nstart\nend\n');
    assert.deepEqual([a.relPath, b.relPath], [
      'vocal-import/song-a/A - 歌_(Instrumental)_fake.flac',
      'vocal-import/song-b/B - 歌_(Instrumental)_fake.flac',
    ]);
    assert.equal(a.durationMs, 120000);
    assert.equal(a.model, 'test-model.ckpt');
    assert.equal(a.outputFormat, 'flac');
    assert.equal(readFileSync(sourceA, 'utf8'), 'source-a');
    assert.equal(readFileSync(sourceB, 'utf8'), 'source-b');
    assert.deepEqual(
      [statSync(sourceA).size, statSync(sourceB).size],
      ['source-a'.length, 'source-b'.length],
    );
  });
});

test('本机分离器：只产出 Vocals 时拒绝，绝不把人声当伴奏', async () => {
  await withTempDir(async dir => {
    const mediaRoot = join(dir, 'media');
    const music = join(dir, 'music');
    mkdirSync(mediaRoot, { recursive: true });
    mkdirSync(music, { recursive: true });
    const source = put(music, 'V - 歌.mp3', 'source-v');
    const command = executable(dir, 'vocals-only.mjs', `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const args = process.argv.slice(2);
const outputDir = args[args.indexOf('--output_dir') + 1];
const source = args.at(-1);
writeFileSync(join(outputDir, basename(source).replace(/\\.[^.]+$/, '') + '_(Vocals)_fake.flac'), 'vocals-only');
`);
    const separator = createLocalSeparator({ mediaRoot, command, ffprobeBin: fakeFfprobe(dir) });
    await assert.rejects(
      () => separator({ job: { songId: 'vocals-only' }, sourceFile: source, outputDir: join(mediaRoot, 'vocal-import', 'vocals-only') }),
      error => error.code === 'SEPARATOR_NO_OUTPUT' && /人声轨不会被当作伴奏/.test(error.message),
    );
  });
});

test('本机分离器：模型文件不存在时明确报配置错误，不消耗重试次数', async () => {
  await withTempDir(async dir => {
    const mediaRoot = join(dir, 'media');
    const music = join(dir, 'music');
    mkdirSync(mediaRoot, { recursive: true });
    mkdirSync(music, { recursive: true });
    const source = put(music, 'M - 歌.mp3', 'source-m');
    // 超时配置非法时构造阶段就明确失败，不把错误拖到提取中途。
    assert.throws(() => createLocalSeparator({ mediaRoot, timeoutMs: 0 }), /timeoutMs/);
    const separator = createLocalSeparator({
      mediaRoot,
      command: fakeSeparatorScript(dir),
      model: join(dir, 'missing-model.ckpt'),
      ffprobeBin: fakeFfprobe(dir),
      env: { ...process.env, LOCK_LOG: join(dir, 'lock.log') },
    });
    await assert.rejects(
      () => separator({ job: { songId: 'missing-model' }, sourceFile: source, outputDir: join(mediaRoot, 'vocal-import', 'missing-model') }),
      error => error.code === 'SEPARATOR_NOT_CONFIGURED' && /模型文件不存在/.test(error.message) && error.status === 503,
    );
  });
});

test('本机分离器未安装：任务退回待提取，不计失败次数', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, policy } = makeQueue(dir);
    put(music, 'AAA - 待提取.mp3', 'audio');
    const separator = createLocalSeparator({ mediaRoot, command: 'p040-separator-not-installed' });
    const queue = openVocalImportQueue({
      db,
      policy,
      mediaRoot,
      extractor: separator,
      verifyAccompaniment: createTestAccompanimentVerifier(),
      logger: null,
    }).queue;
    try {
      await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const result = await queue.runOnce();
      assert.equal(result.reason, 'SEPARATOR_NOT_CONFIGURED');
      const job = queue.getJob(result.jobId);
      assert.equal(job.status, 'PENDING_EXTRACT');
      assert.equal(job.attempts, 0);
      assert.equal(job.error.code, 'SEPARATOR_NOT_CONFIGURED');
    } finally {
      db.close();
    }
  });
});

test('队列→本机分离器→曲库入库：同 songId 双轨、歌词保留、源不变、幂等', async () => {
  await withTempDir(async dir => {
    const music = join(dir, 'music');
    mkdirSync(music, { recursive: true });
    const sourcePath = put(music, '3LAU, Carly Paige - Touch.mp3', '原唱字节');
    put(music, '3LAU,Carly Paige - Touch.lrc', LRC);
    const sourceBytes = readFileSync(sourcePath);
    const sourceHash = sha256(sourceBytes);

    const { db, mediaRoot, policy } = makeQueue(dir);
    const separator = createLocalSeparator({
      mediaRoot,
      command: fakeSeparatorScript(dir),
      ffprobeBin: fakeFfprobe(dir),
      env: { ...process.env, LOCK_LOG: join(dir, 'lock.log') },
    });
    const importer = createRepertoireImporter({ db, mediaRoot, policy, verifyAccompaniment: createTestAccompanimentVerifier() });
    const { queue } = openVocalImportQueue({
      db,
      policy,
      mediaRoot,
      extractor: separator,
      importer,
      verifyAccompaniment: createTestAccompanimentVerifier(),
      logger: null,
    });
    try {
      const enqueued = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      assert.equal(enqueued.created.length, 1);
      const jobId = enqueued.created[0];
      const run = await queue.runOnce();
      assert.equal(run.status, 'IMPORTED');

      const job = queue.getJob(jobId);
      assert.equal(job.status, 'IMPORTED');
      assert.ok(job.events.some(event => event.event === 'imported' && event.status === 'IMPORTED'));

      const item = getRepertoire(db, job.songId);
      assert.equal(item.id, job.songId);
      assert.equal(item.kind, 'VOCAL');
      assert.equal(item.title, 'Touch');
      assert.equal(item.artist, '3LAU, Carly Paige');
      assert.equal(item.language, 'zh');
      assert.ok(item.tracks.original?.media?.id);
      assert.ok(item.tracks.accompaniment?.media?.id);
      assert.notEqual(item.tracks.original.media.id, item.tracks.accompaniment.media.id);
      assert.equal(item.tracks.original.media.sha256, sourceHash);
      assert.equal(item.lyrics.length, 2);
      assert.deepEqual(item.lyrics.map(line => line.text), ['第一句', '第二句']);
      assert.equal(db.prepare("SELECT count(*) AS n FROM repertoire_items WHERE kind='VOCAL'").get().n, 1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM source_media').get().n, 1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, 2);

      // 源目录只读：原始文件内容、大小、SHA 全部不变。
      assert.deepEqual(readFileSync(sourcePath), sourceBytes);
      assert.equal(sha256(readFileSync(sourcePath)), sourceHash);

      // 已入库任务不会被再次处理，不会重复创建曲目。
      assert.equal((await queue.runOnce()).reason, 'EMPTY');
      assert.equal(db.prepare("SELECT count(*) AS n FROM repertoire_items WHERE kind='VOCAL'").get().n, 1);
    } finally {
      db.close();
    }
  });
});

test('入库适配器：不覆盖人工歌词/结构，已有伴奏不被新伴奏替换', async () => {
  await withTempDir(async dir => {
    const music = join(dir, 'music');
    mkdirSync(music, { recursive: true });
    const sourcePath = put(music, 'Singer - Song.mp3', 'manual-source');
    put(music, 'Singer - Song.lrc', LRC);
    const { db, mediaRoot, policy } = makeQueue(dir);
    const songId = '11111111-1111-5111-8111-111111111111';

    saveRepertoire(db, null, {
      clientId: songId,
      kind: 'VOCAL',
      title: '人工标题',
      artist: '人工歌手',
      language: 'zh',
      lyrics: [{ id: 'manual-line', startMs: 1000, text: '人工歌词' }],
      sections: [{ id: 'manual-section', type: 'verse', label: '主歌', startMs: 0, endMs: 60000, source: 'manual' }],
    });

    const importer = createRepertoireImporter({ db, mediaRoot, policy, verifyAccompaniment: createTestAccompanimentVerifier() });
    const job = publicJobFor({ songId, sourcePath, lyricsPath: 'Singer - Song.lrc' });
    const firstArtifact = artifactFor(mediaRoot, songId, 'first-accompaniment');

    await importer({ job, artifact: firstArtifact });
    const first = getRepertoire(db, songId);
    assert.deepEqual(first.lyrics.map(line => line.text), ['人工歌词']);
    assert.equal(first.sections.length, 1);
    assert.equal(first.sections[0].id, 'manual-section');
    assert.equal(first.title, '人工标题');
    assert.equal(db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, 2);

    // 同一工件再次入库：不新增媒体、不改歌词。
    await importer({ job, artifact: firstArtifact });
    assert.equal(db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, 2);
    assert.deepEqual(getRepertoire(db, songId).lyrics.map(line => line.text), ['人工歌词']);

    // 已有伴奏时，新伴奏版本不得静默替换：标记冲突，旧音轨与人工内容保持。
    const secondArtifact = artifactFor(mediaRoot, songId, 'second-accompaniment', 'second-accompaniment.flac');
    const secondResult = await importer({ job, artifact: secondArtifact });
    assert.equal(secondResult.status, 'CONFLICT_ACCOMPANIMENT');
    assert.equal(secondResult.existingAccompanimentClipId, first.tracks.accompaniment.media.id);
    const second = getRepertoire(db, songId);
    assert.equal(db.prepare("SELECT count(*) AS n FROM repertoire_items WHERE kind='VOCAL'").get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, 2);
    assert.equal(second.tracks.accompaniment.media.id, first.tracks.accompaniment.media.id);
    assert.equal(second.tracks.original.media.id, first.tracks.original.media.id);
    assert.deepEqual(second.lyrics.map(line => line.text), ['人工歌词']);
    assert.equal(second.sections.length, 1);
    assert.equal(second.sections[0].id, 'manual-section');
    assert.equal(readFileSync(sourcePath, 'utf8'), 'manual-source');
  });
});

test('入库适配器：不同 songId 但源 SHA 相同，并入既有曲目而不新建第二张卡片', async () => {
  await withTempDir(async dir => {
    const music = join(dir, 'music');
    mkdirSync(music, { recursive: true });
    const sourcePath = put(music, 'Singer - Same.mp3', 'same-source');
    put(music, 'Singer - Same.lrc', LRC);
    const { db, mediaRoot, policy } = makeQueue(dir);
    const importer = createRepertoireImporter({ db, mediaRoot, policy, verifyAccompaniment: createTestAccompanimentVerifier() });
    const songId = '33333333-3333-5333-8333-333333333333';
    const otherSongId = '44444444-4444-5444-8444-444444444444';
    const sourceSha = sha256(readFileSync(sourcePath));

    // 既有曲目只登记同一份源音频、没有伴奏：允许并入，不新建第二张卡片。
    db.prepare(
      'INSERT INTO source_media(id,source_kind,source_locator,internal_path,sha256,duration_ms,audio_codec,video_codec,container) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run('existing-source', 'AUDIO', null, 'existing/source.mp3', sourceSha, 120000, 'mp3', null, null);
    db.prepare("INSERT INTO repertoire_items(id,kind,title,artist,source_media_id) VALUES(?,?,?,?,?)").run(
      songId,
      'VOCAL',
      '既有标题',
      '既有歌手',
      'existing-source',
    );

    const second = await importer({
      job: { ...publicJobFor({ songId: otherSongId, sourcePath, lyricsPath: 'Singer - Same.lrc' }) },
      artifact: artifactFor(mediaRoot, otherSongId, 'same-2'),
    });
    assert.equal(second.repertoireId, songId);
    assert.equal(second.status, 'MERGED');
    assert.equal(db.prepare("SELECT count(*) AS n FROM repertoire_items WHERE kind='VOCAL'").get().n, 1);
    assert.equal(getRepertoire(db, otherSongId), null);
    assert.equal(getRepertoire(db, songId).tracks.accompaniment.media.id, second.accompanimentClipId);
    assert.equal(getRepertoire(db, songId).title, '既有标题');
  });
});

test('队列恢复：校验完成→入库之间重启，只补跑入库，不重新提取', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, policy, queue } = makeQueue(dir);
    put(music, 'Restart - Song.mp3', 'restart-source');
    const importer = createRepertoireImporter({ db, mediaRoot, policy, verifyAccompaniment: createTestAccompanimentVerifier() });
    let extractionCalls = 0;
    const extractor = async () => {
      extractionCalls += 1;
      throw new Error('不应重新提取');
    };
    try {
      const enqueued = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const jobId = enqueued.created[0];
      const songId = enqueued.jobs[0].songId;
      db.prepare('UPDATE vocal_import_jobs SET source_duration_ms=120000 WHERE id=?').run(jobId);
      const row = db.prepare('SELECT * FROM vocal_import_jobs WHERE id=?').get(jobId);
      const artifact = artifactFor(mediaRoot, songId, 'resume-accompaniment');

      // 模拟：提取已完成、校验通过但进程在入库前退出，租约已清空。
      db.prepare("UPDATE vocal_import_jobs SET status='VERIFYING',stage='VERIFY',artifacts_json=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?").run(JSON.stringify({ accompaniment: artifact }), jobId);
      assert.equal(row.source_sha256, sha256(readFileSync(join(music, 'Restart - Song.mp3'))));

      const reopened = openVocalImportQueue({
        db,
        policy,
        mediaRoot,
        extractor,
        importer: async () => {
          throw Object.assign(new Error('数据库暂时不可用'), { code: 'DB_BUSY' });
        },
        verifyAccompaniment: createTestAccompanimentVerifier(),
        logger: null,
      });
      // 进程重启时会发现“租约已空但仍在校验中”的任务，恢复它但不重算已完成阶段。
      assert.equal(reopened.recovered, 1);
      const failed = await reopened.queue.runOnce();
      assert.equal(failed.reason, 'DB_BUSY');
      assert.equal(extractionCalls, 0);
      const afterFail = reopened.queue.getJob(jobId);
      assert.equal(afterFail.status, 'VERIFYING');
      assert.equal(afterFail.attempts, 1);

      // 等退避窗口过去后用正常入库器重跑：仍不重新提取，只补跑入库。
      db.prepare('UPDATE vocal_import_jobs SET lease_expires_at=1 WHERE id=?').run(jobId);
      const recovered = openVocalImportQueue({
      db,
      policy,
      mediaRoot,
      extractor,
      importer,
      verifyAccompaniment: createTestAccompanimentVerifier(),
      logger: null,
    });
      assert.equal(recovered.recovered, 1);
      const result = await recovered.queue.runOnce();
      assert.equal(result.status, 'IMPORTED');
      assert.equal(extractionCalls, 0);
      const job = recovered.queue.getJob(jobId);
      assert.equal(job.status, 'IMPORTED');
      assert.ok(job.events.some(event => event.event === 'imported' && event.detail.resumed === true));
      assert.equal(getRepertoire(db, songId).tracks.accompaniment.media.id !== undefined, true);
    } finally {
      db.close();
    }
  });
});

test('HTTP：V3.1 路由继承现有配对鉴权，绝对路径被拒，不泄露本机路径', async () => {
  await withTempDir(async dir => {
    const music = join(dir, 'music');
    mkdirSync(music, { recursive: true });
    put(music, 'AAA - HTTP.mp3', 'http-audio');
    put(music, 'AAA - HTTP.lrc', LRC);
    const db = openDatabase(join(dir, 'db.sqlite'));
    const mediaRoot = join(dir, 'media');
    mkdirSync(mediaRoot, { recursive: true });
    const { token } = pairOwner(db, 'pair-code', 'pair-code');
    const integration = createVocalImportIntegration({
      db,
      mediaRoot,
      config: {
        roots: [{ id: 'music', label: '临时音乐', path: music }],
        worker: false,
        separator: { command: 'p040-separator-not-installed' },
      },
      logger: null,
    });
    const server = createApiServer({ db, mediaRoot, vocalImport: integration });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const auth = { Authorization: `Bearer ${token}` };
    try {
      const unauthorized = await fetch(`${base}/api/vocal-import/roots`);
      assert.equal(unauthorized.status, 401);

      const roots = await fetch(`${base}/api/vocal-import/roots`, { headers: auth });
      assert.equal(roots.status, 200);
      const rootsBody = await roots.json();
      assert.deepEqual(rootsBody.roots, [{ id: 'music', label: '临时音乐', available: true }]);
      assert.equal(JSON.stringify(rootsBody).includes(music), false);

      const absolute = await fetch(`${base}/api/vocal-import/scan`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: music }),
      });
      assert.equal(absolute.status, 403);
      assert.equal((await absolute.json()).error.code, 'PATH_NOT_ALLOWED');

      const scan = await fetch(`${base}/api/vocal-import/scan`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootId: 'music' }),
      });
      assert.equal(scan.status, 202);
      const scanBody = await scan.json();
      assert.equal(scanBody.created, 1);
      assert.equal(JSON.stringify(scanBody).includes(music), false);

      const jobs = await fetch(`${base}/api/vocal-import/jobs`, { headers: auth });
      assert.equal(jobs.status, 200);
      const jobsBody = await jobs.json();
      assert.equal(jobsBody.jobs.length, 1);
      assert.equal(JSON.stringify(jobsBody).includes(music), false);

      const detail = await fetch(`${base}/api/vocal-import/jobs/${jobsBody.jobs[0].id}`, { headers: auth });
      assert.equal(detail.status, 200);
      assert.equal(JSON.stringify(await detail.json()).includes(music), false);

      // 现有路由不被吞掉。
      const catalog = await fetch(`${base}/api/catalog`, { headers: auth });
      assert.equal(catalog.status, 200);
    } finally {
      await new Promise(resolve => server.close(resolve));
      db.close();
    }
  });
});

test('HTTP：设备未配对时 V3.1 接口也必须 401，不能暴露本机目录能力', async () => {
  await withTempDir(async dir => {
    const music = join(dir, 'music');
    mkdirSync(music, { recursive: true });
    put(music, 'U - Song.mp3', 'unauth-audio');
    const db = openDatabase(join(dir, 'db.sqlite'));
    const mediaRoot = join(dir, 'media');
    mkdirSync(mediaRoot, { recursive: true });
    const integration = createVocalImportIntegration({
      db,
      mediaRoot,
      config: {
        roots: [{ id: 'music', label: '临时音乐', path: music }],
        worker: false,
        separator: { command: 'p040-separator-not-installed' },
      },
      logger: null,
    });
    const server = createApiServer({ db, mediaRoot, vocalImport: integration });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal((await fetch(`${base}/api/vocal-import/roots`)).status, 401);
      const scan = await fetch(`${base}/api/vocal-import/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootId: 'music' }),
      });
      assert.equal(scan.status, 401);
      assert.equal((await scan.json()).error.code, 'UNAUTHORIZED');
      // 未配对不能扫描，队列里也不应出现任务。
      const jobs = db.prepare('SELECT count(*) AS n FROM vocal_import_jobs').get().n;
      assert.equal(jobs, 0);
      // 其它公开接口不受影响，配对入口仍然可用。
      assert.equal((await fetch(`${base}/api/health`)).status, 200);
    } finally {
      await new Promise(resolve => server.close(resolve));
      db.close();
    }
  });
});

test('取消：校验阶段收到取消不再入库，任务停在 CANCELLED', async () => {
  await withTempDir(async dir => {
    const { db, mediaRoot, music, queue } = makeQueue(dir);
    put(music, 'Cancel - Verify.mp3', 'cancel-source');
    put(music, 'Cancel - Verify.lrc', LRC);
    try {
      const enqueued = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const jobId = enqueued.created[0];
      const songId = enqueued.jobs[0].songId;
      const artifact = artifactFor(mediaRoot, songId, 'cancel-accompaniment');
      db.prepare(
        "UPDATE vocal_import_jobs SET status='VERIFYING',stage='VERIFY',source_duration_ms=120000,artifacts_json=?,cancel_requested=0,lease_owner=NULL,lease_expires_at=NULL WHERE id=?",
      ).run(JSON.stringify({ accompaniment: artifact }), jobId);

      // 先领取任务并开始校验，再在“校验中”阶段收到取消，覆盖领取后取消的路径。
      const pending = queue.runOnce();
      db.prepare('UPDATE vocal_import_jobs SET cancel_requested=1 WHERE id=?').run(jobId);
      const result = await pending;
      assert.equal(result.reason, 'CANCELLED');
      const job = queue.getJob(jobId);
      assert.equal(job.status, 'CANCELLED');
      assert.equal(job.cancelRequested, true);
      assert.ok(job.events.some(event => event.event === 'cancelled' && event.status === 'CANCELLED'));
      assert.equal(db.prepare("SELECT count(*) AS n FROM repertoire_items WHERE kind='VOCAL'").get().n, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, 0);
    } finally {
      db.close();
    }
  });
});

test('运行配置：白名单根来自环境变量，缺省不挂载接口', () => {
  const empty = readVocalImportConfig({});
  assert.deepEqual(empty.roots, []);
  assert.equal(empty.worker, false);

  const single = readVocalImportConfig({
    VOCAL_IMPORT_ROOT_PATH: '/tmp/p040-music',
    VOCAL_IMPORT_ROOT_ID: 'music',
    VOCAL_IMPORT_ROOT_LABEL: '本机音乐',
    VOCAL_IMPORT_WORKER: '1',
    VOCAL_IMPORT_SEPARATOR_CMD: 'audio-separator',
    VOCAL_IMPORT_MODEL: 'model.ckpt',
  });
  assert.deepEqual(single.roots, [{ id: 'music', label: '本机音乐', path: '/tmp/p040-music' }]);
  assert.equal(single.worker, true);
  assert.equal(single.separator.model, 'model.ckpt');

  assert.throws(() => readVocalImportConfig({ VOCAL_IMPORT_ROOTS: 'not-json' }), /JSON/);
  assert.equal(existsSync('/tmp/p040-music'), false);
});
