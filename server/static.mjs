import { createReadStream, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, extname, join } from 'node:path';

/**
 * 静态资源服务（T089）：为 Docker/浏览器交付提供构建后的 dist。
 * SPA 路由回退到 index.html；不处理 /api；拒绝越界路径。
 */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function serveStatic(req, res, root, path, { spaFallback = true } = {}) {
  let rel;
  try { rel = decodeURIComponent(path); } catch { res.writeHead(400); res.end(); return true; }
  const base = resolve(root);
  const target = resolve(base, rel.replace(/^[/\\]+/, ''));
  const inside = relative(base, target);
  if (inside.startsWith('..') || isAbsolute(inside)) { res.writeHead(403); res.end(); return true; }

  const send = (file) => {
    const stat = statSync(file);
    if (!stat.isFile()) return false;
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') { res.end(); return true; }
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return true;
  };

  try {
    const stat = statSync(target);
    if (stat.isDirectory()) return send(join(target, 'index.html'));
    return send(target);
  } catch {
    if (spaFallback && (req.headers.accept || '').includes('text/html')) return send(join(base, 'index.html'));
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: '请求的内容不存在' } }));
    return true;
  }
}
