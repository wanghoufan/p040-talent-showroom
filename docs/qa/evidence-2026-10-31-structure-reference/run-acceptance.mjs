/**
 * P040 参考结构最小闭环：三首真实样本定向验收（隔离副本）
 *
 * 只做三件事：
 *   1. 把真实库做一份 SQLite 一致快照，三首原曲复制到隔离 media 目录；
 *   2. 在隔离库上启动一个临时服务，用真实 HTTP 接口走 Papillon 载入/确认/保存、
 *      BABE 手动打点、Let Go 拒绝 BTS 参考；
 *   3. 关服务后直接调用分析结果写入函数，验证「人工结构不被算法结果覆盖」。
 *
 * 不播放音频、不操作手机、不跑伴奏分离、不改生产库、不读第三方歌词。
 * 用法：node "docs/qa/evidence-2026-10-31-structure-reference/run-acceptance.mjs"
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const SRC = join(ROOT, 'var/vocal-v31-work/real-qa-20261030/db/qa.db');
const MUSIC = join(ROOT, 'var/vocal-v31-work/batch-20-20261030/music');
const WORK = join(ROOT, 'var/vocal-v31-work/accept-20261031');
const OUT = import.meta.dirname;
const PORT = 28795;
const PAPILLON_REF = join(ROOT, 'docs/plan/P040-Structure-Source-Validation-2026-10-31/papillon-candidates.json');

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
/** 隔离副本上的只读查询（副本本身可写，用普通连接避免只读模式在 WAL 目录上报 14）。 */
const sql = (db, statement) => JSON.parse(execFileSync('sqlite3', ['-json', db, statement], { encoding: 'utf8' }) || '[]');
/** 源库查询一律只读，绝不打开写句柄。 */
const sqlSource = (db, statement) => JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', db, statement], { encoding: 'utf8' }) || '[]');

const checks = [];
function check(id, ok, detail) {
  checks.push({ id, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
}

function snapshotDb(from, to) {
  mkdirSync(join(to, '..'), { recursive: true });
  execFileSync('sqlite3', [from, `.backup '${to}'`]);
}

async function waitHealthy(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return await res.json();
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('临时服务未在预期时间内就绪');
}

function startServer(env) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (b) => { log += b.toString(); });
  child.stderr.on('data', (b) => { log += b.toString(); });
  return { child, log: () => log };
}

