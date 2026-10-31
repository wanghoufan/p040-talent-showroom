#!/usr/bin/env python3
"""原唱混音直接分析：乐段边界 + 声学重复候选（P040 V3.2 T2）。

硬约束（SDD §2.1 / §2.2 / AC-08）：
- **只读原曲混音**，不做人声/伴奏分离，不调用 Demucs / audio-separator / UVR / Spleeter；
  结果 JSON 里 `separation.used` 必须为 false，并列出检测到的分离模块（应为空）。
- 不联网、不下载权重；只用本机 librosa 特征（CENS 和声 + MFCC 音色）。
- 输出仅到 `--out` 指定文件；源音频只读，前后都不写。
- 只给「边界」和「声学相似候选」。**不判定主歌/副歌，也不宣称同旋律**；
  类型由用户在 P040 界面确认（SDD §2.1）。

用法：
  python analyze.py --audio /只读/一首歌.mp3 --out /隔离目录/analysis.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import resource
import subprocess
import sys
import tempfile
import time

MODEL_NAME = "p040-mix-structure"
MODEL_VERSION = "1.1.0"

SAMPLE_RATE = 11025
HOP_LENGTH = 256
MIN_SEGMENT_SECONDS = 8.0
# 簇内平均余弦相似度阈值（1 - 距离）。低于它的段不算同一类。
CLUSTER_SIMILARITY = 0.55
# 重复候选阈值：只提示，不当作已确认重复。
RELATION_SIMILARITY = 0.55
MAX_RELATIONS = 24
# 这些模块一旦出现在进程里，说明有分离链路被拉起；直接拒绝出结果。
FORBIDDEN_MODULES = ("audio_separator", "demucs", "spleeter", "uvr5", "torchaudio.pipelines")


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_audio(path: str):
    """直接解码原唱混音；soundfile 不支持时用 ffmpeg 解码成临时 wav（仍是原混音）。"""
    import librosa

    try:
        y, sr = librosa.load(path, sr=SAMPLE_RATE, mono=True)
        if y.size:
            return y, sr, "soundfile"
    except Exception:  # noqa: BLE001 - 编码不支持时回退，不是错误路径
        pass
    with tempfile.TemporaryDirectory(prefix="p040-structure-") as work:
        wav = os.path.join(work, "decoded.wav")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", path, "-ac", "1", "-ar", str(SAMPLE_RATE), wav],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        y, sr = librosa.load(wav, sr=SAMPLE_RATE, mono=True)
        return y, sr, "ffmpeg-decode"


def _unit_columns(matrix):
    import numpy as np

    norms = np.linalg.norm(matrix, axis=0, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


def _standardize(matrix):
    import numpy as np

    mean = matrix.mean(axis=1, keepdims=True)
    std = matrix.std(axis=1, keepdims=True)
    std[std == 0] = 1.0
    return (matrix - mean) / std


def _novelty_curve(affinity, half_window: int = 8):
    """棋盘核自相似新颖度：段内相似、段间不相似的位置得分高。"""
    import numpy as np

    size = affinity.shape[0]
    if size < 2 * half_window + 2:
        return np.zeros(size)
    offsets = np.arange(-half_window, half_window)
    gauss = np.exp(-0.5 * (offsets / (half_window / 2.0)) ** 2)
    kernel = np.outer(gauss, gauss) * np.outer(np.sign(offsets), np.sign(offsets))
    curve = np.zeros(size)
    for index in range(half_window, size - half_window):
        block = affinity[index - half_window:index + half_window, index - half_window:index + half_window]
        curve[index] = float(np.sum(block * kernel))
    curve = np.maximum(curve, 0.0)
    peak = float(curve.max()) if curve.size else 0.0
    return curve / peak if peak > 0 else curve


def _merge_short_segments(boundaries, strengths, duration, min_segment):
    """边界过密时优先删最弱边界，直到每段都不短于 min_segment（降低碎片化）。"""
    bounds = list(boundaries)
    scores = list(strengths)
    while len(bounds) > 2:
        short = [i for i in range(1, len(bounds)) if bounds[i] - bounds[i - 1] < min_segment]
        if not short:
            break
        candidates = []
        for i in short:
            if i - 1 > 0:
                candidates.append(i - 1)
            if i < len(bounds) - 1:
                candidates.append(i)
        if not candidates:
            break
        weakest = min(candidates, key=lambda idx: scores[idx] if idx < len(scores) else 0.0)
        bounds.pop(weakest)
        if weakest < len(scores):
            scores.pop(weakest)
    if bounds[-1] < duration:
        bounds[-1] = duration
    return bounds


def _cluster(features):
    """段级特征 → 相似度矩阵 + 簇编号。

    平均连接层次聚类（cosine 距离）避免单连接「链式合并」把整首歌串成一簇；
    scipy 不可用时退回阈值并查集。
    """
    import numpy as np

    unit = _unit_columns(features)
    similarity = unit.T @ unit
    size = unit.shape[1]
    if size == 0:
        return [], similarity
    labels = None
    try:
        from scipy.cluster.hierarchy import fcluster, linkage
        from scipy.spatial.distance import squareform

        distance = np.clip(1.0 - similarity, 0.0, 2.0)
        condensed = squareform(distance, checks=False)
        tree = linkage(condensed, method="average")
        raw = fcluster(tree, t=1.0 - CLUSTER_SIMILARITY, criterion="distance")
        labels = [f"c{int(value)}" for value in raw]
    except Exception:  # noqa: BLE001 - 缺 scipy 时用并查集兜底
        parent = list(range(size))

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        for i in range(size):
            for j in range(i + 1, size):
                if similarity[i, j] >= CLUSTER_SIMILARITY:
                    ri, rj = find(i), find(j)
                    if ri != rj:
                        parent[max(ri, rj)] = min(ri, rj)
        mapping = {}
        labels = []
        for index in range(size):
            root = find(index)
            mapping.setdefault(root, f"c{len(mapping) + 1}")
            labels.append(mapping[root])
    # 按出现顺序重新编号，保证同样输入永远得到同样的 c1/c2…
    order = {}
    normalized = []
    for label in labels:
        if label not in order:
            order[label] = f"c{len(order) + 1}"
        normalized.append(order[label])
    return normalized, similarity


def analyze(audio_path: str, min_segment: float = MIN_SEGMENT_SECONDS):
    import librosa
    import numpy as np

    started = time.time()
    audio_sha = sha256_file(audio_path)
    y, sr, decoder = load_audio(audio_path)
    duration = len(y) / sr

    chroma = librosa.feature.chroma_cens(y=y, sr=sr, hop_length=HOP_LENGTH)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, hop_length=HOP_LENGTH, n_mfcc=13)
    rms = librosa.feature.rms(y=y, hop_length=HOP_LENGTH)[0]
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=HOP_LENGTH, units="frames")
    if len(beat_frames) < 24:
        # 极端情况（清唱/极短音频）：退回固定 2 秒网格，仍然只描述音频，不编造段类型。
        step = int(round(2.0 * sr / HOP_LENGTH))
        beat_frames = np.arange(step, chroma.shape[1], step)

    beat_chroma = librosa.util.sync(chroma, beat_frames, aggregate=np.median, pad=False)
    beat_mfcc = librosa.util.sync(mfcc, beat_frames, aggregate=np.median, pad=False)
    width = min(beat_chroma.shape[1], beat_mfcc.shape[1], len(beat_frames))
    beat_chroma = beat_chroma[:, :width]
    beat_mfcc = beat_mfcc[:, :width]
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP_LENGTH)[:width]

    # 音色 + 和声分别标准化后拼接：只归一化的 CENS 对任何流行歌都接近 1，无法区分段落。
    features = _unit_columns(np.vstack([_standardize(beat_chroma), _standardize(beat_mfcc)]))
    affinity = features.T @ features
    novelty = _novelty_curve(affinity)
    peaks = librosa.util.peak_pick(
        novelty,
        pre_max=8, post_max=8, pre_avg=16, post_avg=16,
        delta=float(novelty.max()) * 0.09 if novelty.size else 0.0,
        wait=6,
    )
    interior = [float(round(beat_times[p], 2)) for p in peaks if 0 < p < len(beat_times)]
    boundaries = [0.0] + sorted({value for value in interior if 0 < value < duration}) + [round(duration, 3)]
    strengths = [0.0] + [float(novelty[p]) for p in peaks if 0 < p < len(beat_times)] + [0.0]
    strengths = strengths[: len(boundaries)]
    boundaries = _merge_short_segments(boundaries, strengths, round(duration, 3), min_segment)

    frames_per_second = sr / HOP_LENGTH
    vectors = []
    segments = []
    for index in range(len(boundaries) - 1):
        start, end = boundaries[index], boundaries[index + 1]
        inside = (beat_times >= start) & (beat_times < end)
        vector = np.median(features[:, inside], axis=1) if inside.any() else np.median(features, axis=1)
        vectors.append(vector)
        f0 = int(start * frames_per_second)
        f1 = max(f0 + 1, int(end * frames_per_second))
        segments.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "rms": round(float(np.mean(rms[f0:f1])) if f1 > f0 else 0.0, 5),
        })

    labels, similarity = _cluster(np.vstack(vectors).T) if vectors else ([], np.zeros((0, 0)))

    relations = []
    merge_candidates = []
    for i in range(len(segments)):
        for j in range(i + 1, len(segments)):
            score = float(similarity[i, j]) if similarity.size else 0.0
            if j == i + 1:
                # 相邻且很像 ⇒ 更可能是同一段被切碎，提示合并而不是「重复」。
                if score >= 0.72:
                    merge_candidates.append({"left": i, "right": j, "score": round(score, 4)})
                continue
            if score < RELATION_SIMILARITY:
                continue
            relations.append({
                "left": i,
                "right": j,
                "score": round(score, 4),
                "method": "chroma-cens+mfcc-cosine",
            })
    relations.sort(key=lambda row: -row["score"])
    relations = relations[:MAX_RELATIONS]

    for index, segment in enumerate(segments):
        segment["clusterId"] = labels[index] if index < len(labels) else None
        segment["label"] = "segment"
        segment["confidence"] = None

    separation_modules = [name for name in FORBIDDEN_MODULES if name in sys.modules]
    elapsed = time.time() - started
    peak_raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    peak_mb = peak_raw / (1024 * 1024) if sys.platform == "darwin" else peak_raw / 1024
    return {
        "schema": "p040.structure-analysis.v1",
        "modelName": MODEL_NAME,
        "modelVersion": MODEL_VERSION,
        "librosaVersion": librosa.__version__,
        "audioSha256": audio_sha,
        "durationMs": int(round(duration * 1000)),
        "decoder": decoder,
        "tempoBpm": round(float(np.atleast_1d(tempo)[0]), 2) if np.size(tempo) else None,
        "segments": segments,
        "relations": relations,
        "mergeCandidates": merge_candidates,
        "separation": {"used": False, "modulesSeen": separation_modules},
        "timing": {
            "seconds": round(elapsed, 3),
            "peakMemoryMb": round(peak_mb, 1),
            "sampleRate": sr,
            "hopLength": HOP_LENGTH,
        },
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="P040 原唱混音结构分析（不分离音轨）")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--min-segment", type=float, default=MIN_SEGMENT_SECONDS)
    args = parser.parse_args(argv)

    if not os.path.isfile(args.audio):
        print(f"audio not found: {args.audio}", file=sys.stderr)
        return 2
    result = analyze(args.audio, min_segment=args.min_segment)
    if result["separation"]["modulesSeen"]:
        print("separation modules detected: " + ",".join(result["separation"]["modulesSeen"]), file=sys.stderr)
        return 3
    if not result["segments"]:
        print("no segments produced", file=sys.stderr)
        return 4
    directory = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(directory, exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(tmp, args.out)
    print(json.dumps({
        "segments": len(result["segments"]),
        "relations": len(result["relations"]),
        "seconds": result["timing"]["seconds"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
