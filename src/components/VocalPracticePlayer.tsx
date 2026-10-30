import { useEffect, useMemo, useRef, useState } from 'react';
import { readCachedIndex } from '../lib/offline-manifest';
import { playbackSource } from '../native/filesystem';
import {
  availableVocalSources, defaultVocalSource, hasVocalTrack, lineAtTime, lineLoopFor, parseLrc,
  rapRangesFromSections, resolveLineTimings, resolveTracks, skipRapTarget, sortSections,
  switchVocalTrack, VOCAL_PRACTICE_DEFAULTS,
} from '../lib/vocal';
import { editLocally } from '../lib/offline-editing';
import type {
  DanceItem, MediaFile, PerformanceSource, TalentItem, TimedLyric, VocalLineLoop, VocalPracticeSettings,
  VocalSection, VocalSectionType, VocalTracks,
} from '../lib/types';
import '../styles/vocal-practice.css';

/**
 * 唱歌详情练唱播放器（V2.1）。
 *
 * 数据只从后端的 tracks / lyrics / sections / practice 读取（server/repertoire/service.mjs）；
 * 三处缺失时按旧行为兼容：旧 audio 按 audioRole 精确落到一轨，纯文本歌词照常阅读，
 * 没有可靠时间戳时逐句循环与点击定位明确禁用并提示校准，绝不伪造时间或分析结果。
 * 切轨统一走 lib/vocal/tracks.ts 的 switchVocalTrack：保持 offset 与播放状态，失败回滚原轨。
 */

