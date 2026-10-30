import type { VocalTrack, VocalTracks, VocalTrackRole } from './model';

export interface SwitchableAudio {
  src: string;
  currentTime: number;
  paused: boolean;
  volume: number;
  muted: boolean;
  playbackRate: number;
  pause(): void;
  play(): Promise<unknown>;
  load(): void;
  addEventListener(name: string, listener: () => void): void;
  removeEventListener(name: string, listener: () => void): void;
}
/** A URL may be an offline capacitor file URL or a LAN URL. Resolve/validate before switching. */
export interface SwitchInput {
  tracks: VocalTracks;
  fromRole: VocalTrackRole;
  toRole: VocalTrackRole;
  resolveUrl: (track: VocalTrack) => Promise<string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}
function waitForMetadata(audio: SwitchableAudio, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      audio.removeEventListener('loadedmetadata', ok);
      audio.removeEventListener('error', failed);
      signal?.removeEventListener('abort', cancelled);
      clearTimeout(timer);
    };
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      cleanup();
      if (error) reject(error); else resolve();
    };
    const ok = () => finish();
    const failed = () => finish(new Error('目标音轨无法解码'));
    const cancelled = () => finish(new Error('切换已取消'));
    const timer = setTimeout(() => finish(new Error('读取目标音轨超时')), timeoutMs);
    audio.addEventListener('loadedmetadata', ok);
    audio.addEventListener('error', failed);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
  });
}
/**
 * Preserve canonical timeline/paused state/volume/speed, with rollback on failed loading.
 * Audio may be briefly muted during a physical source swap; zero-gap switching is not promised.
 * Caller must serialize requests, check cache readiness and check current-song identity.
 */
export async function switchVocalTrack(audio: SwitchableAudio, input: SwitchInput): Promise<void> {
  const from = input.tracks[input.fromRole];
  const to = input.tracks[input.toRole];
  if (!to) throw new Error(`缺少${input.toRole === 'original' ? '原唱' : '伴奏'}音轨`);
  if (input.fromRole === input.toRole) return;
  // Resolve target before disturbing currently playing audio.
  const targetUrl = await input.resolveUrl(to);
  if (!targetUrl) throw new Error('目标音轨不可访问');
  const previous = {
    src: audio.src,
    time: audio.currentTime,
    paused: audio.paused,
    volume: audio.volume,
    muted: audio.muted,
    rate: audio.playbackRate,
  };
  const canonicalMs = previous.time * 1000 - (from?.offsetMs ?? 0);
  const newTime = Math.max(0, (canonicalMs + (to.offsetMs ?? 0)) / 1000);
  const wasPlaying = !previous.paused;
  audio.pause();
  try {
    const ready = waitForMetadata(audio, input.timeoutMs ?? 8000, input.signal);
    audio.src = targetUrl;
    audio.load();
    await ready;
    audio.currentTime = newTime;
    audio.volume = previous.volume;
    audio.muted = previous.muted;
    audio.playbackRate = previous.rate;
    if (wasPlaying) await audio.play();
  } catch (err) {
    audio.pause();
    if (previous.src) {
      // Attach listeners before calling load() or a fast local file could miss the event.
      const rollbackReady = waitForMetadata(audio, input.timeoutMs ?? 8000);
      audio.src = previous.src;
      audio.load();
      // Best effort: after reload, restore without mistakenly starting a different track.
      try { await rollbackReady; }
      catch { /* Original may also be unavailable: caller displays actionable error. */ }
      audio.currentTime = previous.time;
      audio.volume = previous.volume;
      audio.muted = previous.muted;
      audio.playbackRate = previous.rate;
      if (wasPlaying) try { await audio.play(); } catch { /* leave paused if unavailable */ }
    }
    throw err;
  }
}
