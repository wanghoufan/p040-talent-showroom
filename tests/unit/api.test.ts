import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, CONNECTION_ERROR_MESSAGE } from '../../src/lib/api';

type FetchInit = RequestInit | undefined;

function hangingFetch() {
  return vi.fn((_url: string, init?: FetchInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal as AbortSignal | undefined;
    if (!signal) return reject(new Error('missing signal'));
    const fail = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail);
  }));
}

function okFetch(body: unknown = { ok: true }, status = 200) {
  return vi.fn<(url: string, init?: FetchInit) => Promise<Response>>(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  }) as Response);
}

// 地址自动择优会先打一次 /api/health，断言业务请求时要把它筛掉。
function apiCalls(mock: ReturnType<typeof vi.fn>): Array<[string, FetchInit]> {
  return (mock.mock.calls as Array<[string, FetchInit]>).filter(([url]) => !String(url).includes('/api/health'));
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function rawResponse(body: string, status = 200, contentType = 'text/html') {
  return vi.fn(async () => new Response(body, { status, headers: { 'Content-Type': contentType } }));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('api 请求取消与超时', () => {
  it('老 WebView 没有 AbortSignal.timeout 时仍能正常请求', async () => {
    const original = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    expect(Reflect.deleteProperty(AbortSignal, 'timeout')).toBe(true);
    expect((AbortSignal as unknown as { timeout?: unknown }).timeout).toBeUndefined();
    try {
      const fetchMock = okFetch({ items: [] });
      vi.stubGlobal('fetch', fetchMock);
      await expect(api('/api/library')).resolves.toEqual({ items: [] });
      const signal = (apiCalls(fetchMock).at(-1)?.[1] as RequestInit).signal as AbortSignal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
    } finally {
      if (original) Object.defineProperty(AbortSignal, 'timeout', original);
    }
  });

  it('15 秒无响应按 AbortError 拒绝', async () => {
    vi.useFakeTimers();
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const request = api('/api/library');
    const settled = vi.fn();
    request.catch(settled);
    await vi.advanceTimersByTimeAsync(14999);
    expect(settled).not.toHaveBeenCalled();
    expect((apiCalls(fetchMock).at(-1)?.[1] as RequestInit).signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    const error = await request.catch((e: unknown) => e);
    expect(Object.prototype.toString.call(error)).toBe('[object DOMException]');
  });

  it('成功请求后清理超时定时器', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', okFetch({ value: 1 }));
    await expect(api('/api/library')).resolves.toEqual({ value: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('失败响应仍抛 ApiError', async () => {
    vi.stubGlobal('fetch', okFetch({ error: { message: '没找到' } }, 404));
    await expect(api('/api/library')).rejects.toBeInstanceOf(ApiError);
  });

  it('传入调用方 AbortSignal 时原样下发并跟随其取消', async () => {
    vi.useFakeTimers();
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const request = api('/api/library', { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    const signal = (apiCalls(fetchMock).at(-1)?.[1] as RequestInit).signal as AbortSignal;
    expect(signal).toBe(controller.signal);
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(15000);
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('调用方取消后不会被 15 秒超时再次影响', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const controller = new AbortController();
    const request = api('/api/library', { signal: controller.signal });
    controller.abort(abortError());
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('api 非 JSON 响应安全兜底', () => {
  beforeEach(() => {
    localStorage.setItem('dance.owner-token', 'secret-token-123');
  });

  it('本地静态页返回 HTML 时抛可理解的连接错误，不泄露 HTML/URL/token', async () => {
    vi.stubGlobal('fetch', rawResponse('<!doctype html><html><body>Not Found</body></html>'));
    const error = await api('/api/library').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(200);
    expect((error as ApiError).message).toBe(CONNECTION_ERROR_MESSAGE);
    expect((error as ApiError).message).not.toContain('<');
    expect((error as ApiError).message).not.toContain('html');
    expect((error as ApiError).message).not.toContain('/api');
    expect((error as ApiError).message).not.toContain('http');
    expect((error as ApiError).message).not.toContain('secret-token-123');
    expect(JSON.parse(JSON.stringify({ message: (error as ApiError).message }))).toEqual({ message: CONNECTION_ERROR_MESSAGE });
  });

  it('空响应体同样给出连接/配置错误', async () => {
    vi.stubGlobal('fetch', rawResponse('', 200, 'application/json'));
    await expect(api('/api/library')).rejects.toMatchObject({
      name: 'Error',
      status: 200,
      message: CONNECTION_ERROR_MESSAGE,
    });
  });

  it('HTML 错误页保留 HTTP 状态，但仍使用安全提示', async () => {
    vi.stubGlobal('fetch', rawResponse('<html>Bad Gateway</html>', 502));
    const error = await api('/api/library').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).message).toBe(CONNECTION_ERROR_MESSAGE);
    expect((error as ApiError).message).not.toContain('Bad Gateway');
  });

  it('正常 JSON 成功响应不受影响', async () => {
    vi.stubGlobal('fetch', okFetch({ items: [1, 2] }));
    await expect(api('/api/library')).resolves.toEqual({ items: [1, 2] });
  });

  it('JSON 错误响应仍保留服务端消息与 HTTP 状态', async () => {
    vi.stubGlobal('fetch', okFetch({ error: { message: '没找到' } }, 404));
    const error = await api('/api/library').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).message).toBe('没找到');
  });

  it('读取响应体时的取消错误仍按 AbortError 透传', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw abortError(); },
    }) as unknown as Response));
    await expect(api('/api/library')).rejects.toMatchObject({ name: 'AbortError' });
  });
});
