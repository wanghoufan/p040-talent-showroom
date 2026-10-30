-- V3.1 本地 AI 智能导入：只新增导入任务/事件/工件三张表。
-- 只作用于本机导入队列，不写 repertoire_items / source_media / performance_clips；
-- 真正入库由后续 V2.1 集成步骤在授权后单独完成。源音乐只读，路径以 root_id + 相对路径表达。
-- conflict_json：入库伴奏冲突时保存「保留旧/使用新」的明确选择现场，默认不静默替换。
-- manual_review_json：记录人工核对/改名过的字段，重扫时不得覆盖。

CREATE TABLE IF NOT EXISTS vocal_import_jobs (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  source_rel_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source_size_bytes INTEGER,
  source_duration_ms INTEGER,
  lyrics_rel_path TEXT,
  lyrics_sha256 TEXT,
  lyrics_timed_lines INTEGER NOT NULL DEFAULT 0,
  supplied_accompaniment_rel_path TEXT,
  title TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  language TEXT CHECK(language IS NULL OR language IN('zh','en','ko')),
  status TEXT NOT NULL CHECK(status IN('NEEDS_REVIEW','PENDING_EXTRACT','EXTRACTING','VERIFYING','READY_TO_IMPORT','IMPORTED','FAILED','CANCELLED')),
  -- 持久区分“只把原唱兜底入库”与“原唱+伴奏双轨已完成”：前者仍可重试补提取伴奏。
  import_mode TEXT NOT NULL DEFAULT 'NONE' CHECK(import_mode IN('NONE','ORIGINAL_ONLY','DUAL_TRACK')),
  stage TEXT NOT NULL DEFAULT 'MATCH' CHECK(stage IN('MATCH','EXTRACT','VERIFY','IMPORT')),
  issues_json TEXT NOT NULL DEFAULT '[]',
  scan_json TEXT NOT NULL DEFAULT '{}',
  artifacts_json TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  conflict_json TEXT NOT NULL DEFAULT '{}',
  manual_review_json TEXT NOT NULL DEFAULT '{}',
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_vocal_import_jobs_status ON vocal_import_jobs(status,created_at);
CREATE INDEX IF NOT EXISTS idx_vocal_import_jobs_song ON vocal_import_jobs(song_id);
CREATE INDEX IF NOT EXISTS idx_vocal_import_jobs_root ON vocal_import_jobs(root_id);
CREATE INDEX IF NOT EXISTS idx_vocal_import_jobs_lease ON vocal_import_jobs(lease_expires_at);

CREATE TABLE IF NOT EXISTS vocal_import_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES vocal_import_jobs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  stage TEXT,
  status TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(job_id,seq)
);

CREATE TABLE IF NOT EXISTS vocal_import_artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES vocal_import_jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN('original','accompaniment','lyrics','analysis')),
  rel_path TEXT NOT NULL,
  sha256 TEXT,
  size_bytes INTEGER,
  duration_ms INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','ready','failed')),
  quality_state TEXT NOT NULL DEFAULT 'unverified' CHECK(quality_state IN('unverified','ready-for-listening-qa')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(job_id,kind,version)
);
