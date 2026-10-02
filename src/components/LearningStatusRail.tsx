import { STATUS_OPTIONS } from '../lib/filters';
import type { DanceItem,LearningStatus } from '../lib/types';
export default function LearningStatusRail({items,value,onChange}:{items:DanceItem[];value:LearningStatus|null;onChange:(next:LearningStatus|null)=>void}){
  return <aside className="status-rail" aria-label="学习状态筛选">{STATUS_OPTIONS.map(({id,label})=><button key={id} aria-pressed={value===id} onClick={()=>onChange(value===id?null:id)}><span>{label}</span><small>{items.filter(i=>i.learningStatus===id).length}</small></button>)}</aside>;
}
