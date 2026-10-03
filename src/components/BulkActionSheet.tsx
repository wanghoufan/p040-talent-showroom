import { useRef,useState } from 'react';
import { bulkRequest,runBulk,type ItemRef } from '../lib/library-management';
export default function BulkActionSheet({action,items,onClose,onDone}:{action:'trash'|'restore'|'purge';items:(ItemRef&{title:string})[];onClose:()=>void;onDone:()=>void}){
 const request=useRef(bulkRequest(action,items.map(({kind,id})=>({kind,id}))));const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const label=action==='trash'?'移入回收站':action==='restore'?'恢复':'永久删除记录';
 async function save(){setBusy(true);setError('');try{await runBulk(request.current);onDone();}catch{setError('操作未完成，所选项目已保留。请连接服务器后重试。');}finally{setBusy(false);}}
 return <div className="modal-backdrop"><section className="import-sheet" role="dialog" aria-modal="true" aria-label={label}><h2>{label} {items.length} 首？</h2><p>{action==='trash'?'可在“我的 → 回收站”恢复；会从今晚节目单移除。':action==='restore'?'恢复曲目，不恢复之前的节目单位置。':'记录删除后无法恢复；原始媒体文件保留。'}</p><ul className="bulk-title-list">{items.map(i=><li key={`${i.kind}:${i.id}`}>{i.title}</li>)}</ul>{error&&<p role="alert">{error}</p>}<div className="button-row"><button disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy} onClick={()=>void save()}>{busy?'正在处理…':label}</button></div></section></div>;
}
