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
  applyStructureDraft, getDraftView, listStructureReferences, readDraft, setStructureReferenceFromCatalog,
} from '../server/vocal-structure/service.mjs';
import { normalizeReference, verifyIdentity } from '../server/vocal-structure/reference.mjs';
import { REFERENCE_CATALOG, catalogReference } from '../server/vocal-structure/reference-catalog.mjs';
import { mountStructureRoutes } from '../server/vocal-structure/routes.mjs';

/**
 * 内置参考目录（P040 V1.2）：无需用户找文件即可载入本次已提供的 Papillon 参考。
 * 全部在临时目录 + 临时 SQLite 里跑：不连真实库、不读真实音乐文件、不出声、不跑分析。
 *
 * `shaProvider` 只在本文件里注入目录声明的摘要，用来把「身份五项全过」这条路径跑通；
 * 生产路由不传这个参数，永远用真实文件现算的 SHA。
 */

const DURATION = 195036;
const CATALOG_SHA = REFERENCE_CATALOG[0].audioSha256;
const PAPILLON = catalogReference('papillon-jackson-wang-studio');

/** 与真实 Papillon LRC 对齐的 9 个行首时间（2026-10-31 定向验收实测值）。 */
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
  const root = mkdtempSync(join(tmpdir(), 'p040-catalog-'));
  const mediaRoot = join(root, 'media');
  mkdirSync(join(mediaRoot, 'vocal-import', 'song-1'), { recursive: true });
  const audio = join(mediaRoot, 'vocal-import', 'song-1', 'original.mp3');
  writeFileSync(audio, Buffer.from('fake-audio-bytes-for-catalog-test'));
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

const fakeSha = () => CATALOG_SHA;

test('内置目录：schema 可校验、无歌词载荷、10 段里 2 段争议保持待标注', () => {
  assert.equal(REFERENCE_CATALOG.length, 1);
  const normalized = normalizeReference(PAPILLON);
  assert.equal(normalized.schema, 'p040.structure-reference.v1');
  assert.equal(normalized.candidates.length, 10);
  assert.equal(normalized.audioSha256, CATALOG_SHA);
  assert.equal(normalized.audioDurationMs, DURATION);

  const disputed = normalized.candidates.filter((candidate) => candidate.disputed);
  assert.equal(disputed.length, 2);
  assert.ok(disputed.every((candidate) => candidate.type === 'unknown'));
  assert.deepEqual(disputed.map((candidate) => candidate.alternates), [['refrain', 'verse'], ['refrain', 'verse']]);

  // 重复只作候选提示，没有任何 repeatOf 字段会被服务端当成已确认关系。
  assert.deepEqual(
    normalized.candidates.filter((candidate) => candidate.repeatCandidateOf).map((candidate) => candidate.repeatCandidateOf),
    ['B1', 'A1', 'B1'],
  );
  assert.equal(normalized.candidates.some((candidate) => 'repeatOf' in candidate), false);
  // 目录里不得夹带任何歌词正文字段。
  const raw = JSON.stringify(PAPILLON);
  assert.equal(/"(lyric|lyrics|text|line|lines|lyricText)"/.test(raw), false);
  assert.equal(raw.includes('You got me feeling'), false);
});

test('内置目录 × 本机曲目：五项全过才算匹配，任一项不符都拒绝', () => {
  const reference = normalizeReference(PAPILLON);
  const good = { title: 'Papillon', artist: '王嘉尔', durationMs: DURATION, notes: '' };
  assert.equal(verifyIdentity({ reference, item: good, audioSha256: CATALOG_SHA }).ok, true);

  const cases = [
    ['artist', { ...good, artist: 'BTS' }, CATALOG_SHA, 'IDENTITY_ARTIST_MISMATCH'],
    ['title', { ...good, title: 'Papillon (Live)' }, CATALOG_SHA, 'IDENTITY_VERSION_MISMATCH'],
    ['duration', { ...good, durationMs: DURATION - 20000 }, CATALOG_SHA, 'IDENTITY_DURATION_MISMATCH'],
    ['sha', good, 'b'.repeat(64), 'IDENTITY_AUDIO_SHA_MISMATCH'],
  ];
  for (const [label, item, sha, code] of cases) {
    const result = verifyIdentity({ reference, item, audioSha256: sha });
    assert.equal(result.ok, false, `${label} 不符必须拒绝`);
    assert.ok(result.blockers.some((blocker) => blocker.code === code), `${label} 应给出 ${code}`);
  }
});

