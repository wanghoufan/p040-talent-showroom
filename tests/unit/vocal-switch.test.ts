import { describe, expect, it } from 'vitest';
import { switchVocalTrack, type SwitchableAudio } from '../../src/lib/vocal';
import type { MediaFile, VocalTrack, VocalTracks } from '../../src/lib/types';

const media = (id: string): MediaFile => ({ id, url: `/api/media/audio/${id}`, sha256: `h-${id}`, sizeBytes: 1, version: 1 });

/** 只模拟切换协议（换源/等元数据/回滚），不代表真机播放器行为。 */
class FakeAudio implements SwitchableAudio {
  src = '';
  currentTime = 0;
  paused = true;
  volume = 1;
  muted = false;
  playbackRate = 1;
  brokenSources = new Set<string>();
  private listeners = new Map<string, Set<() => void>>();

  addEventListener(name: string, listener: () => void) { const set = this.listeners.get(name) || new Set(); set.add(listener); this.listeners.set(name, set); }
  removeEventListener(name: string, listener: () => void) { this.listeners.get(name)?.delete(listener); }
  private emit(name: string) { for (const listener of [...(this.listeners.get(name) || [])]) listener(); }
  pause() { this.paused = true; }
  async play() { if (this.brokenSources.has(this.src)) throw new Error('不可播放'); this.paused = false; }
  load() {
    const src = this.src;
    queueMicrotask(() => { if (this.brokenSources.has(src)) this.emit('error'); else this.emit('loadedmetadata'); });
  }
}

const tracks: VocalTracks = {
  original: { media: media('o'), offsetMs: 500 },
  accompaniment: { media: media('a'), offsetMs: 0 },
};
const resolve = async (track: VocalTrack) => `/offline/${track.media.id}`;

describe('播放中切换音轨', () => {
  it('换轨后按 offset 还原到同一歌词位置，并保持播放/音量/静音/倍速', async () => {
    const audio = new FakeAudio();
    audio.src = '/offline/o';
    audio.currentTime = 2;
    audio.paused = false;
    audio.volume = 0.6;
    audio.muted = true;
    audio.playbackRate = 0.8;
    await switchVocalTrack(audio, { tracks, fromRole: 'original', toRole: 'accompaniment', resolveUrl: resolve });
    expect(audio.src).toBe('/offline/a');
    expect(audio.currentTime).toBeCloseTo(1.5, 5); // 2000ms 文件时间 − 500ms offset = 1500ms 时间轴
    expect(audio.paused).toBe(false);
    expect(audio.volume).toBe(0.6);
    expect(audio.muted).toBe(true);
    expect(audio.playbackRate).toBe(0.8);
  });

  it('暂停状态切换后不自动播放，避免演出中误起播', async () => {
    const audio = new FakeAudio();
    audio.src = '/offline/a';
    audio.currentTime = 3;
    audio.paused = true;
    await switchVocalTrack(audio, { tracks, fromRole: 'accompaniment', toRole: 'original', resolveUrl: resolve });
    expect(audio.src).toBe('/offline/o');
    expect(audio.currentTime).toBeCloseTo(3.5, 5);
    expect(audio.paused).toBe(true);
  });

  it('目标音轨加载失败回退到原轨并保留原位置', async () => {
    const audio = new FakeAudio();
    audio.src = '/offline/o';
    audio.currentTime = 12;
    audio.paused = false;
    audio.brokenSources.add('/offline/a');
    await expect(switchVocalTrack(audio, { tracks, fromRole: 'original', toRole: 'accompaniment', resolveUrl: resolve })).rejects.toThrow('目标音轨无法解码');
    expect(audio.src).toBe('/offline/o');
    expect(audio.currentTime).toBeCloseTo(12, 5);
  });

  it('缺轨和不可访问地址直接报错，不动当前播放', async () => {
    const audio = new FakeAudio();
    audio.src = '/offline/o';
    audio.currentTime = 5;
    await expect(switchVocalTrack(audio, { tracks: { original: tracks.original }, fromRole: 'original', toRole: 'accompaniment', resolveUrl: resolve })).rejects.toThrow('缺少伴奏音轨');
    await expect(switchVocalTrack(audio, { tracks, fromRole: 'original', toRole: 'accompaniment', resolveUrl: async () => '' })).rejects.toThrow('目标音轨不可访问');
    expect(audio.src).toBe('/offline/o');
    expect(audio.currentTime).toBe(5);
  });

  it('同一角色重复请求是空操作', async () => {
    const audio = new FakeAudio();
    audio.src = '/offline/o';
    await switchVocalTrack(audio, { tracks, fromRole: 'original', toRole: 'original', resolveUrl: resolve });
    expect(audio.src).toBe('/offline/o');
  });
});
