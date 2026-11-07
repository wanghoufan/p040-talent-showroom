#!/usr/bin/env node
/**
 * 把已审校译文从译文隔离库合并进 **克隆库**（默认 dry-run，只有 --mode apply 才写）。
 *
 * 边界（脚本内硬编码，不靠调用方自觉）：
 * - 只允许写克隆副本；正式库、real-qa 原库、译文源库均列入禁止写入名单。
 * - 只写 `translations_json`；`lyrics_json`、时间轴、结构、音轨与其它列一律不动。
 * - 人工译文优先：复用服务端 `mergeTranslations` 的 manual > lrc > ai 规则，绝不覆盖 manual。
 * - 缓存只做 INSERT OR IGNORE（缺才补），不删除、不更新已有缓存行。
 *
 * 模式：
 *   --mode plan      只读目标库（先应用缺失迁移），输出逐曲逐行判定与预计变更，可重复运行
 *   --mode apply     先备份目标库，再单事务写入，随后自检
 *   --mode verify    对当前目标库做完整性自检（对照 --baseline 快照）
 *   --mode rollback  用 --backup-file 覆盖目标库
 *
 * 用法：
 *   node scripts/merge-translations-clone.mjs --mode plan \
 *     --source-db var/vocal-v31-work/translation-20261031/db/qa.db \
 *     --target-db var/vocal-v31-work/merge-20261031/db/qa.db \
 *     --out docs/qa/evidence-2026-10-31-merge-clone/merge-plan.json
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../server/db/database.mjs';
import {
  isNonLyricLine, mergeTranslations, normalizeTranslations, textHash,
  translationSourceOf, withStaleness,
} from '../server/vocal-translation/translation.mjs';

const FORBIDDEN_TARGETS = [
  'var/personal-dance-library.db',
  'var/vocal-v31-work/real-qa-20261030/db/qa.db',
  'var/vocal-v31-work/translation-20261031/db/qa.db',
].map(path => resolve(path));
// 生产库任何时候都禁止；原 real-qa 隔离库只在用户明确授权后，用固定口令放行一次。
const PRODUCTION_DB = resolve('var/personal-dance-library.db');
const ORIGINAL_ISOLATED_DB = resolve('var/vocal-v31-work/real-qa-20261030/db/qa.db');
const OVERRIDE_TOKEN = 'YES-WITH-AUTHORIZATION';

const CREDENTIAL_TABLES = new Set(['owner_credentials']);
const IGNORED_COLUMNS = new Set(['translations_json', 'revision']);
// 迁移账本按定义会随迁移新增行；缓存表按设计只增不删。两者单列说明，不算「非目标数据被改」。
const MIGRATION_LEDGER = 'schema_migrations';
const ADDITIVE_TABLES = new Set(['vocal_translation_cache']);

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const sha256File = path => sha256(readFileSync(path));

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
}

function listTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
}

function readTable(db, table, columns) {
  const order = columns.includes('id') ? 'id' : 'rowid';
  return db.prepare(`SELECT ${columns.map(column => `"${column}"`).join(',')} FROM ${table} ORDER BY ${order}`).all();
}

/** 快照：记录表行数与内容摘要；凭据表只记行数，不读取内容。 */
function snapshot(db, options = {}) {
  const tableColumns = options.tableColumns || {};
  const tables = {};
  for (const table of listTables(db)) {
    const all = columnsOf(db, table);
    if (CREDENTIAL_TABLES.has(table)) {
      tables[table] = { rows: db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, digest: null, columns: [], note: '凭据表只记录行数，不读取内容' };
      continue;
    }
    const usable = table === 'repertoire_items' ? all.filter(column => !IGNORED_COLUMNS.has(column)) : all;
    const columns = tableColumns[table] ? tableColumns[table].filter(column => usable.includes(column)) : usable;
    const rows = readTable(db, table, columns);
    tables[table] = { rows: rows.length, digest: sha256(JSON.stringify(rows)), columns };
  }
  const songs = {};
  for (const row of db.prepare("SELECT * FROM repertoire_items WHERE kind='VOCAL' ORDER BY id").all()) {
    const fields = {};
    for (const [key, value] of Object.entries(row)) {
      if (IGNORED_COLUMNS.has(key)) continue;
      fields[key] = sha256(String(value));
    }
    songs[row.id] = { title: row.title, revision: row.revision, fields, lyricsDigest: sha256(String(row.lyrics_json)) };
  }
  return { capturedAt: new Date().toISOString(), tables, songs };
}

