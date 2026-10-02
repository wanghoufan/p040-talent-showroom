import { mkdirSync, cpSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { openDatabase } from '../server/db/database.mjs';
import { readConfig } from '../server/config.mjs';

/**
 * 备份（T088）。
 *
 * - SQLite：用 VACUUM INTO 做一致快照（无需停服务）。
 * - 派生媒体：audio/、covers/ 原样复制并记录 sha256。
 * - 原始参考视频：按“可重建”只记录 sha256/大小，不复制，节省空间（可由原始素材重新导入）。
 *
 * 用法：node scripts/backup.mjs [备份目录]（默认 var/backups/<时间戳>）
 */

async function sha256(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function listFiles(root, sub) {
  const base = join(root, sub);
  if (!existsSync(base)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(base);
  return out;
}

async function describe(root, files) {
  const rows = [];
  for (const file of files) {
    const stat = statSync(file);
    rows.push({ path: relative(root, file), sizeBytes: stat.size, sha256: await sha256(file) });
  }
  return rows;
}

export async function runBackup(destination) {
  const config = readConfig();
  const root = resolve('.');
  const mediaRoot = config.mediaRoot;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = resolve(destination || join('var/backups', stamp));
  mkdirSync(outDir, { recursive: true });

  const db = openDatabase(config.dbPath);
  const snapshot = join(outDir, 'personal-dance-library.db');
  db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
  const catalogVersion = db.prepare('SELECT catalog_version FROM catalog_meta WHERE singleton=1').get()?.catalog_version ?? null;
  db.close();

  mkdirSync(join(outDir, 'media'), { recursive: true });
  for (const sub of ['audio', 'covers']) {
    const src = join(mediaRoot, sub);
    if (existsSync(src)) cpSync(src, join(outDir, 'media', sub), { recursive: true });
  }

  const derived = [...(await describe(mediaRoot, await listFiles(mediaRoot, 'audio'))), ...(await describe(mediaRoot, await listFiles(mediaRoot, 'covers')))];
  const rebuildable = await describe(mediaRoot, await listFiles(mediaRoot, 'source'));

  const manifest = {
    createdAt: new Date().toISOString(),
    catalogVersion,
    db: { file: 'personal-dance-library.db', sizeBytes: statSync(snapshot).size, sha256: await sha256(snapshot) },
    derivedMedia: derived,
    rebuildableSources: rebuildable,
    note: 'rebuildableSources 只记录原始视频/音频哈希，未复制；恢复后如需原视频请从原始素材重新导入。',
  };
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { outDir, manifest };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runBackup(process.argv[2]).then(({ outDir, manifest }) => {
    console.log(`备份完成：${outDir}`);
    console.log(`数据库 ${manifest.db.sizeBytes} 字节；派生媒体 ${manifest.derivedMedia.length} 个；可重建原始视频 ${manifest.rebuildableSources.length} 个。`);
  }).catch((error) => { console.error('备份失败：', error.message); process.exitCode = 1; });
}
