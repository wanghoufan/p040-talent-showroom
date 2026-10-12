import { Link,useParams } from 'react-router-dom';
import { referenceSource } from '../native/filesystem';
import { useEffect,useRef,useState } from 'react';
export default function ReferenceVideoPage(){
  const {id}=useParams();const video=useRef<HTMLVideoElement>(null);const [error,setError]=useState('');const [src,setSrc]=useState('');const [offline,setOffline]=useState(false);const [checking,setChecking]=useState(true);
  useEffect(()=>{let active=true;if(!id){setChecking(false);return undefined;}void referenceSource(id).then(r=>{if(active){setSrc(r.src);setOffline(r.offline);setChecking(false);}});return()=>{active=false;};},[id]);
  return <section><header className="page-header"><button onClick={()=>history.back()} aria-label="返回详情">‹</button><h1>原始视频</h1></header>{checking?<p role="status">正在打开原视频…</p>:<video className="reference-video" ref={video} autoPlay playsInline controls src={src} onError={()=>setError(offline?'本地原视频无法播放，请在“我的→原视频（离线看）”重新下载':'原视频暂时无法播放，请连接服务器，或在“我的→原视频（离线看）”下载到手机')}/>}{offline&&!error&&<p className="muted">已缓存到手机，断网也能播放。</p>}<button onClick={()=>void video.current?.requestFullscreen().catch(()=>setError('请使用播放器的全屏按钮'))}>全屏播放</button>{error&&<p role="alert">{error}</p>}<Link className="icon-link" to="/">返回曲库</Link></section>;
}
