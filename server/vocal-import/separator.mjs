import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { fail } from './errors.mjs';
import { probeAudio } from './probe.mjs';

/**
 * 本机人声分离适配器（audio-separator / 兼容 CLI）。
 *
 * 硬约束：
 * - 只读源文件：不写、不改名、不覆盖；提取前后核对大小与 mtime，变化即作废；
 * - 独立输出：只写 `mediaRoot/vocal-import/<songId>/`，输出 relPath 由本模块计算；
 * - 并发为一：同一适配器实例内所有进程串行（队列本身也是单任务）；
 * - 失败可恢复：命令不存在/模型缺失属于配置问题，交回队列 release()，不消耗重试次数；
 *   进程崩溃、超时、无产物属于可重试失败。
 */
const AUDIO_OUTPUT_EXTENSIONS = new Set(['.flac', '.wav', '.mp3', '.m4a']);
const MAX_CAPTURE = 8 * 1024 * 1024;

function hashFile(filePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const digest = createHash('sha256');
    createReadStream(filePath)
      .on('error', rejectPromise)
      .on('data', chunk => digest.update(chunk))
      .on('end', () => resolvePromise(digest.digest('hex')));
  });
}

function listAudioFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && AUDIO_OUTPUT_EXTENSIONS.has(extname(entry.name).toLowerCase()))
      .map(entry => join(dir, entry.name));
  } catch {
    return [];
  }
}

