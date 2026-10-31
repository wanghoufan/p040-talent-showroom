-- P040 V3.2 歌曲结构草稿：AI/算法结果与用户确认后的正式结构严格分离。
-- 只新增一张表，不改 repertoire_items 现有列，也不迁移任何历史数据。
-- legacy_sections_json 保存生成草稿时的旧结构快照，供「恢复旧结构」使用。

CREATE TABLE IF NOT EXISTS vocal_structure_drafts (
  song_id TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL,
  model_name TEXT NOT NULL,
  model_version TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  state TEXT NOT NULL DEFAULT 'DRAFT' CHECK(state IN('DRAFT','NEEDS_REVIEW','APPLIED','DISCARDED')),
  base_revision INTEGER,
  map_json TEXT NOT NULL,
  analysis_json TEXT NOT NULL DEFAULT '{}',
  legacy_sections_json TEXT NOT NULL DEFAULT '[]',
  applied_revision INTEGER,
  applied_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_vocal_structure_drafts_state ON vocal_structure_drafts(state);
