import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db/database.mjs';
import { getRepertoire, saveRepertoire } from '../server/repertoire/service.mjs';
import { restoreLegacySections } from '../server/vocal-structure/service.mjs';

/**
 * 旧边界回归（2026-10-31 真机 QA）。
 *
 * 真机反馈：旧尾段终点 219600ms，音轨只有 219572ms（分析按解码样本算时长，
 * 容器时长少 28ms），拆分/合并后保存被「段落超出歌曲总时长」挡住。
 *
 * 判据不是放宽阈值，而是「这条边界以前就落过库、这次没被改动」：
 * - 原样保留的旧边界放行，数值也不得被悄悄改写；
 * - 这次新改出来或新增的越界仍然拒绝。
 * 全部使用临时 SQLite，不连生产库、不读写真实音频。
 */

const LIMIT = 219572; // 真实音轨时长
const LEGACY_TAIL = 219600; // 旧结构末段终点（比音轨多 28ms）
const SHA = 'a'.repeat(64);

function withDb(run) {
  const dir = mkdtempSync(join(tmpdir(), 'p040-legacy-boundary-'));
  const db = openDatabase(join(dir, 'db.sqlite'));
  return Promise.resolve()
    .then(() => run({ db }))
    .finally(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
}

/** 造一条有原唱音轨的 VOCAL 曲目；创建时不校验时长（prior 为空），可写入旧边界。 */
function seed(db, sections) {
  const item = saveRepertoire(db, null, { kind: 'VOCAL', title: '旧边界测试歌', language: 'zh', lyrics: [], sections });
  const clipId = randomUUID();
  const sourceId = randomUUID();
  db.prepare('INSERT INTO source_media(id,source_kind,internal_path,sha256,duration_ms) VALUES(?,?,?,?,?)')
    .run(sourceId, 'AUDIO', 'legacy/test.mp3', SHA, LIMIT);
  db.prepare('INSERT INTO performance_clips(id,source_media_id,start_ms,end_ms,internal_audio_path,codec,source_preserving,sha256,size_bytes,duration_ms) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(clipId, sourceId, 0, LIMIT, 'legacy/test.mp3', 'mp3', 1, SHA, 10, LIMIT);
  db.prepare('UPDATE repertoire_items SET original_clip_id=? WHERE id=?').run(clipId, item.id);
  return getRepertoire(db, item.id);
}

const legacySections = () => [
  { id: 's1', type: 'verse', label: 'A1', startMs: 0, endMs: 12000, source: 'manual' },
  { id: 's2', type: 'chorus', label: 'B1', startMs: 12000, endMs: 200000, source: 'manual' },
  { id: 's3', type: 'verse', label: 'A2', startMs: 200000, endMs: LEGACY_TAIL, source: 'manual' },
];

test('旧尾段 219600 原样保留可以保存，且数值不被改写', () => withDb(({ db }) => {
  const item = seed(db, legacySections());
  assert.equal(item.sections.at(-1).endMs, LEGACY_TAIL);

  // 只改动中间段（拆分 B1），旧尾段不动。
  const next = [
    item.sections[0],
    { ...item.sections[1], endMs: 100000 },
    { id: 's4', type: 'chorus', label: 'B2', startMs: 100000, endMs: 200000, source: 'manual' },
    item.sections[2],
  ];
  const saved = saveRepertoire(db, item.id, { sections: next });
  assert.equal(saved.sections.length, 4);
  // 旧边界必须原样保留，不能被悄悄裁到 219572。
  assert.equal(saved.sections.at(-1).endMs, LEGACY_TAIL);
  assert.equal(saved.sections.at(-1).id, 's3');
}));

test('这次新造出来的越界仍然拒绝：改尾段、加新段都不行', () => withDb(({ db }) => {
  const item = seed(db, legacySections());

  assert.throws(
    () => saveRepertoire(db, item.id, { sections: item.sections.map((section) => (section.id === 's3' ? { ...section, endMs: 220000 } : section)) }),
    /INVALID_SECTIONS/,
  );
  assert.throws(
    () => saveRepertoire(db, item.id, { sections: [...item.sections, { id: 's9', type: 'outro', label: '尾奏', startMs: 219600, endMs: 220500, source: 'manual' }] }),
    /INVALID_SECTIONS/,
  );
  // 失败后正式结构没有被改动。
  assert.deepEqual(getRepertoire(db, item.id).sections.map((section) => section.endMs), [12000, 200000, LEGACY_TAIL]);
}));

test('只改练习设置不碰结构时，已有人工段落一段不动', () => withDb(({ db }) => {
  const item = seed(db, legacySections());
  const saved = saveRepertoire(db, item.id, { practice: { ...item.practice, backwardSeconds: 10 } });
  assert.deepEqual(
    saved.sections.map((section) => [section.id, section.startMs, section.endMs, section.source]),
    [['s1', 0, 12000, 'manual'], ['s2', 12000, 200000, 'manual'], ['s3', 200000, LEGACY_TAIL, 'manual']],
  );
  assert.equal(saved.practice.backwardSeconds, 10);
}));

test('恢复冻结快照允许旧尾段：不因当前音轨更短而恢复失败，值也不被改写', () => withDb(({ db }) => {
  // 当前正式结构先换成不含越界尾段的版本，再恢复旧快照。
  const item = seed(db, legacySections());
  saveRepertoire(db, item.id, {
    sections: [
      { id: 'n1', type: 'verse', label: 'A1', startMs: 0, endMs: 100000, source: 'manual' },
      { id: 'n2', type: 'verse', label: 'A2', startMs: 100000, endMs: 150000, source: 'manual' },
    ],
  });
  db.prepare('INSERT INTO vocal_structure_drafts(song_id,source_sha256,model_name,model_version,state,map_json,analysis_json,legacy_sections_json) VALUES(?,?,?,?,?,?,?,?)')
    .run(item.id, SHA, 'p040-mix-structure', 'test-1', 'APPLIED', '{}', '{}', JSON.stringify(legacySections()));

  const restored = restoreLegacySections({ db, getRepertoire, saveRepertoire, songId: item.id });
  assert.equal(restored.restored, 3);
  assert.equal(restored.item.sections.at(-1).endMs, LEGACY_TAIL);
  assert.equal(db.prepare('SELECT state FROM vocal_structure_drafts WHERE song_id=?').get(item.id).state, 'DISCARDED');
}));
