-- V2.1 唱歌持久化：语言、逐句歌词、人工结构、练习设置、两条独立音轨与对齐偏移。
-- 纯增量列；旧 audio_role / performance_clip_id 原样保留，旧单音轨按 audioRole 精确映射到其中一轨，另一轨保持 NULL。
ALTER TABLE repertoire_items ADD COLUMN vocal_language TEXT CHECK(vocal_language IS NULL OR vocal_language IN('zh','en','ko'));
ALTER TABLE repertoire_items ADD COLUMN lyrics_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE repertoire_items ADD COLUMN sections_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE repertoire_items ADD COLUMN practice_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE repertoire_items ADD COLUMN original_clip_id TEXT REFERENCES performance_clips(id);
ALTER TABLE repertoire_items ADD COLUMN accompaniment_clip_id TEXT REFERENCES performance_clips(id);
ALTER TABLE repertoire_items ADD COLUMN original_offset_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repertoire_items ADD COLUMN accompaniment_offset_ms INTEGER NOT NULL DEFAULT 0;
