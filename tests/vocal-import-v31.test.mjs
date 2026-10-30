import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { openDatabase } from '../server/db/database.mjs';
import {
  artistKey, canonical, detectLanguage, nameIdentity, versionLabels,
} from '../server/vocal-import/canonical.mjs';
import { parseLrcText } from '../server/vocal-import/lrc.mjs';
import { probeAudio } from '../server/vocal-import/probe.mjs';
import { createTestAccompanimentVerifier } from './helpers/test-accompaniment-verifier.mjs';
import { songIdForAudioSha, uuid5, VOCAL_IMPORT_NAMESPACE } from '../server/vocal-import/uuid5.mjs';
import { createSourcePolicy } from '../server/vocal-import/source-policy.mjs';
import { scanSource } from '../server/vocal-import/scan.mjs';
import { openVocalImportQueue } from '../server/vocal-import/queue.mjs';
import { mountVocalImportRoutes } from '../server/vocal-import/routes.mjs';
import { buildSections } from '../server/vocal-import/sections.mjs';

const NO_PROBE = { probe: false, fingerprint: false, deep: false };
const LRC_TOUCH = '[ti:Touch]\n[ar:3LAU, Carly Paige]\n[00:01.20]No talk\n[00:04.500]seven days\n';
const LRC_MIDS = '[00:02.00]Midsummer\n[00:05.25]Madness\n';
const LRC_BAOSHI = '[00:01.00]爱的恰恰\n[00:03.50]恰恰\n';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'p040-v31-'));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function put(dir, name, content) {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

/** 合成一批与真实审计同名的文件；只用临时目录，不读任何真实音乐。 */
function seedRealNames(dir) {
  put(dir, '3LAU, Carly Paige - Touch.mp3', 'audio-touch');
  put(dir, '3LAU,Carly Paige - Touch.lrc', LRC_TOUCH);

  put(dir, '4MINUTE - 미쳐.mp3', 'audio-korean');
  put(dir, '4MINUTE - 미쳐.lrc', '[00:01.00]미쳐\n[00:02.50]미쳐\n');

  put(dir, '5 Seconds of Summer - Teeth.mp3', 'audio-teeth');
  put(dir, '5 Seconds of Summer - Teeth.lrc', '[00:01.00]Teeth\n[00:03.00]Teeth\n');

  put(dir, '88rising, Joji, Rich Brian, AUGUST 08 - Midsummer Madness.mp3', 'audio-midsummer');
  put(dir, '88rising,Joji,Rich Brian - Midsummer Madness.lrc', LRC_MIDS);

  put(dir, '8D Tunes - Mood (8D Audio).mp3', 'audio-8d');
  put(dir, '8D Tunes - Mood (8D Audio).lrc', '[ti:Mood]\n无时间戳歌词\n');
  put(dir, '8D Tunes - Mood.mp3', 'audio-mood-plain');

  put(dir, '宝石Gem,俞天时,王洋EVIS - 爱的恰恰.mp3', 'audio-baoshi-a');
  put(dir, '宝石Gem,俞天时,王洋EVIS - 爱的恰恰 (1).mp3', 'audio-baoshi-b');
  put(dir, '宝石Gem,俞天时,王洋EVIS - 爱的恰恰.lrc', LRC_BAOSHI);
  put(dir, '宝石Gem,俞天时,王洋EVIS - 爱的恰恰 (1).lrc', LRC_BAOSHI);

  put(dir, '陈从雨xiaoyu0,石玺彤 - senorita（翻自 Shawn Mendes）.mp3', 'audio-cover');
  put(dir, '陈从雨xiaoyu0,石玺彤 - senorita（翻自 Shawn Mendes）.lrc', '[00:01.00]senorita\n');
}

async function scanSeed(dir, options = NO_PROBE) {
  const policy = createSourcePolicy({ roots: [{ id: 'music', label: '临时音乐', path: dir }] });
  const scan = await scanSource({ policy, rootId: 'music', options });
  return { policy, scan };
}

test('uuid5 与计划包 Python 端完全一致，songId 由音频 SHA 决定', () => {
  assert.equal(
    uuid5(VOCAL_IMPORT_NAMESPACE, 'b76193882e06503df3438c45567e22d8c07c71f9acb2a4cb565eb04a26c24cee'),
    '78fcc0fd-ee50-508e-a170-3e09e6fedc1f',
  );
  assert.equal(uuid5(VOCAL_IMPORT_NAMESPACE, 'abc'), '50a79674-63d8-500c-8f0b-7f3ecd3a7eaa');
  assert.equal(
    songIdForAudioSha('b76193882e06503df3438c45567e22d8c07c71f9acb2a4cb565eb04a26c24cee'),
    '78fcc0fd-ee50-508e-a170-3e09e6fedc1f',
  );
});

test('文件名归一：逗号空格、全角括号、副本后缀、版本隔离', () => {
  // T01：逗号后空格不同，仍属同一首。
  assert.equal(
    nameIdentity('3LAU, Carly Paige - Touch.mp3').key,
    nameIdentity('3LAU,Carly Paige - Touch.lrc').key,
  );
  // T08：全角括号归一为半角，且不丢翻唱标识。
  const cover = nameIdentity('陈从雨xiaoyu0,石玺彤 - senorita（翻自 Shawn Mendes）.mp3');
  assert.equal(cover.title, 'senorita (翻自 Shawn Mendes)');
  assert.deepEqual(versionLabels(cover.base), ['翻自']);
  // (1) 是副本后缀，不是版本。
  assert.equal(nameIdentity('爱的恰恰 (1).mp3').copyNumber, '1');
  assert.equal(nameIdentity('爱的恰恰 (1).mp3').key, nameIdentity('爱的恰恰.mp3').key);
  // (8D Audio) 是版本，必须保留；歌手叫 8D Tunes 不代表普通版也是 8D。
  const eightD = nameIdentity('8D Tunes - Mood (8D Audio).mp3');
  assert.deepEqual(eightD.versions, ['8d audio']);
  assert.notEqual(eightD.key, nameIdentity('8D Tunes - Mood.mp3').key);
  assert.deepEqual(nameIdentity('8D Tunes - Mood.mp3').versions, []);
  assert.deepEqual(nameIdentity('Live Tunes - Normal Song.mp3').versions, []);
  // 全角/半角括号等价。
  assert.equal(canonical('（Live）'), canonical('(Live)'));
});

test('ID3 交叉核验：歌手分隔符与全角括号差异不算冲突', () => {
  // 真实审计里 ID3 用 `/`，文件名用 `,`；T01/T02 不能因此被误判待核对。
  assert.equal(artistKey('3LAU/Carly Paige'), artistKey('3LAU, Carly Paige'));
  assert.equal(artistKey('2Someone/Lanfranchi/Farina'), artistKey('2Someone, Lanfranchi, Farina'));
  assert.equal(artistKey('Farina/2Someone/Lanfranchi'), artistKey('2Someone, Lanfranchi, Farina'));
  // T05 的 ID3 比文件名多出两位合作歌手：保持冲突，不静默视为相同。
  assert.notEqual(
    artistKey('宝石Gem/俞天时/王洋EVIS/YYKBZ/Yoken_Official'),
    artistKey('宝石Gem,俞天时,王洋EVIS'),
  );
  // T08 的 ID3 标题是原始全角括号，文件名归一后不能变成“标题冲突”。
  assert.equal(
    canonical('senorita（翻自 Shawn Mendes）'),
    canonical('senorita (翻自 Shawn Mendes)'),
  );
  assert.equal(nameIdentity('senorita（翻自 Shawn Mendes）.mp3').titleKey, canonical('senorita (翻自 Shawn Mendes)'));
});

test('语言判定只输出 zh/en/ko，日文假名不臆造枚举值', () => {
  // V3.1 重写后只读歌词正文（见 tests/vocal-import-lang-detect-v31.test.mjs），故这里喂内联 LRC。
  assert.equal(detectLanguage({ lyrics: '[00:01.00]미쳐\n[00:02.50]미쳐' }), 'ko');
  assert.equal(detectLanguage({ lyrics: '[00:01.00]爱的恰恰\n[00:03.50]恰恰' }), 'zh');
  assert.equal(detectLanguage({ lyrics: '[00:01.00]No talk\n[00:04.50]seven days' }), 'en');
  assert.equal(detectLanguage({ lyrics: '[00:01.00]夜に駆ける' }), null);
  // 元数据不再参与判定：只有歌名/歌手时返回 null，不猜。
  assert.equal(detectLanguage({ title: '4MINUTE - 미쳐' }), null);
});

test('语言判定剔除 LRC 中文署名行（BUG-V31-QA-004）', () => {
  // 网易云等来源把「作词/作曲」写进歌词，英文歌曾因此被判成 zh。
  const lyrics = '作词 : Carly Paige\n作曲 : 3LAU\n[00:05.00]Touch me like nobody else';
  assert.equal(detectLanguage({ title: 'Touch', artist: '3LAU', lyrics }), 'en');
  // V3.1：署名行剔除后没有可用歌词行 → null。旧断言期望回退歌名判 en，
  // 但“中文歌手唱英文歌”正是回退元数据造成的误判源，改为明确不猜。
  assert.equal(detectLanguage({ title: 'Touch', lyrics: '作词 : 某某\n作曲 : 某某' }), null);
  // 真中文歌词不受影响，署名行剔除后仍判 zh。
  assert.equal(detectLanguage({ title: '爱的恰恰', lyrics: '作词 : 某某\n[00:03.00]我的心上人' }), 'zh');
  assert.equal(detectLanguage({ title: 'Dumhdurum', artist: 'APINK', lyrics: '作词 : 某某' }), null);
  // 真实样本：网易云逐字歌词把署名写进 tx 字段，整行是 JSON。
  const karaoke = '{"t":0,"c":[{"tx":"作词: "},{"tx":"Justin Blau"},{"tx":"/"},{"tx":"Carly Paige"}]}\n'
    + '{"t":335,"c":[{"tx":"作曲: "},{"tx":"Carly Paige"}]}\n'
    + '{"t":5000,"c":[{"tx":"No talk, seven days"}]}';
  assert.equal(detectLanguage({ title: 'Touch', artist: '3LAU', lyrics: karaoke }), 'en');
});

test('LRC：BOM、多标签同句、三位毫秒、offset、无时戳与非法秒数', () => {
  const lrc = parseLrcText(
    '\uFEFF[ti:测试]\n[offset:-500]\n[00:01.20][00:02.30]同一句\n[00:03.456]第三句\n[00:05.00]\n[00:75.00]坏秒数\n[乱码标签]\n纯文本行\n',
  );
  assert.equal(lrc.metadata.ti, '测试');
  assert.equal(lrc.timedLines.length, 3);
  // LRC 惯例：正 offset 让歌词提前。与服务端入库及 src/lib/vocal.ts 的
  // `startMs = rawMs - offsetMs` 同向；offset=-500 时每句延后 500ms。
  assert.deepEqual(lrc.timedLines.map(line => line.startMs), [1700, 2800, 3956]);
  assert.ok(lrc.timedLines.every(line => line.text === '同一句' || line.text === '第三句'));
  assert.equal(lrc.invalidTags, 2); // 坏秒数 + 未知标签
  assert.equal(lrc.hasTiming, true);
  assert.deepEqual(lrc.plainLines, ['纯文本行']);

  const plain = parseLrcText('[ti:Mood]\n无时间戳歌词\n');
  assert.equal(plain.hasTiming, false);
  assert.equal(plain.maxStartMs, null);

  // 位宽容忍度与客户端一致：秒可 1-2 位，分钟可 1-4 位。
  const loose = parseLrcText('[0:5]短秒\n[1000:00]超长分钟\n');
  assert.deepEqual(loose.timedLines.map(line => line.startMs), [5000, 60000000]);
});

test('扫描：真实审计同名的 7 组用例（自动配对 / 待核对 / 8D 隔离 / 同名不同 SHA）', async () => {
  await withTempDir(async dir => {
    seedRealNames(dir);
    const { scan } = await scanSeed(dir);
    const byTitle = new Map(scan.songs.map(song => [song.title, song]));

    // T01 自动配对
    const touch = scan.songs.find(song => song.original.includes('3LAU'));
    assert.equal(touch.lyrics, '3LAU,Carly Paige - Touch.lrc');
    assert.equal(touch.status, 'ready-to-extract');
    assert.equal(touch.language, 'en');

    // T03 韩文无乱码
    const korean = scan.songs.find(song => song.original.includes('4MINUTE'));
    assert.equal(korean.language, 'ko');
    assert.equal(korean.status, 'ready-to-extract');

    // T07 歌手列表不同：只给候选，必须待核对
    const midsummer = scan.songs.find(song => song.original.includes('88rising'));
    assert.equal(midsummer.lyrics, null);
    assert.ok(midsummer.issues.includes('lyrics-needs-confirmation'));
    assert.equal(midsummer.lyricsProposal, '88rising,Joji,Rich Brian - Midsummer Madness.lrc');
    assert.equal(midsummer.status, 'needs-review');

    // T06 8D：版本保留；无时间戳不伪造同步
    const eightD = byTitle.get('Mood (8D Audio)');
    assert.deepEqual(eightD.versions, ['8d audio']);
    assert.ok(eightD.issues.includes('lyrics-no-timestamps'));
    assert.equal(eightD.status, 'ready-to-extract');
    // 普通版本不得盲配 8D 歌词
    const plainMood = byTitle.get('Mood');
    assert.equal(plainMood.lyrics, null);
    assert.ok(plainMood.issues.includes('missing-lyrics'));

    // T05 同名不同 SHA：保留两个版本，进待核对，不静默合并
    const baoshi = scan.songs.filter(song => song.title === '爱的恰恰');
    assert.equal(baoshi.length, 2);
    assert.notEqual(baoshi[0].songId, baoshi[1].songId);
    assert.ok(baoshi.every(song => song.issues.includes('same-title-different-audio-review')));
    assert.ok(baoshi.every(song => song.status === 'needs-review'));
    // 两份完全相同的 LRC 只算重复，不算歧义
    assert.equal(scan.duplicateLyrics.length, 1);
    assert.ok(scan.songs.every(song => song.lyrics !== '宝石Gem,俞天时,王洋EVIS - 爱的恰恰 (1).lrc'));

    // T08 全角括号的翻唱版本仍被识别为独立版本
    const cover = scan.songs.find(song => song.original.includes('senorita'));
    assert.deepEqual(cover.versions, ['翻自']);

    assert.equal(scan.summary.audioFiles, 9);
    assert.equal(scan.summary.duplicates, 0);
    // 输出不泄露本机绝对路径
    assert.equal(JSON.stringify(scan).includes(dir), false);
  });
});

test('扫描：完全重复的音频按 SHA 去重，只保留一个主文件并报告别名', async () => {
  await withTempDir(async dir => {
    put(dir, '重复歌.mp3', 'same-bytes');
    put(dir, '重复歌 (1).mp3', 'same-bytes');
    put(dir, '重复歌.lrc', '[00:01.00]line\n');
    const { scan } = await scanSeed(dir);
    assert.equal(scan.songs.length, 1);
    assert.equal(scan.songs[0].original, '重复歌.mp3');
    assert.deepEqual(scan.duplicateFiles.map(item => item.duplicate), ['重复歌 (1).mp3']);
  });
});

test('扫描：单个坏文件只记录并跳过，不阻断其它歌曲', async () => {
  await withTempDir(async dir => {
    put(dir, 'good-a.mp3', 'good-a');
    put(dir, 'good-a.lrc', '[00:01.00]a\n');
    put(dir, 'good-b.mp3', 'good-b');
    put(dir, 'good-b.lrc', '[00:01.00]b\n');
    const bad = put(dir, 'broken.mp3', 'broken');
    chmodSync(bad, 0o000);
    try {
      const { scan } = await scanSeed(dir);
      assert.equal(scan.songs.length, 2);
      assert.deepEqual(scan.songs.map(song => song.title).sort(), ['good-a', 'good-b']);
      assert.equal(scan.summary.audioFiles, 2);
      assert.equal(scan.summary.unreadableFiles, 1);
      assert.equal(scan.unreadableFiles.length, 1);
      assert.equal(scan.unreadableFiles[0].relPath, 'broken.mp3');
      assert.equal(scan.unreadableFiles[0].code, 'EACCES');
      // 坏文件也不得把本机目录泄露到扫描结果里。
      assert.equal(JSON.stringify(scan).includes(dir), false);
    } finally {
      chmodSync(bad, 0o600);
    }
  });
});

test('路径安全：拒绝绝对路径、..、符号链接与白名单外 rootId', async () => {
  await withTempDir(async dir => {
    const outside = join(dir, '..', `outside-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    const root = join(dir, 'root');
    mkdirSync(root, { recursive: true });
    put(root, 'normal.mp3', 'audio');
    symlinkSync(join(outside, 'escaped.mp3'), join(root, 'link.mp3'));
    symlinkSync(outside, join(root, 'linkdir'));
    writeFileSync(join(outside, 'escaped.mp3'), 'audio-outside');
    try {
      const policy = createSourcePolicy({ roots: [{ id: 'music', path: root }] });
      assert.throws(() => policy.resolveRoot('music', '/etc'), { code: 'PATH_NOT_ALLOWED' });
      assert.throws(() => policy.resolveRoot('music', '../outside'), { code: 'PATH_NOT_ALLOWED' });
      assert.throws(() => policy.resolveRoot('music', 'linkdir'), { code: 'PATH_NOT_ALLOWED' });
      assert.throws(() => policy.resolveFile('music', 'link.mp3'), { code: 'PATH_NOT_ALLOWED' });
      assert.throws(() => policy.resolveRoot('unknown'), { code: 'ROOT_NOT_FOUND' });
      assert.deepEqual(policy.listRoots(), [{ id: 'music', label: 'music', available: true }]);
      assert.equal(JSON.stringify(policy.listRoots()).includes(root), false);

      // 扫描完全不跟随符号链接
      const scan = await scanSource({ policy, rootId: 'music', options: NO_PROBE });
      assert.equal(scan.summary.audioFiles, 1);
      assert.equal(scan.songs[0].original, 'normal.mp3');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

function makeQueue(dir, { extractor = null, importer = null, maxAttempts = 3 } = {}) {
  const db = openDatabase(join(dir, 'db.sqlite'));
  const mediaRoot = join(dir, 'media');
  mkdirSync(mediaRoot, { recursive: true });
  const policy = createSourcePolicy({ roots: [{ id: 'music', path: join(dir, 'music') }] });
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
  return { db, mediaRoot, policy, queue };
}

const fakeExtractor = mediaRoot => async ({ job, outputDir }) => {
  const target = join(outputDir, 'accompaniment.flac');
  const content = Buffer.from(`fake-instrumental:${job.songId}`);
  writeFileSync(target, content);
  return {
    relPath: relative(mediaRoot, target).split(sep).join('/'),
    sha256: createHash('sha256').update(content).digest('hex'),
    sizeBytes: statSync(target).size,
  };
};

test('队列：迁移就绪、幂等入队、无提取器时不伪造完成', async () => {
  await withTempDir(async dir => {
    mkdirSync(join(dir, 'music'), { recursive: true });
    seedRealNames(join(dir, 'music'));
    const { db, queue } = makeQueue(dir);
    try {
      const first = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      assert.ok(first.created.length >= 8);
      assert.equal(first.reused.length, 0);
      assert.equal(first.scan.summary.audioFiles, 9);

      const second = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      assert.equal(second.created.length, 0);
      assert.equal(second.reused.length, first.created.length);
      assert.equal(db.prepare('SELECT count(*) AS n FROM vocal_import_jobs').get().n, first.created.length);

      const pending = queue.listJobs({ status: 'PENDING_EXTRACT' });
      assert.ok(pending.length > 0);
      const result = await queue.runOnce();
      assert.equal(result.reason, 'EXTRACTOR_NOT_CONFIGURED');
      const stillPending = queue.getJob(result.jobId);
      assert.equal(stillPending.status, 'PENDING_EXTRACT');
      assert.equal(stillPending.attempts, 0);
      assert.equal(stillPending.error.code, 'EXTRACTOR_NOT_CONFIGURED');
    } finally {
      db.close();
    }
  });
});

test('队列：提取→校验→待入库，重复处理不产生重影，且不写生产曲库', async () => {
  await withTempDir(async dir => {
    mkdirSync(join(dir, 'music'), { recursive: true });
    put(join(dir, 'music'), '3LAU, Carly Paige - Touch.mp3', 'audio-touch');
    put(join(dir, 'music'), '3LAU,Carly Paige - Touch.lrc', LRC_TOUCH);
    const { db, mediaRoot, queue } = makeQueue(dir);
    try {
      const before = db.prepare('SELECT count(*) AS n FROM repertoire_items').get().n;
      await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const run = await queue.runOnce({ }); // 提取器稍后注入，先确认未配置行为
      assert.equal(run.reason, 'EXTRACTOR_NOT_CONFIGURED');

      // 注入真实（假）提取器后重跑
      const queue2 = openVocalImportQueue({
        db,
        policy: createSourcePolicy({ roots: [{ id: 'music', path: join(dir, 'music') }] }),
        mediaRoot,
        extractor: fakeExtractor(mediaRoot),
        verifyAccompaniment: createTestAccompanimentVerifier(),
        logger: null,
      }).queue;
      const done = await queue2.runOnce();
      assert.equal(done.processed, true);
      const job = queue2.getJob(done.jobId);
      assert.equal(job.status, 'READY_TO_IMPORT');
      assert.ok(job.artifacts.accompaniment.relPath.endsWith('accompaniment.flac'));
      assert.equal(job.artifactRows.length, 1);
      assert.ok(job.events.length >= 3);
      assert.equal(db.prepare('SELECT count(*) AS n FROM repertoire_items').get().n, before);
      assert.equal(db.prepare('SELECT count(*) AS n FROM performance_clips').get().n, 0);
      // 再跑一次不会重复处理同一任务
      const again = await queue2.runOnce();
      assert.equal(again.reason, 'EMPTY');
    } finally {
      db.close();
    }
  });
});

test('队列：一首失败不阻断其余；重试只重跑失败阶段；取消生效', async () => {
  await withTempDir(async dir => {
    mkdirSync(join(dir, 'music'), { recursive: true });
    put(join(dir, 'music'), 'AAA - 坏的.mp3', 'audio-bad');
    put(join(dir, 'music'), 'BBB - 好的.mp3', 'audio-good');
    const { db, mediaRoot, queue } = makeQueue(dir, {
      maxAttempts: 1,
      extractor: async payload => {
        if (payload.job.title === '坏的') throw Object.assign(new Error('模型进程退出'), { code: 'MODEL_CRASH' });
        return fakeExtractor(mediaRoot)(payload);
      },
    });
    try {
      await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const results = [await queue.runOnce(), await queue.runOnce(), await queue.runOnce()];
      const statuses = queue.listJobs().map(job => job.status).sort();
      assert.deepEqual(statuses, ['FAILED', 'READY_TO_IMPORT']);
      const failed = queue.listJobs({ status: 'FAILED' })[0];
      assert.equal(failed.error.code, 'MODEL_CRASH');
      assert.equal(failed.attempts, 1);
      assert.ok(results.some(result => result.reason === 'MODEL_CRASH'));

      const retried = queue.retry(failed.id);
      assert.equal(retried.status, 'PENDING_EXTRACT');
      assert.equal(retried.attempts, 0);
      assert.equal(retried.last_error_code, null);

      const cancelled = queue.cancel(retried.id);
      assert.equal(cancelled.status, 'CANCELLED');
      assert.equal((await queue.runOnce()).reason, 'EMPTY');
    } finally {
      db.close();
    }
  });
});

test('队列：重启用租约恢复，不重算已完成阶段、不计失败', async () => {
  await withTempDir(async dir => {
    mkdirSync(join(dir, 'music'), { recursive: true });
    put(join(dir, 'music'), 'CCC - 恢复.mp3', 'audio-recover');
    const { db, queue } = makeQueue(dir);
    try {
      await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const job = queue.listJobs()[0];
      // 模拟进程在提取中被杀：租约过期
      db.prepare("UPDATE vocal_import_jobs SET status='EXTRACTING',stage='EXTRACT',lease_owner='dead',lease_expires_at=1 WHERE id=?").run(job.id);
      const recovered = queue.recover();
      assert.equal(recovered, 1);
      const after = queue.getJob(job.id);
      assert.equal(after.status, 'PENDING_EXTRACT');
      assert.equal(after.attempts, 0);
      assert.ok(after.events.some(event => event.event === 'recovered'));
    } finally {
      db.close();
    }
  });
});

test('队列：人工核对只接受本次扫描候选，非法相对路径被拒绝', async () => {
  await withTempDir(async dir => {
    mkdirSync(join(dir, 'music'), { recursive: true });
    put(join(dir, 'music'), '88rising, Joji, Rich Brian, AUGUST 08 - Midsummer Madness.mp3', 'audio-midsummer');
    put(join(dir, 'music'), '88rising,Joji,Rich Brian - Midsummer Madness.lrc', LRC_MIDS);
    const { db, queue } = makeQueue(dir);
    try {
      await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const job = queue.listJobs()[0];
      assert.equal(job.status, 'NEEDS_REVIEW');
      assert.throws(
        () => queue.resolve(job.id, { lyricsRelPath: '../../etc/passwd' }),
        { code: 'PATH_NOT_ALLOWED' },
      );
      const resolved = queue.resolve(job.id, { lyricsRelPath: '88rising,Joji,Rich Brian - Midsummer Madness.lrc' });
      assert.equal(resolved.status, 'PENDING_EXTRACT');
      assert.equal(queue.getJob(job.id).lyrics.relPath, '88rising,Joji,Rich Brian - Midsummer Madness.lrc');
    } finally {
      db.close();
    }
  });
});

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

test('路由：不接受绝对路径、只回显 rootId、未授权 401、扫描入队 202', async () => {
  await withTempDir(async dir => {
    const music = join(dir, 'music');
    mkdirSync(music, { recursive: true });
    put(music, '3LAU, Carly Paige - Touch.mp3', 'audio-touch');
    put(music, '3LAU,Carly Paige - Touch.lrc', LRC_TOUCH);
    const { db, queue } = makeQueue(dir);
    const policy = createSourcePolicy({ roots: [{ id: 'music', label: '临时', path: music }] });
    try {
      const handler = mountVocalImportRoutes({ policy, queue, authorize: () => true });
      await withHttpServer(handler, async base => {
        const roots = await (await fetch(`${base}/api/vocal-import/roots`)).json();
        assert.deepEqual(roots.roots, [{ id: 'music', label: '临时', available: true }]);

        const absolute = await fetch(`${base}/api/vocal-import/scan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '/Users' }),
        });
        assert.equal(absolute.status, 403);
        assert.equal((await absolute.json()).error.code, 'PATH_NOT_ALLOWED');

        const traversal = await fetch(`${base}/api/vocal-import/scan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rootId: 'music', subPath: '../..' }),
        });
        assert.equal(traversal.status, 403);

        const scan = await fetch(`${base}/api/vocal-import/scan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rootId: 'music' }),
        });
        assert.equal(scan.status, 202);
        const payload = await scan.json();
        assert.equal(payload.created, 1);
        assert.equal(JSON.stringify(payload).includes(music), false);

        const folderField = await fetch(`${base}/api/vocal-import/scan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rootId: 'music', folder: '/Users' }),
        });
        assert.equal(folderField.status, 403);
        assert.equal((await folderField.json()).error.code, 'PATH_NOT_ALLOWED');

        const jobs = await (await fetch(`${base}/api/vocal-import/jobs`)).json();
        assert.equal(jobs.jobs.length, 1);
        const jobId = jobs.jobs[0].id;
        const detail = await (await fetch(`${base}/api/vocal-import/jobs/${jobId}`)).json();
        assert.equal(detail.songId, jobs.jobs[0].songId);
        assert.equal(detail.original.relPath, '3LAU, Carly Paige - Touch.mp3');

        // 路由扫描默认开启 ffprobe；测试用的是文本假音频，会被如实标成 invalid-audio，
        // 所以这里得到“待核对”而不是“处理中”。
        assert.equal(detail.status, 'NEEDS_REVIEW');
        const busy = await fetch(`${base}/api/vocal-import/jobs/${jobId}/retry`, { method: 'POST' });
        assert.equal(busy.status, 409);
        assert.equal((await busy.json()).error.code, 'CONFLICT');

        const cancelled = await (await fetch(`${base}/api/vocal-import/jobs/${jobId}/cancel`, { method: 'POST' })).json();
        assert.equal(cancelled.status, 'CANCELLED');
        const retried = await (await fetch(`${base}/api/vocal-import/jobs/${jobId}/retry`, { method: 'POST' })).json();
        assert.equal(retried.status, 'PENDING_EXTRACT');

        const badStatus = await fetch(`${base}/api/vocal-import/jobs?status=BOGUS`);
        assert.equal(badStatus.status, 400);
        const missing = await fetch(`${base}/api/vocal-import/jobs/00000000-0000-4000-8000-000000000000`);
        assert.equal(missing.status, 404);
      });

      const guarded = mountVocalImportRoutes({ policy, queue, authorize: () => false });
      await withHttpServer(guarded, async base => {
        assert.equal((await fetch(`${base}/api/vocal-import/roots`)).status, 401);
      });

      // 非本前缀的请求必须交给后续路由，不被吞掉
      const passthrough = await handler({ method: 'GET', headers: {} }, { writeHead() {}, end() {} }, new URL('http://x/api/catalog'), {});
      assert.equal(passthrough, false);
    } finally {
      db.close();
    }
  });
});

/** 构造假的 ffprobe/ffmpeg 可执行脚本：不依赖本机是否安装 ffmpeg，也不读真实音频。 */
function makeFakeTools(dir) {
  const binDir = join(dir, 'fake-bin');
  mkdirSync(binDir, { recursive: true });
  const ffprobe = join(binDir, 'ffprobe');
  const ffmpeg = join(binDir, 'ffmpeg');
  writeFileSync(
    ffprobe,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const file = args[args.length - 1] || '';
const base = file.split('/').pop();
const tags = {};
// 真实审计里 ID3 用斜杠分隔多歌手；用文件名触发，验证不会被误判成冲突。
if (base.includes('Touch')) Object.assign(tags, { artist: '3LAU/Carly Paige', title: 'Touch' });
if (base.includes('标签冲突')) Object.assign(tags, { artist: '别人', title: '别的歌' });
process.stdout.write(JSON.stringify({ format: { duration: '10.0', tags } }));
`,
  );
  writeFileSync(
    ffmpeg,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const i = args.indexOf('-i');
const file = i >= 0 ? args[i + 1] : '';
const base = (file || '').split('/').pop();
const rate = 8000;
if (args.includes('-t')) {
  // 指纹阶段：同一首音频（哪怕封面不同）必须给出完全相同的 PCM，其它歌各自不同。
  const crypto = require('node:crypto');
  const seed = base.includes('封面不同') ? 'cover-pair' : base;
  const digest = crypto.createHash('sha256').update(seed).digest();
  const pcm = Buffer.alloc(rate * 2 * 3);
  for (let offset = 0; offset < pcm.length; offset += digest.length) digest.copy(pcm, offset);
  process.stdout.write(pcm);
  process.exit(0);
}
let bytes = rate * 2 * 10;
let error = '';
if (base.includes('尾部损坏')) { bytes = Math.round(rate * 2 * 9.9); error = 'Error submitting packet to decoder: Invalid data found'; }
if (base.includes('整段损坏')) { bytes = rate * 2 * 5; error = 'Error submitting packet to decoder: Invalid data found'; }
process.stdout.write(Buffer.alloc(bytes, 0));
if (error) { process.stderr.write(error + '\\n'); process.exitCode = 1; }
`,
  );
  execFileSync('chmod', ['755', ffprobe, ffmpeg]);
  return { ffprobe, ffmpeg };
}

test('探测：按真实审计把尾部少量损坏与整段损坏分开，PCM 相同但封装不同只提示核对', async () => {
  await withTempDir(async dir => {
    const tools = makeFakeTools(dir);
    put(dir, '尾部损坏 - 歌.mp3', 'audio-tail');
    put(dir, '尾部损坏 - 歌.lrc', '[00:01.00]tail line\n');
    put(dir, '整段损坏 - 歌.mp3', 'audio-damaged');
    put(dir, '整段损坏 - 歌.lrc', '[00:01.00]damaged line\n');
    put(dir, '完好 - 歌.mp3', 'audio-good');
    put(dir, '完好 - 歌.lrc', '[00:01.00]good line\n');
    // T05/T08 现实：两个文件字节不同、时长相同、仅内嵌封面不同。
    put(dir, '封面不同 - 同一首.mp3', 'audio-cover-a');
    put(dir, '封面不同 - 同一首 (1).mp3', 'audio-cover-b');

    const policy = createSourcePolicy({ roots: [{ id: 'music', path: dir }] });
    const scan = await scanSource({
      policy,
      rootId: 'music',
      // 不显式传 deep：真实扫描默认就要整轨解码，验证缺省值本身包含损坏检测。
      options: {
        probe: true,
        fingerprint: true,
        probeOptions: { ffprobeBin: tools.ffprobe, ffmpegBin: tools.ffmpeg },
      },
    });

    const tail = scan.songs.find(song => song.original.includes('尾部损坏'));
    assert.equal(tail.decode.state, 'tail-truncated');
    assert.equal(tail.decode.coverageRatio, 0.99);
    assert.equal(tail.decode.fullyDecoded, false);
    assert.ok(tail.issues.includes('audio-tail-truncated'));
    // 尾部少量损坏不阻断自动提取（AC08）。
    assert.equal(tail.status, 'ready-to-extract');

    const damaged = scan.songs.find(song => song.original.includes('整段损坏'));
    assert.equal(damaged.decode.state, 'damaged');
    assert.equal(damaged.decode.coverageRatio, 0.5);
    assert.ok(damaged.issues.includes('audio-damaged'));
    assert.equal(damaged.status, 'ready-to-extract');

    const good = scan.songs.find(song => song.original.includes('完好'));
    assert.equal(good.decode.state, 'ok');
    assert.equal(good.decode.fullyDecoded, true);

    const covers = scan.songs.filter(song => song.original.includes('封面不同'));
    assert.equal(covers.length, 2);
    assert.notEqual(covers[0].originalHash, covers[1].originalHash);
    assert.equal(covers[0].pcmFingerprint, covers[1].pcmFingerprint);
    assert.equal(scan.pcmDuplicateGroups.length, 1);
    assert.equal(scan.pcmDuplicateGroups[0].note, 'same-pcm-different-container-or-cover');
    assert.deepEqual(
      scan.pcmDuplicateGroups[0].files.map(file => file.relPath).sort(),
      ['封面不同 - 同一首 (1).mp3', '封面不同 - 同一首.mp3'],
    );
    // 版本歧义必须人工复核，不静默合并。
    assert.ok(covers.every(song => song.status === 'needs-review'));
    assert.ok(covers.every(song => song.issues.includes('pcm-duplicate-different-file')));
  });
});

test('队列：重复扫描不复活已取消/已失败任务，也不清零失败次数', async () => {
  await withTempDir(async dir => {
    mkdirSync(join(dir, 'music'), { recursive: true });
    put(join(dir, 'music'), '取消 - 歌.mp3', 'audio-cancel');
    const { db, queue } = makeQueue(dir);
    try {
      await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const job = queue.listJobs()[0];
      queue.cancel(job.id);
      assert.equal(queue.getJob(job.id).status, 'CANCELLED');
      const again = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      assert.equal(again.created.length, 0);
      assert.equal(queue.getJob(job.id).status, 'CANCELLED');
    } finally {
      db.close();
    }
  });

  await withTempDir(async dir => {
    mkdirSync(join(dir, 'music'), { recursive: true });
    put(join(dir, 'music'), '失败 - 歌.mp3', 'audio-fail');
    const { db, queue } = makeQueue(dir, {
      maxAttempts: 1,
      extractor: async () => { throw Object.assign(new Error('boom'), { code: 'MODEL_CRASH' }); },
    });
    try {
      await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const job = queue.listJobs()[0];
      await queue.runOnce();
      assert.equal(queue.getJob(job.id).status, 'FAILED');
      assert.equal(queue.getJob(job.id).attempts, 1);
      await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      assert.equal(queue.getJob(job.id).status, 'FAILED');
      assert.equal(queue.getJob(job.id).attempts, 1);
      assert.equal(queue.getJob(job.id).error.code, 'MODEL_CRASH');
    } finally {
      db.close();
    }
  });
});

test('队列：人工核对可另选白名单内的 LRC，但拒绝非 LRC 与非相对路径', async () => {
  await withTempDir(async dir => {
    mkdirSync(join(dir, 'music'), { recursive: true });
    put(join(dir, 'music'), '88rising, Joji, Rich Brian, AUGUST 08 - Midsummer Madness.mp3', 'audio-midsummer');
    put(join(dir, 'music'), '88rising,Joji,Rich Brian - Midsummer Madness.lrc', LRC_MIDS);
    put(join(dir, 'music'), '手动选的歌词.lrc', '[00:01.00]manual\n');
    const { db, queue } = makeQueue(dir);
    try {
      await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const job = queue.listJobs()[0];
      assert.equal(job.status, 'NEEDS_REVIEW');
      assert.throws(
        () => queue.resolve(job.id, { lyricsRelPath: '88rising, Joji, Rich Brian, AUGUST 08 - Midsummer Madness.mp3' }),
        { code: 'BAD_REQUEST' },
      );
      assert.throws(
        () => queue.resolve(job.id, { lyricsRelPath: '/etc/passwd' }),
        { code: 'PATH_NOT_ALLOWED' },
      );
      const resolved = queue.resolve(job.id, { lyricsRelPath: '手动选的歌词.lrc' });
      assert.equal(resolved.status, 'PENDING_EXTRACT');
      const detail = queue.getJob(job.id);
      assert.equal(detail.lyrics.relPath, '手动选的歌词.lrc');
      const event = detail.events.find(item => item.event === 'resolved');
      assert.equal(event.detail.outsideCandidates, true);
    } finally {
      db.close();
    }
  });
});

test('探测：整轨解码一个样本都没有时不能算 ok', async () => {
  await withTempDir(async dir => {
    const ffprobe = join(dir, 'empty-ffprobe.mjs');
    writeFileSync(ffprobe, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ format: { duration: '10.0', tags: {} } }));
`);
    const ffmpeg = join(dir, 'empty-ffmpeg.mjs');
    writeFileSync(ffmpeg, `#!/usr/bin/env node
process.exit(0);
`);
    chmodSync(ffprobe, 0o755);
    chmodSync(ffmpeg, 0o755);
    const source = put(dir, 'empty.mp3', 'audio-empty');
    const probe = await probeAudio(source, {
      ffprobeBin: ffprobe,
      ffmpegBin: ffmpeg,
      deep: true,
      fingerprint: false,
      timeoutMs: 5000,
    });
    assert.equal(probe.decode.state, 'failed');
    assert.equal(probe.decode.fullyDecoded, false);
    assert.equal(probe.decode.decodedMs, 0);
  });
});

