import {useRef,useState} from 'react';
import {queueFile,readLocalText} from '../lib/offline-files';
import {editLocally} from '../lib/offline-editing';
import {readMetadata} from '../lib/local-database';
import {guessLocalFileRole,normalizedSongKey,parseLrc,resolveLineTimings} from '../lib/vocal';
import type {LearningStatus} from '../lib/types';
import type {LibraryKind} from '../lib/library-management';
type TrackRole='original'|'accompaniment';
interface Entry {
  key:string;
  file:File;
  title:string;
  /** 唱歌：同一首歌的原唱/伴奏/LRC 共用这一首曲目 id，绝不拆成三首。 */
  songId?:string;
  role?:TrackRole;
  entryKind:'audio'|'lyrics';
  /** 文件名看不出用途时的复核提示，避免把未标注音频静默当成原唱。 */
  hint?:string;
  jobId?:string;
  itemId?:string;
  state:'waiting'|'processing'|'ready'|'done'|'failed'|'duplicate';
  /** 被拒绝的冲突项不再提供“重试”，避免用户手动把重复文件重新排回队列。 */
  retryable?:boolean;
  error?:string;
}
/** 歌词文件不建曲目：解析后写回同一 songId 的 lyrics 字段，离线时由编辑队列补发。 */
function isLyricFile(name:string){return /\.lrc$/i.test(name);}
export default function MultiImportSheet({kind,onClose}:{kind:LibraryKind;onClose:()=>void}){
 const [entries,setEntries]=useState<Entry[]>([]),[status,setStatus]=useState<LearningStatus>('WANT_TO_LEARN'),[busy,setBusy]=useState(false),[error,setError]=useState('');const input=useRef<HTMLInputElement>(null);
 const change=(key:string,values:Partial<Entry>)=>setEntries(old=>old.map(e=>e.key===key?{...e,...values}:e));
 const choose=(files:FileList|null)=>{
  if(!files)return;
  if(files.length>50){setError('一次最多选择 50 个文件');return;}
  setError('');
  const list=Array.from(files);
  if(kind!=='VOCAL'){
   setEntries(list.map(file=>({key:crypto.randomUUID(),file,title:file.name.replace(/\.[^.]+$/,''),entryKind:isLyricFile(file.name)?'lyrics':'audio',state:file.size>512*1024*1024?'failed':'waiting',error:file.size>512*1024*1024?'文件超过 512MiB':undefined})));
   return;
  }
  // 唱歌：先按歌名分组，再把同一组的原唱、伴奏、LRC 落到同一个 songId。
  const groups=new Map<string,{title:string;order:number;audio:{file:File;role:TrackRole}[];lyrics?:File;conflicts:{file:File;role:TrackRole}[]}>();
  list.forEach((file,index)=>{
   const ext=file.name.split('.').at(-1)?.toLowerCase()||'';
   if(!['mp3','m4a','wav','flac','lrc'].includes(ext)){setError('唱歌批量导入只接受 mp3 / m4a / wav / flac 音频和 .lrc 歌词');return;}
   const key=normalizedSongKey(file.name);
   if(!key)return;
   const group=groups.get(key)||{title:guessLocalFileRole(file.name).baseName||file.name,order:index,audio:[],lyrics:undefined,conflicts:[]};
   if(isLyricFile(file.name)){if(group.lyrics)setError('同一首歌有多个歌词文件，只保留第一个');else group.lyrics=file;}
   else{
    const role:TrackRole=guessLocalFileRole(file.name).role==='accompaniment'?'accompaniment':'original';
    // 同曲同角色只允许一个文件：第二个不排队，避免后到的文件把先到的音轨静默覆盖。
    if(group.audio.some(item=>item.role===role))group.conflicts.push({file,role});
    else group.audio.push({file,role});
   }
   groups.set(key,group);
  });
  const next:Entry[]=[];
  for(const group of [...groups.values()].sort((a,b)=>a.order-b.order)){
   if(!group.audio.length){
    // 只有歌词没有音频时不单独建曲目，明确提示而不是造出一首空歌。
    const file=group.lyrics as File;
    next.push({key:crypto.randomUUID(),file,title:group.title,entryKind:'lyrics',state:'failed',retryable:false,error:'这首歌只有歌词文件，缺少音频；请一起选择原唱或伴奏后再导入'});
    for(const clash of group.conflicts)next.push({key:crypto.randomUUID(),file:clash.file,title:group.title,role:clash.role,entryKind:'audio',state:'failed',retryable:false,error:clash.role==='accompaniment'?'这首歌已有伴奏文件，这一份未导入；如需更换请在曲目详情页替换':'这首歌已有原唱文件，这一份未导入；如需更换请在曲目详情页替换'});
    continue;
   }
   const songId=crypto.randomUUID();
   // 每条音频都带 createFields：队列按任意顺序处理都不会因曲目尚未创建而 404，创建动作本身按 songId 幂等。
   group.audio.forEach(item=>next.push({key:crypto.randomUUID(),file:item.file,title:group.title,songId,role:item.role,entryKind:'audio',hint:item.role==='original'&&guessLocalFileRole(item.file.name).role==='unknown'?'用途未标注，先按原唱处理，可在详情页替换':undefined,state:item.file.size>512*1024*1024?'failed':'waiting',error:item.file.size>512*1024*1024?'文件超过 512MiB':undefined}));
   if(group.lyrics)next.push({key:crypto.randomUUID(),file:group.lyrics,title:group.title,songId,entryKind:'lyrics',state:'waiting'});
   // 冲突文件单独列出并保持 failed：用户能看到被拒绝的是哪一个，也不会悄悄少一条音轨。
   for(const clash of group.conflicts)next.push({key:crypto.randomUUID(),file:clash.file,title:group.title,songId,role:clash.role,entryKind:'audio',state:'failed',retryable:false,error:`同一首歌只能有一个${clash.role==='accompaniment'?'伴奏':'原唱'}文件，这一份未导入，也不会覆盖已选文件；如需更换请在曲目详情页替换`});
  }
  setEntries(next);
 };
 async function saveLyrics(entry:Entry){
  if(!entry.songId)throw Error('歌词缺少目标曲目');
  const text=await readLocalText(entry.file);
  const doc=parseLrc(text);
  if(!doc.hasUsableTiming)throw Error(doc.issues.includes('INVALID_TIMESTAMP')?'歌词时间戳格式不正确，未保存；请使用 [mm:ss.xx] 格式':'歌词没有可用的 [mm:ss] 时间戳，未保存；未校时歌词不会给出假时间');
  // 歌词可能先于音频落盘：同一 songId 先把曲目建好，后续音频仍关联到这首，不另建新歌。
  const exists=JSON.parse(readMetadata('dance.repertoire-snapshot')||'[]').some((item:{id:string})=>item.id===entry.songId);
  if(!exists)await editLocally({kind:'VOCAL',id:entry.songId},{title:entry.title,learningStatus:status},'create');
  await editLocally({kind:'VOCAL',id:entry.songId},{lyrics:resolveLineTimings(doc.lines)},'update');
  return doc.lines.length;
 }
 async function process(entry:Entry){
  if(entry.file.size>512*1024*1024)return;
  change(entry.key,{state:'processing',error:undefined});
  try{
   if(kind==='VOCAL'){
    if(!entry.songId)throw Error('缺少曲目归属，已跳过，不会新建曲目');
    if(entry.entryKind==='lyrics'){
     const count=await saveLyrics(entry);
     change(entry.key,{state:'done',error:`已写入 ${count} 句歌词`});
     return;
    }
    await queueFile(entry.file,{kind:'VOCAL',id:entry.songId},'MEDIA',{
     id:entry.key,title:entry.title,learningStatus:status,track:entry.role,
     createFields:{title:entry.title,learningStatus:status},
    });
    change(entry.key,{state:'done'});
    return;
   }
   let itemId=entry.itemId;
   if(kind!=='DANCE'&&!itemId)itemId=entry.key;
   await queueFile(entry.file,{kind,id:itemId||entry.key},'MEDIA',{id:entry.key,title:entry.title,learningStatus:status,...(kind!=='DANCE'?{createFields:{title:entry.title,learningStatus:status}}:{})});
   change(entry.key,{state:'done'});
  }catch(e){change(entry.key,{state:'failed',error:e instanceof Error?e.message:'手机尚未保存，请重试'});}
 }
 const run=async(list:Entry[])=>{setBusy(true);for(const entry of list)await process(entry);setBusy(false);};
 const label=(entry:Entry)=>entry.entryKind==='lyrics'?'歌词 LRC':entry.role==='accompaniment'?'伴奏':'原唱';
 return <div className="modal-backdrop"><section className="import-sheet" role="dialog" aria-modal="true" aria-label="批量收录"><header className="page-header"><h2>批量收录</h2><button disabled={busy} onClick={onClose}>关闭</button></header><p>最多 50 个文件，先保存到手机，联网后逐项处理。失败项目可在“我的 → 同步与待办”重试。</p>{kind==='VOCAL'&&<p role="status">同一首歌的原唱、伴奏、歌词会自动归到同一首曲目，不会生成三首。</p>}<input hidden multiple type="file" accept={kind==='VOCAL'?'audio/*,.lrc':'audio/*,video/*'} ref={input} onChange={e=>choose(e.target.files)}/><button disabled={busy} onClick={()=>input.current?.click()}>选择多个音频{kind==='VOCAL'?' / 歌词 LRC':' / 视频'}</button><label>统一学习状态<select disabled={busy} value={status} onChange={e=>setStatus(e.target.value as LearningStatus)}><option value="WANT_TO_LEARN">想学</option><option value="PRACTICING">正在练</option><option value="CAN_DANCE">{kind==='DANCE'?'会跳':kind==='GUITAR'?'会弹':'会唱'}</option></select></label>{error&&<p role="alert">{error}</p>}<div className="import-queue">{entries.map(e=><div key={e.key}><input aria-label={`歌名 ${e.file.name}`} disabled={busy||['done','duplicate'].includes(e.state)} value={e.title} onChange={event=>change(e.key,{title:event.target.value})} maxLength={200}/><p>{label(e)} · {e.file.name} · {e.hint?`${e.hint} · `:''}{e.state==='done'?`✓ ${e.error||'已保存到手机，处理进度见“我的”'}`:e.state==='processing'?'正在处理…':e.state==='duplicate'?'已跳过重复':e.state==='failed'?e.error:'等待收录'}</p>{e.state==='failed'&&e.retryable!==false&&<button disabled={busy||!e.title.trim()} onClick={()=>void run([e])}>重试此项</button>}</div>)}</div><button className="primary" disabled={busy||!entries.some(e=>e.state==='waiting')||entries.some(e=>!e.title.trim())} onClick={()=>void run(entries.filter(e=>e.state==='waiting'))}>{busy?'正在收录…':'确认并开始收录'}</button></section></div>;
}
