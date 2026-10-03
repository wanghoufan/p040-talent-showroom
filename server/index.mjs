import QRCode from 'qrcode';
import {authenticateOwner,pairOwner,createRequestSession,publicSession,guestRequest,decideRequest} from './requests/service.mjs';
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {syncOperation} from './sync-operations.mjs';
import {listScores,addScore,setScores} from './scores/service.mjs';
import {listDemo,importDemo,clearDemo} from './library/demo.mjs';
import { bulkLibrary,listTrash } from './library/service.mjs';
import { getProgram,setProgram } from './program/service.mjs';
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
import { bulkUpdateDances } from './dances/bulk-update.mjs';
import { listRepertoire,getRepertoire,saveRepertoire,attachRepertoireMedia,deleteRepertoire } from './repertoire/service.mjs';
import { storeCover } from './media/covers.mjs';
import { normalizeSourceLink } from './security/source-policy.mjs';
import { serveStatic } from './static.mjs';

export function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function readJson(req, maxBytes=32768) {
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw new Error('BAD_REQUEST');chunks.push(chunk);}
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
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-File-Name,X-Import-Id,X-Score-Id,Authorization,Range');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range,Accept-Ranges,Content-Length');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method === 'GET' && path === '/api/health') return sendJson(res, 200, { ok: true, recognition: 'disabled' });
      const {db}=ctx;
      if(db&&path==='/api/pair'&&req.method==='POST')return sendJson(res,200,pairOwner(db,(await readJson(req)).code,ctx.pairCode));
      const publicMatch=/^\/api\/public\/request-sessions\/([A-Za-z0-9_-]{32})(\/requests)?$/.exec(path);
      if(db&&publicMatch){if(req.method==='GET'&&!publicMatch[2])return sendJson(res,200,publicSession(db,publicMatch[1]));if(req.method==='POST'&&publicMatch[2])return sendJson(res,201,guestRequest(db,publicMatch[1],await readJson(req)));return sendJson(res,404,{error:{code:'NOT_FOUND'}});}
      if(db&&path.startsWith('/api/')&&db.prepare('SELECT count(*) AS n FROM owner_credentials').get().n>0&&!authenticateOwner(db,req.headers.authorization?.replace(/^Bearer /,'')||(path.startsWith('/api/media/')?url.searchParams.get('owner'):null)))return sendJson(res,401,{error:{code:'UNAUTHORIZED',message:'请先在“我的”配对这台设备'}});
      if(db&&path==='/api/request-sessions'){
        if(req.method==='GET')return sendJson(res,200,{sessions:db.prepare('SELECT id,token,expires_at AS expiresAt,closed FROM request_sessions ORDER BY expires_at DESC LIMIT 20').all(),requests:db.prepare("SELECT r.*,COALESCE(d.title_override,s.title,t.title,'已删除曲目') AS title FROM guest_requests r LEFT JOIN dance_items d ON r.kind='DANCE' AND d.id=r.item_id LEFT JOIN song_identities s ON s.id=d.song_identity_id LEFT JOIN repertoire_items t ON r.kind<>'DANCE' AND t.id=r.item_id ORDER BY r.created_at DESC LIMIT 400").all()});
        if(req.method==='POST'){if(!authenticateOwner(db,req.headers.authorization?.replace(/^Bearer /,'')))return sendJson(res,401,{error:{code:'UNAUTHORIZED'}});return sendJson(res,201,createRequestSession(db,(await readJson(req)).items));}
      }
      const qrSession=/^\/api\/request-sessions\/([0-9a-f-]{36})\/qr$/.exec(path);if(db&&qrSession&&req.method==='GET'){const row=db.prepare('SELECT token,closed,expires_at FROM request_sessions WHERE id=?').get(qrSession[1]);if(!row||row.closed||row.expires_at<=Date.now())throw Error('NOT_FOUND');const host=req.headers.host;if(typeof host!=='string'||!/^([0-9.]+|localhost)(:\d+)?$/.test(host))throw Error('BAD_REQUEST');return sendJson(res,200,{image:await QRCode.toDataURL(`http://${host}/request/${row.token}`,{margin:2,width:320})});}
      const closeSession=/^\/api\/request-sessions\/([0-9a-f-]{36})$/.exec(path);if(db&&closeSession&&req.method==='DELETE'){db.prepare('UPDATE request_sessions SET closed=1 WHERE id=?').run(closeSession[1]);return sendJson(res,200,{closed:true});}
      if(db&&path==='/api/requests/history'&&req.method==='DELETE'){const result=db.prepare("DELETE FROM guest_requests WHERE state<>'PENDING'").run();return sendJson(res,200,{cleared:result.changes});}
      const decide=/^\/api\/requests\/([0-9a-f-]{36})$/.exec(path);if(db&&decide&&req.method==='POST')return sendJson(res,200,decideRequest(db,decide[1],(await readJson(req)).decision));
      if(db&&req.method==='POST'&&path==='/api/sync/operations')return sendJson(res,200,syncOperation(db,await readJson(req,262144)));
      const scoreMatch=/^\/api\/library\/(DANCE|GUITAR|VOCAL)\/([0-9a-f-]{36})\/scores$/.exec(path);
      if(db&&scoreMatch){const ref={kind:scoreMatch[1],id:scoreMatch[2]};if(req.method==='GET')return sendJson(res,200,listScores(db,ref));if(req.method==='POST')return sendJson(res,201,await addScore(db,ctx.mediaRoot,ref,req));if(req.method==='PUT')return sendJson(res,200,setScores(db,ref,(await readJson(req)).items));}
      const scoreMedia=/^\/api\/media\/score\/([0-9a-f-]{36})$/.exec(path);if(db&&scoreMedia&&['GET','HEAD'].includes(req.method)){const asset=db.prepare('SELECT * FROM score_assets WHERE id=?').get(scoreMedia[1]);if(!asset)return sendJson(res,404,{error:{code:'NOT_FOUND'}});return serveMedia(req,res,ctx.mediaRoot,asset.internal_path,asset.mime);}
      if(db&&path==='/api/demo-library'){if(req.method==='GET')return sendJson(res,200,listDemo(db));if(req.method==='POST')return sendJson(res,200,await importDemo(db,ctx.mediaRoot));if(req.method==='DELETE')return sendJson(res,200,clearDemo(db,ctx.mediaRoot));}
      if(db&&req.method==='POST'&&path==='/api/library/bulk')return sendJson(res,200,bulkLibrary(db,await readJson(req,262144)));
      if(db&&req.method==='GET'&&path==='/api/library/trash')return sendJson(res,200,listTrash(db));
      if(db&&path==='/api/programs/tonight'){
        if(req.method==='GET')return sendJson(res,200,getProgram(db));
        if(req.method==='PUT'){const body=await readJson(req);return sendJson(res,200,setProgram(db,body.items,body.revision));}
      }
      if(db&&req.method==='GET'&&path==='/api/catalog') return sendJson(res,200,getCatalog(db,url.searchParams));
      if(db&&req.method==='GET'&&path==='/api/sync/manifest') return sendJson(res,200,getManifest(db));
      if(db&&path==='/api/repertoire'){
        if(req.method==='GET')return sendJson(res,200,listRepertoire(db,url.searchParams));
        if(req.method==='POST')return sendJson(res,201,saveRepertoire(db,null,await readJson(req,262144)));
      }
      const talentMatch=/^\/api\/repertoire\/([0-9a-f-]{36})(\/media)?$/.exec(path);
      if(db&&talentMatch){
        if(req.method==='POST'&&talentMatch[2])return sendJson(res,200,attachRepertoireMedia(db,talentMatch[1],await readJson(req)));
        if(!talentMatch[2]){
          const item=getRepertoire(db,talentMatch[1]);if(!item)return sendJson(res,404,{error:{code:'NOT_FOUND',message:'曲目不存在'}});
          if(req.method==='GET')return sendJson(res,200,item);
          if(req.method==='PATCH')return sendJson(res,200,saveRepertoire(db,talentMatch[1],await readJson(req,262144)));
          if(req.method==='DELETE')return sendJson(res,200,deleteRepertoire(db,talentMatch[1]));
        }
      }
      if(db&&req.method==='PATCH'&&path==='/api/dances/bulk') return sendJson(res,200,bulkUpdateDances(db,await readJson(req,65536)));
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
      const messages={INVALID_MEDIA:'文件无法读取，请选择有效视频、音频或谱件',UPLOAD_TOO_LARGE:'文件超过大小限制',TOO_MANY_PAGES:'PDF 超过 100 页，请拆分后导入',RATE_LIMIT:'点歌太频繁，请等一分钟再试',QUEUE_FULL:'队列已满，请等待主人处理后再试',NOT_FOUND:'内容不存在，或点歌会话已关闭、过期',UNAUTHORIZED:'请先配对这台设备',CONFLICT:'内容已有新修改，请到同步待办选择保留版本'};
      const known=['BAD_REQUEST','INVALID_STATUS','INVALID_TAGS','INVALID_TITLE','INVALID_ARTIST','INVALID_SOURCE','SOURCE_NOT_ALLOWED','IMPORT_NOT_READY','INVALID_CLIP','INVALID_PROVIDER_RESPONSE',...Object.keys(messages)];
      const code=error.name==='PasswordException'?'ENCRYPTED_PDF':known.includes(error.message)?error.message:'BAD_REQUEST';
      sendJson(res,error.status||400,{error:{code,message:code==='ENCRYPTED_PDF'?'PDF 已加密，请使用未加密文件':messages[code]||'请求无法完成，请检查内容后重试'}});
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
  const pairingFile=resolve(dirname(config.dbPath),'owner-pairing.json');mkdirSync(dirname(pairingFile),{recursive:true});if(!existsSync(pairingFile))writeFileSync(pairingFile,JSON.stringify({code:randomBytes(16).toString('hex')}),{mode:0o600});const pairCode=JSON.parse(readFileSync(pairingFile,'utf8')).code;
  const server = createApiServer({pairCode,db,mediaRoot:config.mediaRoot,staticRoot:existsSync(distPath)?distPath:undefined});
  server.on('error', () => { console.error('服务启动失败，请检查端口配置'); db.close(); process.exitCode = 1; });
  server.listen(config.port, config.host, () => console.log(`Dance API http://${config.host}:${config.port}`));
  const shutdown=()=>server.close(()=>{db.close();process.exit(0);});
  process.on('SIGTERM',shutdown);
  process.on('SIGINT',shutdown);
}
