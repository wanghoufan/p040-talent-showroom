import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, jsonBody, mediaUrl } from '../lib/api';
import { catalogChanged, storedCatalog } from '../lib/catalog-store';
import { STATUS_OPTIONS, SCENE_OPTIONS } from '../lib/filters';
import type { DanceItem } from '../lib/types';
import ClipTrimmer from '../components/ClipTrimmer';

export default function DanceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [item, setItem] = useState<DanceItem | null>(() => storedCatalog().find((i) => i.id === id) || null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [playing, setPlaying] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void api<DanceItem>(`/api/dances/${id}`).then((data) => { if (active) setItem(data); }).catch(() => { if (active) setError('无法连接服务器，部分操作暂不可用'); });
    return () => { active = false; };
  }, [id]);

  const patch = async (body: unknown) => {
    try { const data = await api<DanceItem>(`/api/dances/${id}`, { method: 'PATCH', ...jsonBody(body) }); setItem(data); catalogChanged(); setError(''); }
    catch { setError('修改未完成，请检查连接'); }
  };
  const uploadCover = async (file: File) => {
    try { const data = await api<DanceItem>(`/api/dances/${id}/cover`, { method: 'POST', headers: { 'Content-Type': file.type || 'image/jpeg' }, body: file }); setItem(data); catalogChanged(); setError(''); }
    catch { setError('封面更新未完成，请使用 JPG / PNG / WEBP 图片'); }
  };
  // 安全删除（T071）：默认仅记录（软删除，不动媒体）；第二档才回收媒体文件，前端二次确认。
  const remove = async (deleteMedia: boolean) => {
    setDeleting(true);
    try { await api(`/api/dances/${id}`, { method: 'DELETE', ...jsonBody({ deleteMedia }) }); catalogChanged(); navigate('/'); }
    catch { setError('删除未完成，请检查连接'); setDeleting(false); setConfirmDelete(false); }
  };

  if (!item) return <p role="status">正在读取舞蹈…{error}</p>;
  return (
    <section>
      <header className="page-header"><Link className="icon-link" to="/" aria-label="返回曲库">‹</Link><h1>舞蹈详情</h1></header>
      <div className="detail-cover">{item.cover ? <img src={mediaUrl(item.cover.url)} alt="" /> : <span>♪</span>}</div>
      <h2 className="detail-title">{item.title}</h2>
      <p className="muted">{item.artist}</p>
      <div className="primary-actions">
        <button className="primary" onClick={() => { if (!audio.current) return; if (playing) audio.current.pause(); else void audio.current.play().catch(() => setError('音乐无法播放，请检查连接')); }}>{playing ? '暂停音乐' : '播放音乐'}</button>
        {item.source?.sourceKind === 'VIDEO' && <Link className="icon-link" to={`/reference/${item.sourceMediaId}`}>查看原视频</Link>}
      </div>
      <audio ref={audio} src={mediaUrl(item.audio.url)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} controls />
      <ClipTrimmer item={item} onUpdated={setItem} />
      <fieldset><legend>学习状态</legend><div className="button-row">{STATUS_OPTIONS.map((o) => <button key={o.id} aria-pressed={item.learningStatus === o.id} onClick={() => void patch({ learningStatus: o.id })}>{o.label}</button>)}</div></fieldset>
      <fieldset><legend>场景标签</legend><div className="button-row">{SCENE_OPTIONS.map((o) => <button key={o.id} aria-pressed={item.sceneTags.includes(o.id)} onClick={() => void patch({ sceneTags: item.sceneTags.includes(o.id) ? item.sceneTags.filter((t) => t !== o.id) : [...item.sceneTags, o.id] })}>{o.label}</button>)}</div></fieldset>
      <div className="button-row">
        <button onClick={() => { setTitle(item.title); setArtist(item.artist); setEditing(true); }}>修改歌曲信息</button>
        <input ref={coverInput} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadCover(f); }} />
        <button onClick={() => coverInput.current?.click()}>修改封面</button>
        <button onClick={() => void patch({ learningStatus: item.learningStatus === 'WANT_TO_LEARN' ? 'PRACTICING' : 'CAN_DANCE' })}>{item.learningStatus === 'WANT_TO_LEARN' ? '开始练' : '我会跳了'}</button>
      </div>
      {editing && <form className="review-form" onSubmit={(e) => { e.preventDefault(); void patch({ title, artist }).then(() => setEditing(false)); }}><label>歌名<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></label><label>歌手<input value={artist} onChange={(e) => setArtist(e.target.value)} maxLength={200} /></label><button className="primary">保存歌曲信息</button></form>}
      <div className="settings-block danger-zone">
        <h2>安全删除</h2>
        <p className="muted">默认仅从曲库移除（保留原始视频与音频文件）。</p>
        {!confirmDelete ? (
          <button className="danger" onClick={() => setConfirmDelete(true)}>删除这支舞</button>
        ) : (
          <div className="button-row">
            <button disabled={deleting} onClick={() => void remove(false)}>仅移除（保留文件）</button>
            <button className="danger" disabled={deleting} onClick={() => void remove(true)}>同时删除本地媒体文件</button>
            <button disabled={deleting} onClick={() => setConfirmDelete(false)}>取消</button>
          </div>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
