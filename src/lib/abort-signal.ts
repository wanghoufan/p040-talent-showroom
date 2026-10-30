/**
 * 老 Android WebView 没有 AbortSignal.timeout / AbortSignal.any，也不一定支持
 * Controller.abort(reason)。这里统一用 AbortController + setTimeout 组合外部取消
 * 与超时，超时语义仍是 AbortError；请求结束必须调用 release 释放计时器和监听。
 */
export interface TimedSignal { signal: AbortSignal; release: () => void; }

export function createTimedSignal(timeoutMs: number, external?: AbortSignal | null): TimedSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let onExternalAbort: (() => void) | undefined;
  if (external) {
    onExternalAbort = () => controller.abort();
    if (external.aborted) onExternalAbort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    if (external && onExternalAbort) external.removeEventListener('abort', onExternalAbort);
  };
  return { signal: controller.signal, release };
}
