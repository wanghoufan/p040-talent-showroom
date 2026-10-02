import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { extractUrl, enqueueShares, listPendingShares, submitShare } from '../../src/lib/pending-shares';
import type { PendingShare } from '../../src/lib/types';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it('从分享文本中提取抖音链接并清理尾部标点', () => {
  expect(extractUrl('看看这个 https://v.douyin.com/abc123/ 很棒')).toBe('https://v.douyin.com/abc123/');
  expect(extractUrl('https://v.douyin.com/xyz/。')).toBe('https://v.douyin.com/xyz/');
  expect(extractUrl('没有链接')).toBeUndefined();
});

it('分享入队按 token 去重，先本地落盘', () => {
  const base: PendingShare = { id: 'a', token: 't1', sharedText: 'https://v.douyin.com/a/', mime: 'text/plain', receivedAt: '2026-10-02T00:00:00Z', submitState: 'PENDING' };
  expect(enqueueShares([base, { ...base, id: 'b' }])).toBe(1);
  expect(listPendingShares()).toHaveLength(1);
});

it('在线提交映射 SUBMITTED，adapter 无能力映射 NEEDS_INPUT，离线映射 OFFLINE_SAVED', async () => {
  const make = (id: string): PendingShare => ({ id, token: id, sharedText: `https://v.douyin.com/${id}/`, mime: 'text/plain', receivedAt: '2026-10-02T00:00:00Z', submitState: 'PENDING' });
  enqueueShares([make('ready'), make('need'), make('offline')]);

  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { link: string };
    if (body.link.includes('/ready/')) return new Response(JSON.stringify({ id: 'job-ready', status: 'PROCESSING' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (body.link.includes('/need/')) return new Response(JSON.stringify({ id: 'job-need', status: 'NEEDS_INPUT' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    throw new TypeError('network down');
  }));

  const ready = await submitShare('ready');
  expect(ready?.submitState).toBe('SUBMITTED');
  expect(ready?.serverJobId).toBe('job-ready');

  const need = await submitShare('need');
  expect(need?.submitState).toBe('NEEDS_INPUT');

  const offline = await submitShare('offline');
  expect(offline?.submitState).toBe('OFFLINE_SAVED');
});
