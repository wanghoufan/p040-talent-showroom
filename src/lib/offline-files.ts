import { uuid } from './uuid';
import {Directory,Filesystem} from '@capacitor/filesystem';import {Capacitor} from '@capacitor/core';import {saveLocalFile,localFiles,deleteLocalFile,localOperations,commitLocal,readMetadata} from './local-database';import {api,apiWithTimeout,jsonBody,ApiError} from './api';import {flushOperations,editLocally,type LocalOperation} from './offline-editing';import {catalogChanged} from './catalog-store';import {rememberRepertoire} from './repertoire-store';import {isMigrationSyncGuardActive,trackSyncWork} from './migration-sync-guard';import {findStoredVideo,linkStoredVideo,readStoredVideo,recoverStoredVideos,stageVideo} from './video-store';import type {TalentItem,ImportJob,DanceItem} from './types';import type {ItemRef} from './library-management';
export interface PendingFile {id:string;path?:string;blob?:Blob;name:string;mime:string;kind:string;itemId:string;state:string;jobId?:string;uploadId?:string;error?:string;title?:string;learningStatus?:string;createFields?:Record<string,unknown>;/** 唱歌：媒体写入哪一条音轨；缺失时后端按旧 audioRole 回退，绝不占用另一条已存在的轨。 */track?:'original'|'accompaniment';/** 唱歌：用户已在曲目页明确确认替换同角色音轨时才为 true，服务端不接受无标记的静默覆盖。 */replace?:boolean;/** 舞蹈视频已转入 video-store 的持久副本；上传与播放都以这份为准。 */videoId?:string;}
/** 读取 LRC 等文本文件：优先 Blob.text，旧 WebView 用 FileReader 兜底；失败必须明确抛错，不能把空字符串当歌词。 */
export async function readLocalText(file:File){const candidate=file as Blob&{text?:()=>Promise<string>};if(typeof candidate.text==='function')return candidate.text();return await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(typeof reader.result==='string'?reader.result:'');reader.onerror=()=>reject(reader.error||Error('歌词文件无法读取'));reader.readAsText(file);});}
function base64(bytes:Uint8Array){let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);}
/** 只有舞蹈库会收视频；视频必须走 video-store 的持久副本，不能再用「传完即删」的临时队列文件。 */
function isVideoFile(file:File){return /^video\//.test(file.type)||/\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(file.name);}
export async function queueFile(file:File,ref:ItemRef,kind:'MEDIA'|'SCORE'='MEDIA',options:{title?:string;learningStatus?:string;id?:string;createFields?:Record<string,unknown>;track?:'original'|'accompaniment';replace?:boolean}={}){
 if(!file.size)throw Error('文件为空，请重新选择');if(file.size>(kind==='SCORE'?25:512)*1024*1024)throw Error('文件超过大小限制');const id=options.id||uuid(),entry:PendingFile={id,name:file.name,mime:file.type||'application/octet-stream',kind:ref.kind+(kind==='SCORE'?':SCORE':''),itemId:ref.id,state:'pending',title:options.title||file.name.replace(/\.[^.]+$/,''),learningStatus:options.learningStatus,createFields:options.createFields,track:ref.kind==='VOCAL'&&kind==='MEDIA'?options.track:undefined,replace:ref.kind==='VOCAL'&&kind==='MEDIA'&&options.replace?true:undefined};
 if(Capacitor.isNativePlatform()){
  if(kind==='MEDIA'&&ref.kind==='DANCE'&&isVideoFile(file)){
   // 先完整落盘并校验（含内容摘要）再入队；上传失败、离线或退出都不会丢源视频。
   const stored=await stageVideo(file);
   entry.videoId=stored.id;
   await saveLocalFile(entry);
  }else{
   entry.path=`dance-pending/${id}`;await Filesystem.mkdir({path:'dance-pending',directory:Directory.Data,recursive:true}).catch(()=>undefined);try{for(let offset=0;offset<file.size;offset+=262144){const data=base64(new Uint8Array(await file.slice(offset,offset+262144).arrayBuffer()));if(!offset)await Filesystem.writeFile({path:entry.path,directory:Directory.Data,data});else await Filesystem.appendFile({path:entry.path,directory:Directory.Data,data});}await saveLocalFile(entry);}catch(e){await Filesystem.deleteFile({path:entry.path,directory:Directory.Data}).catch(()=>undefined);throw e;}
  }
 }else{entry.blob=file;await saveLocalFile(entry);}window.dispatchEvent(new Event('dance-files-changed'));void flushLocalFiles();return entry;
}
class LocalFileError extends Error {}
async function fileBody(entry:PendingFile){
 if(entry.videoId){
  let stored=findStoredVideo(entry.videoId);
  // 冷启动时上传可能先于索引恢复执行：先从 sidecar 补登记，别把已落盘的副本判成不存在。
  if(!stored){await recoverStoredVideos();stored=findStoredVideo(entry.videoId);}
  if(!stored)throw new LocalFileError('手机副本无法读取，请移除待办并重新选择文件');
  try{return await readStoredVideo(stored);}catch{throw new LocalFileError('手机副本无法读取，请移除待办并重新选择文件');}
 }
 if(entry.blob)return entry.blob;
 try{const {uri}=await Filesystem.getUri({path:entry.path!,directory:Directory.Data});const response=await fetch(Capacitor.convertFileSrc(uri));if(!response.ok)throw Error();return await response.blob();}catch{throw new LocalFileError('手机副本无法读取，请移除待办并重新选择文件');}}
let task:Promise<void>|null=null;
/**
 * 后台上传入口（15 秒定时器、前台切换、online、queueFile 都会走这里）。
 * 换机迁移期间必须整体让路：迁移清单只在开始分享时构建一次，上传成功后的 deleteFile
 * 会删掉正在迁移的 dance-pending/<id>，导致建清单失败或接收端连接中断转为致命错误。
 * 保护由 migration-sync-guard 提供，本身不碰这里的 task，也不取消正在跑的上传。
 */
export function flushLocalFiles():Promise<void>{
 if(isMigrationSyncGuardActive())return task??Promise.resolve();
 return task??=trackSyncWork(perform().finally(()=>{task=null;window.dispatchEvent(new Event('dance-files-changed'));}));
}
/** 同一首曲目的离线修改（含整批操作命中的曲目）。 */
function blockingOps(ops:LocalOperation[],itemId:string){return ops.filter(o=>o.action!=='program'&&(o.id===itemId||o.action==='bulk'&&(o.fields?.refs as ItemRef[]||[]).some(r=>r.id===itemId)));}
const BLOCKED_CREATE='这首歌的资料还没同步成功（创建失败或有冲突），音频暂不上传；请先到「同步与待办」处理，再重试此文件';
const BLOCKED_EDIT='这首歌有未同步的歌词/结构修改，音频暂不上传；请先到「同步与待办」处理失败或冲突，再重试此文件';
async function holdFile(entry:PendingFile,error:string){entry.state='blocked';entry.error=error;await saveLocalFile(entry);}
async function perform(){await flushOperations();for(const entry of await localFiles<PendingFile>()){
 // 迁移保护可能在某个文件上传途中才置位：当前这个文件允许传完（此时清单还没构建），
 // 但绝不能再取下一个——每多传一个就多一次 deleteFile，正好删在迁移清单要读的文件上。
 if(isMigrationSyncGuardActive())break;
 if(['failed','duplicate','blocked'].includes(entry.state))continue;
 const ops=blockingOps(await localOperations<LocalOperation>(),entry.itemId);
 // 新曲还在创建中：等它真正落盘再绑定音轨，绝不把媒体挂到不存在的曲目上。
 if(ops.some(o=>!o.state||o.state==='pending'))continue;
 // 同曲修改已失败/冲突：不再静默跳过到天荒地老，明确告诉用户卡在哪、怎么处理。
 if(ops.some(o=>o.state==='failed'||o.state==='conflict')){await holdFile(entry,entry.createFields?BLOCKED_CREATE:BLOCKED_EDIT);continue;}
 try{
 const [kind,score]=entry.kind.split(':');if(score){await apiWithTimeout(`/api/library/${kind}/${entry.itemId}/scores`,{method:'POST',headers:{'Content-Type':entry.mime,'X-Score-Id':entry.id},body:await fileBody(entry)},120000);if(kind!=='DANCE')rememberRepertoire(await api<TalentItem>(`/api/repertoire/${entry.itemId}`));}
 else{if(!entry.jobId){const job=await apiWithTimeout<ImportJob>('/api/imports/file',{method:'POST',headers:{'Content-Type':entry.mime,'X-File-Name':encodeURIComponent(entry.name),'X-Import-Id':entry.uploadId||entry.id},body:await fileBody(entry)},120000);entry.jobId=job.id;await saveLocalFile(entry);if(entry.videoId)await linkStoredVideo(entry.videoId,{jobId:job.id});}const job=await api<ImportJob>(`/api/imports/${entry.jobId}`);if(job.status==='FAILED'){entry.state='failed';entry.error='媒体无法读取，可重试或移除待办';await saveLocalFile(entry);continue;}if(job.status!=='READY')continue;if(entry.createFields&&job.duplicateRefs?.some(r=>r.kind===kind&&r.id!==entry.itemId)){entry.state='duplicate';entry.error='已有相同音频的曲目，请跳过重复文件';await saveLocalFile(entry);continue;}if(kind==='DANCE'){if(!job.duplicateId){const dance=await api<DanceItem>(`/api/imports/${entry.jobId}/finalize`,{method:'POST',...jsonBody({title:entry.title,learningStatus:entry.learningStatus||'WANT_TO_LEARN'})});if(entry.videoId&&dance?.sourceMediaId)await linkStoredVideo(entry.videoId,{jobId:entry.jobId,sourceMediaId:dance.sourceMediaId});}else if(entry.videoId)await linkStoredVideo(entry.videoId,{jobId:entry.jobId});}else{if(entry.createFields){if(!JSON.parse(readMetadata('dance.repertoire-snapshot')||'[]').some((i:ItemRef)=>i.id===entry.itemId))await editLocally({kind:kind as 'GUITAR'|'VOCAL',id:entry.itemId},entry.createFields,'create');await flushOperations();const waiting=blockingOps(await localOperations<LocalOperation>(),entry.itemId);if(waiting.some(o=>o.state==='failed'||o.state==='conflict')){await holdFile(entry,BLOCKED_CREATE);continue;}if(waiting.length)continue;entry.createFields=undefined;await saveLocalFile(entry);}let item:TalentItem;try{item=await api<TalentItem>(`/api/repertoire/${entry.itemId}/media`,{method:'POST',...jsonBody({importJobId:entry.jobId,...(entry.track?{track:entry.track}:{}),...(entry.replace?{replace:true}:{})})});}catch(error){if(error instanceof ApiError&&error.status===409){await holdFile(entry,entry.track?`「${entry.track==='original'?'原唱':'伴奏'}」已有音轨，或与现有文件内容完全相同，已停止覆盖；请到曲目页确认后再替换`:error.message);continue;}throw error;}rememberRepertoire(item);}}
 const results=JSON.parse(readMetadata('dance.file-results')||'[]');await commitLocal({'dance.file-results':JSON.stringify([{id:entry.id,name:entry.name,title:entry.title,state:kind==='DANCE'&&entry.jobId?'已处理（重复曲目自动跳过）':'已收录',itemId:entry.itemId},...results.filter((r:{id:string})=>r.id!==entry.id)].slice(0,100))});await deleteLocalFile(entry.id);if(entry.path)await Filesystem.deleteFile({path:entry.path,directory:Directory.Data}).catch(()=>undefined);catalogChanged();
 }catch(error){if(error instanceof LocalFileError||error instanceof ApiError&&[400,404,413,415,422].includes(error.status)){entry.state='failed';entry.error=error.message;await saveLocalFile(entry);continue;}break;}}}
export async function retryPendingFiles(id?:string){for(const entry of await localFiles<PendingFile>())if(['failed','blocked'].includes(entry.state)&&(!id||entry.id===id)){const keepJob=entry.state==='blocked'&&!!entry.jobId;entry.state='pending';if(!keepJob){entry.jobId=undefined;entry.uploadId=uuid();}await saveLocalFile(entry);}return flushLocalFiles();}

/**
 * 移除一条待办。用户移除待办不等于明确删除视频：video-store 里的持久副本一律保留（可恢复），
 * 需要清掉副本必须由用户在「未完成的收录」里显式点「删除副本」（discardStoredVideo）。
 */
export async function discardPendingFile(id:string){
 // 迁移期间清单已按现有文件算好哈希，此时删 dance-pending/<id> 会让分享端读不到文件、整轮判致命错误。
 // 这里与 flushLocalFiles 共用同一道保护；先停止分享再移除待办。
 if(isMigrationSyncGuardActive())throw Error('正在迁移到新手机：请先停止分享，再移除待上传文件');
 if(task)await task;
 const file=(await localFiles<PendingFile>()).find(f=>f.id===id);
 // 只删待办自己的临时文件（dance-pending/…）；舞蹈视频在 video-store 的副本不在这里，不能顺手删。
 if(file?.path)try{await Filesystem.deleteFile({path:file.path,directory:Directory.Data});}catch(error){if((error as {code?:string})?.code!=='OS-PLUG-FILE-0008')throw error;}
 await deleteLocalFile(id);
 window.dispatchEvent(new Event('dance-files-changed'));
}
