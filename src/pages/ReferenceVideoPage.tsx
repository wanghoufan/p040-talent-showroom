import { Link,useParams } from 'react-router-dom';
import { mediaUrl } from '../lib/api';
import { useRef,useState } from 'react';
export default function ReferenceVideoPage(){
  const {id}=useParams();const video=useRef<HTMLVideoElement>(null);const [error,setError]=useState('');
  return <section><header className="page-header"><button onClick={()=>history.back()} aria-label="返回详情">‹</button><h1>原始视频</h1></header><video className="reference-video" ref={video} autoPlay playsInline controls src={mediaUrl(`/api/media/reference/${id}`)} onError={()=>setError('原视频暂时无法播放，请连接服务器或准备离线学习')}/><button onClick={()=>void video.current?.requestFullscreen().catch(()=>setError('请使用播放器的全屏按钮'))}>全屏播放</button>{error&&<p role="alert">{error}</p>}<Link className="icon-link" to="/">返回曲库</Link></section>;
}
