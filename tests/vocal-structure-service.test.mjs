import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db/database.mjs';
import { getRepertoire, saveRepertoire } from '../server/repertoire/service.mjs';
import { createApiServer } from '../server/index.mjs';
import { createStructureAnalyzer, sha256File } from '../server/vocal-structure/analyzer.mjs';
import {
  applyStructureDraft, discardStructureDraft, generateStructureDraft, getDraftView,
  readDraft, restoreLegacySections,
} from '../server/vocal-structure/service.mjs';
import { mountStructureRoutes } from '../server/vocal-structure/routes.mjs';

/**
 * 结构草稿落库与接口（V3.2 T4）。
 * 全部使用临时目录 + 临时 SQLite，不连生产库、不读写用户音乐。
 */

const SEGMENTS = [
  { start: 0, end: 15, label: 'segment', clusterId: 'c1', rms: 0.1 },
  { start: 15, end: 40, label: 'segment', clusterId: 'c2', rms: 0.2 },
  { start: 40, end: 60, label: 'segment', clusterId: 'c1', rms: 0.11 },
  { start: 60, end: 90, label: 'segment', clusterId: 'c3', rms: 0.26 },
];

const LYRICS = [
  { id: 'line-1', startMs: 16000, text: '第一句' },
  { id: 'line-2', startMs: 30000, text: '第二句' },
  { id: 'line-3', startMs: 61000, text: '第三句' },
];

