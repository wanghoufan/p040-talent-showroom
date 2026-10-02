import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db/database.mjs';
import { createApiServer } from '../server/index.mjs';

function seedSource(db, mediaRoot, { container, videoCodec = null, kind = 'VIDEO' } = {}) {
  mkdirSync(join(mediaRoot, 'source'), { recursive: true });
  const id = randomUUID();
  const rel = `source/${id}.bin`;
  writeFileSync(join(mediaRoot, rel), 'original-media-bytes');
  db.prepare('INSERT INTO source_media(id,source_kind,internal_path,sha256,duration_ms,audio_codec,video_codec,container) VALUES(?,?,?,?,1000,?,?,?)')
    .run(id, kind, rel, `s-${id}`, 'aac', videoCodec, container);
  return id;
}

async function withServer(run, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dance-ops-'));
  const mediaRoot = join(root, 'media');
  mkdirSync(mediaRoot, { recursive: true });
  const db = openDatabase(join(root, 'db.sqlite'));
  const server = createApiServer({ db, mediaRoot, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ base, db, mediaRoot, root }); }
  finally { await new Promise((resolve) => server.close(resolve)); db.close(); rmSync(root, { recursive: true, force: true }); }
}

test('CORS：OPTIONS 预检 204 且带允许头，普通响应带 Access-Control-Allow-Origin', async () => {
  await withServer(async ({ base }) => {
    const pre = await fetch(`${base}/api/catalog`, { method: 'OPTIONS', headers: { Origin: 'http://192.168.31.10' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'http://192.168.31.10');
    assert.match(pre.headers.get('access-control-allow-methods') || '', /DELETE/);
    const ok = await fetch(`${base}/api/health`, { headers: { Origin: 'http://192.168.31.10' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://192.168.31.10');
    assert.equal(ok.headers.get('access-control-expose-headers')?.includes('Content-Range'), true);
  });
});

test('原始媒体 MIME 按容器格式返回，而非仅凭 codec 猜测', async () => {
  await withServer(async ({ base, db, mediaRoot }) => {
    const webm = seedSource(db, mediaRoot, { container: 'matroska,webm', videoCodec: 'vp9' });
    const mp4 = seedSource(db, mediaRoot, { container: 'mov,mp4,m4a,3gp,3g2,mj2', videoCodec: 'h264' });
    const unknown = seedSource(db, mediaRoot, { container: null, videoCodec: 'h264' });
    assert.equal((await fetch(`${base}/api/media/reference/${webm}`)).headers.get('content-type'), 'video/webm');
    assert.equal((await fetch(`${base}/api/media/reference/${mp4}`)).headers.get('content-type'), 'video/mp4');
    assert.equal((await fetch(`${base}/api/media/reference/${unknown}`)).headers.get('content-type'), 'video/mp4');
  });
});

test('静态资源：提供 dist 文件并在 SPA 路由回退 index.html', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dance-dist-'));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>舞蹈曲库</title>');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
  try {
    await withServer(async ({ base }) => {
      const html = await fetch(`${base}/`, { headers: { Accept: 'text/html' } });
      assert.equal(html.status, 200);
      assert.match(html.headers.get('content-type') || '', /text\/html/);
      assert.match(await html.text(), /舞蹈曲库/);
      const js = await fetch(`${base}/assets/app.js`);
      assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
      // SPA 深链回退
      const spa = await fetch(`${base}/dances/abc`, { headers: { Accept: 'text/html' } });
      assert.match(await spa.text(), /舞蹈曲库/);
    }, { staticRoot: dist });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