test('扫描：缺 ffmpeg 只报解码不可用，不冤枉音频损坏', async () => {
  await withTempDir(async dir => {
    const tools = makeFakeTools(dir);
    put(dir, '配置 - 歌.mp3', 'audio-config');
    put(dir, '配置 - 歌.lrc', '[00:01.00]line\n');
    const policy = createSourcePolicy({ roots: [{ id: 'music', path: dir }] });
    const scan = await scanSource({
      policy,
      rootId: 'music',
      options: {
        probe: true,
        fingerprint: false,
        probeOptions: { ffprobeBin: tools.ffprobe, ffmpegBin: join(dir, 'no-such-ffmpeg') },
      },
    });
    const song = scan.songs.find(item => item.original.includes('配置'));
    assert.equal(song.decode.state, 'not-installed');
    assert.ok(song.issues.includes('audio-decode-unavailable'));
    assert.ok(!song.issues.includes('audio-damaged'));
    assert.equal(song.status, 'ready-to-extract');
  });
});

test('扫描：ID3 多歌手用 / 分隔与文件名不一致时不算标题/歌手冲突', async () => {
  await withTempDir(async dir => {
    const tools = makeFakeTools(dir);
    put(dir, '3LAU, Carly Paige - Touch.mp3', 'audio-touch-tag');
    put(dir, '3LAU,Carly Paige - Touch.lrc', LRC_TOUCH);
    put(dir, '标签冲突 - 歌.mp3', 'audio-conflict');
    put(dir, '标签冲突 - 歌.lrc', '[00:01.00]conflict\n');
    const policy = createSourcePolicy({ roots: [{ id: 'music', path: dir }] });
    const scan = await scanSource({
      policy,
      rootId: 'music',
      options: { probe: true, fingerprint: false, deep: false, probeOptions: { ffprobeBin: tools.ffprobe, ffmpegBin: tools.ffmpeg } },
    });
    const touch = scan.songs.find(song => song.original.includes('Touch'));
    assert.ok(!touch.issues.includes('filename-id3-artist-conflict'));
    assert.ok(!touch.issues.includes('filename-id3-title-conflict'));
    const conflict = scan.songs.find(song => song.original.includes('标签冲突'));
    assert.ok(conflict.issues.includes('filename-id3-artist-conflict'));
    assert.ok(conflict.issues.includes('filename-id3-title-conflict'));
    assert.equal(conflict.status, 'needs-review');
  });
});

