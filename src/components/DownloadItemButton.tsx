import { useEffect, useState } from 'react';
import { planMedia, syncLibrary } from '../lib/sync';
import type { DanceItem, TalentItem } from '../lib/types';

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 单曲按需下载：体积先算再显示，已全部落盘时显示「已离线」并禁用。
 * 复用 syncLibrary 的 hash/size/version 校验，已缓存的文件不会被重下。
 */
export default function DownloadItemButton({ item, className = 'icon-link' }: { item: DanceItem | TalentItem; className?: string }) {
  const [plan, setPlan] = useState(() => planMedia([item]));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    setPlan(planMedia([item]));
    const refresh = () => setPlan(planMedia([item]));
    window.addEventListener('dance-catalog-changed', refresh);
    return () => window.removeEventListener('dance-catalog-changed', refresh);
  }, [item]);
  if (plan.entries === 0) return null;
  const download = async () => {
    setBusy(true); setMessage('');
    try {
      const result = await syncLibrary(undefined, { onlyIds: [item.id], includeScores: true });
      setPlan(planMedia([item]));
      setMessage(!result.mediaSupported ? '请在手机 App 内下载，浏览器不会保存离线音乐。' : result.complete ? '已下载到手机，断网也能播放。' : `还有 ${result.failed.length} 个文件未完成，可再点一次重试。`);
    } catch { setMessage('下载未完成，请检查 Mac Mini 连接后重试。'); }
    finally { setBusy(false); }
  };
  return <>
    <button className={className} disabled={busy || plan.ready} onClick={() => void download()} aria-label={plan.ready ? `${item.title} 已离线` : `下载这首歌：${item.title}`}>
      {plan.ready ? '已离线' : busy ? '正在下载…' : `下载这首歌 · ${humanBytes(plan.bytes)}`}
    </button>
    {message && <span className="muted" role="status">{message}</span>}
  </>;
}
