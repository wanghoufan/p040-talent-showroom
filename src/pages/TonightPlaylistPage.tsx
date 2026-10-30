import {useEffect,useState,useRef} from 'react';
import {useCatalog} from '../lib/catalog-store';import {useRepertoire} from '../lib/repertoire-store';
import {fetchProgram,saveProgram,storedProgram,kindLabel,type ProgramItem} from '../lib/program';
import {prepareOffline,type PrepareResult} from '../lib/sync';import {isItemPlayable,isPerformanceReady,isMediaReady,readCachedIndex,type CachedIndex} from '../lib/offline-manifest';
import {moveItem} from '../lib/playlist';import type {LibraryKind} from '../lib/library-management';
import {resolveTracks,trackPairStatus} from '../lib/vocal';
import '../styles/vocal-performance.css';

/**
 * 今晚节目单：舞蹈/吉他/唱歌混排，准备离线演出继续复用现有同步（prepareOffline）。
 * 唱歌的准备明细只报告真实状态：缺哪条音轨（未提供 / 未缓存）、歌词是否有时间戳、结构是否标注；
 * 缓存校验依据文件存在与清单大小，不宣称已做音频解码验证，也不用原唱冒充伴奏。
 */

export interface VocalPrepIssue { title:string; missing:string[]; lyrics:string; sections:string }

/** 逐首列出唱歌的资源明细，供节目单在准备前/后准确展示。纯文本曲目沿用旧逻辑，不在此虚报缺轨。 */
export function vocalPrepIssues(items:ProgramItem[],cached:CachedIndex):VocalPrepIssue[]{
 const issues:VocalPrepIssue[]=[];
 for(const item of items){
  if(item.kind!=='VOCAL')continue;
  const tracks=resolveTracks(item);
  if(!tracks.original&&!tracks.accompaniment)continue;
  const missing:string[]=[];
  // 原唱与伴奏指向同一文件时不是真双轨，既不能标「齐全」，也不能算已缓存伴奏。
  if(trackPairStatus(tracks).state==='same-media')missing.push('伴奏与原唱为同一文件');
  else for(const role of ['accompaniment','original'] as const){
   const label=role==='accompaniment'?'伴奏':'原唱';
   const media=tracks[role]?.media;
   if(!media){missing.push(`${label}未提供`);continue;}
   if(!isMediaReady({key:media.url,url:media.url,sha256:media.sha256,version:media.version,sizeBytes:media.sizeBytes,kind:'audio'},cached))missing.push(`${label}未缓存`);
  }
  issues.push({
   title:item.title,
   missing,
   lyrics:item.lyrics?.length?`歌词 ${item.lyrics.length} 句（带时间）`:item.scoreText?'歌词为纯文本（无时间戳）':'未导入歌词',
   sections:item.sections?.length?`结构 ${item.sections.length} 段`:'未标注结构',
  });
 }
 return issues;
}

/** 节目单行内状态：唱歌以伴奏是否就绪判定能否演出，只有原唱时明确写「未提供伴奏」。 */
export function programRowStatus(item:ProgramItem,cached:CachedIndex):string{
 if(item.kind!=='VOCAL')return item.audio?(isItemPlayable(item,cached)?'已缓存':'未缓存'):'文本曲目';
 const tracks=resolveTracks(item);
 if(!tracks.original&&!tracks.accompaniment)return item.audio?(isItemPlayable(item,cached)?'已缓存':'未缓存'):'文本曲目';
 const same=trackPairStatus(tracks).state==='same-media';
 if(same)return '伴奏与原唱为同一文件';
 if(!tracks.accompaniment?.media)return '未提供伴奏（仅原唱）';
 return isPerformanceReady(item,cached)?'伴奏已缓存':'伴奏未缓存';
}

/** 缺轨原因的界面口径：与 prepareOffline 的 cause 一一对应，不合并成含糊的「缺失」。 */
const MISSING_CAUSE_LABEL:Record<'absent'|'not-cached'|'duplicate',string>={absent:'未提供','not-cached':'未缓存',duplicate:'与原唱同源'};

