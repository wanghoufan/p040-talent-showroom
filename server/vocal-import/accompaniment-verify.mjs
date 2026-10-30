import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { extname } from 'node:path';
import { fail } from './errors.mjs';
import { probeAudio } from './probe.mjs';

/**
 * 伴奏工件入库前的统一安全校验。
 *
 * 用户自带伴奏和分离器产物都必须通过同一套规则，缺一不可：
 * 1. 扩展名必须是音频（LRC/TXT 等非音频一律拒绝，不能靠“能打开”放行）；
 * 2. 实际文件 SHA-256 与记录一致，且**不能与原唱完全相同**（至少 SHA 层拦截）；
 * 3. 必须实际完整解码（ffprobe + 整轨 ffmpeg 解码），不能只看文件非空；
 * 4. 解码得到的时长必须与原唱时长在容差内（默认取 2 秒与 2% 的较大值）。
 *
 * 生产默认使用真实 ffprobe/ffmpeg；测试通过 `probe` 注入隔离的假探测，
 * 规则本身（扩展名、SHA、重复、时长容差）仍走同一份实现，不做“测试放宽”。
 */
export const ACCOMPANIMENT_AUDIO_EXTENSIONS = Object.freeze([
  '.mp3',
  '.m4a',
  '.aac',
  '.wav',
  '.flac',
  '.ogg',
  '.opus',
]);
const AUDIO_EXTENSIONS = new Set(ACCOMPANIMENT_AUDIO_EXTENSIONS);
export const DURATION_TOLERANCE_RATIO = 0.02;
export const DURATION_TOLERANCE_MIN_MS = 2000;
const CACHE_LIMIT = 128;
/** 与分离器共用同一组二进制配置，避免 FFPROBE_BIN 不在 PATH 时入库校验误报“工具缺失”。 */
const DEFAULT_PROBE_OPTIONS = Object.freeze({
  ffprobeBin: process.env.FFPROBE_BIN || 'ffprobe',
  ffmpegBin: process.env.FFMPEG_BIN || 'ffmpeg',
});

export function isAccompanimentAudioPath(path) {
  return AUDIO_EXTENSIONS.has(extname(String(path ?? '')).toLowerCase());
}

export function accompanimentDurationToleranceMs(sourceDurationMs) {
  const value = Number(sourceDurationMs);
  if (!Number.isFinite(value) || value <= 0) return DURATION_TOLERANCE_MIN_MS;
  return Math.max(DURATION_TOLERANCE_MIN_MS, Math.round(value * DURATION_TOLERANCE_RATIO));
}

function hashFile(filePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const digest = createHash('sha256');
    createReadStream(filePath)
      .on('error', rejectPromise)
      .on('data', chunk => digest.update(chunk))
      .on('end', () => resolvePromise(digest.digest('hex')));
  });
}

function isFullyDecoded(probe) {
  return Boolean(probe?.decode && probe.decode.state === 'ok' && probe.decode.fullyDecoded === true);
}

function seconds(ms) {
  return Math.round(Number(ms) / 1000);
}

export function createAccompanimentVerifier({ probe = probeAudio, probeOptions = {} } = {}) {
  const cache = new Map();
  const probeConfig = { ...DEFAULT_PROBE_OPTIONS, ...probeOptions };

  return async function verifyAccompanimentArtifact({
    filePath,
    relPath = filePath,
    originalFilePath = null,
    originalSha256 = null,
    sourceDurationMs = null,
    expectedSha256 = null,
  } = {}) {
    if (typeof filePath !== 'string' || !filePath) fail('BAD_REQUEST', '缺少待校验的伴奏文件');
    // 扩展名先拦截：.lrc/.txt 即使内容能被 ffprobe 误读，也不能当作伴奏登记。
    if (!isAccompanimentAudioPath(relPath) || !isAccompanimentAudioPath(filePath)) {
      fail('ACCOMPANIMENT_NOT_AUDIO', '伴奏必须是音频文件（.mp3/.m4a/.wav/.flac 等），LRC 等非音频不能入库', {
        status: 422,
      });
    }

    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      fail('ACCOMPANIMENT_NOT_FOUND', '伴奏文件不存在，无法入库', { status: 422 });
    }
    if (!stat.isFile() || stat.size <= 0) fail('ACCOMPANIMENT_EMPTY', '伴奏文件为空或不是普通文件', { status: 422 });

    const cacheKey = [
      filePath,
      stat.size,
      stat.mtimeMs,
      originalFilePath ?? '',
      originalSha256 ?? '',
      sourceDurationMs ?? '',
      expectedSha256 ?? '',
    ].join('|');
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const sha256 = await hashFile(filePath);
    if (expectedSha256 && expectedSha256 !== sha256) {
      fail('CONFLICT', '伴奏文件 SHA-256 与记录不一致', { status: 409 });
    }
    if (originalSha256 && sha256 === originalSha256) {
      fail('ACCOMPANIMENT_DUPLICATES_ORIGINAL', '伴奏与原唱内容完全相同，不能登记为伴奏', { status: 422 });
    }

    let effectiveSourceDurationMs = Number(sourceDurationMs) > 0 ? Math.round(Number(sourceDurationMs)) : null;
    if (!effectiveSourceDurationMs && originalFilePath) {
      const originalProbe = await probe(originalFilePath, { ...probeConfig, fingerprint: false, deep: false });
      if (originalProbe?.probeState === 'ok' && Number(originalProbe.durationMs) > 0) {
        effectiveSourceDurationMs = Math.round(Number(originalProbe.durationMs));
      }
    }

    const probed = await probe(filePath, { ...probeConfig, fingerprint: false, deep: true });
    if (probed?.probeState === 'not-installed' || probed?.decode?.state === 'not-installed') {
      fail(
        'ACCOMPANIMENT_VERIFIER_UNAVAILABLE',
        '本机缺少 ffprobe/ffmpeg，无法完成伴奏真实解码校验；生产环境不允许跳过校验',
        { status: 503 },
      );
    }
    if (probed?.probeState !== 'ok' || !(Number(probed?.durationMs) > 0)) {
      fail('ACCOMPANIMENT_NOT_DECODABLE', '伴奏不是可识别的音频，或无法读取时长', { status: 422 });
    }
    if (!isFullyDecoded(probed)) {
      fail('ACCOMPANIMENT_NOT_DECODABLE', '伴奏未能完整解码（可能损坏、被截断或不是音频）', { status: 422 });
    }
    if (!effectiveSourceDurationMs) {
      fail('ACCOMPANIMENT_DURATION_UNKNOWN', '缺少可核验的原唱时长，无法对伴奏做容差校验', { status: 422 });
    }

    const durationMs = Math.round(Number(probed.durationMs));
    const toleranceMs = accompanimentDurationToleranceMs(effectiveSourceDurationMs);
    const deltaMs = Math.abs(durationMs - effectiveSourceDurationMs);
    if (deltaMs > toleranceMs) {
      fail(
        'ACCOMPANIMENT_DURATION_MISMATCH',
        `伴奏时长与原曲相差 ${seconds(deltaMs)} 秒，超过容差 ${seconds(toleranceMs)} 秒`,
        { status: 422, detail: { durationMs, sourceDurationMs: effectiveSourceDurationMs, toleranceMs, deltaMs } },
      );
    }

    const verified = { sha256, sizeBytes: stat.size, durationMs, sourceDurationMs: effectiveSourceDurationMs, toleranceMs };
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(cacheKey, verified);
    return verified;
  };
}
