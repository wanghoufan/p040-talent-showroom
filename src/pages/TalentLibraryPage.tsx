import { playableTalent } from '../lib/repertoire-store';
import { playbackSource } from '../native/filesystem';
import { readCachedIndex } from '../lib/offline-manifest';
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useRepertoire, talentLabel, talentStatuses } from '../lib/repertoire-store';
import TalentNav from '../components/TalentNav';
import CoverArt from '../components/CoverArt';
import type { LearningStatus } from '../lib/types';
export default function TalentLibraryPage() {
 const { kind: pathKind } = useParams(); const kind = pathKind === 'guitar' ? 'GUITAR' : 'VOCAL';
 const { items, error } = useRepertoire(); const [query, setQuery] = useState(''), [status, setStatus] = useState<LearningStatus | ''>('');
 const audio = useRef<HTMLAudioElement>(null); const [playing, setPlaying] = useState(''), [paused, setPaused] = useState(true), [playError, setPlayError] = useState('');
 const play = (item: typeof items[number]) => { const source = playableTalent(item), a = audio.current; if (!source || !a) return; setPlayError(''); if (playing === item.id && !a.paused) { a.pause(); return; } a.src = playbackSource(source, readCachedIndex()); setPlaying(item.id); void a.play().catch(() => setPlayError('请检查连接或到“我的”下载全部音乐')); };
 const filtered = items.filter(item => item.kind === kind && (!status || item.learningStatus === status) && `${item.title} ${item.artist}`.toLowerCase().includes(query.toLowerCase().trim()));
 return <section><header className="page-header"><h1>我的{talentLabel(kind)}曲库</h1><Link className="icon-link" aria-label={`收录${talentLabel(kind)}曲目`} to={`/repertoire/${kind === 'GUITAR' ? 'guitar' : 'vocal'}/new`}>＋</Link></header><TalentNav />
 <input className="search" type="search" aria-label="搜索曲目" placeholder="搜索歌名或歌手" value={query} onChange={e => setQuery(e.target.value)} />
 <div className="button-row talent-status"><button aria-pressed={!status} onClick={() => setStatus('')}>全部</button>{talentStatuses(kind).map(s => <button key={s.id} aria-pressed={status === s.id} onClick={() => setStatus(status === s.id ? '' : s.id)}>{s.label}</button>)}</div>
 {error && <p className="notice">{error}</p>}
 {filtered.length ? <div className="card-grid talent-grid">{filtered.map(item => <article className={`dance-card${playing === item.id ? ' dance-card--active' : ''}`} key={item.id}><Link className="dance-card__body" to={`/repertoire/item/${item.id}`} aria-label={`查看 ${item.title}`}><div className="dance-card__cover"><CoverArt title={item.title} /></div><h2>{item.title}</h2><p>{item.artist || '未填写歌手'}</p><div className="dance-card__labels"><span>{talentStatuses(kind).find(s => s.id === item.learningStatus)?.label}</span>{item.performanceKey && <span>{item.performanceKey}调</span>}{kind === 'GUITAR' && <span>Capo {item.capo}</span>}<span>{item.audio ? '有练习音乐' : '文本曲目'}</span></div></Link>{item.audio && <button className="icon-link" onClick={() => play(item)} aria-label={`${playing === item.id && !paused ? '暂停' : '播放'} ${item.title}`}>{playing === item.id && !paused ? '⏸ 暂停' : '▶ 播放'}</button>}</article>)}</div> : <div className="empty-library"><h2>{query || status ? '没有符合筛选的曲目' : `还没有${talentLabel(kind)}曲目`}</h2><p>可以先保存文本谱或歌词，再添加自己的练习音频。</p><Link className="icon-link primary" to={`/repertoire/${kind === 'GUITAR' ? 'guitar' : 'vocal'}/new`}>＋ 收录曲目</Link></div>}
 <div className="mini-player" hidden={!playing}><span>{items.find(item => item.id === playing)?.title}</span><audio ref={audio} controls onPlay={() => setPaused(false)} onPause={() => setPaused(true)} onEnded={() => { setPaused(true); setPlaying(''); }} />{playError && <p role="alert">{playError}</p>}</div></section>;
}
