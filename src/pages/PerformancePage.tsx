import {lazy,Suspense,useEffect,useMemo,useRef,useState} from 'react';const ScoreReader=lazy(()=>import('../components/ScoreReader'));
import ScrollingText from '../components/ScrollingText';
import {useCatalog} from '../lib/catalog-store';import {useRepertoire} from '../lib/repertoire-store';
import {storedProgram,fetchProgram,kindLabel,programAudio,type ProgramItem} from '../lib/program';
import {readCachedIndex,isMediaReady,type CachedIndex} from '../lib/offline-manifest';import {offlineUrl,cachedFileValid,isOfflineSupported} from '../native/filesystem';
import {mediaUrl} from '../lib/api';import {keepScreenAwake} from '../native/theme-bars';
import {defaultVocalSource,hasVocalTrack,lineAtTime,resolveLineTimings,resolveTracks,sectionAtTime,sortSections,switchVocalTrack,trackPairStatus} from '../lib/vocal';
import {isRedundantTranslation,readTranslations,summarizeTranslations,translationIndex,translationToggleLabel} from '../lib/vocal/translation';
import type {LibraryKind} from '../lib/library-management';
import type {MediaFile,PerformanceSource,TimedLyric,VocalSection,VocalTracks} from '../lib/types';
import '../styles/vocal-performance.css';

/**
 * 演出模式（手机单列）。
 *
 * 唱歌（VOCAL）只认后端 item.tracks：默认伴奏，缺伴奏时明确提示且绝不把原唱当伴奏自动播出；
 * 原唱与伴奏指向同一文件时按「同源、非真双轨」处理并禁用伴奏，不允许假伴奏；
 * 时间统一用「歌词时间轴」= 文件时钟 − 当前音轨 offsetMs，timeupdate/定位/切轨都按它换算；
 * 现场切轨复用 switchVocalTrack，保持当前位置、暂停状态与歌词同步；曲目切换一律停声、回到伴奏等手动播放。
 * 演出与练唱设置隔离：不继承跳过 Rap、逐句循环、全曲循环、变速与合练状态。舞蹈/吉他沿用原单音轨行为。
 */

interface AudioEntry { key: string; url: string; sha256: string; version: number; sizeBytes: number; kind: 'audio' }

function audioEntry(media: MediaFile): AudioEntry {
  return {key: media.url, url: media.url, sha256: media.sha256, version: media.version, sizeBytes: media.sizeBytes, kind: 'audio'};
}

/** 演出用地址：原生端必须是已校验的离线文件；Web（局域网调试）回落到媒体地址。 */
async function resolveMediaUrl(media: MediaFile | null | undefined): Promise<string> {
  if (!media?.url) return '';
  if (!isOfflineSupported()) {
    try { return mediaUrl(media.url); } catch { return media.url; }
  }
  const cached: CachedIndex = readCachedIndex();
  const entry = audioEntry(media);
  const hit = cached[entry.key];
  if (!hit || !isMediaReady(entry, cached)) return '';
  if (!(await cachedFileValid(entry, hit))) return '';
  return hit.uri ? offlineUrl(hit.uri) : '';
}

function trackIsCached(tracks: VocalTracks, role: PerformanceSource, cached: CachedIndex): boolean {
  const media = tracks[role]?.media;
  return media ? isMediaReady(audioEntry(media), cached) : false;
}

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function trackLabel(role: PerformanceSource): string {
  return role === 'accompaniment' ? '伴奏' : '原唱';
}

