#!/usr/bin/env node
/**
 * 逐行核对 v2：目标库译文是否与译文源库一致（按 id 对齐，比较 text/source），
 * 并正确解析 lyrics_json（顶层数组）比对原歌词。
 * 只读打开两个库。
 *
 *   node verify-parity-v2.mjs <source.db> <target.db> <out.json>
 */
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [sourcePath, targetPath, outPath] = process.argv.slice(2);
const source = new DatabaseSync(sourcePath, { readOnly: true });
const target = new DatabaseSync(targetPath, { readOnly: true });

const parseDoc = raw => { try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const parseLyrics = raw => { try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

const sourceSongs = source.prepare("SELECT id, title, lyrics_json, translations_json FROM repertoire_items WHERE kind='VOCAL' ORDER BY title").all();
const results = [];
let totalLines = 0;
let mismatches = 0;
let songsWithSourceTranslation = 0;

for (const song of sourceSongs) {
  const targetRow = target.prepare('SELECT id, title, lyrics_json, translations_json FROM repertoire_items WHERE id=?').get(song.id);
  if (!targetRow) { results.push({ id: song.id, title: song.title, missingInTarget: true }); mismatches += 1; continue; }

  const sourceLines = new Map((parseDoc(song.translations_json).lines || []).map(line => [line.id, line]));
  const targetLines = new Map((parseDoc(targetRow.translations_json).lines || []).map(line => [line.id, line]));
  if (sourceLines.size) songsWithSourceTranslation += 1;

  const sourceLyrics = new Map(parseLyrics(song.lyrics_json).map(line => [line.id, line.text]));
  const targetLyrics = new Map(parseLyrics(targetRow.lyrics_json).map(line => [line.id, line.text]));

  const diff = [];
  for (const [id, line] of sourceLines) {
    const now = targetLines.get(id);
    if (!now) { diff.push({ lineId: id, kind: 'MISSING_IN_TARGET' }); continue; }
    if ((line.text ?? '') !== (now.text ?? '')) diff.push({ lineId: id, kind: 'TEXT_DIFF', source: line.text ?? null, target: now.text ?? null });
    if ((line.source ?? 'ai') !== (now.source ?? 'ai')) diff.push({ lineId: id, kind: 'SOURCE_KIND_DIFF', source: line.source ?? null, target: now.source ?? null });
  }
  // 目标多出的译文行：只允许源库本来就没有（说明本库有源库没有的人工内容）
  const extra = [...targetLines.keys()].filter(id => !sourceLines.has(id));

  const lyricsDiff = [];
  for (const [id, text] of sourceLyrics) if (targetLyrics.get(id) !== text) lyricsDiff.push({ lineId: id, kind: 'LYRIC_TEXT_DIFF' });
  for (const id of targetLyrics.keys()) if (!sourceLyrics.has(id)) lyricsDiff.push({ lineId: id, kind: 'LYRIC_EXTRA_IN_TARGET' });

  totalLines += sourceLines.size;
  mismatches += diff.length + lyricsDiff.length + extra.length;
  results.push({
    id: song.id, title: song.title,
    sourceLines: sourceLines.size, targetLines: targetLines.size,
    targetManual: [...targetLines.values()].filter(line => line.source === 'manual').length,
    identical: diff.length === 0 && lyricsDiff.length === 0 && extra.length === 0,
    extraInTarget: extra, diffs: diff, lyricsDiff,
  });
}

source.close();
target.close();
const payload = {
  checkedAt: new Date().toISOString(), source: sourcePath, target: targetPath,
  songsChecked: results.length, songsWithSourceTranslation, totalLines, mismatches,
  ok: mismatches === 0 && results.every(item => item.identical),
  songs: results,
};
if (outPath) writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify({
  ok: payload.ok, songsChecked: payload.songsChecked, songsWithSourceTranslation,
  totalLines, mismatches,
  perSong: results.map(item => ({ title: item.title, lines: item.sourceLines, manual: item.targetManual, identical: item.identical })),
}, null, 2));