test('扫描：跳过 macOS AppleDouble 与隐藏文件，不把资源叉当成音频', async () => {
  await withTempDir(async dir => {
    put(dir, '._真正的歌.mp3', 'apple-double-resource-fork');
    put(dir, '.hidden.mp3', 'hidden-audio');
    put(dir, '真正的歌.mp3', 'audio-real');
    put(dir, '真正的歌.lrc', '[00:01.00]line\n');
    const { scan } = await scanSeed(dir);
    assert.equal(scan.summary.audioFiles, 1);
    assert.equal(scan.songs.length, 1);
    assert.equal(scan.songs[0].original, '真正的歌.mp3');
    assert.ok(!scan.unpairedLrc.includes('._真正的歌.lrc'));
  });
});

test('队列：扫描后源音频被改动则拒绝提取，不产生伴奏工件', async () => {
  await withTempDir(async dir => {
    mkdirSync(join(dir, 'music'), { recursive: true });
    const sourcePath = put(join(dir, 'music'), '变动 - 歌.mp3', 'source-v1');
    let calls = 0;
    const { db, mediaRoot, queue } = makeQueue(dir, {
      extractor: async payload => {
        calls += 1;
        return fakeExtractor(mediaRoot)(payload);
      },
    });
    try {
      await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const job = queue.listJobs()[0];
      writeFileSync(sourcePath, 'source-v2-changed');
      const result = await queue.runOnce();
      assert.equal(result.reason, 'SOURCE_CHANGED');
      assert.equal(calls, 0);
      const after = queue.getJob(job.id);
      assert.equal(after.status, 'FAILED');
      assert.equal(after.error.code, 'SOURCE_CHANGED');
      assert.deepEqual(after.artifacts, {});
      assert.equal(db.prepare('SELECT count(*) AS n FROM vocal_import_artifacts').get().n, 0);
    } finally {
      db.close();
    }
  });
});

