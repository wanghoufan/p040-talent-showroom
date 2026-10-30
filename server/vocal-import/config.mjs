import { resolve } from 'node:path';

/**
 * V3.1 本地导入的**运行配置**。
 * 白名单根目录只能来自服务端环境变量，任何 HTTP 请求都不能提供本机路径。
 *
 * 支持的写法：
 * - `VOCAL_IMPORT_ROOTS`：JSON 数组，`[{ "id": "music", "label": "本机音乐", "path": "/已授权目录" }]`
 * - `VOCAL_IMPORT_ROOT_PATH`：单根快捷写法，可配合 `VOCAL_IMPORT_ROOT_ID` / `VOCAL_IMPORT_ROOT_LABEL`
 * - `VOCAL_IMPORT_WORKER=1`：在 API 进程内启动单并发后台循环（默认关闭）
 * - `VOCAL_IMPORT_SEPARATOR_CMD` / `VOCAL_IMPORT_MODEL` / `VOCAL_IMPORT_OUTPUT_FORMAT`
 * - `VOCAL_IMPORT_TIMEOUT_MS` / `VOCAL_IMPORT_EXTRA_ARGS`（JSON 字符串数组）
 */
const ROOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

function normalizeRoots(input) {
  if (!Array.isArray(input)) throw new TypeError('VOCAL_IMPORT_ROOTS 必须是数组');
  return input.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('VOCAL_IMPORT_ROOTS 每一项必须是对象');
    }
    const id = String(entry.id ?? '');
    const path = String(entry.path ?? '');
    if (!ROOT_ID_PATTERN.test(id)) throw new TypeError(`INVALID_ROOT_ID:${id}`);
    if (!path.trim()) throw new TypeError(`INVALID_ROOT_PATH:${id}`);
    return {
      id,
      label: entry.label ? String(entry.label) : id,
      path: resolve(path),
    };
  });
}

function parseRoots(env) {
  const raw = env.VOCAL_IMPORT_ROOTS;
  if (typeof raw === 'string' && raw.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new TypeError('VOCAL_IMPORT_ROOTS 不是合法 JSON');
    }
    return normalizeRoots(parsed);
  }
  if (typeof env.VOCAL_IMPORT_ROOT_PATH === 'string' && env.VOCAL_IMPORT_ROOT_PATH.trim()) {
    return normalizeRoots([
      {
        id: env.VOCAL_IMPORT_ROOT_ID || 'music',
        label: env.VOCAL_IMPORT_ROOT_LABEL || '本机音乐',
        path: env.VOCAL_IMPORT_ROOT_PATH,
      },
    ]);
  }
  return [];
}

function parseExtraArgs(env) {
  const raw = env.VOCAL_IMPORT_EXTRA_ARGS;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError('VOCAL_IMPORT_EXTRA_ARGS 不是合法 JSON');
  }
  if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) {
    throw new TypeError('VOCAL_IMPORT_EXTRA_ARGS 必须是字符串数组');
  }
  return parsed;
}

export function readVocalImportConfig(env = process.env) {
  const timeout = Number(env.VOCAL_IMPORT_TIMEOUT_MS || 30 * 60 * 1000);
  return {
    roots: parseRoots(env),
    worker: env.VOCAL_IMPORT_WORKER === '1',
    separator: {
      command: env.VOCAL_IMPORT_SEPARATOR_CMD || 'audio-separator',
      model: env.VOCAL_IMPORT_MODEL || null,
      outputFormat: env.VOCAL_IMPORT_OUTPUT_FORMAT || 'flac',
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30 * 60 * 1000,
      ffprobeBin: env.FFPROBE_BIN || 'ffprobe',
      extraArgs: parseExtraArgs(env),
    },
  };
}
