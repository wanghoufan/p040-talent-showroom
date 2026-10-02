import { Link } from 'react-router-dom';
import { mediaUrl } from '../lib/api';
import type { DanceItem } from '../lib/types';
export default function DanceCard({item,onPlay}:{item:DanceItem;onPlay:(item:DanceItem)=>void}){
  const seconds=Math.round(item.durationMs/1000);
  return <article className="dance-card"><Link className="dance-card__body" to={`/dances/${item.id}`} aria-label={`查看 ${item.title}`}><div className="dance-card__cover">{item.cover?<img src={mediaUrl(item.cover.url)} alt="" loading="lazy"/>:<span aria-hidden="true">♪</span>}<span className="duration">{Math.floor(seconds/60)}:{String(seconds%60).padStart(2,'0')}</span></div><h2>{item.title}</h2><p>{item.artist}</p></Link><button className="quick-play" aria-label={`播放 ${item.title}`} onClick={()=>onPlay(item)}>▶</button></article>;
}
