import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db/database.mjs';
import { createApiServer } from '../server/index.mjs';

test('database migrations persist, enforce status, tags and foreign keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'dance-db-'));
  const expectedMigrations = readdirSync(new URL('../server/db/migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).length;
  try {
    let db = openDatabase(join(root, 'test.db'));
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, expectedMigrations);
    assert.throws(() => db.prepare("INSERT INTO dance_items(id,performance_clip_id,learning_status,scene_mask) VALUES('bad','missing','BAD',0)").run());
    db.close(); db = openDatabase(join(root, 'test.db'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, expectedMigrations);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('health stays available without recognition keys and exposes no local paths', async () => {
  const server = createApiServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, recognition: 'disabled' });
    const missing = await fetch(`${base}/api/missing`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: { code: 'NOT_FOUND', message: '请求的内容不存在' } });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
