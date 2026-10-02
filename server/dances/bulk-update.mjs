import { STATUSES, sceneMask, bumpCatalog, getDance } from '../catalog.mjs';

/** Classifications only: validate the entire selection before one atomic write. */
export function bulkUpdateDances(db, body) {
  if (Object.keys(body).some(key => !['ids', 'learningStatus', 'sceneTags', 'sceneMode'].includes(key))) throw new Error('BAD_REQUEST');
  const { ids, learningStatus, sceneTags, sceneMode } = body;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 1000 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) throw new Error('BAD_REQUEST');
  if (learningStatus !== undefined && !STATUSES.includes(learningStatus)) throw new Error('INVALID_STATUS');
  const changeTags = sceneTags !== undefined;
  if (!changeTags && (sceneMode !== undefined || learningStatus === undefined)) throw new Error('BAD_REQUEST');
  const mask = changeTags ? sceneMask(sceneTags) : 0;
  if (changeTags && (!['add', 'remove', 'replace'].includes(sceneMode) || (sceneMode !== 'replace' && sceneTags.length === 0))) throw new Error('INVALID_TAGS');
  db.exec('BEGIN IMMEDIATE');
  try {
    const find = db.prepare('SELECT learning_status,scene_mask FROM dance_items WHERE id=? AND deleted_at IS NULL');
    const rows = ids.map(id => {
      const row = find.get(id);
      if (!row) throw new Error('NOT_FOUND');
      return { id, ...row };
    });
    const update = db.prepare('UPDATE dance_items SET learning_status=?,scene_mask=?,updated_at=CURRENT_TIMESTAMP WHERE id=?');
    for (const row of rows) {
      const nextMask = !changeTags ? row.scene_mask : sceneMode === 'add' ? row.scene_mask | mask : sceneMode === 'remove' ? row.scene_mask & ~mask : mask;
      update.run(learningStatus ?? row.learning_status, nextMask, row.id);
    }
    bumpCatalog(db);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { items: ids.map(id => getDance(db, id)), catalogVersion: db.prepare('SELECT catalog_version AS v FROM catalog_meta WHERE singleton=1').get().v };
}
