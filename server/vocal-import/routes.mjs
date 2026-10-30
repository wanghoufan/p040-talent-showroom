import { VocalImportError, fail } from './errors.mjs';

/**
 * 路由挂接（本任务不修改 server/index.mjs，只提供可挂载的处理器）。
 *
 * 使用方式见同目录 README.md：
 *   const handleVocalImport = mountVocalImportRoutes({policy,queue,authorize});
 *   ...
 *   if (await handleVocalImport(req,res,url,ctx)) return;
 * `authorize` 是必填项，接口默认拒绝：即使被误挂到鉴权之前、或设备尚未配对，
 * 也不会暴露本机目录扫描与提取能力。
 */
const PREFIX = '/api/vocal-import';

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function respond(res, status, value) {
  sendJson(res, status, value);
  return true;
}

async function readJson(req, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) fail('BAD_REQUEST', '请求体过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('BAD_REQUEST', '请求体不是合法 JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('BAD_REQUEST', '请求体必须是对象');
  return value;
}

function rejectAbsolutePathBody(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      if (['path', 'rootPath', 'absolutePath', 'dir', 'folder'].includes(key)) {
        fail('PATH_NOT_ALLOWED', '不接受本机绝对路径，请使用服务端登记过的 rootId');
      }
      fail('BAD_REQUEST', `不支持的字段：${key}`);
    }
  }
}

export function mountVocalImportRoutes({ policy, queue, authorize, maxBodyBytes = 32768, logger = null } = {}) {
  if (!policy) throw new TypeError('mountVocalImportRoutes 需要 policy');
  if (!queue) throw new TypeError('mountVocalImportRoutes 需要 queue');
  if (typeof authorize !== 'function') {
    throw new TypeError('mountVocalImportRoutes 需要 authorize：V3.1 接口不接受无鉴权挂载');
  }

  return async function handleVocalImport(req, res, url, ctx = {}) {
    const path = url.pathname;
    if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
    try {
      if (!(await authorize(req, ctx))) {
        return respond(res, 401, { error: { code: 'UNAUTHORIZED', message: '请先配对这台设备' } });
      }

      if (path === `${PREFIX}/roots`) {
        if (req.method !== 'GET') return respond(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
        return respond(res, 200, { roots: policy.listRoots() });
      }

      if (path === `${PREFIX}/scan`) {
        if (req.method !== 'POST') return respond(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
        const body = await readJson(req, maxBodyBytes);
        rejectAbsolutePathBody(body, ['rootId', 'subPath']);
        if (typeof body.rootId !== 'string' || !body.rootId) fail('BAD_REQUEST', '缺少 rootId');
        if (body.subPath !== undefined && typeof body.subPath !== 'string') fail('BAD_REQUEST', 'subPath 必须是字符串');
        const result = await queue.enqueueScan({ rootId: body.rootId, subPath: body.subPath ?? '' });
        return respond(res, 202, {
          created: result.created.length,
          reused: result.reused.length,
          scan: result.scan,
        });
      }

      if (path === `${PREFIX}/jobs`) {
        if (req.method !== 'GET') return respond(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
        const jobs = queue.listJobs({
          status: url.searchParams.get('status') ?? undefined,
          rootId: url.searchParams.get('rootId') ?? undefined,
          songId: url.searchParams.get('songId') ?? undefined,
          limit: url.searchParams.get('limit') ?? undefined,
        });
        return respond(res, 200, { jobs });
      }

      const match = /^\/api\/vocal-import\/jobs\/([0-9a-f-]{36})(?:\/(retry|cancel|resolve|resolve-conflict|original-only))?$/.exec(path);
      if (match) {
        const jobId = match[1];
        const action = match[2] ?? null;
        if (!action) {
          if (req.method !== 'GET') return respond(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
          const job = queue.getJob(jobId);
          if (!job) return respond(res, 404, { error: { code: 'JOB_NOT_FOUND', message: '导入任务不存在' } });
          return respond(res, 200, job);
        }
        if (req.method !== 'POST') return respond(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
        if (action === 'retry') {
          return respond(res, 200, queue.getJob(queue.retry(jobId).id));
        }
        if (action === 'cancel') {
          return respond(res, 200, queue.getJob(queue.cancel(jobId).id));
        }
        // 分离失败/模型不可用时的安全兜底：只入库原唱 + 歌词，不写伴奏轨。
        if (action === 'original-only') {
          const imported = await queue.importOriginalOnly(jobId);
          return respond(res, 200, queue.getJob(imported.id));
        }
        // 入库阶段已有伴奏冲突：必须由用户明确选择保留旧伴奏或改用新伴奏。
        if (action === 'resolve-conflict') {
          const body = await readJson(req, maxBodyBytes);
          rejectAbsolutePathBody(body, ['choice']);
          if (body.choice !== 'keep-existing' && body.choice !== 'use-new') {
            fail('BAD_REQUEST', 'choice 必须是 keep-existing 或 use-new');
          }
          const resolved = await queue.resolveImportConflict(jobId, { choice: body.choice });
          return respond(res, 200, queue.getJob(resolved.id));
        }
        const body = await readJson(req, maxBodyBytes);
        // 人工核对可确认的字段：歌词、伴奏，以及标签冲突时的歌名/歌手（queue.resolve 支持后者）。
        rejectAbsolutePathBody(body, ['lyricsRelPath', 'suppliedAccompanimentRelPath', 'title', 'artist']);
        for (const value of Object.values(body)) {
          if (typeof value !== 'string') fail('BAD_REQUEST', '核对结果必须是字符串');
        }
        return respond(res, 200, queue.getJob(queue.resolve(jobId, body).id));
      }

      return respond(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
    } catch (error) {
      if (error instanceof VocalImportError) {
        return respond(res, error.status, { error: { code: error.code, message: error.message } });
      }
      logger?.error?.(`vocal-import route ${path}: ${error?.message ?? error}`);
      return respond(res, 500, { error: { code: 'INTERNAL', message: '导入接口内部错误' } });
    }
  };
}
