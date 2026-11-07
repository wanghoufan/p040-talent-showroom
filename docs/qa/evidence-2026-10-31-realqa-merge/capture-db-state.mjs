#!/usr/bin/env node
/**
 * 只读抓取 P040 real-qa 库状态，用于合并前后逐曲对比。
 * 不写库、不读凭据内容（只统计行数）。
 *
 *   node docs/qa/evidence-2026-10-31-realqa-merge/capture-db-state.mjs <db> <out.json>
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [dbPath, outPath] = process.argv.slice(2);
if (!dbPath || !outPath) {
  console.error('用法: node capture-db-state.mjs <db> <out.json>');
  process.exit(2);
}

const sha256 = value => createHash('sha256').update(String(value ?? '')).digest('hex');
const db = new DatabaseSync(dbPath, { readOnly: true });

const columns = db.prepare('PRAGMA table_info(repertoire_items)').all().map(row => row.name);
const hasTranslations = columns.includes('translations_json');

const migrations = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
const counts = {};
for (const { name } of tables) {
  counts[name] = db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n;
}

const songs = db.prepare(`SELECT id, title, artist, kind, revision, updated_at, created_at, lyrics_json, vocal_language ${hasTranslations ? ', translations_json' : ''} FROM repertoire_items ORDER BY id`).all()
  .map(row => {
    const lyrics = (() => { try { return JSON.parse(row.lyrics_json || '[]'); } catch { return []; } })();
    let translation = null;
    if (hasTranslations) {
      const doc = (() => { try { return JSON.parse(row.translations_json || '{}'); } catch { return {}; } })();
      const lines = Array.isArray(doc.lines) ? doc.lines : [];
      translation = {
        lines: lines.length,
        manual: lines.filter(line => line.source === 'manual').length,
        ai: lines.filter(line => line.source === 'ai').length,
        lrc: lines.filter(line => line.source === 'lrc').length,
        lineIds: lines.map(line => line.id).sort(),
        updatedAt: doc.updatedAt ?? null,
        provider: doc.provider ?? null,
        model: doc.model ?? null,
      };
    }
    return {
      id: row.id, title: row.title, artist: row.artist, kind: row.kind,
      revision: row.revision, updatedAt: row.updated_at, createdAt: row.created_at,
      vocalLanguage: row.vocal_language,
      lyricsLines: lyrics.length,
      lyricsLineIds: lyrics.map(line => line.id),
      lyricsDigest: sha256(row.lyrics_json),
      translation,
    };
  });

const columnsDigest = sha256(columns.join('|'));
db.close();

const payload = {
  capturedAt: new Date().toISOString(),
  db: dbPath,
  migrations,
  hasTranslationsColumn: hasTranslations,
  repertoireColumnsDigest: columnsDigest,
  tableCounts: counts,
  songs,
};
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify({
  out: outPath, migrations: migrations.length, hasTranslationsColumn: hasTranslations,
  tables: Object.keys(counts).length, songs: songs.length,
  vocal: songs.filter(song => song.kind === 'VOCAL').length,
  translated: songs.filter(song => song.translation && song.translation.lines > 0).length,
}, null, 2));
