// Connect only to the explicitly forwarded WebView of this project's debug App.
const pages=await (await fetch('http://127.0.0.1:9225/json/list')).json();
const page=pages.find(p=>p.title==='舞蹈曲库'&&['http://127.0.0.1:5173','https://localhost','http://localhost'].some(origin=>p.url.startsWith(origin)));
if(!page)throw new Error('Project WebView not found');
if(['tap','replace','type','drag'].includes(process.argv[2])&&!JSON.parse(page.description||'{}').visible)throw new Error('Project App is not in the foreground; no touch dispatched');
const socket=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
let id=0;const pending=new Map();
socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id){const call=pending.get(message.id);if(call){pending.delete(message.id);message.error?call.reject(new Error(message.error.message)):call.resolve(message.result);}}});
const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;const timeout=setTimeout(()=>{pending.delete(n);reject(Error('Device command timed out'));},10000);pending.set(n,{resolve:value=>{clearTimeout(timeout);resolve(value);},reject:error=>{clearTimeout(timeout);reject(error);}});socket.send(JSON.stringify({id:n,method,params}));});
const evaluate=async expression=>{
  const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw new Error('Device expression failed');
  return result.result.value;
};
try{
  if(process.argv[2]==='tap'){
    const selector=process.argv[3];
    const rect=await evaluate(`(()=>{const s=${JSON.stringify(selector)};const e=s.startsWith("text:")?[...document.querySelectorAll("button,a")].find(e=>e.innerText.trim()===s.slice(5)):document.querySelector(s);if(!e)throw Error();e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height};})()`);
    if(rect.width<1||rect.height<1)throw new Error('Target is not visible');
    await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:rect.x,y:rect.y}]});
    await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await new Promise(resolve=>setTimeout(resolve,300));
    console.log(JSON.stringify({action:'tap',selector,rect}));
  }else if(process.argv[2]==='replace'){
    const selector=process.argv[3];
    const rect=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[rect]});await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await call('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await call('Input.insertText',{text:process.argv[4]||''});console.log(JSON.stringify({action:'replace',selector}));
  }else if(process.argv[2]==='type'){
    await call('Input.insertText',{text:process.argv[3]||''});
    console.log(JSON.stringify({action:'type',characters:(process.argv[3]||'').length}));
  }else if(process.argv[2]==='drag'){
    // drag <selector> <dy>: 从元素中心按下并纵向拖动 dy 像素（真实触摸手势）。
    const selector=process.argv[3];
    const dy=Number(process.argv[4]||0);
    const rect=await evaluate(`(()=>{const s=${JSON.stringify(selector)};const e=s.startsWith("text:")?[...document.querySelectorAll("button,a")].find(e=>e.innerText.trim()===s.slice(5)):document.querySelector(s);if(!e)throw Error();e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    const steps=12;
    await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:rect.x,y:rect.y}]});
    for(let i=1;i<=steps;i++){
      await call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:rect.x,y:rect.y+(dy*i)/steps}]});
      await new Promise(r=>setTimeout(r,16));
    }
    await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    console.log(JSON.stringify({action:'drag',selector,from:{x:Math.round(rect.x),y:Math.round(rect.y)},dy}));
  }else{
    console.log(JSON.stringify(await evaluate(process.argv[3]||'({title:document.title,url:location.href,text:document.body.innerText.slice(0,1200)})')));
  }
}finally{socket.close();}
