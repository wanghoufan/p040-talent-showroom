import type { VocalTrack, VocalTrackRole, VocalTracks } from '../types';

/**
 * 播放中切换音轨（KTV 原唱/伴奏）。
 * 处理顺序：先解析目标地址 → 暂停 → 换源 → 等元数据 → 用「规范化时间轴」还原位置 → 失败回滚到原轨。
 * 只保证两条音轨的歌词时间轴对齐；物理换源期间可能有极短静默，不承诺无缝。
 */

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

export interface SwitchInput {
  tracks: VocalTracks;
  fromRole: VocalTrackRole;
  toRole: VocalTrackRole;
  /** 离线缓存或局域网地址由调用方解析；返回空串视为不可访问。 */
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

export async function switchVocalTrack(audio: SwitchableAudio, input: SwitchInput): Promise<void> {
  const from = input.tracks[input.fromRole];
  const to = input.tracks[input.toRole];
  if (!to) throw new Error(`缺少${input.toRole === 'original' ? '原唱' : '伴奏'}音轨`);
  if (input.fromRole === input.toRole) return;

  // 目标不可访问时保持当前音轨继续播放，不做任何破坏性切换。
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
  // 两条文件各自的 offsetMs 表示「文件时钟 − 歌词时间轴」，据此换算到目标文件位置。
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
  } catch (error) {
    audio.pause();
    if (previous.src) {
      // 监听必须先挂再 load()，否则快速加载的本地文件会丢掉 loadedmetadata。
      const rollbackReady = waitForMetadata(audio, input.timeoutMs ?? 8000);
      audio.src = previous.src;
      audio.load();
      try { await rollbackReady; } catch { /* 原轨也不可用时由调用方提示；不要误播另一首。 */ }
      audio.currentTime = previous.time;
      audio.volume = previous.volume;
      audio.muted = previous.muted;
      audio.playbackRate = previous.rate;
      if (wasPlaying) try { await audio.play(); } catch { /* 保持暂停，避免静默失败 */ }
    }
    throw error;
  }
}
