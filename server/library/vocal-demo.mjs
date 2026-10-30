import { copyFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractAudio, fileIdentity, probeMedia } from '../media/ffmpeg.mjs';
import { bumpCatalog } from '../catalog.mjs';

/**
 * 五首原创唱歌演示：每首一条独立伴奏 MP3、一条程序生成的合成导唱 MP3、配套 LRC
 * 与人工预设结构。合成导唱只用于演示切轨，不是真人演唱；导入后以
 * artist/notes 明确标注，避免被误认为真实歌曲或 AI 分析结果。
 * 素材只读本目录，导入时复制到媒体根，不读写用户曲库和真实媒体。
 */
const assets = new URL('./demo-assets/', import.meta.url);
const SYNTHETIC = '合成导唱（非真人）';
const NOTE = '原创演示示例：伴奏与合成导唱旋律均为程序生成，导唱不是真人演唱；歌词与结构为人工标注，不是 AI 分析结果。';

export const VOCAL_DEMO_SONGS = [
  {
    id: 'city', slot: 'vocal-city-v1', language: 'zh', lrc: 'city.lrc',
    accompaniment: 'city.mp3', guide: 'city-guide.mp3',
    sections: [
      { id: 'INTRO', type: 'intro', label: '前奏', startMs: 0, endMs: 5000 },
      { id: 'A1', type: 'verse', label: '主歌 A1', startMs: 5000, endMs: 17000 },
      { id: 'B1', type: 'chorus', label: '副歌 B1', startMs: 17000, endMs: 29000 },
      { id: 'R1', type: 'rap', label: 'Rap R1', startMs: 29000, endMs: 37000 },
      { id: 'A2', type: 'verse', label: '主歌 A2', startMs: 37000, endMs: 49000 },
      { id: 'B2', type: 'chorus', label: '副歌 B2', startMs: 49000, endMs: 61000, repeatOf: 'B1' },
      { id: 'OUTRO', type: 'outro', label: '尾奏', startMs: 61000, endMs: 66000 },
    ],
  },
  {
    id: 'harbor', slot: 'vocal-harbor-v1', language: 'zh', lrc: 'harbor.lrc',
    accompaniment: 'harbor.mp3', guide: 'harbor-guide.mp3',
    sections: [
      { id: 'INTRO', type: 'intro', label: '前奏', startMs: 0, endMs: 6000 },
      { id: 'A1', type: 'verse', label: '主歌 A1', startMs: 6000, endMs: 18000 },
      { id: 'B1', type: 'chorus', label: '副歌 B1', startMs: 18000, endMs: 30000 },
      { id: 'A2', type: 'verse', label: '主歌 A2', startMs: 30000, endMs: 42000 },
      { id: 'B2', type: 'chorus', label: '副歌 B2', startMs: 42000, endMs: 54000, repeatOf: 'B1' },
      { id: 'OUTRO', type: 'outro', label: '尾奏', startMs: 54000, endMs: 60000 },
    ],
  },
  {
    id: 'window', slot: 'vocal-window-v1', language: 'en', lrc: 'window.lrc',
    accompaniment: 'window.mp3', guide: 'window-guide.mp3',
    sections: [
      { id: 'INTRO', type: 'intro', label: 'Intro', startMs: 0, endMs: 6000 },
      { id: 'A1', type: 'verse', label: 'Verse A1', startMs: 6000, endMs: 18000 },
      { id: 'B1', type: 'chorus', label: 'Chorus B1', startMs: 18000, endMs: 30000 },
      { id: 'A2', type: 'verse', label: 'Verse A2', startMs: 30000, endMs: 42000 },
      { id: 'B2', type: 'chorus', label: 'Chorus B2', startMs: 42000, endMs: 54000, repeatOf: 'B1', repetition: 'same-melody-new-lyrics' },
      { id: 'C1', type: 'bridge', label: 'Bridge C1', startMs: 54000, endMs: 60000 },
      { id: 'OUTRO', type: 'outro', label: 'Outro', startMs: 60000, endMs: 66000 },
    ],
  },
  {
    id: 'pulse', slot: 'vocal-pulse-v1', language: 'en', lrc: 'pulse.lrc',
    accompaniment: 'pulse.mp3', guide: 'pulse-guide.mp3',
    sections: [
      { id: 'INTRO', type: 'intro', label: 'Intro', startMs: 0, endMs: 4000 },
      { id: 'R1', type: 'rap', label: 'Rap R1', startMs: 4000, endMs: 22000 },
      { id: 'B1', type: 'chorus', label: 'Chorus B1', startMs: 22000, endMs: 34000 },
      { id: 'R2', type: 'rap', label: 'Rap R2', startMs: 34000, endMs: 54000 },
      { id: 'B2', type: 'chorus', label: 'Chorus B2', startMs: 54000, endMs: 66000, repeatOf: 'B1' },
      { id: 'OUTRO', type: 'outro', label: 'Outro', startMs: 66000, endMs: 72000 },
    ],
  },
  {
    id: 'orbit', slot: 'vocal-orbit-v1', language: 'ko', lrc: 'orbit.lrc',
    accompaniment: 'orbit.mp3', guide: 'orbit-guide.mp3',
    sections: [
      { id: 'INTRO', type: 'intro', label: '인트로', startMs: 0, endMs: 5000 },
      { id: 'A1', type: 'verse', label: '主歌 A1', startMs: 5000, endMs: 18000 },
      { id: 'P1', type: 'pre', label: '预副歌 P1', startMs: 18000, endMs: 27000 },
      { id: 'B1', type: 'chorus', label: '副歌 B1', startMs: 27000, endMs: 40000 },
      { id: 'R1', type: 'rap', label: 'Rap R1', startMs: 40000, endMs: 54000 },
      { id: 'B2', type: 'chorus', label: '副歌 B2', startMs: 54000, endMs: 67000, repeatOf: 'B1' },
      { id: 'OUTRO', type: 'outro', label: '尾奏', startMs: 67000, endMs: 72000 },
    ],
  },
];

