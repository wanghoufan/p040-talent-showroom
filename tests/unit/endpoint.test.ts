import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeEndpoint, currentEndpointBase, endpointCandidates, invalidateEndpoint } from '../../src/lib/endpoint';

const LAN = 'http://192.168.31.61:28794';
const TS = 'http://100.125.100.15:28794';

function writeSettings(primary: string, fallback?: string): void {
  localStorage.setItem('dance.device-settings', JSON.stringify({
    themeMode: 'system', apiEndpoint: primary, apiFallback: fallback, cachePolicyVersion: 1,
  }));
}

/** 只有 healthy 里的地址返回 200，其余抛网络错误（模拟不在同一网络）。 */
function stubNetwork(healthy: string[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const base = healthy.find((candidate) => url.startsWith(`${candidate}/api/health`));
    if (!base) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => { localStorage.clear(); invalidateEndpoint(); });
afterEach(() => { vi.unstubAllGlobals(); invalidateEndpoint(); });

describe('服务地址自动择优', () => {
  it('主备地址去重且保持主地址在前', () => {
    writeSettings(LAN, TS);
    expect(endpointCandidates()).toEqual([LAN, TS]);
    writeSettings(LAN, LAN);
    expect(endpointCandidates()).toEqual([LAN]);
    writeSettings(LAN);
    expect(endpointCandidates()).toEqual([LAN]);
  });

  it('在家：局域网健康就用局域网，不碰 Tailscale', async () => {
    writeSettings(LAN, TS);
    const fetchMock = stubNetwork([LAN, TS]);
    await expect(activeEndpoint()).resolves.toBe(LAN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('出门：局域网不通自动换备用地址', async () => {
    writeSettings(LAN, TS);
    stubNetwork([TS]);
    await expect(activeEndpoint()).resolves.toBe(TS);
    expect(currentEndpointBase()).toBe(TS);
  });

  it('5 分钟内复用上次结果，不重复探测', async () => {
    writeSettings(LAN, TS);
    const fetchMock = stubNetwork([LAN]);
    await activeEndpoint();
    await activeEndpoint();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('两个都不通时退回主地址，让上层按原逻辑提示无法连接', async () => {
    writeSettings(LAN, TS);
    stubNetwork([]);
    await expect(activeEndpoint()).resolves.toBe(LAN);
    expect(currentEndpointBase()).toBe(LAN);
  });

  it('invalidate 后重新探测：换网时能从局域网切到备用的反向路径', async () => {
    writeSettings(LAN, TS);
    stubNetwork([LAN]);
    await expect(activeEndpoint()).resolves.toBe(LAN);
    invalidateEndpoint();
    stubNetwork([TS]);
    await expect(activeEndpoint()).resolves.toBe(TS);
  });

  it('没有配置地址时返回空串，不发起请求', async () => {
    writeSettings('');
    const fetchMock = stubNetwork([]);
    await expect(activeEndpoint()).resolves.toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