function runCommand(command, args, { timeoutMs, env, signal }) {
  return new Promise(resolvePromise => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_CAPTURE, encoding: 'utf8', env, signal },
      (error, stdout, stderr) => {
        resolvePromise({
          error,
          notInstalled: Boolean(error && (error.code === 'ENOENT' || error.errno === -2)),
          timedOut: Boolean(error?.killed),
          exitCode: error?.code ?? 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
  });
}

function assertInside(root, target, message) {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  if (absoluteTarget !== absoluteRoot && !absoluteTarget.startsWith(absoluteRoot + sep)) {
    fail('PATH_NOT_ALLOWED', message);
  }
}

/**
 * 分离器可能产出多个 stem。文件名带 Vocals/人声/主唱 的一律不是伴奏，
 * 绝不能因为「目录里只有一个新文件」就把它当伴奏入库。
 */
function classifyStem(filePath) {
  const name = basename(filePath);
  if (/instrumental|accompaniment|off[-\s_]?vocal|伴奏/i.test(name)) return 'instrumental';
  if (/vocal|人声|主唱|acapella|a[-\s_]?cappella/i.test(name)) return 'vocals';
  return 'unknown';
}

function pickInstrumental(outputDir, before) {
  const after = listAudioFiles(outputDir)
    .map(filePath => {
      const stat = statSync(filePath);
      return { filePath, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
    })
    .filter(file => file.sizeBytes > 0);
  // 只接受本次尝试新产生或确实被重写的文件；绝不把失败残留当成新伴奏。
  const fresh = after.filter(file => {
    const previous = before.get(file.filePath);
    if (!previous) return true;
    return file.mtimeMs !== previous.mtimeMs || file.sizeBytes !== previous.sizeBytes;
  });
  if (!fresh.length) return null;
  const instrumental = fresh.filter(file => classifyStem(file.filePath) === 'instrumental');
  if (instrumental.length === 1) return instrumental[0].filePath;
  // 多个伴奏候选无法安全判断用哪个 → 交给失败重试，不任取其一。
  if (instrumental.length > 1) return null;
  // 兼容不按 stem 命名的实现：只有唯一新文件且名字没有明确标成 vocals 才接受。
  if (fresh.length === 1 && classifyStem(fresh[0].filePath) !== 'vocals') return fresh[0].filePath;
  return null;
}

function looksLikeModelPath(model) {
  // 只有带路径分隔符的才按本地文件校验；裸文件名可能是 audio-separator 的模型名，
  // 由它自己在模型目录里解析，不能用当前工作目录误判为“模型不存在”。
  return /[\\/]/.test(model);
}

export function createLocalSeparator({
  mediaRoot,
  command = 'audio-separator',
  model = null,
  outputFormat = 'flac',
  timeoutMs = 30 * 60 * 1000,
  ffprobeBin = 'ffprobe',
  extraArgs = [],
  env = process.env,
  logger = null,
} = {}) {
  if (!mediaRoot) throw new TypeError('createLocalSeparator 需要 mediaRoot');
  if (!command) throw new TypeError('createLocalSeparator 需要 command');
  // 超时配置非法时立即明确报错，避免把异常超时带进真正提取时才发现。
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('createLocalSeparator 需要正的 timeoutMs（毫秒）');
  }

  // 单实例串行锁：即使调用方不小心并发，也不会同时跑两个模型进程。
  let tail = Promise.resolve();
  const serial = task => {
    const next = tail.then(task, task);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return async function extract({ job, sourceFile, outputDir, signal } = {}) {
    return serial(async () => {
      if (!outputDir) fail('BAD_REQUEST', '缺少受控输出目录');
      assertInside(resolve(mediaRoot, 'vocal-import'), outputDir, '输出目录必须在受控媒体目录内');

      // 模型是本地文件路径却不存在：属于配置问题，明确报错并退回待提取，不消耗重试次数。
      if (model && looksLikeModelPath(model) && !existsSync(model)) {
        fail(
          'SEPARATOR_NOT_CONFIGURED',
          `伴奏模型文件不存在（${basename(model)}），请检查 VOCAL_IMPORT_MODEL 配置`,
          { status: 503 },
        );
      }

      let before;
      try {
        before = statSync(sourceFile);
      } catch {
        fail('PATH_NOT_ALLOWED', '源音频不存在或不可访问');
      }
      if (!before.isFile()) fail('PATH_NOT_ALLOWED', '源音频不是普通文件');

      mkdirSync(outputDir, { recursive: true });
      const beforeFiles = new Map(
        listAudioFiles(outputDir).map(filePath => {
          const stat = statSync(filePath);
          return [filePath, { mtimeMs: stat.mtimeMs, sizeBytes: stat.size }];
        }),
      );

      const args = [];
      if (model) args.push('--model_filename', model);
      if (outputFormat) args.push('--output_format', outputFormat);
      // 强制参数放在 extraArgs 之后：用户追加参数不能把 --single_stem 改成 Vocals，
      // 否则人声会被当成伴奏。输出目录同样由本模块最终决定。
      args.push(...extraArgs, '--single_stem', 'Instrumental', '--output_dir', outputDir, sourceFile);

      const result = await runCommand(command, args, { timeoutMs, env, signal });
      if (result.notInstalled) {
        fail(
          'SEPARATOR_NOT_CONFIGURED',
          `本机未安装伴奏提取器（${basename(command)}），请先安装 audio-separator 或配置 VOCAL_IMPORT_SEPARATOR_CMD`,
          { status: 503 },
        );
      }
      if (result.error) {
        logger?.error?.(`vocal-import separator exit=${result.exitCode} timedOut=${result.timedOut}: ${result.stderr.slice(-2000)}`);
        if (result.timedOut) {
          const minutes = Math.max(1, Math.round(timeoutMs / 60000));
          fail('SEPARATOR_TIMEOUT', `本机伴奏提取超时（超过 ${minutes} 分钟），可稍后重试`);
        }
        // 模型权重未下载/文件名写错时，audio-separator 通常以非零退出；
        // 这属于配置问题而不是音频失败，明确提示并退回待提取。
        if (/model.{0,40}(not found|not exist|unknown|unable to (load|find))|no such (model|file).{0,40}model|download.{0,20}(failed|error)/i.test(result.stderr)) {
          fail('SEPARATOR_NOT_CONFIGURED', '伴奏模型不可用（未下载或文件名不正确），请检查 VOCAL_IMPORT_MODEL 配置', { status: 503 });
        }
        fail('SEPARATOR_FAILED', `本机伴奏提取进程失败（退出码 ${result.exitCode}）`);
      }

      let after;
      try {
        after = statSync(sourceFile);
      } catch {
        fail('SOURCE_CHANGED', '源音频在提取期间消失，本次结果作废', { status: 409 });
      }
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        fail('SOURCE_CHANGED', '源音频在提取期间被改动，本次结果作废', { status: 409 });
      }

      const output = pickInstrumental(outputDir, beforeFiles);
      // 绝不把 Vocals/人声产物当伴奏：无法确认是伴奏时宁可失败，让用户重试或换模型。
      if (!output) fail('SEPARATOR_NO_OUTPUT', '分离器没有产生可识别的伴奏文件（人声轨不会被当作伴奏）');
      assertInside(outputDir, output, '分离器产物必须写在本次任务的输出目录内');

      const stat = statSync(output);
      if (!stat.isFile() || stat.size === 0) fail('SEPARATOR_NO_OUTPUT', '分离器产出的伴奏文件为空');

      const probe = await probeAudio(output, { ffprobeBin, fingerprint: false, deep: false });
      const durationMs = probe.durationMs ?? job?.original?.durationMs ?? null;
      if (probe.probeState === 'invalid') fail('SEPARATOR_NO_OUTPUT', '分离器产出的伴奏无法解码');

      return {
        relPath: relative(mediaRoot, output).split(sep).join('/'),
        sha256: await hashFile(output),
        sizeBytes: stat.size,
        durationMs: durationMs ?? null,
        codec: extname(output).slice(1).toLowerCase(),
        model: model || 'default',
        separator: basename(command),
        outputFormat,
        qualityState: 'unverified',
      };
    });
  };
}
