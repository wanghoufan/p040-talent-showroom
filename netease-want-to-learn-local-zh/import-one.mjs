#!/usr/bin/env node
// 参考适配器：把单首已核验的音频+歌词导入目标项目曲库。
// 依赖目标项目存在 server/vocal-import 模块（P040 才艺展示厅结构）；其他项目请改用自己的导入入口。
import { resolve, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';

const help = '用法：node import-one.mjs --project-root <项目根> --source-dir <单曲隔离目录> --db <目标库> --media <媒体目录> [--apply --backup-dir <备份目录>]\n默认只读预检；--apply 写入前创建 SQLite 一致性备份。--project-root 缺省为当前工作目录。';
if (process.argv.includes('--help')) { console.log(help); process.exit(0); }

const args = process.argv.slice(2);
const opts = { 'project-root': resolve(process.cwd()) };
for (let i = 0; i < args.length; i++) {
  const k = args[i];
  if (k === '--apply') { opts.apply = true; continue; }
  if (!['--project-root', '--source-dir', '--db', '--media', '--backup-dir'].includes(k) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('参数错误；请用 --help');
  opts[k.slice(2)] = resolve(args[++i]);
}
for (const k of ['source-dir', 'db', 'media']) if (!opts[k] || !existsSync(opts[k])) throw Error(`缺少或不存在：--${k}`);
if (!existsSync(opts['project-root'])) throw Error(`项目根不存在：--project-root`);
if (opts.apply && !opts['backup-dir']) throw Error('写入须指定 --backup-dir');

const mod = (p) => import(pathToFileURL(join(opts['project-root'], 'server', 'vocal-import', p)).href);
let sourcePolicy, importerMod, queueMod, scanMod;
try {
  ({ createSourcePolicy: sourcePolicy } = await mod('source-policy.mjs'));
  importerMod = await mod('importer.mjs');
  queueMod = await mod('queue.mjs');
  ({ scanSource: scanMod } = await mod('scan.mjs'));
} catch (e) {
  throw Error(`目标项目缺少 server/vocal-import 模块（${e.message}）；请改走目标项目自己的导入入口`);
}

const policy = sourcePolicy({ roots: [{ id: 'netease-stage', label: '电脑导入暂存', path: opts['source-dir'] }] });
const scan = await scanMod({ policy, rootId: 'netease-stage' });
if (scan.songs.length !== 1) throw Error(`隔离目录必须恰好一首，实际 ${scan.songs.length}`);
const song = scan.songs[0];
if (!song.lyrics || !song.timedLyricsCount || song.status === 'needs-review') throw Error('音频或歌词需核对，未导入');

const ro = new DatabaseSync(opts.db, { readOnly: true });
const existing = ro.prepare("SELECT count(*) n FROM repertoire_items WHERE kind='VOCAL' AND deleted_at IS NULL AND title=? AND artist=?").get(song.title, song.artist).n;
ro.close();
console.log(JSON.stringify({ title: song.title, artist: song.artist, language: song.language, timedLyrics: song.timedLyricsCount, status: song.status, duplicates: existing, mode: opts.apply ? 'apply' : 'dry-run' }));
if (existing) { console.log('已存在同名同歌手曲目；不重复导入'); process.exit(0); }
if (!opts.apply) process.exit(0);

mkdirSync(opts['backup-dir'], { recursive: true });
const db = new DatabaseSync(opts.db); db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
try {
  const file = join(opts['backup-dir'], `netease-preimport-${Date.now()}.db`);
  if (existsSync(file)) throw Error('备份目标已存在');
  await backup(db, file);
  const check = new DatabaseSync(file, { readOnly: true });
  try { if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('备份校验失败'); } finally { check.close(); }
  const importer = importerMod.createRepertoireImporter({ db, mediaRoot: opts.media, policy });
  const queue = queueMod.createVocalImportQueue({ db, policy, mediaRoot: opts.media, importer });
  const result = await queue.enqueueScan({ rootId: 'netease-stage' });
  if (result.created.length !== 1) throw Error('任务创建不唯一，停止');
  const imported = await queue.importOriginalOnly(result.created[0]);
  const rows = db.prepare("SELECT lyrics_json,original_clip_id FROM repertoire_items WHERE kind='VOCAL' AND deleted_at IS NULL AND title=? AND artist=?").all(song.title, song.artist);
  if (imported.status !== 'IMPORTED' || rows.length !== 1 || !rows[0].original_clip_id || JSON.parse(rows[0].lyrics_json).length < 1) throw Error('入库回读失败');
  console.log(JSON.stringify({ status: imported.status, lyrics: JSON.parse(rows[0].lyrics_json).length, backup: file }));
} finally { db.close(); }
