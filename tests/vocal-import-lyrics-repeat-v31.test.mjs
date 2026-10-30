import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db/database.mjs';
import { parseLrcText } from '../server/vocal-import/lrc.mjs';
import {
  LYRIC_REPEAT_SOURCE,
  LYRIC_REPEAT_STATUS,
  LYRIC_REPEAT_UNKNOWN,
  buildLyricRepeatSuggestions,
  normalizeRepeatText,
} from '../server/vocal-import/lyrics-repeat.mjs';
import { createSourcePolicy } from '../server/vocal-import/source-policy.mjs';
import { scanSource } from '../server/vocal-import/scan.mjs';
import { openVocalImportQueue } from '../server/vocal-import/queue.mjs';

const NO_PROBE = { probe: false, fingerprint: false, deep: false };

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'p040-repeat-'));
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function put(dir, name, content) {
  const path = join(dir, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function makeQueue(dir) {
  const db = openDatabase(join(dir, 'db.sqlite'));
  const mediaRoot = join(dir, 'media');
  mkdirSync(mediaRoot, { recursive: true });
  mkdirSync(join(dir, 'music'), { recursive: true });
  const policy = createSourcePolicy({ roots: [{ id: 'music', path: join(dir, 'music') }] });
  const { queue } = openVocalImportQueue({ db, policy, mediaRoot, logger: null });
  return { db, queue };
}

test('重复候选：只按 LRC 文本/时间行分组，时间原样、带 source/待确认/unknown', () => {
  const timedLines = Object.freeze([
    Object.freeze({ startMs: 1000, text: '副歌' }),
    Object.freeze({ startMs: 3000, text: '主歌' }),
    Object.freeze({ startMs: 5000, text: '  副歌  ' }),
  ]);
  const result = buildLyricRepeatSuggestions(timedLines);

  assert.equal(result.source, LYRIC_REPEAT_SOURCE);
  assert.equal(result.status, LYRIC_REPEAT_STATUS);
  assert.equal(result.candidates.length, 1);
  const [candidate] = result.candidates;
  assert.equal(candidate.source, LYRIC_REPEAT_SOURCE);
  assert.equal(candidate.status, LYRIC_REPEAT_STATUS);
  assert.equal(candidate.sectionType, LYRIC_REPEAT_UNKNOWN);
  assert.equal(candidate.text, '副歌');
  assert.equal(candidate.count, 2);
  assert.deepEqual(candidate.occurrences, [
    { startMs: 1000, lineIndex: 0 },
    { startMs: 5000, lineIndex: 2 },
  ]);
  // 不补 endMs、不插值、不生成 sections。
  assert.equal('sections' in result, false);
  for (const occurrence of candidate.occurrences) {
    assert.deepEqual(Object.keys(occurrence).sort(), ['lineIndex', 'startMs']);
  }
  // 纯函数：不改输入。
  assert.deepEqual(timedLines.map(line => line.startMs), [1000, 3000, 5000]);
});

test('重复候选：无可靠重复或无时间行时返回空候选，不伪造时间', () => {
  const noRepeat = buildLyricRepeatSuggestions([
    { startMs: 1000, text: '第一句' },
    { startMs: 2000, text: '第二句' },
  ]);
  assert.deepEqual(noRepeat.candidates, []);
  assert.equal(noRepeat.status, LYRIC_REPEAT_UNKNOWN);

  // 纯文本歌词没有时间行，不参与候选。
  const plain = parseLrcText('[ti:测试]\n只有文本\n只有文本\n');
  assert.equal(plain.hasTiming, false);
  const fromPlain = buildLyricRepeatSuggestions(plain.timedLines);
  assert.deepEqual(fromPlain.candidates, []);
  assert.equal(fromPlain.status, LYRIC_REPEAT_UNKNOWN);

  assert.deepEqual(buildLyricRepeatSuggestions([]).candidates, []);
  assert.deepEqual(buildLyricRepeatSuggestions(null).candidates, []);
  // 单字/纯标点不当作可靠短句。
  const noisy = buildLyricRepeatSuggestions([
    { startMs: 0, text: '啊' },
    { startMs: 1000, text: '啊' },
  ]);
  assert.deepEqual(noisy.candidates, []);
  assert.equal(normalizeRepeatText('  Ａ  '), 'a');
});

test('扫描：把重复候选放进 song，不改变状态与 issues', async () => {
  await withTempDir(async dir => {
    put(dir, 'Repeat Song.mp3', 'audio-repeat');
    put(dir, 'Repeat Song.lrc', '[00:01.00]同一句\n[00:03.00]别的\n[00:05.00]同一句\n');
    const policy = createSourcePolicy({ roots: [{ id: 'music', path: dir }] });
    const scan = await scanSource({ policy, rootId: 'music', options: NO_PROBE });
    const [song] = scan.songs;

    assert.equal(song.status, 'ready-to-extract');
    assert.equal(song.lyricsRepeatStatus, LYRIC_REPEAT_STATUS);
    assert.equal(song.lyricsRepeatCandidates.length, 1);
    assert.equal(song.lyricsRepeatCandidates[0].text, '同一句');
    assert.deepEqual(song.lyricsRepeatCandidates[0].occurrences.map(item => item.startMs), [1000, 5000]);
    assert.equal(JSON.stringify(scan).includes(dir), false);
  });
});

test('队列：候选经既有 scan_json 暴露；人工换歌词后按新 LRC 重算，重扫不覆盖', async () => {
  await withTempDir(async dir => {
    mkdirSync(join(dir, 'music'), { recursive: true });
    put(join(dir, 'music'), '88rising, Joji, Rich Brian, AUGUST 08 - Midsummer Madness.mp3', 'audio-midsummer');
    put(join(dir, 'music'), '88rising,Joji,Rich Brian - Midsummer Madness.lrc', '[00:02.00]Midsummer\n[00:05.25]Madness\n');
    put(join(dir, 'music'), '手动选的歌词.lrc', '[00:01.00]重复句\n[00:02.00]别的\n[00:03.00]重复句\n');
    const { db, queue } = makeQueue(dir);
    try {
      await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const needing = queue.listJobs()[0];
      assert.equal(needing.status, 'NEEDS_REVIEW');
      // 自动配对歌词本身没有重复 -> 空候选。
      assert.deepEqual(needing.repeatCandidates, []);
      assert.equal(needing.repeatCandidateStatus, LYRIC_REPEAT_UNKNOWN);

      queue.resolve(needing.id, { lyricsRelPath: '手动选的歌词.lrc' });
      const selected = queue.getJob(needing.id);
      assert.equal(selected.repeatCandidateStatus, LYRIC_REPEAT_STATUS);
      assert.equal(selected.repeatCandidates[0].text, '重复句');
      assert.deepEqual(selected.repeatCandidates[0].occurrences.map(item => item.startMs), [1000, 3000]);

      // 重扫不能把人工选中的歌词候选覆盖回自动配对那份空结果。
      await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
      const afterRescan = queue.getJob(needing.id);
      assert.equal(afterRescan.lyrics.relPath, '手动选的歌词.lrc');
      assert.equal(afterRescan.repeatCandidates[0].text, '重复句');
    } finally {
      db.close();
    }
  });
});
