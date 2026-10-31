import { sha256File } from './analyzer.mjs';
import { readWaveform, waveformBuckets } from './waveform.mjs';
import {
  applyStructureDraft, clearStructureReference, discardStructureDraft, draftFromCurrentSections, generateStructureDraft,
  getDraftView, listStructureReferences, reapplyStructureReference, recordDraftFailure, restoreLegacySections,
  resolveOriginalAudio, setStructureReference, setStructureReferenceFromCatalog,
} from './service.mjs';

/** 与 server/index.mjs 的 sendJson 等价；单独定义避免与入口模块循环引用。 */
function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

/**
 * 结构地图 HTTP 接口（V3.2 T4 + V3.3 参考草稿）。
 *
 * 只挂到 owner 已配对的设备上：分析会读本机原曲文件，不能因为「还没配对」就变成公开接口。
 * 路由形态：
 *   GET    /api/repertoire/:id/structure-draft          读取草稿（无草稿返回 draft:null）
 *   POST   /api/repertoire/:id/structure-draft          生成/重算草稿（body: {force?:boolean}）
 *   PUT    /api/repertoire/:id/structure-draft          应用草稿（body: {map, replaceManual?, confirmReference?}）
 *   DELETE /api/repertoire/:id/structure-draft          丢弃草稿
 *   POST   /api/repertoire/:id/structure-draft/restore  恢复生成前的旧结构
 *   GET    /api/repertoire/:id/structure-draft/current  当前正式结构 → 地图（不跑分析）
 *   POST   /api/repertoire/:id/structure-draft/reference        载入参考草稿（只写草稿）
 *   POST   /api/repertoire/:id/structure-draft/reference/reapply 重新载入上次的参考草稿
 *   DELETE /api/repertoire/:id/structure-draft/reference        放弃参考草稿
 *   GET    /api/repertoire/:id/structure-waveform       原曲波形包络（只给界面拖动用）
 */
const ROUTE = /^\/api\/repertoire\/([0-9a-f-]{36})\/structure-draft(\/restore|\/current|\/reference(?:\/reapply)?)?$/;
/** 本机内置参考目录：GET 列出可载入项，POST {catalogId} 一键载入（仍走身份五项核验）。 */
const CATALOG_ROUTE = /^\/api\/repertoire\/([0-9a-f-]{36})\/structure-draft\/reference\/catalog$/;
const WAVEFORM_ROUTE = /^\/api\/repertoire\/([0-9a-f-]{36})\/structure-waveform$/;

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 512 * 1024) throw Object.assign(new Error('BAD_REQUEST'), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString() || '{}';
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BAD_REQUEST');
  return value;
}