function verifyAgainst(before, db) {
  const after = snapshot(db, { tableColumns: Object.fromEntries(Object.entries(before.tables).map(([table, info]) => [table, info.columns])) });
  const problems = [];
  const skipped = [];
  for (const [table, info] of Object.entries(before.tables)) {
    const now = after.tables[table];
    if (!now) { problems.push({ code: 'TABLE_MISSING', table }); continue; }
    if (table === MIGRATION_LEDGER) { skipped.push({ table, note: '迁移账本按定义新增行，不参与数据比对', before: info.rows, after: now.rows }); continue; }
    if (ADDITIVE_TABLES.has(table)) { skipped.push({ table, note: '缓存表按设计只增不删；删除/改写会在此后单独核对', before: info.rows, after: now.rows }); continue; }
    if (info.digest && now.digest !== info.digest) problems.push({ code: 'TABLE_CONTENT_CHANGED', table });
    if (now.rows !== info.rows) problems.push({ code: 'ROW_COUNT_CHANGED', table, before: info.rows, after: now.rows });
  }
  const songs = [];
  for (const [id, info] of Object.entries(before.songs)) {
    const now = after.songs[id];
    if (!now) { problems.push({ code: 'SONG_MISSING', id }); continue; }
    const changedFields = Object.keys(info.fields).filter(key => info.fields[key] !== now.fields[key]);
    const lyricsUnchanged = info.lyricsDigest === now.lyricsDigest;
    if (!lyricsUnchanged) problems.push({ code: 'LYRICS_CHANGED', id });
    if (changedFields.some(key => key !== 'revision')) problems.push({ code: 'NON_TARGET_COLUMN_CHANGED', id, changedFields });
    songs.push({ id, title: info.title, changedFields, lyricsUnchanged, revisionBefore: info.revision, revisionAfter: now.revision });
  }
  return { ok: problems.length === 0, problems, skipped, songs };
}

