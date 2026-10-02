# Data Model

## Server authoritative tables

- `dance_items`: id, song_identity_id, source_media_id, performance_clip_id, title_override, learning_status, scene_mask, cover_asset_id, created_at, updated_at, deleted_at.
- `source_media`: id, source_kind, source_locator, internal_path, sha256, duration_ms, audio_codec, video_codec, status.
- `performance_clips`: id, source_media_id, start_ms, end_ms, internal_audio_path, codec, source_preserving, sha256, size_bytes, duration_ms, version.
- `song_identities`: id, title, artist, recognition_status, provider, provider_ref, confidence, cover_asset_id.
- `import_jobs`: id, source_kind, status, stage, error_code, draft_json, created_at, updated_at.
- `tonight_playlist_items`: dance_item_id, position, updated_at.
- `assets`: id, kind, internal_path, sha256, size_bytes, created_at.
- `catalog_meta`: singleton catalog_version / updated_at.

## Fixed enums

- LearningStatus: `CAN_DANCE | PRACTICING | WANT_TO_LEARN`
- SceneTag: `COOL | SEXY | OUTDOOR | TRANSITION`
- ImportStatus: `PENDING | PROCESSING | NEEDS_INPUT | READY | FAILED`
- ImportStage: `ACQUIRE | PROBE | EXTRACT | RECOGNIZE | COVER | REVIEW`
- RecognitionStatus: `UNTRIED | MATCHED | AMBIGUOUS | FAILED | MANUAL`

## Android local files

```text
files/
  catalog/catalog.json
  catalog/offline-manifest.json
  queue/pending-shares.json
  media/audio/<clip-id>.<ext>
  media/covers/<asset-id>.<ext>
  media/reference/<source-id>.mp4   # optional offline learning
```

Device settings store only theme/api endpoint/last sync; media readiness comes from manifest + filesystem validation, not Preferences booleans.
