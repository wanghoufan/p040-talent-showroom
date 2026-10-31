import { readDeviceSettings } from './device-settings';
import { createTimedSignal } from './abort-signal';
export function mediaUrl(path:string):string {
  if(!path.startsWith('/api/media/')) throw new Error('无效媒体地址');
  // 原生 Filesystem.downloadFile 需要绝对地址；未配置端点时回落到当前来源（WebView 直连或 Vite 代理）。
  const base=readDeviceSettings().apiEndpoint||window.location.origin;
  const token=localStorage.getItem('dance.owner-token');return base+path+(token?'?owner='+encodeURIComponent(token):'');
}
export class ApiError extends Error {status:number;payload:unknown;constructor(message:string,status:number,payload:unknown=null){super(message);this.status=status;this.payload=payload;}}
// 静态页/代理兜底常把 HTML 或空响应当 /api 结果返回；统一换成可理解的连接提示，避免把 HTML、URL 或 token 带进界面。
export const CONNECTION_ERROR_MESSAGE='无法连接本地服务，请检查服务器地址与网络后重试';
function isAbortError(error:unknown):boolean{return error instanceof DOMException?error.name==='AbortError':(error as {name?:unknown}|null)?.name==='AbortError';}
async function readJson(res:Response):Promise<unknown>{
  try { return await res.json(); }
  catch(error) { if(isAbortError(error)) throw error; throw new ApiError(CONNECTION_ERROR_MESSAGE,res.status); }
}
// 老 Android WebView 没有 AbortSignal.timeout，统一用 AbortController+setTimeout 兜底，超时语义仍是 AbortError。
const REQUEST_TIMEOUT_MS=15000;
export async function api<T>(path:string,options:RequestInit={}):Promise<T>{
  if(!path.startsWith('/api/')) throw new Error('无效接口');
  // 调用方给了 signal 就原样下发（由调用方负责取消与时限）；否则用本模块的 15 秒兜底。
  const timed=options.signal?null:createTimedSignal(REQUEST_TIMEOUT_MS);
  const signal=timed?timed.signal:(options.signal??undefined);
  let res:Response;
  try {
    res=await fetch((readDeviceSettings().apiEndpoint||'')+path,{...options,headers:{...Object.fromEntries(new Headers(options.headers)),...(localStorage.getItem('dance.owner-token')?{Authorization:'Bearer '+localStorage.getItem('dance.owner-token')}:{})},signal});
  } catch(error) {
    // 断网/服务未启动时 fetch 抛的是浏览器原文（如 “Failed to fetch”），统一换成中文连接提示，避免英文原文露到界面。
    if(isAbortError(error)) throw error;
    throw new ApiError(CONNECTION_ERROR_MESSAGE,0);
  } finally { timed?.release(); }
  const value=await readJson(res);
  if(!res.ok)throw new ApiError((value as {error?:{message?:string}}|null)?.error?.message||'操作未完成，请重试',res.status,value);
  return value as T;
}
/** 大文件上传等长耗时请求：用调用方指定时限，而不是 api 默认的 15 秒。 */
export async function apiWithTimeout<T>(path:string,options:RequestInit={},timeoutMs:number):Promise<T>{
  const timed=createTimedSignal(timeoutMs);
  try { return await api<T>(path,{...options,signal:timed.signal}); } finally { timed.release(); }
}
export const jsonBody=(value:unknown):RequestInit=>({headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
