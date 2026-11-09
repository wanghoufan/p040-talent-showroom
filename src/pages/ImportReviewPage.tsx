import { useEffect,useRef,useState } from 'react';
import { Link,useNavigate,useParams } from 'react-router-dom';
import { api,apiWithTimeout,jsonBody,mediaUrl,ApiError } from '../lib/api';
import { findPendingImport,forgetImport,rememberImport } from '../lib/pending-imports';
import { discardStoredVideo,findStoredVideo,findStoredVideoByJob,linkStoredVideo,recoverStoredVideos,stageVideo,readStoredVideo,VideoCopyError,type StoredVideo } from '../lib/video-store';
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
  const [storedVideo,setStoredVideo]=useState<StoredVideo|undefined>(()=>findStoredVideoByJob(jobId));
  const supplementInput=useRef<HTMLInputElement>(null);

  useEffect(()=>{
    // 冷启动后 sidecar 可能比 localStorage 索引更完整，先补登记再判断能否继续上传。
    void recoverStoredVideos().then(()=>setStoredVideo(findStoredVideoByJob(jobId)));
  },[jobId]);

  useEffect(()=>{
    let active=true; let timer:ReturnType<typeof setTimeout>; let initialized=false;
    const poll=async()=>{
      try{
        const next=await api<ImportJob>(`/api/imports/${id}`);
        if(!active) return;
        setJob(next);
        if(next.status==='FAILED') forgetImport(jobId);
        if(next.status!=='NEEDS_INPUT') setStoredVideo(findStoredVideoByJob(jobId));
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
  },[id,jobId]);

  const save=async()=>{
    setBusy(true); setError('');
    try{
      const item=await api<DanceItem>(`/api/imports/${id}/finalize`,{method:'POST',...jsonBody({title,artist,learningStatus:status,sceneTags:scenes})});
      // 确认保存后把私有副本登记为该曲目的本地原视频；文件保留，重启/断网仍可播放。
      const pending=findPendingImport(jobId);
      const local=(pending?.videoId?findStoredVideo(pending.videoId):undefined)||findStoredVideoByJob(jobId);
      // 只有视频副本才登记为“原视频”；手动音频导入不能冒充视频源。
      // 关联失败不阻断保存（文件仍在手机里，播放会回落到网络），下次打开原视频页还能重新下载。
      if(item.sourceMediaId&&local?.mime.startsWith('video/')) {
        try { await linkStoredVideo(local.id,{sourceMediaId:item.sourceMediaId}); }
        catch { /* sidecar 写失败：任务已保存，关联信息丢失只影响离线播放 */ }
      }
      forgetImport(jobId); removeShareByJob(jobId); catalogChanged(); navigate(`/dances/${item.id}`,{replace:true});
    }
    catch{ setError('保存未完成，请重试'); setBusy(false); }
  };
  const sendSupplement=async(video:StoredVideo)=>{
    setBusy(true); setError('');
    try{
      const body=await readStoredVideo(video);
      await apiWithTimeout(`/api/imports/${id}/supplement`,{method:'POST',headers:{'Content-Type':video.mime,'X-File-Name':encodeURIComponent(video.name)},body},120000);
      updateShareByJob(jobId,'SUBMITTED'); window.location.reload();
    }catch{ setError('视频已保存在手机，但补充上传未完成；可点「继续上传已保存的视频」重试'); setBusy(false); }
  };
  const supplement=async(file:File)=>{
    setBusy(true); setError('');
    let staged:StoredVideo;
    try{ staged=await stageVideo(file); }
    catch(error){ setError(error instanceof VideoCopyError?error.message:'视频无法保存到手机，请重试'); setBusy(false); return; }
    // 用户明确换视频：新副本落盘成功后才清理这一条任务下的旧副本，避免两份都挂同一个 jobId。
    const previous=findStoredVideoByJob(jobId);
    if(previous&&previous.id!==staged.id)await discardStoredVideo(previous.id);
    await linkStoredVideo(staged.id,{jobId});
    rememberImport(jobId,staged.name,{videoId:staged.id,sizeBytes:staged.sizeBytes});
    setStoredVideo(staged);
    await sendSupplement(staged);
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
      {storedVideo&&<p className="muted">视频已保存在手机：{storedVideo.name}（{Math.ceil(storedVideo.sizeBytes/1024/1024)} MB），退出 App 也不会丢。</p>}
      <input ref={supplementInput} type="file" accept="video/*" hidden onChange={e=>{const f=e.target.files?.[0];if(f)void supplement(f);}}/>
      {storedVideo
        ?<button className="primary" disabled={busy} onClick={()=>void sendSupplement(storedVideo)}>{busy?'正在上传…':'继续上传已保存的视频'}</button>
        :<button className="primary" disabled={busy} onClick={()=>supplementInput.current?.click()}>选择本地视频补充</button>}
      {storedVideo&&<button disabled={busy} onClick={()=>supplementInput.current?.click()}>换一个视频</button>}
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