test('练歌页目录列表：同曲才出现；同名不同歌手只显示为不匹配，不提供载入', () => withEnv(async ({ db, mediaRoot }) => {
  const papillon = seedVocal(db, mediaRoot, {});
  const matched = listStructureReferences({ db, mediaRoot, getRepertoire, songId: papillon.id, shaProvider: fakeSha });
  assert.equal(matched.entries.length, 1);
  assert.equal(matched.entries[0].id, 'papillon-jackson-wang-studio');
  assert.equal(matched.entries[0].identity.ok, true);
  assert.equal(matched.entries[0].candidateCount, 10);
  assert.equal(matched.entries[0].disputedCount, 2);

  const wrongArtist = seedVocal(db, mediaRoot, { artist: 'BTS' });
  const blocked = listStructureReferences({ db, mediaRoot, getRepertoire, songId: wrongArtist.id, shaProvider: fakeSha });
  assert.equal(blocked.entries.length, 1, '同名歌仍要告诉用户「有一份参考但不匹配」');
  assert.equal(blocked.entries[0].identity.ok, false);
  assert.ok(blocked.entries[0].identity.blockers.some((blocker) => blocker.code === 'IDENTITY_ARTIST_MISMATCH'));

  const other = seedVocal(db, mediaRoot, { title: 'Let Go', artist: '石玺彤', durationMs: 206206 });
  const none = listStructureReferences({ db, mediaRoot, getRepertoire, songId: other.id, shaProvider: fakeSha });
  assert.equal(none.entries.length, 0, '不同歌不出现别人的参考');
}));

test('一键载入：只写草稿、10 段按 LRC 顺序锚定、身份不符整份拒绝', () => withEnv(async ({ db, mediaRoot }) => {
  const legacy = [
    { id: 'section-1', type: 'intro', label: '前奏', startMs: 0, endMs: 12000, source: 'manual' },
    { id: 'section-2', type: 'verse', label: '主歌', startMs: 12000, endMs: DURATION, source: 'manual' },
  ];
  const item = seedVocal(db, mediaRoot, { sections: legacy });
  const before = JSON.stringify(getRepertoire(db, item.id).sections);

  const loaded = setStructureReferenceFromCatalog({
    db, mediaRoot, getRepertoire, songId: item.id, catalogId: 'papillon-jackson-wang-studio', shaProvider: fakeSha,
  });
  assert.equal(loaded.identity.ok, true);
  assert.equal(loaded.draft.reference.candidateCount, 10);
  assert.equal(loaded.draft.map.sections.length, 10);
  assert.deepEqual(
    loaded.draft.map.sections.map((section) => section.startMs),
    [0, 12180, 34650, 57150, 68560, 79870, 103260, 125290, 136400, 147450],
  );
  const disputed = loaded.draft.map.sections.filter((section) => section.disputed);
  assert.equal(disputed.length, 2);
  assert.ok(disputed.every((section) => section.type === 'unknown'));
  // 正式结构一个字节都没变，且还没被保存过。
  assert.equal(JSON.stringify(getRepertoire(db, item.id).sections), before);
  assert.equal(getDraftView({ db, getRepertoire, songId: item.id }).reference.sections.length, 10);

  // 身份不符（这里用错摘要模拟文件被换）→ 409，不落草稿。
  const fresh = seedVocal(db, mediaRoot, { title: 'Let Go', artist: '石玺彤', durationMs: 206206 });
  assert.throws(
    () => setStructureReferenceFromCatalog({
      db, mediaRoot, getRepertoire, songId: fresh.id, catalogId: 'papillon-jackson-wang-studio', shaProvider: fakeSha,
    }),
    /IDENTITY_MISMATCH/,
  );
  assert.equal(readDraft(db, fresh.id), null);

  // 不存在的目录 id 也要明确报错，不能静默。
  assert.throws(
    () => setStructureReferenceFromCatalog({ db, mediaRoot, getRepertoire, songId: item.id, catalogId: 'nope', shaProvider: fakeSha }),
    /REFERENCE_CATALOG_NOT_FOUND/,
  );
}));