export function mountStructureRoutes({ db, mediaRoot, analyzer, getRepertoire, saveRepertoire, workDir, authorize, logger = null } = {}) {
  if (!db || !mediaRoot || !getRepertoire || !saveRepertoire) return null;

  return async function handle(req, res, url) {
    const waveformMatch = WAVEFORM_ROUTE.exec(url.pathname);
    if (waveformMatch) {
      const ownerToken = req.headers.authorization?.replace(/^Bearer /, '') || null;
      if (authorize && !authorize(ownerToken)) {
        sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: '请先配对这台设备' } });
        return true;
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
        return true;
      }
      const songId = waveformMatch[1];
      try {
        const audio = resolveOriginalAudio(db, mediaRoot, songId);
        const sha = audio.sha256 || sha256File(audio.absolute);
        const result = await readWaveform({
          audioPath: audio.absolute,
          sha256: sha,
          buckets: waveformBuckets(url.searchParams.get('buckets')),
          durationMs: audio.durationMs || 0,
        });
        return sendJson(res, 200, result), true;
      } catch (error) {
        const code = error?.code || 'WAVEFORM_FAILED';
        sendJson(res, code === 'AUDIO_NOT_FOUND' ? 404 : 503, {
          error: {
            code,
            message: code === 'FFMPEG_UNAVAILABLE'
              ? '本机没有 ffmpeg，暂时画不出波形；仍可按时间刻度拖动校正，不伪造波形。'
              : '波形暂时不可用，可用时间刻度校正。',
          },
        });
        return true;
      }
    }

    const catalogMatch = CATALOG_ROUTE.exec(url.pathname);
    if (catalogMatch) {
      const ownerToken = req.headers.authorization?.replace(/^Bearer /, '') || null;
      if (authorize && !authorize(ownerToken)) {
        sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: '请先配对这台设备' } });
        return true;
      }
      const catalogSongId = catalogMatch[1];
      try {
        if (req.method === 'GET') {
          return sendJson(res, 200, listStructureReferences({ db, mediaRoot, getRepertoire, songId: catalogSongId })), true;
        }
        if (req.method === 'POST') {
          const body = await readBody(req).catch(() => ({}));
          return sendJson(res, 200, setStructureReferenceFromCatalog({
            db, mediaRoot, getRepertoire, songId: catalogSongId, catalogId: body?.catalogId,
          })), true;
        }
        sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
        return true;
      } catch (error) {
        if (res.headersSent) return true;
        sendJson(res, error.status || 400, {
          error: {
            code: error.code || error.message || 'BAD_REQUEST',
            message: humanError(error),
            ...(error.identity ? { identity: error.identity } : {}),
          },
        });
        return true;
      }
    }

    const match = ROUTE.exec(url.pathname);
    if (!match) return false;
    const ownerToken = req.headers.authorization?.replace(/^Bearer /, '') || null;
    if (authorize && !authorize(ownerToken)) {
      sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: '请先配对这台设备' } });
      return true;
    }
    const songId = match[1];
    const sub = match[2] || '';
    try {
      if (!sub && req.method === 'GET') {
        return sendJson(res, 200, { draft: getDraftView({ db, getRepertoire, songId }) }), true;
      }
      if (!sub && req.method === 'POST') {
        if (!analyzer?.ready) {
          sendJson(res, 503, {
            error: {
              code: 'ANALYZER_NOT_CONFIGURED',
              message: '这台电脑还没有配置原曲结构分析（P040_STRUCTURE_PYTHON）；曲目保持「待分析」，不会用歌词猜段落。',
            },
          });
          return true;
        }
        const body = await readBody(req).catch(() => ({}));
        try {
          const result = await generateStructureDraft({
            db, mediaRoot, analyzer, getRepertoire, songId,
            force: body?.force === true,
            workDir,
          });
          return sendJson(res, 200, result), true;
        } catch (error) {
          recordDraftFailure({ db, songId, code: error?.code || 'ANALYSIS_FAILED', message: error?.message || '', item: getRepertoire(db, songId) });
          logger?.warn?.(`structure draft failed for ${songId}: ${error?.code || error?.message}`);
          throw error;
        }
      }
      if (!sub && req.method === 'PUT') {
        const body = await readBody(req);
        const result = applyStructureDraft({
          db, getRepertoire, saveRepertoire, songId,
          map: body?.map,
          replaceManual: body?.replaceManual === true,
          confirmReference: body?.confirmReference === true,
        });
        return sendJson(res, 200, result), true;
      }
      if (sub === '/reference' && req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, setStructureReference({ db, mediaRoot, getRepertoire, songId, reference: body?.reference })), true;
      }
      if (sub === '/reference/reapply' && req.method === 'POST') {
        return sendJson(res, 200, reapplyStructureReference({ db, getRepertoire, songId })), true;
      }
      if (sub === '/reference' && req.method === 'DELETE') {
        return sendJson(res, 200, clearStructureReference({ db, getRepertoire, songId })), true;
      }
      if (!sub && req.method === 'DELETE') {
        return sendJson(res, 200, discardStructureDraft({ db, songId })), true;
      }
      if (sub === '/restore' && req.method === 'POST') {
        return sendJson(res, 200, restoreLegacySections({ db, getRepertoire, saveRepertoire, songId })), true;
      }
      if (sub === '/current' && req.method === 'GET') {
        const map = draftFromCurrentSections({ db, getRepertoire, songId });
        return sendJson(res, map ? 200 : 404, map ? { map } : { error: { code: 'NO_SECTIONS', message: '这条曲目还没有结构' } }), true;
      }
      sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
      return true;
    } catch (error) {
      if (res.headersSent) return true;
      sendJson(res, error.status || 400, {
        error: {
          code: error.code || error.message || 'BAD_REQUEST',
          message: humanError(error),
          ...(error.identity ? { identity: error.identity } : {}),
        },
      });
      return true;
    }
  };
}

function humanError(error) {
  const code = error?.code || error?.message;
  const map = {
    ANALYZER_NOT_CONFIGURED: '分析环境未配置，曲目保持待分析',
    ANALYSIS_TIMEOUT: '分析超时，可重试或换更短的音频',
    ANALYSIS_FAILED: '分析没有完成，源文件未被修改',
    ANALYSIS_INVALID: '分析结果不可信，已拒绝',
    SEPARATION_DETECTED: '检测到分离链路，已拒绝该结果',
    SOURCE_CHANGED: '原曲在分析过程中被改动，请重试',
    NO_AUDIO: '这条曲目还没有原唱音轨',
    DRAFT_NOT_FOUND: '还没有结构草稿',
    MANUAL_OVERRIDE: '已有手工校准结构，需显式确认覆盖',
    CONFLICT: '曲目已变化，请重新生成草稿',
    NO_LEGACY_SECTIONS: '生成草稿时本来就没有旧结构',
    INVALID_MAP: '草稿内容不合法',
    IDENTITY_MISMATCH: '参考结构核验不通过：歌手/歌名/版本/时长/原音频摘要与本地不一致，已拒绝载入',
    REFERENCE_SCHEMA_INVALID: '参考文件格式不对（需要 p040.structure-reference.v1）',
    REFERENCE_LYRIC_PAYLOAD: '参考文件里带了歌词正文；只接受结构类型与时间，不接收第三方歌词',
    REFERENCE_AUDIO_SHA_REQUIRED: '参考文件必须带原音频 SHA，无法核对就不载入',
    REFERENCE_TITLE_REQUIRED: '参考文件缺少歌名',
    REFERENCE_ARTIST_REQUIRED: '参考文件缺少歌手',
    REFERENCE_DURATION_REQUIRED: '参考文件缺少原曲时长',
    REFERENCE_EMPTY: '参考文件没有候选段落',
    REFERENCE_NOT_FOUND: '草稿里没有参考结构',
    REFERENCE_CATALOG_NOT_FOUND: '本机没有这份参考结构',
    REFERENCE_CONFIRMATION_REQUIRED: '这是参考草稿，需要先逐段核对再应用',
  };
  return map[code] || '结构操作未完成，请检查内容后重试';
}
