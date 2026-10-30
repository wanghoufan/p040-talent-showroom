import { useState } from 'react';
import { SCENE_OPTIONS, STATUS_OPTIONS } from '../lib/filters';
import { talentStatuses } from '../lib/repertoire-store';
import type { LearningStatus, SceneTag, TalentKind } from '../lib/types';
export type VocalLanguage = 'ZH' | 'EN' | 'KO';
export interface VocalLanguageValue { status: LearningStatus | null; language: VocalLanguage | null }
const LANGUAGE_OPTIONS: ReadonlyArray<{ id: VocalLanguage; label: string }> = [{ id: 'ZH', label: '中文' }, { id: 'EN', label: '英文' }, { id: 'KO', label: '韩文' }];
const STATUS_OPTIONS_VOCAL: ReadonlyArray<{ id: LearningStatus | null; label: string }> = [{ id: null, label: '全部' }, { id: 'WANT_TO_LEARN', label: '想学' }, { id: 'PRACTICING', label: '练习中' }, { id: 'CAN_DANCE', label: '已学会' }];
// 语言按钮只对真实存在语言的曲目开放；无数据时禁用并明示，不按歌名或歌手猜测。
export function VocalLibraryFilters({ value, availableLanguages, onChange }: { value: VocalLanguageValue; availableLanguages: VocalLanguage[]; onChange: (value: VocalLanguageValue) => void }) {
 const hintId = 'vocal-language-hint', missing = availableLanguages.length === 0;
 return <div className="vocal-filters">
  <div className="vocal-filters__row" role="group" aria-label="按学习状态筛选">
   <span className="vocal-filters__label">状态</span>
   {STATUS_OPTIONS_VOCAL.map(option => <button key={option.label} className="vocal-filters__chip" aria-pressed={value.status === option.id} onClick={() => onChange({ ...value, status: option.id })}>{option.label}</button>)}
  </div>
  <div className="vocal-filters__row" role="group" aria-label="按语言筛选">
   <span className="vocal-filters__label">语言</span>
   <button className="vocal-filters__chip" aria-pressed={!value.language} onClick={() => onChange({ ...value, language: null })}>全部</button>
   {LANGUAGE_OPTIONS.map(option => <button key={option.id} className="vocal-filters__chip" aria-pressed={value.language === option.id} disabled={!availableLanguages.includes(option.id)} aria-describedby={missing ? hintId : undefined} onClick={() => onChange({ ...value, language: option.id })}>{option.label}</button>)}
   {missing && <span className="vocal-filters__hint" id={hintId}>暂无语言信息</span>}
  </div>
 </div>;
}
export interface LibraryFilterValue { status: LearningStatus | null; language?: VocalLanguage | null; scenes: SceneTag[]; demoOnly: boolean; cachedOnly: boolean; }
export default function LibraryFilters({ kind, value, onChange }: { kind: 'DANCE' | TalentKind; value: LibraryFilterValue; onChange: (value: LibraryFilterValue) => void }) {
 const [draft,setDraft]=useState(value),[open,setOpen]=useState(false);
 const statuses=kind==='DANCE'?STATUS_OPTIONS:talentStatuses(kind);
 const labels=[statuses.find(s=>s.id===value.status)?.label,value.scenes.length?`${value.scenes.length}场景`:null,value.demoOnly?'示例':null,value.cachedOnly?'已缓存':null].filter(Boolean);
 return <><button className="filter-entry" aria-label={`筛选${labels.length?'：'+labels.join('、'):''}`} onClick={()=>{setDraft({...value,scenes:[...value.scenes]});setOpen(true);}}>筛选{labels.length>0&&<small>{labels.join(' · ')}</small>}</button>
 {open&&<div className="modal-backdrop"><div className="import-sheet" role="dialog" aria-modal="true" aria-label="曲库筛选"><h2>筛选曲目</h2><fieldset><legend>学习状态</legend><div className="button-row"><button aria-pressed={!draft.status} onClick={()=>setDraft({...draft,status:null})}>全部</button>{statuses.map(s=><button key={s.id} aria-pressed={draft.status===s.id} onClick={()=>setDraft({...draft,status:s.id})}>{s.label}</button>)}</div></fieldset>
 {kind==='DANCE'&&<fieldset><legend>场景（同时满足所选条件）</legend><div className="button-row">{SCENE_OPTIONS.map(s=><button key={s.id} aria-pressed={draft.scenes.includes(s.id)} onClick={()=>setDraft({...draft,scenes:draft.scenes.includes(s.id)?draft.scenes.filter(x=>x!==s.id):[...draft.scenes,s.id]})}>{s.label}</button>)}</div></fieldset>}
 <label className="check-row"><input type="checkbox" checked={draft.demoOnly} onChange={e=>setDraft({...draft,demoOnly:e.target.checked})}/>仅示例</label><label className="check-row"><input type="checkbox" checked={draft.cachedOnly} onChange={e=>setDraft({...draft,cachedOnly:e.target.checked})}/>仅已缓存</label>
 <div className="button-row"><button onClick={()=>setDraft({status:null,scenes:[],demoOnly:false,cachedOnly:false})}>重置</button><button onClick={()=>setOpen(false)}>取消</button><button className="primary" onClick={()=>{onChange(draft);setOpen(false);}}>应用筛选</button></div></div></div>}</>;
}