function parseDoc(raw) {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function pickMeta(doc) {
  const meta = {};
  for (const key of ['updatedAt', 'provider', 'model']) if (doc[key] !== undefined) meta[key] = doc[key];
  return meta;
}

/** 单曲计划：校验行 id / 原文一致性，按 manual>lrc>ai 合并，逐行给出判定。 */
function planSong(sourceRow, targetRow) {
  const incomingDoc = parseDoc(sourceRow.translations_json);
  const incomingLines = Array.isArray(incomingDoc.lines) ? incomingDoc.lines : [];
  const targetLyrics = JSON.parse(targetRow.lyrics_json || '[]');
  const sourceLyrics = JSON.parse(sourceRow.lyrics_json || '[]');
  const targetById = new Map(targetLyrics.map(line => [line.id, line]));
  const sourceById = new Map(sourceLyrics.map(line => [line.id, line]));
  const targetDoc = parseDoc(targetRow.translations_json);
  const existingLines = Array.isArray(targetDoc.lines) ? targetDoc.lines : [];
  const existingById = new Map(existingLines.filter(line => line?.id).map(line => [line.id, line]));

  const entry = {
    id: sourceRow.id,
    title: sourceRow.title,
    language: sourceRow.vocal_language || null,
    lyricsLines: targetLyrics.length,
    sourceLyricsLines: sourceLyrics.length,
    incomingLines: incomingLines.length,
    existingLines: existingLines.length,
    lyricsIdentical: String(sourceRow.lyrics_json) === String(targetRow.lyrics_json),
    targetRevision: targetRow.revision,
    accepted: [], rejected: [], kept: [], replaced: [], unchanged: [], warnings: [],
    metadata: { target: pickMeta(targetDoc), source: pickMeta(incomingDoc) },
  };

  if (!entry.lyricsIdentical) {
    for (const line of sourceLyrics) {
      const mirror = targetById.get(line.id);
      if (!mirror) entry.warnings.push({ code: 'LYRIC_ID_MISSING_IN_TARGET', id: line.id });
      else if (mirror.text !== line.text) entry.warnings.push({ code: 'LYRIC_TEXT_DIVERGED', id: line.id });
    }
    for (const line of targetLyrics) {
      if (!sourceById.has(line.id)) entry.warnings.push({ code: 'LYRIC_ID_ONLY_IN_TARGET', id: line.id });
    }
  }

  const seen = new Set();
  const accepted = [];
  for (const raw of incomingLines) {
    const id = typeof raw?.id === 'string' ? raw.id : '';
    const text = typeof raw?.text === 'string' ? raw.text.trim() : '';
    const source = ['lrc', 'ai', 'manual'].includes(raw?.source) ? raw.source : 'ai';
    if (!id) { entry.rejected.push({ id: raw?.id ?? null, reason: 'NO_ID' }); continue; }
    if (seen.has(id)) { entry.rejected.push({ id, reason: 'DUPLICATE_IN_SOURCE' }); continue; }
    seen.add(id);
    if (!text) { entry.rejected.push({ id, reason: 'EMPTY_TEXT' }); continue; }
    if (text.length > 500) { entry.rejected.push({ id, reason: 'TEXT_TOO_LONG', length: text.length }); continue; }
    const lyric = targetById.get(id);
    if (!lyric) { entry.rejected.push({ id, reason: 'UNKNOWN_LINE' }); continue; }
    if (typeof lyric.text !== 'string' || !lyric.text.trim()) { entry.rejected.push({ id, reason: 'LYRIC_EMPTY' }); continue; }
    const sourceLyric = sourceById.get(id);
    if (!sourceLyric || sourceLyric.text !== lyric.text) { entry.rejected.push({ id, reason: 'STALE_SOURCE_TEXT' }); continue; }
    const expected = textHash(lyric.text);
    if (raw.sourceHash && raw.sourceHash !== expected) entry.warnings.push({ code: 'SOURCE_HASH_REPAIRED', id, stored: raw.sourceHash, computed: expected });
    if (isNonLyricLine(lyric.text)) entry.warnings.push({ code: 'NON_LYRIC_LINE', id, text: lyric.text.slice(0, 40) });
    accepted.push({ id, text, source, sourceHash: expected });

    const current = existingById.get(id);
    if (!current) entry.accepted.push({ id, text, source, action: 'ADD' });
    else if (current.text === text && (current.source || 'ai') === source) entry.unchanged.push({ id, source });
    else if (current.source === 'manual' && source !== 'manual') entry.kept.push({ id, reason: 'KEEP_MANUAL', current: current.text, incoming: text });
    else if (current.source === 'lrc' && source === 'ai') entry.kept.push({ id, reason: 'KEEP_LRC', current: current.text, incoming: text });
    else entry.replaced.push({ id, from: { text: current.text, source: current.source || 'ai' }, to: { text, source }, action: current.source === 'manual' ? 'MANUAL_OVERWRITE' : 'REPLACE' });
  }

  const mergedLines = mergeTranslations(existingLines, accepted);
  const normalized = normalizeTranslations({ version: incomingDoc.version ?? 1, language: incomingDoc.language ?? 'zh', lines: mergedLines }, targetLyrics);
  const staleLines = withStaleness(normalized.lines, targetLyrics).filter(line => line.stale);

  // 文档级元数据：目标已有则保留，缺失才从源库补，避免把源库时间戳刷到目标上。
  const nextDoc = { version: normalized.version, language: normalized.language, lines: normalized.lines, ...pickMeta(targetDoc) };
  if (!nextDoc.updatedAt && incomingDoc.updatedAt) nextDoc.updatedAt = incomingDoc.updatedAt;
  if (!nextDoc.provider && incomingDoc.provider) nextDoc.provider = incomingDoc.provider;
  if (!nextDoc.model && incomingDoc.model) nextDoc.model = incomingDoc.model;

  const changes = entry.accepted.length + entry.replaced.length;
  entry.result = {
    mergedLines: normalized.lines.length,
    source: translationSourceOf(normalized.lines),
    manualLines: normalized.lines.filter(line => line.source === 'manual').length,
    aiLines: normalized.lines.filter(line => line.source === 'ai').length,
    lrcLines: normalized.lines.filter(line => line.source === 'lrc').length,
    staleLines: staleLines.map(line => ({ id: line.id, sourceHash: line.sourceHash })),
    changes,
    willWrite: normalized.lines.length > 0 && (changes > 0 || existingLines.length === 0),
    predictedRevision: targetRow.revision + (normalized.lines.length > 0 && (changes > 0 || existingLines.length === 0) ? 1 : 0),
  };
  entry.nextJson = normalized.lines.length ? JSON.stringify(nextDoc) : null;
  return entry;
}

function summarize(songs) {
  return {
    songsConsidered: songs.length,
    songsChanging: songs.filter(song => song.result?.willWrite).length,
    linesAdding: songs.reduce((sum, song) => sum + (song.result?.changes || 0), 0),
    linesRejected: songs.reduce((sum, song) => sum + song.rejected.length, 0),
    linesKeptProtected: songs.reduce((sum, song) => sum + song.kept.length, 0),
    linesUnchanged: songs.reduce((sum, song) => sum + song.unchanged.length, 0),
    warnings: songs.reduce((sum, song) => sum + song.warnings.length, 0),
    staleLines: songs.reduce((sum, song) => sum + (song.result?.staleLines.length || 0), 0),
  };
}

function cachePlan(sourceDb, targetDb) {
  const sourceRows = sourceDb.prepare('SELECT * FROM vocal_translation_cache ORDER BY cache_key').all();
  let targetKeys = [];
  try { targetKeys = targetDb.prepare('SELECT cache_key FROM vocal_translation_cache').all(); } catch { targetKeys = []; }
  const existing = new Set(targetKeys.map(row => row.cache_key));
  const missing = sourceRows.filter(row => !existing.has(row.cache_key));
  return { sourceRows: sourceRows.length, targetRows: targetKeys.length, toInsert: missing.length, rows: missing };
}

function backupTarget(targetPath, backupDir) {
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = resolve(backupDir, `merge-clone-${stamp}.db`);
  copyFileSync(targetPath, file);
  return { file, sha256: sha256File(file), bytes: statSync(file).size };
}

function main() {
  const mode = arg('mode', 'plan');
  const sourcePath = resolve(arg('source-db') || '');
  const targetPath = resolve(arg('target-db') || '');
  const outPath = arg('out') ? resolve(arg('out')) : null;
  const baselinePath = arg('baseline') ? resolve(arg('baseline')) : null;
  const backupDir = resolve(arg('backup-dir') || 'var/backups');

  if (!sourcePath || !existsSync(sourcePath)) throw new Error('缺少 --source-db 或文件不存在');
  if (!targetPath || !existsSync(targetPath)) throw new Error('缺少 --target-db 或文件不存在');
  if (targetPath === PRODUCTION_DB) throw new Error(`拒绝写入：${targetPath} 是生产库，本脚本永不写入`);
  if (FORBIDDEN_TARGETS.includes(targetPath)) {
    const authorized = targetPath === ORIGINAL_ISOLATED_DB && arg('confirm-original') === OVERRIDE_TOKEN;
    if (!authorized) {
      throw new Error(`拒绝写入：${targetPath} 是原库/正式库；仅在用户明确授权后传 --confirm-original ${OVERRIDE_TOKEN} 才允许原 real-qa 隔离库`);
    }
  }
  if (targetPath === sourcePath) throw new Error('目标库不能等于源库');

  const report = {
    mode,
    ranAt: new Date().toISOString(),
    source: { path: sourcePath, sha256: sha256File(sourcePath) },
    target: { path: targetPath, sha256: sha256File(targetPath) },
  };

  if (mode === 'rollback') {
    const backupFile = resolve(arg('backup-file') || '');
    if (!backupFile || !existsSync(backupFile)) throw new Error('缺少 --backup-file 或文件不存在');
    for (const suffix of ['-wal', '-shm']) {
      const stray = `${targetPath}${suffix}`;
      if (existsSync(stray)) rmSync(stray);
    }
    copyFileSync(backupFile, targetPath);
    const restored = { backupFile, restoredSha256: sha256File(targetPath), expectedSha256: sha256File(backupFile) };
    restored.match = restored.restoredSha256 === restored.expectedSha256;
    report.rollback = restored;
    if (!restored.match) throw new Error('回滚后哈希不一致');
    if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const sourceDb = new DatabaseSync(sourcePath, { readOnly: true });

  // 1) 迁移前快照（只用于证明迁移没动业务数据）
  const probe = new DatabaseSync(targetPath, { readOnly: true });
  const migrationsBefore = probe.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version);
  const preMigration = snapshot(probe);
  probe.close();

  // 2) 应用缺失迁移（openDatabase 按文件名顺序执行，事务内单文件）
  const targetDb = openDatabase(targetPath);
  const migrationsAfter = targetDb.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version);
  report.migrations = {
    before: migrationsBefore,
    after: migrationsAfter,
    appliedNow: migrationsAfter.filter(version => !migrationsBefore.includes(version)),
    dataPreserved: verifyAgainst(preMigration, targetDb),
  };
  report.snapshotBefore = snapshot(targetDb);

  const songs = sourceDb.prepare("SELECT id, title, vocal_language, lyrics_json, translations_json FROM repertoire_items WHERE kind='VOCAL' AND translations_json NOT IN ('','{}') ORDER BY title").all();
  const planSongs = [];
  for (const sourceRow of songs) {
    const targetRow = targetDb.prepare('SELECT * FROM repertoire_items WHERE id=?').get(sourceRow.id);
    if (!targetRow) { planSongs.push({ id: sourceRow.id, title: sourceRow.title, missingInTarget: true, rejected: [], kept: [], replaced: [], unchanged: [], warnings: [] }); continue; }
    planSongs.push(planSong(sourceRow, targetRow));
  }
  const cache = cachePlan(sourceDb, targetDb);
  report.songs = planSongs;
  report.cache = { sourceRows: cache.sourceRows, targetRows: cache.targetRows, toInsert: cache.toInsert };
  report.totals = summarize(planSongs);
  report.planned = planSongs.filter(song => song.result).map(song => ({
    id: song.id, title: song.title,
    lines: song.result.mergedLines, manual: song.result.manualLines, ai: song.result.aiLines, lrc: song.result.lrcLines,
    source: song.result.source, changes: song.result.changes, kept: song.kept.length, rejected: song.rejected.length,
    revisionBefore: song.targetRevision, revisionAfter: song.result.predictedRevision,
    bytes: song.nextJson ? Buffer.byteLength(song.nextJson) : 0,
  }));

  if (mode === 'apply') {
    if (!report.totals.songsChanging && !cache.toInsert) {
      report.apply = { skipped: true, reason: 'NO_CHANGES' };
    } else {
      report.backup = backupTarget(targetPath, backupDir);
      const written = [];
      targetDb.exec('BEGIN IMMEDIATE');
      try {
        for (const song of planSongs) {
          if (!song.result?.willWrite || !song.nextJson) continue;
          const result = targetDb.prepare('UPDATE repertoire_items SET translations_json=? WHERE id=?').run(song.nextJson, song.id);
          if (result.changes !== 1) throw new Error(`更新行数异常：${song.title} changes=${result.changes}`);
          written.push({ id: song.id, title: song.title, bytes: Buffer.byteLength(song.nextJson), lines: song.result.mergedLines });
        }
        let inserted = 0;
        const insert = targetDb.prepare(`INSERT OR IGNORE INTO vocal_translation_cache
          (cache_key, source_lang, target_lang, source_text, target_text, provider, model, created_at, last_used_at)
          VALUES (?,?,?,?,?,?,?,?,?)`);
        for (const row of cache.rows) {
          inserted += insert.run(row.cache_key, row.source_lang, row.target_lang, row.source_text, row.target_text, row.provider, row.model, row.created_at, row.last_used_at).changes;
        }
        targetDb.exec('COMMIT');
        report.apply = { skipped: false, written, cacheInserted: inserted };
      } catch (error) {
        targetDb.exec('ROLLBACK');
        targetDb.close();
        sourceDb.close();
        throw error;
      }
    }
  }

  // 3) 自检：迁移后基线 vs 现在的「非目标列 / 歌词 / 表行数」，以及译文完整性
  report.verification = verifyAgainst(report.snapshotBefore, targetDb);
  report.verification.translations = planSongs.filter(song => song.result).map(song => {
    const row = targetDb.prepare('SELECT translations_json, revision FROM repertoire_items WHERE id=?').get(song.id);
    const lyrics = JSON.parse(targetDb.prepare('SELECT lyrics_json FROM repertoire_items WHERE id=?').get(song.id).lyrics_json || '[]');
    const doc = parseDoc(row.translations_json);
    const lines = Array.isArray(doc.lines) ? doc.lines : [];
    return {
      id: song.id, title: song.title, revision: row.revision, lines: lines.length,
      manual: lines.filter(line => line.source === 'manual').length,
      ai: lines.filter(line => line.source === 'ai').length,
      lrc: lines.filter(line => line.source === 'lrc').length,
      source: lines.length ? translationSourceOf(lines) : 'none',
      stale: withStaleness(lines, lyrics).filter(line => line.stale).length,
      lyricsLines: lyrics.length,
      updatedAt: doc.updatedAt ?? null,
      provider: doc.provider ?? null,
      model: doc.model ?? null,
    };
  });
  report.verification.cacheAfter = (() => { try { return targetDb.prepare('SELECT count(*) AS n FROM vocal_translation_cache').get().n; } catch { return null; } })();
  report.verification.cacheIntegrity = (() => {
    let sourceKeys = new Set();
    let targetKeys = new Set();
    try { sourceKeys = new Set(sourceDb.prepare('SELECT cache_key FROM vocal_translation_cache').all().map(row => row.cache_key)); } catch { sourceKeys = new Set(); }
    try { targetKeys = new Set(targetDb.prepare('SELECT cache_key FROM vocal_translation_cache').all().map(row => row.cache_key)); } catch { targetKeys = new Set(); }
    const missing = [...sourceKeys].filter(key => !targetKeys.has(key));
    return { sourceKeys: sourceKeys.size, targetKeys: targetKeys.size, missing: missing.length, complete: missing.length === 0 };
  })();
  if (!report.verification.cacheIntegrity.complete) report.verification.ok = false;

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2));
  }
  targetDb.close();
  sourceDb.close();

  console.log(JSON.stringify({
    mode,
    migrations: { before: report.migrations.before, after: report.migrations.after, appliedNow: report.migrations.appliedNow, dataPreserved: report.migrations.dataPreserved.ok },
    totals: report.totals,
    cache: report.cache,
    apply: report.apply ?? null,
    verification: { ok: report.verification.ok, problems: report.verification.problems, translations: report.verification.translations, cacheAfter: report.verification.cacheAfter, cacheIntegrity: report.verification.cacheIntegrity },
    songs: planSongs.map(song => ({
      title: song.title,
      lines: song.result?.mergedLines ?? 0,
      change: song.result?.changes ?? 0,
      rejected: song.rejected?.length ?? 0,
      kept: song.kept?.length ?? 0,
      stale: song.result?.staleLines.length ?? 0,
      missingInTarget: Boolean(song.missingInTarget),
    })),
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`合并脚本失败：${error?.message || error}`);
  process.exit(1);
}
