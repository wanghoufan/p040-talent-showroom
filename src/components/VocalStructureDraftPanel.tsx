import { useState } from 'react';
import { ApiError } from '../lib/api';
import { TYPE_TEXT, sortByTime } from '../lib/vocal/structure';
import {
  applyStructureDraft, discardStructureDraft, generateStructureDraft, restoreLegacyStructure,
  type StructureDraft,
} from '../lib/vocal/structure-api';
import type { TalentItem } from '../lib/types';
import '../styles/vocal-practice.css';

/**
 * 原唱音频结构草稿面板（V3.2 T4/T5）。
 *
 * 只在用户点击时调用本机分析；结果先显示为草稿，必须显式「应用」才写回正式结构。
 * 旧结构在生成草稿时已快照，可一键恢复；不碰音轨、歌词与伴奏。
 */

interface Props {
  item: TalentItem;
  hasOriginalTrack: boolean;
  onUpdated?: (item: TalentItem) => void;
}

const formatSec = (ms: number): string => `${(ms / 1000).toFixed(0)}s`;

export default function VocalStructureDraftPanel({ item, hasOriginalTrack, onUpdated }: Props) {
  const [draft, setDraft] = useState<StructureDraft | null>(null);
  const [busy, setBusy] = useState<'idle' | 'analyzing' | 'applying' | 'restoring'>('idle');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);

  const analyze = async (force: boolean) => {
    setBusy('analyzing'); setError(''); setNotice('');
    try {
      const result = await generateStructureDraft(item.id, force);
      setDraft(result.draft);
      setNotice(result.reused
        ? '这份草稿已经存在（同一份原曲、同一模型版本），直接显示，不重复分析。'
        : `分析完成：${result.draft.summary.sections} 段，用时 ${result.draft.timing?.seconds ?? '?'} 秒。`);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '分析没有完成，请检查本机服务与配对环境。');
    } finally { setBusy('idle'); }
  };

  const apply = async (replaceManual: boolean) => {
    if (!draft) return;
    setBusy('applying'); setError(''); setNotice('');
    try {
      const result = await applyStructureDraft(item.id, draft.map, replaceManual, true);
      setDraft(result.draft);
      setConfirmOverwrite(false);
      setNotice(`已应用 ${result.applied} 段结构。Rap 需在「校准歌曲结构」里逐段确认后才会跳过。可随时恢复之前的结构。`);
      onUpdated?.(result.item);
    } catch (cause) {
      if (cause instanceof ApiError && /手工/.test(cause.message)) { setConfirmOverwrite(true); return; }
      setError(cause instanceof ApiError ? cause.message : '应用未完成，正式结构没有改变。');
    } finally { setBusy('idle'); }
  };

  const restore = async () => {
    setBusy('restoring'); setError(''); setNotice('');
    try {
      const result = await restoreLegacyStructure(item.id);
      setNotice(`已恢复生成草稿前的 ${result.restored} 段结构。`);
      onUpdated?.(result.item);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '恢复未完成，正式结构没有改变。');
    } finally { setBusy('idle'); }
  };

  const discard = async () => {
    setBusy('applying'); setError('');
    try {
      await discardStructureDraft(item.id);
      setDraft(null);
      setNotice('草稿已丢弃，正式结构没有改变。');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '丢弃未完成。');
    } finally { setBusy('idle'); }
  };

  const sections = draft ? sortByTime(draft.map.sections.map((section) => ({
    ...section, label: section.code, source: 'algorithm' as const, rapApproved: section.approvedRap === true,
  }))) : [];

  return (
    <div className="vocal-structure-draft">
      <div className="vocal-chips">
        <button type="button" disabled={busy !== 'idle' || !hasOriginalTrack} onClick={() => void analyze(false)}>
          {busy === 'analyzing' ? '正在分析原唱…' : draft ? '重新读取草稿' : '分析原唱结构'}
        </button>
        {draft && (
          <button type="button" disabled={busy !== 'idle'} onClick={() => void analyze(true)}>重新分析</button>
        )}
      </div>
      {!hasOriginalTrack && <p className="vocal-hint">还没有原唱音轨：结构只能来自原唱音频，先导入原唱再分析。</p>}

      {draft && (
        <>
          <p className="vocal-hint" role="status">
            草稿：{draft.summary.sections} 段 · 待标注 {draft.summary.pendingTypes} 段
            {draft.summary.typeCandidates ? `（其中 ${draft.summary.typeCandidates} 段有候选类型）` : ''}
            {' · '}相似候选 {draft.summary.pendingRelations} 条
            {' · '}模型 {draft.modelName} v{draft.modelVersion}
            {draft.timing ? ` · ${draft.timing.seconds}s` : ''}
            {draft.separation ? ' · 未做音源分离' : ''}
          </p>
          <div className="vocal-map" role="list" aria-label="分析草稿段落">
            {sections.map((section) => (
              <div key={section.id} role="listitem" className={`vocal-map__chip vocal-map__chip--${section.type}`}>
                <span className="vocal-map__code">{section.label}</span>
                <span className="vocal-map__type">{TYPE_TEXT[section.type]}</span>
                <span className="vocal-map__time">{formatSec(section.startMs)}–{formatSec(section.endMs)}</span>
                {section.type === 'rap' && (
                  <span className="vocal-map__flag">{section.rapApproved ? 'Rap 已确认' : 'Rap 待确认'}</span>
                )}
              </div>
            ))}
          </div>
          <p className="vocal-hint">参考边界可直接应用，未定类型保留待标注，之后可手动调整。Rap 要确认后才会在练唱中跳过。</p>
          {draft.reference && (
            <div role="status" className="vocal-ref">
              <p className="vocal-ref__headline">参考草稿：{draft.reference.candidateCount} 段候选
                {draft.reference.disputedCount ? ` · ${draft.reference.disputedCount} 段类型有争议（保持待标注）` : ''}</p>
              <p className="vocal-hint" style={{ marginTop: 4 }}>
                来源 {draft.reference.source || '未标注'}；身份核验{draft.reference.identity.ok ? '通过' : '未通过'}。
                有争议的类型保持待标注，可在练习时调整。
              </p>
            </div>
          )}
          <div className="vocal-chips">
            <button
              type="button"
              disabled={busy !== 'idle'}
              onClick={() => void apply(false)}
            >
              应用为新结构
            </button>
            <button type="button" disabled={busy !== 'idle'} onClick={() => void discard()}>放弃草稿</button>
            {draft.legacySectionCount > 0 && (
              <button type="button" disabled={busy !== 'idle'} onClick={() => void restore()}>恢复旧结构（{draft.legacySectionCount} 段）</button>
            )}
          </div>
        </>
      )}

      {confirmOverwrite && (
        <div role="alertdialog" aria-label="确认覆盖手工结构">
          <p className="vocal-hint" role="alert">这首曲目已有手工校准的结构。应用草稿会覆盖它，旧结构仍可从草稿恢复。</p>
          <div className="vocal-chips">
            <button type="button" disabled={busy !== 'idle'} onClick={() => void apply(true)}>确认覆盖</button>
            <button type="button" disabled={busy !== 'idle'} onClick={() => setConfirmOverwrite(false)}>取消</button>
          </div>
        </div>
      )}

      {notice && <p className="vocal-hint" role="status">{notice}</p>}
      {error && <p className="vocal-hint" role="alert">{error}</p>}
    </div>
  );
}