const SETTINGS_PREFIX = 'dance.vocal-practice.settings';
const TIMESTAMP_HINT = /\[\d{1,4}:\d{1,2}/;
const SECONDS_CHOICES: VocalPracticeSettings['backwardSeconds'][] = [5, 10, 15, 30];
const RATE_CHOICES = [0.75, 1, 1.25, 1.5];
const LINE_CHOICES = [2, 3, 4, 5, 6];
const DEFAULT_SETTINGS: VocalPracticeSettings = { ...VOCAL_PRACTICE_DEFAULTS, customRepeatLines: 4 };
const SECTION_TYPE_LABEL: Record<VocalSectionType, string> = {
  intro: '前奏', verse: '主歌', pre: '预副歌', chorus: '副歌', bridge: '桥段', rap: 'Rap', outro: '尾奏', unknown: '未标注',
};

function isSeconds(value: unknown): value is VocalPracticeSettings['backwardSeconds'] {
  return SECONDS_CHOICES.includes(value as VocalPracticeSettings['backwardSeconds']);
}

/** 只记住练习习惯（秒数/句数/倍速）；循环与合练状态每次进入重新开始。 */
function sanitizeSettings(raw: Partial<VocalPracticeSettings> | undefined): VocalPracticeSettings {
  const value = raw || {};
  return {
    skipRap: value.skipRap === true,
    wholeTrackLoop: value.wholeTrackLoop === true,
    backwardSeconds: isSeconds(value.backwardSeconds) ? value.backwardSeconds : DEFAULT_SETTINGS.backwardSeconds,
    forwardSeconds: isSeconds(value.forwardSeconds) ? value.forwardSeconds : DEFAULT_SETTINGS.forwardSeconds,
    customRepeatLines: typeof value.customRepeatLines === 'number' && Number.isFinite(value.customRepeatLines)
      ? Math.min(8, Math.max(1, Math.trunc(value.customRepeatLines))) : DEFAULT_SETTINGS.customRepeatLines,
    playbackRate: typeof value.playbackRate === 'number' && RATE_CHOICES.includes(value.playbackRate) ? value.playbackRate : DEFAULT_SETTINGS.playbackRate,
  };
}

function settingsKey(songId: string): string {
  return `${SETTINGS_PREFIX}.${songId}`;
}

/** 本机缓存按曲目隔离；服务端 item.practice 是同步真源，优先级最高。 */
function readSettings(item: TalentItem): VocalPracticeSettings {
  let local: Partial<VocalPracticeSettings> = {};
  try { local = JSON.parse(localStorage.getItem(settingsKey(item.id)) || '{}') as Partial<VocalPracticeSettings>; } catch { local = {}; }
  return sanitizeSettings({ ...local, ...(item.practice || {}) });
}

function saveSettings(songId: string, settings: VocalPracticeSettings): void {
  try {
    localStorage.setItem(settingsKey(songId), JSON.stringify({
      backwardSeconds: settings.backwardSeconds, forwardSeconds: settings.forwardSeconds,
      customRepeatLines: settings.customRepeatLines, playbackRate: settings.playbackRate,
      skipRap: settings.skipRap, wholeTrackLoop: settings.wholeTrackLoop,
    }));
  } catch { /* 存储不可用时仅本会话生效，不影响播放 */ }
}

/** 只把练习习惯写回曲目字段，循环/合练属于临时状态，不落盘。 */
function practicePatch(settings: VocalPracticeSettings): VocalPracticeSettings {
  return {
    skipRap: settings.skipRap, wholeTrackLoop: settings.wholeTrackLoop,
    backwardSeconds: settings.backwardSeconds, forwardSeconds: settings.forwardSeconds,
    customRepeatLines: settings.customRepeatLines, playbackRate: settings.playbackRate,
  };
}

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** 复用既有缓存解析：已下载的原唱/伴奏走本地文件，未下载才回落网络。 */
function trackSource(item: TalentItem, media?: MediaFile): string {
  if (!media) return '';
  const playable: DanceItem = { ...item, audio: media, performanceClipId: item.performanceClipId || media.id, sceneTags: [] };
  try { return playbackSource(playable, readCachedIndex()); } catch { return ''; }
}

function repetitionNote(section: VocalSection, byId: Map<string, VocalSection>): string | null {
  const target = section.repeatOf ? byId.get(section.repeatOf)?.label || section.repeatOf : null;
  if (section.repetition === 'exact-lyrics') return target ? `同词重复 ${target}` : '同词重复';
  if (section.repetition === 'same-melody-new-lyrics') return target ? `旋律同 ${target}、歌词不同` : '旋律重复、歌词不同';
  if (section.repetition === 'unverified') return target ? `重复 ${target}（未校验）` : '重复未校验';
  return target ? `重复 ${target}` : null;
}

interface Props {
  item: TalentItem;
  /** 无音轨时引导用户去原页面导入，播放器不自行造媒体。 */
  onRequestImport?: () => void;
}

export default function VocalPracticePlayer({ item, onRequestImport }: Props) {
  /** 后端 tracks 是分角色持久化的真源；缺失的角色用旧 audio + audioRole 精确补位，绝不猜测另一轨。 */
  const tracks = useMemo<VocalTracks>(() => resolveTracks(item), [item]);
  const sourceList = useMemo(() => availableVocalSources(tracks), [tracks]);
  const [source, setSource] = useState<PerformanceSource | null>(() => defaultVocalSource(tracks, 'practice'));
  const [busy, setBusy] = useState(false);
  const track = source ? tracks[source] : undefined;
  const src = useMemo(() => trackSource(item, track?.media), [item, track]);

  const [settings, setSettings] = useState<VocalPracticeSettings>(() => readSettings(item));
  const [playing, setPlaying] = useState(false);
  const [timeMs, setTimeMs] = useState(0);
  const [mediaDurationMs, setMediaDurationMs] = useState(0);
  const [loop, setLoop] = useState<VocalLineLoop | null>(null);
  const [loopKey, setLoopKey] = useState<string | null>(null);
  const [joint, setJoint] = useState(false);
  const [notice, setNotice] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [dockHeight, setDockHeight] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const persistedSettings = useRef(JSON.stringify(practicePatch(readSettings(item))));

  const declaredDurationMs = Math.max(0, item.durationMs || 0, track?.media.durationMs || 0);
  /** 歌词时间轴位置 = 文件时钟 − offsetMs；界面统一用这份「规范化时间」，切轨才不会错位。 */
  const offsetMs = track?.offsetMs ?? 0;
  const durationMs = Math.max(0, (mediaDurationMs > 0 ? mediaDurationMs - offsetMs : declaredDurationMs));

  const sections = useMemo(() => sortSections(item.sections || []), [item.sections]);
  const sectionById = useMemo(() => new Map(sections.map((section) => [section.id, section])), [sections]);
  const rapRanges = useMemo(() => rapRangesFromSections(sections, declaredDurationMs || undefined), [sections, declaredDurationMs]);

  /** 时间戳优先用后端 lyrics；否则从 LRC 文本解析；纯文本不伪造时间。 */
  const lyrics = useMemo(() => {
    const declared = item.lyrics;
    if (declared && declared.length) {
      return { lines: resolveLineTimings(declared, declaredDurationMs || undefined), plain: [] as string[], issues: [] as string[] };
    }
    const text = item.scoreText || '';
    if (TIMESTAMP_HINT.test(text)) {
      const doc = parseLrc(text);
      if (doc.lines.length) {
        return { lines: resolveLineTimings(doc.lines, declaredDurationMs || undefined), plain: doc.untimedLines, issues: doc.issues };
      }
    }
    return { lines: [] as TimedLyric[], plain: text.split(/\r\n|\n|\r/).map((line) => line.trim()).filter(Boolean), issues: [] as string[] };
  }, [item.lyrics, item.scoreText, declaredDurationMs]);

  const hasTiming = lyrics.lines.length > 0;
  const activeLine = hasTiming ? lineAtTime(lyrics.lines, timeMs) : -1;
  const legacyUnmapped = Boolean(item.audio) && sourceList.length === 0;

  /** 练习习惯同曲持久化：先落本机，再写入曲目 practice 字段走离线队列同步。 */
  useEffect(() => {
    const patch = practicePatch(settings);
    saveSettings(item.id, patch);
    const serialized = JSON.stringify(patch);
    // 初始值与曲目一致时不产生写操作，避免每次打开详情都排一条同步任务。
    if (serialized === persistedSettings.current) return;
    persistedSettings.current = serialized;
    const timer = setTimeout(() => {
      void editLocally({ kind: 'VOCAL', id: item.id }, { practice: patch }, 'update').catch(() => undefined);
    }, 600);
    return () => clearTimeout(timer);
  }, [settings, item.id]);
  // 曲目数据（含音轨）可能在同步后才到；当前轨缺失时回到练唱默认轨，不凭空造轨。
  useEffect(() => {
    if (source && hasVocalTrack(tracks, source)) return;
    const fallback = defaultVocalSource(tracks, 'practice');
    if (fallback !== source) setSource(fallback);
  }, [source, tracks]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;
    element.playbackRate = settings.playbackRate;
    element.preservesPitch = true;
    element.loop = settings.wholeTrackLoop;
  }, [settings.playbackRate, settings.wholeTrackLoop, src]);
  /**
   * 音频源由 switchVocalTrack 直接接管；这里只做「首次装载/曲目变化」的兜底。
   * 若把 src 写成受控属性，切轨后 React 会把新地址再写一次属性，触发浏览器重新 load，
   * 位置归零且暂停——所以先比较元素真实地址，已一致就不再写。
   */
  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;
    if (!src) {
      if (element.getAttribute('src')) { element.removeAttribute('src'); element.load(); }
      return;
    }
    if (element.src === new URL(src, window.location.href).href) return;
    element.src = src;
  }, [src]);
  useEffect(() => {
    const dock = dockRef.current;
    if (!dock || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setDockHeight(Math.ceil(dock.getBoundingClientRect().height)));
    observer.observe(dock);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!showSettings) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setShowSettings(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showSettings]);

  const clampMs = (value: number): number => {
    const limit = durationMs > 0 ? durationMs - 20 : Number.POSITIVE_INFINITY;
    return Math.min(Math.max(0, Math.round(value)), limit);
  };

  const seekTo = (value: number, autoplay = false): void => {
    const element = audioRef.current;
    const next = clampMs(value);
    setTimeMs(next);
    // 规范化时间 → 文件时钟：加上当前音轨 offsetMs。
    if (element) element.currentTime = Math.max(0, (next + offsetMs) / 1000);
    if (autoplay && element) void element.play().catch(() => setNotice('浏览器未允许自动播放，请再点一次播放。'));
  };

  const togglePlay = (): void => {
    const element = audioRef.current;
    if (!element || !src) { setNotice('还没有可播放的音轨，请先导入原唱或伴奏。'); return; }
    if (playing) { element.pause(); return; }
    void element.play().catch(() => setNotice('音乐暂时无法播放，请检查文件是否已缓存或连接。'));
  };

  const replay = (): void => {
    setLoop(null); setLoopKey(null); setJoint(false);
    seekTo(0, true);
  };

  const toggleWholeLoop = (): void => {
    setJoint(false);
    setLoop(null); setLoopKey(null);
    setSettings((current) => ({ ...current, wholeTrackLoop: !current.wholeTrackLoop }));
  };

  const toggleSkipRap = (): void => {
    setSettings((current) => ({ ...current, skipRap: !current.skipRap }));
    const element = audioRef.current;
    if (!settings.skipRap && element && !loop) {
      const current = Math.round(element.currentTime * 1000) - offsetMs;
      const target = skipRapTarget(current, rapRanges, { enabled: true, durationMs: durationMs || undefined });
      if (target > current) seekTo(target);
    }
    if (!rapRanges.length) setNotice('这首歌的结构里没有 Rap 区间，无需跳过。');
  };

  const startJoint = (): void => {
    if (!src) { setNotice('没有可播放的音轨，无法合练。'); return; }
    setLoop(null); setLoopKey(null); setJoint(true);
    setSettings((current) => ({ ...current, skipRap: true, wholeTrackLoop: false }));
    seekTo(0, true);
    setNotice('合练一遍：从头播放 · 自动跳过 Rap · 到结尾停止');
  };

  const startLineLoop = (count: number, key: string): void => {
    if (!hasTiming) { setNotice('这首歌没有逐句时间戳，无法逐句循环；请导入带时间的 LRC。'); return; }
    const endIndex = Math.max(0, activeLine);
    const next = lineLoopFor(lyrics.lines, endIndex, count, { durationMs: durationMs || undefined });
    if (!next) { setNotice('当前句缺少可靠句尾时间，无法循环；可先补充校准。'); return; }
    setLoop(next); setLoopKey(key); setJoint(false);
    setSettings((current) => ({ ...current, wholeTrackLoop: false }));
    seekTo(next.startMs, true);
    setNotice(`循环第 ${next.startIndex + 1}～${next.endIndex + 1} 句，共 ${next.count} 句`);
  };

  /** 切轨复用 lib/vocal/tracks.ts：先校验目标可访问，再按 offset 还原位置，失败回滚原轨并明确提示。 */
  const switchSource = (next: PerformanceSource): void => {
    if (next === source || busy) return;
    if (!hasVocalTrack(tracks, next)) {
      setNotice(next === 'original' ? '这条曲目未提供原唱音轨。' : '这条曲目未提供伴奏音轨。');
      return;
    }
    const element = audioRef.current;
    const label = next === 'original' ? '原唱' : '伴奏';
    if (!element || !source) { setSource(next); return; }
    const nextSrc = trackSource(item, tracks[next]?.media);
    // 两条轨指向同一文件时浏览器不会重新加载，位置与状态本来就连续。
    if (!nextSrc || nextSrc === src) { setSource(next); return; }
    setBusy(true);
    void switchVocalTrack(element, {
      tracks, fromRole: source, toRole: next,
      resolveUrl: async (target) => trackSource(item, target.media),
    }).then(() => {
      setSource(next);
      setTimeMs(Math.max(0, Math.round(element.currentTime * 1000) - (tracks[next]?.offsetMs ?? 0)));
      setPlaying(!element.paused);
      setNotice(`已切换到${label}`);
    }).catch((error: unknown) => {
      const detail = error instanceof Error && error.message ? error.message : '切换失败';
      setNotice(`切换到「${label}」未成功：${detail}；已保留原音轨。`);
    }).finally(() => setBusy(false));
  };

  const handleLoadedMetadata = (): void => {
    const element = audioRef.current;
    if (element && Number.isFinite(element.duration) && element.duration > 0) setMediaDurationMs(Math.round(element.duration * 1000));
  };

  /** 全曲播放时自动跳过 Rap；逐句循环期间尊重显式选择，不自动跳段。 */
  const handleTimeUpdate = (): void => {
    const element = audioRef.current;
    if (!element) return;
    // 文件时钟 → 规范化时间：减去当前音轨 offsetMs，歌词与结构才与切轨后的位置一致。
    const current = Math.round(element.currentTime * 1000) - offsetMs;
    if (loop) {
      if (current >= loop.endMs) { seekTo(loop.startMs); return; }
      setTimeMs(current);
      return;
    }
    if (settings.skipRap && rapRanges.length) {
      const target = skipRapTarget(current, rapRanges, { enabled: true, durationMs: durationMs || undefined });
      if (target > current) { seekTo(target); return; }
    }
    setTimeMs(current);
  };

  const handleEnded = (): void => {
    setPlaying(false);
    if (joint) { setJoint(false); setNotice('合练一遍完成'); return; }
    if (loop) { seekTo(loop.startMs, true); return; }
    setTimeMs(durationMs);
  };

  const jumpToSection = (section: VocalSection): void => {
    setLoop(null); setLoopKey(null); setJoint(false);
    seekTo(section.startMs);
  };

  const modeText = joint ? '合练中 · 自动跳过 Rap' : loop ? `逐句循环 · 第 ${loop.startIndex + 1}～${loop.endIndex + 1} 句` : '自由练习';
  const skipRapBlocked = Boolean(loop) && settings.skipRap;

  return (
    <div className="vocal-practice">
      <section className="vocal-block" aria-labelledby="vocal-structure-title">
        <h2 id="vocal-structure-title">歌曲结构</h2>
        {sections.length ? (
          <>
            <div className="vocal-timeline" aria-hidden="true">
              {sections.map((section) => (
                <span
                  key={section.id}
                  className={`vocal-timeline__seg vocal-timeline__seg--${section.type}`}
                  style={{ flexGrow: Math.max(1, section.endMs - section.startMs) }}
                />
              ))}
            </div>
            <ul className="vocal-sections">
              {sections.map((section) => {
                const note = repetitionNote(section, sectionById);
                return (
                  <li key={section.id}>
                    <button
                      type="button"
                      className={section.type === 'rap' ? 'vocal-section vocal-section--rap' : 'vocal-section'}
                      aria-label={`跳到 ${section.label}，${formatTime(section.startMs)}`}
                      onClick={() => jumpToSection(section)}
                    >
                      <span className="vocal-section__label">{section.label}</span>
                      <span className="vocal-section__type">{SECTION_TYPE_LABEL[section.type]}</span>
                      <span className="vocal-section__time">{formatTime(section.startMs)}</span>
                      {note && <span className="vocal-section__note">{note}</span>}
                      {section.type === 'rap' && <span className="vocal-section__skip">可跳过</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <p className="vocal-empty" role="status">
            待分析：这条曲目还没有结构数据，暂不显示段落跳转，也不把猜测结果当作已识别。先按歌词练唱，结构待校准后补充。
          </p>
        )}
      </section>

      <section className="vocal-block" aria-labelledby="vocal-lyrics-title">
        <div className="vocal-lyrics__head">
          <h2 id="vocal-lyrics-title">同步歌词</h2>
          <div className="vocal-loopbar" role="group" aria-label="按句循环">
            <span className="vocal-loopbar__label">循环</span>
            {[2, 4].map((count) => (
              <button key={count} type="button" aria-pressed={loopKey === String(count)} disabled={!hasTiming} onClick={() => startLineLoop(count, String(count))}>{count} 句</button>
            ))}
            <button
              type="button"
              aria-pressed={loopKey === 'custom'}
              disabled={!hasTiming}
              onClick={() => startLineLoop(settings.customRepeatLines, 'custom')}
            >
              自定义 {settings.customRepeatLines} 句
            </button>
            {loop && <button type="button" onClick={() => { setLoop(null); setLoopKey(null); setNotice('已退出逐句循环'); }}>退出</button>}
          </div>
        </div>
        {hasTiming ? (
          <ol className="vocal-lyrics">
            {lyrics.lines.map((line, index) => (
              <li key={line.id}>
                <button
                  type="button"
                  className={index === activeLine ? 'vocal-line vocal-line--active' : 'vocal-line'}
                  aria-current={index === activeLine ? 'true' : undefined}
                  onClick={() => { setLoop(null); setLoopKey(null); setJoint(false); seekTo(line.startMs); }}
                >
                  <span className="vocal-line__time">{formatTime(line.startMs)}</span>
                  <span className="vocal-line__text">{line.text}</span>
                  <span className="vocal-line__index" aria-label={`第 ${index + 1} 句`}>{index + 1}</span>
                </button>
              </li>
            ))}
          </ol>
        ) : lyrics.plain.length ? (
          <>
            <p className="vocal-hint" role="status">纯文本歌词：没有逐句时间戳，点击定位与逐句循环暂不可用，导入带时间的 LRC 后开启。</p>
            {lyrics.issues.includes('NEEDS_CALIBRATION') && <p className="vocal-hint" role="status">需要校准：当前只有歌词文本，没有可用时间轴。</p>}
            <ol className="vocal-lyrics vocal-lyrics--plain">
              {lyrics.plain.map((text, index) => (
                <li key={`${index}-${text}`} className="vocal-line vocal-line--plain"><span className="vocal-line__text">{text}</span></li>
              ))}
            </ol>
          </>
        ) : (
          <p className="vocal-empty">还没有歌词。点“编辑曲目”粘贴文本，或导入带时间戳的 LRC。</p>
        )}
      </section>

      {!src && (
        <p className="vocal-missing" role="status">
          {legacyUnmapped
            ? '这条曲目有音频但用途未标注，无法判断是原唱还是伴奏；请在编辑里确认音频用途。'
            : sourceList.length === 0
              ? '这条曲目还没有原唱或伴奏音轨：导入 MP3 后即可练唱，纯文本歌词仍可阅读。'
              : `当前选择的「${source === 'original' ? '原唱' : '伴奏'}」未提供音频文件。`}
          {onRequestImport && <button type="button" onClick={onRequestImport}>导入音频</button>}
        </p>
      )}

      <div className="vocal-dock" ref={dockRef} role="group" aria-label="练唱播放器">
        <audio
          ref={audioRef}
          className="vocal-audio"
          preload="metadata"
          loop={settings.wholeTrackLoop}
          onLoadedMetadata={handleLoadedMetadata}
          onDurationChange={handleLoadedMetadata}
          onTimeUpdate={handleTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={handleEnded}
          onError={() => setNotice('音轨加载失败，请检查文件是否已缓存或网络连接，或换一条音轨。')}
        />
        <div className="vocal-dock__meta">
          <div className="vocal-trackbar" role="group" aria-label="练习音轨">
            {(['original', 'accompaniment'] as PerformanceSource[]).map((role) => {
              const ready = hasVocalTrack(tracks, role);
              return (
                <button
                  key={role}
                  type="button"
                  className="vocal-track"
                  aria-pressed={source === role}
                  disabled={!ready || busy}
                  onClick={() => switchSource(role)}
                >
                  {role === 'original' ? '原唱' : '伴奏'}{ready ? '' : '（未提供）'}
                </button>
              );
            })}
          </div>
          <span className="vocal-dock__clock">{formatTime(timeMs)} / {formatTime(durationMs)}</span>
        </div>
        <input
          className="vocal-dock__progress"
          type="range"
          aria-label="播放进度"
          min={0}
          max={Math.max(1000, durationMs)}
          step={100}
          value={Math.min(Math.max(0, timeMs), Math.max(1000, durationMs))}
          onChange={(event) => seekTo(Number(event.target.value))}
        />
        <div className="vocal-dock__controls">
          <button type="button" onClick={replay} aria-label="重播">重播</button>
          <button type="button" onClick={() => seekTo(timeMs - settings.backwardSeconds * 1000)} aria-label={`后退 ${settings.backwardSeconds} 秒`}>−{settings.backwardSeconds}s</button>
          <button type="button" className="vocal-dock__play" onClick={togglePlay} aria-label={playing ? '暂停' : '播放'}>{playing ? '❚❚ 暂停' : '▶ 播放'}</button>
          <button type="button" onClick={() => seekTo(timeMs + settings.forwardSeconds * 1000)} aria-label={`前进 ${settings.forwardSeconds} 秒`}>+{settings.forwardSeconds}s</button>
          <button type="button" aria-pressed={settings.wholeTrackLoop} onClick={toggleWholeLoop} aria-label="单曲循环">循环</button>
        </div>
        <div className="vocal-dock__extra">
          <button type="button" aria-pressed={settings.skipRap} disabled={!rapRanges.length} onClick={toggleSkipRap}>跳过 Rap</button>
          <button type="button" aria-pressed={joint} disabled={!src} onClick={startJoint}>合练一遍</button>
          <button type="button" onClick={() => setShowSettings(true)} aria-label="练习设置">⚙ 设置</button>
          <label className="vocal-dock__rate"><span>倍速</span>
            <select
              aria-label="播放速度"
              value={String(settings.playbackRate)}
              onChange={(event) => setSettings((current) => ({ ...current, playbackRate: Number(event.target.value) }))}
            >
              {RATE_CHOICES.map((rate) => <option key={rate} value={String(rate)}>{rate}×</option>)}
            </select>
          </label>
        </div>
        <p className="vocal-dock__mode" role="status">
          {modeText}{skipRapBlocked ? '（逐句练习不自动跳 Rap）' : ''}{notice ? ` · ${notice}` : ''}
        </p>
      </div>
      <div className="vocal-dock-spacer" style={{ height: dockHeight }} aria-hidden="true" />

      {showSettings && (
        <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) setShowSettings(false); }}>
          <div className="vocal-sheet" role="dialog" aria-modal="true" aria-label="练习设置">
            <div className="vocal-sheet__head">
              <h2>练习设置</h2>
              <button type="button" aria-label="关闭练习设置" onClick={() => setShowSettings(false)}>✕</button>
            </div>
            <p className="vocal-hint">只调整这条曲目的练唱习惯；主题、离线音乐与同步仍在底部「我的」。</p>
            <fieldset className="vocal-field">
              <legend>后退秒数</legend>
              <div className="vocal-chips">
                {SECONDS_CHOICES.map((seconds) => (
                  <button key={seconds} type="button" aria-pressed={settings.backwardSeconds === seconds} onClick={() => setSettings((current) => ({ ...current, backwardSeconds: seconds }))}>{seconds} 秒</button>
                ))}
              </div>
            </fieldset>
            <fieldset className="vocal-field">
              <legend>前进秒数</legend>
              <div className="vocal-chips">
                {SECONDS_CHOICES.map((seconds) => (
                  <button key={seconds} type="button" aria-pressed={settings.forwardSeconds === seconds} onClick={() => setSettings((current) => ({ ...current, forwardSeconds: seconds }))}>{seconds} 秒</button>
                ))}
              </div>
            </fieldset>
            <fieldset className="vocal-field">
              <legend>自定义回退句数</legend>
              <div className="vocal-chips">
                {LINE_CHOICES.map((count) => (
                  <button key={count} type="button" aria-pressed={settings.customRepeatLines === count} onClick={() => setSettings((current) => ({ ...current, customRepeatLines: count }))}>{count} 句</button>
                ))}
              </div>
            </fieldset>
            <fieldset className="vocal-field">
              <legend>播放速度</legend>
              <div className="vocal-chips">
                {RATE_CHOICES.map((rate) => (
                  <button key={rate} type="button" aria-pressed={settings.playbackRate === rate} onClick={() => setSettings((current) => ({ ...current, playbackRate: rate }))}>{rate}×</button>
                ))}
              </div>
            </fieldset>
            <button type="button" className="vocal-sheet__done" onClick={() => setShowSettings(false)}>完成</button>
          </div>
        </div>
      )}
    </div>
  );
}
