import { SCENE_OPTIONS } from '../lib/filters';
import type { SceneTag } from '../lib/types';
export default function SceneTagBar({value,onChange}:{value:SceneTag[];onChange:(next:SceneTag[])=>void}){
  return <div className="scene-bar" aria-label="场景筛选"><button aria-pressed={!value.length} onClick={()=>onChange([])}>全部</button>{SCENE_OPTIONS.map(({id,label})=><button key={id} aria-pressed={value.includes(id)} onClick={()=>onChange(value.includes(id)?value.filter(t=>t!==id):[...value,id])}>{label}</button>)}</div>;
}
