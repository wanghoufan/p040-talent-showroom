#!/usr/bin/env node
/**
 * 把逐句审校的修正写进**隔离库副本**的译文列（人工执行，不参与 App 运行时）。
 *
 * 只改 `translations_json`；不碰 `lyrics_json`、时间轴、结构、源 LRC/MP3。
 * 保护规则：库中已是 `manual` 或 `lrc` 的行一律跳过（不清空、不覆盖），只改 `ai` 行。
 * 修正行按「人工审校」落到 `source='manual'`，避免后续批量翻译再覆盖回错误版本。
 *
 * 用法：
 *   node scripts/apply-lyrics-corrections.mjs \
 *     --db var/vocal-v31-work/translation-20261031/db/qa.db \
 *     --corrections docs/qa/evidence-2026-10-31-lyrics-translation/corrections-2026-10-31.json \
 *     --out docs/qa/evidence-2026-10-31-lyrics-translation/correction-result.json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../server/db/database.mjs';
import { getRepertoire } from '../server/repertoire/service.mjs';
import { createVocalTranslationService } from '../server/vocal-translation/service.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dbPath = resolve(arg('db') || '');
const correctionsPath = resolve(arg('corrections') || '');
const outPath = resolve(arg('out') || '');

if (!dbPath || !existsSync(dbPath)) {
  console.error('缺少 --db 或文件不存在：本脚本只接受隔离库副本路径');
  process.exit(2);
}
if (!correctionsPath || !existsSync(correctionsPath)) {
  console.error('缺少 --corrections 或文件不存在');
  process.exit(2);
}

// 双保险：不允许指向正式库或原隔离 QA 库（只允许写副本）。
const FORBIDDEN = ['var/personal-dance-library.db', 'var/vocal-v31-work/real-qa-20261030/db/qa.db'].map(p => resolve(p));
if (FORBIDDEN.includes(dbPath)) {
  console.error(`拒绝写入：${dbPath} 是原库/正式库，本脚本只允许副本`);
  process.exit(3);
}

const doc = JSON.parse(readFileSync(correctionsPath, 'utf8'));
const db = openDatabase(dbPath);
const service = createVocalTranslationService({ db });

const result = { dbPath, correctionsPath, appliedAt: new Date().toISOString(), songs: [], totals: { applied: 0, removed: 0, protectedLines: [] } };

for (const song of doc.songs || []) {
  const item = getRepertoire(db, song.id);
  if (!item) { result.songs.push({ id: song.id, title: song.title, status: 'NOT_FOUND' }); continue; }
  const lyricIds = new Set((item.lyrics || []).map(line => line.id));
  const currentById = new Map((item.translations?.lines || []).map(line => [line.id, line]));

  const accepted = [];
  const skipped = [];
  for (const entry of song.lines || []) {
    if (!lyricIds.has(entry.id)) { skipped.push({ id: entry.id, reason: 'UNKNOWN_LINE' }); continue; }
    const current = currentById.get(entry.id);
    const source = current?.source || 'none';
    if (source === 'manual' || source === 'lrc') {
      skipped.push({ id: entry.id, reason: 'PROTECTED', source, kept: current.text });
      result.totals.protectedLines.push({ song: song.title, id: entry.id, source, kept: current.text });
      continue;
    }
    if (current && current.text === entry.text) continue;
    accepted.push({ entry, before: current?.text ?? null });
  }

  const writeResult = accepted.filter(({ entry }) => entry.text);
  const removeResult = accepted.filter(({ entry }) => entry.text === '');
  if (writeResult.length) service.applyManual(song.id, { lines: writeResult.map(({ entry }) => ({ id: entry.id, text: entry.text })) });
  if (removeResult.length) service.applyManual(song.id, { lines: removeResult.map(({ entry }) => ({ id: entry.id, text: '' })) });

  const after = getRepertoire(db, song.id);
  const afterById = new Map((after.translations?.lines || []).map(line => [line.id, line]));
  result.songs.push({
    id: song.id,
    title: song.title,
    status: 'APPLIED',
    lyricsUnchanged: JSON.stringify(after.lyrics) === JSON.stringify(item.lyrics),
    lyricsCount: (after.lyrics || []).length,
    translatedLines: (after.translations?.lines || []).length,
    applied: accepted.map(({ entry }) => ({
      id: entry.id,
      before: accepted.find(a => a.entry.id === entry.id)?.before ?? null,
      after: entry.text,
      reason: entry.reason,
      storedSource: afterById.get(entry.id)?.source ?? null,
      storedText: afterById.get(entry.id)?.text ?? null,
    })),
    skipped,
  });
  result.totals.applied += writeResult.length;
  result.totals.removed += removeResult.length;
}

db.close();
if (outPath) writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ applied: result.totals.applied, removed: result.totals.removed, protected: result.totals.protectedLines.length, songs: result.songs.length }, null, 2));
for (const song of result.songs) {
  if (song.status !== 'APPLIED') { console.log(`${song.title}: ${song.status}`); continue; }
  console.log(`${song.title}: lyricsUnchanged=${song.lyricsUnchanged} lines=${song.translatedLines} applied=${song.applied.length} skipped=${song.skipped.length}`);
  for (const skip of song.skipped) console.log(`  skip ${skip.id}: ${skip.reason}${skip.source ? ` (${skip.source})` : ''}`);
}
