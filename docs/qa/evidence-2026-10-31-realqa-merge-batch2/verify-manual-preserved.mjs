#!/usr/bin/env node
/**
 * 核对「合并前已存在的人工译文行」在合并后仍原样存在（text / source 均不变）。
 * 只读打开目标库。
 *
 *   node verify-manual-preserved.mjs <db> <manual-before.json> <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [dbPath, beforePath, outPath] = process.argv.slice(2);
const before = JSON.parse(readFileSync(beforePath, 'utf8'));
const db = new DatabaseSync(dbPath, { readOnly: true });

const parse = raw => { try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

let checked = 0;
const problems = [];
const perSong = [];
const afterTotals = { songs: 0, manual: 0, ai: 0, lrc: 0 };

for (const song of before.songs) {
  const row = db.prepare('SELECT translations_json FROM repertoire_items WHERE id=?').get(song.id);
  const lines = new Map((parse(row?.translations_json).lines || []).map(line => [line.id, line]));
  let afterManual = 0;
  for (const line of lines.values()) if (line.source === 'manual') afterManual += 1;
  afterTotals.songs += 1;
  afterTotals.manual += afterManual;
  for (const line of lines.values()) { if (line.source === 'ai') afterTotals.ai += 1; if (line.source === 'lrc') afterTotals.lrc += 1; }
  perSong.push({ title: song.title, beforeManual: song.manual.length, afterManual });
  for (const line of song.manual) {
    checked += 1;
    const now = lines.get(line.id);
    if (!now) problems.push({ song: song.title, lineId: line.id, code: 'MANUAL_LINE_LOST' });
    else if (now.source !== 'manual') problems.push({ song: song.title, lineId: line.id, code: 'MANUAL_SOURCE_DOWNGRADED', now: now.source });
    else if ((now.text ?? '') !== line.text) problems.push({ song: song.title, lineId: line.id, code: 'MANUAL_TEXT_CHANGED', before: line.text, after: now.text ?? null });
  }
}
db.close();

const payload = {
  checkedAt: new Date().toISOString(), db: dbPath, before: beforePath,
  beforeTotals: before.totals, afterTotals, checkedManualLines: checked, perSong,
  problems, ok: problems.length === 0,
};
if (outPath) writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify({ ok: payload.ok, checkedManualLines: checked, afterTotals, problems }, null, 2));
