import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { ApiError } from '../lib/api';
import { editLocally } from '../lib/offline-editing';
import { sectionAtTime, sortSections, validateSections } from '../lib/vocal';
import {
  TYPE_ORDER, TYPE_TEXT, approveRapSection, clearRepeat, confirmRepeat, isRapConfirmed, previousSameType,
  relabelSections, revokeRapSection, setSectionType, splitSectionAt,
} from '../lib/vocal/structure';
import {
  clearStructureReference, draftSectionsOf, loadCatalogReference, loadStructureReference, readStructureDraft,
  readReferenceCatalog, readWaveform, reapplyStructureReference,
  type ReferenceCatalogEntry, type StructureDraft, type StructureWaveform,
} from '../lib/vocal/structure-api';
import {
  boundaryTimes, IDENTITY_TEXT, isReferenceSection, markReferenceSaved, moveBoundary, nudgeEdge, referenceCatalogFailureMessage,
  referenceHeadline, referencePending, snapBoundaryToLyrics, toSavableSections, type StudioSection,
} from '../lib/vocal/reference';
import type { TalentItem, VocalSectionType } from '../lib/types';
import '../styles/vocal-practice.css';
import '../styles/vocal-structure-touch.css';

/**
 * 结构工作室（P040 V3.4）：沉浸练歌页「地图」抽屉里的分段工作台。
 *
 * 2026-10-31 用户反馈「点进地图之后信息乱七八糟，不知道要干什么」，因此只重排信息层次，
 * 不改数据口径：
 *   ① 选一段 → ② 试听/循环这一段 → ③ 调整边界和类型 → ④ 确认并保存（保存栏常驻）。
 * 身份核验、参考文件导入这类技术说明收进「参考与导入（可选）」，默认不占首屏。
 *
 * - 播放器复用外面那一个 `<audio>`：定位、播放/暂停、整段循环都走父组件的同一套状态；
 * - 参考草稿只当候选显示：有争议的类型保留「待标注」，并标出来源分歧；
 * - 波形只用来拖动分界点，不参与类型判断；没有波形就退回时间刻度，绝不画假波形；
 * - 每次改动进撤销栈；保存是显式动作，落库后一律 `source='manual'`。
 */

interface AudioBridge {
  timeMs: number;
  playing: boolean;
  seek: (ms: number, autoplay?: boolean) => void;
  toggle: () => void;
}

interface Props {
  item: TalentItem;
  audio: AudioBridge;
  onLoop: (range: { startMs: number; endMs: number } | null) => void;
  onClose: () => void;
  onSaved: (count: number) => void;
  /** modal＝独立弹层；drawer＝嵌在练歌页地图抽屉里，不再套一层弹层和标题。 */
  presentation?: 'modal' | 'drawer';
  /** 抽屉里保留回「曲目详情」的入口（改歌名、歌词、音轨仍在详情页）。 */
  onOpenDetail?: () => void;
}

const MIN_SECTION_MS = 500;
const WAVE_WIDTH = 1000;
const WAVE_HEIGHT = 96;
/**
 * 分界线的触摸命中半径（屏幕像素）。旧实现按时长百分比（1.5%）判定，
 * 195 秒的歌在 360px 宽的屏上只有 ±5px，手指一按就落空变成 seek，所以改成按像素算。
 */
const HIT_SLOP_PX = 24;
/** 透明热区半宽：热区总宽 48px（视觉手柄仍是 r=9，不变粗）。 */
const HIT_ZONE_PX = 24;
const ACTION_ERROR: Record<string, string> = {
  SPLIT_TOO_CLOSE_TO_EDGE: '打点太靠近段落边缘（至少留 0.5 秒）',
  SECTION_NOT_FOUND: '段落不存在，请刷新后重试',
  BOUNDARY_NOT_FOUND: '找不到这条分界线，请刷新后重试',
  NO_PREVIOUS_SECTION: '这已经是第一段，没有上一段可合并',
  LYRICS_NOT_IDENTICAL: '两段歌词文字不一致，只能确认「换词」',
  TYPE_MISMATCH: '只能与同类型的更早段落建立重复关系',
  TARGET_MUST_BE_EARLIER: '重复关系只能指向更早的段落',
};

const fmt = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

const sec = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** 老 WebView 的 File 没有 text()，统一走 FileReader，避免「选了文件却读不出来」。 */
function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file);
  });
}

