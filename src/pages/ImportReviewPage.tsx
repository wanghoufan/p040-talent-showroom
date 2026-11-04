import { useEffect,useRef,useState } from 'react';
import { Link,useNavigate,useParams } from 'react-router-dom';
import { api,jsonBody,mediaUrl,ApiError } from '../lib/api';
import { forgetImport } from '../lib/pending-imports';
import { removeShareByJob,updateShareByJob } from '../lib/pending-shares';
import { catalogChanged } from '../lib/catalog-store';
import { STATUS_OPTIONS,SCENE_OPTIONS } from '../lib/filters';
import type { DanceItem,ImportJob,LearningStatus,SceneTag } from '../lib/types';
import ImportProgress from '../components/ImportProgress';
import CoverArt from '../components/CoverArt';

/**
 * 收录确认页（T034）。
 * - 识别为 disabled/低置信度时提供多候选选择/忽略/手填（T085），原音频始终不变；
 * - NEEDS_INPUT 时补充本地视频走 supplement，保留原分享链接（不丢链接）。
 */
export default function ImportReviewPage(){
  const {id}=useParams(); const jobId=id??''; const navigate=useNavigate();
  const [job,setJob]=useState<ImportJob|null>(null),[error,setError]=useState('');
  const [title,setTitle]=useState(''),[artist,setArtist]=useState('');
  const [status,setStatus]=useState<LearningStatus>('WANT_TO_LEARN'),[scenes,setScenes]=useState<SceneTag[]>([]);
  const [busy,setBusy]=useState(false);
  const supplementInput=useRef<HTMLInputElement>(null);

  useEffect(()=>{
    let active=true; let timer:ReturnType<typeof setTimeout>; let initialized=false;
    const poll=async()=>{
      try{
        const next=await api<ImportJob>(`/api/imports/${id}`);
        if(!active) return;
        setJob(next);
        if(next.status==='FAILED') forgetImport(jobId);
        if(next.status==='READY'&&!initialized){ setTitle(next.draft?.title||'未识别舞蹈'); setArtist(next.draft?.artist||''); initialized=true; }
        if(['PENDING','PROCESSING'].includes(next.status)) timer=setTimeout(()=>void poll(),400);
      }catch(error){
        if(!active) return;
        // 服务器已没有这条任务（重启换库/被清理）：留在“未完成收录”里只会点了继续也打不开，直接移除并说明。
        if(error instanceof ApiError&&error.status===404){forgetImport(jobId);setError('这条收录已不存在，请重新导入');return;}
        setError('暂时无法读取收录进度，请检查连接');
      }
    };
    void poll();
    return ()=>{ active=false; clearTimeout(timer); };
  },[id]);

  const save=async()=>{
    setBusy(true); setError('');
    try{ const item=await api<DanceItem>(`/api/imports/${id}/finalize`,{method:'POST',...jsonBody({title,artist,learningStatus:status,sceneTags:scenes})}); forgetImport(jobId); removeShareByJob(jobId); catalogChanged(); navigate(`/dances/${item.id}`,{replace:true}); }
    catch{ setError('保存未完成，请重试'); setBusy(false); }
  };
  const supplement=async(file:File)=>{
    setBusy(true); setError('');
    try{ await api<ImportJob>(`/api/imports/${id}/supplement`,{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream','X-File-Name':encodeURIComponent(file.name)},body:file}); updateShareByJob(jobId,'SUBMITTED'); window.location.reload(); }
    catch{ setError('补充视频未完成，请确认文件有效并重试'); setBusy(false); }
  };
  const candidates=job?.draft?.candidates||[];

  return <section>
    <header className="page-header"><Link className="icon-link" to="/" aria-label="返回曲库">‹</Link><h1>确认并保存</h1></header>
    {error&&<p role="alert">{error}</p>}
    {!job&&<p role="status">正在读取收录进度…</p>}
    {job&&['PROCESSING','PENDING'].includes(job.status)&&<ImportProgress stage={job.stage}/>}
    {job?.status==='FAILED'&&<div className="empty-library"><h2>这个文件暂时无法读取</h2><p>请选择包含声音的视频或有效音频文件重试。</p><Link className="primary icon-link" to="/">返回曲库</Link></div>}
    {job?.status==='NEEDS_INPUT'&&<div className="empty-library">
      <h2>已保留分享链接</h2>
      <p>当前无法自动取得这条视频，请选择本地视频补充；原链接会保留在条目来源里。</p>
      <input ref={supplementInput} type="file" accept="video/*" hidden onChange={e=>{const f=e.target.files?.[0];if(f)void supplement(f);}}/>
      <button className="primary" disabled={busy} onClick={()=>supplementInput.current?.click()}>选择本地视频补充</button>
      <Link className="icon-link" to="/">返回曲库</Link>
    </div>}
    {job?.status==='READY'&&job.draft&&<div className="review-form">
      <CoverArt title={title.trim() || '舞蹈'} variant="detail" />
      {job.duplicateId&&<p className="notice">已收藏过此来源。<Link to={`/dances/${job.duplicateId}`}>查看已有舞蹈</Link>；仍可保存新的一份。</p>}
      {job.draft.link&&<p className="muted">来源链接已保留。</p>}
      {candidates.length>0&&<fieldset><legend>识曲候选（选择后会写入歌曲信息）</legend><div className="button-row">{candidates.map((c,i)=><button key={i} onClick={()=>{setTitle(c.title);setArtist(c.artist);}}>{c.title} · {c.artist} · {Math.round(c.confidence*100)}%</button>)}</div><button onClick={()=>{setTitle('');setArtist('');}}>忽略候选，手动填写</button></fieldset>}
      <label>歌名<input value={title} onChange={e=>setTitle(e.target.value)} maxLength={200}/></label>
      <label>歌手<input value={artist} onChange={e=>setArtist(e.target.value)} maxLength={200} placeholder="未识别，可手动填写"/></label>
      {job.draft.audio&&<audio aria-label="试听原音乐" controls src={mediaUrl(job.draft.audio.url)}/>}
      <div className="primary-actions">{job.draft.sourceMediaId&&<Link className="icon-link" to={`/reference/${job.draft.sourceMediaId}`}>查看原视频</Link>}</div>
      <fieldset><legend>学习状态</legend><div className="button-row">{STATUS_OPTIONS.map(o=><button key={o.id} aria-pressed={status===o.id} onClick={()=>setStatus(o.id)}>{o.label}</button>)}</div></fieldset>
      <fieldset><legend>场景标签（可选）</legend><div className="button-row">{SCENE_OPTIONS.map(o=><button key={o.id} aria-pressed={scenes.includes(o.id)} onClick={()=>setScenes(scenes.includes(o.id)?scenes.filter(s=>s!==o.id):[...scenes,o.id])}>{o.label}</button>)}</div></fieldset>
      <button className="primary" disabled={busy||!title.trim()} onClick={()=>void save()}>{busy?'正在保存…':'保存到我的舞蹈库'}</button>
    </div>}
  </section>;
}
