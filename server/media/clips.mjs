import { randomUUID } from 'node:crypto';
import { unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractAudio } from './ffmpeg.mjs';
import { bumpCatalog, getDance } from '../catalog.mjs';

/**
 * 从 DanceItem 的 SourceMedia 非破坏地派生一个剪辑片段。
 *
 * 媒体真源铁律：
 * - 只新增/替换 performance_clips 派生行，source_media 行与原始文件永不改写；
 * - 首选 stream copy；仅当来源编码不是 aac/mp3 时做一次 AAC 兼容转码；
 * - 传入完整区间即为“恢复完整音频”（与原始取音频一致）。
 */
export async function deriveClip(db, mediaRoot, danceId, startMs, endMs) {
  const row = db.prepare(`SELECT d.id AS dance_id,d.performance_clip_id,m.internal_path,m.duration_ms,m.audio_codec
    FROM dance_items d JOIN source_media m ON m.id=d.source_media_id
    WHERE d.id=? AND d.deleted_at IS NULL`).get(danceId);
  if (!row) throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
  const duration = row.duration_ms;
  const start = Number.isFinite(startMs) ? Math.round(startMs) : 0;
  const end = Number.isFinite(endMs) ? Math.round(endMs) : duration;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration || end - start < 200) {
    throw Object.assign(new Error('INVALID_CLIP'), { status: 400 });
  }
  const clipId = randomUUID();
  mkdirSync(join(mediaRoot, 'audio'), { recursive: true });
  const clip = await extractAudio(
    join(mediaRoot, row.internal_path),
    join(mediaRoot, 'audio', clipId),
    { durationMs: duration, audioCodec: row.audio_codec },
    start,
    end,
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO performance_clips(id,source_media_id,start_ms,end_ms,internal_audio_path,codec,source_preserving,sha256,size_bytes,duration_ms,version)
      VALUES(?,?,?,?,?,?,?,?,?,?,1)`).run(
      clipId,
      db.prepare('SELECT source_media_id FROM dance_items WHERE id=?').get(danceId).source_media_id,
      start, end, clip.path.startsWith(mediaRoot) ? clip.path.slice(mediaRoot.length + 1) : clip.path,
      clip.codec, clip.sourcePreserving ? 1 : 0, clip.sha256, clip.sizeBytes, end - start,
    );
    db.prepare('UPDATE dance_items SET performance_clip_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(clipId, danceId);
    bumpCatalog(db);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  // 旧派生片段不再被任何 DanceItem 引用时清理文件与行，保持库整洁；原始媒体不受影响。
  const oldId = row.performance_clip_id;
  if (oldId && oldId !== clipId && !db.prepare('SELECT 1 FROM dance_items WHERE performance_clip_id=?').get(oldId)) {
    const old = db.prepare('SELECT internal_audio_path FROM performance_clips WHERE id=?').get(oldId);
    db.prepare('DELETE FROM performance_clips WHERE id=?').run(oldId);
    if (old?.internal_audio_path) { try { unlinkSync(join(mediaRoot, old.internal_audio_path)); } catch { /* 文件清理失败不影响主流程。 */ } }
  }
  return getDance(db, danceId);
}
