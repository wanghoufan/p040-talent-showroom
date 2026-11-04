import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db/database.mjs';
import { getRepertoire, saveRepertoire } from '../server/repertoire/service.mjs';
import { sha256File } from '../server/vocal-structure/analyzer.mjs';
import {
  applyStructureDraft, clearStructureReference, generateStructureDraft, readDraft, reapplyStructureReference,
  setStructureReference,
} from '../server/vocal-structure/service.mjs';
import {
  buildReferenceSections, normalizeReference, REFERENCE_SCHEMA, verifyIdentity,
} from '../server/vocal-structure/reference.mjs';

/**
 * 参考结构草稿（V3.3 最小闭环）。
 * 全部在临时目录 + 临时 SQLite 里跑：不连隔离/生产库，不读真实音乐，不出声。
 */

const PAPILLON = JSON.parse(readFileSync(new URL('../docs/plan/P040-Structure-Source-Validation-2026-10-31/papillon-candidates.json', import.meta.url), 'utf8'));
const DURATION = 195036;
const LYRICS = [
  { id: 'line-1', startMs: 12180, text: 'Yeh' },
  { id: 'line-14', startMs: 34650, text: 'You got me feeling like a' },
  { id: 'line-25', startMs: 57150, text: 'Papillon' },
  { id: 'line-30', startMs: 68560, text: 'Aite' },
  { id: 'line-34', startMs: 79870, text: 'Papillon' },
  { id: 'line-47', startMs: 103260, text: 'You got me feeling like a' },
  { id: 'line-54', startMs: 125290, text: 'Aite' },
  { id: 'line-59', startMs: 136400, text: 'Papillon' },
  { id: 'line-63', startMs: 147450, text: 'You got me feeling like a' },
];

