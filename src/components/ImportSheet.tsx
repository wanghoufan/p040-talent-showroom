import MultiImportSheet from './MultiImportSheet';
import { useRef,useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api,jsonBody } from '../lib/api';
import { rememberImport } from '../lib/pending-imports';
import { stageVideo,uploadStoredVideo,VideoCopyError } from '../lib/video-store';
import type { ImportJob } from '../lib/types';
export default function ImportSheet({onClose}:{onClose:()=>void}){
  const [multi,setMulti]=useState(false);const navigate=useNavigate();const [busy,setBusy]=useState(false),[error,setError]=useState(''),[link,setLink]=useState(''),[showLink,setShowLink]=useState(false);
  const video=useRef<HTMLInputElement>(null),audio=useRef<HTMLInputElement>(null);
  const sendFile=async(file:File)=>{
    setBusy(true);setError('');
    try{
      // 先复制到应用私有目录并核对字节数，再上传；上传失败或退出 App 时源视频仍留在手机里。
      const stored=await stageVideo(file);
      const job=await uploadStoredVideo(stored);
      navigate(`/imports/${job.id}`);onClose();
    }catch(e){
      setError(e instanceof VideoCopyError
        ? e.message
        : '视频已保存到手机，但上传未完成；可在曲库顶部「未完成的收录」重试');
      setBusy(false);
    }
  };
  const sendLink=async()=>{
    setBusy(true);setError('');try{const job=await api<ImportJob>('/api/imports/link',{method:'POST',...jsonBody({link})});rememberImport(job.id,link.trim());navigate(`/imports/${job.id}`);onClose();}catch{setError('请检查链接和服务器连接');setBusy(false);}
  };
  if(multi)return <MultiImportSheet kind="DANCE" onClose={onClose}/>;
  return <div className="modal-backdrop"><section className="import-sheet" role="dialog" aria-modal="true" aria-labelledby="import-title" onDragOver={e=>{e.preventDefault();}} onDrop={e=>{e.preventDefault();const f=e.dataTransfer?.files?.[0];if(f)void sendFile(f);}}><header className="page-header"><h2 id="import-title">收录舞蹈</h2><button onClick={onClose} aria-label="关闭收录">×</button></header><p>把舞蹈视频变成原视频、原音乐片段和歌曲信息，方便学习与演出。</p><input ref={video} type="file" accept="video/*" hidden onChange={e=>{const f=e.target.files?.[0];if(f)void sendFile(f);}}/><input ref={audio} type="file" accept="audio/*" hidden onChange={e=>{const f=e.target.files?.[0];if(f)void sendFile(f);}}/><button className="import-choice" disabled={busy} onClick={()=>setShowLink(true)}>从抖音 / 分享链接收录 <span>→</span></button><button className="import-choice" disabled={busy} onClick={()=>video.current?.click()}>选择视频 <span>→</span></button><button className="import-choice" disabled={busy} onClick={()=>audio.current?.click()}>手动音频 + 封面 <span>→</span></button><button className="import-choice" disabled={busy} onClick={()=>setMulti(true)}>批量收录多个文件 →</button><p className="muted drop-hint">也可以把视频或音频文件拖到这里（电脑端）</p>{showLink&&<label>粘贴分享链接<input aria-label="分享链接" value={link} onChange={e=>setLink(e.target.value)} placeholder="https://v.douyin.com/…"/><button className="primary" disabled={busy||!link.trim()} onClick={()=>void sendLink()}>开始收录</button></label>}{busy&&<p role="status">正在保存来源，请稍候…</p>}{error&&<p role="alert">{error}</p>}</section></div>;
}
