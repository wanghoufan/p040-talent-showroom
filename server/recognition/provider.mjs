export async function recognizeSafely(provider,audioPath,timeoutMs=8000) {
  if(!provider) return {status:'UNTRIED',candidates:[]};
  const controller=new AbortController();
  let timer;
  try {
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('TIMEOUT'));},timeoutMs);});
    const raw=await Promise.race([Promise.resolve().then(()=>provider(audioPath,{signal:controller.signal})),timeout]);
    if(!Array.isArray(raw)||raw.some(c=>!c||typeof c.title!=='string'||!c.title.trim()||typeof c.artist!=='string'||!Number.isFinite(c.confidence)||c.confidence<0||c.confidence>1)) throw new Error('INVALID_PROVIDER_RESPONSE');
    const candidates=raw.slice(0,5).map(c=>({title:c.title.slice(0,200),artist:c.artist.slice(0,200),confidence:c.confidence}));
    return {status:candidates.length===1?'MATCHED':candidates.length?'AMBIGUOUS':'FAILED',candidates};
  } catch { return {status:'FAILED',candidates:[]}; }
  finally { clearTimeout(timer); }
}
export function mockProvider(candidates=[]) { return async()=>candidates; }
