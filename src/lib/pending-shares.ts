import { api, jsonBody } from './api';
import { drainNativeShares, isNativePlatform, type NativeShare } from '../native/share-target';
import type { ImportJob, PendingShare } from './types';

/**
 * PendingShare 队列（T053/T056）。
 *
 * 原则：分享内容先本地落盘（localStorage，冷启动也可读），再尝试提交服务器；
 * 提交失败/离线时不丢内容，状态保持在 OFFLINE_SAVED，联网后可重试。
 * 状态三态：online processing（SUBMITTED）/ offline saved（OFFLINE_SAVED）/
 * adapter needs local video（NEEDS_INPUT）。
 */

const KEY = 'dance.pending-shares.v1';
const EVENT = 'dance-pending-shares-changed';

function read(): PendingShare[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? (raw as PendingShare[]) : [];
  } catch {
    return [];
  }
}

function write(items: PendingShare[]): void {
  localStorage.setItem(KEY, JSON.stringify(items));
  window.dispatchEvent(new Event(EVENT));
}

export function subscribePendingShares(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

export function listPendingShares(): PendingShare[] {
  return read();
}

/** 从任意分享文本中提取第一个 http(s) 链接；无链接返回 undefined。 */
export function extractUrl(text?: string): string | undefined {
  if (!text) return undefined;
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0].replace(/[.,;，。；]+$/, '') : undefined;
}

function fromNative(share: NativeShare): PendingShare {
  const normalizedUrl = extractUrl(share.sharedText);
  return {
    id: share.id,
    token: share.token,
    sharedText: share.sharedText,
    streamUri: share.streamUri,
    mime: share.mime,
    normalizedUrl,
    receivedAt: share.receivedAt,
    submitState: 'PENDING',
  };
}

/** 落盘新分享（按 token 去重）；返回真正新增的条目数。 */
export function enqueueShares(incoming: PendingShare[]): number {
  const items = read();
  const seen = new Set(items.map((item) => item.token || item.id));
  let added = 0;
  for (const share of incoming) {
    const key = share.token || share.id;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(share);
    added += 1;
  }
  if (added) write(items);
  return added;
}

/** App 启动 / 回到前台时调用：drain 原生队列并本地落盘。 */
export async function ingestNativeShares(): Promise<number> {
  if (!isNativePlatform()) return 0;
  const shares = await drainNativeShares();
  return enqueueShares(shares.map(fromNative));
}

function patch(id: string, changes: Partial<PendingShare>): void {
  const items = read().map((item) => (item.id === id ? { ...item, ...changes } : item));
  write(items);
}

/** 提交单条分享到 `/api/imports/link`，映射三状态。 */
export async function submitShare(id: string): Promise<PendingShare | undefined> {
  const share = read().find((item) => item.id === id);
  if (!share) return undefined;
  const link = share.normalizedUrl || extractUrl(share.sharedText);
  // video/* 分享只带 content:// 句柄，本机 adapter 无法取得，需用户补本地视频。
  if (!link) {
    patch(id, { submitState: 'NEEDS_INPUT', lastError: '需要补充本地视频' });
    return read().find((item) => item.id === id);
  }
  try {
    const job = await api<ImportJob>('/api/imports/link', { method: 'POST', ...jsonBody({ link }) });
    if (job.status === 'NEEDS_INPUT') {
      patch(id, { submitState: 'NEEDS_INPUT', serverJobId: job.id, lastError: undefined });
    } else {
      patch(id, { submitState: 'SUBMITTED', serverJobId: job.id, lastError: undefined });
    }
  } catch (error) {
    // 网络不可达 → 离线保存可重试；服务器明确拒绝 → 该来源暂不支持自动收录。
    if (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) {
      patch(id, { submitState: 'OFFLINE_SAVED', lastError: '离线，已保存待联网重试' });
    } else {
      patch(id, { submitState: 'NEEDS_INPUT', lastError: error instanceof Error ? error.message : '该来源暂不支持自动收录' });
    }
  }
  return read().find((item) => item.id === id);
}

/** 重试所有未完成条目（联网后调用）。 */
export async function submitAllPending(): Promise<void> {
  const items = read().filter((item) => item.submitState === 'PENDING' || item.submitState === 'OFFLINE_SAVED');
  for (const item of items) await submitShare(item.id);
}

export function removePendingShare(id: string): void {
  write(read().filter((item) => item.id !== id));
}
