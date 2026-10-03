import {api,jsonBody,ApiError} from './api';import {commitLocal,localOperations,readMetadata} from './local-database';import type {ItemRef} from './library-management';import type {DanceItem,TalentItem} from './types';import type {Program} from './program';
export interface LocalOperation extends ItemRef {operationId:string;action:'create'|'update'|'trash'|'restore'|'program'|'bulk';baseRevision:number;fields?:Record<string,unknown>;state?:'pending'|'conflict'|'failed';error?:string;server?:Record<string,unknown>|null;serverRevision?:number;}
const keys={DANCE:'dance.catalog-snapshot',GUITAR:'dance.repertoire-snapshot',VOCAL:'dance.repertoire-snapshot'};
function snapshot(kind:ItemRef['kind']):(DanceItem|TalentItem)[]{return JSON.parse(readMetadata(keys[kind])||'[]');}
export async function editLocally(ref:ItemRef,fields:Record<string,unknown>,action:LocalOperation['action']='update'){
 const items=snapshot(ref.kind),prior=items.find(i=>i.id===ref.id)||(action==='restore'?JSON.parse(readMetadata('dance.trash')||'[]').find((i:ItemRef)=>i.id===ref.id):undefined);if(action!=='create'&&!prior)throw Error('曲目不存在');const op:LocalOperation={...ref,operationId:crypto.randomUUID(),action,baseRevision:prior?.revision||0,...(['create','update'].includes(action)?{fields}:{})};
 const item={...(action==='create'?{id:ref.id,kind:ref.kind,title:'',artist:'',learningStatus:'WANT_TO_LEARN',originalKey:'',performanceKey:'',capo:0,scoreText:'',notes:'',audioRole:'REFERENCE',durationMs:0,revision:0}:prior),...fields};const next=action==='trash'?items.filter(i=>i.id!==ref.id):[...items.filter(i=>i.id!==ref.id),item];const values:Record<string,string>={[keys[ref.kind]]:JSON.stringify(next)};
 const manifest=JSON.parse(readMetadata('dance.offline.manifest')||'null');if(manifest){if(ref.kind==='DANCE')manifest.items=next;else manifest.repertoire=next;if(action==='trash'){manifest.playlist=manifest.playlist.filter((id:string)=>id!==ref.id);if(manifest.program)manifest.program.items=manifest.program.items.filter((r:ItemRef)=>r.id!==ref.id);}values['dance.offline.manifest']=JSON.stringify(manifest);}
 let trash=JSON.parse(readMetadata('dance.trash')||'[]');if(action==='trash')trash=[...trash.filter((i:ItemRef)=>i.id!==ref.id),{...prior,kind:ref.kind,deletedAt:new Date().toISOString()}];if(action==='restore')trash=trash.filter((i:ItemRef)=>i.id!==ref.id);values['dance.trash']=JSON.stringify(trash);
 if(action==='trash'){const program=JSON.parse(readMetadata('dance.program')||'null');if(program){program.items=program.items.filter((r:ItemRef)=>r.id!==ref.id);values['dance.program']=JSON.stringify(program);}}
 await commitLocal(values,[op]);notify();void flushOperations();return item as TalentItem;
}
export async function programLocally(program:Program){await commitLocal({'dance.program':JSON.stringify(program)},[{operationId:crypto.randomUUID(),kind:'DANCE',id:'program',action:'program',baseRevision:program.revision,fields:{items:program.items}}]);notify();void flushOperations();return program;}
export async function mergeRemote<T extends {id:string;revision?:number}>(kind:ItemRef['kind'],remote:T[]):Promise<T[]>{const ops=await localOperations<LocalOperation>(),pending=new Set(ops.filter(o=>o.action!=='program').flatMap(o=>o.action==='bulk'?(o.fields?.refs as ItemRef[]).filter(r=>r.kind===kind).map(r=>r.id):o.kind===kind?[o.id]:[])),local=snapshot(kind) as unknown as T[],trash=JSON.parse(readMetadata('dance.trash')||'[]');const remoteItems=remote.filter(i=>!pending.has(i.id)&&!trash.some((t:ItemRef&{revision:number})=>t.kind===kind&&t.id===i.id&&(t.revision||0)>(i.revision||0))).map(i=>{const prior=local.find(l=>l.id===i.id);return prior&&(prior.revision||0)>(i.revision||0)?prior:i;});return [...remoteItems,...local.filter(i=>pending.has(i.id))];}

