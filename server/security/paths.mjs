import { realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
export function controlledPath(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\0') || name.includes('\\') || isAbsolute(name)) throw new Error('INVALID_PATH');
  const base = realpathSync(root);
  const target = realpathSync(resolve(base, name));
  const rel = relative(base, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('INVALID_PATH');
  return target;
}
