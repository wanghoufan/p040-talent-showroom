import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { editLocally } from '../lib/offline-editing';
import {
  applyPaperDraft, diffPaperDraft, paperCheckCode, parsePaperDraft,
  type PaperApplyResult, type PaperDiff, type PaperDraft,
} from '../lib/vocal/paper-revision';
import { readSnapshots, pushSnapshot, restoreSnapshot, sectionRevision } from '../lib/vocal/structure-revision';
import type { TalentItem, VocalSection } from '../lib/types';
import '../styles/vocal-paper.css';

/**
 * 纸质修订回传（P040 §7）。
 *
 * 主路径是「导入修订 JSON」：纸上改动先变成结构化建议，逐项看完再确认。
 * 拍照识别没有已授权的视觉模型，按钮保留但只说明 BLOCKED——不伪造识别结果，
 * 也不把用户照片传到任何地方。
 */

interface Props {
  item: TalentItem;
  sections: readonly VocalSection[];
  onClose: () => void;
  onApplied: (sections: VocalSection[]) => void;
}

const BLOCKED_TEXT = '拍照/扫描识别暂不可用：当前环境没有已授权的视觉模型，图片不会上传，也不会生成任何识别结果。'
  + '请把纸上修改整理成修订 JSON 后导入，或直接手动编辑结构。';

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export default function VocalPaperRevisionSheet({ item, sections, onClose, onApplied }: Props) {
  const currentSections = item.sections ?? sections;
  const revision = useMemo(() => sectionRevision(currentSections), [currentSections]);
  const code = useMemo(() => paperCheckCode(item.id, revision), [item.id, revision]);

  const fileRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<PaperDraft | null>(null);
  const [diff, setDiff] = useState<PaperDiff | null>(null);
  const [applied, setApplied] = useState<PaperApplyResult | null>(null);
  const [snapshots, setSnapshots] = useState(() => readSnapshots(item.id));
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('vocal-paper-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('vocal-paper-open');
    };
  }, [busy, onClose]);

  const reset = (): void => {
    setDraft(null);
    setDiff(null);
    setApplied(null);
    setError(null);
    setBlocked(null);
    setNotice(null);
  };

  const importFile = async (file: File): Promise<void> => {
    reset();
    let text: string;
    try {
      text = await file.text();
    } catch (cause) {
      setError(`读取文件失败：${cause instanceof Error ? cause.message : '未知错误'}。`);
      return;
    }
    const parsed = parsePaperDraft(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const next = diffPaperDraft(item, parsed.draft);
    setDraft(parsed.draft);
    setDiff(next);
    if (next.conflicts.length) setError('修订与当前结构对不上，已拒绝应用。请先核对下面的原因。');
    else if (!next.rows.length) setNotice('这份修订里没有需要应用的改动。');
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void importFile(file);
  };

  const apply = async (): Promise<void> => {
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // 弹层打开期间结构可能被别处改过：应用前再核一次，避免覆盖新版本。
      const fresh = diffPaperDraft(item, draft);
      setDiff(fresh);
      if (fresh.conflicts.length) {
        setError('结构在确认前发生了变化，已停止应用。请重新核对后再试。');
        return;
      }
      const result = applyPaperDraft(item, draft);
      const base = item.sections ?? sections;
      setSnapshots(pushSnapshot(item.id, {
        revision: sectionRevision(base),
        sections: base,
        at: new Date().toISOString(),
        source: 'paper',
      }));
      await editLocally({ kind: 'VOCAL', id: item.id }, { sections: result.sections }, 'update');
      setApplied(result);
      setDraft(null);
      setDiff(null);
      setNotice(`已应用 ${draft.edits.length} 处改动并写入本曲结构。`);
      onApplied(result.sections);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '未知错误';
      setError(message.startsWith('歌曲不符') || message.startsWith('结构已变化')
        ? message
        : `保存失败：${message}。结构没有写入，可以稍后重试。`);
    } finally {
      setBusy(false);
    }
  };

  const undo = async (): Promise<void> => {
    const latest = snapshots[0];
    if (!latest || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const restored = restoreSnapshot(item.id, latest.revision);
      if (!restored) {
        setError('找不到这份快照，可能已被清理。');
        return;
      }
      await editLocally({ kind: 'VOCAL', id: item.id }, { sections: restored.sections }, 'update');
      setSnapshots(readSnapshots(item.id).filter((snapshot) => snapshot.revision !== latest.revision));
      setApplied(null);
      setNotice(`已撤回，恢复到 ${when(latest.at)} 的结构（修订 ${latest.revision}）。`);
      onApplied(restored.sections);
    } catch (cause) {
      setError(`撤回失败：${cause instanceof Error ? cause.message : '未知错误'}。结构没有改动。`);
    } finally {
      setBusy(false);
    }
  };

  const conflicts = diff?.conflicts ?? [];
  const rows = diff?.rows ?? [];
  const canApply = Boolean(draft) && rows.length > 0 && conflicts.length === 0 && !busy;

  return createPortal(
    <div
      className="vocal-paper-backdrop"
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <div className="vocal-paper-sheet" role="dialog" aria-modal="true" aria-label="纸质修订回传">
        <div className="vocal-paper-head">
          <div>
            <h2 className="vocal-paper-title">纸质修订回传</h2>
            <p className="vocal-paper-sub">
              <span>《{item.title || '未命名'}》</span>
              <span>ID {item.id}</span>
            </p>
          </div>
          <button type="button" className="vocal-paper-close" aria-label="关闭纸质修订" onClick={onClose} disabled={busy}>✕</button>
        </div>

        <div className="vocal-paper-idcard">
          <div>
            <span className="vocal-paper-idcard__label">结构修订号</span>
            <strong className="vocal-paper-idcard__value">{revision}</strong>
          </div>
          <div>
            <span className="vocal-paper-idcard__label">短校验码</span>
            <strong className="vocal-paper-idcard__value">{code}</strong>
          </div>
          <p className="vocal-paper-idcard__hint">
            请与纸上印的修订号和校验码逐位对照。对不上说明打印后结构已改，导入会被拒绝。
          </p>
        </div>

        <div className="vocal-paper-import">
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="vocal-paper-file"
            aria-label="导入修订 JSON"
            onChange={onFileChange}
            disabled={busy}
          />
          <button type="button" className="vocal-paper-primary" onClick={() => fileRef.current?.click()} disabled={busy}>
            导入修订 JSON
          </button>
          <button
            type="button"
            className="vocal-paper-secondary"
            onClick={() => { setBlocked(BLOCKED_TEXT); setError(null); }}
            disabled={busy}
          >
            拍照/扫描导入
          </button>
        </div>

        {blocked && (
          <p className="vocal-paper-blocked" role="status">
            <strong>BLOCKED：</strong>{blocked}
          </p>
        )}
        {error && <p className="vocal-paper-error" role="alert">{error}</p>}
        {notice && <p className="vocal-paper-notice" role="status">{notice}</p>}

        {conflicts.length > 0 && (
          <div className="vocal-paper-conflicts" role="alert">
            <h3>不能覆盖当前结构</h3>
            <ul>
              {conflicts.map((conflict) => <li key={conflict.code}>{conflict.message}</li>)}
            </ul>
          </div>
        )}

        {diff && diff.warnings.length > 0 && (
          <ul className="vocal-paper-warnings">
            {diff.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        )}

        {rows.length > 0 && (
          <div className="vocal-paper-diff">
            <h3 className="vocal-paper-diff__title">差异预览（{rows.length} 项，确认前不会写入）</h3>
            <ol className="vocal-paper-diff__list">
              {rows.map((row, index) => (
                <li className="vocal-paper-row" key={`${row.label}-${index}`}>
                  <div className="vocal-paper-row__head">
                    <strong>{row.label}</strong>
                    <span className={`vocal-paper-conf${row.confidence < 0.7 ? ' is-low' : ''}`}>置信度 {percent(row.confidence)}</span>
                  </div>
                  <p className="vocal-paper-row__change">
                    <span className="vocal-paper-before">{row.before}</span>
                    <span aria-hidden="true"> → </span>
                    <span className="vocal-paper-after">{row.after}</span>
                  </p>
                  <p className="vocal-paper-row__note">{row.note}</p>
                </li>
              ))}
            </ol>
          </div>
        )}

        {applied && (
          <div className="vocal-paper-result">
            <h3>已应用</h3>
            {applied.pending.length > 0 && (
              <ul>
                {applied.pending.map((entry) => <li key={entry}>待确认：{entry}</li>)}
              </ul>
            )}
            {applied.skipped.length > 0 && (
              <ul>
                {applied.skipped.map((entry) => <li key={entry}>未应用：{entry}</li>)}
              </ul>
            )}
            {!applied.pending.length && !applied.skipped.length && <p>所有改动都已写入本曲人工结构。</p>}
          </div>
        )}

        <div className="vocal-paper-actions">
          <button type="button" className="vocal-paper-primary" onClick={() => { void apply(); }} disabled={!canApply}>
            {busy ? '正在保存…' : '确认应用'}
          </button>
          <button
            type="button"
            className="vocal-paper-secondary"
            onClick={() => { void undo(); }}
            disabled={!snapshots.length || busy}
          >
            {snapshots[0] ? `撤回上次应用（${when(snapshots[0].at)}）` : '撤回上次应用'}
          </button>
          <button type="button" onClick={onClose} disabled={busy}>关闭</button>
        </div>
        <p className="vocal-paper-foot">
          应用前会自动保存当前结构快照（每首歌最多保留 10 份），确认后仍可撤回；人工结构不会被机器推断覆盖。
        </p>
      </div>
    </div>,
    document.body,
  );
}
