import BulkActionSheet from '../components/BulkActionSheet';
import { addToProgram,bulkRequest,runBulk } from '../lib/library-management';
import TalentNav from '../components/TalentNav';
import { useRef, useState } from 'react';
import { useCatalog } from '../lib/catalog-store';
import { filterDances } from '../lib/filters';
import type { DanceItem, LearningStatus, SceneTag } from '../lib/types';
import { isItemPlayable, readCachedIndex } from '../lib/offline-manifest';
import { playbackSource } from '../native/filesystem';
import LibraryFilters from '../components/LibraryFilters';

import DanceCard from '../components/DanceCard';
import ImportSheet from '../components/ImportSheet';
import PendingShares from '../components/PendingShares';
import BatchEditSheet, { type ClassificationChange } from '../components/BatchEditSheet';

export default function LibraryPage() {
  const { items, error, applyUpdates } = useCatalog();
  const [status, setStatus] = useState<LearningStatus | null>(null);
  const [scenes, setScenes] = useState<SceneTag[]>([]);
  const [query, setQuery] = useState('');
  const [demoOnly,setDemoOnly]=useState(false),[cachedOnly,setCachedOnly]=useState(false);
  const [importing, setImporting] = useState(false);
  const [playing, setPlaying] = useState<DanceItem | null>(null);
  const [paused, setPaused] = useState(false);
  const [playError, setPlayError] = useState('');
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingIds, setEditingIds] = useState<string[] | null>(null);
  const [message, setMessage] = useState('');
  const [deleting,setDeleting]=useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const filtered = filterDances(items, status, scenes, query).filter(item=>(!demoOnly||item.isDemo)&&(!cachedOnly||isItemPlayable(item,readCachedIndex())));
  const selectedIds = filtered.filter(item => selected.has(item.id)).map(item => item.id);
  const clearSelection = () => setSelected(new Set());
  const toggleBatch = () => {
    if (!batchMode) {
      if (audio.current?.getAttribute('src')) audio.current.pause();
      setPlaying(null); setPaused(false);
    }
    setBatchMode(!batchMode); clearSelection(); setMessage('');
  };
  const select = (item: DanceItem) => setSelected(current => {
    const next = new Set(current);
    if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
    return next;
  });
  const saveBatch = async (change: ClassificationChange) => {
    if (!editingIds?.length) return;
    const result=await runBulk(bulkRequest('update',editingIds.map(id=>({kind:'DANCE',id})),change));
    applyUpdates(result.items as DanceItem[], result.catalogVersion);
    setMessage(`已修改 ${result.items.length} 首舞蹈的分类`);
    setEditingIds(null); clearSelection();
  };
  const play = (item: DanceItem) => {
    const a = audio.current; if (!a) return;
    setPlayError('');
    if (playing?.id === item.id) {
      if (a.paused) void a.play().then(() => setPaused(false)).catch(() => setPlayError('音乐无法播放，请检查连接或离线缓存'));
      else { a.pause(); setPaused(true); }
      return;
    }
    setPlaying(item); setPaused(false); a.src = playbackSource(item, readCachedIndex());
    void a.play().then(() => setPaused(false)).catch(() => setPlayError('音乐无法播放，请检查连接或离线缓存'));
  };
  return <section>
    <header className="library-header"><TalentNav /><div className="page-header__actions"><button className="batch-entry" disabled={!items.length} onClick={toggleBatch}>{batchMode ? '退出批量' : '批量管理'}</button><button aria-label="收录舞蹈" disabled={batchMode} onClick={() => setImporting(true)}>＋</button></div></header>
    <PendingShares />
    <div className="library-search"><input className="search" type="search" aria-label="搜索舞蹈" placeholder="搜索歌名或歌手" value={query} onChange={event => { setQuery(event.target.value); clearSelection(); }} />
    <LibraryFilters kind="DANCE" value={{status,scenes,demoOnly,cachedOnly}} onChange={v=>{setStatus(v.status);setScenes(v.scenes);setDemoOnly(v.demoOnly);setCachedOnly(v.cachedOnly);clearSelection();}} /></div>
    {error && <p className="notice">{error}</p>}
    {message && <p className="notice" role="status">{message}</p>}
    {batchMode && <div className="batch-toolbar"><span>点击卡片选择 · 当前 {filtered.length} 首</span><div className="button-row"><button disabled={!filtered.length} onClick={() => setSelected(new Set(filtered.map(item => item.id)))}>全选当前结果</button><button disabled={!selectedIds.length} onClick={clearSelection}>清空选择</button></div></div>}
    <div className="library-layout"><div>{filtered.length ? <div className="card-grid">{filtered.map(item => <DanceCard key={item.id} item={item} onPlay={play} isCurrent={playing?.id === item.id} paused={paused} selectionMode={batchMode} selected={batchMode && selected.has(item.id)} onSelect={select} />)}</div> : <div className="empty-library"><div className="shell__badge" aria-hidden="true">♪</div><h2>{items.length ? '没有符合筛选的舞蹈' : '还没有收录舞蹈'}</h2><p>把你想学的舞蹈片段收进来，以后不用到处找。</p><button className="primary" onClick={() => { if (items.length) { setStatus(null); setScenes([]); setQuery('');setDemoOnly(false);setCachedOnly(false); clearSelection(); } else setImporting(true); }}>{items.length ? '清除筛选' : '＋ 收录舞蹈'}</button></div>}</div></div>
    {batchMode && <div className="batch-actions"><span aria-live="polite">已选 {selectedIds.length} 首</span><button disabled={!selectedIds.length} onClick={()=>void addToProgram(selectedIds.map(id=>({kind:'DANCE',id}))).then(()=>setMessage('已加入今晚节目单')).catch(()=>setMessage('未能加入，请连接服务器后重试'))}>加入节目单</button><button disabled={!selectedIds.length} onClick={()=>setDeleting(true)}>删除</button><button className="primary" disabled={!selectedIds.length} onClick={() => setEditingIds(selectedIds)}>修改分类（{selectedIds.length}首）</button></div>}
    <div className="mini-player" hidden={!playing}><span className="mini-player__title">{playing?.title}</span><audio ref={audio} controls onPlay={() => setPaused(false)} onPause={() => setPaused(true)} onEnded={() => { setPlaying(null); setPaused(false); }} />{playError && <p role="alert">{playError}</p>}</div>
    {deleting&&<BulkActionSheet action="trash" items={items.filter(i=>selectedIds.includes(i.id)).map(i=>({...i,kind:'DANCE' as const}))} onClose={()=>setDeleting(false)} onDone={()=>{setDeleting(false);clearSelection();setMessage('已移入回收站');}}/>}
    {editingIds && <BatchEditSheet count={editingIds.length} onClose={() => setEditingIds(null)} onSave={saveBatch} />}
    {importing && <ImportSheet onClose={() => setImporting(false)} />}
  </section>;
}
