import { readDeviceSettings } from './device-settings';

/**
 * 服务地址自动择优（用户 2026-11-05 口径）：
 * - 在家连 Wi-Fi：局域网地址探测健康就用它（直连，下载快）；
 * - 出门/断 Wi-Fi：局域网探测失败，自动换 Tailscale 地址；
 * - 都不通：仍用主地址发起请求，让上层按既有逻辑提示「无法连接」并回落本地快照。
 *
 * 探测结果缓存 5 分钟，避免每个请求都打一次 /api/health；
 * 请求真的失败时由 api() 调 invalidateEndpoint() 让下一次重新探测。
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 1500;

interface EndpointCache { base: string; at: number }
let cache: EndpointCache | null = null;
let probing: Promise<string> | null = null;

/** 候选地址：主地址优先，备用地址去重后跟进。 */
export function endpointCandidates(settings = readDeviceSettings()): string[] {
  const list = [settings.apiEndpoint, settings.apiFallback]
    .map((value) => (value || '').trim())
    .filter((value) => value.length > 0);
  return [...new Set(list)];
}

export function invalidateEndpoint(): void {
  cache = null;
}

/** 同步取当前已确认可用的地址（没有缓存时退回主地址），给 mediaUrl 这类同步调用用。 */
export function currentEndpointBase(settings = readDeviceSettings()): string {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.base;
  return settings.apiEndpoint || '';
}

async function probe(base: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  if (typeof fetch !== 'function') return false;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${base}/api/health`, {
      method: 'GET',
      signal: controller ? controller.signal : undefined,
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 选一个可用地址。并发调用共享同一次探测，避免启动时打多轮健康检查。
 */
export function activeEndpoint(force = false): Promise<string> {
  const candidates = endpointCandidates();
  if (!candidates.length) return Promise.resolve('');
  // 只有一个地址时没有可切换目标，探测纯属多一次往返：直接用主地址。
  if (candidates.length === 1) return Promise.resolve(candidates[0]);
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return Promise.resolve(cache.base);
  if (probing) return probing;

  probing = (async () => {
    for (const base of candidates) {
      if (await probe(base)) {
        cache = { base, at: Date.now() };
        return base;
      }
    }
    // 全都不通：仍返回主地址，让请求走原有失败与离线提示路径。
    cache = null;
    return candidates[0];
  })().finally(() => { probing = null; });

  return probing;
}
