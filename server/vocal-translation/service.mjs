import { getRepertoire, saveRepertoire } from '../repertoire/service.mjs';
import {
  MAX_TRANSLATION_CHARS,
  TARGET_LANGUAGE,
  TRANSLATION_LANGUAGE,
  TRANSLATION_VERSION,
  associateExistingTranslations,
  mergeTranslations,
  missingTranslationLines,
  normalizeTranslations,
  textHash,
  translatableLines,
  withStaleness,
} from './translation.mjs';

/**
 * 批量翻译服务。
 *
 * 顺序固定：LRC 自带中文 → 本地缓存 → CodeBuddy 通道。
 * 每批失败会二分重试到单行；单行仍失败只记录 failed，不伪造译文、不把整首标成完成。
 * 人工译文与 LRC 译文永不被 AI 覆盖；写入统一走 saveRepertoire，时间轴与结构完全不动。
 */
const DEFAULT_CHUNK = 32;

function uniqueChunks(entries, size) {
  const chunks = [];
  for (let index = 0; index < entries.length; index += size) chunks.push(entries.slice(index, index + size));
  return chunks;
}

export function createVocalTranslationService({ db, translator, logger = null } = {}) {
  if (!db) throw new TypeError('createVocalTranslationService 需要 db');
  const inFlight = new Map();

  function cacheGet(text, sourceLanguage) {
    if (!translator) return null;
    const key = textHash(`${translator.provider}|${translator.model}|${sourceLanguage}|${TARGET_LANGUAGE}|${text}`);
    const row = db.prepare('SELECT target_text FROM vocal_translation_cache WHERE cache_key=?').get(key);
    if (!row) return null;
    db.prepare('UPDATE vocal_translation_cache SET last_used_at=CURRENT_TIMESTAMP WHERE cache_key=?').run(key);
    return row.target_text;
  }

  function cachePut(text, translated, sourceLanguage) {
    if (!translator) return;
    const key = textHash(`${translator.provider}|${translator.model}|${sourceLanguage}|${TARGET_LANGUAGE}|${text}`);
    db.prepare(`INSERT INTO vocal_translation_cache(cache_key,source_lang,target_lang,source_text,target_text,provider,model)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET target_text=excluded.target_text,last_used_at=CURRENT_TIMESTAMP`)
      .run(key, sourceLanguage, TARGET_LANGUAGE, text, translated, translator.provider, translator.model);
  }

  function readItem(id) {
    const item = getRepertoire(db, id);
    if (!item) throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
    if (item.kind !== 'VOCAL') throw Object.assign(new Error('NOT_VOCAL'), { status: 400 });
    return item;
  }

  function currentLines(item) {
    return (item.translations?.lines || []).map(line => ({ ...line }));
  }

  function persist(item, lines, meta) {
    const doc = {
      version: TRANSLATION_VERSION,
      language: TRANSLATION_LANGUAGE,
      lines: lines.map(({ id, text, source, sourceHash }) => ({ id, text, source, sourceHash })),
      ...(meta?.provider ? { provider: meta.provider } : {}),
      ...(meta?.model ? { model: meta.model } : {}),
    };
    return saveRepertoire(db, item.id, { translations: doc });
  }

  /**
   * 翻译一首歌里缺译文的行。返回统计与最新曲目；`status` 只会是
   * COMPLETE / PARTIAL / CHANNEL_UNAVAILABLE / NOTHING_TO_DO，绝不把失败说成完成。
   */
  async function translateSong(id, options = {}) {
    if (inFlight.has(id)) return inFlight.get(id);
    const task = (async () => {
      const item = readItem(id);
      const lyrics = Array.isArray(item.lyrics) ? item.lyrics : [];
      if (!lyrics.length) throw Object.assign(new Error('NO_LYRICS'), { status: 400 });
      const sourceLanguage = item.language || 'ko';
      // 只把真正的原文行算作待译：老双语 LRC 残留的中文行已经是译文，不再送去翻译。
      const sourceLines = translatableLines(lyrics, sourceLanguage);
      const chunkSize = Number.isInteger(options.chunkSize) && options.chunkSize > 0 ? Math.min(64, options.chunkSize) : DEFAULT_CHUNK;
      const startedAt = new Date().toISOString();
      let lines = currentLines(item);
      let lrcReused = 0;
      const pairedLyricIds = new Set();
      /**
       * 本次真正产出的行（LRC 关联 / 缓存 / 通道）。
       * 落库只写这些行，交给 saveRepertoire 与库里现存的译文合并：
       * 否则翻译期间用户人工改过的句子会被入口快照里的旧文本回滚。
       */
      const produced = new Set();

      // 1. 老双语 LRC 已入库时，先把相邻中文行关联成译文（不删原文行、不改时间轴）。
      if (sourceLanguage !== 'zh') {
        const known = new Set(lines.map(line => line.id));
        const pairs = associateExistingTranslations(lyrics, sourceLanguage).filter(pair => !known.has(pair.id));
        for (const pair of pairs) if (pair.sourceLineId) pairedLyricIds.add(pair.sourceLineId);
        if (pairs.length) {
          lines = mergeTranslations(lines, pairs.map(pair => ({
            id: pair.id,
            text: pair.text,
            source: 'lrc',
            sourceHash: textHash(lyrics.find(line => line.id === pair.id)?.text || ''),
          })));
          for (const pair of pairs) produced.add(pair.id);
          lrcReused = pairs.length;
        }
      }

      // 2. 本地缓存：断网或不配通道时也能复用之前翻好的句子。
      //    缓存只依赖 provider/model 标识，与「通道此刻能否启动」无关，不能因为通道不可用就不查。
      let cached = 0;
      const missingAfterLrc = missingTranslationLines(sourceLines, lines, pairedLyricIds);
      const cacheHits = [];
      if (translator) {
        for (const line of missingAfterLrc) {
          const hit = cacheGet(line.text, sourceLanguage);
          if (hit) {
            cacheHits.push({ id: line.id, text: hit, source: 'ai', sourceHash: textHash(line.text) });
            produced.add(line.id);
            cached += 1;
          }
        }
        if (cacheHits.length) lines = mergeTranslations(lines, cacheHits);
      }

      // 3. CodeBuddy 通道；失败了二分重试，不整首回滚已拿到的句子。
      const remaining = missingTranslationLines(sourceLines, lines, pairedLyricIds);
      const failed = [];
      let translated = 0;
      if (remaining.length) {
        if (!translator) {
          for (const line of remaining) failed.push({ id: line.id, code: 'TRANSLATION_UNAVAILABLE', message: '未配置翻译通道' });
        } else if (!translator.available) {
          for (const line of remaining) failed.push({ id: line.id, code: 'TRANSLATION_UNAVAILABLE', message: translator.unavailableReason?.() || '翻译通道不可用' });
        } else {
          /**
           * 整首按原文去重后再分批：同一句在副歌里出现 2–4 次时，若分批各自翻译，
           * 同一句会拿到 2–4 种中文写法（2026-10-31 审校的 32 行同源不一致）。
           * 这里先去重成「原文 → 行 id 列表」，翻一次回填所有同文行。
           */
          const byText = new Map();
          for (const line of remaining) {
            if (!byText.has(line.text)) byText.set(line.text, { text: line.text, ids: [] });
            byText.get(line.text).ids.push(line.id);
          }
          for (const chunk of uniqueChunks([...byText.values()], chunkSize)) {
            await runChunk(chunk, sourceLanguage, options.signal);
          }
        }
      }

      async function runChunk(groups, language, signal) {
        if (!groups.length) return;
        try {
          const values = await translator.translateBatch(groups.map(group => group.text), { sourceLanguage: language, targetLanguage: TARGET_LANGUAGE, signal });
          const incoming = [];
          groups.forEach((group, index) => {
            const text = String(values[index] || '').trim().slice(0, MAX_TRANSLATION_CHARS);
            if (!text) return;
            cachePut(group.text, text, language);
            for (const id of group.ids) incoming.push({ id, text, source: 'ai', sourceHash: textHash(group.text) });
          });
          lines = mergeTranslations(lines, incoming);
          for (const line of incoming) produced.add(line.id);
          translated += incoming.length;
        } catch (error) {
          if (signal?.aborted) throw Object.assign(new Error('PROVIDER_ABORTED'), { code: 'PROVIDER_ABORTED' });
          // 通道级故障（超时/启动失败/非零退出）不二分：否则 3 次重试 × 每层二分 = 长时间空转。
          // 只有「输出形状不对/长度不符/空行」这类可恢复问题才拆小批重试。
          const systemic = ['PROVIDER_TIMEOUT', 'PROVIDER_SPAWN_FAILED', 'PROVIDER_EXIT', 'TRANSLATION_UNAVAILABLE'].includes(error?.code);
          if (groups.length > 1 && !systemic) {
            const middle = Math.ceil(groups.length / 2);
            await runChunk(groups.slice(0, middle), language, signal);
            await runChunk(groups.slice(middle), language, signal);
            return;
          }
          for (const group of groups) {
            for (const id of group.ids) failed.push({ id, code: error?.code || 'PROVIDER_FAILED', message: error?.message || '翻译失败' });
          }
        }
      }

      // 4. 保存：只提交本次产出的行，让 saveRepertoire 与库里最新译文合并（人工优先）；
      //    没有产出就不写库，避免空操作推进 revision。
      lines = normalizeTranslations({ lines }, lyrics).lines;
      const producedLines = lines.filter(line => produced.has(line.id));
      const changed = producedLines.length > 0;
      let saved = item;
      if (changed) {
        saved = persist(item, producedLines, { provider: translator?.provider, model: translator?.model });
      }
      const finalLines = saved.translations?.lines || lines;
      const missing = missingTranslationLines(sourceLines, finalLines, pairedLyricIds);
      const originalTotal = sourceLines.length;
      const status = missing.length
        ? (missing.length >= originalTotal ? 'CHANNEL_UNAVAILABLE' : 'PARTIAL')
        : (changed ? 'COMPLETE' : 'NOTHING_TO_DO');
      return {
        item: saved,
        status,
        total: originalTotal,
        translated,
        cached,
        lrcReused,
        manualKept: finalLines.filter(line => line.source === 'manual').length,
        translatedLines: finalLines.length,
        remaining: missing.length,
        failed,
        provider: translator ? { kind: translator.kind, provider: translator.provider, model: translator.model, description: translator.description, available: translator.available } : null,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    })().finally(() => inFlight.delete(id));
    inFlight.set(id, task);
    return task;
  }

  /** 人工纠错：manual 覆盖一切；空文本表示删除该句译文。显式整份替换，避免合并把删掉的行带回来。 */
  function applyManual(id, input) {
    const item = readItem(id);
    if (!input || !Array.isArray(input.lines)) throw Object.assign(new Error('INVALID_TRANSLATIONS'), { status: 400 });
    const byId = new Map((item.translations?.lines || []).map(line => [line.id, { ...line }]));
    for (const raw of input.lines) {
      if (!raw || typeof raw.id !== 'string') throw Object.assign(new Error('INVALID_TRANSLATIONS'), { status: 400 });
      const text = typeof raw.text === 'string' ? raw.text.trim() : '';
      if (!text) { byId.delete(raw.id); continue; }
      if (text.length > MAX_TRANSLATION_CHARS) throw Object.assign(new Error('INVALID_TRANSLATIONS'), { status: 400 });
      const lyric = (item.lyrics || []).find(line => line.id === raw.id);
      if (!lyric) throw Object.assign(new Error('UNKNOWN_LINE'), { status: 400 });
      byId.set(raw.id, { id: raw.id, text, source: 'manual', sourceHash: textHash(lyric.text) });
    }
    const lines = (item.lyrics || []).filter(line => byId.has(line.id)).map(line => byId.get(line.id));
    const saved = saveRepertoire(db, item.id, { translations: { lines, replace: true, provider: 'manual', model: 'user' } });
    return { item: saved, lines: withStaleness(saved.translations?.lines || [], saved.lyrics || []) };
  }

  return { translateSong, applyManual, getItem: readItem };
}
