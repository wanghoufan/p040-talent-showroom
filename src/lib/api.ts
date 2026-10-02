import { readDeviceSettings } from './device-settings';
export function mediaUrl(path:string):string {
  if(!path.startsWith('/api/media/')) throw new Error('无效媒体地址');
  // 原生 Filesystem.downloadFile 需要绝对地址；未配置端点时回落到当前来源（WebView 直连或 Vite 代理）。
  const base=readDeviceSettings().apiEndpoint||window.location.origin;
  return base+path;
}
export async function api<T>(path:string,options:RequestInit={}):Promise<T>{
  if(!path.startsWith('/api/')) throw new Error('无效接口');
  const res=await fetch((readDeviceSettings().apiEndpoint||'')+path,{...options,signal:options.signal||AbortSignal.timeout(15000)});
  const value=await res.json();
  if(!res.ok)throw new Error(value?.error?.message||'操作未完成，请重试');
  return value as T;
}
export const jsonBody=(value:unknown):RequestInit=>({headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
