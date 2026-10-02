CREATE TABLE repertoire_items(
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN('GUITAR','VOCAL')),
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 artist TEXT NOT NULL DEFAULT '',
 learning_status TEXT NOT NULL DEFAULT 'WANT_TO_LEARN' CHECK(learning_status IN('CAN_DANCE','PRACTICING','WANT_TO_LEARN')),
 original_key TEXT NOT NULL DEFAULT '', performance_key TEXT NOT NULL DEFAULT '',
 capo INTEGER NOT NULL DEFAULT 0 CHECK(capo BETWEEN 0 AND 12),
 score_text TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
 audio_role TEXT NOT NULL DEFAULT 'REFERENCE' CHECK(audio_role IN('REFERENCE','ACCOMPANIMENT')),
 source_media_id TEXT REFERENCES source_media(id), performance_clip_id TEXT REFERENCES performance_clips(id),
 cover_asset_id TEXT REFERENCES assets(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT
);
CREATE INDEX repertoire_kind_status ON repertoire_items(kind,learning_status) WHERE deleted_at IS NULL;