async function withEnv(run) {
  const root = mkdtempSync(join(tmpdir(), 'p040-reference-'));
  const mediaRoot = join(root, 'media');
  mkdirSync(join(mediaRoot, 'vocal-import', 'song-1'), { recursive: true });
  const audio = join(mediaRoot, 'vocal-import', 'song-1', 'original.mp3');
  writeFileSync(audio, Buffer.from('fake-audio-bytes-for-reference-test'));
  const db = openDatabase(join(root, 'db.sqlite'));
  try {
    return await run({ db, root, mediaRoot, audio });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function seedVocal(db, mediaRoot, { title = 'Papillon', artist = '王嘉尔', sections = [], durationMs = DURATION } = {}) {
  const item = saveRepertoire(db, null, { kind: 'VOCAL', title, artist, language: 'en', lyrics: LYRICS, sections });
  const clipId = randomUUID();
  const sha = sha256File(join(mediaRoot, 'vocal-import', 'song-1', 'original.mp3'));
  const sourceId = randomUUID();
  db.prepare('INSERT INTO source_media(id,source_kind,internal_path,sha256,duration_ms) VALUES(?,?,?,?,?)')
    .run(sourceId, 'AUDIO', 'vocal-import/song-1/original.mp3', sha, durationMs);
  db.prepare('INSERT INTO performance_clips(id,source_media_id,start_ms,end_ms,internal_audio_path,codec,source_preserving,sha256,size_bytes,duration_ms) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(clipId, sourceId, 0, durationMs, 'vocal-import/song-1/original.mp3', 'mp3', 1, sha, 36, durationMs);
  db.prepare('UPDATE repertoire_items SET original_clip_id=?, audio_role=? WHERE id=?').run(clipId, 'REFERENCE', item.id);
  return getRepertoire(db, item.id);
}

function referenceFor(sha, overrides = {}) {
  return { ...PAPILLON, audioSha256: sha, ...overrides };
}

function fakeAnalyzer(sha, segments = [
  { start: 0, end: 20, label: 'segment', clusterId: 'c1', rms: 0.1 },
  { start: 20, end: 60, label: 'segment', clusterId: 'c2', rms: 0.2 },
  { start: 60, end: 120, label: 'segment', clusterId: 'c1', rms: 0.11 },
]) {
  return {
    ready: true, modelName: 'p040-mix-structure', modelVersion: 'test-ref',
    async analyze() {
      return {
        schema: 'p040.structure-analysis.v1', modelName: 'p040-mix-structure', modelVersion: 'test-ref',
        audioSha256: sha, durationMs: DURATION, segments, relations: [], mergeCandidates: [],
        separation: { used: false, modulesSeen: [] }, timing: { seconds: 1 }, decoder: 'test', tempoBpm: 100,
      };
    },
  };
}

test('参考文件：缺 SHA / 带歌词正文一律拒绝', () => {
  assert.throws(() => normalizeReference({ ...PAPILLON, audioSha256: undefined }), /REFERENCE_AUDIO_SHA_REQUIRED/);
  assert.throws(() => normalizeReference({ ...PAPILLON, lyrics: ['第一句歌词'] }), /REFERENCE_LYRIC_PAYLOAD/);
  assert.throws(
    () => normalizeReference({ ...PAPILLON, candidates: [{ ...PAPILLON.candidates[0], lyricText: '不该出现的歌词' }] }),
    /REFERENCE_LYRIC_PAYLOAD/,
  );
  assert.throws(() => normalizeReference({ ...PAPILLON, schema: undefined }), /REFERENCE_SCHEMA_INVALID/);
});

test('身份核验：歌手/歌名/版本/时长/原音频 SHA 任一不符都拒绝', () => {
  const reference = normalizeReference(PAPILLON);
  const sha = PAPILLON.audioSha256;
  const item = { title: 'Papillon', artist: '王嘉尔', durationMs: DURATION, notes: '' };
  assert.equal(verifyIdentity({ reference, item, audioSha256: sha }).ok, true);

  const bts = verifyIdentity({
    reference: normalizeReference({ ...PAPILLON, artist: 'BTS', artistAliases: [] }),
    item: { title: 'Let Go', artist: '石玺彤', durationMs: 206206, notes: '' },
    audioSha256: sha,
  });
  assert.equal(bts.ok, false);
  assert.ok(bts.blockers.some((item2) => item2.code === 'IDENTITY_ARTIST_MISMATCH'));
  assert.ok(bts.blockers.some((item2) => item2.code === 'IDENTITY_TITLE_MISMATCH'));

  const duration = verifyIdentity({ reference, item: { ...item, durationMs: DURATION - 20000 }, audioSha256: sha });
  assert.equal(duration.ok, false);
  assert.ok(duration.blockers.some((item2) => item2.code === 'IDENTITY_DURATION_MISMATCH'));

  const hash = verifyIdentity({ reference, item, audioSha256: 'a'.repeat(64) });
  assert.equal(hash.ok, false);
  assert.ok(hash.blockers.some((item2) => item2.code === 'IDENTITY_AUDIO_SHA_MISMATCH'));

  // 本地是 Live 版、参考写的是录音室版：不能当同一份录音。
  const version = verifyIdentity({ reference, item: { ...item, title: 'Papillon (Live)' }, audioSha256: sha });
  assert.equal(version.ok, false);
  assert.ok(version.blockers.some((item2) => item2.code === 'IDENTITY_VERSION_MISMATCH'));
});

test('候选分段：LRC 锚定、争议类型保持待标注、尾段不虚构结束时间', () => {
  const reference = normalizeReference(PAPILLON);
  const built = buildReferenceSections({ reference, durationMs: DURATION, lyrics: LYRICS });
  assert.equal(built.sections.length, 10);
  assert.deepEqual(built.sections.map((section) => section.startMs), [0, 12180, 34650, 57150, 68560, 79870, 103260, 125290, 136400, 147450]);
  const disputed = built.sections.filter((section) => section.disputed);
  assert.equal(disputed.length, 2);
  assert.ok(disputed.every((section) => section.type === 'unknown'));
  assert.deepEqual(disputed[0].alternates, ['refrain', 'verse']);
  assert.equal(built.sections[1].anchor.lineId, 'line-1');
  assert.equal(built.sections.at(-1).endMs, DURATION);
  assert.equal(built.sections.at(-1).endUnverified, true);
  assert.ok(built.warnings.includes('REFERENCE_DISPUTED_TYPES'));
});

test('载入参考只写草稿：正式结构一个字节不变；应用需显式确认', () => withEnv(async ({ db, mediaRoot, audio }) => {
  const legacy = [
    { id: 'section-1', type: 'intro', label: '前奏', startMs: 0, endMs: 12000, source: 'manual' },
    { id: 'section-2', type: 'verse', label: '主歌', startMs: 12000, endMs: DURATION, source: 'manual' },
  ];
  const item = seedVocal(db, mediaRoot, { sections: legacy });
  const before = JSON.stringify(getRepertoire(db, item.id).sections);

  const sha = sha256File(audio);
  const result = setStructureReference({ db, mediaRoot, getRepertoire, songId: item.id, reference: referenceFor(sha) });
  assert.equal(result.identity.ok, true);
  assert.equal(result.draft.reference.candidateCount, 10);
  assert.equal(result.draft.reference.disputedCount, 2);
  assert.equal(result.draft.map.sections.length, 10);
  assert.equal(JSON.stringify(getRepertoire(db, item.id).sections), before, '正式结构必须原样保留');

  // 参考草稿不能「一键应用」：没有显式确认就拒绝。
  assert.throws(
    () => applyStructureDraft({ db, getRepertoire, saveRepertoire, songId: item.id, map: result.draft.map, replaceManual: true }),
    /REFERENCE_CONFIRMATION_REQUIRED/,
  );
  const applied = applyStructureDraft({
    db, getRepertoire, saveRepertoire, songId: item.id, map: result.draft.map, replaceManual: true, confirmReference: true,
  });
  assert.equal(applied.applied, 10);
  assert.ok(getRepertoire(db, item.id).sections.every((section) => section.source === 'manual'));
}));

test('身份不符直接拒绝：同名不同歌不会写入任何候选', () => withEnv(async ({ db, mediaRoot, audio }) => {
  const item = seedVocal(db, mediaRoot, { title: 'Let Go', artist: '石玺彤', durationMs: 206206 });
  const sha = sha256File(audio);
  const bts = { ...PAPILLON, songTitle: 'Let Go', artist: 'BTS', artistAliases: [], audioSha256: sha, audioDurationMs: 206206 };
  assert.throws(
    () => setStructureReference({ db, mediaRoot, getRepertoire, songId: item.id, reference: bts }),
    /IDENTITY_MISMATCH/,
  );
  assert.equal(readDraft(db, item.id), null, '核验失败不得留下草稿');
  assert.equal(getRepertoire(db, item.id).sections.length, 0);
}));

test('手工保存后重新分析不改写正式结构，参考快照仍可恢复', () => withEnv(async ({ db, mediaRoot, audio }) => {
  const item = seedVocal(db, mediaRoot, {});
  const sha = sha256File(audio);
  const reference = referenceFor(sha);
  const loaded = setStructureReference({ db, mediaRoot, getRepertoire, songId: item.id, reference });
  const applied = applyStructureDraft({
    db, getRepertoire, saveRepertoire, songId: item.id, map: loaded.draft.map, replaceManual: true, confirmReference: true,
  });
  const saved = JSON.stringify(applied.item.sections);

  const analyzer = fakeAnalyzer(sha);
  await generateStructureDraft({ db, mediaRoot, analyzer, getRepertoire, songId: item.id, force: true });
  assert.equal(JSON.stringify(getRepertoire(db, item.id).sections), saved, '重新分析不得覆盖人工结构');
  assert.ok(readDraft(db, item.id).analysis.reference, '参考快照要留在草稿里');

  // 重新分析后仍能把参考草稿恢复到地图上（不写正式结构）。
  const reapplied = reapplyStructureReference({ db, getRepertoire, songId: item.id });
  assert.equal(reapplied.draft.map.sections.length, 10);
  assert.equal(JSON.stringify(getRepertoire(db, item.id).sections), saved);

  const cleared = clearStructureReference({ db, getRepertoire, songId: item.id });
  assert.equal(cleared.draft.reference, null);
  assert.equal(JSON.stringify(getRepertoire(db, item.id).sections), saved);
}));

test('参考草稿写入时保留生成草稿的旧结构快照，可回滚', () => withEnv(async ({ db, mediaRoot, audio }) => {
  const legacy = [{ id: 'section-1', type: 'verse', label: 'A1', startMs: 0, endMs: DURATION, source: 'manual' }];
  const item = seedVocal(db, mediaRoot, { sections: legacy });
  const sha = sha256File(audio);
  setStructureReference({ db, mediaRoot, getRepertoire, songId: item.id, reference: referenceFor(sha) });
  const draft = readDraft(db, item.id);
  assert.equal(draft.legacySections.length, 1);
  assert.equal(draft.legacySections[0].id, 'section-1');
}));
