import { unlinkSync } from 'node:fs';
import { getDance, bumpCatalog } from '../catalog.mjs';
import { controlledPath } from '../security/paths.mjs';

/**
 * 安全删除（T071）。
 * 默认“仅记录”：只软删除 DanceItem 并移出今晚歌单，原始媒体与派生片段文件都不动。
 * 传入 deleteMedia 时才回收媒体文件，且逐项做引用检查——仍被其他曲目/片段引用的文件绝不删除。
 */
export function deleteDance(db, mediaRoot, id, { deleteMedia = false } = {}) {
  const item = getDance(db, id);
  if (!item) throw Object.assign(new Error('NOT_FOUND'), { status: 404 });

  // 引用检查（排除本条目本身）。
  const sourceRefs = item.sourceMediaId
    ? db.prepare('SELECT COUNT(*) AS n FROM dance_items WHERE source_media_id=? AND id<>? AND deleted_at IS NULL').get(item.sourceMediaId, id).n : 0;
  const clipRefs = db.prepare('SELECT COUNT(*) AS n FROM dance_items WHERE performance_clip_id=? AND id<>? AND deleted_at IS NULL').get(item.performanceClipId, id).n;
  const coverRefs = item.coverAssetId
    ? db.prepare('SELECT COUNT(*) AS n FROM dance_items WHERE cover_asset_id=? AND id<>? AND deleted_at IS NULL').get(item.coverAssetId, id).n : 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE dance_items SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(id);
    db.prepare('DELETE FROM tonight_playlist_items WHERE dance_item_id=?').run(id);
    bumpCatalog(db);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }

  let mediaDeleted = 0;
  if (deleteMedia) {
    const remove = (relPath) => {
      if (!relPath) return;
      try { unlinkSync(controlledPath(mediaRoot, relPath)); mediaDeleted += 1; } catch { /* 文件不存在或越界：跳过。 */ }
    };
    const clip = db.prepare('SELECT internal_audio_path FROM performance_clips WHERE id=?').get(item.performanceClipId);
    if (clipRefs === 0) remove(clip?.internal_audio_path);
    if (item.sourceMediaId && sourceRefs === 0) {
      const source = db.prepare('SELECT internal_path FROM source_media WHERE id=?').get(item.sourceMediaId);
      remove(source?.internal_path);
    }
    if (item.coverAssetId && coverRefs === 0) {
      const cover = db.prepare('SELECT internal_path FROM assets WHERE id=?').get(item.coverAssetId);
      remove(cover?.internal_path);
    }
  }
  return { deleted: true, mediaDeleted };
}
