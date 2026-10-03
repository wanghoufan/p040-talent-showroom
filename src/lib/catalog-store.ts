import {mergeRemote} from './offline-editing';
import {readMetadata,writeMetadata} from './local-database';
import { useCallback,useEffect,useState } from 'react';
import { api } from './api';
import type { DanceItem } from './types';
import { readOfflineManifest,saveOfflineManifest } from './offline-manifest';
const KEY='dance.catalog-snapshot';
export function storedCatalog():DanceItem[]{try{return JSON.parse(readMetadata(KEY)||'[]') as DanceItem[];}catch{return [];}}
export function useCatalog(){
  const [items,setItems]=useState<DanceItem[]>(storedCatalog);
  const [error,setError]=useState('');
  const refresh=useCallback(async()=>{
    try {const data=await api<{items:DanceItem[]}>('/api/catalog');data.items=await mergeRemote('DANCE',data.items);setItems(data.items);writeMetadata(KEY,JSON.stringify(data.items));setError('');}
    catch{setError('当前无法连接服务器，已显示本地曲库');}
  },[]);
  useEffect(()=>{const changed=()=>{setItems(storedCatalog());void refresh();};void refresh();window.addEventListener('dance-catalog-changed',changed);return()=>window.removeEventListener('dance-catalog-changed',changed);},[refresh]);
  const applyUpdates=(updated:DanceItem[],catalogVersion:number)=>{
    const updates=new Map(updated.map(item=>[item.id,item]));
    const next=items.map(item=>updates.get(item.id)||item);
    setItems(next);setError('');
    try{
      writeMetadata(KEY,JSON.stringify(next));
      const manifest=readOfflineManifest();
      if(manifest)saveOfflineManifest({...manifest,catalogVersion,items:manifest.items.map(item=>updates.get(item.id)||item)});
    }catch{setError('分类已保存到 Mac Mini，手机未能保存新分类，请检查存储空间后重新同步。');}
  };
  return {items,error,refresh,applyUpdates};
}
export function catalogChanged(){window.dispatchEvent(new Event('dance-catalog-changed'));}
