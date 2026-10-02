import { useEffect, useMemo, useRef, useState } from 'react';
import { mediaUrl } from '../lib/api';
import { readOfflineManifest, readCachedIndex, isItemPlayable } from '../lib/offline-manifest';
import { offlineUrl, isOfflineSupported } from '../native/filesystem';
import { useCatalog } from '../lib/catalog-store';
import { fetchPlaylist } from '../lib/playlist';
import SceneTagBar from '../components/SceneTagBar';
import type { DanceItem, SceneTag } from '../lib/types';

/**
 * 演出模式（T062/T063）。
 * 默认只列「会跳」，四标签 AND；未缓存/损坏的曲目明确不可播。
 * 播放优先用离线文件，缺失时回落网络地址。
 */

function sourceOf(item: DanceItem, playable: boolean): string {
  if (playable && isOfflineSupported()) {
    const hit = readCachedIndex()[item.audio.url];
    if (hit) return offlineUrl(hit.uri);
  }
  return mediaUrl(item.audio.url);
}

export default function PerformancePage() {
  const { items: catalogItems } = useCatalog();
  const [offlineItems, setOfflineItems] = useState<DanceItem[] | null>(() => readOfflineManifest()?.items ?? null);
  const [playlist, setPlaylist] = useState<string[]>(() => readOfflineManifest()?.playlist ?? []);
  const [scenes, setScenes] = useState<SceneTag[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [notice, setNotice] = useState('');
  const audio = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    // 离线优先：先用清单快照渲染；联网时再刷新歌单，不阻塞首屏。
    setOfflineItems(readOfflineManifest()?.items ?? null);
    fetchPlaylist().then((data) => setPlaylist(data.items)).catch(() => undefined);
  }, []);

  const items = useMemo(() => (catalogItems.length ? catalogItems : (offlineItems ?? [])), [catalogItems, offlineItems]);

  const cached = readCachedIndex();
  // 今晚歌单非空时以其顺序为准，否则回落到「会跳」；两者都再叠加四标签 AND。
  const list = useMemo(() => {
    const base = playlist.length
      ? playlist.map((id) => items.find((item) => item.id === id)).filter((x): x is DanceItem => Boolean(x))
      : items.filter((item) => item.learningStatus === 'CAN_DANCE');
    return base.filter((item) => scenes.every((tag) => item.sceneTags.includes(tag)));
  }, [items, playlist, scenes]);
  const current = list[Math.min(index, Math.max(list.length - 1, 0))];
  const playable = current ? isItemPlayable(current, cached) : false;

  useEffect(() => {
    if (index > list.length - 1) setIndex(Math.max(list.length - 1, 0));
  }, [list.length, index]);

  const load = (item: DanceItem, auto: boolean) => {
    if (!audio.current) return;
    if (!isItemPlayable(item, cached)) { setPlaying(false); setNotice('这首歌还没有离线缓存，请先在设置里同步。'); return; }
    setNotice('');
    audio.current.src = sourceOf(item, true);
    if (auto) void audio.current.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };
  // 下一首/上一首只切换选中，不自动发声；必须再次点击播放。
  const select = (next: number) => {
    setIndex(next); setPlaying(false); setNotice('');
    const node = audio.current;
    if (node) { node.pause(); node.removeAttribute('src'); node.load(); }
  };
  const toggle = () => {
    if (!audio.current || !current) return;
    if (playing) { audio.current.pause(); setPlaying(false); return; }
    if (!audio.current.src) load(current, true); else void audio.current.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };
  const restart = () => { if (audio.current) { audio.current.currentTime = 0; void audio.current.play().then(() => setPlaying(true)); } };

  return (
    <section>
      <header className="page-header"><h1>演出模式</h1></header>
      <p className="muted">演出前请在「我的 → 本地缓存」同步离线音乐。</p>
      <SceneTagBar value={scenes} onChange={setScenes} />
      {list.length === 0 ? (
        <div className="empty-library"><h2>没有可演出的舞蹈</h2><p>{playlist.length ? '调整标签筛选，或先在今晚歌单准备好曲目。' : '先在「今晚歌单」挑选曲目，或在曲库把舞蹈标为「会跳」。'}</p></div>
      ) : (
        <>
          <div className="perform-stage">
            <p className="perform-title">{current?.title}</p>
            <p className="muted">{current?.artist}{playable ? '' : ' · 未缓存'}</p>
            <div className="perform-controls">
              <button aria-label="上一首" disabled={index <= 0} onClick={() => select(index - 1)}>⏮</button>
              <button className="primary perform-toggle" aria-label={playing ? '暂停' : '播放'} onClick={toggle}>{playing ? '⏸' : '▶'}</button>
              <button aria-label="从头" onClick={restart}>↺</button>
              <button aria-label="下一首" disabled={index >= list.length - 1} onClick={() => select(index + 1)}>⏭</button>
            </div>
            {notice && <p role="alert" className="notice">{notice}</p>}
            <audio ref={audio} onEnded={() => setPlaying(false)} hidden />
          </div>
          <ol className="perform-list">
            {list.map((item, i) => {
              const ready = isItemPlayable(item, cached);
              return (
                <li key={item.id}>
                  <button className={i === index ? 'perform-list__item perform-list__item--active' : 'perform-list__item'} onClick={() => select(i)}>
                    <span>{item.title}</span><small>{ready ? '已缓存' : '未缓存，不可播'}</small>
                  </button>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