test('载入后的草稿要显式确认才落库；争议段不点类型仍是 unknown', () => withEnv(async ({ db, mediaRoot }) => {
  const item = seedVocal(db, mediaRoot, {});
  const loaded = setStructureReferenceFromCatalog({
    db, mediaRoot, getRepertoire, songId: item.id, catalogId: 'papillon-jackson-wang-studio', shaProvider: fakeSha,
  });
  assert.throws(
    () => applyStructureDraft({ db, getRepertoire, saveRepertoire, songId: item.id, map: loaded.draft.map, replaceManual: true }),
    /REFERENCE_CONFIRMATION_REQUIRED/,
  );
  const applied = applyStructureDraft({
    db, getRepertoire, saveRepertoire, songId: item.id, map: loaded.draft.map, replaceManual: true, confirmReference: true,
  });
  assert.equal(applied.applied, 10);
  const saved = getRepertoire(db, item.id).sections;
  assert.ok(saved.every((section) => section.source === 'manual'));
  assert.equal(saved.filter((section) => section.type === 'unknown').length, 2);
  assert.equal(saved.some((section) => section.repeatOf), false, '重复候选不得自动写成 repeatOf');
}));

test('BABE 空结构：从零写入两段人工结构，不要求先有算法段', () => withEnv(async ({ db, mediaRoot }) => {
  const babe = seedVocal(db, mediaRoot, { title: '베베 (BABE)', artist: '泫雅', sections: [], durationMs: 193328 });
  assert.equal(getRepertoire(db, babe.id).sections.length, 0);

  const sections = [
    { id: 'manual-a', type: 'verse', label: 'A1', startMs: 0, endMs: 35200, source: 'manual' },
    { id: 'manual-b', type: 'unknown', label: 'U1', startMs: 35200, endMs: 193328, source: 'manual' },
  ];
  const saved = saveRepertoire(db, babe.id, { sections });
  assert.equal(saved.sections.length, 2);
  assert.ok(saved.sections.every((section) => section.source === 'manual'));
  assert.equal(saved.sections[0].startMs, 0);
  // 目录里没有 BABE 参考，不会冒出任何参考候选或假类型。
  const catalog = listStructureReferences({ db, mediaRoot, getRepertoire, songId: babe.id, shaProvider: fakeSha });
  assert.equal(catalog.entries.length, 0);
}));

test('目录来源标注与可追溯性：保留计划包出处的说明', () => {  const entry = REFERENCE_CATALOG[0];
  assert.match(entry.source, /P040-Structure-Source-Validation-2026-10-31/);
  assert.match(entry.note, /非官方/);
  // 不能把用户真实 LRC 内容写进目录源文件（防止第三方歌词入库）。
  const source = readFileSync(new URL('../server/vocal-structure/reference-catalog.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('You got me feeling'), false);
});

/**
 * 路由层：确认前后端用的是同一条路径。
 * 客户端 `readReferenceCatalog` / `loadCatalogReference` 打的是
 * `…/structure-draft/reference/catalog`，这里用同一路径打一次性 handler，不启动常驻服务。
 */
test('路由路径一致：GET 列表、POST {catalogId} 载入，401 未配对先挡住', () => withEnv(async ({ db, mediaRoot }) => {
  const item = seedVocal(db, mediaRoot, {});
  const handle = mountStructureRoutes({
    db, mediaRoot, getRepertoire, saveRepertoire,
    authorize: (token) => token === 'owner-test',
  });
  assert.ok(handle);

  const call = async ({ method, path, body, token = 'owner-test' }) => {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    const req = {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
    };
    const result = { status: 0, body: '', sent: false };
    const res = {
      writeHead(status) { result.status = status; result.sent = true; },
      end(value) { result.body = String(value ?? ''); },
      get headersSent() { return result.sent; },
    };
    const handled = await handle(req, res, new URL(`http://127.0.0.1${path}`));
    return { handled, ...result, json: result.body ? JSON.parse(result.body) : null };
  };

  const base = `/api/repertoire/${item.id}/structure-draft/reference/catalog`;
  const unauthorized = await call({ method: 'GET', path: base, token: null });
  assert.equal(unauthorized.status, 401);

  const listed = await call({ method: 'GET', path: base });
  assert.equal(listed.status, 200);
  assert.equal(listed.handled, true);
  assert.equal(listed.json.entries.length, 1);
  assert.equal(listed.json.entries[0].id, 'papillon-jackson-wang-studio');

  // 真实文件摘要与目录声明不同 → 路由必须 409，且不写草稿。
  const rejected = await call({ method: 'POST', path: base, body: { catalogId: 'papillon-jackson-wang-studio' } });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.json.error.code, 'IDENTITY_MISMATCH');
  assert.equal(readDraft(db, item.id), null);

  const missing = await call({ method: 'POST', path: base, body: { catalogId: 'no-such-reference' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'REFERENCE_CATALOG_NOT_FOUND');
}));
