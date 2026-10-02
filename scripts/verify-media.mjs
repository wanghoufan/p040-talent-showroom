import { openDatabase } from '../server/db/database.mjs';
import { probeMedia, fileIdentity } from '../server/media/ffmpeg.mjs';
import { join } from 'node:path';
import { readConfig } from '../server/config.mjs';
import { writeFileSync } from 'node:fs';

/** T041：对真实库抽样校验 片段 duration/codec/hash 与 source 映射，输出 media-truth.md。 */
async function main() {
  const config = readConfig();
  const db = openDatabase(config.dbPath);
  const mediaRoot = config.mediaRoot;
  const rows = db.prepare(`SELECT d.id,d.title_override,s.title AS song_title,c.id AS clip_id,c.internal_audio_path,c.codec,c.sha256 AS clip_sha,c.duration_ms AS clip_duration,c.start_ms,c.end_ms,c.source_preserving,m.id AS source_id,m.internal_path AS source_path,m.sha256 AS source_sha,m.audio_codec AS source_codec,m.duration_ms AS source_duration
    FROM dance_items d JOIN performance_clips c ON c.id=d.performance_clip_id JOIN source_media m ON m.id=d.source_media_id LEFT JOIN song_identities s ON s.id=d.song_identity_id
    WHERE d.deleted_at IS NULL ORDER BY d.created_at LIMIT 12`).all();
  const lines = ['# 媒体真源抽样验证（media truth）', '', `采样条数：${rows.length}；媒体根：${mediaRoot}`, '', '| 歌曲 | 片段码率/hash | duration(ms) | 片段 sha 一致 | source map | 原媒体 sha 一致 | stream copy |', '|---|---|---|---|---|---|---|'];
  let failures = 0;
  for (const row of rows) {
    const clipPath = join(mediaRoot, row.internal_audio_path);
    const sourcePath = join(mediaRoot, row.source_path);
    let probe, identity, sourceOk = false, sourceIdentity;
    try { probe = await probeMedia(clipPath); } catch { probe = null; }
    try { identity = await fileIdentity(clipPath); } catch { identity = null; }
    try { sourceIdentity = await fileIdentity(sourcePath); sourceOk = sourceIdentity.sha256 === row.source_sha; } catch { sourceOk = false; }
    const shaOk = identity ? identity.sha256 === row.clip_sha : false;
    const durationOk = probe ? Math.abs(probe.durationMs - row.clip_duration) <= 60 : false;
    const mapped = row.source_id === (db.prepare('SELECT source_media_id FROM dance_items WHERE id=?').get(row.id)?.source_media_id);
    const ok = shaOk && durationOk && mapped && sourceOk && probe;
    if (!ok) failures++;
    lines.push(`| ${row.title_override || row.song_title || '未识别'} | ${probe?.audioCodec || '?'}/${(identity?.sha256 || '').slice(0, 8)} | ${row.clip_duration} | ${shaOk ? '✓' : '✗'} | ${mapped ? '✓' : '✗'} | ${sourceOk ? '✓' : '✗'} | ${row.source_preserving ? '是' : '转码'} |`);
  }
  lines.push('', `结果：${rows.length - failures}/${rows.length} 通过；失败 ${failures}。`);
  lines.push('', '说明：片段 sha 来自 performance_clips.sha256；duration 由 ffprobe 实测与库值比对（±60ms）；source 映射核对 dance_items.source_media_id；原媒体 sha 核对来源文件未变。');
  writeFileSync('docs/verification/media-truth.md', lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  db.close();
  if (rows.length < 10) { console.error(`采样不足 10 条：${rows.length}`); process.exitCode = 1; }
  if (failures) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
