import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  listPendingShares,
  removePendingShare,
  subscribePendingShares,
  submitShare,
} from '../lib/pending-shares';
import type { PendingShare } from '../lib/types';

/**
 * 分享队列三状态 UI（T056）。
 * online processing（提交中/已排队）/ offline saved（离线已保存）/
 * adapter needs local video（需要补充本地视频）。
 */

const STATE_LABEL: Record<string, string> = {
  PENDING: '等待提交',
  SUBMITTED: '已提交，正在收录',
  OFFLINE_SAVED: '离线已保存，联网后自动重试',
  NEEDS_INPUT: '需要补充本地视频',
};

export default function PendingShares() {
  const navigate = useNavigate();
  const [items, setItems] = useState<PendingShare[]>(() => listPendingShares());
  const [busy, setBusy] = useState<string>('');

  useEffect(() => {
    const refresh = () => setItems(listPendingShares());
    refresh();
    window.addEventListener('online', refresh);
    const unsubscribe = subscribePendingShares(refresh);
    return () => {
      window.removeEventListener('online', refresh);
      unsubscribe();
    };
  }, []);

  if (items.length === 0) return null;

  const retry = async (id: string) => {
    setBusy(id);
    await submitShare(id);
    setItems(listPendingShares());
    setBusy('');
  };

  return (
    <section className="pending-shares" aria-label="来自分享的收录">
      <header className="pending-shares__head">
        <h2>来自分享</h2>
        <span className="muted">{items.length} 条</span>
      </header>
      <ul className="pending-shares__list">
        {items.map((item) => (
          <li key={item.id} className={`pending-share pending-share--${item.submitState.toLowerCase()}`}>
            <div className="pending-share__body">
              <p className="pending-share__title">{item.normalizedUrl || item.sharedText || '分享的视频'}</p>
              <p className="pending-share__state" role="status">{STATE_LABEL[item.submitState] || item.submitState}</p>
              {item.lastError && item.submitState !== 'SUBMITTED' && <p className="pending-share__error">{item.lastError}</p>}
            </div>
            <div className="pending-share__actions">
              {item.submitState === 'SUBMITTED' && item.serverJobId && (
                <button className="primary" onClick={() => navigate(`/imports/${item.serverJobId}`)}>查看</button>
              )}
              {item.submitState === 'NEEDS_INPUT' && item.serverJobId && (
                <button className="primary" onClick={() => navigate(`/imports/${item.serverJobId}`)}>补充视频</button>
              )}
              {(item.submitState === 'PENDING' || item.submitState === 'OFFLINE_SAVED') && (
                <button className="primary" disabled={busy === item.id} onClick={() => void retry(item.id)}>
                  {busy === item.id ? '提交中…' : '重试'}
                </button>
              )}
              <button onClick={() => { removePendingShare(item.id); setItems(listPendingShares()); }} aria-label="移除">移除</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
