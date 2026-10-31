import {api,jsonBody,ApiError} from './api';import {commitLocal,localOperations,readMetadata} from './local-database';import type {ItemRef} from './library-management';import type {DanceItem,TalentItem} from './types';import type {Program} from './program';
export interface LocalOperation extends ItemRef {operationId:string;action:'create'|'update'|'trash'|'restore'|'program'|'bulk';baseRevision:number;fields?:Record<string,unknown>;state?:'pending'|'conflict'|'failed';error?:string;server?:Record<string,unknown>|null;serverRevision?:number;}
const keys={DANCE:'dance.catalog-snapshot',GUITAR:'dance.repertoire-snapshot',VOCAL:'dance.repertoire-snapshot'};
/** 唱歌元数据（与后端 sync-operations 的 VOCAL_METADATA 同一白名单）。 */
const VOCAL_FIELDS=['language','lyrics','sections','practice','translations'] as const;
/** 与后端 MAX_VOCAL_BYTES 一致：离线只排队小改动，完整分析联网走专用接口。 */
const MAX_OPERATION_BYTES=65536;
/** 媒体与版本号不能经离线编辑队列改写：音轨只能走带 importJobId 的导入关联接口。 */
const IMMUTABLE_FIELDS=['tracks','audio','cover','sourceMediaId','performanceClipId','revision','id','kind'];
/**
 * 离线写操作的字段闸门：唱歌的歌词/结构/练习设置只能是「带 baseRevision 的 update」，
 * 且必须是白名单里的已知字段。未知字段不静默丢弃，直接拒绝，避免本地看着成功、同步时才 400。
 */
function acceptedFields(kind:LocalOperation['kind'],action:LocalOperation['action'],fields:Record<string,unknown>):Record<string,unknown>{
 if(IMMUTABLE_FIELDS.some(key=>fields[key]!==undefined))throw Error('音轨与媒体只能在联网时导入');
 const vocal=VOCAL_FIELDS.filter(key=>fields[key]!==undefined);
 if(!vocal.length)return fields;
 if(kind!=='VOCAL'||action!=='update')throw Error('歌词和结构只能逐首保存');
 if(JSON.stringify(fields).length>MAX_OPERATION_BYTES)throw Error('歌词或结构过大，请联网后在曲目页保存');
 if(fields.language!==undefined&&!['zh','en','ko'].includes(fields.language as string))throw Error('语言取值无效');
 if(fields.lyrics!==undefined&&!Array.isArray(fields.lyrics))throw Error('歌词格式无效');
 if(fields.sections!==undefined&&!Array.isArray(fields.sections))throw Error('结构格式无效');
 if(fields.practice!==undefined&&(!fields.practice||typeof fields.practice!=='object'||Array.isArray(fields.practice)))throw Error('练习设置格式无效');
 if(fields.translations!==undefined&&(!fields.translations||typeof fields.translations!=='object'||Array.isArray(fields.translations)||!Array.isArray((fields.translations as {lines?:unknown}).lines)))throw Error('译文格式无效');
 return fields;
}
function snapshot(kind:ItemRef['kind']):(DanceItem|TalentItem)[]{return JSON.parse(readMetadata(keys[kind])||'[]');}
export async function editLocally(ref:ItemRef,fields:Record<string,unknown>,action:LocalOperation['action']='update'){
 const items=snapshot(ref.kind),prior=items.find(i=>i.id===ref.id)||(action==='restore'?JSON.parse(readMetadata('dance.trash')||'[]').find((i:ItemRef)=>i.id===ref.id):undefined);if(action!=='create'&&!prior)throw Error('曲目不存在');
 const patch={...acceptedFields(ref.kind,action,fields)};
 // 练习设置按服务端口径增量合并：只改一项时不把其余默认值清空。
 if(patch.practice&&typeof patch.practice==='object'&&!Array.isArray(patch.practice))patch.practice={...(prior?.practice||{}),...patch.practice as Record<string,unknown>};
 const op:LocalOperation={...ref,operationId:crypto.randomUUID(),action,baseRevision:prior?.revision||0,...(['create','update'].includes(action)?{fields:patch}:{})};
 const item={...(action==='create'?{id:ref.id,kind:ref.kind,title:'',artist:'',learningStatus:'WANT_TO_LEARN',originalKey:'',performanceKey:'',capo:0,scoreText:'',notes:'',audioRole:'REFERENCE',durationMs:0,revision:0}:prior),...patch};const next=action==='trash'?items.filter(i=>i.id!==ref.id):[...items.filter(i=>i.id!==ref.id),item];const values:Record<string,string>={[keys[ref.kind]]:JSON.stringify(next)};
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
 // 用户改完再存 = 明确的新意图：更早那条被服务器拒绝的 update 从未落盘，允许被后来的同曲修改取代，
 // 否则一次失败就能把这首歌的修改和音频待办永久堵死。冲突仍需用户当面选择，不在此列。
 const all=await localOperations<LocalOperation&{createdAt?:number}>();
 const superseded=all.filter(op=>op.state==='failed'&&op.action==='update'&&all.some(o=>o.action==='update'&&o.kind===op.kind&&o.id===op.id&&(o.createdAt||0)>(op.createdAt||0)&&o.state!=='failed'));
 if(superseded.length)await commitLocal({},[],superseded.map(op=>op.operationId));
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
 // 整批通道不承载单首的歌词/结构，避免逐句改动被批处理覆盖。
 if(fields&&VOCAL_FIELDS.some(key=>fields[key]!==undefined))throw Error('歌词和结构只能逐首保存');
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