const TIME_TAG = /\[(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)\]/g;

function readAsset(name) {
  return readFileSync(new URL(name, assets), 'utf8');
}

/** 只解析演示所需的 LRC 子集：元数据标签、单/多时间戳、逐句文本。 */
export function parseDemoLrc(text) {
  const metadata = {};
  const lines = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const meta = /^\[(ti|ar|by|offset):([^\]]*)\]$/i.exec(line);
    if (meta) { metadata[meta[1].toLowerCase()] = meta[2].trim(); continue; }
    const times = [...line.matchAll(TIME_TAG)];
    if (!times.length) continue;
    const last = times[times.length - 1];
    const value = line.slice(last.index + last[0].length).trim();
    if (!value) continue;
    for (const match of times) lines.push({ startMs: Math.round((Number(match[1]) * 60 + Number(match[2])) * 1000), text: value });
  }
  return { metadata, lines: lines.sort((a, b) => a.startMs - b.startMs) };
}

/** 把 LRC 逐句时间与人工段落对齐；没有命中的句子保持无 sectionId，不强行猜测。 */
export function lyricsFor(song) {
  const { lines } = parseDemoLrc(readAsset(song.lrc));
  if (!lines.length) throw new Error('INVALID_DEMO_LRC');
  return lines.map((line, index) => {
    const section = song.sections.find(item => line.startMs >= item.startMs && line.startMs < item.endMs);
    return { id: `line-${index + 1}`, startMs: line.startMs, text: line.text, ...(section ? { sectionId: section.id } : {}) };
  });
}

function sectionPayload(song) {
  return song.sections.map(section => ({
    id: section.id, type: section.type, label: section.label,
    startMs: section.startMs, endMs: section.endMs,
    ...(section.repeatOf ? { repeatOf: section.repeatOf } : {}),
    ...(section.repetition ? { repetition: section.repetition } : {}),
    source: 'manual',
  }));
}

function relativePath(mediaRoot, path) {
  return relative(mediaRoot, path).split('\\').join('/');
}

/** 复制素材为独立 source，再 stream-copy 成 performance clip；两个文件都属于本次演示。 */
async function createVocalTrack(mediaRoot, assetName, createdFiles) {
  const sourceId = randomUUID();
  const clipId = randomUUID();
  const source = join(mediaRoot, 'source', `${sourceId}.mp3`);
  copyFileSync(new URL(assetName, assets), source);
  createdFiles.push(source);
  const probe = await probeMedia(source);
  if (!probe.audioCodec || !['mp3', 'aac'].includes(probe.audioCodec)) throw new Error('INVALID_DEMO_AUDIO');
  mkdirSync(join(mediaRoot, 'audio'), { recursive: true });
  const clip = await extractAudio(source, join(mediaRoot, 'audio', clipId), probe);
  createdFiles.push(clip.path);
  const hash = await fileIdentity(source);
  return {
    sourceId, clipId,
    sourcePath: relativePath(mediaRoot, source),
    sourceHash: hash.sha256,
    durationMs: probe.durationMs,
    audioCodec: probe.audioCodec,
    clipPath: relativePath(mediaRoot, clip.path),
    clipHash: clip.sha256,
    clipSize: clip.sizeBytes,
    clipCodec: clip.codec,
    sourcePreserving: clip.sourcePreserving ? 1 : 0,
  };
}

