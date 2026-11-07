#!/usr/bin/env node
/**
 * 已导入软件清单（manifest）生成/刷新
 *
 * 为什么需要：网易云「已导入软件」目录是平铺文件，光看文件名无法确认
 * 「这首到底导进库没有、是不是同一首」。清单把 文件 ↔ 库记录 用哈希和库 ID 绑起来，
 * 下次导入前先查清单即可判重（同哈希=同文件；同歌名歌手归一化=疑似重复，人工确认）。
 *
 * 用法：
 *   node scripts/music-archive-manifest.mjs                     # 刷新 ~/Music/网易云音乐/已导入软件/manifest.json
 *   node scripts/music-archive-manifest.mjs --dir <归档目录>     # 换目录
 *   node scripts/music-archive-manifest.mjs --db <库路径>        # 换库（默认生产 real-qa）
 *   node scripts/music-archive-manifest.mjs --check "<歌名>"      # 只查一首：是否已归档/已入库
 *
 * 只读库、只写 manifest.json；不移动、不改名任何音频。
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const ARCHIVE_DIR = resolve(argOf('dir', join(homedir(), 'Music', '网易云音乐', '已导入软件')));
const DB_PATH = resolve(argOf('db', 'var/vocal-v31-work/real-qa-20261030/db/qa.db'));
const MANIFEST = join(ARCHIVE_DIR, 'manifest.json');
const AUDIO_EXT = new Set(['.ncm', '.mp3', '.flac', '.m4a', '.wav', '.aac']);
const SIDECAR_EXT = new Set(['.lrc', '.txt', '.jpg', '.jpeg', '.png']);

/** 「歌手 - 歌名」→ {artist,title}；不符合约定时返回 null（交给人工）。 */
function parseName(file) {
  const stem = basename(file, extname(file));
  const parts = stem.split(' - ');
  if (parts.length < 2) return null;
  return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
}

const normalize = (value) => String(value ?? '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\s\p{P}]/gu, '');

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function loadDb() {
  if (!existsSync(DB_PATH)) return new Map();
  // 同步引入用 createRequire，避免 ESM 里没有 require
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db.prepare("select id,title,artist,created_at from repertoire_items where kind='VOCAL' and deleted_at is null").all();
  db.close();
  const index = new Map();
  for (const row of rows) index.set(`${normalize(row.title)}|${normalize(row.artist)}`, row);
  return index;
}

function build() {
  if (!existsSync(ARCHIVE_DIR)) throw new Error(`归档目录不存在：${ARCHIVE_DIR}`);
  const dbIndex = loadDb();
  const files = readdirSync(ARCHIVE_DIR).filter((name) => !name.startsWith('.') && name !== 'manifest.json');
  const groups = new Map();
  for (const name of files) {
    const ext = extname(name).toLowerCase();
    const parsed = parseName(name);
    const key = parsed ? `${normalize(parsed.artist)}|${normalize(parsed.title)}` : `?|${normalize(basename(name, ext))}`;
    if (!groups.has(key)) {
      groups.set(key, { title: parsed?.title ?? basename(name, ext), artist: parsed?.artist ?? '', files: [], parseError: !parsed && (AUDIO_EXT.has(ext) || SIDECAR_EXT.has(ext)) });
    }
    groups.get(key).files.push(name);
  }

  const items = [];
  const warnings = [];
  for (const [key, group] of groups) {
    const dbRow = dbIndex.get(key) ?? null;
    const fileEntries = group.files.map((name) => {
      const path = join(ARCHIVE_DIR, name);
      const ext = extname(name).toLowerCase();
      const entry = { name, ext: ext.replace('.', ''), bytes: statSync(path).size, sha256: sha256(path) };
      if (AUDIO_EXT.has(ext)) entry.kind = 'audio';
      else if (ext === '.lrc') entry.kind = 'lyrics';
      else entry.kind = 'sidecar';
      return entry;
    });
    if (group.parseError) warnings.push(`文件名不是「歌手 - 歌名」，已按文件名归组：${group.files.join(', ')}`);
    if (!dbRow) warnings.push(`库里没有对应曲目（可能已删除或改过名）：${group.artist} - ${group.title}`);
    items.push({
      title: dbRow?.title ?? group.title,
      artist: dbRow?.artist ?? group.artist,
      songId: dbRow?.id ?? null,
      inLibrary: Boolean(dbRow),
      libraryCreatedAt: dbRow?.created_at ?? null,
      hasAudio: fileEntries.some((file) => file.kind === 'audio'),
      hasLyrics: fileEntries.some((file) => file.kind === 'lyrics'),
      files: fileEntries,
    });
  }
  items.sort((a, b) => a.title.localeCompare(b.title, 'zh'));

  const manifest = {
    version: 1,
    description: '网易云「想学」导入归档清单：文件 ↔ 库记录对应关系，用于判重与追溯',
    archiveDir: ARCHIVE_DIR,
    dbPath: DB_PATH,
    refreshedAt: new Date().toISOString(),
    count: items.length,
    items,
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, warnings };
}

function check(keyword) {
  if (!existsSync(MANIFEST)) throw new Error('还没有 manifest.json，先不带 --check 跑一次');
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const needle = normalize(keyword);
  const hits = manifest.items.filter((item) => normalize(item.title).includes(needle) || normalize(item.artist).includes(needle));
  return { keyword, matches: hits.length, hits: hits.map((item) => ({ title: item.title, artist: item.artist, songId: item.songId, inLibrary: item.inLibrary })) };
}

if (args.includes('--check')) {
  console.log(JSON.stringify(check(argOf('check', '')), null, 2));
} else {
  const { manifest, warnings } = build();
  console.log(JSON.stringify({ manifest: MANIFEST, count: manifest.count, inLibrary: manifest.items.filter((item) => item.inLibrary).length, warnings }, null, 2));
}
