import { useEffect, useMemo, useRef, useState } from 'react';
import { useCatalog } from '../lib/catalog-store';
import { fetchPlaylist, savePlaylist, moveItem } from '../lib/playlist';
import { prepareOffline } from '../lib/sync';
import { readCachedIndex, isItemPlayable } from '../lib/offline-manifest';
import type { DanceItem } from '../lib/types';

/**
 * 今晚歌单（T075/T076）。
 * 增删、拖动/上下移动排序并持久化；「准备离线演出」逐条下载校验，全部通过才 Ready。
 */
export default function TonightPlaylistPage() {
  const { items: catalog } = useCatalog();
  const [ids, setIds] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<boolean | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const byId = useMemo(() => new Map(catalog.map((item) => [item.id, item])), [catalog]);
  const playlistItems = useMemo(() => ids.map((id) => byId.get(id)).filter((x): x is DanceItem => Boolean(x)), [ids, byId]);
  const cached = readCachedIndex();

  useEffect(() => {
    fetchPlaylist().then((data) => setIds(data.items)).catch(() => setStatus('无法读取歌单，请确认已连接本地服务器'));
  }, []);

  const persist = (next: string[]) => {
    setIds(next);
    setReady(null);
    savePlaylist(next).catch(() => setStatus('保存失败，请重试'));
  };
  const add = (id: string) => { if (!ids.includes(id)) persist([...ids, id]); };
  const remove = (id: string) => persist(ids.filter((x) => x !== id));
  const clearAll = () => { if (window.confirm('清空今晚歌单？')) persist([]); };

  const prepare = async () => {
    if (!playlistItems.length) return;
    setBusy(true); setStatus('正在准备离线演出…');
    try {
      const result = await prepareOffline(playlistItems, (done, total) => setStatus(`正在缓存 ${done}/${total}`));
      setReady(result.ready);
      setStatus(result.ready ? `已准备好，${playlistItems.length} 首均可离线播放` : '未准备好：仍有条目缺失或损坏');
    } catch { setStatus('准备失败，请确认已连接本地服务器'); } finally { setBusy(false); }
  };

  // 指针拖动排序：按落点所在行重排（触摸与鼠标通用）。
  const onPointerMove = (event: React.PointerEvent) => {
    if (dragFrom == null || !listRef.current) return;
    const rows = [...listRef.current.querySelectorAll<HTMLElement>('[data-row]')];
    const target = rows.findIndex((row) => { const r = row.getBoundingClientRect(); return event.clientY >= r.top && event.clientY <= r.bottom; });
    if (target >= 0 && target !== dragFrom) { const next = moveItem(ids, dragFrom, target); setIds(next); setDragFrom(target); }
  };
  const onPointerUp = () => { if (dragFrom != null) { setDragFrom(null); setReady(null); savePlaylist(ids).catch(() => setStatus('保存失败，请重试')); } };

  const notInList = catalog.filter((item) => !ids.includes(item.id));

  return (
    <section onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <header className="page-header"><h1>今晚歌单</h1>{ids.length > 0 && <button onClick={clearAll}>清空</button>}</header>
      {ids.length === 0 ? (
        <div className="empty-library"><h2>今晚歌单还是空的</h2><p>从下面挑选今晚可能跳的舞，排好顺序。</p></div>
      ) : (
        <>
          <div className="playlist-ready">
            <button className="primary" disabled={busy} onClick={() => void prepare()}>{busy ? '准备中…' : '准备离线演出'}</button>
            {ready !== null && <span className={ready ? 'ready-ok' : 'ready-bad'}>{ready ? '已准备好' : '未准备好'}</span>}
          </div>
          <ol className="playlist" ref={listRef}>
            {playlistItems.map((item, index) => {
              const ok = isItemPlayable(item, cached);
              return (
                <li key={item.id} data-row={index} className={dragFrom === index ? 'playlist__row playlist__row--dragging' : 'playlist__row'}>
                  <button className="playlist__handle" aria-label="拖动排序" onPointerDown={() => setDragFrom(index)}>☰</button>
                  <span className="playlist__title">{item.title}<small>{ok ? '已缓存' : '未缓存，不可播'}</small></span>
                  <span className="playlist__move">
                    <button aria-label="上移" disabled={index === 0} onClick={() => persist(moveItem(ids, index, index - 1))}>↑</button>
                    <button aria-label="下移" disabled={index === ids.length - 1} onClick={() => persist(moveItem(ids, index, index + 1))}>↓</button>
                    <button aria-label="移出歌单" onClick={() => remove(item.id)}>✕</button>
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      )}
      {status && <p role="status" className="notice">{status}</p>}
      <div className="playlist-add">
        <h2>加入歌单</h2>
        {notInList.length === 0 ? <p className="muted">曲库里的舞蹈都已加入。</p> : (
          <ul className="playlist-add__list">
            {notInList.map((item) => <li key={item.id}><button onClick={() => add(item.id)}>＋ {item.title}</button></li>)}
          </ul>
        )}
      </div>
    </section>
  );
}
