import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * 原唱结构分析执行器（V3.2 T2）。
 *
 * 只做三件事：启动隔离的 Python 分析脚本、校验它只读原曲且没有分离链路、核对输出与原曲 SHA。
 * 分析脚本必须运行在**单独的 venv** 里（不含 demucs / audio_separator），
 * 这样即使脚本被改坏也不可能无意拉起分离模型。
 *
 * 配置（环境变量）：
 * - `P040_STRUCTURE_PYTHON`：分析用 Python 绝对路径（必填，未配置时明确失败，不静默降级）
 * - `P040_STRUCTURE_SCRIPT`：analyze.py 路径（默认仓库内 server/vocal-structure/analyze.py）
 * - `P040_STRUCTURE_TIMEOUT_MS`：单曲超时（默认 180000）
 */
export const DEFAULT_TIMEOUT_MS = 180_000;
export const MIN_TIMEOUT_MS = 10_000;
/** 必须与 server/vocal-structure/analyze.py 的 MODEL_NAME / MODEL_VERSION 一致；不一致直接拒绝结果。 */
export const MODEL_NAME = 'p040-mix-structure';
export const MODEL_VERSION = '1.1.0';

export function structureAnalyzerConfig(env = process.env) {
  // 未显式配置时，用项目内已建好的隔离 venv（不含分离模型）；仍不存在就明确不可用，不静默降级。
  const bundledPython = resolve('var/vocal-v31-work/structure-venv/bin/python');
  return {
    python: env.P040_STRUCTURE_PYTHON || (existsSync(bundledPython) ? bundledPython : ''),
    script: env.P040_STRUCTURE_SCRIPT || resolve('server/vocal-structure/analyze.py'),
    timeoutMs: Number(env.P040_STRUCTURE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    workDir: env.P040_STRUCTURE_WORKDIR || resolve('var/vocal-v31-work/structure'),
  };
}

export function sha256File(path) {
  const digest = createHash('sha256');
  digest.update(readFileSync(path));
  return digest.digest('hex');
}

function fail(code, message, extra = {}) {
  return Object.assign(new Error(message ? `${code}: ${message}` : code), { code, ...extra });
}

/** 未配置或不存在的 Python 一律显式失败：宁可显示「待分析」，也不假装分析过。 */
export function createStructureAnalyzer(config = {}) {
  const python = config.python || '';
  const script = config.script || resolve('server/vocal-structure/analyze.py');
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS);

  function assertReady() {
    if (!python) throw fail('ANALYZER_NOT_CONFIGURED', '未配置 P040_STRUCTURE_PYTHON');
    if (!existsSync(python)) throw fail('ANALYZER_NOT_CONFIGURED', `Python 不存在：${python}`);
    if (!existsSync(script)) throw fail('ANALYZER_NOT_CONFIGURED', `分析脚本不存在：${script}`);
  }

  return {
    ready: Boolean(python) && existsSync(python) && existsSync(script),
    modelName: MODEL_NAME,
    modelVersion: MODEL_VERSION,
    config: { python, script, timeoutMs },
    /**
     * @param {object} input
     * @param {string} input.audioPath 原曲（只读）
     * @param {string} input.outPath 分析结果写入位置（隔离目录）
     * @param {string} [input.expectedSha256] 期望的原曲 SHA，防止中途被替换
     */
    async analyze({ audioPath, outPath, expectedSha256 } = {}) {
      assertReady();
      if (!audioPath || !outPath) throw fail('BAD_REQUEST', '缺少 audioPath 或 outPath');
      if (!existsSync(audioPath)) throw fail('AUDIO_NOT_FOUND', audioPath);
      const before = statSync(audioPath);
      const shaBefore = sha256File(audioPath);
      if (expectedSha256 && shaBefore !== expectedSha256) throw fail('SOURCE_CHANGED', '原曲与分析记录不一致');

      let stdout = '';
      try {
        const result = await run(python, [script, '--audio', audioPath, '--out', outPath], {
          timeout: timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
        });
        stdout = result.stdout ?? '';
      } catch (error) {
        const code = error?.killed || error?.signal ? 'ANALYSIS_TIMEOUT' : 'ANALYSIS_FAILED';
        const detail = String(error?.stderr || error?.message || '').slice(0, 400);
        throw fail(code, detail, { stdout: String(error?.stdout || '').slice(0, 400) });
      }

      const after = statSync(audioPath);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || sha256File(audioPath) !== shaBefore) {
        throw fail('SOURCE_CHANGED', '分析期间原曲被改动');
      }
      if (!existsSync(outPath)) throw fail('ANALYSIS_EMPTY', '分析没有产出文件');

      let analysis;
      try {
        analysis = JSON.parse(readFileSync(outPath, 'utf8'));
      } catch (error) {
        throw fail('ANALYSIS_INVALID', `结果不是合法 JSON：${error.message}`);
      }
      if (analysis?.schema !== 'p040.structure-analysis.v1') throw fail('ANALYSIS_INVALID', 'schema 不匹配');
      // 脚本版本与这里的常量必须同步，否则会出现「草稿声称的模型版本」和实际算法不一致。
      if (analysis.modelName !== MODEL_NAME || analysis.modelVersion !== MODEL_VERSION) {
        throw fail('ANALYSIS_VERSION_MISMATCH', `脚本版本 ${analysis.modelName}/${analysis.modelVersion} 与执行器 ${MODEL_NAME}/${MODEL_VERSION} 不一致`);
      }
      if (!Number.isInteger(analysis.durationMs) || analysis.durationMs <= 0) throw fail('ANALYSIS_INVALID', '时长不可用');
      if (!Array.isArray(analysis.segments)) throw fail('ANALYSIS_INVALID', '缺少 segments');
      if (analysis.audioSha256 !== shaBefore) throw fail('ANALYSIS_INVALID', '分析结果对应的不是这份原曲');
      if (analysis.separation?.used !== false || (analysis.separation?.modulesSeen ?? []).length) {
        throw fail('SEPARATION_DETECTED', '分析进程里出现了分离模块，已拒绝该结果');
      }
      return { ...analysis, stdout: String(stdout).slice(0, 400) };
    },
  };
}
