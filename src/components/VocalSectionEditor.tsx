import { useEffect, useMemo, useRef, useState } from 'react';
import { editLocally } from '../lib/offline-editing';
import { sortSections, talentDurationMs, validateSections } from '../lib/vocal';
import {
  TYPE_ORDER, TYPE_TEXT, approveRapSection, clearRepeat, confirmRepeat, isRapConfirmed, lyricsIdentical,
  mergeWithPrevious, previousSameType, relabelSections, revokeRapSection, sectionsSignature, setSectionType, splitSectionAt,
} from '../lib/vocal/structure';
import type { TalentItem, VocalSection, VocalSectionType } from '../lib/types';
import '../styles/vocal-practice.css';

/**
 * 结构人工校准（V3.2）：先在地图上看段落，再只对选中的一段做操作。
 *
 * - 拆分只用歌词句或播放位置，不要求用户先算秒数；
 * - 合并、改类型、确认重复关系都是一键，且都标记 source='manual'；
 * - 「同词」必须先核对歌词文字确实一致（韩文换空格算一致，中韩译文不算）；
 * - 秒数精调仍保留，但不是默认路径；保存前统一校验，不静默丢弃改动。
 */

const ISSUE_TEXT: Record<string, string> = {
  MISSING_ID: '段落缺少标识',
  INVALID_TIME: '开始或结束时间不可用',
  NEGATIVE_START: '开始时间不能为负',
  EMPTY_RANGE: '结束时间必须晚于开始时间',
  OUT_OF_RANGE: '段落超出歌曲总时长',
  SELF_REPEAT: '段落不能重复指向自己',
  REPEAT_TARGET_MISSING: '重复指向的段落不存在',
  OVERLAP: '段落之间不能重叠',
};

const ACTION_ERROR: Record<string, string> = {
  NO_PREVIOUS_SECTION: '这已经是第一段，没有上一段可合并',
  NOT_CONTIGUOUS_SECTIONS: '两段之间有空隙，先补齐边界再合并',
  MIXED_TYPES_REQUIRES_CHOICE: '两段类型不同，请先选定合并后的类型',
  SPLIT_TOO_CLOSE_TO_EDGE: '拆分点太靠近段落边缘（至少留 0.5 秒）',
  LYRICS_NOT_IDENTICAL: '这两段歌词文字不一致，只能确认「换词」而不是「同词」',
  TYPE_MISMATCH: '只能与同类型的更早段落建立重复关系',
  TARGET_MUST_BE_EARLIER: '重复关系只能指向更早的段落',
  SECTION_NOT_FOUND: '段落不存在，请刷新后重试',
  INVALID_SPLIT_TIME: '拆分时间不可用',
  NOT_RAP: '只有标记为 Rap 的段落才能确认跳过',
};

interface Props {
  item: TalentItem;
  onClose: () => void;
  onSaved: (count: number) => void;
}

