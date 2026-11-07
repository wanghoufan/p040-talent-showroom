import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { A4_SHEET_METRICS, buildA4Sheet, type A4SheetPage } from '../lib/vocal/a4-sheet';
import { exportSheetPdf } from '../lib/vocal/pdf-export';
import { sectionRevision } from '../lib/vocal/structure-revision';
import { paperCheckCode } from '../lib/vocal/paper-revision';
import type { TalentItem, VocalSection } from '../lib/types';
import {
  isNativePdfSaveSupported,
  openSavedPdf,
  savePdfToDownloads,
  shareSavedPdf,
  type SavedPdf,
} from '../native/pdf-save';
import '../styles/vocal-print.css';

/**
 * A4 学习稿弹层（P040 §6）。
 *
 * `presentation` 自管：不依赖路由，由调用方决定何时开。
 * 预览和 PDF 共用 `buildA4Sheet` 的同一份坐标数据，屏幕上看到的就是纸上印的。
 * 导出是只读快照：这里没有任何写回歌词/结构的调用。
 */

interface Props {
  item: TalentItem;
  sections: readonly VocalSection[];
  onClose: () => void;
}

const PAGE_W = A4_SHEET_METRICS.pageWidthPt;
const PAGE_H = A4_SHEET_METRICS.pageHeightPt;
const SCALE = A4_SHEET_METRICS.previewScale;

function safeFileName(title: string): string {
  const value = String(title ?? '').trim() || '未命名';
  return `${value.replace(/[\\/:*?"<>|]/g, '_')}-学习稿.pdf`;
}

