import { Link } from 'react-router-dom';
import { STATUS_OPTIONS, SCENE_OPTIONS } from '../lib/filters';
import type { DanceItem } from '../lib/types';
import CoverArt from './CoverArt';
export default function DanceCard({ item, onPlay, isCurrent, paused, selectionMode, selected, onSelect }: {
  item: DanceItem; onPlay: (item: DanceItem) => void; isCurrent?: boolean; paused?: boolean;
  selectionMode?: boolean; selected?: boolean; onSelect?: (item: DanceItem) => void;
}) {
  const seconds = Math.round(item.durationMs / 1000);
  const showPause = Boolean(isCurrent && !paused);
  const content = <><div className="dance-card__cover"><CoverArt title={item.title} /><span className="duration">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>{selectionMode && <span className="selection-badge" aria-hidden="true">{selected ? '✓' : ''}</span>}</div><h2>{item.title}</h2><p>{item.artist}</p><div className="dance-card__labels"><span>{STATUS_OPTIONS.find(option => option.id === item.learningStatus)?.label}</span>{item.sceneTags.map(tag => <span key={tag}>{SCENE_OPTIONS.find(option => option.id === tag)?.label}</span>)}</div></>;
  return <article className={`dance-card${isCurrent ? ' dance-card--active' : ''}${selected ? ' dance-card--selected' : ''}`}>
    {selectionMode ? <button className="dance-card__body dance-card__select" aria-label={`${selected ? '取消选择' : '选择'} ${item.title}`} aria-pressed={Boolean(selected)} onClick={() => onSelect?.(item)}>{content}</button> : <Link className="dance-card__body" to={`/dances/${item.id}`} aria-label={`查看 ${item.title}`}>{content}</Link>}
    {!selectionMode && <button className={`quick-play${showPause ? ' quick-play--active' : ''}`} aria-label={`${showPause ? '暂停' : '播放'} ${item.title}`} aria-pressed={showPause} onClick={() => onPlay(item)}>{showPause ? '⏸' : '▶'}</button>}
  </article>;
}
