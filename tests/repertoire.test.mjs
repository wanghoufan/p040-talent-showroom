import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../server/db/database.mjs';
import { createApiServer } from '../server/index.mjs';
async function withApi(run) {
 const root = mkdtempSync(join(tmpdir(), 'talent-')); const db = openDatabase(join(root, 'db.sqlite')); const server = createApiServer({ db, mediaRoot: join(root, 'media') });
 await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
 const request = async (path, method = 'GET', body) => { const res = await fetch(base + path, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) }); return { status: res.status, data: await res.json() }; };
 try { await run({ db, root, base, request }); } finally { await new Promise(r => server.close(r)); db.close(); rmSync(root, { recursive: true, force: true }); }
}
test('吉他和唱歌曲目独立CRUD，文本谱与调性保留，筛选有效且不污染舞蹈曲库', async () => withApi(async ({ request }) => {
 const g = await request('/api/repertoire', 'POST', { kind: 'GUITAR', title: '吉他示范', capo: 2, originalKey: 'C', performanceKey: 'D', scoreText: '[C]第一行\n[G]第二行' }); assert.equal(g.status, 201);
 const v = await request('/api/repertoire', 'POST', { kind: 'VOCAL', title: '唱歌示范', scoreText: '歌词一\n歌词二', audioRole: 'ACCOMPANIMENT' }); assert.equal(v.status, 201);
 assert.equal((await request('/api/repertoire?kind=GUITAR&q=吉他')).data.items.length, 1);
 const changed = await request('/api/repertoire/' + g.data.id, 'PATCH', { learningStatus: 'CAN_DANCE', notes: '练习备注' }); assert.equal(changed.data.capo, 2); assert.equal(changed.data.scoreText, '[C]第一行\n[G]第二行');
 assert.equal((await request('/api/catalog')).data.items.length, 0); assert.equal((await request('/api/sync/manifest')).data.repertoire.length, 2);
 assert.equal((await request('/api/repertoire/' + g.data.id, 'DELETE')).status, 200); assert.equal((await request('/api/repertoire/' + g.data.id)).status, 404); assert.equal((await request('/api/repertoire')).data.items.length, 1);
}));
test('无效分类/Capo/状态/未知字段整批拒绝，吉他资料不改变另一条曲目', async () => withApi(async ({ request }) => {
 for (const body of [{ kind: 'OTHER', title: 'x' }, { kind: 'GUITAR', title: 'x', capo: 13 }, { kind: 'VOCAL', title: 'x', capo: 2 }, { kind: 'GUITAR', title: '' }, { kind: 'GUITAR', title: 'x', sourceMediaId: 'unsafe' }]) assert.equal((await request('/api/repertoire', 'POST', body)).status, 400);
 const g = (await request('/api/repertoire', 'POST', { kind: 'GUITAR', title: '合法' })).data;
 assert.equal((await request('/api/repertoire/' + g.id, 'PATCH', { learningStatus: 'OTHER' })).status, 400); assert.equal((await request('/api/repertoire/' + g.id)).data.title, '合法');
}));
test('真实音频导入绑定吉他不生成DanceItem，重复绑定幂等且文本编辑不替换音频', async () => withApi(async ({ root, base, request }) => {
 const g = (await request('/api/repertoire', 'POST', { kind: 'GUITAR', title: '音频吉他' })).data;
 const file = join(root, 'audio.wav'); execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', file]);
 const res = await fetch(base + '/api/imports/file', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: readFileSync(file) }); const job = await res.json();
 for (let i = 0; i < 100; i++) { if ((await request('/api/imports/' + job.id)).data.status === 'READY') break; await new Promise(r => setTimeout(r, 20)); }
 const linked = await request('/api/repertoire/' + g.id + '/media', 'POST', { importJobId: job.id, audioRole: 'REFERENCE' }); assert.equal(linked.status, 200); assert.ok(linked.data.audio.sha256);
 assert.equal((await request('/api/repertoire/' + g.id + '/media', 'POST', { importJobId: job.id, audioRole: 'REFERENCE' })).data.audio.sha256, linked.data.audio.sha256);
 assert.equal((await request('/api/catalog')).data.items.length, 0); assert.equal((await fetch(base + linked.data.audio.url)).status, 200);
 const edited = await request('/api/repertoire/' + g.id, 'PATCH', { scoreText: 'Am G C', capo: 3 }); assert.equal(edited.data.audio.sha256, linked.data.audio.sha256);
}));
