import { readdir,mkdir,writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename,join,resolve } from 'node:path';
import { fileIdentity } from '../server/media/ffmpeg.mjs';
const root=resolve(process.argv[2]||'导入素材/按作品分割');
const endpoint=process.env.IMPORT_ENDPOINT||'http://127.0.0.1:8791';
const request=async(path,options={})=>{
  const response=await fetch(endpoint+path,{...options,signal:AbortSignal.timeout(120000)});
  const data=await response.json();
  if(!response.ok)throw new Error(`HTTP ${response.status}: ${data.error?.code||'IMPORT_FAILED'}`);
  return data;
};
const existing=await request('/api/catalog');
const known=new Map(existing.items.filter(i=>i.source?.sha256).map(i=>[i.source.sha256,i.id]));
const results=[];
for(const name of (await readdir(root)).filter(n=>n.toLowerCase().endsWith('.mp4')).sort()){
  const file=join(root,name);const before=await fileIdentity(file);
  if(known.has(before.sha256)){results.push({file:name,id:known.get(before.sha256),duplicate:true});continue;}
  const accepted=await request('/api/imports/file',{method:'POST',headers:{'Content-Type':'video/mp4','X-File-Name':encodeURIComponent(basename(name))},body:createReadStream(file),duplex:'half'});
  let job;
  for(let attempt=0;attempt<400;attempt++){
    job=await request(`/api/imports/${accepted.id}`);
    if(['READY','FAILED'].includes(job.status))break;
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  if(job?.status!=='READY')throw new Error(`Import incomplete: ${name}`);
  const item=await request(`/api/imports/${job.id}/finalize`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:name.replace(/\.mp4$/i,''),learningStatus:'WANT_TO_LEARN',sceneTags:[]})});
  const after=await fileIdentity(file);if(before.sha256!==after.sha256)throw new Error('SOURCE_CHANGED');
  known.set(before.sha256,item.id);
  results.push({file:name,id:item.id,sourceSha256:before.sha256,clipSha256:item.audio.sha256,sourceUnchanged:true});
  console.log(`${results.length}: ${name} saved`);
}
await mkdir('var',{recursive:true});
await writeFile('var/import-first-batch.json',JSON.stringify({at:new Date().toISOString(),count:results.length,results},null,2)+'\n');
console.log(`Import batch: ${results.length} items, report var/import-first-batch.json`);
