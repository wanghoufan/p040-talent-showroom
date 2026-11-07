#!/usr/bin/env node
/**
 * 逐行核对：目标库 5 首译文是否与译文源库完全一致（按 id 对齐，比较 id/text/source）。
 * 只读打开两个库。
 *
 *   node verify-translation-parity.mjs <source.db> <target.db> <out.json>
 */
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [sourcePath, targetPath, outPath] = process.argv.slice(2);
const source = new DatabaseSync(sourcePath, { readOnly: true });
const target = new DatabaseSync(targetPath, { readOnly: true });

const parse = raw => { try { return JSON.parse(raw || '{}'); } catch { return {}; } };

const sourceSongs = source.prepare("SELECT id, title, lyrics_json, translations_json FROM repertoire_items WHERE kind='VOCAL' AND translations_json NOT IN ('','{}') ORDER BY title").all();
const results = [];
let totalLines = 0;
let mismatches = 0;

for (const song of sourceSongs) {
  const targetRow = target.prepare('SELECT id, title, lyrics_json, translations_json FROM repertoire_items WHERE id=?').get(song.id);
  if (!targetRow) { results.push({ id: song.id, title: song.title, missingInTarget: true }); mismatches += 1; continue; }
  const sourceDoc = parse(song.translations_json);
  const targetDoc = parse(targetRow.translations_json);
  const sourceLines = new Map((sourceDoc.lines || []).map(line => [line.id, line]));
  const targetLines = new Map((targetDoc.lines || []).map(line => [line.id, line]));
  const sourceLyrics = new Map((parse(song.lyrics_json).lines || []).map(line => [line.id, line.text]));
  const targetLyrics = new Map((parse(targetRow.lyrics_json).lines || []).map(line => [line.id, line.text]));
  const diff = [];
  for (const [id, line] of sourceLines) {
    const now = targetLines.get(id);
    if (!now) { diff.push({ lineId: id, kind: 'MISSING_IN_TARGET' }); continue; }
    if ((line.text ?? '') !== (now.text ?? '')) diff.push({ lineId: id, kind: 'TEXT_DIFF', source: line.text ?? null, target: now.text ?? null });
    if ((line.source ?? '') !== (now.source ?? '')) diff.push({ lineId: id, kind: 'SOURCE_KIND_DIFF', source: line.source ?? null, target: now.source ?? null });
  }
  for (const id of targetLines.keys()) if (!sourceLines.has(id)) diff.push({ lineId: id, kind: 'EXTRA_IN_TARGET' });
  const lyricsDiff = [...targetLyrics].filter(([id, text]) => sourceLyrics.get(id) !== text).map(([id]) => id);
  totalLines += sourceLines.size;
  mismatches += diff.length + lyricsDiff.length;
  results.push({
    id: song.id, title: song.title,
    sourceLines: sourceLines.size, targetLines: targetLines.size,
    /** 源库该行在本库找不到或原文不同 → 说明不是同一条歌词 */
    identical: diff.length === 0 && lyricsDiff.length === 0,
    diffs: diff, lyricsDiff,
  });
}

source.close();
target.close();
const payload = { checkedAt: new Date().toISOString(), source: sourcePath, target: targetPath, songs: results, totalLines, mismatches, ok: mismatches === 0 && results.every(item => item.identical) };
if (outPath) writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify({ ok: payload.ok, songs: results.length, totalLines, mismatches, perSong: results.map(item => ({ title: item.title, lines: item.sourceLines, identical: item.identical })) }, null, 2));