export default function PerformancePage(){
 const {items:dances}=useCatalog(),{items:talents}=useRepertoire();
 const [program,setProgram]=useState(storedProgram),[kind,setKind]=useState<LibraryKind>('DANCE'),[index,setIndex]=useState(0);
 const [source,setSource]=useState<PerformanceSource|null>(null),[playing,setPlaying]=useState(false);
 const [timeMs,setTimeMs]=useState(0),[mediaDurationMs,setMediaDurationMs]=useState(0),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 /** 演出默认只看原文；有译文时现场可手动切双语，切歌自动回到原文。 */
 const [showTranslation,setShowTranslation]=useState(false);
 const audio=useRef<HTMLAudioElement>(null),lyricsBox=useRef<HTMLOListElement>(null),loadSeq=useRef(0),loadRef=useRef<Promise<void>|null>(null);

 const catalog=useMemo<ProgramItem[]>(()=>[...dances.map(i=>({...i,kind:'DANCE' as const})),...talents],[dances,talents]);
 const list=useMemo(()=>program.items.length?program.items.map(r=>catalog.find(i=>r.kind===i.kind&&r.id===i.id)).filter((i):i is ProgramItem=>!!i):catalog.filter(i=>i.kind===kind&&i.learningStatus==='CAN_DANCE'),[program,catalog,kind]);
 const current=list[Math.min(index,Math.max(list.length-1,0))];
 const isVocal=current?.kind==='VOCAL';
 const declaredTracks=useMemo<VocalTracks>(()=>current&&current.kind==='VOCAL'?resolveTracks(current):{},[current]);
 /** 同源原唱/伴奏不是真双轨：伴奏轨整条丢弃，既不拿原唱冒充伴奏，也不让它被选中播出。 */
 const fakeAccompaniment=useMemo(()=>trackPairStatus(declaredTracks).state==='same-media',[declaredTracks]);
 const tracks=useMemo<VocalTracks>(()=>fakeAccompaniment?{original:declaredTracks.original}:declaredTracks,[declaredTracks,fakeAccompaniment]);
 const defaultSource=useMemo(()=>current&&current.kind==='VOCAL'?defaultVocalSource(tracks,'performance'):null,[current,tracks]);
 /** 歌词时间轴 = 文件时钟 − 当前音轨 offsetMs；界面统一用这份规范化时间，切轨才不会错位。 */
 const offsetMs=source?(tracks[source]?.offsetMs??0):0;
 /** 待加载媒体：唱歌取当前音轨，舞蹈/吉他沿用单音轨（programAudio）；都没有时才为纯文本曲目。 */
 const audioMedia=useMemo<MediaFile|null>(()=>{
   if(!current)return null;
   if(current.kind==='VOCAL')return defaultSource?tracks[defaultSource]?.media??null:null;
   return programAudio(current)?.audio??null;
 },[current,defaultSource,tracks]);
 const currentKey=current?`${current.kind}:${current.id}`:'';

 const declaredDurationMs=(current?.durationMs||0)||(source?Math.max(0,(tracks[source]?.media.durationMs||0)-offsetMs):0);
 const durationMs=Math.max(mediaDurationMs>0?mediaDurationMs-offsetMs:0,declaredDurationMs,0);

 const sections=useMemo<VocalSection[]>(()=>current&&current.kind==='VOCAL'?sortSections(current.sections||[]):[],[current]);
 /** 同步歌词只读后端 item.lyrics；缺时间戳时不伪造，退回纯文本滚动。 */
 const lyrics=useMemo<TimedLyric[]>(()=>{
   if(!current||current.kind!=='VOCAL'||!current.lyrics?.length)return [];
   return resolveLineTimings(current.lyrics,current.durationMs||undefined);
 },[current]);
 const activeLine=lyrics.length?lineAtTime(lyrics,timeMs):-1;
 /** 译文按行 id 关联；演出页只读已同步的译文，现场不发起翻译请求。 */
 const translations=useMemo(()=>current&&current.kind==='VOCAL'?readTranslations(current):null,[current]);
 const translationByLine=useMemo(()=>translationIndex(translations),[translations]);
 const translationSummary=useMemo(()=>summarizeTranslations(lyrics,translations,current?.kind==='VOCAL'?current.language:undefined),[lyrics,translations,current]);
 const activeSection=sections.length?sectionAtTime(sections,timeMs):null;
 const cached=useMemo(readCachedIndex,[]);
 const missingAccompaniment=Boolean(isVocal&&!hasVocalTrack(tracks,'accompaniment'));
 const ctxRef=useRef({defaultSource,audioMedia});
 ctxRef.current={defaultSource,audioMedia};

 useEffect(()=>{void fetchProgram().then(setProgram).catch(()=>undefined);void keepScreenAwake(true);return()=>{void keepScreenAwake(false);};},[]);

 const chosenKey=useRef('');
 // 曲目数据刷新后当前音轨可能不再可用（例如原唱与伴奏变成同一文件）：立即停声并回到默认轨，
 // 不允许继续用旧地址冒充伴奏。切歌瞬间由下方切歌 effect 统一处理，这里只在同一首歌内生效。
 useEffect(()=>{
   if(chosenKey.current!==currentKey||!source||hasVocalTrack(tracks,source))return;
   const element=audio.current;
   if(element){element.pause();element.removeAttribute('src');element.load();element.currentTime=0;}
   setPlaying(false);setTimeMs(0);setMediaDurationMs(0);setSource(defaultSource);
   setNotice(fakeAccompaniment?'原唱与伴奏是同一个文件，已停止这条「伴奏」播放；请导入独立伴奏或改选「原唱」。':'当前音轨已不可用，请重新选择音轨。');
 },[source,tracks,currentKey,defaultSource,fakeAccompaniment]);

 // 切歌：立即停声、清空音轨、回到默认音轨，等待手动播放；不自动继承任何练唱设置。
 useEffect(()=>{
   const element=audio.current;
   if(element){element.pause();element.removeAttribute('src');element.load();element.currentTime=0;}
   setPlaying(false);setTimeMs(0);setMediaDurationMs(0);setNotice('');
   setShowTranslation(false);
   const context=ctxRef.current;
   setSource(context.defaultSource);
   chosenKey.current=currentKey;
   loadRef.current=null;
   const seq=++loadSeq.current;
   if(!element||!context.audioMedia)return;
   const promise=resolveMediaUrl(context.audioMedia).then(url=>{
     // 序号已变（再次切曲/手动切轨）或元素已换，丢弃过期结果，避免旧音轨覆盖当前曲目。
     if(seq!==loadSeq.current||!url||audio.current!==element)return;
     element.src=url;element.load();
   }).catch(()=>undefined);
   loadRef.current=promise;
   return()=>{loadSeq.current+=1;loadRef.current=null;};
 },[currentKey]);

 useEffect(()=>{
   const box=lyricsBox.current;
   if(!box)return;
   const line=box.querySelector<HTMLElement>('[aria-current="true"]');
   line?.scrollIntoView?.({block:'center'});
 },[activeLine]);

 function seekTo(ms:number){
   const element=audio.current;
   const limit=durationMs>0?durationMs-20:Number.POSITIVE_INFINITY;
   const next=Math.min(Math.max(0,Math.round(ms)),limit);
   setTimeMs(next);
   // 规范化时间 → 文件时钟：加上当前音轨 offsetMs。
   if(element)element.currentTime=Math.max(0,(next+offsetMs)/1000);
 }

 /** 无法出声时区分「未提供伴奏」「同源假伴奏」「未准备离线」「音轨未选」，不用原唱顶替。 */
 function blockedReason():string{
   if(!current)return '节目单里还没有可演出的曲目。';
   if(current.kind==='VOCAL'){
     if(!hasVocalTrack(tracks,'accompaniment')&&!hasVocalTrack(tracks,'original'))return '这条曲目还没有原唱或伴奏音轨，无法演出。';
     if(fakeAccompaniment&&!source)return '原唱与伴奏是同一个文件，不能当伴奏播出；可手动选择「原唱」跟唱，或导入独立伴奏。';
     if(!source)return '请选择「伴奏」或「原唱」后再播放。';
     return `「${trackLabel(source)}」尚未下载或文件已丢失，请先在今晚节目单准备离线演出。`;
   }
   if(!audioMedia)return '此曲目只保存了文本，可直接看谱或歌词。';
   return '这首音乐尚未下载或文件已丢失，请先准备离线演出。';
 }

 async function toggle(restart=false){
   const element=audio.current;
   if(!element)return;
   if(playing&&!restart){element.pause();return;}
   // 切曲后的地址解析是异步的：先等正在进行的加载，避免刚切过来就被误报「尚未下载」。
   const pending=loadRef.current;
   if(pending&&!element.getAttribute('src')){await pending;if(audio.current!==element)return;}
   if(!element.getAttribute('src')){setNotice(blockedReason());return;}
   if(restart){element.currentTime=Math.max(0,offsetMs/1000);setTimeMs(0);}
   try{await element.play();setNotice('');}catch{setNotice('音乐无法播放，请检查文件是否已准备离线后重试。');}
 }

 /** 现场切轨：保持 currentTime 与播放/暂停状态；失败回滚原轨并提示，不自动乱播。 */
 async function switchSource(next:PerformanceSource){
   if(next===source||busy)return;
   if(!hasVocalTrack(tracks,next)){setNotice(next==='accompaniment'?'这条曲目未提供伴奏音轨。':'这条曲目未提供原唱音轨。');return;}
   const element=audio.current;
   if(!element)return;
   loadSeq.current+=1; // 作废尚在解析中的初始伴奏地址，避免覆盖用户手动选择的音轨
   setBusy(true);setNotice('');
   try{
     if(!source){
       const url=await resolveMediaUrl(tracks[next]?.media);
       if(!url){setNotice(`「${trackLabel(next)}」尚未下载或文件已丢失，请先在今晚节目单准备离线演出。`);return;}
       element.pause();element.src=url;element.load();element.currentTime=Math.max(0,(tracks[next]?.offsetMs??0)/1000);
       setPlaying(false);setTimeMs(0);setMediaDurationMs(0);setSource(next);
       return;
     }
     await switchVocalTrack(element,{tracks,fromRole:source,toRole:next,resolveUrl:async(track)=>resolveMediaUrl(track.media)});
     setSource(next);
     // 文件时钟 → 规范化时间：减去目标音轨 offsetMs，歌词与结构才留在同一点。
     setTimeMs(Math.max(0,Math.round(element.currentTime*1000)-(tracks[next]?.offsetMs??0)));
   }catch(error){
     const detail=error instanceof Error&&error.message?error.message:'切换失败';
     setNotice(`切换到「${trackLabel(next)}」未成功：${detail}；已保留原音轨。`);
   }finally{setBusy(false);}
 }

 function handleLoaded(){
   const element=audio.current;
   if(element&&Number.isFinite(element.duration)&&element.duration>0)setMediaDurationMs(Math.round(element.duration*1000));
 }

 const position=Math.min(Math.max(0,timeMs),Math.max(1000,durationMs));
 return <section className="perform-page">
  <header className="page-header"><h1>演出模式</h1>{list.length>0&&<span className="perform-count">{Math.min(index,list.length-1)+1} / {list.length}</span>}</header>
  <p className="perform-note">默认伴奏；进入或切换曲目后等待你手动播放。演出不继承练唱设置（跳过 Rap、逐句循环、变速），保持屏幕亮起。</p>
  {!program.items.length&&<select aria-label="默认才艺" value={kind} onChange={e=>{setKind(e.target.value as LibraryKind);setIndex(0);}}>{(['DANCE','GUITAR','VOCAL'] as const).map(k=><option key={k} value={k}>{kindLabel(k)}</option>)}</select>}
  {current?<>
   <div className="perform-stage">
    <p className="perform-kicker">{kindLabel(current.kind)}</p>
    <p className="perform-title">{current.title}</p>
    <p className="perform-meta">{current.kind!=='DANCE'&&<>{current.performanceKey||current.originalKey||'未设调'}{current.kind==='GUITAR'&&` · Capo ${current.capo}`}</>}{current.kind==='DANCE'&&(current.artist||'舞蹈')}</p>
    {isVocal&&<>
     <div className="perform-tracks" role="group" aria-label="现场音轨">
      {(['accompaniment','original'] as PerformanceSource[]).map(role=>{
        const ready=hasVocalTrack(tracks,role);
        return <button key={role} type="button" className="perform-track" aria-pressed={source===role} disabled={!ready||busy} onClick={()=>void switchSource(role)}>
          {role==='accompaniment'?'♫ 伴奏':'♬ 原唱'}{ready?'':fakeAccompaniment&&role==='accompaniment'?'（同源，不能当伴奏）':'（未提供）'}
        </button>;
      })}
     </div>
     {fakeAccompaniment
      ?<p className="perform-alert" role="alert">同源提示：原唱与伴奏指向同一个音频文件，不能当作真实双轨，也不会用原唱冒充伴奏；请导入独立的伴奏文件后再按伴奏演出。</p>
      :missingAccompaniment&&<p className="perform-alert" role="alert">未提供伴奏：这条曲目没有伴奏音轨，不能按伴奏演出；如需跟唱原唱，请手动选择「原唱」。原唱不会被当作伴奏自动播出。</p>}
     {!missingAccompaniment&&<p className="perform-hint">{source?`当前音轨：${trackLabel(source)}（${trackIsCached(tracks,source,cached)?'已缓存':'未缓存，请先准备离线演出'}）`:'请选择音轨'}</p>}
     {translations&&current.language!=='zh'&&(
      <div className="perform-translation" role="group" aria-label="演出中文译文">
       <button type="button" aria-pressed={showTranslation} onClick={()=>setShowTranslation(value=>!value)}>
        {translationToggleLabel(current.language,showTranslation)}
       </button>
       <span className="perform-translation__meta">{translationSummary.translated}/{translationSummary.total} 句有中文</span>
      </div>
     )}
    </>}
    {sections.length>0&&<div className="perform-structure-wrap">
      <div className="perform-structure" aria-hidden="true">
        {sections.map(section=><span key={section.id} className={`perform-structure__seg perform-structure__seg--${section.type}${activeSection?.id===section.id?' perform-structure__seg--active':''}`} style={{flexGrow:Math.max(1,section.endMs-section.startMs)}}/>)}
      </div>
      <p className="perform-section-label">{activeSection?`当前段落：${activeSection.label}`:'当前段落：前奏之前'}</p>
    </div>}
    <div className="perform-progress">
      <span className="perform-clock">{formatTime(timeMs)}</span>
      <input className="perform-seek" type="range" aria-label="演出进度" min={0} max={Math.max(1000,durationMs)} step={100} value={position} onChange={e=>seekTo(Number(e.target.value))}/>
      <span className="perform-clock">{formatTime(durationMs)}</span>
    </div>
    <div className="perform-controls">
      <button aria-label="上一首" disabled={index<=0} onClick={()=>setIndex(index-1)}>⏮</button>
      <button className="primary perform-toggle" aria-label={playing?'暂停':'播放'} onClick={()=>void toggle()}>{playing?'⏸':'▶'}</button>
      <button aria-label="重播" disabled={!audioMedia} onClick={()=>void toggle(true)}>↺</button>
      <button aria-label="下一首" disabled={index>=list.length-1} onClick={()=>setIndex(index+1)}>⏭</button>
    </div>
    {notice&&<p role="alert" className="perform-alert">{notice}</p>}
    <audio ref={audio} className="perform-audio" preload="metadata" onLoadedMetadata={handleLoaded} onDurationChange={handleLoaded} onTimeUpdate={()=>{const element=audio.current;if(element)setTimeMs(Math.max(0,Math.round(element.currentTime*1000)-offsetMs));}} onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onEnded={()=>setPlaying(false)} onError={()=>setNotice('音轨加载失败，请检查文件是否已缓存或网络连接。')}/>
    {lyrics.length?<ol className="perform-lyrics" aria-label="同步歌词" ref={lyricsBox}>
      {lyrics.map((line,lineIndex)=>{
        const translation=showTranslation&&!(current.kind==='VOCAL'&&current.language==='zh')?translationByLine.get(line.id):null;
        const redundant=translation?isRedundantTranslation(line.text,translation.text):false;
        return <li key={line.id}>
          <button type="button" className={`perform-line${lineIndex===activeLine?' perform-line--active':''}`} aria-current={lineIndex===activeLine?'true':undefined} onClick={()=>seekTo(line.startMs)}>{line.text}</button>
          {translation&&!redundant&&<span className="perform-line__translation">{translation.text}{translation.stale?'（原文已改）':''}</span>}
        </li>;
      })}
    </ol>
    :current.kind==='DANCE'?null:<><ScrollingText text={current.scoreText||'暂未保存谱或歌词'}/>{current.kind==='VOCAL'&&<p className="perform-hint">这首歌没有带时间戳的歌词，暂不做逐句同步；导入带时间的 LRC 后再显示。</p>}</>}
    {current.kind!=='DANCE'&&current.scores?.map(s=><Suspense key={s.id} fallback={<p>正在打开谱…</p>}><ScoreReader asset={s} offline/></Suspense>)}
   </div>
   <ol className="perform-list" aria-label="当晚节目单">{list.map((item,itemIndex)=><li key={item.kind+item.id}><button className={`perform-list__item${itemIndex===index?' perform-list__item--active':''}`} onClick={()=>setIndex(itemIndex)}><span>{itemIndex+1}. {item.title}</span><small>{kindLabel(item.kind)}</small></button></li>)}</ol>
  </>:<p>没有可演出的曲目，请先加入今晚节目单。</p>}
 </section>;
}
