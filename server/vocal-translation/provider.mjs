import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 翻译通道：CodeBuddy CLI（`scripts/codebuddy-auto.sh`）→ CodeBuddy 云端模型。
 *
 * 这不是本地模型：运行时会把歌词原文发给 CodeBuddy 服务，需要如实告知用户。
 * 未配置/脚本不存在/调用失败一律显式失败（TRANSLATION_UNAVAILABLE / PROVIDER_FAILED），
 * 不返回假译文，也不回退到任何付费翻译 API。
 */
export const DEFAULT_MODEL = 'deepseek-v4.1-flash';
export const DEFAULT_EFFORT = 'high';
export const DEFAULT_TIMEOUT_MS = 180000;

const LANGUAGE_NAME = { ko: '韩语', en: '英语', ja: '日语', zh: '简体中文' };

export function translationProviderConfig(env = process.env) {
  const disabled = String(env.P040_TRANSLATE_DISABLED ?? '') === '1';
  const scriptPath = resolve(env.P040_TRANSLATE_SCRIPT || 'scripts/codebuddy-auto.sh');
  return {
    disabled,
    scriptPath,
    model: env.P040_TRANSLATE_MODEL || DEFAULT_MODEL,
    effort: env.P040_TRANSLATE_EFFORT || DEFAULT_EFFORT,
    timeoutMs: Number(env.P040_TRANSLATE_TIMEOUT_MS) > 0 ? Number(env.P040_TRANSLATE_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
    retries: Number.isInteger(Number(env.P040_TRANSLATE_RETRIES)) ? Math.max(0, Number(env.P040_TRANSLATE_RETRIES)) : 2,
  };
}

/**
 * 提示词按 2026-10-31 逐句审校的实测问题逐条收紧：
 * - 同源不一致（32 行）：同一句原文必须给出完全相同的译文，不许换说法；
 * - 语义错（H1–H4）：-도록 表程度不表目的，죽도록 是「拼命」不是「死一般」，不许硬改逻辑关系；
 * - 悬空与扩写（M9/M10/M15/M17）：句尾截断可停在承接词上，但不许补出「带我」「在那里」这类成分；
 * - 制作署名（H5/M1/M2）：署名与段落标记不是歌词，原样返回，不翻译。
 */
function promptFor(texts, sourceLanguage, targetLanguage) {
  const source = LANGUAGE_NAME[sourceLanguage] || sourceLanguage;
  const target = LANGUAGE_NAME[targetLanguage] || targetLanguage;
  return [
    `把下面 JSON 数组里的每一行${source}歌词翻译成${target}。这些行按时间顺序来自同一首歌，相邻行常常是同一句话被拆开。`,
    '严格要求：',
    '1. 只输出一个 JSON 数组，长度与输入完全一致，元素是字符串；不要解释、不要序号、不要 Markdown 代码块。',
    '2. 逐行一一对应，不合并、不拆分、不增删行；第 i 个输出就是第 i 个输入的译文。',
    '3. 同一句原文出现多次，必须给出完全相同的中文，不要换说法、不要换同义词。',
    '4. 某行若在句中被截断，译文可以停在「的」「地」「着」这类承接词上；但不得补出原文没有的主语、宾语或「带我」「在那里」这类成分，也不得意译扩写。',
    '5. 保留人名、歌名、英文 hook、拟声词与语气词；英文字母和数字照抄，不音译、不改写。',
    '6. 制作人员署名与段落标记不是歌词（如「Recording Engineer：…」「All Programming by：…」「Chorus：김보아」「[Verse 1]」），原样返回，不要翻译。',
    '7. 忠实保留原文的逻辑关系：表程度、因果、转折的连接词按原意译，不要把程度读成目的、不要把让步读成因果。',
    `输入：${JSON.stringify(texts)}`,
  ].join('\n');
}

/** 从可能夹着 CLI 提示/心跳的 stdout 里找出最后一个合法字符串数组。 */
export function extractTranslationArray(output) {
  const text = String(output ?? '').replace(/^\uFEFF/, '');
  for (let end = text.lastIndexOf(']'); end >= 0; end = text.lastIndexOf(']', end - 1)) {
    let depth = 0;
    let start = -1;
    for (let index = end; index >= 0; index -= 1) {
      const char = text[index];
      if (char === ']') depth += 1;
      else if (char === '[') {
        depth -= 1;
        if (depth === 0) { start = index; break; }
      }
    }
    if (start < 0) continue;
    try {
      const value = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(value) && value.length && value.every(item => typeof item === 'string')) return value;
    } catch { /* 继续向前找 */ }
  }
  return null;
}

