import { createReadStream, statSync } from 'node:fs';
import { controlledPath } from '../security/paths.mjs';
export function serveMedia(req,res,root,name,type) {
  const filename=controlledPath(root,name);
  const size=statSync(filename).size;
  const headers={'Content-Type':type,'Accept-Ranges':'bytes','Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'};
  let start=0,end=size-1,status=200;
  const range=req.headers.range;
  if(range&&!range.includes(',')){
    const match=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(!match||(!match[1]&&!match[2])){res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return;}
    if(!match[1]) start=Math.max(0,size-Number(match[2]));
    else {start=Number(match[1]);if(match[2])end=Math.min(size-1,Number(match[2]));}
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||start>end||Number(match[2])===0&&!match[1]){res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return;}
    status=206;headers['Content-Range']=`bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length']=end-start+1;
  res.writeHead(status,headers);
  if(req.method==='HEAD'){res.end();return;}
  const stream=createReadStream(filename,{start,end});
  stream.on('error',()=>res.destroy());
  res.on('close',()=>stream.destroy());
  stream.pipe(res);
}
