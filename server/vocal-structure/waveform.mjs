import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * 波形包络（只用于界面拖动校正，不是分析证据）。
 *
 * - 只读原曲混音，用 ffmpeg 解码成单声道 8 kHz PCM 后按桶取峰值；
 * - 不做人声/伴奏分离，不写源文件，不联网；
 * - 这里的结果**不参与**主歌/副歌判断，也不写进任何结构字段。
 *
 * 为什么不在前端解码：手机 WebView 全曲 decodeAudioData 内存与耗时不稳，
 * 而 ffmpeg 在本机已有（分析链路同款解码器），一次算完可缓存复用。
 */

const DEFAULT_BUCKETS = 600;
const MIN_BUCKETS = 60;
const MAX_BUCKETS = 2000;
const SAMPLE_RATE = 8000;
const CACHE_LIMIT = 8;

/** 进程内缓存：同一份原曲 + 同一桶数只解码一次；不落盘，不跨进程。 */
const cache = new Map();

export function waveformBuckets(value, fallback = DEFAULT_BUCKETS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_BUCKETS, Math.max(MIN_BUCKETS, Math.round(parsed)));
}

function runFfmpeg(ffmpeg, audioPath) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpeg,
      ['-v', 'error', '-i', audioPath, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'],
      { timeout: 120_000, maxBuffer: 160 * 1024 * 1024, encoding: 'buffer', windowsHide: true },
      (error, stdout) => {
        if (error) {
          const code = error.code === 'ENOENT' ? 'FFMPEG_UNAVAILABLE' : 'WAVEFORM_FAILED';
          reject(Object.assign(new Error(code), { code, detail: String(error.message || '').slice(0, 200) }));
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''));
      },
    );
  });
}

/** s16le 缓冲 → 每桶峰值（0..1，已按全曲最大值归一）。 */
export function peaksFromPcm(buffer, buckets) {
  const samples = Math.floor(buffer.length / 2);
  if (!samples || !Number.isInteger(buckets) || buckets <= 0) return [];
  const size = Math.ceil(samples / buckets);
  const peaks = new Array(buckets).fill(0);
  let max = 0;
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = bucket * size;
    const end = Math.min(samples, start + size);
    let peak = 0;
    for (let at = start; at < end; at += 1) {
      const value = Math.abs(buffer.readInt16LE(at * 2));
      if (value > peak) peak = value;
    }
    peaks[bucket] = peak;
    if (peak > max) max = peak;
  }
  if (!max) return peaks;
  return peaks.map((peak) => Number((peak / max).toFixed(3)));
}

/**
 * @param {object} input
 * @param {string} input.audioPath 原曲绝对路径（只读）
 * @param {string} [input.sha256] 原曲摘要，用作缓存键
 * @param {number} [input.buckets]
 * @param {string} [input.ffmpeg]
 * @param {number} [input.durationMs] 已知总时长；缺失时按 8 kHz 采样数换算
 */
export async function readWaveform({ audioPath, sha256 = '', buckets = DEFAULT_BUCKETS, ffmpeg = 'ffmpeg', durationMs = 0 } = {}) {
  if (!audioPath || !existsSync(audioPath)) {
    throw Object.assign(new Error('AUDIO_NOT_FOUND'), { code: 'AUDIO_NOT_FOUND' });
  }
  const size = waveformBuckets(buckets);
  const key = `${sha256 || audioPath}:${size}`;
  const cached = cache.get(key);
  if (cached) return { ...cached, cached: true };

  const pcm = await runFfmpeg(ffmpeg, audioPath);
  const peaks = peaksFromPcm(pcm, size);
  if (!peaks.length) throw Object.assign(new Error('WAVEFORM_EMPTY'), { code: 'WAVEFORM_EMPTY' });
  const samples = Math.floor(pcm.length / 2);
  const result = {
    buckets: size,
    peaks,
    durationMs: Number.isInteger(durationMs) && durationMs > 0 ? durationMs : Math.round((samples / SAMPLE_RATE) * 1000),
    sampleRate: SAMPLE_RATE,
    source: 'original-mix-peaks',
    separation: { used: false },
  };
  cache.set(key, result);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return { ...result, cached: false };
}

/** 测试用：清空进程内缓存。 */
export function clearWaveformCache() {
  cache.clear();
}
