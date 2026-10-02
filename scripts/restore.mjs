import { mkdirSync, copyFileSync, cpSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readConfig } from '../server/config.mjs';

/**
 * 恢复（T088）。
 *
 * 从 backup.mjs 产出的备份目录恢复 SQLite 与派生媒体（audio/covers）。
 * 原始参考视频不在备份内（按可重建记录），如缺失需从原始素材重新导入。
 *
 * 用法：node scripts/restore.mjs <备份目录> [--yes]
 * 需要 --yes 才会覆盖现有数据库与派生媒体；未加时只做校验并说明将执行的动作。
 */
export function runRestore(sourceDir, { confirm = false } = {}) {
  const dir = resolve(sourceDir);
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('备份目录缺少 manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const dbSnapshot = join(dir, manifest.db?.file || 'personal-dance-library.db');
  if (!existsSync(dbSnapshot)) throw new Error('备份中缺少数据库快照');

  const config = readConfig();
  const actions = [
    `覆盖数据库：${config.dbPath}`,
    ...['audio', 'covers'].filter((sub) => existsSync(join(dir, 'media', sub))).map((sub) => `覆盖派生媒体：${join(config.mediaRoot, sub)}`),
  ];
  if (!confirm) return { applied: false, actions, manifest };

  mkdirSync(resolve(config.dbPath, '..'), { recursive: true });
  // 先清掉旧库的 WAL/SHM，避免与恢复后的库不一致。
  for (const suffix of ['-wal', '-shm']) {
    try { rmSync(config.dbPath + suffix, { force: true }); } catch { /* 忽略 */ }
  }
  copyFileSync(dbSnapshot, config.dbPath);
  for (const sub of ['audio', 'covers']) {
    const src = join(dir, 'media', sub);
    if (existsSync(src)) cpSync(src, join(config.mediaRoot, sub), { recursive: true });
  }
  return { applied: true, actions, manifest };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const sourceDir = process.argv[2];
  if (!sourceDir) { console.error('用法：node scripts/restore.mjs <备份目录> [--yes]'); process.exitCode = 1; }
  else {
    try {
      const result = runRestore(sourceDir, { confirm: process.argv.includes('--yes') });
      if (!result.applied) {
        console.log('未加 --yes，仅校验。将执行：');
        for (const action of result.actions) console.log(` - ${action}`);
        console.log(`备份时间：${result.manifest.createdAt}，catalogVersion=${result.manifest.catalogVersion}`);
      } else {
        console.log('恢复完成。');
        for (const action of result.actions) console.log(` - ${action}`);
      }
    } catch (error) { console.error('恢复失败：', error.message); process.exitCode = 1; }
  }
}
