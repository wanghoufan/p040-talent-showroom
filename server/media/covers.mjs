import { createWriteStream, mkdirSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileIdentity } from './ffmpeg.mjs';
import { getDance, bumpCatalog } from '../catalog.mjs';

const MAX_COVER = 8 * 1024 * 1024;
const SIGNATURES = [
  { type: 'image/jpeg', ext: '.jpg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/png', ext: '.png', test: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: 'image/webp', ext: '.webp', test: b => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
];

/** 人工上传封面（T033/T034）：只接受图片魔数校验，写入 assets 并更新 DanceItem 封面。 */
export async function storeCover(db, mediaRoot, danceId, req) {
  if (!db.prepare('SELECT id FROM dance_items WHERE id=? AND deleted_at IS NULL').get(danceId)) throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
  const declared = req.headers['content-type']?.split(';')[0] || '';
  if (!SIGNATURES.some(s => s.type === declared)) throw Object.assign(new Error('INVALID_MEDIA'), { status: 415 });
  const id = randomUUID();
  mkdirSync(join(mediaRoot, 'covers'), { recursive: true });
  const file = join(mediaRoot, 'covers', id + '.jpg');
  let size = 0; let head = Buffer.alloc(0);
  try {
    await pipeline(req, new Transform({
      transform(chunk, _enc, callback) {
        size += chunk.length;
        if (size > MAX_COVER) return callback(new Error('UPLOAD_TOO_LARGE'));
        if (head.length < 12) head = Buffer.concat([head, chunk]).slice(0, 12);
        callback(null, chunk);
      },
    }), createWriteStream(file, { flags: 'wx' }));
  } catch (error) { try { unlinkSync(file); } catch { /* 保留原始错误。 */ } throw Object.assign(error, { status: error.message === 'UPLOAD_TOO_LARGE' ? 413 : 415 }); }
  const signature = SIGNATURES.find(s => s.test(head));
  if (!signature) { try { unlinkSync(file); } catch { /* 忽略。 */ } throw Object.assign(new Error('INVALID_MEDIA'), { status: 415 }); }
  const finalPath = file.replace(/\.jpg$/, signature.ext);
  if (finalPath !== file) { const { renameSync } = await import('node:fs'); renameSync(file, finalPath); }
  const identity = await fileIdentity(finalPath);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO assets(id,kind,internal_path,sha256,size_bytes) VALUES(?,?,?,?,?)').run(id, 'COVER', relative(mediaRoot, finalPath), identity.sha256, identity.sizeBytes);
    db.prepare('UPDATE dance_items SET cover_asset_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(id, danceId);
    bumpCatalog(db); db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getDance(db, danceId);
}
