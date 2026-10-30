import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * 只读媒体探测（ffprobe / ffmpeg）。三个层次，全部可选、全部只读：
 * 1. probe：时长 + ID3 的 artist/title，用于文件名与标签交叉核验；
 * 2. fingerprint：解码前 20 秒 PCM 后取 SHA-256，用于「同一音频不同封装/仅封面不同」的重复辅助；
 * 3. deep：整轨解码一遍，按实际解码样本覆盖率区分「尾部损坏」与「整段损坏」。
 *
 * 真实审计 `var/vocal-v31-work/real-music-deep-audit.json` 的事实依据：
 * - T02 `Star Unkind` 覆盖 98.99%、T03 `미쳐` 覆盖 98.77%，都只有末尾报错 → 尾部损坏；
 * - T05 / T08 两组同曲文件时长完全相同、SHA 不同 → 优先怀疑仅内嵌封面不同，用 PCM 指纹复核。
 *
 * 任何一步失败都只降级为「未知」，绝不猜测，也不阻塞整批。
 */
const FINGERPRINT_SECONDS = 20;
const FINGERPRINT_SAMPLE_RATE = 8000;
const DECODE_SAMPLE_RATE = 8000;
/** 覆盖率低于此值视为整段损坏，而不是尾部少量损坏。 */
export const TAIL_DAMAGE_MIN_COVERAGE = 0.95;
export const FULL_DECODE_MIN_COVERAGE = 0.999;

function runFile(bin, args, { timeout, maxBuffer = 1024 * 1024 } = {}) {
  return new Promise(resolve => {
    execFile(bin, args, { timeout, maxBuffer, encoding: 'buffer' }, (error, stdout, stderr) => {
      // 返回结构必须完整：缺工具时也要有空的 stdout/stderr，
      // 否则后续 `.split()` 会抛异常，把「配置缺失」误当成单文件损坏。
      if (error && error.code === 'ENOENT') {
        return resolve({
          state: 'not-installed',
          killed: false,
          stdout: Buffer.alloc(0),
          stderr: '',
          message: '',
        });
      }
      resolve({
        state: error ? 'error' : 'ok',
        killed: Boolean(error?.killed),
        stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''),
        stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? ''),
        message: error?.message ?? '',
      });
    });
  });
}

export async function probeAudio(path, options = {}) {
  const {
    ffprobeBin = 'ffprobe',
    ffmpegBin = 'ffmpeg',
    timeoutMs = 18000,
    deep = false,
    fingerprint = true,
  } = options;

  const result = {
    durationMs: null,
    tags: {},
    probeState: 'unknown',
    fingerprint: null,
    fingerprintMs: null,
    decode: null,
  };

  const probed = await runFile(
    ffprobeBin,
    ['-v', 'error', '-show_entries', 'format=duration:format_tags=artist,title', '-of', 'json', path],
    { timeout: timeoutMs },
  );
  if (probed.state === 'not-installed') {
    result.probeState = 'not-installed';
  } else if (probed.state !== 'ok') {
    result.probeState = 'invalid';
  } else {
    try {
      const format = JSON.parse(probed.stdout.toString('utf8') || '{}').format ?? {};
      const duration = Number(format.duration);
      result.durationMs = Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : null;
      const tags = format.tags ?? {};
      for (const [key, value] of Object.entries(tags)) result.tags[String(key).toLowerCase()] = String(value);
      result.probeState = result.durationMs ? 'ok' : 'invalid';
    } catch {
      result.probeState = 'invalid';
    }
  }

  if (result.probeState === 'not-installed') return result;

  if (fingerprint) {
    // 只取开头 20 秒单声道 8kHz PCM：足够区分重复音频，代价与整轨长度无关。
    const decoded = await runFile(
      ffmpegBin,
      ['-v', 'error', '-nostdin', '-i', path, '-t', String(FINGERPRINT_SECONDS),
        '-map', '0:a:0', '-ac', '1', '-ar', String(FINGERPRINT_SAMPLE_RATE), '-f', 's16le', '-'],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
    );
    if (decoded.state === 'ok' && decoded.stdout.length >= FINGERPRINT_SAMPLE_RATE) {
      result.fingerprint = createHash('sha256').update(decoded.stdout).digest('hex');
      result.fingerprintMs = Math.round((decoded.stdout.length / 2 / FINGERPRINT_SAMPLE_RATE) * 1000);
    }
  }

  if (deep) {
    // 解码成 8kHz 单声道 PCM 只是为统计“实际解出多少毫秒”，不落盘、不改变源文件。
    const decoded = await runFile(
      ffmpegBin,
      ['-v', 'error', '-nostdin', '-i', path, '-map', '0:a:0',
        '-ac', '1', '-ar', String(DECODE_SAMPLE_RATE), '-f', 's16le', '-'],
      { timeout: Math.max(timeoutMs, 180000), maxBuffer: 64 * 1024 * 1024 },
    );
    const errors = decoded.stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const decodedMs = decoded.stdout.length >= 2
      ? Math.floor((decoded.stdout.length / 2 / DECODE_SAMPLE_RATE) * 1000)
      : 0;
    const coverageRatio = result.durationMs
      ? Math.min(1, Math.round((decodedMs / result.durationMs) * 10000) / 10000)
      : null;
    let state;
    if (decoded.state === 'not-installed') state = 'not-installed';
    // 超时是工具/配置问题，不能把只解码了一部分的文件误判成“音频损坏”。
    else if (decoded.killed) state = 'timeout';
    // 一个样本都没解出来绝不能算 ok：进程 0 退出但无可解码音频同样要报异常。
    else if (!decodedMs) state = 'failed';
    else if (errors.length === 0 && (coverageRatio === null || coverageRatio >= FULL_DECODE_MIN_COVERAGE)) state = 'ok';
    else if (coverageRatio !== null && coverageRatio >= TAIL_DAMAGE_MIN_COVERAGE) state = 'tail-truncated';
    else state = 'damaged';
    result.decode = {
      state,
      timedOut: Boolean(decoded.killed),
      errorCount: errors.length,
      errors: errors.slice(0, 3),
      decodedMs,
      coverageRatio,
      // 只有“无错误且覆盖完整”才算完整解码；尾部损坏不会被当成正常。
      fullyDecoded: state === 'ok',
    };
  }

  return result;
}

/** 不做任何子进程的占位结果，供测试与“关闭探测”场景使用。 */
export function skippedProbe() {
  return {
    durationMs: null,
    tags: {},
    probeState: 'skipped',
    fingerprint: null,
    fingerprintMs: null,
    decode: null,
  };
}
