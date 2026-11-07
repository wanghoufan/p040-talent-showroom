/**
 * 端到端：真实原曲 → 隔离分析 → 草稿接口 → 应用到正式结构。
 *
 * 只在临时目录建库与媒体副本，不接触生产库与源目录写入；
 * 分析用独立 venv（无 torch/audio_separator），源文件只读。
 */
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../../../server/db/database.mjs';
import { getRepertoire, saveRepertoire } from '../../../../server/repertoire/service.mjs';
import { createApiServer } from '../../../../server/index.mjs';
import { createStructureAnalyzer, sha256File } from '../../../../server/vocal-structure/analyzer.mjs';
import { mountStructureRoutes } from '../../../../server/vocal-structure/routes.mjs';
import { parseLrcFile } from '../../../../server/vocal-import/lrc.mjs';

const SOURCE_DIR = '/Volumes/三星/网易云音乐/音乐（用于转换）';
const AUDIO = '杨宗纬 - 初爱.mp3';
const LRC = '杨宗纬 - 初爱.lrc';
const PYTHON = 'var/vocal-v31-work/structure-venv/bin/python';

const root = mkdtempSync(join(tmpdir(), 'p040-e2e-'));
const mediaRoot = join(root, 'media');
mkdirSync(join(mediaRoot, 'vocal-import', 'song-1'), { recursive: true });
const audioPath = join(mediaRoot, 'vocal-import', 'song-1', 'original.mp3');
copyFileSync(join(SOURCE_DIR, AUDIO), audioPath);
const sourceShaBefore = sha256File(join(SOURCE_DIR, AUDIO));
const sourceSizeBefore = statSync(join(SOURCE_DIR, AUDIO)).size;

const db = openDatabase(join(root, 'qa.sqlite'));
const lrc = parseLrcFile(join(SOURCE_DIR, LRC));
const lyrics = lrc.timedLines.map((line, index) => ({ id: `l${index + 1}`, startMs: line.startMs, text: line.text }));
const item = saveRepertoire(db, null, {
  kind: 'VOCAL', title: '初爱', artist: '杨宗纬', language: 'zh', lyrics, sections: [],
});
const sha = sha256File(audioPath);
const sourceId = randomUUID();
db.prepare('INSERT INTO source_media(id,source_kind,internal_path,sha256,duration_ms) VALUES(?,?,?,?,?)')
  .run(sourceId, 'AUDIO', 'vocal-import/song-1/original.mp3', sha, 233718);
const clipId = randomUUID();
db.prepare('INSERT INTO performance_clips(id,source_media_id,start_ms,end_ms,internal_audio_path,codec,source_preserving,sha256,size_bytes,duration_ms) VALUES(?,?,?,?,?,?,?,?,?,?)')
  .run(clipId, sourceId, 0, 233718, 'vocal-import/song-1/original.mp3', 'mp3', 1, sha, statSync(audioPath).size, 233718);
db.prepare('UPDATE repertoire_items SET original_clip_id=?, audio_role=? WHERE id=?').run(clipId, 'REFERENCE', item.id);

const analyzer = createStructureAnalyzer({
  python: PYTHON,
  script: 'server/vocal-structure/analyze.py',
  timeoutMs: 240_000,
});
const structure = {
  analyzer,
  handle: mountStructureRoutes({
    db, mediaRoot, analyzer, getRepertoire, saveRepertoire,
    workDir: join(root, 'work'), authorize: () => true,
  }),
};
const server = createApiServer({ db, mediaRoot, structure });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const call = async (path, method = 'GET', body) => {
  const response = await fetch(base + path, {
    method,
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
};

try {
  const started = Date.now();
  const created = await call(`/api/repertoire/${item.id}/structure-draft`, 'POST', {});
  if (created.status !== 200) throw new Error(`generation failed: ${created.status} ${JSON.stringify(created.data)}`);
  const draft = created.data.draft;
  const summary = {
    httpStatus: created.status,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    sections: draft.summary.sections,
    pendingTypes: draft.summary.pendingTypes,
    typeCandidates: draft.summary.typeCandidates,
    relationCandidates: draft.summary.pendingRelations,
    separationUsed: draft.separation?.used,
    separationModules: draft.separation?.modulesSeen,
    state: draft.state,
    model: `${draft.modelName} v${draft.modelVersion}`,
    codes: draft.map.sections.map((section) => section.code).join(' '),
    formalSectionsBeforeApply: getRepertoire(db, item.id).sections.length,
  };

  // 用户把有候选的同簇段当作副歌/主歌，再应用（模拟一次人工确认）。
  const map = structuredClone(draft.map);
  for (const section of map.sections) {
    if (section.type === 'unknown' && section.typeCandidate) section.type = section.typeCandidate;
  }
  const applied = await call(`/api/repertoire/${item.id}/structure-draft`, 'PUT', { map });
  if (applied.status !== 200) throw new Error(`apply failed: ${applied.status} ${JSON.stringify(applied.data)}`);
  const after = getRepertoire(db, item.id);

  const restored = await call(`/api/repertoire/${item.id}/structure-draft/restore`, 'POST');

  console.log(JSON.stringify({
    ...summary,
    appliedSections: applied.data.applied,
    formalAllManual: after.sections.every((section) => section.source === 'manual'),
    formalCodes: after.sections.map((section) => section.label).join(' '),
    restoreStatus: restored.status,
    restoredSections: restored.data.restored ?? null,
    sourceShaUnchanged: sha256File(join(SOURCE_DIR, AUDIO)) === sourceShaBefore,
    sourceSizeUnchanged: statSync(join(SOURCE_DIR, AUDIO)).size === sourceSizeBefore,
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(root, { recursive: true, force: true });
}
