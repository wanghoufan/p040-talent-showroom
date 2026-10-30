import { randomUUID } from 'node:crypto';
import { fail } from './errors.mjs';

/**
 * 队列持久化（只写 `vocal_import_*` 三张表）。
 * 该模块刻意不引用任何曲库写入函数：在集成方显式接入入库步骤之前，
 * 扫描/队列阶段不可能写 repertoire_items、source_media 或 performance_clips。
 */
export const JOB_STATUSES = Object.freeze([
  'NEEDS_REVIEW',
  'PENDING_EXTRACT',
  'EXTRACTING',
  'VERIFYING',
  'READY_TO_IMPORT',
  'IMPORTED',
  'FAILED',
  'CANCELLED',
]);
export const JOB_STAGES = Object.freeze(['MATCH', 'EXTRACT', 'VERIFY', 'IMPORT']);

const REQUIRED_TABLES = ['vocal_import_jobs', 'vocal_import_events', 'vocal_import_artifacts'];

export function assertVocalImportSchema(db) {
  const names = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name),
  );
  for (const table of REQUIRED_TABLES) {
    if (!names.has(table)) fail('VOCAL_IMPORT_SCHEMA_MISSING', `缺少迁移 0008_vocal_import.sql（${table}）`);
  }
}

export function withTransaction(db, run) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败时保留原始错误 */
    }
    throw error;
  }
}

