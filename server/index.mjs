import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readConfig } from './config.mjs';
import { openDatabase } from './db/database.mjs';
import { getCatalog,getDance,getManifest,getPlaylist,setPlaylist,STATUSES,sceneMask,bumpCatalog } from './catalog.mjs';
import { receiveFile,publicJob,finalizeImport,startLinkImport } from './import/import-service.mjs';
import { serveMedia } from './media/http-media.mjs';
import { mimeForContainer } from './media/mime.mjs';
import { deriveClip } from './media/clips.mjs';
import { deleteDance } from './dances/delete.mjs';
import { storeCover } from './media/covers.mjs';
import { normalizeSourceLink } from './security/source-policy.mjs';
import { serveStatic } from './static.mjs';

export function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function readJson(req) {
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>32768)throw new Error('BAD_REQUEST');chunks.push(chunk);}
  const value=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('BAD_REQUEST');
  return value;
}
export function createApiServer(options={}) {
  const ctx={...options,pendingJobs:new Set()};
  const server=createServer(async(req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');const path=url.pathname;
      // CORS：bundled App 的 WebView 源与 API 地址不同源（T089）。
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-File-Name,Range');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range,Accept-Ranges,Content-Length');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method === 'GET' && path === '/api/health') return sendJson(res, 200, { ok: true, recognition: 'disabled' });
      const {db}=ctx;
      if(db&&req.method==='GET'&&path==='/api/catalog') return sendJson(res,200,getCatalog(db,url.searchParams));
      if(db&&req.method==='GET'&&path==='/api/sync/manifest') return sendJson(res,200,getManifest(db));
      if(db&&path==='/api/playlists/tonight'){
        if(req.method==='GET') return sendJson(res,200,getPlaylist(db));
        if(req.method==='PUT'){const body=await readJson(req);return sendJson(res,200,setPlaylist(db,body.items));}
      }
      if(db&&req.method==='POST'&&path==='/api/imports/file') return sendJson(res,202,await receiveFile(req,ctx));
      if(db&&req.method==='POST'&&path==='/api/imports/link') {
        const body=await readJson(req);const link=normalizeSourceLink(body.link);
        return sendJson(res,202,startLinkImport(db,link));
      }
      let match=/^\/api\/imports\/([0-9a-f-]{36})\/supplement$/.exec(path);
      if(db&&match&&req.method==='POST') return sendJson(res,202,await receiveFile(req,ctx,{jobId:match[1]}));
      match=/^\/api\/imports\/([0-9a-f-]{36})(\/finalize)?$/.exec(path);
      if(db&&match){
        if(req.method==='GET'&&!match[2]) {const job=publicJob(db,match[1]);return sendJson(res,job?200:404,job||{error:{code:'NOT_FOUND',message:'请求的内容不存在'}});}
        if(req.method==='POST'&&match[2]) return sendJson(res,201,finalizeImport(db,match[1],await readJson(req)));
      }
      match=/^\/api\/dances\/([0-9a-f-]{36})\/clip$/.exec(path);
      if(db&&match&&req.method==='PUT'){
        const body=await readJson(req);
        return sendJson(res,200,await deriveClip(db,ctx.mediaRoot,match[1],body.startMs,body.endMs));
      }
      match=/^\/api\/dances\/([0-9a-f-]{36})\/cover$/.exec(path);
      if(db&&match&&req.method==='POST') return sendJson(res,200,await storeCover(db,ctx.mediaRoot,match[1],req));
      match=/^\/api\/dances\/([0-9a-f-]{36})$/.exec(path);
      if(db&&match){
        const item=getDance(db,match[1]);if(!item)return sendJson(res,404,{error:{code:'NOT_FOUND',message:'请求的内容不存在'}});
        if(req.method==='GET')return sendJson(res,200,item);
        if(req.method==='DELETE'){
          let body={};
          try{ body=await readJson(req); }catch{ body={}; }
          const deleteMedia=body.deleteMedia===true||url.searchParams.get('media')==='1';
          return sendJson(res,200,deleteDance(db,ctx.mediaRoot,match[1],{deleteMedia}));
        }
        if(req.method==='PATCH'){
          const body=await readJson(req);
          if(body.learningStatus!==undefined&&!STATUSES.includes(body.learningStatus))throw new Error('INVALID_STATUS');
          const mask=body.sceneTags!==undefined?sceneMask(body.sceneTags):sceneMask(item.sceneTags);
          if(body.title!==undefined&&(typeof body.title!=='string'||!body.title.trim()||body.title.length>200))throw new Error('INVALID_TITLE');
          if(body.artist!==undefined&&(typeof body.artist!=='string'||body.artist.length>200))throw new Error('INVALID_ARTIST');
          db.exec('BEGIN IMMEDIATE');
          try{
            db.prepare('UPDATE dance_items SET learning_status=?,scene_mask=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(body.learningStatus||item.learningStatus,mask,item.id);
            db.prepare('UPDATE song_identities SET title=?,artist=?,recognition_status=\'MANUAL\' WHERE id=(SELECT song_identity_id FROM dance_items WHERE id=?)').run(body.title?.trim()||item.title,body.artist===undefined?item.artist:body.artist.trim(),item.id);
            bumpCatalog(db);db.exec('COMMIT');
          }catch(error){db.exec('ROLLBACK');throw error;}
          return sendJson(res,200,getDance(db,item.id));
        }
      }
      match=/^\/api\/media\/(audio|reference|cover)\/([0-9a-f-]{36})$/.exec(path);
      if(db&&match&&['GET','HEAD'].includes(req.method)){
        let row,type;
        if(match[1]==='audio'){row=db.prepare('SELECT internal_audio_path AS path,codec FROM performance_clips WHERE id=?').get(match[2]);type=row?.codec==='mp3'?'audio/mpeg':'audio/mp4';}
        if(match[1]==='reference'){row=db.prepare('SELECT internal_path AS path,video_codec,audio_codec,container,source_kind FROM source_media WHERE id=?').get(match[2]);type=mimeForContainer(row?.container,row?.video_codec?'video':'audio',row?.video_codec||row?.audio_codec);}
        if(match[1]==='cover'){row=db.prepare('SELECT internal_path AS path FROM assets WHERE id=?').get(match[2]);type='image/jpeg';}
        if(row)return serveMedia(req,res,ctx.mediaRoot,row.path,type);
      }
      // 静态资源：Docker/浏览器交付提供 dist（不处理 /api）。
      if(ctx.staticRoot&&!path.startsWith('/api/')&&['GET','HEAD'].includes(req.method))return serveStatic(req,res,ctx.staticRoot,path);
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '请求的内容不存在' } });
    } catch(error) {
      if(res.headersSent){res.destroy();return;}
      const known=['BAD_REQUEST','INVALID_MEDIA','INVALID_STATUS','INVALID_TAGS','INVALID_TITLE','INVALID_ARTIST','INVALID_SOURCE','SOURCE_NOT_ALLOWED','IMPORT_NOT_READY','UPLOAD_TOO_LARGE','NOT_FOUND','INVALID_CLIP','INVALID_PROVIDER_RESPONSE'];
      const code=known.includes(error.message)?error.message:'BAD_REQUEST';
      sendJson(res,error.status||400,{error:{code,message:code==='INVALID_MEDIA'?'文件无法读取，请选择有效视频或音频':'请求无法完成，请检查内容后重试'}});
    }
  });
  const close=server.close.bind(server);
  server.close=callback=>close(async error=>{
    await Promise.allSettled([...ctx.pendingJobs]);
    callback?.(error);
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = readConfig();
  const db = openDatabase(config.dbPath);
  const distPath = resolve('dist');
  const server = createApiServer({db,mediaRoot:config.mediaRoot,staticRoot:existsSync(distPath)?distPath:undefined});
  server.on('error', () => { console.error('服务启动失败，请检查端口配置'); db.close(); process.exitCode = 1; });
  server.listen(config.port, config.host, () => console.log(`Dance API http://${config.host}:${config.port}`));
  const shutdown=()=>server.close(()=>{db.close();process.exit(0);});
  process.on('SIGTERM',shutdown);
  process.on('SIGINT',shutdown);
}
