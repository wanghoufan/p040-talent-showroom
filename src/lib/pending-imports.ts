/**
 * 未完成的收录任务（T034 续）。
 *
 * 上传成功后 job 已落在服务器，但用户可能还没在确认页点“保存”就退出 App。
 * 只靠页面路由记不住 jobId：重开 App 回到曲库后，这次导入就像丢了，只能重新选文件。
 * 这里把 jobId 落到 localStorage，曲库页据此给出“未完成的收录 → 继续”，直到确认保存或明确失败才移除。
 */

export interface PendingImport {
  jobId: string;
  name: string;
  createdAt: string;
}

const KEY = 'dance.pending-imports.v1';
const EVENT = 'dance-pending-imports-changed';

function read(): PendingImport[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is PendingImport => Boolean(item) && typeof (item as PendingImport).jobId === 'string');
  } catch {
    return [];
  }
}

function write(items: PendingImport[]): void {
  localStorage.setItem(KEY, JSON.stringify(items));
  window.dispatchEvent(new Event(EVENT));
}

export function listPendingImports(): PendingImport[] {
  return read();
}

/** 同一 jobId 只留一条；最多保留 20 条，避免长期堆积。 */
export function rememberImport(jobId: string, name: string): void {
  const items = read().filter((item) => item.jobId !== jobId);
  items.unshift({ jobId, name: name.trim() || '未命名视频', createdAt: new Date().toISOString() });
  write(items.slice(0, 20));
}

export function forgetImport(jobId: string): void {
  const items = read();
  const next = items.filter((item) => item.jobId !== jobId);
  if (next.length !== items.length) write(next);
}

export function subscribePendingImports(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}