function parseJson(text, fallback) {
  try {
    const value = JSON.parse(text ?? '');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

const COLUMN_BY_FIELD = Object.freeze({
  songId: 'song_id',
  rootId: 'root_id',
  sourceRelPath: 'source_rel_path',
  sourceSha256: 'source_sha256',
  sourceSizeBytes: 'source_size_bytes',
  sourceDurationMs: 'source_duration_ms',
  lyricsRelPath: 'lyrics_rel_path',
  lyricsSha256: 'lyrics_sha256',
  lyricsTimedLines: 'lyrics_timed_lines',
  suppliedAccompanimentRelPath: 'supplied_accompaniment_rel_path',
  title: 'title',
  artist: 'artist',
  language: 'language',
  status: 'status',
  importMode: 'import_mode',
  stage: 'stage',
  issuesJson: 'issues_json',
  scanJson: 'scan_json',
  artifactsJson: 'artifacts_json',
  attempts: 'attempts',
  maxAttempts: 'max_attempts',
  cancelRequested: 'cancel_requested',
  conflictJson: 'conflict_json',
  manualReviewJson: 'manual_review_json',
  leaseOwner: 'lease_owner',
  leaseExpiresAt: 'lease_expires_at',
  lastErrorCode: 'last_error_code',
  lastErrorMessage: 'last_error_message',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
});

export function appendEvent(db, jobId, { event, stage = null, status = null, detail = {} }) {
  const next = db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM vocal_import_events WHERE job_id=?').get(jobId).seq;
  db.prepare(
    'INSERT INTO vocal_import_events(job_id,seq,event,stage,status,detail_json) VALUES(?,?,?,?,?,?)',
  ).run(jobId, next, event, stage, status, JSON.stringify(detail ?? {}));
}

/** 幂等插入：同一 `idempotency_key` 只保留一条任务，返回是否新建。 */
export function insertJob(db, job) {
  return withTransaction(db, () => {
    const existing = db.prepare('SELECT * FROM vocal_import_jobs WHERE idempotency_key=?').get(job.idempotencyKey);
    if (existing) return { row: existing, created: false };
    const id = job.id ?? randomUUID();
    db.prepare(
      `INSERT INTO vocal_import_jobs(
        id,song_id,root_id,source_rel_path,source_sha256,source_size_bytes,source_duration_ms,
        lyrics_rel_path,lyrics_sha256,lyrics_timed_lines,supplied_accompaniment_rel_path,
        title,artist,language,status,stage,issues_json,scan_json,artifacts_json,
        attempts,max_attempts,idempotency_key
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      job.songId,
      job.rootId,
      job.sourceRelPath,
      job.sourceSha256,
      job.sourceSizeBytes ?? null,
      job.sourceDurationMs ?? null,
      job.lyricsRelPath ?? null,
      job.lyricsSha256 ?? null,
      job.lyricsTimedLines ?? 0,
      job.suppliedAccompanimentRelPath ?? null,
      job.title ?? '',
      job.artist ?? '',
      job.language ?? null,
      job.status,
      job.stage ?? 'MATCH',
      JSON.stringify(job.issues ?? []),
      JSON.stringify(job.scan ?? {}),
      JSON.stringify(job.artifacts ?? {}),
      job.attempts ?? 0,
      job.maxAttempts ?? 3,
      job.idempotencyKey,
    );
    appendEvent(db, id, { event: 'created', stage: job.stage ?? 'MATCH', status: job.status, detail: { songId: job.songId } });
    return { row: db.prepare('SELECT * FROM vocal_import_jobs WHERE id=?').get(id), created: true };
  });
}

export function getJobRow(db, id) {
  return db.prepare('SELECT * FROM vocal_import_jobs WHERE id=?').get(String(id ?? ''));
}

export function requireJobRow(db, id) {
  const row = getJobRow(db, id);
  if (!row) fail('JOB_NOT_FOUND', '导入任务不存在');
  return row;
}

export function listJobRows(db, { status, rootId, songId, limit = 200 } = {}) {
  const conditions = [];
  const params = [];
  if (status) {
    if (!JOB_STATUSES.includes(status)) fail('BAD_REQUEST', '未知任务状态');
    conditions.push('status=?');
    params.push(status);
  }
  if (rootId) {
    conditions.push('root_id=?');
    params.push(rootId);
  }
  if (songId) {
    conditions.push('song_id=?');
    params.push(songId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  return db
    .prepare(`SELECT * FROM vocal_import_jobs ${where} ORDER BY created_at ASC,id ASC LIMIT ${safeLimit}`)
    .all(...params);
}

export function updateJob(db, id, fields) {
  const entries = Object.entries(fields).filter(([key]) => COLUMN_BY_FIELD[key]);
  if (!entries.length) return getJobRow(db, id);
  const assignments = entries.map(([key]) => `${COLUMN_BY_FIELD[key]}=?`);
  const params = entries.map(([, value]) => value);
  db.prepare(`UPDATE vocal_import_jobs SET ${assignments.join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(...params, id);
  return getJobRow(db, id);
}

/**
 * 条件更新：只有仍满足领取身份/状态时才写入。
 * `leaseOwner`/`leaseExpiresAt` 传 `null` 表示要求对应列为 NULL。
 * 返回更新后的行；条件不满足（已被新 worker 接管或状态已变化）返回 null，
 * 让调用方把迟到的写入变成 no-op，而不是覆盖别人的结果。
 */
export function updateJobIf(db, id, fields, { status, statuses, leaseOwner, leaseExpiresAt } = {}) {
  const entries = Object.entries(fields).filter(([key]) => COLUMN_BY_FIELD[key]);
  const assignments = entries.map(([key]) => `${COLUMN_BY_FIELD[key]}=?`);
  const params = entries.map(([, value]) => value);
  const conditions = ['id=?'];
  const conditionParams = [id];
  if (status !== undefined) {
    conditions.push('status=?');
    conditionParams.push(status);
  }
  if (Array.isArray(statuses) && statuses.length) {
    conditions.push(`status IN(${statuses.map(() => '?').join(',')})`);
    conditionParams.push(...statuses);
  }
  if (leaseOwner !== undefined) {
    if (leaseOwner === null) {
      conditions.push('lease_owner IS NULL');
    } else {
      conditions.push('lease_owner=?');
      conditionParams.push(leaseOwner);
    }
  }
  if (leaseExpiresAt !== undefined) {
    if (leaseExpiresAt === null) {
      conditions.push('lease_expires_at IS NULL');
    } else {
      conditions.push('lease_expires_at=?');
      conditionParams.push(leaseExpiresAt);
    }
  }
  const setClause = assignments.length ? `${assignments.join(',')},` : '';
  const result = db
    .prepare(`UPDATE vocal_import_jobs SET ${setClause}updated_at=CURRENT_TIMESTAMP WHERE ${conditions.join(' AND ')}`)
    .run(...params, ...conditionParams);
  return Number(result.changes) > 0 ? getJobRow(db, id) : null;
}

export function upsertArtifact(db, jobId, artifact) {
  const existing = db.prepare('SELECT id FROM vocal_import_artifacts WHERE job_id=? AND kind=? AND version=?')
    .get(jobId, artifact.kind, artifact.version ?? 1);
  if (existing) {
    db.prepare(
      `UPDATE vocal_import_artifacts SET rel_path=?,sha256=?,size_bytes=?,duration_ms=?,state=?,quality_state=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    ).run(
      artifact.relPath,
      artifact.sha256 ?? null,
      artifact.sizeBytes ?? null,
      artifact.durationMs ?? null,
      artifact.state ?? 'pending',
      artifact.qualityState ?? 'unverified',
      existing.id,
    );
    return existing.id;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO vocal_import_artifacts(id,job_id,kind,rel_path,sha256,size_bytes,duration_ms,version,state,quality_state)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    jobId,
    artifact.kind,
    artifact.relPath,
    artifact.sha256 ?? null,
    artifact.sizeBytes ?? null,
    artifact.durationMs ?? null,
    artifact.version ?? 1,
    artifact.state ?? 'pending',
    artifact.qualityState ?? 'unverified',
  );
  return id;
}

export function listArtifacts(db, jobId) {
  return db.prepare('SELECT * FROM vocal_import_artifacts WHERE job_id=? ORDER BY kind,version').all(jobId);
}

export function listEvents(db, jobId, limit = 100) {
  return db.prepare('SELECT seq,event,stage,status,detail_json,created_at FROM vocal_import_events WHERE job_id=? ORDER BY seq DESC LIMIT ?')
    .all(jobId, Math.min(Math.max(Number(limit) || 100, 1), 500))
    .reverse()
    .map(row => ({
      seq: row.seq,
      event: row.event,
      stage: row.stage ?? undefined,
      status: row.status ?? undefined,
      detail: parseJson(row.detail_json, {}),
      createdAt: row.created_at,
    }));
}

/** 对外的任务结构：只有 rootId + 相对路径，永远不回显本机绝对路径。 */
export function toPublicJob(row, { events = [] } = {}) {
  if (!row) return null;
  const scan = parseJson(row.scan_json, {});
  const repeatCandidates = Array.isArray(scan.lyricsRepeatCandidates) ? scan.lyricsRepeatCandidates : [];
  return {
    id: row.id,
    songId: row.song_id,
    rootId: row.root_id,
    status: row.status,
    importMode: row.import_mode ?? 'NONE',
    stage: row.stage,
    title: row.title,
    artist: row.artist,
    language: row.language ?? null,
    original: {
      relPath: row.source_rel_path,
      sha256: row.source_sha256,
      sizeBytes: row.source_size_bytes ?? null,
      durationMs: row.source_duration_ms ?? null,
    },
    lyrics: row.lyrics_rel_path
      ? { relPath: row.lyrics_rel_path, sha256: row.lyrics_sha256 ?? null, timedLines: row.lyrics_timed_lines }
      : null,
    suppliedAccompaniment: row.supplied_accompaniment_rel_path ?? null,
    issues: parseJson(row.issues_json, []),
    // 仅提示：LRC 文本重复候选，不推断旋律/段落，不改写入库结构。
    repeatCandidates,
    repeatCandidateStatus: typeof scan.lyricsRepeatStatus === 'string' ? scan.lyricsRepeatStatus : 'unknown',
    artifacts: parseJson(row.artifacts_json, {}),
    conflict: parseJson(row.conflict_json, {}),
    manualReview: parseJson(row.manual_review_json, {}),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    cancelRequested: Boolean(row.cancel_requested),
    error: row.last_error_code ? { code: row.last_error_code, message: row.last_error_message ?? '' } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    events,
  };
}