function runOnce({ scriptPath, model, effort, prompt, timeoutMs, signal }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('bash', [scriptPath, '--model', model, '--effort', effort, '-y', '-p', prompt], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) rejectPromise(error); else resolvePromise(value);
    };
    const onAbort = () => { child.kill('SIGKILL'); finish(Object.assign(new Error('PROVIDER_ABORTED'), { code: 'PROVIDER_ABORTED' })); };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(Object.assign(new Error('PROVIDER_TIMEOUT'), { code: 'PROVIDER_TIMEOUT', stderr }));
    }, timeoutMs);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', error => finish(Object.assign(new Error('PROVIDER_SPAWN_FAILED'), { code: 'PROVIDER_SPAWN_FAILED', cause: error })));
    child.on('close', code => {
      if (code !== 0) {
        finish(Object.assign(new Error('PROVIDER_EXIT'), { code: 'PROVIDER_EXIT', exitCode: code, stdout, stderr }));
        return;
      }
      finish(null, { stdout, stderr });
    });
  });
}

export function createCodebuddyTranslator(options = {}) {
  const config = { ...translationProviderConfig(), ...options };
  const model = config.model || DEFAULT_MODEL;
  return {
    kind: 'codebuddy-cli',
    provider: 'codebuddy',
    model,
    /** 通道说明直接给界面/文档用，避免把云端通道说成本地模型。 */
    description: `CodeBuddy CLI → CodeBuddy 云端模型（${model}），不是本地模型`,
    get available() { return !config.disabled && existsSync(config.scriptPath); },
    unavailableReason() {
      if (config.disabled) return '翻译通道已被 P040_TRANSLATE_DISABLED=1 关闭';
      if (!existsSync(config.scriptPath)) return `找不到翻译脚本：${config.scriptPath}`;
      return '';
    },
    async translateBatch(texts, { sourceLanguage = 'ko', targetLanguage = 'zh', signal } = {}) {
      if (!Array.isArray(texts) || !texts.length) return [];
      if (!this.available) throw Object.assign(new Error(this.unavailableReason()), { code: 'TRANSLATION_UNAVAILABLE' });
      const prompt = promptFor(texts, sourceLanguage, targetLanguage);
      let lastError = null;
      for (let attempt = 0; attempt <= config.retries; attempt += 1) {
        try {
          const { stdout } = await runOnce({ ...config, prompt, signal });
          const value = extractTranslationArray(stdout);
          if (!value) throw Object.assign(new Error('PROVIDER_BAD_SHAPE'), { code: 'PROVIDER_BAD_SHAPE', stdout });
          if (value.length !== texts.length) {
            throw Object.assign(new Error('PROVIDER_LENGTH_MISMATCH'), { code: 'PROVIDER_LENGTH_MISMATCH', expected: texts.length, got: value.length });
          }
          const cleaned = value.map(item => String(item ?? '').trim());
          if (cleaned.some(item => !item)) throw Object.assign(new Error('PROVIDER_EMPTY_LINE'), { code: 'PROVIDER_EMPTY_LINE' });
          return cleaned;
        } catch (error) {
          lastError = error;
          if (error?.code === 'PROVIDER_ABORTED') throw error;
          if (attempt < config.retries) await new Promise(done => setTimeout(done, 800 * (attempt + 1)));
        }
      }
      throw lastError ?? new Error('PROVIDER_FAILED');
    },
  };
}
