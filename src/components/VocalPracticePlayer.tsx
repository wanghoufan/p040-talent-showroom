import { useEffect, useMemo, useRef, useState } from 'react';
import { readCachedIndex } from '../lib/offline-manifest';
import { playbackSource } from '../native/filesystem';
import { apiWithTimeout, jsonBody } from '../lib/api';
import { rememberRepertoire } from '../lib/repertoire-store';
import {
  availableVocalSources, defaultVocalSource, hasVocalTrack, lineAtTime, lineLoopFor, parseLrc,
  rapRangesFromSections, resolveLineTimings, resolveTracks, sectionAtTime, skipRapTarget, sortSections,
  switchVocalTrack, VOCAL_PRACTICE_DEFAULTS,
} from '../lib/vocal';
import {
  defaultShowTranslation, manualTranslationDoc, readTranslations, summarizeTranslations,
  translationIndex, translationToggleLabel,
} from '../lib/vocal/translation';
import { TYPE_TEXT, isRapConfirmed, relabelSections, sectionHeading, unconfirmedRapCount } from '../lib/vocal/structure';
import { readStructureDraft, readReferenceCatalog, loadCatalogReference, type ReferenceCatalogEntry } from '../lib/vocal/structure-api';
import { referenceCatalogFailureMessage, referencePending } from '../lib/vocal/reference';
import VocalStructureStudio from './VocalStructureStudio';
import { editLocally } from '../lib/offline-editing';
import type {
  DanceItem, MediaFile, PerformanceSource, TalentItem, TimedLyric, VocalLineLoop, VocalPracticeSettings,
  VocalSection, VocalTracks,
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
/** 字号是跨曲目的阅读偏好，单独存一份，不和练唱习惯混在一起。 */
const FONT_STORAGE_KEY = 'dance.vocal-practice.font-size';
const TIMESTAMP_HINT = /\[\d{1,4}:\d{1,2}/;
const SECONDS_CHOICES: VocalPracticeSettings['backwardSeconds'][] = [5, 10, 15, 30];
const RATE_CHOICES = [0.75, 1, 1.25, 1.5];
const LINE_CHOICES = [2, 3, 4, 5, 6];
const DEFAULT_SETTINGS: VocalPracticeSettings = { ...VOCAL_PRACTICE_DEFAULTS, customRepeatLines: 4 };
/** 段落类型文案与结构编辑共用一份，避免两处标签不一致。 */
const SECTION_TYPE_LABEL = TYPE_TEXT;
function isSeconds(value: unknown): value is VocalPracticeSettings['backwardSeconds'] {
  return SECONDS_CHOICES.includes(value as VocalPracticeSettings['backwardSeconds']);
}

/** 歌词字号三档：只改歌词排版，不动时间轴与原文。 */
type LyricFont = 'normal' | 'large' | 'xlarge';
const FONT_CHOICES: LyricFont[] = ['normal', 'large', 'xlarge'];
const FONT_LABEL: Record<LyricFont, string> = { normal: '标准', large: '大', xlarge: '特大' };

function readFontScale(): LyricFont {
  try {
    const value = localStorage.getItem(FONT_STORAGE_KEY);
    return value === 'large' || value === 'xlarge' ? value : 'normal';
  } catch { return 'normal'; }
}

function saveFontScale(value: LyricFont): void {
  try { localStorage.setItem(FONT_STORAGE_KEY, value); } catch { /* 存储不可用时只影响本会话 */ }
}

/** 沉浸页歌词按结构分段：同一段连续成组，不在任何段落里的句子单独成组且不显示段标题。 */
interface LyricGroup { key: string; section: VocalSection | null; lines: { line: TimedLyric; index: number }[] }

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

/** 译文来源用一句人看得懂的话说明，避免把 LRC 自带译文说成 AI 识别。 */
function translationSourceLabel(translations: { source?: string }): string {
  switch (translations.source) {
    case 'manual': return '人工译文';
    case 'lrc': return 'LRC 自带译文';
    case 'ai': return 'AI 译文';
    case 'mixed': return '人工 / LRC / AI 混合';
    default: return '译文';
  }
}

function repetitionNote(section: VocalSection, byId: Map<string, VocalSection>): string | null {  const target = section.repeatOf ? byId.get(section.repeatOf)?.label || section.repeatOf : null;
  if (section.repetition === 'exact-lyrics') return target ? `同词重复 ${target}` : '同词重复';
  if (section.repetition === 'same-melody-new-lyrics') return target ? `旋律同 ${target}、歌词不同` : '旋律重复、歌词不同';
  if (section.repetition === 'unverified') return target ? `重复 ${target}（未校验）` : '重复未校验';
  return target ? `重复 ${target}` : null;
}

interface Props {
  item: TalentItem;
  /** 无音轨时引导用户去原页面导入，播放器不自行造媒体。 */
  onRequestImport?: () => void;
  /** 曲库点歌直达沉浸时，返回按钮回到曲库列表；不传则退回曲目详情。 */
  onExitToLibrary?: () => void;
  /** 沉浸页里回到曲目详情（编辑、导入、删除仍在详情页）。 */
  onOpenDetail?: () => void;
}

/** 曲库点歌用 `?immersive=1` 直达沉浸；只在首次挂载时判定，后续切换不改入口。 */
function immersiveFromUrl(): boolean {
  if (typeof window === 'undefined') return false;
  try { return new URLSearchParams(window.location.search).get('immersive') === '1'; } catch { return false; }
}

export default function VocalPracticePlayer({ item, onRequestImport, onExitToLibrary, onOpenDetail }: Props) {
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
  /** 整段循环：与逐句循环互斥，同一时刻只有一个循环范围。 */
  const [sectionLoop, setSectionLoop] = useState<{ id: string; startMs: number; endMs: number } | null>(null);
  const [focusedSectionId, setFocusedSectionId] = useState<string | null>(null);
  const [onlySectionLines, setOnlySectionLines] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  /**
   * 沉浸练歌：同一套播放器与状态，只把页面切成全屏歌词视图；地图收进抽屉。
   * 曲库点歌带 `?immersive=1` 直链进入，此时「返回」回曲库；详情页内点「沉浸练歌」则只退出沉浸。
   */
  const [immersiveByUrl] = useState(immersiveFromUrl);
  const [immersive, setImmersive] = useState(immersiveByUrl);
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** 本机已提供且身份五项全过的参考；没有就是 null，不显示入口。 */
  const [catalogMatch, setCatalogMatch] = useState<ReferenceCatalogEntry | null>(null);
  /** 参考目录「查不到」的原因：401/旧服务/断网都不许说成「没有参考」。 */
  const [catalogError, setCatalogError] = useState('');
  const [catalogRetry, setCatalogRetry] = useState(0);
  /**
   * 只用来提示「服务端还有一份待确认的参考草稿」；正式结构仍然只看 item.sections。
   * 读取失败一律静默，不因为草稿服务不可用而挡住练唱。
   */
  const [draftReference, setDraftReference] = useState<{ count: number; disputed: number; loadedAt?: string | null } | null>(null);
  const [joint, setJoint] = useState(false);
  const [notice, setNotice] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  /** 沉浸页顶栏「更多」：音轨、译文纠错、翻译、结构入口都收在这里，主界面保持原型布局。 */
  const [moreOpen, setMoreOpen] = useState(false);
  /** 「分段」只控制顶部段落标签条显隐；没有结构时按钮禁用，不假装可分。 */
  const [segmentsOpen, setSegmentsOpen] = useState(true);
  /** 「自定义」展开句数选择，选完立即按该句数循环。 */
  const [customLoopOpen, setCustomLoopOpen] = useState(false);
  const [fontScale, setFontScale] = useState<LyricFont>(readFontScale);
  const [dockHeight, setDockHeight] = useState(0);
  /** 每次显式定位 +1：让「把当前句带进可视区」在暂停时也能触发，且同一句重复定位也生效。 */
  const [seekReveal, setSeekReveal] = useState(0);
  const revealedSeekRef = useRef(0);
  /** 播放跟随开关：用户手动滚动歌词后关掉，下一次显式定位再打开。 */
  const followActiveRef = useRef(true);
  const audioRef = useRef<HTMLAudioElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const lyricsRef = useRef<HTMLDivElement>(null);
  const activeLineRef = useRef<HTMLLIElement>(null);
  const persistedSettings = useRef(JSON.stringify(practicePatch(readSettings(item))));

  const declaredDurationMs = Math.max(0, item.durationMs || 0, track?.media.durationMs || 0);
  /** 歌词时间轴位置 = 文件时钟 − offsetMs；界面统一用这份「规范化时间」，切轨才不会错位。 */
  const offsetMs = track?.offsetMs ?? 0;
  const durationMs = Math.max(0, (mediaDurationMs > 0 ? mediaDurationMs - offsetMs : declaredDurationMs));

  /**
   * 结构只读：先按时间排序，再按类型与出现顺序重算编号。
   * 旧数据的 label 常被写成类型名（“主歌”），界面直接拼就会变成「主歌 主歌」；
   * 这里只生成显示用副本（id/时间/类型全不变），不写回 item.sections，也不改用户的持久化结构。
   */
  const sections = useMemo(() => relabelSections(sortSections(item.sections || [])), [item.sections]);
  const sectionById = useMemo(() => new Map(sections.map((section) => [section.id, section])), [sections]);
  const rapRanges = useMemo(() => rapRangesFromSections(sections, declaredDurationMs || undefined), [sections, declaredDurationMs]);
  const unconfirmedRap = useMemo(() => unconfirmedRapCount(sections), [sections]);
  const unknownSections = useMemo(() => sections.filter((section) => section.type === 'unknown').length, [sections]);

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
  /** 译文按行 id 关联；开关只影响显示，不改歌词、不改时间轴。练习默认双语。 */
  const translations = useMemo(() => readTranslations(item), [item.translations]);
  const translationByLine = useMemo(() => translationIndex(translations), [translations]);
  const translationSummary = useMemo(
    () => summarizeTranslations(lyrics.lines, translations, item.language),
    [lyrics.lines, translations, item.language],
  );
  const [showTranslation, setShowTranslation] = useState(() => defaultShowTranslation(item, 'practice'));
  const userToggledTranslation = useRef(false);
  const [translating, setTranslating] = useState(false);
  const [translationNotice, setTranslationNotice] = useState('');
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [correctionDraft, setCorrectionDraft] = useState('');
  useEffect(() => {
    if (!userToggledTranslation.current) setShowTranslation(defaultShowTranslation(item, 'practice'));
  }, [item.id, item.language, translations?.lines.length]);
  const activeLine = hasTiming ? lineAtTime(lyrics.lines, timeMs) : -1;
  const legacyUnmapped = Boolean(item.audio) && sourceList.length === 0;
  /** 当前播放位置所在的段（不是选中段）：地图高亮跟着播放走。 */
  const playingSection = useMemo(() => sectionAtTime(sections, timeMs), [sections, timeMs]);
  const focusedSection = focusedSectionId ? sectionById.get(focusedSectionId) ?? null : null;
  const visibleLines = useMemo(() => {
    if (!onlySectionLines || !focusedSection) return lyrics.lines;
    return lyrics.lines.filter((line) => line.startMs >= focusedSection.startMs && line.startMs < focusedSection.endMs);
  }, [onlySectionLines, focusedSection, lyrics.lines]);
  const visibleActiveIndex = visibleLines.findIndex((line) => hasTiming && line.id === lyrics.lines[activeLine]?.id);
  const lyricIndexById = useMemo(() => new Map(lyrics.lines.map((line, index) => [line.id, index])), [lyrics.lines]);
  /**
   * 歌词按结构分组：只读时间轴落段，不改原文顺序、不改时间轴；
   * 没有结构数据时全部落在无标题组，界面退化成普通列表而不是伪造段落。
   */
  const lyricGroups = useMemo<LyricGroup[]>(() => {
    const groups: LyricGroup[] = [];
    visibleLines.forEach((line, index) => {
      const section = sections.length ? sectionAtTime(sections, line.startMs) : null;
      const groupKey = section ? `section-${section.id}` : 'no-section';
      const last = groups[groups.length - 1];
      const sameGroup = last
        ? (section ? last.section?.id === section.id : last.section === null)
        : false;
      if (last && sameGroup) last.lines.push({ line, index });
      else groups.push({ key: `${groupKey}-${groups.length}`, section, lines: [{ line, index }] });
    });
    return groups;
  }, [visibleLines, sections]);
  /** 顶部段落标签条只在有结构且用户没收起时出现。 */
  const segmentsVisible = segmentsOpen && sections.length > 0;
  /** 「本段」作用于正在播放的段；暂停在段间空隙时退回到最近选中的段。 */
  const currentSection = playingSection ?? focusedSection;
  const activeLineId = activeLine >= 0 ? lyrics.lines[activeLine]?.id ?? null : null;
  const activeTranslation = activeLineId ? translationByLine.get(activeLineId) : undefined;

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
    let alive = true;
    void readStructureDraft(item.id)
      .then((draft) => {
        if (!alive || !draft?.reference) return;
        setDraftReference({ count: draft.reference.candidateCount, disputed: draft.reference.disputedCount, loadedAt: draft.reference.loadedAt });
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [item.id]);
  /**
   * 本机参考：服务端按当前曲目身份核对后才返回可载入项。
   * 读取失败要区分原因（401/404/断网），只说明「查不到」，绝不降级成「没有参考」。
   */
  useEffect(() => {
    let alive = true;
    void readReferenceCatalog(item.id)
      .then((entries) => {
        if (!alive) return;
        setCatalogMatch(entries.find((entry) => entry.identity.ok) ?? null);
        setCatalogError('');
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setCatalogMatch(null);
        setCatalogError(referenceCatalogFailureMessage(error));
      });
    return () => { alive = false; };
  }, [item.id, catalogRetry]);
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
  /**
   * 把当前句带进歌词滚动区（只滚歌词容器，不动页面）。
   * 显式定位（点句/上下句/拖进度/跳段/循环/重播）暂停时也要生效；
   * 播放跟随只在用户没有手动滚动过时生效，避免边播边把用户正在读的位置拽回去。
   */
  useEffect(() => {
    const list = lyricsRef.current;
    const active = activeLineRef.current;
    if (!list || !active) return;
    /*
     * 何时滚：
     * - 显式定位（点句/上下句/拖进度/跳段/循环/重播）不看播放状态，暂停时也要把当前句完整带进来；
     * - 播放跟随只在用户没有手动滚动过时生效，避免边播边把用户正在读的位置拽回去。
     */
    const explicit = seekReveal !== revealedSeekRef.current;
    if (!explicit && (!playing || !followActiveRef.current)) return;
    revealedSeekRef.current = seekReveal;
    if (explicit) followActiveRef.current = true;
    const listRect = list.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    // 目标位置＝把整句居中；末句/首句由 scrollTop 边界自然夹住，句子仍完整可见。
    const offset = activeRect.top - listRect.top + list.scrollTop - (list.clientHeight - activeRect.height) / 2;
    const max = Math.max(0, list.scrollHeight - list.clientHeight);
    const next = Math.min(Math.max(0, offset), max);
    if (Number.isFinite(next) && next !== list.scrollTop) list.scrollTop = next;
  }, [visibleActiveIndex, playing, seekReveal, item.id]);

  /** 用户在歌词区主动滚动（触摸/滚轮/按下滚动条）后暂停跟随，下一次明确跳句再恢复。 */
  useEffect(() => {
    const list = lyricsRef.current;
    if (!list) return;
    const pauseFollow = () => { followActiveRef.current = false; };
    list.addEventListener('touchstart', pauseFollow, { passive: true });
    list.addEventListener('pointerdown', pauseFollow);
    list.addEventListener('wheel', pauseFollow, { passive: true });
    return () => {
      list.removeEventListener('touchstart', pauseFollow);
      list.removeEventListener('pointerdown', pauseFollow);
      list.removeEventListener('wheel', pauseFollow);
    };
  }, [hasTiming, item.id]);

  const clampMs = (value: number): number => {
    const limit = durationMs > 0 ? durationMs - 20 : Number.POSITIVE_INFINITY;
    return Math.min(Math.max(0, Math.round(value)), limit);
  };

  const seekTo = (value: number, autoplay = false): void => {
    const element = audioRef.current;
    const next = clampMs(value);
    setTimeMs(next);
    // 显式定位：即使暂停也要把当前句完整带进可视区（真机点进度条后第 7 句被播放器压住就是这么丢的）。
    setSeekReveal((count) => count + 1);
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
    setLoop(null); setLoopKey(null); setJoint(false); setSectionLoop(null);
    seekTo(0, true);
  };

  const toggleWholeLoop = (): void => {
    setJoint(false);
    setLoop(null); setLoopKey(null); setSectionLoop(null);
    setSettings((current) => ({ ...current, wholeTrackLoop: !current.wholeTrackLoop }));
  };

  const toggleSkipRap = (): void => {
    /* 没有已确认的 Rap 段时不再把按钮做成禁用：一点就把「地图与结构」打开，
       告诉用户去哪儿把段类型改成 Rap 并确认，用户自己决定跳哪几段。 */
    if (!rapRanges.length) {
      setNotice(unconfirmedRap > 0
        ? `有 ${unconfirmedRap} 段 Rap 还未确认：在「地图与结构」里选中该段，点「确认这段是 Rap（可跳过）」。`
        : '这首歌还没有标成 Rap 的段：在「地图与结构」里把要跳过的段类型改成 Rap 并确认，这里就能一键跳过。');
      setDrawerOpen(true);
      return;
    }
    setSettings((current) => ({ ...current, skipRap: !current.skipRap }));
    const element = audioRef.current;
    if (!settings.skipRap && element && !loop) {
      const current = Math.round(element.currentTime * 1000) - offsetMs;
      const target = skipRapTarget(current, rapRanges, { enabled: true, durationMs: durationMs || undefined });
      if (target > current) seekTo(target);
    }
  };

  const startJoint = (): void => {
    if (!src) { setNotice('没有可播放的音轨，无法合练。'); return; }
    setLoop(null); setLoopKey(null); setSectionLoop(null); setJoint(true);
    setSettings((current) => ({ ...current, skipRap: true, wholeTrackLoop: false }));
    seekTo(0, true);
    setNotice('合练一遍：从头播放 · 自动跳过 Rap · 到结尾停止');
  };

  const startLineLoop = (count: number, key: string): void => {
    if (!hasTiming) { setNotice('这首歌没有逐句时间戳，无法逐句循环；请导入带时间的 LRC。'); return; }
    const endIndex = Math.max(0, activeLine);
    const next = lineLoopFor(lyrics.lines, endIndex, count, { durationMs: durationMs || undefined });
    if (!next) { setNotice('当前句缺少可靠句尾时间，无法循环；可先补充校准。'); return; }
    setLoop(next); setLoopKey(key); setJoint(false); setSectionLoop(null);
    setSettings((current) => ({ ...current, wholeTrackLoop: false }));
    /* 只进入循环、不替用户按下播放：暂停时设置循环就停在句首（真机曾出现「点循环即开播」）。 */
    seekTo(next.startMs, playing);
    setNotice(playing
      ? `循环第 ${next.startIndex + 1}～${next.endIndex + 1} 句，共 ${next.count} 句`
      : `循环第 ${next.startIndex + 1}～${next.endIndex + 1} 句，共 ${next.count} 句（已暂停，点播放开始）`);
  };

  /** 点句/上下句都走同一条定位路径：先清掉循环与合练状态，再按句首定位，不伪造时间。 */
  const seekToLine = (index: number): void => {
    const line = lyrics.lines[index];
    if (!line) return;
    setLoop(null); setLoopKey(null); setJoint(false); setSectionLoop(null);
    seekTo(line.startMs);
  };

  const goPrevLine = (): void => {
    if (!hasTiming) { setNotice('这首歌没有逐句时间戳，无法按句定位；请导入带时间的 LRC。'); return; }
    seekToLine(activeLine > 0 ? activeLine - 1 : 0);
  };

  const goNextLine = (): void => {
    if (!hasTiming) { setNotice('这首歌没有逐句时间戳，无法按句定位；请导入带时间的 LRC。'); return; }
    seekToLine(activeLine < 0 ? 0 : Math.min(lyrics.lines.length - 1, activeLine + 1));
  };

  /** 倍速按钮按 0.75 → 1 → 1.25 → 1.5 循环，和前后的 select 共用同一份设置。 */
  const cycleRate = (): void => {
    const index = RATE_CHOICES.indexOf(settings.playbackRate);
    const next = RATE_CHOICES[(index + 1) % RATE_CHOICES.length];
    setSettings((current) => ({ ...current, playbackRate: next }));
    setNotice(`倍速 ${next}×`);
  };

  const cycleFont = (): void => {
    const index = FONT_CHOICES.indexOf(fontScale);
    const next = FONT_CHOICES[(index + 1) % FONT_CHOICES.length];
    setFontScale(next);
    saveFontScale(next);
    setNotice(`歌词字号：${FONT_LABEL[next]}`);
  };

  const clearLoops = (): void => {
    setLoop(null); setLoopKey(null); setSectionLoop(null); setJoint(false);
    setSettings((current) => ({ ...current, wholeTrackLoop: false }));
    setNotice('已关闭循环');
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

  /**
   * 全曲播放时自动跳过 Rap；逐句/整段循环期间尊重显式选择，不自动跳段。
   * 循环范围只有一种：逐句循环与整段循环互斥，先判断哪个生效。
   */
  const handleTimeUpdate = (): void => {
    const element = audioRef.current;
    if (!element) return;
    // 文件时钟 → 规范化时间：减去当前音轨 offsetMs，歌词与结构才与切轨后的位置一致。
    const current = Math.round(element.currentTime * 1000) - offsetMs;
    if (sectionLoop) {
      if (current >= sectionLoop.endMs) { seekTo(sectionLoop.startMs); return; }
      setTimeMs(current);
      return;
    }
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
    if (sectionLoop) { seekTo(sectionLoop.startMs, true); return; }
    if (loop) { seekTo(loop.startMs, true); return; }
    setTimeMs(durationMs);
  };

  const jumpToSection = (section: VocalSection): void => {
    setLoop(null); setLoopKey(null); setJoint(false); setSectionLoop(null);
    setFocusedSectionId(section.id);
    seekTo(section.startMs);
  };

  /** 整段循环：再点一次退出；退出后停在原地继续自由练习。 */
  const toggleSectionLoop = (section: VocalSection): void => {
    setFocusedSectionId(section.id);
    if (sectionLoop?.id === section.id) {
      setSectionLoop(null);
      setNotice(`已退出 ${section.label} 整段循环`);
      return;
    }
    setLoop(null); setLoopKey(null); setJoint(false);
    setSettings((current) => ({ ...current, wholeTrackLoop: false }));
    setSectionLoop({ id: section.id, startMs: section.startMs, endMs: section.endMs });
    seekTo(section.startMs, playing);
    setNotice(`${section.label} 整段循环：${formatTime(section.startMs)}–${formatTime(section.endMs)}${playing ? '' : '（已暂停，点播放开始）'}`);
  };

  const playNextSection = (): void => {
    if (!sections.length) return;
    const index = playingSection ? sections.findIndex((section) => section.id === playingSection.id) : -1;
    const next = sections[Math.min(sections.length - 1, index + 1)];
    if (next) jumpToSection(next);
  };

  /** 译文开关只切换显示；默认练习双语，用户手动切换后不再被自动重置。 */
  const toggleTranslation = (): void => {
    userToggledTranslation.current = true;
    setShowTranslation((value) => !value);
  };

  /**
   * 批量翻译缺失句：走本地服务 → CodeBuddy 通道（云端，不是本地模型）。
   * 失败按句回报；LRC/缓存命中的句子会先落盘，绝不把失败伪装成完成。
   */
  const translateMissing = async (): Promise<void> => {
    if (translating) return;
    if (!hasTiming) { setTranslationNotice('这首歌没有逐句时间戳，无法按行翻译；请先导入带时间的 LRC。'); return; }
    setTranslating(true);
    setTranslationNotice('');
    try {
      const result = await apiWithTimeout<{
        status: 'COMPLETE' | 'PARTIAL' | 'CHANNEL_UNAVAILABLE' | 'NOTHING_TO_DO';
        translated: number; cached: number; lrcReused: number; remaining: number;
        failed?: { id: string; message?: string }[]; item: TalentItem;
      }>(`/api/repertoire/${item.id}/translations/translate`, { method: 'POST', ...jsonBody({}) }, 300000);
      rememberRepertoire(result.item);
      userToggledTranslation.current = true;
      setShowTranslation(true);
      if (result.status === 'COMPLETE') {
        const reuse = [result.lrcReused ? `LRC 译文 ${result.lrcReused} 句` : '', result.cached ? `缓存 ${result.cached} 句` : ''].filter(Boolean).join('、');
        setTranslationNotice(`已翻译 ${result.translated} 句${reuse ? `（另复用${reuse}）` : ''}。`);
      } else if (result.status === 'NOTHING_TO_DO') {
        setTranslationNotice('没有需要翻译的歌词行。');
      } else if (result.status === 'CHANNEL_UNAVAILABLE') {
        setTranslationNotice(`翻译通道不可用：${result.failed?.[0]?.message || '请检查 CodeBuddy 通道'}。已保留 LRC 与缓存译文，未伪造结果。`);
      } else {
        setTranslationNotice(`已完成 ${result.translated} 句，仍有 ${result.remaining} 句未翻译；可稍后重试，失败不会写成译文。`);
      }
    } catch (error) {
      setTranslationNotice(error instanceof Error && error.message ? error.message : '翻译未完成，请检查网络与服务后重试。');
    } finally {
      setTranslating(false);
    }
  };

  const beginCorrection = (lineId: string, text: string): void => {
    setEditingLineId(lineId);
    setCorrectionDraft(text);
  };

  /** 人工纠错写入 manual，服务端合并规则保证 AI 之后不会覆盖它。 */
  const saveCorrection = async (): Promise<void> => {
    if (!editingLineId) return;
    try {
      const updated = await editLocally(
        { kind: 'VOCAL', id: item.id },
        { translations: manualTranslationDoc(item, editingLineId, correctionDraft) },
        'update',
      );
      rememberRepertoire(updated);
      userToggledTranslation.current = true;
      setShowTranslation(true);
      setEditingLineId(null);
      setTranslationNotice(correctionDraft.trim() ? '已保存人工译文，后续 AI 翻译不会覆盖它。' : '已删除这句译文。');
    } catch (error) {
      setTranslationNotice(error instanceof Error && error.message ? error.message : '人工译文未能保存，请重试。');
    }
  };

  const modeText = joint ? '合练中 · 自动跳过 Rap'    : sectionLoop ? `整段循环 · ${sectionById.get(sectionLoop.id)?.label ?? `${formatTime(sectionLoop.startMs)}–${formatTime(sectionLoop.endMs)}`}`
      : loop ? `逐句循环 · 第 ${loop.startIndex + 1}～${loop.endIndex + 1} 句` : '自由练习';
  const skipRapBlocked = Boolean(loop || sectionLoop) && settings.skipRap;

  /**
   * 一键载入本机参考：服务端身份五项已核对通过才会出现在这里。
   * 只写草稿并打开工作室；保存后落正式结构，可继续手动调整。
   */
  const loadCatalogIntoDraft = async (): Promise<void> => {
    if (!catalogMatch) return;
    try {
      const result = await loadCatalogReference(item.id, catalogMatch.id);
      const reference = result.draft.reference;
      setDraftReference({
        count: reference?.candidateCount ?? catalogMatch.candidateCount,
        disputed: reference?.disputedCount ?? catalogMatch.disputedCount,
        loadedAt: reference?.loadedAt ?? new Date().toISOString(),
      });
      setStudioOpen(true);
      setNotice('已载入本机参考候选，可直接保存，练习时随时调整。');
    } catch (error) {
      setNotice(error instanceof Error && error.message ? error.message : '参考未载入，请重试。');
    }
  };

  /**
   * 沉浸页出口：曲库直达时回曲库列表；从详情页点进来时只退出沉浸，停在详情页。
   * 不回退浏览器历史，避免「返回」把用户带到不确定的上一屏。
   */
  const leaveImmersive = (): void => {
    if (immersiveByUrl && onExitToLibrary) { onExitToLibrary(); return; }
    setImmersive(false);
  };

  /** 编辑曲目、导入音频仍在详情页：先退出沉浸再交给上层导航，避免同一路由下沉浸层残留。 */
  const openDetail = (): void => {
    setDrawerOpen(false);
    setImmersive(false);
    onOpenDetail?.();
  };

  return (
    <div className={`vocal-practice${immersive ? ' is-immersive' : ''}`}>
      {immersive && (
        <header className="vocal-immersive__bar">
          <button
            type="button"
            className="vocal-immersive__back"
            aria-label={immersiveByUrl && onExitToLibrary ? '返回曲库' : '退出沉浸'}
            onClick={leaveImmersive}
          >
            <span aria-hidden="true">‹</span>
          </button>
          <div className="vocal-immersive__heading">
            <h2 className="vocal-immersive__title" title={item.title}>{item.title}</h2>
            <p className="vocal-immersive__sub" title={item.artist || '未填写歌手'}>{item.artist || '未填写歌手'}</p>
          </div>
          <button
            type="button"
            className="vocal-immersive__segments"
            aria-pressed={segmentsVisible}
            aria-label={sections.length ? '分段' : '分段（这首歌还没有结构）'}
            disabled={!sections.length}
            onClick={() => setSegmentsOpen((value) => !value)}
          >
            <span aria-hidden="true">▤</span> 分段
          </button>
          <button type="button" className="vocal-immersive__more" aria-label="更多" onClick={() => setMoreOpen(true)}>…</button>
        </header>
      )}
      {/* 段落标签条：只做跳转与显示当前位置，不新增、不改动结构数据 */}
      {immersive && segmentsVisible && (
        <div className="vocal-segments" role="group" aria-label="段落标签">
          {sections.map((section) => {
            const playing = playingSection?.id === section.id;
            return (
              <button
                key={section.id}
                type="button"
                className={playing ? 'vocal-segments__chip is-playing' : 'vocal-segments__chip'}
                aria-pressed={playing}
                aria-label={`跳到 ${sectionHeading(section)}`}
                onClick={() => jumpToSection(section)}
              >
                <span className="vocal-segments__code">{section.label}</span>
                {section.label !== SECTION_TYPE_LABEL[section.type] && (
                  <span className="vocal-segments__type">{SECTION_TYPE_LABEL[section.type]}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {/* 沉浸页不渲染地图：整块高度让给歌词，地图改从顶栏「地图」抽屉进入。 */}
      {!immersive && (
      <section className="vocal-block vocal-block--map" aria-labelledby="vocal-structure-title">
        <div className="vocal-block__head">
          <h2 id="vocal-structure-title">歌曲地图</h2>
          <div className="vocal-block__tools">
            {sections.length > 0 && (
              <span className="vocal-map__meta" role="status">
                {sections.length} 段{unknownSections ? ` · ${unknownSections} 段待标注` : ''}
              </span>
            )}
            <button type="button" className="vocal-map__edit" onClick={() => setStudioOpen(true)}>结构工作室</button>
            <button type="button" className="vocal-map__immersive" onClick={() => setImmersive(true)}>沉浸练歌</button>
            <button type="button" className="vocal-map__drawer" onClick={() => setDrawerOpen(true)}>地图抽屉</button>
          </div>
        </div>
        {catalogMatch && !draftReference && (
          <p className="vocal-ref-banner" role="status">
            本机已有《{catalogMatch.songTitle}》参考候选 {catalogMatch.candidateCount} 段
            {catalogMatch.disputedCount ? `（${catalogMatch.disputedCount} 段类型有争议）` : ''}，身份五项已核对一致。
            <button type="button" onClick={() => void loadCatalogIntoDraft()}>载入参考候选</button>
          </p>
        )}
        {catalogError && !catalogMatch && (
          <p className="vocal-ref-banner vocal-ref-banner--warn" role="status">
            {catalogError}
            <button type="button" onClick={() => setCatalogRetry((value) => value + 1)}>重新核对</button>
          </p>
        )}
        {draftReference && referencePending(item.id, draftReference.loadedAt) && (
          <p className="vocal-ref-banner" role="status">
            服务端还有一份参考草稿：{draftReference.count} 段候选
            {draftReference.disputed ? `（${draftReference.disputed} 段类型有争议）` : ''}，待确认；正式结构未改动。
            <button type="button" onClick={() => setStudioOpen(true)}>打开核对</button>
          </p>
        )}
        {sections.length ? (
          <>
            <div className="vocal-map" role="group" aria-label="歌曲段落">
              {sections.map((section) => {
                const looping = sectionLoop?.id === section.id;
                const playing = playingSection?.id === section.id;
                const focused = focusedSectionId === section.id;
                const note = repetitionNote(section, sectionById);
                return (
                  <button
                    key={section.id}
                    type="button"
                    className={[
                      'vocal-map__chip',
                      `vocal-map__chip--${section.type}`,
                      playing ? 'is-playing' : '',
                      focused ? 'is-focused' : '',
                      looping ? 'is-looping' : '',
                    ].filter(Boolean).join(' ')}
                    aria-pressed={focused}
                    aria-current={playing ? 'true' : undefined}
                    aria-label={`跳到 ${sectionHeading(section)}，${formatTime(section.startMs)}${note ? `，${note}` : ''}`}
                    onClick={() => jumpToSection(section)}
                  >
                    <span className="vocal-map__code">{section.label}</span>
                    {section.label !== SECTION_TYPE_LABEL[section.type] && (
                      <span className="vocal-map__type">{SECTION_TYPE_LABEL[section.type]}</span>
                    )}
                    <span className="vocal-map__time">{formatTime(section.startMs)}</span>
                    {section.type === 'rap' && !isRapConfirmed(section) && <span className="vocal-map__flag">待确认</span>}
                    {looping && <span className="vocal-map__flag vocal-map__flag--loop">循环</span>}
                  </button>
                );
              })}
            </div>
            {focusedSection && (
              <div className="vocal-map__actions" role="group" aria-label={`${focusedSection.label} 段落操作`}>
                <button
                  type="button"
                  aria-pressed={sectionLoop?.id === focusedSection.id}
                  onClick={() => toggleSectionLoop(focusedSection)}
                >
                  {sectionLoop?.id === focusedSection.id ? '退出整段循环' : '整段循环'}
                </button>
                <button type="button" onClick={playNextSection} disabled={!focusedSection}>下一段</button>
                <button type="button" aria-pressed={onlySectionLines} onClick={() => setOnlySectionLines((value) => !value)}>
                  {onlySectionLines ? '显示全部歌词' : '只看本段歌词'}
                </button>
                <span className="vocal-map__hint">
                  {focusedSection.label} · {formatTime(focusedSection.startMs)}–{formatTime(focusedSection.endMs)}
                  {focusedSection.repeatOf ? ` · ${repetitionNote(focusedSection, sectionById) ?? '重复'}` : ''}
                </span>
              </div>
            )}
            {unconfirmedRap > 0 && (
              <p className="vocal-hint" role="status">{unconfirmedRap} 段 Rap 为待确认：确认前不会自动跳过。</p>
            )}
          </>
        ) : (
          <p className="vocal-empty" role="status">
            待分析：这条曲目还没有结构数据，暂不显示段落跳转，也不把猜测结果当作已识别。先按歌词练唱，结构待音轨分析后补充。
          </p>
        )}
      </section>
      )}

      <section
        className="vocal-block vocal-lyrics-block"
        aria-labelledby={immersive ? undefined : 'vocal-lyrics-title'}
        aria-label={immersive ? '歌词' : undefined}
      >
        {/* 沉浸页把循环、译文开关收到播放器与「更多」，标题区只留歌词本体，贴近原型。 */}
        {!immersive && (
          <>
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
        {hasTiming && item.language !== 'zh' && (
          <div className="vocal-translationbar" role="group" aria-label="中文译文">
            {translations && (
              <button type="button" aria-pressed={showTranslation} onClick={toggleTranslation}>
                {translationToggleLabel(item.language, showTranslation)}
              </button>
            )}
            {translationSummary.missing > 0 && (
              <button type="button" className="vocal-translationbar__translate" disabled={translating} onClick={() => void translateMissing()}>
                {translating ? '正在翻译…' : `翻译缺失 ${translationSummary.missing} 句`}
              </button>
            )}
            {translationSummary.missing > 0 && (
              <span className="vocal-translationbar__meta">翻译经 CodeBuddy 云端模型处理，歌词会发送到该服务；不是本地模型</span>
            )}
            {translations && (
              <span className="vocal-translationbar__meta">
                {translationSummary.translated}/{translationSummary.total} 句 · {translationSourceLabel(translations)}
                {translationSummary.stale > 0 ? ` · ${translationSummary.stale} 句原文已改` : ''}
              </span>
            )}
            {!translations && translationSummary.missing > 0 && (
              <span className="vocal-translationbar__meta">还没有中文译文；可先试 LRC 自带译文，再由翻译通道补齐</span>
            )}
          </div>
        )}
          </>
        )}
        {translationNotice && <p className="vocal-hint" role="status">{translationNotice}</p>}
        {hasTiming ? (
          <>
            {onlySectionLines && focusedSection && !visibleLines.length && (
              <p className="vocal-hint" role="status">{focusedSection.label} 这段没有歌词（前奏/间奏），切换「显示全部歌词」可看全曲。</p>
            )}
            <div className={`vocal-lyrics vocal-lyrics--${fontScale}`} ref={lyricsRef}>
              {lyricGroups.map((group) => (
                <section
                  key={group.key}
                  className="vocal-lyric-group"
                  aria-label={group.section ? sectionHeading(group.section) : undefined}
                >
                  {group.section && (
                    <p className="vocal-lyric-group__title">
                      <span>{sectionHeading(group.section, ' · ')}</span>
                      <span className="vocal-lyric-group__rule" aria-hidden="true" />
                    </p>
                  )}
                  <ol className="vocal-lyric-group__list">
                    {group.lines.map(({ line, index }) => {
                      const translation = translationByLine.get(line.id);
                      const isEditing = editingLineId === line.id;
                      const isActive = index === visibleActiveIndex;
                      const lineNumber = (lyricIndexById.get(line.id) ?? index) + 1;
                      return (
                        <li key={line.id} className="vocal-lyric-item" ref={isActive ? activeLineRef : undefined}>
                          <button
                            type="button"
                            className={isActive ? 'vocal-line vocal-line--active' : 'vocal-line'}
                            aria-current={isActive ? 'true' : undefined}
                            aria-label={`第 ${lineNumber} 句：${line.text}`}
                            onClick={() => seekToLine(lyricIndexById.get(line.id) ?? index)}
                          >
                            {!immersive && <span className="vocal-line__time">{formatTime(line.startMs)}</span>}
                            <span className="vocal-line__body">
                              <span className="vocal-line__text">{line.text}</span>
                              {showTranslation && translation && !isEditing && (
                                <span className="vocal-line__translation-text">
                                  {translation.text}
                                  {translation.stale && <span className="vocal-line__stale">原文已改</span>}
                                </span>
                              )}
                            </span>
                            {!immersive && <span className="vocal-line__index" aria-label={`第 ${lineNumber} 句`}>{lineNumber}</span>}
                          </button>
                          {!immersive && showTranslation && translation && !isEditing && (
                            <div className="vocal-line__translation">
                              <button
                                type="button"
                                className="vocal-line__correct"
                                aria-label={`纠错第 ${lineNumber} 句中文译文`}
                                onClick={() => beginCorrection(line.id, translation.text)}
                              >
                                纠错
                              </button>
                            </div>
                          )}
                          {isEditing && (
                            <div className="vocal-line__editor">
                              <label className="vocal-line__editor-label">
                                <span>第 {lineNumber} 句中文译文</span>
                                <textarea
                                  aria-label={`第 ${lineNumber} 句中文译文`}
                                  value={correctionDraft}
                                  rows={2}
                                  onChange={(event) => setCorrectionDraft(event.target.value)}
                                />
                              </label>
                              <div className="vocal-line__editor-actions">
                                <button type="button" onClick={() => void saveCorrection()}>保存</button>
                                <button type="button" onClick={() => setEditingLineId(null)}>取消</button>
                                <span className="vocal-hint">留空保存＝删除这句译文</span>
                              </div>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
            </div>
          </>
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

      <div className={`vocal-dock${immersive ? ' vocal-dock--immersive' : ''}`} ref={dockRef} role="group" aria-label="练唱播放器">
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
        {/* 沉浸页按原型排：进度 → 5 主控 → 逐句练习 → 工具；详情页保持原四层布局。 */}
        {immersive && (
          <>
            <div className="vocal-immersive__timeline">
              <span className="vocal-immersive__clock">{formatTime(timeMs)}</span>
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
              <span className="vocal-immersive__clock">{formatTime(durationMs)}</span>
            </div>
            <div className="vocal-immersive__transport" role="group" aria-label="播放控制">
              <button type="button" onClick={() => seekTo(timeMs - settings.backwardSeconds * 1000)} aria-label={`后退 ${settings.backwardSeconds} 秒`}>
                −{settings.backwardSeconds}s
              </button>
              <button type="button" onClick={goPrevLine} disabled={!hasTiming} aria-label="上一句">
                <span aria-hidden="true">⏮</span> 上句
              </button>
              <button type="button" className="vocal-dock__play" onClick={togglePlay} aria-label={playing ? '暂停' : '播放'}>
                <span className="vocal-dock__play-icon" aria-hidden="true">{playing ? '❚❚' : '▶'}</span>
              </button>
              <button type="button" onClick={goNextLine} disabled={!hasTiming} aria-label="下一句">
                下句 <span aria-hidden="true">⏭</span>
              </button>
              <button type="button" onClick={() => seekTo(timeMs + settings.forwardSeconds * 1000)} aria-label={`前进 ${settings.forwardSeconds} 秒`}>
                +{settings.forwardSeconds}s
              </button>
            </div>
            <div className="vocal-immersive__practice" role="group" aria-label="逐句练习">
              <button
                type="button"
                aria-pressed={settings.skipRap}
                aria-label={rapRanges.length ? '跳过 Rap' : '设置要跳过的 Rap 段'}
                onClick={toggleSkipRap}
              >
                跳Rap
              </button>
              <button type="button" aria-pressed={loopKey === '2'} disabled={!hasTiming} aria-label="循环 2 句" onClick={() => startLineLoop(2, '2')}>2句</button>
              <button type="button" aria-pressed={loopKey === '4'} disabled={!hasTiming} aria-label="循环 4 句" onClick={() => startLineLoop(4, '4')}>4句</button>
              <button
                type="button"
                aria-pressed={loopKey === 'custom'}
                aria-expanded={customLoopOpen}
                disabled={!hasTiming}
                aria-label={`自定义循环句数，当前 ${settings.customRepeatLines} 句`}
                onClick={() => setCustomLoopOpen((value) => !value)}
              >
                自定义
              </button>
              <button
                type="button"
                aria-pressed={Boolean(currentSection && sectionLoop?.id === currentSection.id)}
                disabled={!currentSection}
                aria-label="本段循环"
                onClick={() => { if (currentSection) toggleSectionLoop(currentSection); }}
              >
                本段
              </button>
              <button type="button" aria-pressed={joint} disabled={!src} aria-label="合练一遍" onClick={startJoint}>合练</button>
            </div>
            {customLoopOpen && (
              <div className="vocal-immersive__custom" role="group" aria-label="自定义循环句数">
                {LINE_CHOICES.map((count) => (
                  <button
                    key={count}
                    type="button"
                    aria-pressed={settings.customRepeatLines === count}
                    onClick={() => {
                      setSettings((current) => ({ ...current, customRepeatLines: count }));
                      setCustomLoopOpen(false);
                      startLineLoop(count, 'custom');
                    }}
                  >
                    {count} 句
                  </button>
                ))}
              </div>
            )}
            <div className="vocal-immersive__tools" role="group" aria-label="练习工具">
              <button type="button" onClick={replay} aria-label="重播"><span className="vocal-immersive__icon" aria-hidden="true">↺</span> 重播</button>
              <button type="button" onClick={() => setShowSettings(true)} aria-label="循环设置"><span className="vocal-immersive__icon" aria-hidden="true">⇄</span> 循环设置</button>
              <button type="button" onClick={cycleRate} aria-label={`倍速，当前 ${settings.playbackRate} 倍`}>{settings.playbackRate}×</button>
              <button
                type="button"
                aria-pressed={showTranslation}
                disabled={!translations}
                aria-label={translations ? '双语' : '双语（暂无译文）'}
                onClick={toggleTranslation}
              >
                双语
              </button>
              <button type="button" onClick={cycleFont} aria-label={`字号：${FONT_LABEL[fontScale]}`}>Aa</button>
            </div>
          </>
        )}
        {!immersive && (
          <>
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
        <div className="vocal-dock__controls" role="group" aria-label="播放控制">
          <button type="button" onClick={replay} aria-label="重播">重播</button>
          <button type="button" onClick={() => seekTo(timeMs - settings.backwardSeconds * 1000)} aria-label={`后退 ${settings.backwardSeconds} 秒`}>−{settings.backwardSeconds}s</button>
          <button type="button" className="vocal-dock__play" onClick={togglePlay} aria-label={playing ? '暂停' : '播放'}>
            <span className="vocal-dock__play-icon" aria-hidden="true">{playing ? '❚❚' : '▶'}</span>
            {playing ? '暂停' : '播放'}
          </button>
          <button type="button" onClick={() => seekTo(timeMs + settings.forwardSeconds * 1000)} aria-label={`前进 ${settings.forwardSeconds} 秒`}>+{settings.forwardSeconds}s</button>
          <button type="button" aria-pressed={settings.wholeTrackLoop} onClick={toggleWholeLoop} aria-label="单曲循环">循环</button>
        </div>
        <div className="vocal-dock__extra" role="group" aria-label="练习控制">
          <button type="button" aria-pressed={settings.skipRap} onClick={toggleSkipRap}>跳过 Rap</button>
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
          </>
        )}
        {/* 沉浸页空闲态不再常驻「自由练习」四个字：把那行空间让给歌词。
            但合练 / 逐句循环 / 整段循环这些**有信息量**的状态仍要显示，否则用户不知道在循环。 */}
        {(() => {
          const idle = modeText === '自由练习';
          const line = immersive
            ? [idle ? '' : modeText, skipRapBlocked ? '逐句练习不自动跳 Rap' : '', notice].filter(Boolean).join(' · ')
            : `${modeText}${skipRapBlocked ? '（逐句练习不自动跳 Rap）' : ''}${notice ? ` · ${notice}` : ''}`;
          return line ? <p className="vocal-dock__mode" role="status">{line}</p> : null;
        })()}
      </div>
      {/* 详情页用占位块顶开 fixed 播放器；沉浸页播放器本身在流内，无需占位。 */}
      {!immersive && <div className="vocal-dock-spacer" style={{ height: dockHeight }} aria-hidden="true" />}

      {showSettings && (
        <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) setShowSettings(false); }}>
          <div className="vocal-sheet" role="dialog" aria-modal="true" aria-label="循环与练习设置">
            <div className="vocal-sheet__head">
              <h2>循环与练习设置</h2>
              <button type="button" aria-label="关闭练习设置" onClick={() => setShowSettings(false)}>✕</button>
            </div>
            <p className="vocal-hint">只调整这条曲目的练唱习惯；主题、离线音乐与同步仍在底部「我的」。</p>
            <fieldset className="vocal-field">
              <legend>循环</legend>
              <div className="vocal-chips">
                <button type="button" aria-pressed={loopKey === '2'} disabled={!hasTiming} onClick={() => startLineLoop(2, '2')}>2 句</button>
                <button type="button" aria-pressed={loopKey === '4'} disabled={!hasTiming} onClick={() => startLineLoop(4, '4')}>4 句</button>
                <button type="button" aria-pressed={loopKey === 'custom'} disabled={!hasTiming} onClick={() => startLineLoop(settings.customRepeatLines, 'custom')}>
                  自定义 {settings.customRepeatLines} 句
                </button>
                <button
                  type="button"
                  aria-pressed={Boolean(currentSection && sectionLoop?.id === currentSection.id)}
                  disabled={!currentSection}
                  onClick={() => { if (currentSection) toggleSectionLoop(currentSection); }}
                >
                  本段循环
                </button>
                <button type="button" aria-pressed={settings.wholeTrackLoop} onClick={toggleWholeLoop}>整首循环</button>
                <button type="button" disabled={!loopKey && !sectionLoop && !settings.wholeTrackLoop} onClick={clearLoops}>关闭循环</button>
              </div>
              <p className="vocal-hint">{modeText}{currentSection ? ` · 当前段 ${currentSection.label}` : ''}</p>
            </fieldset>
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

      {/* 更多：原型主界面不摆音轨与译文纠错，但功能一个不少，全部落到这里 */}
      {moreOpen && (
        <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) setMoreOpen(false); }}>
          <div className="vocal-sheet" role="dialog" aria-modal="true" aria-label="更多">
            <div className="vocal-sheet__head">
              <h2>更多</h2>
              <button type="button" aria-label="关闭更多" onClick={() => setMoreOpen(false)}>✕</button>
            </div>
            <fieldset className="vocal-field">
              <legend>练习音轨</legend>
              <div className="vocal-chips">
                {(['original', 'accompaniment'] as PerformanceSource[]).map((role) => {
                  const ready = hasVocalTrack(tracks, role);
                  return (
                    <button
                      key={role}
                      type="button"
                      aria-pressed={source === role}
                      disabled={!ready || busy}
                      onClick={() => switchSource(role)}
                    >
                      {role === 'original' ? '原唱' : '伴奏'}{ready ? '' : '（未提供）'}
                    </button>
                  );
                })}
              </div>
              {!src && <p className="vocal-hint">还没有可播放的音轨；请回到曲目详情导入原唱或伴奏。</p>}
            </fieldset>
            <fieldset className="vocal-field">
              <legend>歌词与译文</legend>
              <div className="vocal-chips">
                <button
                  type="button"
                  aria-pressed={onlySectionLines}
                  disabled={!sections.length}
                  onClick={() => {
                    setOnlySectionLines((value) => {
                      const next = !value;
                      if (next && !focusedSectionId && playingSection) setFocusedSectionId(playingSection.id);
                      return next;
                    });
                  }}
                >
                  {onlySectionLines ? '显示全部歌词' : '只看本段歌词'}
                </button>
                {activeTranslation && (
                  <button
                    type="button"
                    onClick={() => {
                      if (!activeLineId) return;
                      beginCorrection(activeLineId, activeTranslation.text);
                      setMoreOpen(false);
                    }}
                  >
                    纠错当前句译文
                  </button>
                )}
                {translationSummary.missing > 0 && (
                  <button type="button" disabled={translating} onClick={() => void translateMissing()}>
                    {translating ? '正在翻译…' : `翻译缺失 ${translationSummary.missing} 句`}
                  </button>
                )}
              </div>
              {translations ? (
                <p className="vocal-hint">
                  {translationSummary.translated}/{translationSummary.total} 句 · {translationSourceLabel(translations)}
                  {translationSummary.stale > 0 ? ` · ${translationSummary.stale} 句原文已改` : ''}
                </p>
              ) : (
                <p className="vocal-hint">还没有中文译文；可先试 LRC 自带译文，再由翻译通道补齐。</p>
              )}
              {translationSummary.missing > 0 && (
                <p className="vocal-hint">翻译经 CodeBuddy 云端模型处理，歌词会发送到该服务；不是本地模型。</p>
              )}
            </fieldset>
            <fieldset className="vocal-field">
              <legend>结构与其他</legend>
              <div className="vocal-chips">
                <button type="button" onClick={() => { setMoreOpen(false); setDrawerOpen(true); }}>地图与结构</button>
                {onOpenDetail && (
                  <button type="button" onClick={() => { setMoreOpen(false); openDetail(); }}>曲目详情</button>
                )}
                {immersiveByUrl && onExitToLibrary && (
                  <button type="button" onClick={() => { setMoreOpen(false); onExitToLibrary(); }}>返回曲库</button>
                )}
              </div>
              <p className="vocal-hint">{currentSection ? `当前段 ${currentSection.label} · ` : ''}{modeText}</p>
            </fieldset>
            <button type="button" className="vocal-sheet__done" onClick={() => setMoreOpen(false)}>完成</button>
          </div>
        </div>
      )}

      {studioOpen && (
        <VocalStructureStudio
          item={item}
          audio={{ timeMs, playing, seek: seekTo, toggle: togglePlay }}
          onLoop={(range) => setSectionLoop(range ? { id: 'studio-loop', startMs: range.startMs, endMs: range.endMs } : null)}
          onClose={() => setStudioOpen(false)}
          onSaved={(count) => {
            setStudioOpen(false);
            setDraftReference(null);
            setNotice(`已保存 ${count} 段人工结构；之后重新分析不会再改写它。`);
          }}
        />
      )}

      {drawerOpen && (
        <div className="vocal-drawer-backdrop" onClick={(event) => { if (event.target === event.currentTarget) setDrawerOpen(false); }}>
          {/* 标题与关闭只留一套：都由里面的分段工作台提供，避免「地图 / 结构工作室」双标题、双 ✕。 */}
          <div className="vocal-drawer" role="dialog" aria-modal="true" aria-label="地图抽屉">
            <VocalStructureStudio
              presentation="drawer"
              item={item}
              audio={{ timeMs, playing, seek: seekTo, toggle: togglePlay }}
              onLoop={(range) => {
                setSectionLoop(range ? { id: 'drawer-loop', startMs: range.startMs, endMs: range.endMs } : null);
                if (!range) setNotice('已退出整段循环');
              }}
              onClose={() => setDrawerOpen(false)}
              onOpenDetail={onOpenDetail ? openDetail : undefined}
              onSaved={(count) => {
                setDrawerOpen(false);
                setDraftReference(null);
                setNotice(`已保存 ${count} 段人工结构；之后重新分析不会再改写它。`);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
