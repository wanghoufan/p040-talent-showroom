import type { DanceItem,LearningStatus,SceneTag } from './types';
export const STATUS_OPTIONS:ReadonlyArray<{id:LearningStatus;label:string}>=[{id:'CAN_DANCE',label:'会跳'},{id:'PRACTICING',label:'正在练'},{id:'WANT_TO_LEARN',label:'想学'}];
export const SCENE_OPTIONS:ReadonlyArray<{id:SceneTag;label:string}>=[{id:'COOL',label:'耍酷'},{id:'SEXY',label:'性感'},{id:'OUTDOOR',label:'户外'},{id:'TRANSITION',label:'转场'}];
export function filterDances(items:DanceItem[],status:LearningStatus|null,scenes:SceneTag[],query=''):DanceItem[]{
  const q=query.trim().toLocaleLowerCase();
  return items.filter(item=>(!status||item.learningStatus===status)&&scenes.every(scene=>item.sceneTags.includes(scene))&&(!q||`${item.title} ${item.artist}`.toLocaleLowerCase().includes(q)));
}