const chipRow = { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' } as const;
const fieldStyle = { minHeight: '44px', padding: '0 8px', fontSize: '19px', width: '100%' } as const;

function describe(issue: string): string {
  const code = issue.includes(':') ? issue.split(':').filter(Boolean).pop() || issue : issue;
  return ISSUE_TEXT[code] || '结构不合法';
}

function toSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

export default function VocalSectionEditor({ item, onClose, onSaved }: Props) {
  const lyrics = useMemo(() => item.lyrics ?? [], [item.lyrics]);
  const [sections, setSections] = useState<VocalSection[]>(() => relabelSections(sortSections(item.sections || [])));
  const [selectedId, setSelectedId] = useState<string | null>(() => sections[0]?.id ?? null);
  const [timeDraft, setTimeDraft] = useState<{ start: string; end: string } | null>(null);
  const [lineId, setLineId] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [syncNotice, setSyncNotice] = useState('');
  const [busy, setBusy] = useState(false);

  /**
   * 已落库的结构快照。既用于「外部恢复/应用草稿后同步」，也用于校验时识别
   * 原样保留的旧边界（见 validateSections 的 persisted）。
   */
  const persisted = useRef<VocalSection[]>(sections);
  const persistedSignature = useRef(sectionsSignature(sections));

  /**
   * 和服务端 maxDuration 同一口径：单音轨 durationMs 可能只是伴奏/旧音轨的时长，
   * 原唱轨（或另一条轨）更长时，边界按更长的轨算。否则旧尾段会被误判越界。
   */
  const durationMs = useMemo(() => talentDurationMs(item), [item]);

  /**
   * 恢复旧结构 / 应用草稿后，正式结构会在弹层打开期间变化。
   * - 本地没有未保存改动：直接换成最新的正式结构，避免弹层停留在旧数据；
   * - 本地已有改动：不覆盖用户正在改的内容，只提示最新结构已就位，保存会覆盖它。
   */
  useEffect(() => {
    const incoming = relabelSections(sortSections(item.sections || []));
    const incomingSignature = sectionsSignature(incoming);
    if (incomingSignature === persistedSignature.current) return;
    const editing = sectionsSignature(sections) !== persistedSignature.current;
    persistedSignature.current = incomingSignature;
    if (editing) {
      // 用户正在改的内容不动；旧快照继续作为「上次落库值」参与校验，
      // 这样它没被动过的旧尾段不会突然变成新的越界错误。
      const known = new Set(persisted.current.map((section) => section.id));
      persisted.current = [...persisted.current, ...incoming.filter((section) => !known.has(section.id))];
      setSyncNotice('正式结构已在别处更新；当前未保存的改动仍保留，保存后会覆盖它。');
      return;
    }
    persisted.current = incoming;
    setSections(incoming);
    setSelectedId((current) => (incoming.some((section) => section.id === current) ? current : incoming[0]?.id ?? null));
    setTimeDraft(null);
    setLineId('');
    setErrors([]);
    setSyncNotice('正式结构已在别处更新，已同步为最新结构。');
  }, [item.sections, sections]);

  const selected = useMemo(() => sections.find((section) => section.id === selectedId) ?? null, [sections, selectedId]);
  const selectedLines = useMemo(
    () => (selected ? lyrics.filter((line) => line.startMs > selected.startMs && line.startMs < selected.endMs) : []),
    [selected, lyrics],
  );
  const previous = useMemo(() => (selected ? previousSameType(sections, selected.id) : null), [sections, selected]);
  const sameLyrics = useMemo(
    () => Boolean(selected && previous && lyricsIdentical(selected, previous, lyrics)),
    [selected, previous, lyrics],
  );

  /** 每次操作后统一重编号 + 重新选中，避免 id 悬空。 */
  function apply(next: VocalSection[], keepId?: string) {
    setSections(next);
    setErrors([]);
    const target = keepId ?? selectedId;
    setSelectedId(next.some((section) => section.id === target) ? target : next[0]?.id ?? null);
    setTimeDraft(null);
    setLineId('');
  }

  function run(action: () => VocalSection[], keepId?: string) {
    try {
      apply(action(), keepId);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'UNKNOWN';
      setErrors([ACTION_ERROR[code] ?? `操作未完成：${code}`]);
    }
  }

  function editTime(patch: { start?: string; end?: string }) {
    if (!selected) return;
    const draft = { start: timeDraft?.start ?? toSeconds(selected.startMs), end: timeDraft?.end ?? toSeconds(selected.endMs), ...patch };
    setTimeDraft(draft);
    /**
     * 只换算用户真正改动的那一端；另一端保留原值。
     * 输入框按 0.1 秒显示，若把没改的一端也按显示值回写，
     * 219572ms 会被悄悄改成 219600ms，凭空造出一个越界边界。
     */
    const toMs = (text: string): number => Math.round(Number(text) * 1000);
    const startMs = patch.start !== undefined ? toMs(patch.start) : (timeDraft ? toMs(draft.start) : selected.startMs);
    const endMs = patch.end !== undefined ? toMs(patch.end) : (timeDraft ? toMs(draft.end) : selected.endMs);
    // 先原样落到草稿（包括非法区间），保存时统一校验并列出原因；不能悄悄改回旧值让用户以为生效了。
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < 0) return;
    setSections((current) => relabelSections(current.map((section) => (
      section.id === selected.id
        ? { ...section, startMs, endMs, source: 'manual' as const, ...(section.type === 'rap' ? { rapApproved: false } : {}) }
        : section
    ))));
  }

  function addSection() {
    const last = sections[sections.length - 1];
    const startMs = last ? last.endMs : 0;
    const endMs = Math.max(startMs + 1000, Math.min(durationMs || startMs + 10000, startMs + 10000));
    const id = `manual-${Date.now().toString(36)}`;
    apply(relabelSections([...sections, { id, type: 'verse', label: 'A', startMs, endMs, source: 'manual' }]), id);
  }

  function removeSection() {
    if (!selected) return;
    apply(relabelSections(sections.filter((section) => section.id !== selected.id)));
  }

  async function save() {
    setBusy(true); setErrors([]);
    const ordered = relabelSections(sortSections(sections));
    const issues = validateSections(ordered, durationMs || undefined, { persisted: persisted.current });
    if (issues.length) {
      setErrors([...new Set(issues.map(describe))]);
      setBusy(false);
      return;
    }
    try {
      await editLocally({ kind: 'VOCAL', id: item.id }, { sections: ordered }, 'update');
      onSaved(ordered.length);
    } catch (cause) {
      const detail = cause instanceof Error && cause.message ? cause.message : '保存失败';
      setErrors([`结构未保存：${detail}。请联网或先精简段落数量。`]);
    } finally { setBusy(false); }
  }

  const loopOf = (section: VocalSection) => `${toSeconds(section.startMs)}–${toSeconds(section.endMs)}s`;

  return (
    <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="vocal-sheet vocal-sheet--wide" role="dialog" aria-modal="true" aria-label="校准歌曲结构">
        <div className="vocal-sheet__head">
          <h2>校准歌曲结构</h2>
          <button type="button" aria-label="关闭结构校准" disabled={busy} onClick={onClose}>✕</button>
        </div>
        <p className="vocal-hint">点一段看细节；拆分用歌词句或当前播放位置，不用先算秒数。保存后整张图标记为人工校准。</p>
        {syncNotice && <p className="vocal-hint" role="status">{syncNotice}</p>}

        {sections.length ? (
          <div className="vocal-map" role="group" aria-label="待校准的歌曲段落">
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                className={[
                  'vocal-map__chip',
                  `vocal-map__chip--${section.type}`,
                  section.id === selectedId ? 'is-focused' : '',
                ].filter(Boolean).join(' ')}
                aria-pressed={section.id === selectedId}
                aria-label={`选择 ${section.label}，${TYPE_TEXT[section.type]}，${loopOf(section)}`}
                onClick={() => { setSelectedId(section.id); setTimeDraft(null); setLineId(''); }}
              >
                <span className="vocal-map__code">{section.label}</span>
                <span className="vocal-map__type">{TYPE_TEXT[section.type]}</span>
                <span className="vocal-map__time">{loopOf(section)}</span>
                {section.type === 'rap' && (
                  <span className="vocal-map__flag">{isRapConfirmed(section) ? 'Rap 已确认' : 'Rap 待确认'}</span>
                )}
                {section.repeatOf && <span className="vocal-map__flag">{section.repetition === 'exact-lyrics' ? '同词' : '换词'}</span>}
              </button>
            ))}
          </div>
        ) : (
          <p className="vocal-empty">还没有段落。可直接「新增一段」手写标注，或在曲目页先跑原唱分析。</p>
        )}

        {selected && (
          <div className="vocal-block" style={{ marginTop: '14px' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: '19px' }}>{selected.label} · {TYPE_TEXT[selected.type]}</h3>
            <p className="vocal-hint" style={{ marginTop: 0 }}>{loopOf(selected)}，共 {selectedLines.length} 句歌词</p>

            <fieldset className="vocal-field">
              <legend>类型</legend>
              <div className="vocal-chips">
                {TYPE_ORDER.map((type: VocalSectionType) => (
                  <button
                    key={type}
                    type="button"
                    aria-pressed={selected.type === type}
                    disabled={busy}
                    onClick={() => run(() => setSectionType(sections, selected.id, type), selected.id)}
                  >
                    {TYPE_TEXT[type]}
                  </button>
                ))}
              </div>
            </fieldset>

            {selected.type === 'rap' && (
              <fieldset className="vocal-field">
                <legend>Rap 跳过确认</legend>
                <p className="vocal-hint" style={{ marginTop: 0 }} role="status">
                  {isRapConfirmed(selected)
                    ? '已确认这一段是 Rap：练唱时可自动跳过。'
                    : '未确认：不会自动跳过。保存结构本身不等于确认 Rap。'}
                </p>
                <div className="vocal-chips">
                  <button
                    type="button"
                    aria-pressed={isRapConfirmed(selected)}
                    disabled={busy || isRapConfirmed(selected)}
                    onClick={() => run(() => approveRapSection(sections, selected.id), selected.id)}
                  >
                    确认这段是 Rap（可跳过）
                  </button>
                  <button
                    type="button"
                    disabled={busy || !isRapConfirmed(selected)}
                    onClick={() => run(() => revokeRapSection(sections, selected.id), selected.id)}
                  >
                    取消确认
                  </button>
                </div>
                <p className="vocal-hint" style={{ margin: '6px 0 0' }}>改动起止时间、拆分或合并后需要重新确认。</p>
              </fieldset>
            )}

            <fieldset className="vocal-field">
              <legend>拆分</legend>
              {selectedLines.length ? (
                <div style={{ display: 'grid', gap: '6px' }}>
                  <select
                    aria-label="选择拆分用的歌词句"
                    style={fieldStyle}
                    value={lineId}
                    onChange={(event) => setLineId(event.target.value)}
                  >
                    <option value="">选一句歌词作拆分点…</option>
                    {selectedLines.map((line, index) => (
                      <option key={line.id} value={line.id}>{index + 1}. {line.text.slice(0, 20)}（{toSeconds(line.startMs)}s）</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={busy || !lineId}
                    onClick={() => {
                      const line = selectedLines.find((item) => item.id === lineId);
                      if (line) run(() => splitSectionAt(sections, selected.id, line.startMs));
                    }}
                  >
                    在这一句拆成两段
                  </button>
                </div>
              ) : (
                <p className="vocal-hint" style={{ margin: 0 }}>这段没有歌词句可作锚点；需要更细的边界时用下面的秒数精调。</p>
              )}
              <div style={chipRow}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => splitSectionAt(sections, selected.id, (selected.startMs + selected.endMs) / 2))}
                >
                  从中间对半拆
                </button>
                <button
                  type="button"
                  disabled={busy || !previous}
                  onClick={() => run(() => mergeWithPrevious(sections, selected.id, selected.type))}
                >
                  与上一段合并
                </button>
              </div>
            </fieldset>

            {previous && (
              <fieldset className="vocal-field">
                <legend>与上一段 {previous.label} 的关系</legend>
                <div className="vocal-chips">
                  <button
                    type="button"
                    disabled={busy || !sameLyrics}
                    aria-pressed={selected.repeatOf === previous.id && selected.repetition === 'exact-lyrics'}
                    onClick={() => run(() => confirmRepeat(sections, selected.id, previous.id, 'exact-lyrics', lyrics), selected.id)}
                  >
                    同词重复
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-pressed={selected.repeatOf === previous.id && selected.repetition === 'same-melody-new-lyrics'}
                    onClick={() => run(() => confirmRepeat(sections, selected.id, previous.id, 'same-melody-new-lyrics', lyrics), selected.id)}
                  >
                    旋律同、换词
                  </button>
                  <button
                    type="button"
                    disabled={busy || !selected.repeatOf}
                    onClick={() => run(() => clearRepeat(sections, selected.id), selected.id)}
                  >
                    不重复
                  </button>
                </div>
                {!sameLyrics && <p className="vocal-hint" style={{ margin: '6px 0 0' }}>两段歌词文字不同，只能确认「换词」；确认「同词」需要歌词完全一致。</p>}
              </fieldset>
            )}

            <fieldset className="vocal-field">
              <legend>秒数精调（可选）</legend>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                <label style={{ fontSize: '15px', color: 'var(--muted)' }}>开始（秒）
                  <input
                    aria-label="本段开始秒数"
                    style={fieldStyle}
                    type="number"
                    min="0"
                    step="0.1"
                    value={timeDraft?.start ?? toSeconds(selected.startMs)}
                    onChange={(event) => editTime({ start: event.target.value })}
                  />
                </label>
                <label style={{ fontSize: '15px', color: 'var(--muted)' }}>结束（秒）
                  <input
                    aria-label="本段结束秒数"
                    style={fieldStyle}
                    type="number"
                    min="0"
                    step="0.1"
                    value={timeDraft?.end ?? toSeconds(selected.endMs)}
                    onChange={(event) => editTime({ end: event.target.value })}
                  />
                </label>
              </div>
            </fieldset>

            <div style={chipRow}>
              <button type="button" disabled={busy} onClick={removeSection}>删除这一段</button>
            </div>
          </div>
        )}

        {!sections.length && <p className="vocal-hint">没有段落时也可以直接保存为空（保持「待分析」），不会伪造结构。</p>}

        <div className="vocal-chips">
          <button type="button" disabled={busy} onClick={addSection}>新增一段</button>
          <button type="button" disabled={busy} onClick={() => void save()}>{busy ? '正在保存…' : '保存结构'}</button>
        </div>
        {errors.length > 0 && (
          <ul className="vocal-hint" role="alert" style={{ paddingLeft: '18px' }}>
            {errors.map((message) => <li key={message}>{message}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
