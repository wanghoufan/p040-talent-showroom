"""Original mixed-audio similarity proposals; NO source separation, NO accompaniment creation.

Uses chroma CENS + short temporal statistics. The score is harmonic/arrangement
similarity, NOT proof of same melody. Only used to propose candidate repeats.
Do not overwrite user-authoritative sections with its results.
"""
from __future__ import annotations
import argparse
import json
import math
from pathlib import Path
from itertools import combinations
import numpy as np


def _signature(chroma: np.ndarray, start_sec: float, end_sec: float, fps: float) -> np.ndarray | None:
    start = max(0, int(math.floor(start_sec * fps)))
    end = min(chroma.shape[1], int(math.ceil(end_sec * fps)))
    if end - start < 4:
        return None
    samples = chroma[:, start:end]
    # Global pitch-profile and dynamics summary; harmonic similarity is NOT melody identity.
    parts = [np.mean(samples, axis=1), np.std(samples, axis=1)]
    for window in np.array_split(samples, 4, axis=1):
        parts.append(np.mean(window, axis=1))
    vector = np.concatenate(parts).astype(float)
    norm = np.linalg.norm(vector)
    return vector / norm if norm > 1e-12 else None


def calculate_similarity(audio_path: Path, analysis: dict, sr: int = 22050, hop_length: int = 1024) -> dict:
    import librosa
    if not audio_path.is_file():
        raise FileNotFoundError(str(audio_path))
    segments = analysis.get('segments')
    if not isinstance(segments, list):
        raise ValueError('MODEL_SEGMENTS_REQUIRED')
    # Read the original entire MIX only. No demixing or instrument extraction calls.
    y, loaded_sr = librosa.load(str(audio_path), sr=sr, mono=True)
    if len(y) == 0:
        raise ValueError('EMPTY_AUDIO')
    chroma = librosa.feature.chroma_cens(y=y, sr=loaded_sr, hop_length=hop_length)
    fps = loaded_sr / hop_length
    vectors = {}
    for i, seg in enumerate(segments):
        if seg.get('label') not in ('verse','chorus','bridge','pre','pre-chorus'):
            continue
        vectors[i] = _signature(chroma, float(seg['start']), float(seg['end']), fps)
    evidence = []
    for a,b in combinations(vectors,2):
        if segments[a].get('label') != segments[b].get('label'):
            continue
        v1,v2=vectors[a],vectors[b]
        if v1 is None or v2 is None:continue
        score = float(np.clip(np.dot(v1,v2),0,1))
        if score >= 0.65:
            evidence.append({'left':a,'right':b,'score':round(score,4),'method':'mixed-chroma-cens','status':'pending-confirmation'})
    return {'schema':'p040.audio-similarity.proposal.v1', 'origin':'original-mix-only',
            'durationSec': round(len(y)/loaded_sr,3), 'audioEvidence':evidence,
            'explanation':'Harmonic similarity only. Melody, lyrics, and section roles must be verified before confirming repetition.'}


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--audio',required=True,help='Original MP3/WAV/FLAC, read only')
    ap.add_argument('--analysis',required=True,help='Existing JSON with audio-derived segments')
    ap.add_argument('--out',required=True,help='Write proposals JSON outside original audio path')
    opts=ap.parse_args()
    audio=Path(opts.audio).resolve(strict=True)
    out=Path(opts.out).resolve()
    if out == audio or out == Path(opts.analysis).resolve():
        ap.error('OUT_OVERWRITES_SOURCE')
    result=calculate_similarity(audio,json.loads(Path(opts.analysis).read_text(encoding='utf-8')))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(f'{len(result["audioEvidence"])} similarity candidate(s) written to {out}; none auto-confirmed')

if __name__=='__main__':main()