export default function TonightPlaylistPage(){
 const {items:dances}=useCatalog(),{items:talents}=useRepertoire();
 const [program,setProgram]=useState(storedProgram),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[query,setQuery]=useState(''),[kind,setKind]=useState<LibraryKind|'ALL'>('ALL'),[selected,setSelected]=useState<Set<string>>(new Set()),[confirm,setConfirm]=useState(false),[report,setReport]=useState<VocalPrepIssue[]>([]);
 const dragging=useRef<{index:number;pointer:number}|null>(null);const [dragIndex,setDragIndex]=useState<number|null>(null);
 function startDrag(event:React.PointerEvent<HTMLButtonElement>,index:number){event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);dragging.current={index,pointer:event.pointerId};setDragIndex(index);}
 function endDrag(event:React.PointerEvent<HTMLButtonElement>){const drag=dragging.current;dragging.current=null;setDragIndex(null);if(!drag)return;const row=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[data-program-index]');if(row)void persist(moveItem(program.items,drag.index,Number(row.dataset.programIndex)));}
 const catalog:ProgramItem[]=[...dances.map(i=>({...i,kind:'DANCE' as const})),...talents];const items=program.items.map(r=>catalog.find(i=>i.kind===r.kind&&i.id===r.id)).filter((i):i is ProgramItem=>!!i);const cached=readCachedIndex();
 useEffect(()=>{const changed=()=>setProgram(storedProgram());window.addEventListener('dance-program-changed',changed);fetchProgram().then(setProgram).catch(()=>setMessage('当前显示手机保存的节目单'));return()=>window.removeEventListener('dance-program-changed',changed);},[]);
 async function persist(refs:typeof program.items){setBusy(true);setMessage('');try{setProgram(await saveProgram({...program,items:refs}));setSelected(new Set());setConfirm(false);setReport([]);}catch{setMessage('保存失败或节目单已在另一端修改，当前顺序保留；请刷新后重试。');}finally{setBusy(false);}}
 async function prepare(){
  setBusy(true);setMessage('');
  try{
   const result:PrepareResult=items.length?await prepareOffline(items,(done,total)=>setMessage(`正在缓存 ${done}/${total}`)):{downloaded:0,total:0,ready:true,mediaSupported:false,missingTracks:[]};
   const nextReport=vocalPrepIssues(items,readCachedIndex());
   setReport(nextReport);
   const reasons=result.missingTracks.map(track=>`${track.title}·${track.role==='accompaniment'?'伴奏':'原唱'}${MISSING_CAUSE_LABEL[track.cause]}`);
   const detail=reasons.slice(0,4).join('、')+(reasons.length>4?` 等 ${reasons.length} 条`:'');
   setMessage(result.ready
    ?`节目单已准备好（${items.length} 项）。已按清单校验文件存在且大小一致，未做音频解码验证。`
    :`仍有资源未就绪${result.mediaSupported?'':'（当前环境不支持离线缓存，请在手机 App 内准备）'}${detail?`：${detail}`:''}；请按下方明细补全后重试。`);
  }catch{setReport([]);setMessage('准备失败，请检查连接后重试。');}
  finally{setBusy(false);}
 }
 const remaining=catalog.filter(i=>!program.items.some(r=>r.kind===i.kind&&r.id===i.id)&&(kind==='ALL'||i.kind===kind)&&`${i.title} ${i.artist}`.toLowerCase().includes(query.toLowerCase()));
 return <section><header className="page-header"><h1>今晚节目单</h1><button disabled={busy||!items.length} onClick={()=>setConfirm(true)}>清空</button></header>
  <button className="primary" disabled={busy||!items.length} onClick={()=>void prepare()}>准备离线演出</button>
  <p className="prep-note">沿用「我的 → 离线音乐」同一套同步与缓存，只补齐缺失文件；校验依据文件存在与清单大小，不做音频解码验证，也不会用原唱冒充伴奏（原唱与伴奏同源时明确标出，不算真双轨）。</p>
  {message&&<p role="status">{message}</p>}
  {report.length>0&&<ul className="prep-report" aria-label="离线准备明细">
   {report.map(issue=><li className="prep-report__row" key={issue.title}>
    <strong>{issue.title}</strong>
    <span className={issue.missing.length?'prep-report__bad':'prep-report__ok'}>{issue.missing.length?issue.missing.join('、'):'原唱/伴奏齐全'}</span>
    <span className="prep-report__meta">{issue.lyrics} · {issue.sections}</span>
   </li>)}
  </ul>}
  <ol className="playlist">{items.map((item,index)=><li className={`playlist__row${dragIndex===index?' playlist__row--dragging':''}`} data-program-index={index} key={item.kind+item.id}><button className="playlist__drag" aria-label={`拖动排序 ${item.title}`} disabled={busy} onPointerDown={e=>startDrag(e,index)} onPointerUp={endDrag} onPointerCancel={()=>{dragging.current=null;setDragIndex(null);}}>⠿</button><span className="playlist__title">{item.title}<small>{kindLabel(item.kind)} · {programRowStatus(item,cached)}</small></span><span className="playlist__move"><button disabled={busy||index===0} aria-label={`上移 ${item.title}`} onClick={()=>void persist(moveItem(program.items,index,index-1))}>↑</button><button disabled={busy||index===items.length-1} aria-label={`下移 ${item.title}`} onClick={()=>void persist(moveItem(program.items,index,index+1))}>↓</button><button disabled={busy} aria-label={`移出 ${item.title}`} onClick={()=>void persist(program.items.filter(r=>!(r.id===item.id&&r.kind===item.kind)))}>×</button></span></li>)}</ol>
  {!items.length&&<p>节目单为空，从下面选择舞蹈、吉他或唱歌。</p>}
  <h2>加入节目单</h2><div className="library-search"><input placeholder="搜索曲目" value={query} onChange={e=>{setQuery(e.target.value);setSelected(new Set());}}/><select aria-label="才艺类型" value={kind} onChange={e=>{setKind(e.target.value as typeof kind);setSelected(new Set());}}>{(['ALL','DANCE','GUITAR','VOCAL'] as const).map(k=><option key={k} value={k}>{k==='ALL'?'全部':kindLabel(k)}</option>)}</select></div>
  <div className="button-row"><button disabled={busy} onClick={()=>setSelected(new Set(remaining.map(i=>i.id)))}>全选当前结果</button><button disabled={busy||!selected.size} onClick={()=>void persist([...program.items,...remaining.filter(i=>selected.has(i.id)).map(({kind,id})=>({kind,id}))])}>加入所选（{selected.size}）</button></div>
  {remaining.map(i=><label className="trash-row" key={i.id}><input type="checkbox" checked={selected.has(i.id)} onChange={()=>setSelected(old=>{const next=new Set(old);if(next.has(i.id))next.delete(i.id);else next.add(i.id);return next;})}/>{i.title} · {kindLabel(i.kind)}</label>)}
  {confirm&&<div className="modal-backdrop"><section className="import-sheet" role="dialog" aria-modal="true" aria-label="清空节目单"><h2>清空今晚节目单？</h2><p>只移除节目单中的 {items.length} 项，曲库内容保留。</p><div className="button-row"><button onClick={()=>setConfirm(false)}>取消</button><button disabled={busy} onClick={()=>void persist([])}>确认清空</button></div></section></div>}
 </section>;
}
