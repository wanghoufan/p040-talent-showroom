import { createAccompanimentVerifier } from '../../server/vocal-import/accompaniment-verify.mjs';

/**
 * 测试专用：只替换“探测实现”，规则仍使用生产同一份 accompaniment-verify。
 * 因此扩展名、SHA 一致、与原唱相同、时长容差这些判定不会被测试放宽。
 */
export function makeProbe({ durationMs = 120000, probeState = 'ok' } = {}) {
  return async () => {
    if (probeState !== 'ok') {
      return {
        durationMs: null,
        tags: {},
        probeState,
        fingerprint: null,
        fingerprintMs: null,
        decode: {
          state: probeState === 'not-installed' ? 'not-installed' : 'failed',
          timedOut: false,
          errorCount: 1,
          errors: ['scripted failure'],
          decodedMs: 0,
          coverageRatio: 0,
          fullyDecoded: false,
        },
      };
    }
    return {
      durationMs,
      tags: {},
      probeState: 'ok',
      fingerprint: null,
      fingerprintMs: null,
      decode: {
        state: 'ok',
        timedOut: false,
        errorCount: 0,
        errors: [],
        decodedMs: durationMs,
        coverageRatio: 1,
        fullyDecoded: true,
      },
    };
  };
}

export function createTestAccompanimentVerifier(options = {}) {
  return createAccompanimentVerifier({ probe: makeProbe(options) });
}
