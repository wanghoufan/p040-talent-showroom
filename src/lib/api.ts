import { readDeviceSettings } from './device-settings';
export function mediaUrl(path:string):string {
  if(!path.startsWith('/api/media/')) throw new Error('无效媒体地址');
  // 原生 Filesystem.downloadFile 需要绝对地址；未配置端点时回落到当前来源（WebView 直连或 Vite 代理）。
  const base=readDeviceSettings().apiEndpoint||window.location.origin;
  const token=localStorage.getItem('dance.owner-token');return base+path+(token?'?owner='+encodeURIComponent(token):'');
}
export class ApiError extends Error {status:number;constructor(message:string,status:number){super(message);this.status=status;}}
export async function api<T>(path:string,options:RequestInit={}):Promise<T>{
  if(!path.startsWith('/api/')) throw new Error('无效接口');
  const res=await fetch((readDeviceSettings().apiEndpoint||'')+path,{...options,headers:{...Object.fromEntries(new Headers(options.headers)),...(localStorage.getItem('dance.owner-token')?{Authorization:'Bearer '+localStorage.getItem('dance.owner-token')}:{})},signal:options.signal||AbortSignal.timeout(15000)});
  const value=await res.json();
  if(!res.ok)throw new ApiError(value?.error?.message||'操作未完成，请重试',res.status);
  return value as T;
}
export const jsonBody=(value:unknown):RequestInit=>({headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
