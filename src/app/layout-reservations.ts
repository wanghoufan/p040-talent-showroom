/** Measure actual docks, including safe-area/font scaling, instead of assuming a fixed player height. */
export function observeLayoutReservations(shell: HTMLElement): () => void {
 let observed: Element[]=[];
 const measure=()=>{
  const tabs=shell.querySelector<HTMLElement>('.tabbar');
  const docks=[...shell.querySelectorAll<HTMLElement>('.mini-player,.batch-actions')].filter(e=>!e.hidden&&getComputedStyle(e).display!=='none');
  const tabHeight=Math.ceil(tabs?.getBoundingClientRect().height||72);
  const dockHeight=Math.ceil(Math.max(0,...docks.map(e=>e.getBoundingClientRect().height)));
  for(const [key,value] of [['--tabbar-height',`${tabHeight}px`],['--dock-height',`${dockHeight}px`]])if(shell.style.getPropertyValue(key)!==value)shell.style.setProperty(key,value);
 };
 const resize=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);
 const refresh=()=>{const next=[...shell.querySelectorAll('.tabbar,.mini-player,.batch-actions')];if(next.length!==observed.length||next.some((e,i)=>e!==observed[i])){resize?.disconnect();next.forEach(e=>resize?.observe(e));observed=next;}measure();};
 const mutations=new MutationObserver(refresh);mutations.observe(shell,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','class']});
 // Android 系统栏 inset 变化只改 tabbar 的 padding（不改 content-box），ResizeObserver 不触发，需显式重测。
 const onInsets=()=>measure();
 window.addEventListener('resize',measure);window.addEventListener('dance-insets-changed',onInsets);refresh();return()=>{resize?.disconnect();mutations.disconnect();window.removeEventListener('resize',measure);window.removeEventListener('dance-insets-changed',onInsets);};
}
