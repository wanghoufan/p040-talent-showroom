import {flushOperations,type LocalOperation} from '../lib/offline-editing';
import {discardPendingFile,flushLocalFiles,type PendingFile} from '../lib/offline-files';
import {cacheProgram} from '../lib/program';
import {localOperations,localFiles,writeMetadata} from '../lib/local-database';
import {useState} from 'react';
import {api} from '../lib/api';
import {syncLibrary} from '../lib/sync';
import {catalogChanged} from '../lib/catalog-store';
import {cacheRepertoire} from '../lib/repertoire-store';
import {readOfflineManifest,saveOfflineManifest,readCachedIndex,saveCachedIndex} from '../lib/offline-manifest';
import {removeCached} from '../native/filesystem';
import type {OfflineManifest} from '../lib/types';
export default function DemoControls({onChanged}:{onChanged?:()=>Promise<void>}){const [count,setCount]=useState(()=>{const m=readOfflineManifest();return [...(m?.items||[]),...(m?.repertoire||[])].filter(i=>i.isDemo).length;}),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false),[message,setMessage]=useState('');
 async function manage(clear=false){setBusy(true);setMessage('');try{
  if(clear){await flushLocalFiles();await flushOperations();const before=readOfflineManifest(),demoIds=new Set([...(before?.items||[]),...(before?.repertoire||[])].filter(i=>i.isDemo).map(i=>i.id));if((await localOperations<LocalOperation>()).some(op=>demoIds.has(op.id)||(op.action==='bulk'&&(op.fields?.refs as {id:string}[]||[]).some(r=>demoIds.has(r.id))))){setMessage('示例还有未解决的修改，请先在同步与待办处理冲突后清除。');return;}const result=await api<{removedMedia:string[];cleared:{kind:string;id:string}[]}>('/api/demo-library',{method:'DELETE'});const cached=readCachedIndex();for(const [key,hit] of Object.entries(cached))if(result.removedMedia.some(id=>key.endsWith('/'+id))){await removeCached(hit.path);delete cached[key];}saveCachedIndex(cached);for(const file of await localFiles<PendingFile>())if(result.cleared.some(r=>r.id===file.itemId))await discardPendingFile(file.id);const manifest=readOfflineManifest();if(manifest)saveOfflineManifest({...manifest,items:manifest.items.filter(i=>!result.cleared.some(r=>r.kind==='DANCE'&&r.id===i.id)),repertoire:manifest.repertoire?.filter(i=>!result.cleared.some(r=>r.id===i.id))});}
  else await api('/api/demo-library',{method:'POST',signal:AbortSignal.timeout(120000)});
  const snapshot=await api<OfflineManifest>('/api/sync/manifest');setCount([...snapshot.items,...(snapshot.repertoire||[])].filter(i=>i.isDemo).length);saveOfflineManifest(snapshot);if(snapshot.program)cacheProgram(snapshot.program);writeMetadata('dance.catalog-snapshot',JSON.stringify(snapshot.items));cacheRepertoire(snapshot.repertoire||[]);catalogChanged();
  if(!clear){const result=await syncLibrary(undefined,{demoOnly:true});setMessage(result.mediaSupported?(result.complete?'三类示例已导入并下载到手机，可断网试用。':'示例已导入；部分下载失败，可再点此按钮补齐。'):'三类示例已导入；请在手机 App 下载后离线试用。');}else setMessage('示例已清除，普通曲目保留。');setConfirm(false);await onChanged?.();
 }catch{setMessage('操作未完成，已有数据保留，请检查连接后重试。');}finally{setBusy(false);}}
 return <div className="settings-block"><h2>试用示例</h2><p>已导入 {count}/3 首</p><p>舞蹈、吉他、唱歌各一首，独立标记。重复导入会保留你对示例的修改。</p><div className="button-row"><button disabled={busy} onClick={()=>void manage()}>下载并导入示例</button><button disabled={busy} onClick={()=>setConfirm(true)}>清除示例</button></div>{message&&<p role="status">{message}</p>}{confirm&&<div className="modal-backdrop"><section className="import-sheet" role="dialog" aria-modal="true" aria-label="清除示例"><h2>清除全部试用示例？</h2><p>包含你编辑过的示例和节目单中的示例；普通曲目及其媒体保留。</p><div className="button-row"><button disabled={busy} onClick={()=>setConfirm(false)}>取消</button><button disabled={busy} onClick={()=>void manage(true)}>确认清除示例</button></div></section></div>}</div>;
}