/**
 * 五首演示逐首独立事务：任何一首失败都只回滚它自己的文件与记录，不动已有曲目和真实媒体。
 * 已导入的槽位按 slot 跳过，重复点击不会生成第二份。
 */
export async function importVocalDemos(db, mediaRoot) {
  const created = [];
  for (const song of VOCAL_DEMO_SONGS) {
    const prior = db.prepare('SELECT kind,item_id AS id FROM demo_records WHERE slot=?').get(song.slot);
    if (prior) continue;
    await createVocalDemo(db, mediaRoot, song, created);
  }
  return created;
}

async function createVocalDemo(db, mediaRoot, song, created) {
  const itemId = randomUUID();
  const files = [];
  let committed = false;
  try {
    mkdirSync(join(mediaRoot, 'source'), { recursive: true });
    const accompaniment = await createVocalTrack(mediaRoot, song.accompaniment, files);
    const guide = await createVocalTrack(mediaRoot, song.guide, files);
    if (accompaniment.durationMs <= 0 || guide.durationMs <= 0) throw new Error('INVALID_DEMO_AUDIO');
    if (Math.abs(accompaniment.durationMs - guide.durationMs) > 50) throw new Error('DEMO_TRACK_MISMATCH');
    const { metadata } = parseDemoLrc(readAsset(song.lrc));
    const title = metadata.ti || song.id;
    const artist = [metadata.ar || '原创演示', SYNTHETIC].join(' · ');

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const track of [accompaniment, guide]) {
        db.prepare("INSERT INTO source_media(id,source_kind,internal_path,sha256,duration_ms,audio_codec,container) VALUES(?,'AUDIO',?,?,?,?,?)")
          .run(track.sourceId, track.sourcePath, track.sourceHash, track.durationMs, track.audioCodec, 'mp3');
        db.prepare("INSERT INTO performance_clips(id,source_media_id,start_ms,end_ms,internal_audio_path,codec,source_preserving,sha256,size_bytes,duration_ms) VALUES(?,?,0,?,?,?,?,?,?,?)")
          .run(track.clipId, track.sourceId, track.durationMs, track.clipPath, track.clipCodec, track.sourcePreserving, track.clipHash, track.clipSize, track.durationMs);
      }
      // 旧单音轨字段精确指向伴奏；导唱另存 original_clip_id，两条音轨因此互不顶替。
      db.prepare(`INSERT INTO repertoire_items(id,kind,title,artist,learning_status,original_key,performance_key,capo,score_text,notes,audio_role,source_media_id,performance_clip_id,vocal_language,lyrics_json,sections_json,practice_json,original_clip_id,accompaniment_clip_id,original_offset_ms,accompaniment_offset_ms)
        VALUES(?,'VOCAL',?,?,'WANT_TO_LEARN','','',0,'',?,'ACCOMPANIMENT',?,?,?,?,?,?,?,?,0,0)`)
        .run(itemId, title, artist, NOTE, accompaniment.sourceId, accompaniment.clipId, song.language, JSON.stringify(lyricsFor(song)), JSON.stringify(sectionPayload(song)), '{}', guide.clipId, accompaniment.clipId);
      db.prepare('INSERT INTO demo_records(kind,item_id,slot,media_json) VALUES(?,?,?,?)')
        .run('VOCAL', itemId, song.slot, JSON.stringify([accompaniment.sourcePath, accompaniment.clipPath, guide.sourcePath, guide.clipPath]));
      bumpCatalog(db);
      db.exec('COMMIT');
      committed = true;
      created.push({ id: itemId, slot: song.slot, title, durationMs: accompaniment.durationMs });
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    if (!committed) for (const path of files) { try { unlinkSync(path); } catch { /* 保留原始错误。 */ } }
    throw error;
  }
}
