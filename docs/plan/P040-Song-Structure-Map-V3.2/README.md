# P040 V3.2 — Song Structure Map (No Accompaniment Processing)

This is an **isolated engineering starter package**, not a modified P040 repository or production APK.

## Scope

Map real-audio-derived sections to `A1/A2/B1/B2/C1`, associate existing LRC lines, support manual split/merge/confirmation and existing P040 section JSON. **Never generate/extract accompaniment or separate vocal stems.** Any future model requiring internal demixing is out of scope in this release.

## Contents

- `docs/P040-Structure-Map-Complete-SDD-V3.2.md`: full standalone Chinese development plan and acceptance criteria.
- `docs/P040-Main-Developer-Handoff-V3.2.md`: complete handoff to the single main desktop developer.
- `src/structure-map.mjs`: pure structure-map core with confirmed-only persistence and Rap restrictions.
- `src/cli.mjs`: all-in-one-like segment JSON + LRC → structure map draft; never reads audio files.
- `src/direct_mix_similarity.py`: OPTIONAL candidate repeat finder using the **unseparated** original mix, requires numpy/librosa.
- `prototype.html`: interactive 390dp Android-style visual (no real playback or database).
- `fixtures/`: original invented, synthetic sample data, not user songs.
- `tests/`: 36 Node tests, one real local audio feature test with generated synthetic wave, and Chromium UI smoke test.

## Quick tests

```
node --test tests/structure-map.test.mjs
python -m unittest discover -s tests -p 'test_*.py' -v
python tests/browser_smoke.py
node src/cli.mjs --analysis fixtures/example-analysis.json --lrc fixtures/example.lrc --duration-ms 180000 --out /tmp/p040-map.json
```

## Evidence / limitations

The actual Mac mini P040 repository was inspected **read-only** with its project connector on 2026-10-30. A real 20-song import is recorded there, but actual audio bytes, database writes, Apple M4 model inference, Android integration, and user acceptance could not be performed through this connection. The original existing song files were not copied into this package. Synthetic QA verifies implementation safety and behavior, **not** model recognition accuracy.
