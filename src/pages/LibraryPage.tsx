import { useRef,useState } from 'react';
import { useCatalog } from '../lib/catalog-store';
import { filterDances } from '../lib/filters';
import type { DanceItem,LearningStatus,SceneTag } from '../lib/types';
import { readCachedIndex } from '../lib/offline-manifest';
import { playbackSource } from '../native/filesystem';
import SceneTagBar from '../components/SceneTagBar';
import LearningStatusRail from '../components/LearningStatusRail';
import DanceCard from '../components/DanceCard';
import ImportSheet from '../components/ImportSheet';
import PendingShares from '../components/PendingShares';
export default function LibraryPage(){
  const {items,error}=useCatalog();const [status,setStatus]=useState<LearningStatus|null>(null),[scenes,setScenes]=useState<SceneTag[]>([]),[query,setQuery]=useState(''),[importing,setImporting]=useState(false),[playing,setPlaying]=useState<DanceItem|null>(null),[paused,setPaused]=useState(false),[playError,setPlayError]=useState('');
  const audio=useRef<HTMLAudioElement>(null);
  const filtered=filterDances(items,status,scenes,query);
  const play=(item:DanceItem)=>{const a=audio.current;if(!a)return;setPlayError('');if(playing?.id===item.id){if(a.paused){void a.play().then(()=>setPaused(false)).catch(()=>setPlayError('音乐无法播放，请检查连接或离线缓存'));}else{a.pause();setPaused(true);}return;}setPlaying(item);setPaused(false);a.src=playbackSource(item,readCachedIndex());void a.play().then(()=>setPaused(false)).catch(()=>setPlayError('音乐无法播放，请检查连接或离线缓存'));};
  return <section><header className="page-header"><h1>我的舞蹈曲库</h1><button aria-label="收录舞蹈" onClick={()=>setImporting(true)}>＋</button></header><PendingShares/><input className="search" type="search" aria-label="搜索舞蹈" placeholder="搜索歌名或歌手" value={query} onChange={e=>setQuery(e.target.value)}/><SceneTagBar value={scenes} onChange={setScenes}/>{error&&<p className="notice">{error}</p>}<div className="library-layout"><LearningStatusRail items={items} value={status} onChange={setStatus}/><div>{filtered.length?<div className="card-grid">{filtered.map(item=><DanceCard key={item.id} item={item} onPlay={play} isCurrent={playing?.id===item.id} paused={paused}/>)}</div>:<div className="empty-library"><div className="shell__badge" aria-hidden="true">♪</div><h2>{items.length?'没有符合筛选的舞蹈':'还没有收录舞蹈'}</h2><p>把你想学的舞蹈片段收进来，以后不用到处找。</p><button className="primary" onClick={()=>{if(items.length){setStatus(null);setScenes([]);setQuery('');}else setImporting(true);}}>{items.length?'清除筛选':'＋ 收录舞蹈'}</button></div>}</div></div><div className="mini-player" hidden={!playing}><span className="mini-player__title">{playing?.title}</span><audio ref={audio} controls onPlay={()=>setPaused(false)} onPause={()=>setPaused(true)} onEnded={()=>{setPlaying(null);setPaused(false);}}/>{playError&&<p role="alert">{playError}</p>}</div>{importing&&<ImportSheet onClose={()=>setImporting(false)}/>}</section>;
}
