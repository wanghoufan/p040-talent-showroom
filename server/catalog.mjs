import {listScores} from './scores/service.mjs';
import { getProgram,writeProgram } from './program/service.mjs';
import { listRepertoire } from './repertoire/service.mjs';
export const STATUSES=['CAN_DANCE','PRACTICING','WANT_TO_LEARN'];
export const SCENES=['COOL','SEXY','OUTDOOR','TRANSITION'];
export function sceneMask(tags) {
  if(!Array.isArray(tags)||tags.length>4||tags.some(t=>!SCENES.includes(t))||new Set(tags).size!==tags.length) throw new Error('INVALID_TAGS');
  return tags.reduce((mask,tag)=>mask|(1<<SCENES.indexOf(tag)),0);
}
export function bumpCatalog(db) { db.exec('UPDATE catalog_meta SET catalog_version=catalog_version+1,updated_at=CURRENT_TIMESTAMP WHERE singleton=1'); }
export function getDance(db,id,includeDeleted=false) {
  const row=db.prepare(`SELECT d.*,s.title,s.artist,c.sha256 AS audio_hash,c.size_bytes AS audio_size,c.version AS audio_version,c.duration_ms,c.start_ms,c.end_ms,c.source_preserving,a.sha256 AS cover_hash,a.size_bytes AS cover_size,m.duration_ms AS source_duration,m.sha256 AS source_hash,m.source_kind,m.source_locator
    FROM dance_items d JOIN performance_clips c ON c.id=d.performance_clip_id LEFT JOIN song_identities s ON s.id=d.song_identity_id LEFT JOIN assets a ON a.id=d.cover_asset_id LEFT JOIN source_media m ON m.id=d.source_media_id WHERE d.id=? AND (d.deleted_at IS NULL OR ?)`).get(id,includeDeleted?1:0);
  if(!row) return null;
  return { scores:listScores(db,{kind:'DANCE',id:row.id}),revision:row.revision,isDemo:!!db.prepare("SELECT 1 FROM demo_records WHERE kind='DANCE' AND item_id=?").get(row.id),id:row.id,title:row.title_override||row.title||'未识别舞蹈',artist:row.artist||'未识别',learningStatus:row.learning_status,sceneTags:SCENES.filter((_,i)=>row.scene_mask&(1<<i)),sourceMediaId:row.source_media_id||undefined,performanceClipId:row.performance_clip_id,coverAssetId:row.cover_asset_id||undefined,durationMs:row.duration_ms,
    audio:{id:row.performance_clip_id,url:`/api/media/audio/${row.performance_clip_id}`,sha256:row.audio_hash,sizeBytes:row.audio_size,version:row.audio_version,startMs:row.start_ms,endMs:row.end_ms,sourcePreserving:!!row.source_preserving},
    cover:row.cover_asset_id?{id:row.cover_asset_id,url:`/api/media/cover/${row.cover_asset_id}`,sha256:row.cover_hash,sizeBytes:row.cover_size,version:1}:undefined,
    source:row.source_media_id?{id:row.source_media_id,durationMs:row.source_duration,sha256:row.source_hash,sourceKind:row.source_kind,sourceLocator:row.source_locator||undefined}:undefined };
}
/** 离线同步清单：曲库快照 + 每首媒体 size/hash/version + 今晚歌单。无绝对路径。 */
export function getManifest(db) {
  const rows=db.prepare('SELECT id FROM dance_items WHERE deleted_at IS NULL ORDER BY created_at DESC,id').all();
  const items=rows.map(({id})=>getDance(db,id));
  const playlist=db.prepare('SELECT dance_item_id AS id FROM tonight_playlist_items ORDER BY position').all().map(({id})=>id).filter(id=>items.some(item=>item.id===id));
  return { catalogVersion:db.prepare('SELECT catalog_version AS v FROM catalog_meta WHERE singleton=1').get().v, mode:'FULL', count:items.length, items, playlist, repertoire:listRepertoire(db).items,program:getProgram(db) };
}
export function getCatalog(db,params=new URLSearchParams()) {
  const status=params.get('status');
  if(status&&!STATUSES.includes(status)) throw new Error('INVALID_STATUS');
  const mask=sceneMask(params.getAll('scene'));
  const rows=db.prepare('SELECT id FROM dance_items WHERE deleted_at IS NULL AND (? IS NULL OR learning_status=?) AND (scene_mask & ?)=? ORDER BY created_at DESC,id').all(status,status,mask,mask);
  const query=(params.get('q')||'').toLocaleLowerCase();
  return { catalogVersion:db.prepare('SELECT catalog_version AS v FROM catalog_meta WHERE singleton=1').get().v,items:rows.map(({id})=>getDance(db,id)).filter(item=>!query||`${item.title} ${item.artist}`.toLocaleLowerCase().includes(query)) };
}
/** 今晚歌单（有序 dance item id 列表）。 */
export function getPlaylist(db) {
  return { items:db.prepare('SELECT dance_item_id AS id FROM tonight_playlist_items ORDER BY position').all().map(({id})=>id) };
}
/** 覆盖式写入今晚歌单；position 稳定递增，事务保证一致。 */
export function setPlaylist(db,ids) {
  if(!Array.isArray(ids)||ids.length>200||ids.some((id)=>typeof id!=='string')) throw new Error('BAD_REQUEST');
  if(ids.length+getProgram(db).items.filter(r=>r.kind!=='DANCE').length>200)throw new Error('BAD_REQUEST');
  if(new Set(ids).size!==ids.length) throw new Error('BAD_REQUEST');
  const valid=new Set(db.prepare('SELECT id FROM dance_items WHERE deleted_at IS NULL').all().map(({id})=>id));
  if(ids.some((id)=>!valid.has(id))) throw new Error('NOT_FOUND');
  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare('DELETE FROM tonight_playlist_items').run();
    const insert=db.prepare('INSERT INTO tonight_playlist_items(dance_item_id,position,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)');
    ids.forEach((id,index)=>insert.run(id,index));
    writeProgram(db,[...ids.map(id=>({kind:'DANCE',id})),...getProgram(db).items.filter(r=>r.kind!=='DANCE')]);
    bumpCatalog(db);db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  return { items:ids };
}
