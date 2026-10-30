import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createTimedSignal } from '../../src/lib/abort-signal';
import { apiWithTimeout } from '../../src/lib/api';

function hangingFetch() {
  return vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal as AbortSignal | undefined;
    if (!signal) return reject(new Error('missing signal'));
    const fail = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail);
  }));
}

function okFetch(body: unknown = { ok: true }) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as Response);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createTimedSignal 老 WebView 兼容', () => {
  it('没有 AbortSignal.timeout / any 也能按时超时', () => {
    vi.useFakeTimers();
    const timeout = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    const any = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Reflect.deleteProperty(AbortSignal, 'timeout');
    Reflect.deleteProperty(AbortSignal, 'any');
    try {
      expect((AbortSignal as unknown as { timeout?: unknown }).timeout).toBeUndefined();
      expect((AbortSignal as unknown as { any?: unknown }).any).toBeUndefined();
      const { signal, release } = createTimedSignal(5000);
      vi.advanceTimersByTime(4999);
      expect(signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toMatchObject({ name: 'AbortError' });
      release();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (timeout) Object.defineProperty(AbortSignal, 'timeout', timeout);
      if (any) Object.defineProperty(AbortSignal, 'any', any);
    }
  });

  it('外部取消立即传导，释放计时器', () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { signal, release } = createTimedSignal(15000, controller.signal);
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
    release();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('外部已取消时创建的信号立刻是取消态', () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const { signal, release } = createTimedSignal(15000, controller.signal);
    expect(signal.aborted).toBe(true);
    release();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('release 后摘掉外部监听并清掉计时器，不再被迟到取消影响', () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { signal, release } = createTimedSignal(5000, controller.signal);
    release();
    release();
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    expect(signal.aborted).toBe(false);
  });

  it('超时后 release 仍是幂等的', () => {
    vi.useFakeTimers();
    const { signal, release } = createTimedSignal(5000);
    vi.advanceTimersByTime(5000);
    expect(signal.aborted).toBe(true);
    release();
    release();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('apiWithTimeout 长耗时请求时限', () => {
  it('按指定 120 秒取消，而不是 api 默认的 15 秒', async () => {
    vi.useFakeTimers();
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const request = apiWithTimeout('/api/demo-library', { method: 'POST' }, 120000);
    const settled = vi.fn();
    request.catch(settled);
    await vi.advanceTimersByTimeAsync(119999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('请求成功或失败后都释放计时器', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', okFetch({ ok: true }));
    await expect(apiWithTimeout('/api/demo-library', { method: 'POST' }, 120000)).resolves.toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('源码不再直接依赖新式 AbortSignal 静态方法', () => {
  it('src 下没有 AbortSignal.timeout / AbortSignal.any 调用', () => {
    const offenders = sourceFiles(join(process.cwd(), 'src')).filter(path => /AbortSignal\.(timeout|any)\s*\(/.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
