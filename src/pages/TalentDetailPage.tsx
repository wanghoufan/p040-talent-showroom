import {queueFile} from '../lib/offline-files';
import {editLocally} from '../lib/offline-editing';
import ScoreAttachments from '../components/ScoreAttachments';
import ScrollingText from '../components/ScrollingText';
import { playableTalent } from '../lib/repertoire-store';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, jsonBody } from '../lib/api';
import { cacheRepertoire, rememberRepertoire, storedRepertoire, talentLabel, talentStatuses, useRepertoire } from '../lib/repertoire-store';
import { playbackSource } from '../native/filesystem';
import { readCachedIndex } from '../lib/offline-manifest';
import type { ImportJob, TalentItem, TalentKind } from '../lib/types';
import TalentEditor, { type TalentFields } from '../components/TalentEditor';
import CoverArt from '../components/CoverArt';
export default function TalentDetailPage() {
 const { id, kind: pathKind } = useParams(); const navigate = useNavigate(); const { items, error: catalogError, loaded } = useRepertoire();
 const item = items.find(x => x.id === id); const creating = !id; const kind: TalentKind = item?.kind || (pathKind === 'guitar' ? 'GUITAR' : 'VOCAL'); const listPath = `/repertoire/${kind === 'GUITAR' ? 'guitar' : 'vocal'}`;
 const [editing, setEditing] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false), [paused, setPaused] = useState(true), [loop, setLoop] = useState(false), [rate, setRate] = useState('1'), [confirm, setConfirm] = useState(false);
 const audio = useRef<HTMLAudioElement>(null), file = useRef<HTMLInputElement>(null), cancel = useRef<AbortController | null>(null);
 const pendingKey = `dance.repertoire-import.${id}`;
 const [pending, setPending] = useState(() => id ? localStorage.getItem(pendingKey) : null);
 useEffect(() => { setPending(id ? localStorage.getItem(`dance.repertoire-import.${id}`) : null); }, [id]);
 useEffect(() => () => cancel.current?.abort(), []);
 useEffect(() => { if (audio.current) { audio.current.playbackRate = Number(rate); audio.current.preservesPitch = true; } }, [rate]);
 const save = async (fields: TalentFields) => {
  const updated=await editLocally({kind,id:id||crypto.randomUUID()},fields as unknown as Record<string,unknown>,creating?'create':'update');
  rememberRepertoire(updated); setEditing(false); if (creating) navigate(`/repertoire/item/${updated.id}`, { replace: true });
 };
 const play = () => {
  const a = audio.current; const playable = item && playableTalent(item); if (!a || !playable) return;
  setError(''); if (!a.paused) { a.pause(); return; }
  if (!a.getAttribute('src')) a.src = playbackSource(playable, readCachedIndex());
  a.playbackRate = Number(rate); a.preservesPitch = true;
  void a.play().catch(() => setError('音乐暂时无法播放，请检查连接或到“我的”下载全部音乐。'));
 };
 const finishImport = async (jobId: string, signal: AbortSignal) => {
  for (let i = 0; i < 180; i++) {
   if (signal.aborted) return;
   const job = await api<ImportJob>(`/api/imports/${jobId}`, { signal });
   if (job.status === 'FAILED') { localStorage.removeItem(pendingKey); setPending(null); throw new Error('文件无法读取'); }
   if (job.status === 'READY') {
    const updated = await api<TalentItem>(`/api/repertoire/${id}/media`, { method: 'POST', signal, ...jsonBody({ importJobId: jobId, audioRole: item?.audioRole || 'REFERENCE' }) });
    rememberRepertoire(updated); localStorage.removeItem(pendingKey); setPending(null); if (audio.current) { audio.current.pause(); audio.current.removeAttribute('src'); } return;
   }
   await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('稍后重试');
 };
 const importMedia = async (source?: File) => {
  if(source){try{await queueFile(source,{kind,id:id!});setError('文件已保存到手机，连接 Mac Mini 后自动处理。');}catch{setError('文件尚未保存，请检查存储空间。');}return;}
  setBusy(true); setError(''); const controller = new AbortController(); cancel.current = controller;
  try {
   const jobId = pending;
   if (jobId) await finishImport(jobId, controller.signal);
  } catch { if (!controller.signal.aborted) setError('音频导入未完成，请检查文件和连接；已有曲目资料保留，可继续导入。'); }
  finally { setBusy(false); cancel.current = null; }
 };
 const remove = async () => { setBusy(true); setError(''); try { await editLocally({kind,id:id!},{},'trash'); cacheRepertoire(storedRepertoire().filter(x => x.id !== id)); navigate(listPath); } catch { setError('删除未完成，请连接 Mac Mini 重试'); } finally { setBusy(false); } };
 if (!creating && !item) return <section><Link className="icon-link" to={listPath}>返回曲库</Link><p role="status">{loaded ? '未找到这首曲目' : '正在读取曲目…'}</p>{catalogError && <p>{catalogError}</p>}</section>;
 return <section><header className="page-header"><Link className="icon-link" aria-label="返回才艺曲库" to={listPath}>‹</Link><h1>{creating ? `收录${talentLabel(kind)}曲目` : `${talentLabel(kind)}详情`}</h1></header>
 {(creating || editing) ? <TalentEditor key={id || kind} kind={kind} item={item} onSave={save} onCancel={() => creating ? navigate(listPath) : setEditing(false)} /> : item && <>
 <CoverArt title={item.title} variant="detail" /><h2 className="detail-title">{item.title}</h2><p className="muted">{item.artist || '未填写歌手'} · {talentStatuses(kind).find(s => s.id === item.learningStatus)?.label}</p>
 <div className="talent-facts"><span>原调 {item.originalKey || '未填写'}</span><span>{kind === 'GUITAR' ? '演奏调' : '演唱调'} {item.performanceKey || '未填写'}</span>{kind === 'GUITAR' && <span>Capo {item.capo}</span>}</div>
 {item.audio ? <div className="settings-block"><p>{item.audioRole === 'ACCOMPANIMENT' ? '伴奏' : '原唱 / 示范'}</p><button className="primary talent-play" onClick={play}>{paused ? '播放音乐' : '暂停音乐'}</button><audio ref={audio} controls loop={loop} onPlay={() => setPaused(false)} onPause={() => setPaused(true)} onEnded={() => setPaused(true)} />
 <div className="button-row"><button aria-pressed={loop} onClick={() => setLoop(!loop)}>{loop ? '循环已开启' : '单曲循环'}</button><label>播放速度<select value={rate} onChange={e => setRate(e.target.value)}>{['0.5','0.75','1','1.25','1.5'].map(x => <option key={x} value={x}>{x}×</option>)}</select></label></div></div> : <p className="notice">这是文本曲目，可直接看谱或歌词；导入自己的音频后可播放。</p>}
 <div className="settings-block"><h2>{kind === 'GUITAR' ? '和弦 / 歌词文本谱' : '歌词'}</h2>{item.scoreText ? <ScrollingText text={item.scoreText}/> : <p className="muted">尚未填写，点“编辑曲目”粘贴文本。</p>}</div>{item.notes && <div className="settings-block"><h2>练习备注</h2><p className="talent-notes">{item.notes}</p></div>}
 <ScoreAttachments itemRef={{kind,id:item.id}} scores={item.scores||[]} onChange={scores=>rememberRepertoire({...item,scores})}/><div className="button-row"><button disabled={busy} onClick={() => setEditing(true)}>编辑曲目</button><button disabled={busy} onClick={() => file.current?.click()}>{item.audio ? '重新导入练习音乐' : '导入音频 / 视频'}</button></div>
 <input type="file" ref={file} accept="audio/*,video/*" hidden onChange={e => { const selected = e.target.files?.[0]; if (selected) void importMedia(selected); e.target.value = ''; }} />
 {pending && !busy && <button onClick={() => void importMedia()}>继续未完成导入</button>}{busy && <p role="status">正在保存或处理音频，请稍候…</p>}
 {item.source?.sourceKind === 'VIDEO' && <Link className="icon-link" to={`/reference/${item.sourceMediaId}`}>查看原视频（需连接 Mac Mini）</Link>}
 <div className="settings-block danger-zone"><button className="danger" disabled={busy} onClick={() => setConfirm(true)}>删除曲目</button></div>
 {confirm && <div className="modal-backdrop"><div className="import-sheet" role="dialog" aria-modal="true" aria-label="删除曲目确认"><h2>删除“{item.title}”？</h2><p>只删除曲目记录，原始媒体与音乐缓存保留。</p><div className="button-row"><button disabled={busy} onClick={() => setConfirm(false)}>取消</button><button className="danger" disabled={busy} onClick={() => void remove()}>确认删除</button></div></div></div>}
 </>}{error && <p role="alert">{error}</p>}{catalogError && !creating && <p className="notice">{catalogError}</p>}</section>;
}
