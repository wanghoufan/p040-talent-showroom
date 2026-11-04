import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearWaveformCache, peaksFromPcm, readWaveform, waveformBuckets } from '../server/vocal-structure/waveform.mjs';

/**
 * 波形定向测试（P040 V1.2）。
 *
 * 用**真正可解码的音频文件**跑一遍本机 ffmpeg 解码链路，确认界面拿到的峰值来自音频本身：
 * 1 秒静音 → 1 秒满幅 → 1 秒半幅；峰谷必须按这个包络出现，且时长与采样数一致。
 * 不读用户曲库、不改任何 MP3/LRC、不跑结构分析。
 */

const RATE = 8000;

/** 16-bit PCM 单声道 WAV；sampleAt 决定每个采样点的振幅（0..1）。 */
function writeWav(path, seconds, sampleAt) {
  const frames = seconds * RATE;
  const data = Buffer.alloc(frames * 2);
  for (let index = 0; index < frames; index += 1) {
    const amplitude = sampleAt(index / RATE);
    const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / RATE) * amplitude * 32767);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, value)), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
  return { frames, header, data };
}

async function withTemp(run) {
  const root = mkdtempSync(join(tmpdir(), 'p040-waveform-'));
  try {
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('真实音频：静音/满幅/半幅三段包络按顺序出现，时长由解码结果得出', async () => withTemp(async (root) => {
  clearWaveformCache();
  const audio = join(root, 'envelope.wav');
  writeWav(audio, 3, (seconds) => (seconds < 1 ? 0 : seconds < 2 ? 1 : 0.5));

  const result = await readWaveform({ audioPath: audio, buckets: 60 });
  assert.equal(result.buckets, 60);
  assert.equal(result.peaks.length, 60);
  assert.equal(result.source, 'original-mix-peaks');
  assert.equal(result.separation.used, false);
  assert.equal(result.sampleRate, RATE);
  // 3 秒整，按 8 kHz 采样换算；允许 1 个桶的量化误差。
  assert.ok(Math.abs(result.durationMs - 3000) <= 100, `durationMs=${result.durationMs}`);

  const silent = result.peaks.slice(0, 20);
  const loud = result.peaks.slice(20, 40);
  const half = result.peaks.slice(40, 60);
  assert.ok(silent.every((peak) => peak === 0), `静音段应全 0：${silent.join(',')}`);
  assert.ok(loud.every((peak) => peak > 0.95), `满幅段应接近 1：${loud.join(',')}`);
  assert.ok(half.every((peak) => peak > 0.45 && peak < 0.55), `半幅段应约 0.5：${half.join(',')}`);
  // 峰值不是随机/伪造：三段之间有明确落差。
  assert.ok(Math.min(...loud) > Math.max(...half) * 1.8);
}));

test('峰值只来自传入的 PCM：空缓冲不造波形，桶数有上下限', () => {
  assert.deepEqual(peaksFromPcm(Buffer.alloc(0), 10), []);
  assert.equal(waveformBuckets('999999'), 2000);
  assert.equal(waveformBuckets('1'), 60);
  assert.equal(waveformBuckets('abc', 600), 600);
});

test('文件不存在或解码器不可用时明确报错，不返回假波形', async () => withTemp(async (root) => {
  clearWaveformCache();
  await assert.rejects(
    () => readWaveform({ audioPath: join(root, 'missing.mp3'), buckets: 60 }),
    (error) => error.code === 'AUDIO_NOT_FOUND',
  );
  const audio = join(root, 'ok.wav');
  writeWav(audio, 1, () => 1);
  await assert.rejects(
    () => readWaveform({ audioPath: audio, buckets: 60, ffmpeg: 'definitely-not-ffmpeg' }),
    (error) => error.code === 'FFMPEG_UNAVAILABLE',
  );
}));

test('同一份音频同一桶数走进程内缓存，重复请求不重复解码', async () => withTemp(async (root) => {
  clearWaveformCache();
  const audio = join(root, 'cache.wav');
  writeWav(audio, 1, () => 0.8);
  const first = await readWaveform({ audioPath: audio, sha256: 'f'.repeat(64), buckets: 60 });
  assert.equal(first.cached, false);
  const second = await readWaveform({ audioPath: audio, sha256: 'f'.repeat(64), buckets: 60 });
  assert.equal(second.cached, true);
  assert.deepEqual(second.peaks, first.peaks);
}));
