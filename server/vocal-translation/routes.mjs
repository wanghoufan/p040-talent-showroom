/**
 * 歌词译文接口（owner 配对后可用）。
 *
 * PUT  /api/repertoire/:id/translations            人工纠错（整份提交，空文本=删除该句）
 * POST /api/repertoire/:id/translations/translate  批量翻译缺失句（LRC → 缓存 → CodeBuddy 通道）
 *
 * 只读写译文文档，不触碰 lyrics_json 的时间轴；失败按句回报，不伪装完成。
 */
const PATH = /^\/api\/repertoire\/([0-9a-f-]{36})\/translations(\/translate)?$/;

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJson(req, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('PAYLOAD_TOO_LARGE'), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BAD_REQUEST');
    return value;
  } catch {
    throw Object.assign(new Error('BAD_REQUEST'), { status: 400 });
  }
}

export function mountTranslationRoutes({ service, authorize, maxBodyBytes = 262144, logger = null } = {}) {
  if (!service) throw new TypeError('mountTranslationRoutes 需要 service');
  if (typeof authorize !== 'function') throw new TypeError('mountTranslationRoutes 需要 authorize：译文接口不接受无鉴权挂载');

  return async function handleTranslation(req, res, url) {
    const match = PATH.exec(url.pathname);
    if (!match) return false;
    try {
      if (!authorize(req)) return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: '请先配对这台设备' } });
      const id = match[1];
      if (match[2]) {
        if (req.method !== 'POST') return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
        const body = await readJson(req, maxBodyBytes);
        if (body.chunkSize !== undefined && (!Number.isInteger(body.chunkSize) || body.chunkSize < 1 || body.chunkSize > 64)) {
          throw Object.assign(new Error('BAD_REQUEST'), { status: 400 });
        }
        const result = await service.translateSong(id, { chunkSize: body.chunkSize });
        return sendJson(res, 200, result);
      }
      if (req.method !== 'PUT') return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
      const body = await readJson(req, maxBodyBytes);
      if (!Array.isArray(body.lines)) throw Object.assign(new Error('BAD_REQUEST'), { status: 400 });
      return sendJson(res, 200, service.applyManual(id, { lines: body.lines }));
    } catch (error) {
      const status = error?.status || 500;
      if (status >= 500) logger?.error?.(`vocal-translation ${url.pathname}: ${error?.message ?? error}`);
      return sendJson(res, status, {
        error: {
          code: error?.code || (status === 404 ? 'NOT_FOUND' : status === 400 ? 'BAD_REQUEST' : 'INTERNAL'),
          message: error?.message || '译文接口内部错误',
        },
      });
    }
  };
}
