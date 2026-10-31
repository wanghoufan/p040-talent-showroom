-- P040 歌词中文译文：原译分离、按歌词行 id 关联，不改动 lyrics_json 的时间轴。
-- translations_json 只存译文与来源，不复制原文；缓存表按 provider/model/原文哈希去重，离线时直接读曲目数据。
ALTER TABLE repertoire_items ADD COLUMN translations_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS vocal_translation_cache (
  cache_key TEXT PRIMARY KEY,
  source_lang TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  source_text TEXT NOT NULL,
  target_text TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vocal_translation_cache_last_used ON vocal_translation_cache(last_used_at);
