import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const dist = join(root, 'dist');
const synced = join(root, 'android/app/src/main/assets/public');
const apk = join(root, 'android/app/build/outputs/apk/debug/app-debug.apk');

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const files = walk(dist).sort();
const rows = [];
let mismatch = 0;
for (const file of files) {
  const a = sha(readFileSync(join(dist, file)));
  const b = sha(readFileSync(join(synced, file)));
  const c = sha(execFileSync('unzip', ['-p', apk, `assets/public/${file}`], { maxBuffer: 64 * 1024 * 1024 }));
  const ok = a === b && b === c;
  if (!ok) mismatch += 1;
  rows.push({ file, dist: a, synced: b, apk: c, ok });
}
const extra = walk(synced).length - files.length;
console.log(JSON.stringify({ fileCount: files.length, extraInSynced: extra, mismatch, rows }, null, 2));
