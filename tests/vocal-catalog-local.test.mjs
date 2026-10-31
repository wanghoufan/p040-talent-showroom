import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('参考目录可从本机文件读取，缺失时为空且不泄露本机数据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-local-'));
  try {
    const file = join(dir, 'catalog.json');
    const entry = { id: 'example', schema: 'p040.structure-reference.v1', songTitle: '示例曲', artist: '示例歌手', artistAliases: [], titleAliases: [], version: 'studio', audioDurationMs: 1000, audioSha256: 'a'.repeat(64), candidates: [{timeMs: 0, type: 'intro', label: '前奏'}] };
    writeFileSync(file, JSON.stringify([entry]));
    const probe = "import { REFERENCE_CATALOG } from './server/vocal-structure/reference-catalog.mjs'; console.log(JSON.stringify(REFERENCE_CATALOG.map(x => x.id)))";
    const run = path => spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: process.cwd(), env: { ...process.env, P040_REFERENCE_CATALOG: path }, encoding: 'utf8' });
    let result = run(file); assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.stdout), ['example']);
    result = run(join(dir, 'missing.json')); assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.stdout), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