function notify(){window.dispatchEvent(new Event('dance-repertoire-changed'));window.dispatchEvent(new Event('dance-catalog-changed'));window.dispatchEvent(new Event('dance-sync-changed'));window.dispatchEvent(new Event('dance-program-changed'));}
let flushTask:Promise<void>|null=null;
export function flushOperations():Promise<void>{return flushTask??=performFlush().finally(()=>{flushTask=null;});}
function operationRefs(op:LocalOperation):ItemRef[]{return op.action==='program'?[]:op.action==='bulk'?(op.fields?.refs as ItemRef[]||[]):[{kind:op.kind,id:op.id}];}
function related(a:LocalOperation,b:LocalOperation){return a.action==='program'&&b.action==='program'||operationRefs(a).some(r=>operationRefs(b).some(x=>r.kind===x.kind&&r.id===x.id));}
async function performFlush(){
 for(const original of await localOperations<LocalOperation>()){
  const queue=await localOperations<LocalOperation>(),op=queue.find(o=>o.operationId===original.operationId);
  if(!op||['conflict','failed'].includes(op.state||'')||queue.some(o=>['conflict','failed'].includes(o.state||'')&&related(o,op)))continue;
  const {operationId,kind,id,action,baseRevision,fields}=op;
  let result:{status:string;item?:Record<string,unknown>;items?:Record<string,unknown>[];revision:number;revisions?:({revision:number}&ItemRef)[];programRevision?:number;program?:Program;server?:Record<string,unknown>|null};
  try{result=await api('/api/sync/operations',{method:'POST',...jsonBody({operationId,kind,id,action,baseRevision,...(fields?{fields}:{})})});}catch(error){if(error instanceof ApiError&&[400,404,413,422].includes(error.status)){await commitLocal({},[{...op,state:'failed',error:error.message}]);notify();continue;}break;}
  if(result.status==='conflict'){await commitLocal({},[{...op,state:'conflict',server:result.server,serverRevision:result.revision}]);window.dispatchEvent(new Event('dance-sync-changed'));continue;}
  const later=(await localOperations<LocalOperation>()).filter(o=>o.operationId!==operationId),values:Record<string,string>={},replacements=new Map<string,LocalOperation>();
  const refs=operationRefs(op),revisions=result.revisions||refs.map(r=>({...r,revision:result.revision}));
  for(const ref of revisions){
   const future=later.find(o=>operationRefs(o).some(r=>r.kind===ref.kind&&r.id===ref.id));
   if(future){const next=replacements.get(future.operationId)||future;replacements.set(next.operationId,next.action==='bulk'?{...next,fields:{...next.fields,baseRevisions:{...(next.fields?.baseRevisions as object),[ref.id]:ref.revision}}}:{...next,baseRevision:ref.revision});}
  }
  for(const refKind of new Set(refs.map(r=>r.kind))){
   const current=snapshot(refKind),updated=current.map(item=>{
    const revision=revisions.find(r=>r.id===item.id);if(!revision)return item;
    const remote=(result.items||[result.item]).find(i=>i?.id===item.id);const future=later.some(o=>operationRefs(o).some(r=>r.id===item.id));return !future&&remote?remote:{...item,revision:revision.revision};
   });values[keys[refKind]]=JSON.stringify(updated);
  }
  const futureProgram=later.find(o=>o.action==='program');if(action==='program'&&!futureProgram&&result.item)values['dance.program']=JSON.stringify(result.item);
  if(result.program){
   // Deleting a scheduled item advances the program revision too. Preserve
   // later local removals while adopting the resulting server program.
   const program=futureProgram?JSON.parse(readMetadata('dance.program')||'{}'):result.program;
   const removed=later.filter(o=>o.action==='trash'||o.action==='bulk'&&o.fields?.action==='trash').flatMap(operationRefs);
   values['dance.program']=JSON.stringify({...program,revision:result.program.revision,items:program.items.filter((r:ItemRef)=>!removed.some(x=>x.kind===r.kind&&x.id===r.id))});
  }
  if(futureProgram&&result.programRevision!==undefined)replacements.set(futureProgram.operationId,{...futureProgram,baseRevision:result.programRevision});
  const trash=JSON.parse(readMetadata('dance.trash')||'[]');values['dance.trash']=JSON.stringify(trash.filter((i:ItemRef)=>{const restored=(action==='restore'||action==='bulk'&&fields?.action==='restore')&&refs.some(r=>r.id===i.id);return !restored||later.some(o=>(o.action==='trash'||o.action==='bulk'&&o.fields?.action==='trash')&&operationRefs(o).some(r=>r.id===i.id));}).map((i:ItemRef)=>{const r=revisions.find(r=>r.id===i.id);return r?{...i,revision:r.revision}:i;}));
  const manifest=JSON.parse(readMetadata('dance.offline.manifest')||'null');if(manifest){if(values[keys.DANCE])manifest.items=JSON.parse(values[keys.DANCE]);if(values[keys.GUITAR])manifest.repertoire=JSON.parse(values[keys.GUITAR]);if(values['dance.program'])manifest.program=JSON.parse(values['dance.program']);values['dance.offline.manifest']=JSON.stringify(manifest);}
  await commitLocal(values,[...replacements.values()],[operationId]);notify();
 }
}
export async function resolveOperation(op:LocalOperation,fields:Record<string,unknown>|null){
 const values:Record<string,string>={},queue=await localOperations<LocalOperation>(),later=queue.filter(o=>o.operationId!==op.operationId&&related(o,op));let replacement:LocalOperation|null=null;
 if(op.action==='bulk'){
  const refs=operationRefs(op),serverItems=(op.server?.items||[]) as (ItemRef&{revision:number;deletedAt?:string})[];
  if(fields===null){const current=snapshot(op.kind);values[keys[op.kind]]=JSON.stringify([...current.filter(i=>!refs.some(r=>r.id===i.id)),...serverItems.filter(i=>!i.deletedAt)]);}
  else{const baseRevisions=Object.fromEntries(serverItems.map(i=>[i.id,i.revision]));replacement={...op,operationId:crypto.randomUUID(),fields:{...op.fields,...(op.fields?.action==='update'?{fields}:{}),baseRevisions},state:'pending',server:undefined,serverRevision:undefined};}
 }else if(fields===null){
  if(op.action==='program')values['dance.program']=JSON.stringify(op.server);else values[keys[op.kind]]=JSON.stringify([...snapshot(op.kind).filter(i=>i.id!==op.id),...(op.server&&!op.server.deletedAt?[op.server]:[])]);
 }else replacement={...op,operationId:crypto.randomUUID(),action:op.server?.deletedAt&&op.action==='update'?'restore':op.action==='create'&&op.server?'update':!op.server&&op.kind!=='DANCE'&&op.action==='update'?'create':op.action,baseRevision:op.serverRevision||0,fields:['trash','restore'].includes(op.action)?undefined:fields,state:'pending',server:undefined,serverRevision:undefined};
 if(fields===null&&op.action!=='program'){
  const refs=operationRefs(op),remote:(ItemRef&{revision?:number;deletedAt?:unknown})[]=op.action==='bulk'?(op.server?.items||[]) as (ItemRef&{revision:number;deletedAt?:string})[]:op.server?[{...op.server,kind:op.kind,id:op.id}]:[];
  const trash=JSON.parse(readMetadata('dance.trash')||'[]').filter((i:ItemRef)=>!refs.some(r=>r.id===i.id));values['dance.trash']=JSON.stringify([...trash,...remote.filter(i=>i.deletedAt)]);
 }
 // Adopting the server resolves this operation only. Replay later drafts so
 // unrelated edits, deletes and program changes stay visible across restart.
 if(fields===null)for(const next of later){
  if(next.action==='program'){values['dance.program']=JSON.stringify({...JSON.parse(values['dance.program']||readMetadata('dance.program')||'{}'),...next.fields});continue;}
  for(const ref of operationRefs(next)){
   const key=keys[ref.kind],items=JSON.parse(values[key]||readMetadata(key)||'[]'),trash=JSON.parse(values['dance.trash']||readMetadata('dance.trash')||'[]');
   const prior=items.find((i:ItemRef)=>i.id===ref.id)||trash.find((i:ItemRef)=>i.id===ref.id)||snapshot(ref.kind).find(i=>i.id===ref.id);
   const action=next.action==='bulk'?next.fields?.action:next.action;
   const draft=(next.action==='bulk'?next.fields?.fields:next.fields) as Record<string,unknown>||{};
   const item={...prior,...draft};delete item.sceneMode;
   if(draft.sceneTags){const tags=draft.sceneTags as string[],old=(prior?.sceneTags||[]) as string[];item.sceneTags=draft.sceneMode==='add'?[...new Set([...old,...tags])]:draft.sceneMode==='remove'?old.filter(t=>!tags.includes(t)):tags;}
   if(action==='trash'){values[key]=JSON.stringify(items.filter((i:ItemRef)=>i.id!==ref.id));values['dance.trash']=JSON.stringify([...trash.filter((i:ItemRef)=>i.id!==ref.id),{...item,...ref,deletedAt:new Date().toISOString()}]);}
   else{delete item.deletedAt;values[key]=JSON.stringify([...items.filter((i:ItemRef)=>i.id!==ref.id),item]);values['dance.trash']=JSON.stringify(trash.filter((i:ItemRef)=>i.id!==ref.id));}
  }
 }
 const manifest=JSON.parse(readMetadata('dance.offline.manifest')||'null');if(manifest){if(values[keys.DANCE])manifest.items=JSON.parse(values[keys.DANCE]);if(values[keys.GUITAR])manifest.repertoire=JSON.parse(values[keys.GUITAR]);values['dance.offline.manifest']=JSON.stringify(manifest);}
 await commitLocal(values,[...(replacement?[replacement]:[]),...(!replacement&&later[0]?[later[0].action==='bulk'?{...later[0],fields:{...later[0].fields,baseRevisions:{...(later[0].fields?.baseRevisions as object),...(op.action==='bulk'?Object.fromEntries(((op.server?.items||[]) as (ItemRef&{revision:number})[]).map(i=>[i.id,i.revision])):{[op.id]:op.serverRevision||0})}}}:{...later[0],baseRevision:op.serverRevision||0}]:[])],[op.operationId]);notify();void flushOperations();
}
export async function bulkLocally(action:'update'|'trash'|'restore',refs:ItemRef[],fields?:Record<string,unknown>){
 const kind=refs[0]?.kind;if(!kind||new Set(refs.map(r=>r.kind+':'+r.id)).size!==refs.length)throw Error('请选择有效曲目');
 const nextByKey=new Map<string,(DanceItem|TalentItem)[]>(),baseRevisions:Record<string,number>={},changed=[];let trash=JSON.parse(readMetadata('dance.trash')||'[]');
 for(const ref of refs){const key=keys[ref.kind],items=nextByKey.get(key)||snapshot(ref.kind),item=(action==='restore'?[...trash].reverse():items).find((i:ItemRef)=>i.id===ref.id);if(!item)throw Error('曲目不存在');baseRevisions[ref.id]=item.revision||0;
  if(action==='trash'){nextByKey.set(key,items.filter(i=>i.id!==ref.id));trash=[...trash.filter((i:ItemRef)=>i.id!==ref.id),{...item,kind:ref.kind,deletedAt:new Date().toISOString()}];}
  else{const update={...item,...fields};delete update.sceneMode;if(fields?.sceneTags){const tags=fields.sceneTags as string[];update.sceneTags=fields.sceneMode==='add'?[...new Set([...item.sceneTags,...tags])]:fields.sceneMode==='remove'?item.sceneTags.filter((t:string)=>!tags.includes(t)):tags;}delete update.deletedAt;nextByKey.set(key,[...items.filter(i=>i.id!==ref.id),update]);changed.push(update);if(action==='restore')trash=trash.filter((i:ItemRef)=>i.id!==ref.id);}
 }
 const values:Record<string,string>={'dance.trash':JSON.stringify(trash)};for(const [key,next] of nextByKey)values[key]=JSON.stringify(next);
 const manifest=JSON.parse(readMetadata('dance.offline.manifest')||'null');if(manifest){if(values[keys.DANCE])manifest.items=JSON.parse(values[keys.DANCE]);if(values[keys.GUITAR])manifest.repertoire=JSON.parse(values[keys.GUITAR]);if(action==='trash'){manifest.playlist=manifest.playlist.filter((id:string)=>!refs.some(r=>r.id===id));if(manifest.program)manifest.program.items=manifest.program.items.filter((r:ItemRef)=>!refs.some(i=>i.id===r.id));}values['dance.offline.manifest']=JSON.stringify(manifest);}
 if(action==='trash'){const program=JSON.parse(readMetadata('dance.program')||'null');if(program){program.items=program.items.filter((r:ItemRef)=>!refs.some(i=>i.id===r.id));values['dance.program']=JSON.stringify(program);}}
 await commitLocal(values,[{operationId:crypto.randomUUID(),kind,id:crypto.randomUUID(),action:'bulk',baseRevision:0,fields:{action,refs,baseRevisions,...(fields?{fields}:{})}}]);notify();void flushOperations();return {items:changed,catalogVersion:manifest?.catalogVersion||0};
}

export async function retryOperation(op:LocalOperation){await commitLocal({},[{...op,state:"pending",error:undefined}]);notify();await flushOperations();}