export default function VocalStructureStudio({
  item, audio, onLoop, onClose, onSaved, presentation = 'modal', onOpenDetail,
}: Props) {
  const drawer = presentation === 'drawer';
  const durationMs = Math.max(0, item.durationMs || 0, ...(item.sections ?? []).map((section) => section.endMs));
  /** 打开时的正式结构：首屏选段也按当前位置算，避免先闪一下「前奏」。 */
  const openedSections = useMemo(() => relabelSections(sortSections(item.sections ?? [])), [item.sections]);
  const [sections, setSections] = useState<StudioSection[]>(openedSections);
  const [history, setHistory] = useState<StudioSection[][]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => sectionAtTime(openedSections, audio.timeMs)?.id ?? null);
  /** 打开地图/切换数据时按当前位置选段；用户手动选过段后就不再被自动覆盖。 */
  const positionRef = useRef(audio.timeMs);
  positionRef.current = audio.timeMs;
  const selectedRef = useRef<string | null>(selectedId);
  selectedRef.current = selectedId;
  const manualPick = useRef(false);
  const [autoNote, setAutoNote] = useState('');
  const [draft, setDraft] = useState<StructureDraft | null>(null);
  const [source, setSource] = useState<'reference' | 'formal'>('formal');
  const [loading, setLoading] = useState(true);
  const [wave, setWave] = useState<StructureWaveform | null>(null);
  const [waveError, setWaveError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const loaded = useRef(false);
  const drag = useRef<number | null>(null);
  /** 正在拖动的手指/鼠标 id：只有它自己的 move/up 才作数，其他指针一律忽略。 */
  const dragPointer = useRef<number | null>(null);
  /** 真正拿到 pointer capture 的元素（可能是热区，也可能是 SVG 本身）。 */
  const captureEl = useRef<Element | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  /** 波形的实际渲染宽度：热区宽度要从「屏幕像素」换算回 viewBox 单位。 */
  const [waveWidth, setWaveWidth] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const [refBusy, setRefBusy] = useState(false);
  /** 正在循环的段：只影响体验提示，真正的循环区间仍由父组件播放器执行。 */
  const [loopingId, setLoopingId] = useState<string | null>(null);
  /** 本机内置参考：服务端按当前曲目身份五项核验后返回，用户不需要找文件。 */
  const [catalog, setCatalog] = useState<ReferenceCatalogEntry[] | null>(null);
  /** 目录读取失败的原因：401/旧服务/断网不能显示成「本机没有参考」。 */
  const [catalogError, setCatalogError] = useState('');
  const catalogLoaded = useRef(false);

  /**
   * 按当前播放位置选段：只改界面选中状态，不 seek、不播放、不写库。
   * 位置不落在任何一段里时保持「没有选中」，并说明原因，避免看起来像乱选了前奏。
   * 用户已经手动选过段（`manualPick`）就不再覆盖，除非是显式切换了数据来源。
   */
  function followPlayhead(next: StudioSection[], options: { force?: boolean } = {}): void {
    const at = positionRef.current;
    const current = selectedRef.current;
    const keepManual = manualPick.current && !options.force && Boolean(current && next.some((section) => section.id === current));
    if (keepManual) { setAutoNote(''); return; }
    const hit = sectionAtTime(next, at);
    setSelectedId(hit?.id ?? null);
    setAutoNote(hit || !next.length ? '' : `当前播放位置 ${fmt(at)} 不在任何一段内，没有自动选段；点上面任一段可手动选择。`);
  }

  /** 首次打开：优先用服务端草稿（参考/分析），没有草稿才用正式结构。只读，不写任何东西。 */
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    let alive = true;
    void (async () => {
      try {
        const remote = await readStructureDraft(item.id);
        if (!alive) return;
        setDraft(remote);
        const fromDraft = draftSectionsOf(remote);
        const formal = relabelSections(sortSections(item.sections ?? []));
        // 参考草稿还没被保存过：默认展示候选；保存过就默认回到正式结构，避免诱导重复保存。
        const showReference = Boolean(remote?.reference && fromDraft.length && referencePending(item.id, remote.reference?.loadedAt));
        if (showReference) {
          const next = relabelSections(sortSections(fromDraft));
          setSections(next);
          setSource('reference');
          followPlayhead(next);
        } else if (formal.length) {
          setSections(formal);
          setSource('formal');
          followPlayhead(formal);
        } else if (fromDraft.length) {
          const next = relabelSections(sortSections(fromDraft));
          setSections(next);
          setSource('reference');
          followPlayhead(next);
        }
      } catch {
        if (alive) setNotice('结构草稿没读到，先按当前正式结构编辑。');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [item.id]);

  /** 波形是可选增强：取不到就明确说明并退回时间刻度，不画假波形。 */
  useEffect(() => {
    let alive = true;
    void readWaveform(item.id, 600)
      .then((result) => { if (alive) setWave(result); })
      .catch(() => { if (alive) setWaveError('这台机器画不出波形，仍可按时间刻度拖动分界线。'); });
    return () => { alive = false; };
  }, [item.id]);

  /**
   * 内置参考目录：打开工作室就先核对一遍，有匹配就直接给「载入」按钮。
   * 读取失败只说明「查不到」，不写成「本机没有参考」——401/旧服务都可能是原因。
   */
  useEffect(() => {
    if (catalogLoaded.current) return;
    catalogLoaded.current = true;
    let alive = true;
    void readReferenceCatalog(item.id)
      .then((entries) => { if (alive) { setCatalog(entries); setCatalogError(''); } })
      .catch((error: unknown) => {
        if (!alive) return;
        setCatalog([]);
        setCatalogError(referenceCatalogFailureMessage(error));
      });
    return () => { alive = false; };
  }, [item.id]);

  const reference = draft?.reference ?? null;
  const ordered = useMemo(() => sortSections(sections) as StudioSection[], [sections]);
  const selected = useMemo(() => ordered.find((section) => section.id === selectedId) ?? null, [ordered, selectedId]);
  const previous = useMemo(() => (selected ? previousSameType(ordered, selected.id) : null), [ordered, selected]);
  const boundaries = useMemo(() => boundaryTimes(ordered), [ordered]);
  const waveMounted = Boolean(selected);
  /**
   * 只有选中段时才画波形：挂载后量一次实际宽度，热区的 48px 才能换算回 viewBox 单位。
   * 竖屏/横屏、抽屉宽度变化都要重新量，否则热区会跟视觉手柄错位。
   */
  useEffect(() => {
    const element = svgRef.current;
    if (!element) return undefined;
    const measure = (): void => {
      const next = element.getBoundingClientRect().width;
      setWaveWidth((current) => (Math.abs(current - next) > 0.5 ? next : current));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [waveMounted]);

  const referenceMarks = useMemo(() => ordered.filter(isReferenceSection), [ordered]);
  const disputedCount = useMemo(() => ordered.filter((section) => section.disputed).length, [ordered]);
  const hasFormal = (item.sections?.length ?? 0) > 0;
  const canSwitchSource = Boolean(draft?.reference) && hasFormal;
  /**
   * 重复关系标题只认真实状态：`repeatOf` + 具体 `repetition` 才算用户已确认；
   * 参考候选的 `repeatCandidateOf` 只是提示，永远不算确认。未确认时标题仍指向「上一段」这一候选目标。
   */
  const relationTarget = selected?.repeatOf ? ordered.find((section) => section.id === selected.repeatOf) ?? null : null;
  const relationConfirmed = selected?.repetition === 'exact-lyrics' || selected?.repetition === 'same-melody-new-lyrics';
  const relationLegend = relationConfirmed
    ? `与 ${relationTarget?.label ?? previous?.label ?? '更早同类型段'} 的重复关系（已确认：${selected?.repetition === 'exact-lyrics' ? '同词重复' : '旋律同、换词'}）`
    : `与上一段 ${previous?.label ?? '同类型段'} 的重复关系（待确认）`;

  function snapshot(next: StudioSection[], keepId?: string): void {
    setHistory((current) => [...current.slice(-19), sections]);
    const applied = relabelSections(sortSections(next));
    setSections(applied);
    const target = keepId ?? selectedId;
    setSelectedId(applied.some((section) => section.id === target) ? target : applied[0]?.id ?? null);
    setError('');
  }

  function run(action: () => StudioSection[], keepId?: string): void {
    try { snapshot(action(), keepId); } catch (cause) {
      const code = cause instanceof Error ? cause.message : 'UNKNOWN';
      setError(ACTION_ERROR[code] ?? `操作没完成：${code}`);
    }
  }

  function undo(): void {
    const previousState = history[history.length - 1];
    if (!previousState) return;
    setHistory(history.slice(0, -1));
    setSections(previousState);
    setSelectedId((current) => (previousState.some((section) => section.id === current) ? current : previousState[0]?.id ?? null));
    setError('');
    setNotice('已撤销上一步。');
  }

  function seekToSection(section: StudioSection): void {
    manualPick.current = true;
    setAutoNote('');
    setSelectedId(section.id);
    audio.seek(section.startMs);
  }

  /** 选段不偷偷改循环：循环仍停在原来的段，界面上如实说明。 */
  function loopSection(section: StudioSection): void {
    manualPick.current = true;
    setAutoNote('');
    setSelectedId(section.id);
    onLoop({ startMs: section.startMs, endMs: section.endMs });
    setLoopingId(section.id);
    setNotice(`正在循环 ${section.label}：${fmt(section.startMs)}–${fmt(section.endMs)}`);
  }

  function stopLoop(): void {
    onLoop(null);
    setLoopingId(null);
    setNotice('已停止循环。');
  }

  function toggleLoop(section: StudioSection): void {
    if (loopingId === section.id) { stopLoop(); return; }
    loopSection(section);
  }

  /** 试听这一段：先回到段首，暂停状态下顺手开播。 */
  function audition(section: StudioSection): void {
    if (audio.playing) { audio.seek(section.startMs); return; }
    audio.seek(section.startMs, true);
  }

  /** 播放位置打点：切开包含它的那一段；没有段落时从 0 建一段再切。 */
  function tapAtPlayhead(): void {
    const at = Math.round(audio.timeMs);
    if (!ordered.length) {
      const endMs = Math.max(at + MIN_SECTION_MS * 2, Math.min(durationMs || at + 10000, at + 10000));
      run(() => [{ id: `manual-${Date.now().toString(36)}`, type: 'unknown', label: 'U', startMs: 0, endMs, source: 'manual' }]);
      return;
    }
    const target = ordered.find((section) => at > section.startMs && at < section.endMs) ?? selected;
    if (!target) {
      setError('当前位置不在任何一段里：先点上面选一段，再打点。');
      return;
    }
    run(() => splitSectionAt(ordered, target.id, at) as StudioSection[], target.id);
  }

  function addSection(): void {
    const startMs = ordered.length ? ordered[ordered.length - 1].endMs : 0;
    const endMs = Math.max(startMs + 1000, Math.min(durationMs || startMs + 10000, startMs + 10000));
    const id = `manual-${Date.now().toString(36)}`;
    run(() => [...ordered, { id, type: 'verse', label: 'A', startMs, endMs, source: 'manual' } as StudioSection], id);
  }

  function removeSection(): void {
    if (!selected) return;
    run(() => ordered.filter((section) => section.id !== selected.id));
  }

  /** 显式改类型即视为用户拍板：清掉争议标记，但仍留在草稿里，保存后才落库。 */
  function changeType(type: VocalSectionType): void {
    if (!selected) return;
    run(() => setSectionType(ordered, selected.id, type).map((section) => (
      section.id === selected.id ? { ...section, disputed: false, alternates: [] } : section
    )) as StudioSection[], selected.id);
  }

  function confirmRepeatWith(previousSection: StudioSection, relation: 'exact-lyrics' | 'same-melody-new-lyrics'): void {
    if (!selected) return;
    run(() => confirmRepeat(ordered, selected.id, previousSection.id, relation, item.lyrics ?? []) as StudioSection[], selected.id);
  }

  /** 波形的屏幕几何：命中判定一律用像素，不再用在时长里的百分比。 */
  function waveBox(): { left: number; width: number } {
    const rect = svgRef.current?.getBoundingClientRect();
    // 量不到宽度（还没布局完）时按 1 单位 = 1px 兜底，至少不会把整块判定成「没点中」。
    return { left: rect?.left ?? 0, width: rect && rect.width > 0 ? rect.width : WAVE_WIDTH };
  }

  /** 波形/刻度上的拖动：只改分界点，左右两段同时更新。 */
  function timeFromPointer(event: ReactPointerEvent<SVGSVGElement>): number | null {
    const { left, width } = waveBox();
    if (!durationMs) return null;
    const ratio = Math.min(1, Math.max(0, (event.clientX - left) / width));
    return Math.round(ratio * durationMs);
  }

  /** 手指/鼠标落点附近的最近分界线；超过 HIT_SLOP_PX 就算没命中。 */
  function boundaryNear(clientX: number): number | null {
    const { left, width } = waveBox();
    if (!durationMs || !boundaries.length) return null;
    let best: { time: number; distance: number } | null = null;
    for (const time of boundaries) {
      const distance = Math.abs(clientX - (left + (time / durationMs) * width));
      if (distance > HIT_SLOP_PX) continue;
      if (!best || distance < best.distance) best = { time, distance };
    }
    return best?.time ?? null;
  }

  /**
   * 开始拖动：进撤销栈 + 抢 pointer capture。
   * capture 一定要挂在 SVG 上：分界线的 key/坐标每帧都在变，挂在手柄元素上会随 DOM 重建丢掉捕获。
   */
  function beginDrag(event: ReactPointerEvent<SVGElement>, time: number): void {
    drag.current = time;
    dragPointer.current = event.pointerId;
    setHistory((current) => [...current.slice(-19), ordered]);
    setError('');
    const target = svgRef.current ?? (event.currentTarget as SVGElement);
    captureEl.current = target;
    target.setPointerCapture?.(event.pointerId);
    // SVG 上已经是 touch-action:none；这里再挡一次，防止安卓 WebView 把后续 move 当滚动。
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
  }

  function endDrag(event?: ReactPointerEvent<SVGElement>): void {
    const id = dragPointer.current;
    const target = captureEl.current;
    drag.current = null;
    dragPointer.current = null;
    captureEl.current = null;
    if (!event || id === null || !target) return;
    const capture = target as Element & { hasPointerCapture?: (id: number) => boolean; releasePointerCapture?: (id: number) => void };
    if (capture.hasPointerCapture?.(id)) capture.releasePointerCapture?.(id);
  }

  /** 是否还握着 capture：握着就说明拖动没结束，pointerleave 不能当成抬手。 */
  function stillCaptured(event: ReactPointerEvent<SVGElement>): boolean {
    const id = dragPointer.current;
    if (id === null) return false;
    const target = (captureEl.current ?? event.currentTarget) as Element & { hasPointerCapture?: (id: number) => boolean };
    return target.hasPointerCapture?.(id) === true;
  }

  function onPointerDown(event: ReactPointerEvent<SVGSVGElement>): void {
    const at = timeFromPointer(event);
    if (at === null) return;
    const boundary = boundaryNear(event.clientX);
    if (boundary === null) { audio.seek(at); return; }
    beginDrag(event as ReactPointerEvent<SVGElement>, boundary);
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>): void {
    if (drag.current === null) return;
    if (dragPointer.current !== null && event.pointerId !== dragPointer.current) return;
    const at = timeFromPointer(event);
    if (at === null) return;
    if (event.cancelable) event.preventDefault();
    try {
      const next = moveBoundary(ordered, drag.current, at, durationMs);
      // 拖动后分界点的真实位置会被夹住：以结果里最接近指针的那条为准，继续拖才不会跳。
      const nextBoundaries = boundaryTimes(next);
      if (nextBoundaries.length) {
        drag.current = nextBoundaries.reduce((best, value) => (Math.abs(value - at) < Math.abs(best - at) ? value : best), nextBoundaries[0]);
      }
      setSections(next);
    } catch { /* 拖到边上会被夹住，忽略即可 */ }
  }

  function onPointerUp(event: ReactPointerEvent<SVGSVGElement>): void { endDrag(event as ReactPointerEvent<SVGElement>); }

  function onPointerLeave(event: ReactPointerEvent<SVGSVGElement>): void {
    // 触摸拖动期间已经拿到 capture；此时 leave 只是手指滑出了 SVG 边界，不能提前结束拖动。
    if (stillCaptured(event as ReactPointerEvent<SVGElement>)) return;
    endDrag();
  }

  function switchSource(next: 'reference' | 'formal'): void {
    const fromDraft = relabelSections(sortSections(draftSectionsOf(draft)));
    const formal = relabelSections(sortSections(item.sections ?? []));
    const target = next === 'reference' ? fromDraft : formal;
    if (!target.length) return;
    setSource(next);
    setSections(target);
    // 换了数据集，旧选中项的 id 已经不存在：按当前位置重新选一次（仍是只读显示）。
    followPlayhead(target, { force: true });
    setHistory([]);
    setNotice(next === 'reference' ? '已切到参考候选（还没保存，正式结构不变）。' : '已切回当前正式结构。');
  }

  /** 身份核验失败时把「哪一项不一致」原样列出来，而不是只说一句「不通过」。 */
  function identityDetail(cause: unknown): string {
    const payload = cause instanceof ApiError ? cause.payload as { error?: { identity?: { blockers?: { detail?: string }[] } } } | null : null;
    const blockers = payload?.error?.identity?.blockers ?? [];
    return blockers.length ? `（${blockers.slice(0, 3).map((item2) => item2.detail).filter(Boolean).join('；')}）` : '';
  }

  /** 载入结果统一落到界面：候选段进地图，来源切到参考，历史清空。 */
  function applyLoadedDraft(next: StructureDraft, note: string): void {
    const sectionsNext = relabelSections(sortSections(draftSectionsOf(next)));
    setDraft(next);
    setSections(sectionsNext);
    setSource('reference');
    followPlayhead(sectionsNext, { force: true });
    setHistory([]);
    setNotice(note);
  }

  /**
   * 载入本机内置参考：不需要用户找文件，也不需要转换格式。
   * 服务端用当前曲目元数据 + 现算文件摘要复核身份五项，不过就整份拒绝。
   */
  async function loadCatalogEntry(entry: ReferenceCatalogEntry): Promise<void> {
    if (!entry.identity.ok) {
      setError(`这份参考和当前歌曲不是同一首：${blockerText(entry.identity)}`);
      return;
    }
    setRefBusy(true); setError(''); setNotice('');
    try {
      const result = await loadCatalogReference(item.id, entry.id);
      const count = draftSectionsOf(result.draft).length;
      applyLoadedDraft(result.draft, `已载入本机参考 ${count} 段候选（未保存，正式结构不变）；有争议的段落仍是「待标注」。`);
    } catch (cause) {
      setError(`参考没载入：${cause instanceof Error && cause.message ? cause.message : '请重试'}${identityDetail(cause)}`);
    } finally { setRefBusy(false); }
  }

  function blockerText(identity: ReferenceCatalogEntry['identity']): string {
    const blockers = identity.blockers ?? [];
    return blockers.length ? blockers.slice(0, 3).map((blocker) => blocker.detail).join('；') : '未提供原因';
  }

  /**
   * 载入参考结构：文件在浏览器里解析后交给草稿接口，服务端再核验身份。
   * 不抓取任何在线内容，也不接收第三方歌词正文；失败不留下任何草稿。
   */
  async function loadReferenceFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setRefBusy(true); setError(''); setNotice('');
    try {
      const text = await readFileText(file);
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { throw new Error('这个文件不是有效的 JSON'); }
      const result = await loadStructureReference(item.id, payload);
      const count = draftSectionsOf(result.draft).length;
      applyLoadedDraft(result.draft, `已载入参考候选 ${count} 段（未保存，正式结构不变）；有争议的段落仍是「待标注」。`);
    } catch (cause) {
      setError(`参考文件没载入：${cause instanceof Error && cause.message ? cause.message : '请检查文件内容'}${identityDetail(cause)}`);
    } finally {
      setRefBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  /** 放弃参考草稿：回到载入前的地图，正式结构自始至终没被写过。 */
  async function dropReference(): Promise<void> {
    setRefBusy(true); setError('');
    try {
      const result = await clearStructureReference(item.id);
      const next = relabelSections(sortSections(draftSectionsOf(result.draft)));
      const applied = next.length ? next : relabelSections(sortSections(item.sections ?? []));
      setDraft(result.draft);
      setSections(applied);
      setSource('reference');
      followPlayhead(applied, { force: true });
      setHistory([]);
      setNotice('已放弃参考候选；正式结构没动。');
    } catch (cause) {
      setError(`放弃参考没成功：${cause instanceof Error && cause.message ? cause.message : '请重试'}`);
    } finally { setRefBusy(false); }
  }

  /** 重新分析后把上次的参考候选放回地图（同样只写草稿）。 */
  async function restoreReference(): Promise<void> {
    setRefBusy(true); setError('');
    try {
      const result = await reapplyStructureReference(item.id);
      const next = relabelSections(sortSections(draftSectionsOf(result.draft)));
      setDraft(result.draft);
      setSections(next);
      setSource('reference');
      followPlayhead(next, { force: true });
      setHistory([]);
      setNotice(`已重新载入参考候选 ${next.length} 段（未保存）。`);
    } catch (cause) {
      setError(`参考候选取回失败：${cause instanceof Error && cause.message ? cause.message : '请重试'}`);
    } finally { setRefBusy(false); }
  }

  async function save(): Promise<void> {
    setBusy(true); setError('');
    const next = relabelSections(sortSections(sections));
    const issues = validateSections(next, durationMs || undefined, { persisted: item.sections ?? [] });
    if (issues.length) {
      setError(`结构没保存：${issues.slice(0, 3).join('、')}`);
      setBusy(false);
      return;
    }
    try {
      await editLocally({ kind: 'VOCAL', id: item.id }, { sections: toSavableSections(next) }, 'update');
      markReferenceSaved(item.id);
      setSource('formal');
      setLoopingId(null);
      onLoop(null);
      onSaved(next.length);
    } catch (cause) {
      setError(`结构没保存：${cause instanceof Error && cause.message ? cause.message : '请检查网络后重试'}`);
    } finally { setBusy(false); }
  }

  const widthOf = (section: StudioSection): number => (durationMs ? (section.endMs - section.startMs) / durationMs : 0);
  const xOf = (ms: number): number => (durationMs ? (ms / durationMs) * WAVE_WIDTH : 0);
  /** 48px 热区换算成 viewBox 单位：viewBox 宽 1000，屏上只有 300 多 px，不能用固定 r。 */
  const hitHalf = HIT_ZONE_PX * (waveWidth > 0 ? WAVE_WIDTH / waveWidth : 1);

  const statusText = loading
    ? '正在读取…'
    : ordered.length
      ? `${ordered.length} 段${source === 'reference' ? ' · 参考候选（未保存）' : ' · 当前正式结构'}${disputedCount ? ` · ${disputedCount} 段待核对` : ''}`
      : source === 'reference' ? '还没有分段 · 参考候选是空的' : '还没有分段';

  const sheet = (
    <div
      className={`vocal-sheet vocal-sheet--wide vocal-studio${drawer ? ' vocal-studio--drawer' : ''}`}
      role={drawer ? undefined : 'dialog'}
      aria-modal={drawer ? undefined : true}
      aria-label={drawer ? undefined : '结构工作室'}
    >
      <div className="vocal-map__head">
        <div className="vocal-map__headtext">
          <h2>歌曲分段</h2>
          <p className="vocal-map__sub" role="status">{statusText}</p>
        </div>
        <button
          type="button"
          className="vocal-map__close"
          aria-label={drawer ? '关闭地图抽屉' : '关闭结构工作室'}
          disabled={busy}
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      {/* ① 选一段：先把「这首歌分成哪几段」摆出来（横排，长歌也只占一行） */}
      <section className="vocal-map__step">
        <p className="vocal-map__steplabel"><span aria-hidden="true">1</span>选一段</p>
        {ordered.length ? (
          <div className="vocal-map" role="group" aria-label="结构段落">
            {ordered.map((section) => {
              const disputed = section.disputed === true;
              return (
                <button
                  key={section.id}
                  type="button"
                  className={[
                    'vocal-map__chip', `vocal-map__chip--${section.type}`,
                    section.id === selectedId ? 'is-focused' : '',
                    section.id === loopingId ? 'is-looping' : '',
                    isReferenceSection(section) ? 'is-reference' : '',
                  ].filter(Boolean).join(' ')}
                  aria-pressed={section.id === selectedId}
                  aria-label={`选择 ${section.label}，${TYPE_TEXT[section.type]}，${fmt(section.startMs)} 到 ${fmt(section.endMs)}`}
                  onClick={() => seekToSection(section)}
                >
                  <span className="vocal-map__code">{section.label}</span>
                  {section.label !== TYPE_TEXT[section.type] && (
                    <span className="vocal-map__type">{TYPE_TEXT[section.type]}</span>
                  )}
                  <span className="vocal-map__time">{fmt(section.startMs)}–{fmt(section.endMs)}</span>
                  {disputed && <span className="vocal-map__flag vocal-map__flag--pending">待核对</span>}
                  {section.endUnverified && <span className="vocal-map__flag">结尾未定</span>}
                  {section.anchor && !section.anchor.snapped && <span className="vocal-map__flag">未锚上</span>}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="vocal-map__empty">
            <p>这首歌还没有段落。先播放，听到要分开的地方，点下面「播放位置打点」，就会从当前位置切出一段；分错了可以撤销。</p>
            <p className="vocal-map__note">也可以载入本机参考候选，或在末尾新增一段。这里只反映真实结构——服务不可用时会单独提示，不会当成「这首歌没有结构」。</p>
          </div>
        )}
        {/* 打开地图时按播放位置选段；位置不落在任何一段里就明说，而不是悄悄选前奏。 */}
        {autoNote && <p className="vocal-map__note" role="status">{autoNote}</p>}
        <div className="vocal-studio__bars" role="group" aria-label="分段操作">
          <button type="button" disabled={busy} title="从当前播放位置切开所选段" onClick={tapAtPlayhead}>播放位置打点</button>
          <button type="button" disabled={busy} onClick={addSection}>在末尾新增一段</button>
          {/* 删掉最后一段后没有选中段，第 ③ 步会消失；撤销必须留在这里，否则删了就退不回。 */}
          {!selected && <button type="button" disabled={busy || !history.length} onClick={undo}>撤销</button>}
        </div>
      </section>

      {/* ② 试听这一段：选中段必须有明确的试听/循环入口 */}
      {selected && (
        <section className="vocal-map__step">
          <p className="vocal-map__steplabel"><span aria-hidden="true">2</span>试听这一段</p>
          <div className="vocal-map__now">
            <p className="vocal-map__nowtitle">
              {selected.label}{selected.label !== TYPE_TEXT[selected.type] ? ` · ${TYPE_TEXT[selected.type]}` : ''}
            </p>
            <p className="vocal-map__nowmeta">
              {sec(selected.startMs)}–{sec(selected.endMs)} · 时长 {sec(selected.endMs - selected.startMs)}
              {selected.referenceLabel ? ` · 参考写法：${selected.referenceLabel}` : ''}
              {selected.disputed && selected.alternates?.length ? ` · 来源分歧：${selected.alternates.join(' / ')}` : ''}
              {selected.anchor && !selected.anchor.snapped ? ' · 这条边界没对上歌词行' : ''}
            </p>
            <div className="vocal-map__playbar">
              <button type="button" className="vocal-map__play" disabled={busy} onClick={() => audition(selected)}>
                {audio.playing ? '❚❚ 暂停' : '▶ 试听'}
              </button>
              <button type="button" aria-pressed={loopingId === selected.id} disabled={busy} onClick={() => toggleLoop(selected)}>
                {loopingId === selected.id ? '停止循环' : '整段循环'}
              </button>
              <button type="button" disabled={busy} onClick={() => audio.seek(selected.startMs)}>回到段首</button>
            </div>
            {loopingId && loopingId !== selected.id && (
              <p className="vocal-map__note">
                现在循环的是 {ordered.find((section) => section.id === loopingId)?.label ?? '另一段'}；点它再点「停止循环」可结束。
              </p>
            )}
            {loopingId === selected.id && (
              <p className="vocal-map__note">循环中：只会在这段里反复播放。</p>
            )}
          </div>
        </section>
      )}

      {/* ③ 调整边界和类型 */}
      {selected && (
        <section className="vocal-map__step">
          <p className="vocal-map__steplabel"><span aria-hidden="true">3</span>调整边界和类型</p>
          <div className="vocal-wave-wrap">
            <p className="vocal-map__note">拖动竖线改分界点；粉色虚线是当前播放位置。</p>
            <svg
              ref={svgRef}
              className="vocal-wave"
              viewBox={`0 0 ${WAVE_WIDTH} ${WAVE_HEIGHT}`}
              role="img"
              aria-label="原曲波形与段落分界"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={onPointerLeave}
              onLostPointerCapture={() => { drag.current = null; dragPointer.current = null; captureEl.current = null; }}
            >
              {ordered.map((section) => (
                <rect
                  key={`band-${section.id}`}
                  className={`vocal-wave__band vocal-wave__band--${section.type}${section.id === selectedId ? ' is-selected' : ''}`}
                  x={xOf(section.startMs)}
                  y={0}
                  width={Math.max(0.5, widthOf(section) * WAVE_WIDTH)}
                  height={WAVE_HEIGHT}
                />
              ))}
              {wave && wave.peaks.map((peak, index) => {
                const step = WAVE_WIDTH / wave.peaks.length;
                return (
                  <rect
                    key={`peak-${index}`}
                    className="vocal-wave__peak"
                    x={index * step}
                    y={WAVE_HEIGHT / 2 - (peak * WAVE_HEIGHT) / 2}
                    width={Math.max(0.6, step * 0.7)}
                    height={Math.max(1, peak * WAVE_HEIGHT)}
                  />
                );
              })}
              {boundaries.map((time, index) => (
                <g key={`boundary-${index}`}>
                  <line className="vocal-wave__line" x1={xOf(time)} x2={xOf(time)} y1={0} y2={WAVE_HEIGHT} />
                  <circle className="vocal-wave__handle" data-testid={`boundary-${time}`} cx={xOf(time)} cy={WAVE_HEIGHT / 2} r={9} />
                  {/* 透明热区：视觉手柄不变粗，手指有 48px 宽的可按范围 */}
                  <rect
                    className="vocal-wave__hit"
                    data-testid={`boundary-hit-${time}`}
                    data-boundary-ms={time}
                    x={xOf(time) - hitHalf}
                    y={0}
                    width={hitHalf * 2}
                    height={WAVE_HEIGHT}
                    onPointerDown={(event) => beginDrag(event, time)}
                  />
                </g>
              ))}
              <line className="vocal-wave__playhead" x1={xOf(audio.timeMs)} x2={xOf(audio.timeMs)} y1={0} y2={WAVE_HEIGHT} />
            </svg>
            <div className="vocal-wave__ruler" aria-hidden="true">
              {Array.from({ length: 5 }, (_, index) => (
                <span key={index}>{fmt((durationMs / 4) * index)}</span>
              ))}
            </div>
            {waveError && <p className="vocal-map__note" role="status">{waveError}</p>}
            {!wave && !waveError && <p className="vocal-map__note">正在生成波形…</p>}
          </div>

          <fieldset className="vocal-field">
            <legend>微调分界点（0.1 / 0.5 秒）</legend>
            <div className="vocal-studio__nudge">
              <button type="button" disabled={busy || ordered.findIndex((section) => section.id === selected.id) === 0}
                onClick={() => run(() => nudgeEdge(ordered, selected.id, 'start', -500, durationMs) as StudioSection[], selected.id)}>
                起点 −0.5s
              </button>
              <button type="button" disabled={busy || ordered.findIndex((section) => section.id === selected.id) === 0}
                onClick={() => run(() => nudgeEdge(ordered, selected.id, 'start', -100, durationMs) as StudioSection[], selected.id)}>
                起点 −0.1s
              </button>
              <button type="button" disabled={busy || ordered.findIndex((section) => section.id === selected.id) === 0}
                onClick={() => run(() => nudgeEdge(ordered, selected.id, 'start', 100, durationMs) as StudioSection[], selected.id)}>
                起点 +0.1s
              </button>
              <button type="button" disabled={busy || ordered.findIndex((section) => section.id === selected.id) === 0}
                onClick={() => run(() => nudgeEdge(ordered, selected.id, 'start', 500, durationMs) as StudioSection[], selected.id)}>
                起点 +0.5s
              </button>
              <button type="button" disabled={busy || ordered[ordered.length - 1]?.id === selected.id}
                onClick={() => run(() => nudgeEdge(ordered, selected.id, 'end', -500, durationMs) as StudioSection[], selected.id)}>
                终点 −0.5s
              </button>
              <button type="button" disabled={busy || ordered[ordered.length - 1]?.id === selected.id}
                onClick={() => run(() => nudgeEdge(ordered, selected.id, 'end', -100, durationMs) as StudioSection[], selected.id)}>
                终点 −0.1s
              </button>
              <button type="button" disabled={busy || ordered[ordered.length - 1]?.id === selected.id}
                onClick={() => run(() => nudgeEdge(ordered, selected.id, 'end', 100, durationMs) as StudioSection[], selected.id)}>
                终点 +0.1s
              </button>
              <button type="button" disabled={busy || ordered[ordered.length - 1]?.id === selected.id}
                onClick={() => run(() => nudgeEdge(ordered, selected.id, 'end', 500, durationMs) as StudioSection[], selected.id)}>
                终点 +0.5s
              </button>
              <button type="button" disabled={busy || ordered.findIndex((section) => section.id === selected.id) === 0}
                onClick={() => run(() => snapBoundaryToLyrics(ordered, selected.startMs, item.lyrics ?? [], 1500, durationMs) as StudioSection[], selected.id)}>
                分界对齐歌词行
              </button>
            </div>
            <p className="vocal-map__note">拖不准就用按钮微调；也可以在播放位置点「播放位置打点」直接切开。只吸附到 1.5 秒内最近的歌词行首；对不上就保持原值。</p>
          </fieldset>

          <fieldset className="vocal-field">
            <legend>这段是什么类型</legend>
            <div className="vocal-chips">
              {TYPE_ORDER.map((type) => (
                <button key={type} type="button" aria-pressed={selected.type === type} disabled={busy} onClick={() => changeType(type)}>
                  {TYPE_TEXT[type]}
                </button>
              ))}
            </div>
            {selected.disputed && (
              <p className="vocal-map__note" role="status">这段在两个来源里写法不同，先保留「待标注」；你点选类型才算确认。</p>
            )}
          </fieldset>

          {/* 选 Rap 只是改类型；能不能跳过要靠这里显式确认，保存本身不等于确认。 */}
          {selected.type === 'rap' && (
            <fieldset className="vocal-field">
              <legend>Rap 跳过确认</legend>
              <p className="vocal-map__note" role="status">
                {isRapConfirmed(selected)
                  ? '已确认这一段是 Rap：练唱时会自动跳过；逐句/整段循环优先，不会被跳抢走。'
                  : '还没确认：只改类型不算数，练唱暂时不会跳过这一段。'}
              </p>
              <div className="vocal-chips">
                <button
                  type="button"
                  aria-pressed={isRapConfirmed(selected)}
                  disabled={busy || isRapConfirmed(selected)}
                  onClick={() => run(() => approveRapSection(ordered, selected.id) as StudioSection[], selected.id)}
                >
                  确认这段是 Rap（可跳过）
                </button>
                <button
                  type="button"
                  disabled={busy || !isRapConfirmed(selected)}
                  onClick={() => run(() => revokeRapSection(ordered, selected.id) as StudioSection[], selected.id)}
                >
                  取消确认
                </button>
              </div>
              <p className="vocal-map__note">确认标记随结构一起保存，重新打开地图仍然有效；边界改完请再听一遍。</p>
            </fieldset>
          )}

          {previous && (
            <fieldset className="vocal-field">
              <legend>{relationLegend}</legend>
              <div className="vocal-chips">
                <button type="button" disabled={busy} aria-pressed={selected.repeatOf === previous.id && selected.repetition === 'exact-lyrics'}
                  onClick={() => confirmRepeatWith(previous, 'exact-lyrics')}>同词重复</button>
                <button type="button" disabled={busy} aria-pressed={selected.repeatOf === previous.id && selected.repetition === 'same-melody-new-lyrics'}
                  onClick={() => confirmRepeatWith(previous, 'same-melody-new-lyrics')}>旋律同、换词</button>
                <button type="button" disabled={busy || !selected.repeatOf} onClick={() => run(() => clearRepeat(ordered, selected.id) as StudioSection[], selected.id)}>不重复</button>
              </div>
              <p className="vocal-map__note">相似度只作提示；确认前不会写成重复，也不会自动跳过。</p>
            </fieldset>
          )}

          <div className="vocal-studio__bars" role="group" aria-label="撤销与删除">
            <button type="button" disabled={busy || !history.length} onClick={undo}>撤销</button>
            <button type="button" className="vocal-map__dangerbtn" disabled={busy} onClick={removeSection}>删除这一段</button>
          </div>
        </section>
      )}

      {/* 参考与导入：技术说明默认收起，不占首屏 */}
      <details className="vocal-map__more">
        <summary>参考与导入（可选）</summary>
        <p className="vocal-map__note">没有参考也能分段，上面的步骤不受影响。只有想用现成参考时才需要这里。</p>

        {canSwitchSource && (
          <>
            <div className="vocal-studio__bars" role="group" aria-label="结构来源">
              <button type="button" aria-pressed={source === 'reference'} disabled={refBusy || busy} onClick={() => switchSource('reference')}>参考候选</button>
              <button type="button" aria-pressed={source === 'formal'} disabled={refBusy || busy} onClick={() => switchSource('formal')}>当前正式结构</button>
            </div>
            <p className="vocal-map__note">
              现在编辑的是{source === 'reference' ? '参考候选' : '当前正式结构'}；保存哪一份由你决定，不会自动覆盖。
            </p>
          </>
        )}

        <div className="vocal-ref-catalog" role="group" aria-label="本机参考结构">
          <p className="vocal-ref-catalog__title">本机已提供的参考</p>
          {catalog === null ? (
            <p className="vocal-map__note">正在核对本机参考…</p>
          ) : catalogError ? (
            <p className="vocal-map__note vocal-hint--warn">{catalogError}</p>
          ) : catalog.length === 0 ? (
            <p className="vocal-map__note">这台设备上没有这首歌的现成参考；直接用上面的打点或载入一份参考文件即可。</p>
          ) : catalog.map((entry) => {
            const addable = entry.identity.ok;
            return (
              <div key={entry.id} className="vocal-ref-catalog__item" role="status">
                <span className="vocal-ref-catalog__name">
                  {entry.songTitle} · {entry.artist}{entry.version ? ` · ${entry.version}` : ''}
                </span>
                <span className="vocal-map__note">
                  {addable
                    ? `身份五项一致 · ${entry.candidateCount} 段候选${entry.disputedCount ? ` · ${entry.disputedCount} 段类型有争议` : ''}`
                    : `身份不匹配，不能载入：${blockerText(entry.identity)}`}
                </span>
                <button type="button" disabled={!addable || refBusy || busy} onClick={() => void loadCatalogEntry(entry)}>
                  {addable ? '载入这份参考' : '不可载入'}
                </button>
              </div>
            );
          })}
        </div>

        <div className="vocal-studio__bars" role="group" aria-label="参考结构文件">
          <label className="vocal-file">
            <span>{refBusy ? '正在核对…' : '载入参考文件'}</span>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              aria-label="载入参考文件"
              disabled={refBusy || busy}
              onChange={(event) => void loadReferenceFile(event.target.files?.[0])}
            />
          </label>
          {reference && (
            <button type="button" disabled={refBusy || busy} onClick={() => void dropReference()}>放弃参考</button>
          )}
          {reference && !referenceMarks.length && (
            <button type="button" disabled={refBusy || busy} onClick={() => void restoreReference()}>重新载入上次参考</button>
          )}
        </div>
        <p className="vocal-map__note">
          参考文件只读结构类型、秒数和原音频摘要；不联网抓取，也不保存第三方歌词；核验不过就整份拒绝。
        </p>

        {reference && (
          <div className="vocal-ref" role="status" aria-label="参考结构核验">
            <p className="vocal-ref__headline">{referenceHeadline(reference)}</p>
            <p className="vocal-map__note">
              身份核验：{reference.identity.checks.map((check) => `${IDENTITY_TEXT[check.id] ?? check.id}${check.ok ? '✓' : '✗'}`).join(' ')}
              {' '}·{' '}
              {reference.identity.ok ? '全部一致' : '未通过，已拒绝载入'}
              {reference.disputedCount ? ` · ${reference.disputedCount} 段来源写法不一致（Refrain / Verse）` : ''}
            </p>
            <p className="vocal-map__note">
              来源：{reference.source || '未标注'}。边界来自你现有 LRC 的对应行，不是乐句实测线；末段结束时间只到曲尾。
            </p>
          </div>
        )}
      </details>

      {onOpenDetail && (
        <div className="vocal-map__detailrow">
          <button type="button" className="vocal-map__detaillink" onClick={onOpenDetail}>曲目详情</button>
          <span className="vocal-map__note">改歌名、歌词、音轨仍在详情页。</span>
        </div>
      )}

      {/* ④ 确认并保存：保存栏常驻，不点它就绝不改正式结构 */}
      <div className="vocal-studio__save">
        {error && <p className="vocal-map__alert" role="alert">{error}</p>}
        {notice && <p className="vocal-map__notice" role="status">{notice}</p>}
        <button type="button" className="vocal-studio__savebtn" disabled={busy || !sections.length} onClick={() => void save()}>
          {busy ? '正在保存…' : '保存为人工结构'}
        </button>
        <p className="vocal-map__savetip">
          {source === 'reference' ? '点这里才会把候选变成正式结构。' : '只有点这里才会改正式结构。'}
        </p>
      </div>
    </div>
  );

  if (drawer) return sheet;
  return (
    <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      {sheet}
    </div>
  );
}