/** 隔离根目录：必须 await 回调，否则 finally 会在异步用例跑完前删掉临时目录。 */
async function withEnv(run) {
  const root = mkdtempSync(join(tmpdir(), 'p040-structure-'));
  const mediaRoot = join(root, 'media');
  mkdirSync(join(mediaRoot, 'vocal-import', 'song-1'), { recursive: true });
  const audio = join(mediaRoot, 'vocal-import', 'song-1', 'original.mp3');
  writeFileSync(audio, Buffer.from('fake-audio-bytes-for-structure-test'));
  const db = openDatabase(join(root, 'db.sqlite'));
  try {
    return await run({ db, root, mediaRoot, audio });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** 造一条带原唱音轨的 VOCAL 曲目（时间轴与音轨都在隔离库内）。 */
function seedVocal(db, mediaRoot, { sections = [], lyrics = LYRICS } = {}) {
  const item = saveRepertoire(db, null, { kind: 'VOCAL', title: '结构测试歌', language: 'zh', lyrics, sections });
  const clipId = randomUUID();
  const sha = sha256File(join(mediaRoot, 'vocal-import', 'song-1', 'original.mp3'));
  const sourceId = randomUUID();
  db.prepare('INSERT INTO source_media(id,source_kind,internal_path,sha256,duration_ms) VALUES(?,?,?,?,?)')
    .run(sourceId, 'AUDIO', 'vocal-import/song-1/original.mp3', sha, 90000);
  db.prepare('INSERT INTO performance_clips(id,source_media_id,start_ms,end_ms,internal_audio_path,codec,source_preserving,sha256,size_bytes,duration_ms) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(clipId, sourceId, 0, 90000, 'vocal-import/song-1/original.mp3', 'mp3', 1, sha, 36, 90000);
  db.prepare('UPDATE repertoire_items SET original_clip_id=?, audio_role=? WHERE id=?')
    .run(clipId, 'REFERENCE', item.id);
  return getRepertoire(db, item.id);
}

function fakeAnalyzer(overrides = {}) {
  return {
    ready: true,
    modelName: 'p040-mix-structure',
    modelVersion: 'test-1',
    async analyze({ audioPath }) {
      return {
        schema: 'p040.structure-analysis.v1',
        modelName: 'p040-mix-structure',
        modelVersion: 'test-1',
        audioSha256: sha256File(audioPath),
        durationMs: 90000,
        segments: SEGMENTS,
        // 只有同类型的段才可能是重复；首段被判前奏后，用两段未标注段做候选。
        relations: [{ left: 1, right: 2, score: 0.83, method: 'chroma-cens+mfcc-cosine' }],
        mergeCandidates: [],
        separation: { used: false, modulesSeen: [] },
        timing: { seconds: 1.2, peakMemoryMb: 120 },
        ...overrides,
      };
    },
  };
}

test('生成草稿：写入独立表，不动机场结构，旧结构被完整快照', () => withEnv(async ({ db, mediaRoot }) => {
  const item = seedVocal(db, mediaRoot, {
    sections: [{ id: 'legacy-1', type: 'verse', label: '主歌', startMs: 0, endMs: 90000, source: 'manual' }],
  });
  const result = await generateStructureDraft({ db, mediaRoot, analyzer: fakeAnalyzer(), getRepertoire, songId: item.id, workDir: join(mediaRoot, '..', 'work') });
  assert.equal(result.reused, false);
  assert.equal(result.draft.state, 'NEEDS_REVIEW');
  // 首段整体落在首句之前 ⇒ 前奏（只看「没人唱」，不是旋律判断）；其余未知道段保持 U。
  assert.deepEqual(result.draft.map.sections.map((section) => section.code), ['前奏', 'U1', 'U2', 'U3']);
  assert.equal(result.draft.legacySectionCount, 1);
  assert.equal(result.draft.map.relationCandidates.length, 1);
  // 正式结构仍是旧的，没有被草稿覆盖。
  const after = getRepertoire(db, item.id);
  assert.equal(after.sections.length, 1);
  assert.equal(after.sections[0].id, 'legacy-1');
  assert.equal(after.sections[0].source, 'manual');
  assert.deepEqual(readDraft(db, item.id).legacySections.map((section) => section.id), ['legacy-1']);
}));

test('同一份原曲重复生成幂等，force 才重算', () => withEnv(async ({ db, mediaRoot }) => {
  const item = seedVocal(db, mediaRoot);
  let calls = 0;
  const analyzer = fakeAnalyzer();
  const counted = { ...analyzer, async analyze(input) { calls += 1; return analyzer.analyze(input); } };
  await generateStructureDraft({ db, mediaRoot, analyzer: counted, getRepertoire, songId: item.id, workDir: join(mediaRoot, '..', 'work') });
  const second = await generateStructureDraft({ db, mediaRoot, analyzer: counted, getRepertoire, songId: item.id, workDir: join(mediaRoot, '..', 'work') });
  assert.equal(second.reused, true);
  assert.equal(calls, 1);
  const forced = await generateStructureDraft({ db, mediaRoot, analyzer: counted, getRepertoire, songId: item.id, force: true, workDir: join(mediaRoot, '..', 'work') });
  assert.equal(forced.reused, false);
  assert.equal(calls, 2);
}));

test('应用草稿：正式结构全部标 manual，草稿转 APPLIED，旧结构仍可恢复', () => withEnv(async ({ db, mediaRoot }) => {
  const item = seedVocal(db, mediaRoot);
  const generated = await generateStructureDraft({ db, mediaRoot, analyzer: fakeAnalyzer(), getRepertoire, songId: item.id, workDir: join(mediaRoot, '..', 'work') });
  const map = generated.draft.map;
  // 用户把两段确认成主歌/副歌，再应用。
  map.sections[0].type = 'verse';
  map.sections[1].type = 'chorus';
  map.sections[2].type = 'verse';
  map.sections[3].type = 'chorus';
  const applied = applyStructureDraft({ db, getRepertoire, saveRepertoire, songId: item.id, map });
  assert.equal(applied.applied, 4);
  assert.deepEqual(applied.item.sections.map((section) => section.label), ['A1', 'B1', 'A2', 'B2']);
  assert.ok(applied.item.sections.every((section) => section.source === 'manual'));
  assert.equal(readDraft(db, item.id).state, 'APPLIED');
  // 原本没有旧结构时不允许「恢复」出内容：明确 409 语义，而不是静默恢复 0 段。
  assert.throws(() => restoreLegacySections({ db, getRepertoire, saveRepertoire, songId: item.id }), (error) => error.code === 'NO_LEGACY_SECTIONS');
}));

test('应用草稿不把 Rap 当已确认；显式确认状态可持久化，旧数据保持可读', () => withEnv(async ({ db, mediaRoot }) => {
  const item = seedVocal(db, mediaRoot, {
    lyrics: [
      { id: 'line-1', startMs: 6000, text: '第一句' },
      { id: 'line-2', startMs: 26000, text: '第二句' },
      { id: 'line-3', startMs: 56000, text: '第三句' },
    ],
  });
  const generated = await generateStructureDraft({
    db, mediaRoot, songId: item.id, getRepertoire,
    analyzer: fakeAnalyzer({
      segments: [
        { start: 0, end: 20, label: 'verse' },
        { start: 20, end: 50, label: 'rap' },
        { start: 50, end: 70, label: 'chorus' },
        { start: 70, end: 90, label: 'verse' },
      ],
      relations: [],
    }),
    workDir: join(mediaRoot, '..', 'work'),
  });
  const map = generated.draft.map;
  assert.deepEqual(map.sections.map((section) => section.type), ['verse', 'rap', 'chorus', 'verse']);

  const applied = applyStructureDraft({ db, getRepertoire, saveRepertoire, songId: item.id, map });
  const appliedRap = applied.item.sections.find((section) => section.type === 'rap');
  // source=manual 只代表结构已保存；Rap 未逐段确认时必须显式持久化为 false。
  assert.equal(appliedRap.source, 'manual');
  assert.equal(appliedRap.rapApproved, false);

  // 用户在校准结构里确认后保存：true 必须原样落库。
  const confirmed = applied.item.sections.map((section) => (
    section.type === 'rap' ? { ...section, rapApproved: true } : section
  ));
  const saved = saveRepertoire(db, item.id, { sections: confirmed });
  assert.equal(saved.sections.find((section) => section.type === 'rap').rapApproved, true);

  // 取消确认同样要持久化，不能又退回「manual=已确认」。
  const revoked = saved.sections.map((section) => (
    section.type === 'rap' ? { ...section, rapApproved: false } : section
  ));
  assert.equal(saveRepertoire(db, item.id, { sections: revoked }).sections.find((section) => section.type === 'rap').rapApproved, false);

  // 旧数据没有这个字段：原样保留缺省，读取端才能按旧行为兼容。
  const legacy = saveRepertoire(db, item.id, {
    sections: [{ id: 'legacy-rap', type: 'rap', label: 'R1', startMs: 0, endMs: 10000, source: 'manual' }],
  });
  assert.equal('rapApproved' in legacy.sections[0], false);

  // 非法值明确拒绝，不悄悄丢掉确认状态。
  assert.throws(() => saveRepertoire(db, item.id, {
    sections: [{ id: 'bad-rap', type: 'rap', label: 'R1', startMs: 0, endMs: 10000, source: 'manual', rapApproved: 'yes' }],
  }), /INVALID_SECTIONS/);
}));

test('恢复旧结构时，算法 Rap 不会被改成可跳过', () => withEnv(async ({ db, mediaRoot }) => {
  const item = seedVocal(db, mediaRoot, {
    sections: [{ id: 'legacy-rap', type: 'rap', label: 'R1', startMs: 0, endMs: 90000, source: 'algorithm' }],
  });
  const generated = await generateStructureDraft({ db, mediaRoot, analyzer: fakeAnalyzer(), getRepertoire, songId: item.id, workDir: join(mediaRoot, '..', 'work') });
  const map = generated.draft.map;
  map.sections.forEach((section) => { section.type = 'verse'; });
  applyStructureDraft({ db, getRepertoire, saveRepertoire, songId: item.id, map });
  const restored = restoreLegacySections({ db, getRepertoire, saveRepertoire, songId: item.id });
  const rap = restored.item.sections[0];
  assert.equal(rap.source, 'manual');
  assert.equal(rap.rapApproved, false);
}));

test('旧结构可一键恢复，且恢复后草稿标记为已丢弃', () => withEnv(async ({ db, mediaRoot }) => {
  const item = seedVocal(db, mediaRoot, {
    sections: [
      { id: 'legacy-1', type: 'verse', label: 'A', startMs: 0, endMs: 40000, source: 'manual' },
      { id: 'legacy-2', type: 'chorus', label: 'B', startMs: 40000, endMs: 90000, source: 'manual' },
    ],
  });
  const generated = await generateStructureDraft({ db, mediaRoot, analyzer: fakeAnalyzer(), getRepertoire, songId: item.id, workDir: join(mediaRoot, '..', 'work') });
  const map = generated.draft.map;
  map.sections.forEach((section) => { section.type = 'verse'; });
  applyStructureDraft({ db, getRepertoire, saveRepertoire, songId: item.id, map, replaceManual: true });
  const restored = restoreLegacySections({ db, getRepertoire, saveRepertoire, songId: item.id });
  assert.equal(restored.restored, 2);
  assert.deepEqual(restored.item.sections.map((section) => section.id), ['legacy-1', 'legacy-2']);
  assert.equal(readDraft(db, item.id).state, 'DISCARDED');
}));

test('已有手工结构时应用草稿必须显式覆盖', () => withEnv(async ({ db, mediaRoot }) => {
  const item = seedVocal(db, mediaRoot, {
    sections: [{ id: 'legacy-1', type: 'verse', label: 'A', startMs: 0, endMs: 90000, source: 'manual' }],
  });
  const generated = await generateStructureDraft({ db, mediaRoot, analyzer: fakeAnalyzer(), getRepertoire, songId: item.id, workDir: join(mediaRoot, '..', 'work') });
  assert.throws(() => applyStructureDraft({ db, getRepertoire, saveRepertoire, songId: item.id, map: generated.draft.map }), (error) => error.code === 'MANUAL_OVERRIDE');
  const ok = applyStructureDraft({ db, getRepertoire, saveRepertoire, songId: item.id, map: generated.draft.map, replaceManual: true });
  assert.equal(ok.item.sections.length, 4);
}));

test('草稿生成后只改练习设置仍可应用；正式结构被改过才判冲突', () => withEnv(async ({ db, mediaRoot }) => {
  const item = seedVocal(db, mediaRoot);
  const generated = await generateStructureDraft({ db, mediaRoot, analyzer: fakeAnalyzer(), getRepertoire, songId: item.id, workDir: join(mediaRoot, '..', 'work') });

  // 练习设置（倍速/跳过 Rap）由播放器自动保存，会推进 revision，但不代表结构变了。
  saveRepertoire(db, item.id, { practice: { playbackRate: 1.25 } });
  assert.ok(getRepertoire(db, item.id).revision > generated.draft.baseRevision);
  const applied = applyStructureDraft({ db, getRepertoire, saveRepertoire, songId: item.id, map: generated.draft.map });
  assert.equal(applied.applied, 4, '只改练习设置不应把草稿锁死');

  // 同一首歌再生成草稿后把结构清空（用户在编辑器里删光段落）：草稿不能把它悄悄填回来。
  const next = await generateStructureDraft({ db, mediaRoot, analyzer: fakeAnalyzer(), getRepertoire, songId: item.id, workDir: join(mediaRoot, '..', 'work'), force: true });
  saveRepertoire(db, item.id, { sections: [] });
  assert.throws(
    () => applyStructureDraft({ db, getRepertoire, saveRepertoire, songId: item.id, map: next.draft.map }),
    (error) => error.code === 'CONFLICT',
  );
  assert.deepEqual(getRepertoire(db, item.id).sections, []);
}));

test('丢弃草稿后不再自动复用', () => withEnv(async ({ db, mediaRoot }) => {
  const item = seedVocal(db, mediaRoot);
  await generateStructureDraft({ db, mediaRoot, analyzer: fakeAnalyzer(), getRepertoire, songId: item.id, workDir: join(mediaRoot, '..', 'work') });
  assert.deepEqual(discardStructureDraft({ db, songId: item.id }), { songId: item.id, state: 'DISCARDED' });
  const again = await generateStructureDraft({ db, mediaRoot, analyzer: fakeAnalyzer(), getRepertoire, songId: item.id, workDir: join(mediaRoot, '..', 'work') });
  assert.equal(again.reused, false);
  assert.equal(again.draft.state, 'NEEDS_REVIEW');
}));

test('没有原唱音轨时明确拒绝，不读取别的文件', () => withEnv(async ({ db, mediaRoot }) => {
  const item = saveRepertoire(db, null, { kind: 'VOCAL', title: '没有音轨' });
  await assert.rejects(
    generateStructureDraft({ db, mediaRoot, analyzer: fakeAnalyzer(), getRepertoire, songId: item.id, workDir: join(mediaRoot, '..', 'work') }),
    (error) => error.code === 'NO_AUDIO',
  );
  assert.equal(getDraftView({ db, getRepertoire, songId: item.id }), null);
}));

test('分析器拒绝带分离模块的结果，并且不改动原曲', () => withEnv(async ({ db, mediaRoot, root, audio }) => {
  // 用 node 冒充 python：脚本只写结果文件，便于验证守卫逻辑。
  const script = join(root, 'fake-analyze.mjs');
  writeFileSync(script, `
    import {writeFileSync} from 'node:fs';
    import {createHash} from 'node:crypto';
    import {readFileSync} from 'node:fs';
    const args=process.argv.slice(2);const audio=args[1];const out=args[3];
    const sha=createHash('sha256').update(readFileSync(audio)).digest('hex');
    writeFileSync(out, JSON.stringify({schema:'p040.structure-analysis.v1',modelName:'p040-mix-structure',modelVersion:'1.1.0',audioSha256:sha,durationMs:1000,
      segments:[{start:0,end:1,label:'segment'}],relations:[],separation:{used:true,modulesSeen:['demucs']}}));
  `);
  const analyzer = createStructureAnalyzer({ python: process.execPath, script, timeoutMs: 20000 });
  const before = readFileSync(audio);
  await assert.rejects(
    analyzer.analyze({ audioPath: audio, outPath: join(root, 'out.json') }),
    (error) => error.code === 'SEPARATION_DETECTED',
  );
  assert.deepEqual(readFileSync(audio), before);
}));

test('分析器校验原曲 SHA，中途换文件即报错', () => withEnv(async ({ root, audio }) => {
  const script = join(root, 'fake-mismatch.mjs');
  writeFileSync(script, `
    import {writeFileSync} from 'node:fs';
    const args=process.argv.slice(2);const out=args[3];
    writeFileSync(out, JSON.stringify({schema:'p040.structure-analysis.v1',modelName:'p040-mix-structure',modelVersion:'1.1.0',audioSha256:'deadbeef',durationMs:1000,
      segments:[{start:0,end:1,label:'segment'}],relations:[],separation:{used:false,modulesSeen:[]}}));
  `);
  const analyzer = createStructureAnalyzer({ python: process.execPath, script, timeoutMs: 20000 });
  await assert.rejects(
    analyzer.analyze({ audioPath: audio, outPath: join(root, 'out.json') }),
    (error) => error.code === 'ANALYSIS_INVALID',
  );
}));

test('未配置 Python 时分析器明确不可用，不假装成功', async () => {
  const analyzer = createStructureAnalyzer({ python: '', script: 'x.py' });
  assert.equal(analyzer.ready, false);
  await assert.rejects(analyzer.analyze({ audioPath: 'a', outPath: 'b' }), (error) => error.code === 'ANALYZER_NOT_CONFIGURED');
});

test('HTTP：读取空草稿、生成、应用、恢复都能走通，且未配置分析器时返回 503', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p040-structure-http-'));
  const mediaRoot = join(root, 'media');
  mkdirSync(join(mediaRoot, 'vocal-import', 'song-1'), { recursive: true });
  writeFileSync(join(mediaRoot, 'vocal-import', 'song-1', 'original.mp3'), Buffer.from('fake-audio-bytes-for-structure-test'));
  const db = openDatabase(join(root, 'db.sqlite'));
  const item = seedVocal(db, mediaRoot);
  const analyzer = fakeAnalyzer();
  const structure = {
    analyzer,
    handle: mountStructureRoutes({
      db, mediaRoot, analyzer, getRepertoire, saveRepertoire,
      workDir: join(root, 'work'), authorize: () => true,
    }),
  };
  const server = createApiServer({ db, mediaRoot, structure });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, {
      method,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    const empty = await request(`/api/repertoire/${item.id}/structure-draft`);
    assert.equal(empty.status, 200);
    assert.equal(empty.data.draft, null);

    const created = await request(`/api/repertoire/${item.id}/structure-draft`, 'POST', {});
    assert.equal(created.status, 200);
    assert.equal(created.data.draft.map.sections.length, 4);

    const map = created.data.draft.map;
    map.sections.forEach((section) => { section.type = 'verse'; });
    const applied = await request(`/api/repertoire/${item.id}/structure-draft`, 'PUT', { map });
    assert.equal(applied.status, 200);
    assert.equal(applied.data.applied, 4);

    const restored = await request(`/api/repertoire/${item.id}/structure-draft/restore`, 'POST');
    assert.equal(restored.status, 409);

    const current = await request(`/api/repertoire/${item.id}/structure-draft/current`);
    assert.equal(current.status, 200);
    assert.equal(current.data.map.sections.length, 4);

    const notReady = { analyzer: { ready: false }, handle: mountStructureRoutes({ db, mediaRoot, analyzer: { ready: false }, getRepertoire, saveRepertoire, workDir: join(root, 'work'), authorize: () => true }) };
    const server2 = createApiServer({ db, mediaRoot, structure: notReady });
    await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
    const base2 = `http://127.0.0.1:${server2.address().port}`;
    const unavailable = await fetch(`${base2}/api/repertoire/${item.id}/structure-draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(unavailable.status, 503);
    await new Promise((resolve) => server2.close(resolve));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