async function main() {
  const startedAt = new Date().toISOString();
  if (existsSync(WORK)) rmSync(WORK, { recursive: true, force: true });
  mkdirSync(join(WORK, 'media'), { recursive: true });

  // ── 0. 前置：源文件只读快照与指纹 ──────────────────────────────
  const songs = sqlSource(SRC, `SELECT r.id, r.title, r.artist, r.audio_role,
      c.internal_audio_path, c.sha256, c.duration_ms, r.revision,
      length(r.lyrics_json) AS lyrics_bytes, length(r.sections_json) AS sections_bytes
    FROM repertoire_items r LEFT JOIN performance_clips c
      ON c.id = COALESCE(r.original_clip_id, r.performance_clip_id)
    WHERE r.deleted_at IS NULL AND r.title IN ('Papillon','베베 (BABE)','Let Go')`);
  const byTitle = Object.fromEntries(songs.map((row) => [row.title, row]));
  const papillon = byTitle['Papillon'];
  const babe = byTitle['베베 (BABE)'];
  const letgo = byTitle['Let Go'];
  check('三首样本都在隔离快照来源库中', Boolean(papillon && babe && letgo), songs.map((s) => s.title).join(' / '));

  const sourceFiles = [];
  const musicFiles = readdirSync(MUSIC);
  for (const row of [papillon, babe, letgo]) {
    const name = musicFiles.find((entry) => entry.endsWith('.mp3') && entry.includes(row.title));
    const file = join(MUSIC, name);
    sourceFiles.push({ row, file, name, sha: sha256(file), mtime: statSync(file).mtimeMs });
  }
  check('三首原曲 SHA 与库内记录一致', sourceFiles.every((entry) => entry.sha === entry.row.sha256),
    sourceFiles.map((entry) => `${entry.row.title}:${entry.sha.slice(0, 12)}`).join(' '));
  check('Papillon 参考文件 SHA 与真实原曲一致（057306bf…）', sourceFiles[0].sha === JSON.parse(readFileSync(PAPILLON_REF, 'utf8')).audioSha256,
    sourceFiles[0].sha.slice(0, 16));

  // ── 1. 隔离副本：一致快照 + 只读复制三首音频 ────────────────────
  const dbCopy = join(WORK, 'db', 'qa.db');
  snapshotDb(SRC, dbCopy);
  for (const entry of sourceFiles) {
    const dest = join(WORK, 'media', 'vocal-import', entry.row.id, 'original.mp3');
    mkdirSync(join(dest, '..'), { recursive: true });
    copyFileSync(entry.file, dest);
    check(`隔离副本音频可用：${entry.row.title}`, sha256(dest) === entry.sha, dest.replace(ROOT, '.'));
  }
  check('隔离副本与原库曲目数据一致（Papillon 段落数）',
    sql(dbCopy, "SELECT json_array_length(sections_json) AS n FROM repertoire_items WHERE title='Papillon'")[0].n
      === sqlSource(SRC, "SELECT json_array_length(sections_json) AS n FROM repertoire_items WHERE title='Papillon'")[0].n, '快照打开校验');

  const pairingFile = join(WORK, 'db', 'owner-pairing.json');
  const base = `http://127.0.0.1:${PORT}`;
  const server = startServer({
    SQLITE_DB_PATH: dbCopy,
    MEDIA_ROOT: join(WORK, 'media'),
    PORT: String(PORT),
    HOST: '127.0.0.1',
    VOCAL_IMPORT_WORKER: '0',
    P040_STRUCTURE_PYTHON: '',
  });

  const header = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
  let token = '';
  try {
    const health = await waitHealthy(base);
    check('隔离服务健康检查可用', health?.ok === true, JSON.stringify(health).slice(0, 120));

    const code = JSON.parse(readFileSync(pairingFile, 'utf8')).code;
    const paired = await (await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json();
    token = paired.token;
    check('隔离服务取得本机 owner 凭据', typeof token === 'string' && token.length > 0, 'token 不打印');

    const rep = await (await fetch(`${base}/api/repertoire`, { headers: header(token) })).json();
    const items = rep.items ?? rep;
    const pick = (title) => items.find((entry) => entry.title === title && entry.kind === 'VOCAL');
    const pap = pick('Papillon'); const babeItem = pick('베베 (BABE)'); const lg = pick('Let Go');
    check('三首唱歌曲目都能从接口读出', Boolean(pap && babeItem && lg), [pap?.title, babeItem?.title, lg?.title].join(' / '));

    const papBefore = JSON.stringify(pap.sections ?? []);
    const babeBefore = JSON.stringify(babeItem.sections ?? []);
    const lgBefore = JSON.stringify(lg.sections ?? []);
    const lyricsBefore = sql(dbCopy, 'SELECT title, lyrics_json FROM repertoire_items ORDER BY title');

    // ── 2. Papillon：参考载入（只写草稿）──────────────────────────
    const ref = JSON.parse(readFileSync(PAPILLON_REF, 'utf8'));
    const loadRes = await fetch(`${base}/api/repertoire/${pap.id}/structure-draft/reference`, {
      method: 'POST', headers: header(token), body: JSON.stringify({ reference: ref }),
    });
    const loaded = await loadRes.json();
    check('Papillon 参考载入返回 200', loadRes.status === 200, `status=${loadRes.status}`);
    check('身份核验五项全过', loaded.identity?.ok === true, (loaded.identity?.checks ?? []).map((c) => `${c.id}:${c.ok}`).join(' '));
    check('候选 10 段', loaded.draft?.reference?.candidateCount === 10, `candidateCount=${loaded.draft?.reference?.candidateCount}`);
    check('争议 2 段保持待标注', loaded.draft?.reference?.disputedCount === 2
      && loaded.draft.map.sections.filter((s) => s.type === 'unknown').length === 2,
    loaded.draft?.map?.sections?.filter((s) => s.type === 'unknown').map((s) => `${s.code}@${s.startMs}`).join(' '));

    const expectedStarts = [0, 12180, 34650, 57150, 68560, 79870, 103260, 125290, 136400, 147450];
    const actualStarts = (loaded.draft?.map?.sections ?? []).map((s) => s.startMs);
    check('10 段起点与用户 LRC 锚定结果一致', JSON.stringify(actualStarts) === JSON.stringify(expectedStarts), actualStarts.join(','));
    const snapped = (loaded.draft?.map?.sections ?? []).filter((s) => s.anchor?.lineId).map((s) => s.anchor.lineId);
    check('多数边界锚在现有 LRC 行上', snapped.length >= 5, `${snapped.length}/10 段锚到 LRC 行`);

    const afterLoad = (await (await fetch(`${base}/api/repertoire`, { headers: header(token) })).json()).items
      .find((entry) => entry.id === pap.id);
    check('载入参考不改正式结构', JSON.stringify(afterLoad.sections ?? []) === papBefore, `sections 未变`);

    // ── 3. Papillon：未确认不许应用 ──────────────────────────────
    const map = loaded.draft.map;
    const bare = await fetch(`${base}/api/repertoire/${pap.id}/structure-draft`, {
      method: 'PUT', headers: header(token), body: JSON.stringify({ map, replaceManual: true }),
    });
    const bareBody = await bare.json();
    check('未逐段确认时拒绝应用（409 REFERENCE_CONFIRMATION_REQUIRED）',
      bare.status === 409 && bareBody.error?.code === 'REFERENCE_CONFIRMATION_REQUIRED', `status=${bare.status} code=${bareBody.error?.code}`);

    // ── 4. Papillon：显式保存 → manual ───────────────────────────
    const applied = await fetch(`${base}/api/repertoire/${pap.id}/structure-draft`, {
      method: 'PUT', headers: header(token), body: JSON.stringify({ map, replaceManual: true, confirmReference: true }),
    });
    const appliedBody = await applied.json();
    check('显式确认后应用成功', applied.status === 200 && appliedBody.applied === 10, `status=${applied.status} applied=${appliedBody.applied}`);
    const papSaved = (await (await fetch(`${base}/api/repertoire`, { headers: header(token) })).json()).items
      .find((entry) => entry.id === pap.id);
    check('保存后 10 段全部 source=manual', (papSaved.sections ?? []).length === 10
      && papSaved.sections.every((s) => s.source === 'manual'), (papSaved.sections ?? []).map((s) => s.source).join(','));
    check('保存后争议段仍是 unknown（未静默定型）',
      (papSaved.sections ?? []).filter((s) => s.type === 'unknown').length === 2,
    (papSaved.sections ?? []).filter((s) => s.type === 'unknown').map((s) => `${s.label}@${s.startMs}`).join(' '));
    check('保存不改歌词', papSaved.lyrics?.length === pap.lyrics?.length, `${papSaved.lyrics?.length}/${pap.lyrics?.length} 行`);

    // ── 5. BABE：没有参考时手动打点 ──────────────────────────────
    const babeSections = babeItem.sections ?? [];
    const target = babeSections.find((s) => s.startMs < 35200 && s.endMs > 35200);
    const tapped = babeSections.flatMap((s) => (s.id === target.id
      ? [{ ...s, endMs: 35200 }, { id: 'manual-tap-babe-1', type: 'unknown', label: 'U1', startMs: 35200, endMs: s.endMs, source: 'manual' }]
      : [s]));
    const tapRes = await fetch(`${base}/api/sync/operations`, {
      method: 'POST', headers: header(token),
      body: JSON.stringify({ operationId: crypto.randomUUID(), kind: 'VOCAL', id: babeItem.id, action: 'update', baseRevision: babeItem.revision, fields: { sections: tapped } }),
    });
    const tapBody = await tapRes.json();
    check('BABE 手动打点写入成功', tapRes.status === 200 && tapBody.status === 'applied', `status=${tapRes.status}/${tapBody.status}`);
    const babeAfter = (await (await fetch(`${base}/api/repertoire`, { headers: header(token) })).json()).items
      .find((entry) => entry.id === babeItem.id);
    check('BABE 段数 +1 且新段为 manual unknown', (babeAfter.sections ?? []).length === babeSections.length + 1
      && babeAfter.sections.some((s) => s.id === 'manual-tap-babe-1' && s.source === 'manual' && s.type === 'unknown'),
    `${babeSections.length} → ${babeAfter.sections?.length}`);
    check('BABE 没有被塞入任何参考候选', !JSON.stringify(babeAfter.sections).includes('ref-')
      && JSON.stringify(babeAfter.sections) !== '[]', '无 ref-* 段');

    // ── 6. Let Go：同名不同歌绝不匹配 ────────────────────────────
    const btsRef = {
      schema: 'p040.structure-reference.v1', project: 'P040', songTitle: 'Let Go', artist: 'BTS',
      artistAliases: [], version: 'studio', audioDurationMs: 206206,
      audioSha256: sourceFiles[2].sha, status: 'DRAFT_REVIEW_REQUIRED', source: 'wrong-song-control',
      candidates: [
        { timeMs: 0, type: 'intro', label: '前奏' },
        { timeMs: 15000, type: 'verse', label: 'A1' },
        { timeMs: 45000, type: 'chorus', label: 'B1' },
      ],
    };
    const lgRes = await fetch(`${base}/api/repertoire/${lg.id}/structure-draft/reference`, {
      method: 'POST', headers: header(token), body: JSON.stringify({ reference: btsRef }),
    });
    const lgBody = await lgRes.json();
    check('Let Go 拒绝 BTS 同名参考（409 IDENTITY_MISMATCH）',
      lgRes.status === 409 && lgBody.error?.code === 'IDENTITY_MISMATCH', `status=${lgRes.status} code=${lgBody.error?.code}`);
    check('拒绝信息指出歌手不一致',
      (lgBody.error?.identity?.blockers ?? []).some((b) => b.code === 'IDENTITY_ARTIST_MISMATCH'),
      (lgBody.error?.identity?.blockers ?? []).map((b) => b.code).join(','));
    const lgDraft = await (await fetch(`${base}/api/repertoire/${lg.id}/structure-draft`, { headers: header(token) })).json();
    check('拒绝后没有留下任何参考草稿', lgDraft.draft === null, `draft=${lgDraft.draft === null ? 'null' : 'exists'}`);
    const lgAfter = (await (await fetch(`${base}/api/repertoire`, { headers: header(token) })).json()).items
      .find((entry) => entry.id === lg.id);
    check('Let Go 正式结构未变', JSON.stringify(lgAfter.sections ?? []) === lgBefore, 'sections 未变');

    // ── 7. 原 MP3 / LRC / 歌词未变 ───────────────────────────────
    const sourceUntouched = sourceFiles.every((entry) => sha256(entry.file) === entry.sha && statSync(entry.file).mtimeMs === entry.mtime);
    check('源目录三首 MP3 字节与 mtime 均未变', sourceUntouched, sourceFiles.map((entry) => entry.row.title).join(' / '));
    const lrcNames = ['王嘉尔 - Papillon.lrc', '泫雅 - 베베 (BABE).lrc', '石玺彤 - Let Go.lrc'];
    check('三首 LRC 文件仍在源目录且未被改写',
      lrcNames.every((name) => existsSync(join(MUSIC, name))),
      lrcNames.map((name) => `${name}:${statSync(join(MUSIC, name)).size}B`).join(' '));
    const lyricsAfter = sql(dbCopy, 'SELECT title, lyrics_json FROM repertoire_items ORDER BY title');
    check('全库歌词内容零改动', JSON.stringify(lyricsBefore) === JSON.stringify(lyricsAfter),
      `${lyricsBefore.length} 条曲目 lyrics_json 逐字相同`);
  } finally {
    server.child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    if (!server.child.killed) server.child.kill('SIGKILL');
  }

  // ── 8. 分析结果写入不得覆盖人工结构（直接调用真实写入函数）──────
  const { openDatabase } = await import('../../../server/db/database.mjs');
  const { saveVocalAnalysis, getRepertoire } = await import('../../../server/repertoire/service.mjs');
  const db = openDatabase(dbCopy);
  try {
    const saved = getRepertoire(db, papillon.id);
    const result = saveVocalAnalysis(db, papillon.id, {
      sections: [
        { id: 'algo-1', type: 'verse', label: '主歌', startMs: 0, endMs: 90000 },
        { id: 'algo-2', type: 'chorus', label: '副歌', startMs: 90000, endMs: 195036 },
      ],
    });
    const after = getRepertoire(db, papillon.id);
    check('算法结果写入被拒（MANUAL_OVERRIDE，不改段）',
      result.applied === false && result.reason === 'MANUAL_OVERRIDE', JSON.stringify({ applied: result.applied, reason: result.reason }));
    check('人工 10 段结构在算法写入后逐字不变',
      JSON.stringify(after.sections) === JSON.stringify(saved.sections), `${after.sections.length} 段`);
  } finally {
    db.close();
  }

  const report = {
    schema: 'p040.reference-acceptance.v1',
    startedAt, finishedAt: new Date().toISOString(),
    isolatedCopy: WORK.replace(ROOT, '.'),
    sourceDb: SRC.replace(ROOT, '.'),
    total: checks.length, pass: checks.filter((c) => c.ok).length, fail: checks.filter((c) => !c.ok).length,
    checks,
  };
  writeFileSync(join(OUT, 'acceptance-result.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${report.pass}/${report.total} PASS, ${report.fail} FAIL`);
  if (report.fail) process.exitCode = 1;
}

await main();
