import { api, jsonBody } from './api';
import type { Playlist } from './types';

/** 今晚歌单读写（T074/T075）。 */
export const fetchPlaylist = () => api<Playlist>('/api/playlists/tonight');
export const savePlaylist = (items: string[]) => api<Playlist>('/api/playlists/tonight', { method: 'PUT', ...jsonBody({ items }) });

/** 本地顺序调整：把 from 位置的元素移动到 to 位置。 */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