function PagePreview({ page }: { page: A4SheetPage }) {
  return (
    <div
      className="vocal-print-page"
      style={{ width: `${PAGE_W * SCALE}pt`, height: `${PAGE_H * SCALE}pt` }}
    >
      <div
        className="vocal-print-page__inner"
        style={{ width: `${PAGE_W}pt`, height: `${PAGE_H}pt`, transform: `scale(${SCALE})` }}
      >
        {page.rules.map((rule, i) => (
          <span
            key={`rule-${i}`}
            aria-hidden="true"
            className={`vocal-print-rule${rule.dashed ? ' vocal-print-rule--dashed' : ''}`}
            style={rule.y1 === rule.y2
              ? { left: `${rule.x1}pt`, top: `${rule.y1}pt`, width: `${rule.x2 - rule.x1}pt` }
              : { left: `${rule.x1}pt`, top: `${rule.y1}pt`, height: `${rule.y2 - rule.y1}pt` }}
          />
        ))}
        {page.runs.map((run, i) => (
          <span
            key={`run-${i}`}
            className={`vocal-print-run vocal-print-run--${run.kind}${run.muted ? ' is-muted' : ''}`}
            style={{
              top: `${run.y}pt`,
              ...(run.align === 'right' ? { right: `${PAGE_W - run.x}pt` } : { left: `${run.x}pt` }),
              fontSize: `${run.size}pt`,
              fontWeight: run.weight,
            }}
          >
            {run.text}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function VocalPrintSheet({ item, sections, onClose }: Props) {
  /* 纸面必须印上修订号与短校验码，人工改完回传时才对得上版本（§7）。 */
  const revision = useMemo(() => sectionRevision(sections), [sections]);
  const sheet = useMemo(
    () => buildA4Sheet(item, sections, { revision }),
    [item, sections, revision],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedPdf | null>(null);
  const nativeSave = isNativePdfSaveSupported();

  const empty = sheet.meta.lineCount === 0;
  const noSections = sheet.meta.noSections;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('vocal-print-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('vocal-print-open');
    };
  }, [onClose]);

  const download = async (): Promise<void> => {
    if (busy || empty) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setSaved(null);
    const fileName = safeFileName(sheet.meta.title);
    try {
      const bytes = await exportSheetPdf(sheet.pages);
      if (nativeSave) {
        const result = await savePdfToDownloads(bytes, fileName);
        setSaved(result);
        const sizeText = result.size > 0 ? `（${Math.max(1, Math.round(result.size / 1024))} KB）` : '';
        setNotice(`已保存到 ${result.path}${sizeText}，可在系统文件管理器中找到。`);
        return;
      }
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      const blob = new Blob([buffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setNotice(`已发起下载：${fileName}（保存位置由浏览器决定）`);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      if (code === 'CANVAS_UNAVAILABLE') setError('当前环境不支持 Canvas，无法生成 PDF。可以改用「打印」保存为 PDF。');
      else if (code === 'JPEG_ENCODE_FAILED') setError('页面转成图片失败，未能生成 PDF。请改用「打印」保存为 PDF。');
      else if (nativeSave) setError(`保存失败：${code || '未知错误'}。文件未保存，请确认存储空间或权限后重试。`);
      else setError(`生成 PDF 失败：${code || '未知错误'}。请改用「打印」或稍后重试。`);
    } finally {
      setBusy(false);
    }
  };

  const share = async (): Promise<void> => {
    if (!saved) return;
    setError(null);
    try {
      await shareSavedPdf(saved, `分享 ${saved.name || 'A4 学习稿'}`);
    } catch (cause) {
      setError(`调起分享失败：${cause instanceof Error ? cause.message : '未知错误'}`);
    }
  };

  const open = async (): Promise<void> => {
    if (!saved) return;
    setError(null);
    try {
      await openSavedPdf(saved);
    } catch {
      setError('手机里没有可打开 PDF 的应用，请改用「分享」发送到电脑或其他设备查看。');
    }
  };

  const print = (): void => {
    if (empty) return;
    setError(null);
    try {
      window.print();
    } catch (cause) {
      setError(`调起打印失败：${cause instanceof Error ? cause.message : '未知错误'}。请改用「下载 PDF」。`);
    }
  };

  return createPortal(
    <div
      className="vocal-print-backdrop"
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <div className="vocal-print-sheet" role="dialog" aria-modal="true" aria-label="A4 学习稿">
        <div className="vocal-print-sheet__head">
          <div>
            <h2 className="vocal-print-sheet__title">A4 学习稿</h2>
            <p className="vocal-print-sheet__sub">
              <span className={`vocal-print-badge vocal-print-badge--${sheet.meta.structureSource}`}>{sheet.meta.sourceLabel}</span>
              <span>共 {sheet.meta.pageCount} 页</span>
              <span>修订 {revision} · 校验码 {paperCheckCode(item.id, revision)}</span>
              {sheet.meta.lineCount > 0 && <span>{sheet.meta.lineCount} 行歌词</span>}
            </p>
          </div>
          <button type="button" className="vocal-print-sheet__close" aria-label="关闭 A4 学习稿" onClick={onClose}>✕</button>
        </div>

        {noSections && (
          <p className="vocal-print-hint" role="status">暂无分段，将只按歌词行输出。</p>
        )}
        {empty && (
          <p className="vocal-print-hint vocal-print-hint--warn" role="alert">这首歌没有可打印的歌词行，学习稿会是空页。</p>
        )}
        {error && <p className="vocal-print-hint vocal-print-hint--error" role="alert">{error}</p>}
        {notice && <p className="vocal-print-hint" role="status">{notice}</p>}

        <div className="vocal-print-scroll" tabIndex={0} aria-label="A4 预览">
          {sheet.pages.map((page) => (
            <div className="vocal-print-preview" key={page.index}>
              <PagePreview page={page} />
              <p className="vocal-print-preview__caption">第 {page.index} / {page.total} 页</p>
            </div>
          ))}
        </div>

        <div className="vocal-print-actions">
          <button type="button" onClick={download} disabled={busy || empty}>{busy ? '正在生成…' : nativeSave ? '保存 PDF' : '下载 PDF'}</button>
          {nativeSave && saved && (
            <>
              <button type="button" onClick={share} disabled={busy}>分享</button>
              <button type="button" onClick={open} disabled={busy}>打开</button>
            </>
          )}
          <button type="button" onClick={print} disabled={busy || empty}>打印</button>
          <button type="button" onClick={onClose} disabled={busy}>关闭</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
