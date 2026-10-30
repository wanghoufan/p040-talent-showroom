-- Additive migration for P040 VOCAL only. Never drops or updates legacy audio links.
-- The caller (server/db/database.mjs) wraps migrations in BEGIN/COMMIT.
ALTER TABLE repertoire_items ADD COLUMN language_code TEXT NOT NULL DEFAULT 'und'
  CHECK(language_code IN ('zh','en','ko','other','und'));
CREATE TABLE vocal_tracks (
  song_id TEXT NOT NULL REFERENCES repertoire_items(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('original','accompaniment')),
  performance_clip_id TEXT NOT NULL REFERENCES performance_clips(id),
  offset_ms INTEGER NOT NULL DEFAULT 0 CHECK(offset_ms BETWEEN -600000 AND 600000),
  source_type TEXT NOT NULL DEFAULT 'manual' CHECK(source_type IN ('manual','ai-separated','legacy')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(song_id, role)
);
CREATE INDEX vocal_tracks_clip ON vocal_tracks(performance_clip_id);
-- A preexisting solo file must map to exactly one role, never two.
INSERT INTO vocal_tracks(song_id,role,performance_clip_id,source_type)
SELECT id,CASE WHEN audio_role='ACCOMPANIMENT' THEN 'accompaniment' ELSE 'original' END,
       performance_clip_id,'legacy'
FROM repertoire_items
WHERE kind='VOCAL' AND performance_clip_id IS NOT NULL;
CREATE TABLE vocal_analysis (
  song_id TEXT PRIMARY KEY REFERENCES repertoire_items(id) ON DELETE CASCADE,
  lyrics_json TEXT NOT NULL DEFAULT '[]',
  sections_json TEXT NOT NULL DEFAULT '[]',
  analysis_state TEXT NOT NULL DEFAULT 'pending'
    CHECK(analysis_state IN ('pending','needs-review','ready')),
  manual_corrections INTEGER NOT NULL DEFAULT 0 CHECK(manual_corrections IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
