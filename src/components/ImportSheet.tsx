import MultiImportSheet from './MultiImportSheet';
import { useRef,useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api,jsonBody } from '../lib/api';
import type { ImportJob } from '../lib/types';
export default function ImportSheet({onClose}:{onClose:()=>void}){
  const [multi,setMulti]=useState(false);const navigate=useNavigate();const [busy,setBusy]=useState(false),[error,setError]=useState(''),[link,setLink]=useState(''),[showLink,setShowLink]=useState(false);
  const video=useRef<HTMLInputElement>(null),audio=useRef<HTMLInputElement>(null);
  const sendFile=async(file:File)=>{
    setBusy(true);setError('');
    try{const job=await api<ImportJob>('/api/imports/file',{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream','X-File-Name':encodeURIComponent(file.name)},body:file});navigate(`/imports/${job.id}`);onClose();}
    catch{setError('收录未完成，请确认服务器连接后重试');setBusy(false);}
  };
  const sendLink=async()=>{
    setBusy(true);setError('');try{const job=await api<ImportJob>('/api/imports/link',{method:'POST',...jsonBody({link})});navigate(`/imports/${job.id}`);onClose();}catch{setError('请检查链接和服务器连接');setBusy(false);}
  };
  if(multi)return <MultiImportSheet kind="DANCE" onClose={onClose}/>;
  return <div className="modal-backdrop"><section className="import-sheet" role="dialog" aria-modal="true" aria-labelledby="import-title" onDragOver={e=>{e.preventDefault();}} onDrop={e=>{e.preventDefault();const f=e.dataTransfer?.files?.[0];if(f)void sendFile(f);}}><header className="page-header"><h2 id="import-title">收录舞蹈</h2><button onClick={onClose} aria-label="关闭收录">×</button></header><p>把舞蹈视频变成原视频、原音乐片段和歌曲信息，方便学习与演出。</p><input ref={video} type="file" accept="video/*" hidden onChange={e=>{const f=e.target.files?.[0];if(f)void sendFile(f);}}/><input ref={audio} type="file" accept="audio/*" hidden onChange={e=>{const f=e.target.files?.[0];if(f)void sendFile(f);}}/><button className="import-choice" disabled={busy} onClick={()=>setShowLink(true)}>从抖音 / 分享链接收录 <span>→</span></button><button className="import-choice" disabled={busy} onClick={()=>video.current?.click()}>选择视频 <span>→</span></button><button className="import-choice" disabled={busy} onClick={()=>audio.current?.click()}>手动音频 + 封面 <span>→</span></button><button className="import-choice" disabled={busy} onClick={()=>setMulti(true)}>批量收录多个文件 →</button><p className="muted drop-hint">也可以把视频或音频文件拖到这里（电脑端）</p>{showLink&&<label>粘贴分享链接<input aria-label="分享链接" value={link} onChange={e=>setLink(e.target.value)} placeholder="https://v.douyin.com/…"/><button className="primary" disabled={busy||!link.trim()} onClick={()=>void sendLink()}>开始收录</button></label>}{busy&&<p role="status">正在保存来源，请稍候…</p>}{error&&<p role="alert">{error}</p>}</section></div>;
}
