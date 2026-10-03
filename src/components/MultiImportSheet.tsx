import {useRef,useState} from 'react';
import {queueFile} from '../lib/offline-files';
import type {LearningStatus} from '../lib/types';
import type {LibraryKind} from '../lib/library-management';
interface Entry {key:string;file:File;title:string;jobId?:string;itemId?:string;state:'waiting'|'processing'|'ready'|'done'|'failed'|'duplicate';error?:string;}
export default function MultiImportSheet({kind,onClose}:{kind:LibraryKind;onClose:()=>void}){
 const [entries,setEntries]=useState<Entry[]>([]),[status,setStatus]=useState<LearningStatus>('WANT_TO_LEARN'),[busy,setBusy]=useState(false),[error,setError]=useState('');const input=useRef<HTMLInputElement>(null);
 const change=(key:string,values:Partial<Entry>)=>setEntries(old=>old.map(e=>e.key===key?{...e,...values}:e));
 const choose=(files:FileList|null)=>{if(!files)return;if(files.length>50){setError('一次最多选择 50 个文件');return;}setError('');setEntries(Array.from(files,file=>({key:crypto.randomUUID(),file,title:file.name.replace(/\.[^.]+$/,''),state:file.size>512*1024*1024?'failed':'waiting',error:file.size>512*1024*1024?'文件超过 512MiB':undefined})));};
 async function process(entry:Entry){if(entry.file.size>512*1024*1024)return;change(entry.key,{state:'processing',error:undefined});let itemId=entry.itemId;
  try{if(kind!=='DANCE'&&!itemId)itemId=entry.key;
   await queueFile(entry.file,{kind,id:itemId||entry.key},'MEDIA',{id:entry.key,title:entry.title,learningStatus:status,...(kind!=='DANCE'?{createFields:{title:entry.title,learningStatus:status}}:{})});change(entry.key,{state:'done'});
  }catch(e){change(entry.key,{state:'failed',itemId,error:e instanceof Error?e.message:'手机尚未保存，请重试'});}
 }
 const run=async(list:Entry[])=>{setBusy(true);for(const entry of list)await process(entry);setBusy(false);};
 return <div className="modal-backdrop"><section className="import-sheet" role="dialog" aria-modal="true" aria-label="批量收录"><header className="page-header"><h2>批量收录</h2><button disabled={busy} onClick={onClose}>关闭</button></header><p>最多 50 个文件，先保存到手机，联网后逐项处理。失败项目可在“我的 → 同步与待办”重试。</p><input hidden multiple type="file" accept="audio/*,video/*" ref={input} onChange={e=>choose(e.target.files)}/><button disabled={busy} onClick={()=>input.current?.click()}>选择多个音频 / 视频</button><label>统一学习状态<select disabled={busy} value={status} onChange={e=>setStatus(e.target.value as LearningStatus)}><option value="WANT_TO_LEARN">想学</option><option value="PRACTICING">正在练</option><option value="CAN_DANCE">{kind==='DANCE'?'会跳':kind==='GUITAR'?'会弹':'会唱'}</option></select></label>{error&&<p role="alert">{error}</p>}<div className="import-queue">{entries.map(e=><div key={e.key}><input aria-label={`歌名 ${e.file.name}`} disabled={busy||['done','duplicate'].includes(e.state)} value={e.title} onChange={event=>change(e.key,{title:event.target.value})} maxLength={200}/><p>{e.state==='done'?'✓ 已保存到手机，处理进度见“我的”':e.state==='processing'?'正在处理…':e.state==='duplicate'?'已跳过重复':e.state==='failed'?e.error:'等待收录'}</p>{e.state==='failed'&&<button disabled={busy||!e.title.trim()} onClick={()=>void run([e])}>重试此项</button>}</div>)}</div><button className="primary" disabled={busy||!entries.some(e=>e.state==='waiting')||entries.some(e=>!e.title.trim())} onClick={()=>void run(entries.filter(e=>e.state==='waiting'))}>{busy?'正在收录…':'确认并开始收录'}</button></section></div>;
}
