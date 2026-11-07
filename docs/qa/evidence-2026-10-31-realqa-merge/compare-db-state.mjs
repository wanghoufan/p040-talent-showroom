#!/usr/bin/env node
/**
 * 对比 P040 real-qa 合并前后快照，只允许「translations_json / revision / 迁移账本 / 缓存 / 新表」变化。
 *
 *   node compare-db-state.mjs <before.json> <after.json> <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [beforePath, afterPath, outPath] = process.argv.slice(2);
const before = JSON.parse(readFileSync(beforePath, 'utf8'));
const after = JSON.parse(readFileSync(afterPath, 'utf8'));

const ADDITIVE = new Set(['schema_migrations', 'vocal_translation_cache', 'vocal_structure_drafts']);
const problems = [];
const notes = [];

// 1) 表与行数
for (const [table, count] of Object.entries(before.tableCounts)) {
  const now = after.tableCounts[table];
  if (now === undefined) { problems.push({ code: 'TABLE_MISSING', table }); continue; }
  if (now !== count) {
    if (ADDITIVE.has(table)) notes.push({ table, before: count, after: now, note: '按设计可增' });
    else problems.push({ code: 'ROW_COUNT_CHANGED', table, before: count, after: now });
  }
}
const newTables = Object.keys(after.tableCounts).filter(table => !(table in before.tableCounts));
for (const table of newTables) {
  if (!ADDITIVE.has(table)) problems.push({ code: 'UNEXPECTED_NEW_TABLE', table, rows: after.tableCounts[table] });
  else notes.push({ table, rows: after.tableCounts[table], note: '迁移新增表' });
}

// 2) 逐曲
const beforeSongs = new Map(before.songs.map(song => [song.id, song]));
const afterSongs = new Map(after.songs.map(song => [song.id, song]));
for (const [id, old] of beforeSongs) {
  const now = afterSongs.get(id);
  if (!now) { problems.push({ code: 'SONG_MISSING', id }); continue; }
  for (const key of ['title', 'artist', 'kind', 'createdAt', 'updatedAt', 'vocalLanguage', 'lyricsDigest', 'lyricsLines']) {
    if (JSON.stringify(old[key]) !== JSON.stringify(now[key])) problems.push({ code: 'FIELD_CHANGED', id, title: old.title, field: key, before: old[key], after: now[key] });
  }
  if (JSON.stringify(old.lyricsLineIds) !== JSON.stringify(now.lyricsLineIds)) problems.push({ code: 'LYRICS_LINE_IDS_CHANGED', id, title: old.title });
}
for (const id of afterSongs.keys()) if (!beforeSongs.has(id)) problems.push({ code: 'SONG_ADDED', id });

// 3) 译文变化（只允许这 5 首）
const translated = after.songs.filter(song => (song.translation?.lines ?? 0) > 0);
const revisions = [];
for (const [id, old] of beforeSongs) {
  const now = afterSongs.get(id);
  if (!now) continue;
  const delta = now.revision - old.revision;
  if (delta !== 0) revisions.push({ id, title: old.title, before: old.revision, after: now.revision, delta });
}
const translatedIds = new Set(translated.map(song => song.id));
for (const item of revisions) {
  if (!translatedIds.has(item.id)) problems.push({ code: 'UNEXPECTED_REVISION_BUMP', ...item });
  if (item.delta !== 1) problems.push({ code: 'REVISION_DELTA_NOT_1', ...item });
}

const payload = {
  comparedAt: new Date().toISOString(),
  before: beforePath, after: afterPath,
  migrations: { before: before.migrations.length, after: after.migrations.length, added: after.migrations.filter(v => !before.migrations.includes(v)) },
  translatedSongs: translated.map(song => ({ id: song.id, title: song.title, lines: song.translation.lines, manual: song.translation.manual, ai: song.translation.ai, lrc: song.translation.lrc })),
  revisions,
  notes,
  problems,
  ok: problems.length === 0,
};
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify({ ok: payload.ok, problems: payload.problems, translated: payload.translatedSongs.length, revisions: payload.revisions.length, notes: payload.notes.length }, null, 2));
