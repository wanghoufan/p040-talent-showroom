import { useMemo,useRef,useState } from 'react';
import { api,jsonBody,mediaUrl } from '../lib/api';
import { catalogChanged } from '../lib/catalog-store';
import type { DanceItem } from '../lib/types';

/**
 * 非破坏裁剪：只设置 start/end，派生新片段；来源视频/音频永不改写。
 * 「恢复完整音频」= 用完整区间派生，等价于原始取音频。
 */
export default function ClipTrimmer({ item,onUpdated }:{ item:DanceItem;onUpdated:(next:DanceItem)=>void }){
  const full = item.source?.durationMs || item.audio.endMs || item.durationMs;
  const [startMs,setStartMs]=useState(item.audio.startMs ?? 0);
  const [endMs,setEndMs]=useState(item.audio.endMs ?? full);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const preview=useRef<HTMLAudioElement>(null);
  const dirty = startMs !== (item.audio.startMs ?? 0) || endMs !== (item.audio.endMs ?? full);
  const seconds = useMemo(() => ({
    start: +(startMs / 1000).toFixed(1),
    end: +(endMs / 1000).toFixed(1),
    full: +(full / 1000).toFixed(1),
  }), [startMs, endMs, full]);
  const save = async (nextStart:number, nextEnd:number) => {
    setBusy(true); setMessage('');
    try {
      const updated = await api<DanceItem>(`/api/dances/${item.id}/clip`, { method:'PUT', ...jsonBody({ startMs:nextStart, endMs:nextEnd }) });
      setStartMs(updated.audio.startMs ?? 0); setEndMs(updated.audio.endMs ?? full);
      catalogChanged(); onUpdated(updated); setMessage('片段已更新');
    } catch { setMessage('片段更新未完成，请检查连接'); }
    finally { setBusy(false); }
  };
  const previewClip = () => {
    const audio = preview.current; if (!audio) return;
    audio.currentTime = seconds.start;
    void audio.play().catch(() => setMessage('无法试听，请检查连接'));
    const stop = () => { if (audio.currentTime >= seconds.end) { audio.pause(); audio.removeEventListener('timeupdate', stop); } };
    audio.addEventListener('timeupdate', stop);
  };
  return <fieldset className="clip-trimmer"><legend>裁剪片段（非破坏）</legend>
    <label>起点 {seconds.start}s<input type="range" min={0} max={Math.max(0.2, seconds.full - 0.2)} step={0.1} value={seconds.start} onChange={e=>setStartMs(Math.min(Number(e.target.value)*1000, endMs-200))}/></label>
    <label>终点 {seconds.end}s<input type="range" min={0.2} max={seconds.full} step={0.1} value={seconds.end} onChange={e=>setEndMs(Math.max(Number(e.target.value)*1000, startMs+200))}/></label>
    <div className="button-row">
      <button onClick={previewClip} disabled={busy}>试听片段</button>
      <button className="primary" disabled={busy || !dirty || endMs-startMs < 200} onClick={()=>void save(startMs,endMs)}>保存片段</button>
      <button disabled={busy || (startMs===0 && endMs===full)} onClick={()=>void save(0,full)}>恢复完整音频</button>
    </div>
    <audio ref={preview} src={mediaUrl(item.audio.url)} preload="none"/>
    {message && <p role="status">{message}</p>}
  </fieldset>;
}
