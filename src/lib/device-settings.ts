import type { DeviceSettings } from './types';
import { isThemeMode, THEME_STORAGE_KEY } from '../app/theme';
const KEY='dance.device-settings';
const defaults:DeviceSettings={themeMode:'system',apiEndpoint:'',cachePolicyVersion:1};
export function validateEndpoint(input:string,allowLoopback=false):string {
  const url=new URL(input.trim());
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash) throw new Error('请输入本地服务器地址');
  const host=url.hostname.toLowerCase();
  const parts=host.split('.').map(Number);
  const ipv4=parts.length===4 && parts.every(x=>Number.isInteger(x)&&x>=0&&x<=255);
  const privateHost=ipv4&&(parts[0]===10||(parts[0]===192&&parts[1]===168)||(parts[0]===172&&parts[1]>=16&&parts[1]<=31));
  const localName=host.endsWith('.local')&&host.length>6;
  const loopback=host==='localhost'||host==='127.0.0.1'||host==='[::1]';
  if(!privateHost&&!localName&&!(allowLoopback&&loopback)) throw new Error('仅支持可信本地或私有网络地址');
  return url.origin;
}
export function readDeviceSettings():DeviceSettings {
  try {
    const raw=JSON.parse(localStorage.getItem(KEY)||'null') as Partial<DeviceSettings>|null;
    if(!raw||!isThemeMode(raw.themeMode)) return {...defaults};
    const apiEndpoint=raw.apiEndpoint?validateEndpoint(raw.apiEndpoint,import.meta.env.DEV):'';
    return {...defaults,themeMode:raw.themeMode,apiEndpoint,lastSyncAt:typeof raw.lastSyncAt==='string'?raw.lastSyncAt:undefined};
  } catch { return {...defaults}; }
}
export function saveDeviceSettings(settings:DeviceSettings):void {
  if(!isThemeMode(settings.themeMode)) throw new Error('无效主题');
  const apiEndpoint=settings.apiEndpoint?validateEndpoint(settings.apiEndpoint,import.meta.env.DEV):'';
  localStorage.setItem(KEY,JSON.stringify({...settings,apiEndpoint}));
  localStorage.setItem(THEME_STORAGE_KEY,settings.themeMode);
  window.dispatchEvent(new Event('dance-settings-changed'));
}
