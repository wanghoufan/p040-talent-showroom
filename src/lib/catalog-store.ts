import { useCallback,useEffect,useState } from 'react';
import { api } from './api';
import type { DanceItem } from './types';
const KEY='dance.catalog-snapshot';
export function storedCatalog():DanceItem[]{try{return JSON.parse(localStorage.getItem(KEY)||'[]') as DanceItem[];}catch{return [];}}
export function useCatalog(){
  const [items,setItems]=useState<DanceItem[]>(storedCatalog);
  const [error,setError]=useState('');
  const refresh=useCallback(async()=>{
    try {const data=await api<{items:DanceItem[]}>('/api/catalog');setItems(data.items);localStorage.setItem(KEY,JSON.stringify(data.items));setError('');}
    catch{setError('当前无法连接服务器，已显示本地曲库');}
  },[]);
  useEffect(()=>{void refresh();window.addEventListener('dance-catalog-changed',refresh);return()=>window.removeEventListener('dance-catalog-changed',refresh);},[refresh]);
  return {items,error,refresh};
}
export function catalogChanged(){window.dispatchEvent(new Event('dance-catalog-changed'));}
