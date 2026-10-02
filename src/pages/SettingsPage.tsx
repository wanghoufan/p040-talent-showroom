import { useEffect, useState } from 'react';
import { applyTheme, resolveTheme, systemPrefersDark } from '../app/theme';
import { readDeviceSettings, saveDeviceSettings, validateEndpoint } from '../lib/device-settings';
import { syncLibrary } from '../lib/sync';
import { offlineBytes, clearOfflineMedia, isOfflineSupported } from '../native/filesystem';
import { applySystemBars } from '../native/theme-bars';
import { readCachedIndex, saveCachedIndex, type CachedIndex } from '../lib/offline-manifest';
import type { DeviceSettings } from '../lib/types';

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState(readDeviceSettings);
  const [endpoint, setEndpoint] = useState(() => readDeviceSettings().apiEndpoint);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [cache, setCache] = useState({ count: 0, bytes: 0 });
  const [syncMessage, setSyncMessage] = useState('');

  const refreshCache = async () => setCache({ count: Object.keys(readCachedIndex()).length, bytes: await offlineBytes() });
  useEffect(() => { void refreshCache(); }, []);

  const theme = (themeMode: DeviceSettings['themeMode']) => { const next = { ...settings, themeMode }; saveDeviceSettings(next); setSettings(next); const resolved = resolveTheme(themeMode, systemPrefersDark()); applyTheme(resolved, document.documentElement); void applySystemBars(resolved === 'dark'); };
  const connect = async () => {
    setBusy(true); setMessage('');
    try {
      const address = validateEndpoint(endpoint, import.meta.env.DEV);
      const response = await fetch(address + '/api/health', { signal: AbortSignal.timeout(5000) });
      const data = await response.json();
      if (!response.ok || data.ok !== true) throw new Error();
      const next = { ...settings, apiEndpoint: address }; saveDeviceSettings(next); setSettings(next);
      setMessage('连接成功，服务器地址已保存');
    } catch { setMessage('连接失败，请检查本地地址、网络和服务器状态'); } finally { setBusy(false); }
  };
  const sync = async () => {
    setBusy(true); setSyncMessage('正在同步离线曲库…');
    try {
      const result = await syncLibrary((done, total) => setSyncMessage(`正在缓存 ${done}/${total}`));
      await refreshCache();
      setSyncMessage(result.mediaSupported ? `已同步 ${result.items} 首，新缓存 ${result.downloaded} 个文件` : `已保存曲库清单 ${result.items} 首（浏览器不缓存媒体文件）`);
    } catch { setSyncMessage('同步失败，请确认已连接本地服务器'); } finally { setBusy(false); }
  };
  const clearCache = async () => {
    await clearOfflineMedia();
    saveCachedIndex({} as CachedIndex);
    await refreshCache();
    setSyncMessage('离线缓存已清空');
  };

  return (
    <section>
      <header className="page-header"><h1>我的</h1></header>
      <div className="settings-block"><h2>主题</h2><div className="button-row">{([{ id: 'system', label: '跟随系统' }, { id: 'light', label: '浅色' }, { id: 'dark', label: '深色' }] as const).map((o) => <button key={o.id} aria-pressed={settings.themeMode === o.id} onClick={() => theme(o.id)}>{o.label}</button>)}</div></div>
      <div className="settings-block">
        <h2>Mac Mini 连接</h2>
        <label>本地服务地址<input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="http://192.168.31.10:8791" inputMode="url" /></label>
        <button className="primary" disabled={busy || !endpoint.trim()} onClick={() => void connect()}>{busy ? '正在检测…' : '连接测试并保存'}</button>
        {message && <p role="status">{message}</p>}
        <p className="muted">最近同步：{settings.lastSyncAt ? new Date(settings.lastSyncAt).toLocaleString() : '尚未同步'}</p>
      </div>
      <div className="settings-block">
        <h2>本地缓存</h2>
        <p className="muted">已缓存 {cache.count} 个文件，占用 {humanBytes(cache.bytes)}。{isOfflineSupported() ? '' : '当前环境不落盘媒体。'}</p>
        <div className="button-row">
          <button className="primary" disabled={busy} onClick={() => void sync()}>同步离线曲库</button>
          <button disabled={busy || cache.count === 0} onClick={() => void clearCache()}>清空离线缓存</button>
        </div>
        {syncMessage && <p role="status">{syncMessage}</p>}
      </div>
      <div className="settings-block"><h2>舞蹈曲库</h2><p className="muted">收录舞蹈 · 学习 · 演出</p><p className="muted">V1.5</p></div>
    </section>
  );
}
