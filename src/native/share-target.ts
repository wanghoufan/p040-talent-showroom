import { Capacitor, registerPlugin } from '@capacitor/core';

/** 原生落盘的分享条目（Android SharedPreferences，由 ShareTargetPlugin 交付）。 */
export interface NativeShare {
  id: string;
  token: string;
  sharedText?: string;
  streamUri?: string;
  mime: string;
  receivedAt: string;
  submitState: string;
}

interface ShareTargetPlugin {
  drain(): Promise<{ json: string }>;
  peek(): Promise<{ json: string }>;
  addListener(event: 'shareReceived', listener: () => void): Promise<{ remove: () => void }>;
}

const ShareTarget = registerPlugin<ShareTargetPlugin>('ShareTarget');

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

function parse(raw: { json?: string }): NativeShare[] {
  try {
    const value = JSON.parse(raw?.json || '[]');
    return Array.isArray(value) ? (value as NativeShare[]) : [];
  } catch { return []; }
}

/** 取出并清空原生队列；Web 环境返回空。 */
export async function drainNativeShares(): Promise<NativeShare[]> {
  if (!isNativePlatform()) return [];
  try { return parse(await ShareTarget.drain()); } catch { return []; }
}

/** 只读查看原生队列（不清空），用于测试与诊断。 */
export async function peekNativeShares(): Promise<NativeShare[]> {
  if (!isNativePlatform()) return [];
  try { return parse(await ShareTarget.peek()); } catch { return []; }
}

/** 订阅原生新分享事件（warm start）；Web 环境返回空退订函数。 */
export async function onNativeShare(listener: () => void): Promise<() => void> {
  if (!isNativePlatform()) return () => {};
  try {
    const handle = await ShareTarget.addListener('shareReceived', listener);
    return () => handle.remove();
  } catch { return () => {}; }
}
