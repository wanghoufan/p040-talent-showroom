import { useEffect, useState } from 'react';
import { api } from './api';
import type { DanceItem, TalentItem, TalentKind } from './types';
import { readOfflineManifest, saveOfflineManifest } from './offline-manifest';
const KEY = 'dance.repertoire-snapshot';
export const talentLabel = (kind: TalentKind) => kind === 'GUITAR' ? '吉他' : '唱歌';
export const talentStatuses = (kind: TalentKind) => [{ id: 'WANT_TO_LEARN', label: '想学' }, { id: 'PRACTICING', label: '正在练' }, { id: 'CAN_DANCE', label: kind === 'GUITAR' ? '会弹' : '会唱' }] as const;
export function storedRepertoire(): TalentItem[] { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } }
export function cacheRepertoire(items: TalentItem[]): void {
 localStorage.setItem(KEY, JSON.stringify(items));
 const manifest = readOfflineManifest(); if (manifest) saveOfflineManifest({ ...manifest, repertoire: items });
 window.dispatchEvent(new Event('dance-repertoire-changed'));
}
export function rememberRepertoire(item: TalentItem): void { cacheRepertoire([item, ...storedRepertoire().filter(x => x.id !== item.id)]); }
export function useRepertoire() {
 const [items, setItems] = useState(storedRepertoire), [error, setError] = useState(''), [loaded, setLoaded] = useState(false);
 useEffect(() => {
  let active = true;
  const refresh = async () => { try { const data = await api<{ items: TalentItem[] }>('/api/repertoire'); if (active) { setItems(data.items); localStorage.setItem(KEY, JSON.stringify(data.items)); setError(''); } } catch { if (active) setError('当前显示手机保存的曲目；新建、编辑和导入需连接 Mac Mini'); } finally { if (active) setLoaded(true); } };
  const changed = () => { if (active) setItems(storedRepertoire()); };
  void refresh(); window.addEventListener('dance-repertoire-changed', changed); return () => { active = false; window.removeEventListener('dance-repertoire-changed', changed); };
 }, []);
 return { items, error, loaded };
}

export function playableTalent(item: TalentItem): DanceItem | null { return item.audio ? { ...item, audio: item.audio, performanceClipId: item.performanceClipId!, sceneTags: [] } : null; }
