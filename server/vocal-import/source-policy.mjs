import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fail } from './errors.mjs';

/**
 * 源目录白名单策略（AC13）。
 *
 * 规则：
 * 1. 导入根目录只能在服务端启动配置里声明，网络请求只能传 `rootId`（可带相对子目录），
 *    永远不能传本机绝对路径；
 * 2. 相对路径禁止 `..`、盘符、UNC、NUL；
 * 3. 根目录以下任何一段是符号链接即拒绝；扫描器另外完全跳过符号链接文件；
 * 4. 最终 realpath 必须仍落在根目录内，双重防越界；
 * 5. 只读：这里没有任何写、改、删、重命名操作。
 */
const ROOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

function normalizeSubPath(input, field = 'subPath') {
  if (input === undefined || input === null || input === '') return '';
  if (typeof input !== 'string') fail('BAD_REQUEST', `${field} 必须是字符串`);
  if (input.includes('\0')) fail('PATH_NOT_ALLOWED', '路径包含非法字符');
  if (isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input) || /^\\\\/.test(input)) {
    fail('PATH_NOT_ALLOWED', '只接受白名单根目录下的相对路径，不接受本机绝对路径');
  }
  const segments = input.replace(/\\/g, '/').split('/').filter(segment => segment !== '' && segment !== '.');
  if (segments.some(segment => segment === '..')) fail('PATH_NOT_ALLOWED', '路径不能包含 ..');
  return segments.join('/');
}

function assertInside(rootPath, targetPath) {
  const rel = relative(rootPath, targetPath);
  if (rel === '') return;
  if (rel.startsWith('..') || isAbsolute(rel)) fail('PATH_NOT_ALLOWED', '路径越出已授权目录');
}

/** 逐段检查根目录以下的符号链接；根目录本身允许是挂载点或系统符号链接。 */
function assertNoSymlinkSegments(rootPath, targetPath) {
  const rel = relative(rootPath, targetPath);
  if (!rel) return;
  let current = rootPath;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      fail('PATH_NOT_ALLOWED', '路径不可访问');
    }
    if (stat.isSymbolicLink()) fail('PATH_NOT_ALLOWED', '不允许通过符号链接访问目录');
  }
}

export function createSourcePolicy({ roots = [] } = {}) {
  const declared = new Map();
  for (const root of roots) {
    const entry = typeof root === 'string' ? { id: root, path: root } : root;
    const id = String(entry?.id ?? '');
    const path = String(entry?.path ?? '');
    if (!ROOT_ID_PATTERN.test(id)) throw new TypeError(`INVALID_ROOT_ID:${id}`);
    if (!path) throw new TypeError(`INVALID_ROOT_PATH:${id}`);
    if (declared.has(id)) throw new TypeError(`DUPLICATE_ROOT_ID:${id}`);
    declared.set(id, { id, path: resolve(path), label: entry.label ? String(entry.label) : id });
  }

  function requireRoot(rootId) {
    const root = declared.get(String(rootId ?? ''));
    if (!root) fail('ROOT_NOT_FOUND', '导入目录未在服务端白名单中登记');
    return root;
  }

  function realRootPath(root) {
    try {
      return realpathSync(root.path);
    } catch {
      fail('ROOT_UNAVAILABLE', '导入目录当前不可用（外置卷未挂载或没有权限）');
    }
  }

  return {
    /** 只返回 id / 展示名 / 是否可用，不回显本机绝对路径。 */
    listRoots() {
      return [...declared.values()].map(root => {
        let available = false;
        try {
          available = statSync(root.path).isDirectory();
        } catch {
          available = false;
        }
        return { id: root.id, label: root.label, available };
      });
    },

    /** 解析一个已授权的目录；网络侧只能给出 rootId + 相对子目录。 */
    resolveRoot(rootId, subPath = '') {
      const root = requireRoot(rootId);
      const rootPath = realRootPath(root);
      const relSubPath = normalizeSubPath(subPath);
      const targetPath = relSubPath ? resolve(rootPath, relSubPath) : rootPath;
      assertInside(rootPath, targetPath);
      assertNoSymlinkSegments(rootPath, targetPath);
      let real;
      try {
        real = realpathSync(targetPath);
      } catch {
        fail('PATH_NOT_ALLOWED', '目录不存在或不可访问');
      }
      assertInside(rootPath, real);
      let stat;
      try {
        stat = statSync(real);
      } catch {
        fail('PATH_NOT_ALLOWED', '目录不存在或不可访问');
      }
      if (!stat.isDirectory()) fail('PATH_NOT_ALLOWED', '目标不是目录');
      return { rootId: root.id, rootPath, targetPath: real, relSubPath };
    },

    /** 解析一个已授权的普通文件；符号链接一律拒绝。 */
    resolveFile(rootId, relPath) {
      const root = requireRoot(rootId);
      const rootPath = realRootPath(root);
      const rel = normalizeSubPath(relPath, 'relPath');
      if (!rel) fail('BAD_REQUEST', 'relPath 不能为空');
      const targetPath = resolve(rootPath, rel);
      assertInside(rootPath, targetPath);
      assertNoSymlinkSegments(rootPath, targetPath);
      let stat;
      try {
        stat = lstatSync(targetPath);
      } catch {
        fail('PATH_NOT_ALLOWED', '文件不存在或不可访问');
      }
      if (stat.isSymbolicLink()) fail('PATH_NOT_ALLOWED', '不允许符号链接文件');
      if (!stat.isFile()) fail('PATH_NOT_ALLOWED', '目标不是普通文件');
      const real = realpathSync(targetPath);
      assertInside(rootPath, real);
      return { rootId: root.id, rootPath, filePath: real, relPath: rel };
    },

    hasRoot(rootId) {
      return declared.has(String(rootId ?? ''));
    },
  };
}
