import { useMemo, useState } from 'react';
import { editLocally } from '../lib/offline-editing';
import { sortSections, validateSections } from '../lib/vocal';
import type { TalentItem, VocalSection, VocalSectionType } from '../lib/types';
import '../styles/vocal-practice.css';

/**
 * 结构人工校准：结构数据不可靠时由用户确认段落边界，保存时统一标记 source='manual'，
 * 之后算法结果不得覆盖人工标注（后端返回 MANUAL_OVERRIDE）。
 * 只保存能通过校验的结构；校验不过就明确列出问题，不静默丢弃用户的改动。
 */

const TYPES: { value: VocalSectionType; label: string }[] = [
  { value: 'intro', label: '前奏' }, { value: 'verse', label: '主歌' }, { value: 'pre', label: '预副歌' },
  { value: 'chorus', label: '副歌' }, { value: 'bridge', label: '桥段' }, { value: 'rap', label: 'Rap' },
  { value: 'outro', label: '尾奏' }, { value: 'unknown', label: '未标注' },
];

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

interface Draft { id: string; label: string; type: VocalSectionType; startS: string; endS: string }

interface Props {
  item: TalentItem;
  onClose: () => void;
  onSaved: (count: number) => void;
}

const boxStyle = { display: 'grid', gap: '6px', padding: '10px 0', borderBottom: '1px solid var(--line)' } as const;
const fieldStyle = { minHeight: '44px', padding: '0 8px', fontSize: '19px', width: '100%' } as const;
const headStyle = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' } as const;

function toDraft(section: VocalSection): Draft {
  return {
    id: section.id || crypto.randomUUID(),
    label: section.label || '',
    type: section.type,
    startS: (section.startMs / 1000).toFixed(1),
    endS: (section.endMs / 1000).toFixed(1),
  };
}

function draftSection(draft: Draft, index: number): VocalSection {
  return {
    id: draft.id || `manual-${index + 1}`,
    type: draft.type,
    label: draft.label.trim() || `段落 ${index + 1}`,
    startMs: Math.max(0, Math.round(Number(draft.startS) * 1000)),
    endMs: Math.max(0, Math.round(Number(draft.endS) * 1000)),
    source: 'manual',
  };
}

/** 校验返回 `id:CODE`；只把人类可读的原因展示给用户，内部 id 不暴露。 */
function describe(issue: string): string {
  const code = issue.includes(':') ? issue.split(':').filter(Boolean).pop() || issue : issue;
  return ISSUE_TEXT[code] || '结构不合法';
}

export default function VocalSectionEditor({ item, onClose, onSaved }: Props) {
  const [drafts, setDrafts] = useState<Draft[]>(() => sortSections(item.sections || []).map(toDraft));
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const durationMs = item.durationMs || 0;

  const preview = useMemo(() => drafts.map(draftSection), [drafts]);

  const update = (index: number, patch: Partial<Draft>) => {
    setDrafts((current) => current.map((draft, at) => (at === index ? { ...draft, ...patch } : draft)));
  };
  const add = () => {
    const last = drafts[drafts.length - 1];
    const startS = last ? Number(last.endS) || 0 : 0;
    setDrafts((current) => [...current, {
      id: crypto.randomUUID(), label: `段落 ${current.length + 1}`, type: 'verse',
      startS: startS.toFixed(1), endS: (startS + 10).toFixed(1),
    }]);
  };

  async function save() {
    setBusy(true); setErrors([]);
    const sections = sortSections(preview);
    const issues = validateSections(sections, durationMs || undefined);
    if (issues.length) {
      setErrors([...new Set(issues.map(describe))]);
      setBusy(false);
      return;
    }
    try {
      await editLocally({ kind: 'VOCAL', id: item.id }, { sections }, 'update');
      onSaved(sections.length);
    } catch (cause) {
      const detail = cause instanceof Error && cause.message ? cause.message : '保存失败';
      setErrors([`结构未保存：${detail}。请联网或先精简段落数量。`]);
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="vocal-sheet" role="dialog" aria-modal="true" aria-label="校准歌曲结构">
        <div className="vocal-sheet__head">
          <h2>校准歌曲结构</h2>
          <button type="button" aria-label="关闭结构校准" disabled={busy} onClick={onClose}>✕</button>
        </div>
        <p className="vocal-hint">按秒填写每段的开始与结束，保存后标记为人工校准；没有把握就别填，未标注不会伪造段落。</p>
        {drafts.map((draft, index) => (
          <div key={draft.id} style={boxStyle}>
            <div style={headStyle}>
              <label style={{ fontSize: '15px', color: 'var(--muted)' }}>段落名称
                <input aria-label={`第 ${index + 1} 段名称`} style={fieldStyle} value={draft.label} maxLength={40} onChange={(event) => update(index, { label: event.target.value })} />
              </label>
              <label style={{ fontSize: '15px', color: 'var(--muted)' }}>类型
                <select aria-label={`第 ${index + 1} 段类型`} style={fieldStyle} value={draft.type} onChange={(event) => update(index, { type: event.target.value as VocalSectionType })}>
                  {TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                </select>
              </label>
            </div>
            <div style={headStyle}>
              <label style={{ fontSize: '15px', color: 'var(--muted)' }}>开始（秒）
                <input aria-label={`第 ${index + 1} 段开始秒数`} style={fieldStyle} type="number" min="0" step="0.1" value={draft.startS} onChange={(event) => update(index, { startS: event.target.value })} />
              </label>
              <label style={{ fontSize: '15px', color: 'var(--muted)' }}>结束（秒）
                <input aria-label={`第 ${index + 1} 段结束秒数`} style={fieldStyle} type="number" min="0" step="0.1" value={draft.endS} onChange={(event) => update(index, { endS: event.target.value })} />
              </label>
            </div>
            <button type="button" disabled={busy} onClick={() => setDrafts((current) => current.filter((_, at) => at !== index))} aria-label={`删除第 ${index + 1} 段`}>删除这一段</button>
          </div>
        ))}
        {!drafts.length && <p className="vocal-empty">还没有段落。点下面「新增一段」按时间手写标注。</p>}
        <div className="vocal-chips">
          <button type="button" disabled={busy} onClick={add}>新增一段</button>
          <button type="button" disabled={busy || !drafts.length} onClick={() => void save()}>{busy ? '正在保存…' : '保存结构'}</button>
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
