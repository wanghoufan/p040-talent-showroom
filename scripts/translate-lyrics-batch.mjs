#!/usr/bin/env node
/**
 * 隔离库批量翻译歌词（人工执行，不参与 App 运行时）。
 *
 * 只读 `--db` 指向的隔离 SQLite，写入译文列；不读生产库、不碰源素材、不做音源分离、不播放声音。
 * 翻译通道默认 scripts/codebuddy-auto.sh（CodeBuddy 云端模型），可用环境变量覆盖。
 *
 * 用法：
 *   node scripts/translate-lyrics-batch.mjs --db var/.../qa.db --ids id1,id2 --out var/.../translation-20261031
 *   node scripts/translate-lyrics-batch.mjs --db ... --all-korean --out ...
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase } from '../server/db/database.mjs';
import { getRepertoire } from '../server/repertoire/service.mjs';
import { createCodebuddyTranslator, translationProviderConfig } from '../server/vocal-translation/provider.mjs';
import { createVocalTranslationService } from '../server/vocal-translation/service.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dbPath = resolve(arg('db') || '');
if (!dbPath || !existsSync(dbPath)) {
  console.error('缺少 --db 或文件不存在；本脚本只接受隔离库路径');
  process.exit(2);
}
const outDir = resolve(arg('out') || 'var/vocal-v31-work/translation-run');
mkdirSync(outDir, { recursive: true });

const config = translationProviderConfig();
const translator = createCodebuddyTranslator(config);
const db = openDatabase(dbPath);
const service = createVocalTranslationService({ db, translator, logger: console });

let ids = (arg('ids') || '').split(',').map(value => value.trim()).filter(Boolean);
if (!ids.length && process.argv.includes('--all-korean')) {
  ids = db.prepare("SELECT id FROM repertoire_items WHERE kind='VOCAL' AND deleted_at IS NULL AND vocal_language='ko' ORDER BY created_at")
    .all().map(row => row.id);
}
if (!ids.length) {
  console.error('没有目标曲目：请给 --ids 或 --all-korean');
  process.exit(2);
}

const report = {
  startedAt: new Date().toISOString(),
  dbPath,
  channel: {
    kind: translator.kind,
    provider: translator.provider,
    model: translator.model,
    description: translator.description,
    available: translator.available,
    script: config.scriptPath,
  },
  songs: [],
};
writeFileSync(join(outDir, 'channel.json'), JSON.stringify(report.channel, null, 2));

for (const id of ids) {
  const before = getRepertoire(db, id);
  if (!before) { console.error(`跳过 ${id}：曲目不存在`); continue; }
  const startedAt = new Date().toISOString();
  console.log(`\n=== ${before.title} (${id}) ===`);
  try {
    const result = await service.translateSong(id, { chunkSize: 24 });
    const item = getRepertoire(db, id);
    const lines = item?.translations?.lines || [];
    const record = {
      id,
      title: before.title,
      artist: before.artist,
      language: before.language,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: result.status,
      total: result.total,
      translated: result.translated,
      cached: result.cached,
      lrcReused: result.lrcReused,
      translatedLines: lines.length,
      remaining: result.remaining,
      failed: result.failed,
      lyricsUnchanged: JSON.stringify(before.lyrics) === JSON.stringify(item?.lyrics),
      translationSources: lines.reduce((acc, line) => ({ ...acc, [line.source]: (acc[line.source] || 0) + 1 }), {}),
      samples: lines.slice(0, 3).map(line => ({ id: line.id, text: line.text, source: line.source })),
    };
    report.songs.push(record);
    writeFileSync(join(outDir, `${id}.json`), JSON.stringify({ record, lyrics: item?.lyrics, translations: item?.translations }, null, 2));
    console.log(`status=${record.status} total=${record.total} translated=${record.translated} cached=${record.cached} lrc=${record.lrcReused} remaining=${record.remaining} lyricsUnchanged=${record.lyricsUnchanged}`);
  } catch (error) {
    const record = { id, title: before.title, language: before.language, startedAt, status: 'ERROR', error: error?.message || String(error), code: error?.code };
    report.songs.push(record);
    console.error(`ERROR ${before.title}: ${record.error}`);
  }
}

report.finishedAt = new Date().toISOString();
const complete = report.songs.filter(song => song.status === 'COMPLETE').length;
report.summary = {
  requested: ids.length,
  complete,
  partial: report.songs.filter(song => song.status === 'PARTIAL').length,
  unavailable: report.songs.filter(song => song.status === 'CHANNEL_UNAVAILABLE').length,
  error: report.songs.filter(song => song.status === 'ERROR').length,
  allLyricsUnchanged: report.songs.every(song => song.lyricsUnchanged !== false),
};
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
db.close();
console.log(`\n完成：COMPLETE ${complete}/${ids.length}，报告 ${join(outDir, 'report.json')}`);
process.exit(report.summary.error || report.summary.unavailable || report.summary.partial ? 1 : 0);