test('队列：提取期间源音频被替换，本次结果作废且不登记工件', async () => {
  await withTempDir(async dir => {
    mkdirSync(join(dir, 'music'), { recursive: true });
    const sourcePath = put(join(dir, 'music'), '中途变动 - 歌.mp3', 'source-stable');
    const { db, mediaRoot, queue } = makeQueue(dir, {
      extractor: async payload => {
        writeFileSync(payload.sourceFile, 'swapped-during-extraction');
        return fakeExtractor(mediaRoot)(payload);
      },
    });
    try {
      await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const result = await queue.runOnce();
      assert.equal(result.reason, 'SOURCE_CHANGED');
      const job = queue.getJob(result.jobId);
      assert.equal(job.status, 'FAILED');
      assert.equal(job.error.code, 'SOURCE_CHANGED');
      assert.equal(db.prepare('SELECT count(*) AS n FROM vocal_import_artifacts').get().n, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM repertoire_items').get().n, 0);
      assert.ok(statSync(sourcePath).size > 0);
    } finally {
      db.close();
    }
  });
});

test('队列：入队时持久化歌词 SHA-256，供幂等定位与审计', async () => {
  await withTempDir(async dir => {
    mkdirSync(join(dir, 'music'), { recursive: true });
    put(join(dir, 'music'), '歌词哈希 - 歌.mp3', 'audio-hash');
    const lrcText = '[00:01.00]hash line\n';
    put(join(dir, 'music'), '歌词哈希 - 歌.lrc', lrcText);
    const { db, queue } = makeQueue(dir);
    try {
      await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const job = queue.listJobs()[0];
      assert.equal(job.lyrics.relPath, '歌词哈希 - 歌.lrc');
      assert.equal(job.lyrics.sha256, createHash('sha256').update(lrcText).digest('hex'));
    } finally {
      db.close();
    }
  });
});

test('队列：在“校验完成→入库”之间重启，恢复后补跑入库而不重新提取', async () => {
  await withTempDir(async dir => {
    mkdirSync(join(dir, 'music'), { recursive: true });
    put(join(dir, 'music'), '恢复入库 - 歌.mp3', 'audio-resume');
    const mediaRootPath = join(dir, 'media');
    const { db, mediaRoot, queue } = makeQueue(dir, { extractor: fakeExtractor(mediaRootPath) });
    try {
      await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const first = await queue.runOnce();
      assert.equal(first.status, 'READY_TO_IMPORT');
      const jobId = first.jobId;
      // 模拟进程在调用 importer 之前被杀：状态停在 VERIFYING，工件已登记、租约已释放。
      db.prepare("UPDATE vocal_import_jobs SET status='VERIFYING',stage='VERIFY',lease_owner=NULL,lease_expires_at=NULL WHERE id=?").run(jobId);

      const imported = [];
      const resumed = openVocalImportQueue({
        db,
        policy: createSourcePolicy({ roots: [{ id: 'music', path: join(dir, 'music') }] }),
        mediaRoot,
        extractor: async () => { throw new Error('不应该重新提取'); },
        importer: async payload => { imported.push(payload); },
        verifyAccompaniment: createTestAccompanimentVerifier(),
        logger: null,
      }).queue;
      const result = await resumed.runOnce();
      assert.equal(result.status, 'IMPORTED');
      assert.equal(imported.length, 1);
      assert.ok(imported[0].artifact.relPath.endsWith('accompaniment.flac'));
      const job = resumed.getJob(jobId);
      assert.equal(job.status, 'IMPORTED');
      assert.ok(job.events.some(event => event.event === 'imported' && event.detail.resumed === true));
    } finally {
      db.close();
    }
  });
});

test('结构推测：前奏/主歌/副歌按歌词重复切段，无歌词不臆造', () => {
  const lyrics = [
    { startMs: 3000, text: '第一句开场白' },
    { startMs: 8000, text: '第二句讲事情' },
    { startMs: 13000, text: '副歌这句会重复' },
    { startMs: 18000, text: '又来一句主歌' },
    { startMs: 23000, text: '副歌这句会重复' },
  ];
  const sections = buildSections(lyrics, 40000);
  assert.deepEqual(sections.map(s => [s.label, s.startMs, s.endMs]), [
    ['主歌', 3000, 13000],
    ['副歌', 13000, 18000],
    ['主歌', 18000, 23000],
    ['副歌', 23000, 28000],
    ['尾奏', 28000, 40000],
  ]);
  assert.deepEqual(buildSections([], 40000), []);
});
