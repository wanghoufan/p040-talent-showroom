import { Link } from 'react-router-dom';
import { mediaUrl } from '../lib/api';
import type { DanceItem } from '../lib/types';
export default function DanceCard({item,onPlay,isCurrent,paused}:{item:DanceItem;onPlay:(item:DanceItem)=>void;isCurrent?:boolean;paused?:boolean}){
  const seconds=Math.round(item.durationMs/1000);
  const showPause=Boolean(isCurrent&&!paused);
  return <article className={`dance-card${isCurrent?' dance-card--active':''}`}><Link className="dance-card__body" to={`/dances/${item.id}`} aria-label={`查看 ${item.title}`}><div className="dance-card__cover">{item.cover?<img src={mediaUrl(item.cover.url)} alt="" loading="lazy"/>:<span aria-hidden="true">♪</span>}<span className="duration">{Math.floor(seconds/60)}:{String(seconds%60).padStart(2,'0')}</span></div><h2>{item.title}</h2><p>{item.artist}</p></Link><button className={`quick-play${showPause?' quick-play--active':''}`} aria-label={`${showPause?'暂停':'播放'} ${item.title}`} aria-pressed={showPause} onClick={()=>onPlay(item)}>{showPause?'⏸':'▶'}</button></article>;
}
