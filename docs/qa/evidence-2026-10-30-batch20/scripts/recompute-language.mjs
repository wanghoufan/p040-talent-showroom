#!/usr/bin/env node
/**
 * 语言标签复算（只读 dry-run）。
 *
 * 用新的 `detectLanguage` 对库里已存的 `lyrics_json` 重新判定语言，输出「旧 → 新」对照表。
 * 默认只打印，不改任何数据；`--apply` 才会逐条调用公开接口 `PATCH /api/repertoire/:id/vocal`
 * 写回语言（不碰音频、歌词、结构），且每条都会先打印旧值。
 *
 * 用法：
 *   node docs/qa/evidence-2026-10-30-batch20/scripts/recompute-language.mjs            # dry-run
 *   API=... TOKEN_FILE=... node .../recompute-language.mjs --apply                     # 写回
 */
import { readFileSync } from 'node:fs';
import { detectLanguage, lyricScriptCounts } from '../../../../server/vocal-import/canonical.mjs';

const DB = process.env.SQLITE_DB_PATH ?? 'var/vocal-v31-work/real-qa-20261030/db/qa.db';
const API = process.env.API ?? '';
const TOKEN_FILE = process.env.TOKEN_FILE ?? '';
const APPLY = process.argv.includes('--apply');

const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(DB, { readOnly: true });
const rows = db
  .prepare(
    `SELECT id,title,artist,vocal_language,lyrics_json
       FROM repertoire_items
      WHERE kind='VOCAL' AND deleted_at IS NULL
      ORDER BY created_at`,
  )
  .all();
db.close();

const parse = (value) => {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const token = TOKEN_FILE ? readFileSync(TOKEN_FILE, 'utf8').trim() : '';
const table = [];
for (const row of rows) {
  const lyrics = parse(row.lyrics_json);
  if (!lyrics.length) {
    table.push({ id: row.id, title: row.title, artist: row.artist, old: row.vocal_language ?? null, next: null, changed: false, lines: 0, note: '无歌词，跳过' });
    continue;
  }
  const text = lyrics.map((line) => String(line?.text ?? '')).join('\n');
  const next = detectLanguage({ lyrics: text });
  const counts = lyricScriptCounts(text);
  table.push({
    id: row.id,
    title: row.title,
    artist: row.artist,
    old: row.vocal_language ?? null,
    next,
    changed: (row.vocal_language ?? null) !== next,
    lines: lyrics.length,
    counts,
  });
}

const changed = table.filter((row) => row.changed);
console.log(JSON.stringify({ at: new Date().toISOString(), db: DB, total: table.length, changed: changed.length, table }, null, 2));

if (APPLY) {
  if (!API || !TOKEN_FILE) throw new Error('--apply 需要 API 与 TOKEN_FILE 环境变量');
  const todo = changed.filter((row) => row.next);
  for (const row of todo) {
    const response = await fetch(`${API}/api/repertoire/${row.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: row.next }),
      signal: AbortSignal.timeout(20000),
    });
    console.error(`PATCH ${row.id} ${row.old} -> ${row.next} : ${response.status}`);
    if (!response.ok) throw new Error(`PATCH failed ${response.status}`);
  }
  console.error(`applied ${todo.length}`);
}
