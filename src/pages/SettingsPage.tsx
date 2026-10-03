import {api,jsonBody} from '../lib/api';
import SyncControls from '../components/SyncControls';
import DemoControls from '../components/DemoControls';
import { Link } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { applyTheme, resolveTheme, systemPrefersDark } from '../app/theme';
import { readDeviceSettings, saveDeviceSettings, validateEndpoint } from '../lib/device-settings';
import { syncLibrary, inspectOfflineLibrary, readSyncReport, clearSyncReport, type SyncProgress } from '../lib/sync';
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
  const [pairCode,setPairCode]=useState('');const [includeScores,setIncludeScores]=useState(true);
  const [settings, setSettings] = useState(readDeviceSettings);
  const [endpoint, setEndpoint] = useState(() => readDeviceSettings().apiEndpoint);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [cache, setCache] = useState({ count: 0, bytes: 0 });
  const [syncMessage, setSyncMessage] = useState('');
  const [overview, setOverview] = useState({ items: 0, readyItems: 0 });
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [report, setReport] = useState(readSyncReport);
  const controller = useRef<AbortController | null>(null);
  const [stopping, setStopping] = useState(false);

  const refreshCache = async () => { setChecking(true); try { setOverview(await inspectOfflineLibrary()); setCache({ count: Object.keys(readCachedIndex()).length, bytes: await offlineBytes() }); } finally { setChecking(false); } };
  useEffect(() => { void refreshCache().catch(() => setSyncMessage('缓存检查未完成，请稍后重试')); return () => controller.current?.abort(); }, []);

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
    setBusy(true); setStopping(false); setProgress(null); setSyncMessage('正在读取曲库…');
    const abort = new AbortController(); controller.current = abort;
    try {
      const result = await syncLibrary(setProgress, { signal: abort.signal,includeScores });
      setReport(result); setSettings(readDeviceSettings()); await refreshCache();
      setSyncMessage(!result.mediaSupported ? `已保存 ${result.items} 首曲库清单；请在手机 App 下载音乐，浏览器不会保存离线音乐。` : result.cancelled ? `已停止下载，已保存的 ${result.readyItems} 首音乐可继续使用。` : result.complete ? `全部完成：${result.readyItems}/${result.items} 首音乐可离线播放。` : `部分完成：${result.readyItems}/${result.items} 首音乐可离线播放，${result.failed.length} 个文件失败，可重试。`);
    } catch { setSyncMessage(abort.signal.aborted ? '下载已停止，已完成的缓存保留。' : '下载未完成，请检查 Mac Mini 连接后重试；已有缓存保留。'); }
    finally { controller.current = null; setBusy(false); setStopping(false); setProgress(null); }
  };
  const stop = () => { setStopping(true); controller.current?.abort(); };
  const clearCache = async () => {
    await clearOfflineMedia();
    saveCachedIndex({} as CachedIndex); clearSyncReport(); setReport(null);
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
        <label>设备配对码<input type="password" value={pairCode} onChange={e=>setPairCode(e.target.value)} autoComplete="off"/></label><button disabled={!pairCode||busy} onClick={()=>void api<{token:string}>('/api/pair',{method:'POST',...jsonBody({code:pairCode})}).then(r=>{localStorage.setItem('dance.owner-token',r.token);setPairCode('');setMessage('设备配对成功');}).catch(()=>setMessage('配对失败，请检查配对码'))}>配对这台设备</button><p className="muted">最近同步：{settings.lastSyncAt ? new Date(settings.lastSyncAt).toLocaleString() : '尚未同步'}</p>
      </div>
      <div className="settings-block">
        <h2>离线音乐</h2>
        <p>{checking ? '正在检查手机缓存…' : '可离线播放：'}{overview.readyItems}/{overview.items} 首</p>
        <p className="muted">下载舞蹈、吉他、唱歌全曲库的音乐、封面和勾选的谱件到手机，拔线、断网也能播放。原视频不包含在此次下载中。</p>
        <p className="muted">已缓存 {cache.count} 个文件，占用 {humanBytes(cache.bytes)}。{isOfflineSupported() ? '' : '当前环境不落盘媒体。'}</p>
        <label className="check-row"><input type="checkbox" checked={includeScores} disabled={busy} onChange={e=>setIncludeScores(e.target.checked)}/>同时下载图片 / PDF 谱</label><div className="button-row">
          <button className="primary" disabled={busy || checking} onClick={() => void sync()}>下载全部音乐到手机</button>
          {!busy && report?.mediaSupported && !report.complete && <button disabled={checking} onClick={() => void sync()}>重试未完成下载</button>}
          {progress && <button disabled={stopping} onClick={stop}>{stopping ? '正在停止…' : '停止下载'}</button>}
          <button disabled={busy || checking || cache.count === 0} onClick={() => void clearCache()}>清空离线缓存</button>
        </div>
        {progress && <div className="download-progress" role="status">
          {progress.stage === 'manifest' ? <p>正在读取曲库…</p> : progress.stage === 'check' ? <p>正在检查手机已有文件…</p> : <>
            <progress aria-label="下载进度" max={Math.max(progress.total, 1)} value={progress.processed} />
            <p>已处理 {progress.processed}/{progress.total} 个文件 · 成功 {progress.downloaded} · 失败 {progress.failed}</p>
            <p className="muted">本次需下载约 {humanBytes(progress.pendingBytes)}{progress.currentTitle ? ` · ${progress.currentTitle}` : ''}</p>
          </>}
          {stopping && <p>当前文件结束后停止，已下载的音乐会保留。</p>}
        </div>}
        {syncMessage && !progress && <p role="status">{syncMessage}</p>}
        {!busy && report && <div className="download-result">
          {!syncMessage && <p>{report.mediaSupported ? `上次下载：${report.complete ? '全部完成' : report.cancelled ? '已停止' : '部分完成'}` : '上次仅保存了曲库清单，音乐未下载'}</p>}
          {report.failed.length > 0 && <details><summary>失败文件 {report.failed.length} 个（点击查看）</summary><ul>{report.failed.map(file => <li key={file.key}>{file.title} · {file.kind === 'audio' ? '音乐' : file.kind==='score'?'谱件':'封面'}</li>)}</ul></details>}
        </div>}
      </div>
      <SyncControls/><DemoControls onChanged={refreshCache}/><div className="settings-block"><h2>曲目管理</h2><Link className="icon-link" to="/settings/requests">扫码点歌 →</Link><Link className="icon-link" to="/settings/trash">回收站 →</Link></div><div className="settings-block"><h2>舞蹈曲库</h2><p className="muted">收录舞蹈 · 学习 · 演出</p><p className="muted">V2 · 舞蹈 / 吉他 / 唱歌</p></div>
    </section>
  );
}
