import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { VocalImportJob, VocalImportJobStatus } from './VocalImportManager';
import '../styles/vocal-import-manager.css';

/**
 * 手机端（唱歌曲库）的本地导入任务状态条。
 *
 * 只读任务状态，不在手机运行模型，也不伪造「提取成功」：
 * 真正扫描、提取、入库都在 Mac mini；这里只显示进度、异常入口与失败重试。
 */

const STATUS_LABEL: Record<VocalImportJobStatus, string> = {
  NEEDS_REVIEW: '需核对',
  PENDING_EXTRACT: '待提取',
  EXTRACTING: '提取中',
  VERIFYING: '校验中',
  READY_TO_IMPORT: '待入库',
  IMPORTED: '已入库',
  FAILED: '失败',
  CANCELLED: '已取消',
};

/** 手机任务条按此顺序汇总，未出现的状态不占位。 */
const STATUS_ORDER: readonly VocalImportJobStatus[] = [
  'PENDING_EXTRACT',
  'EXTRACTING',
  'VERIFYING',
  'READY_TO_IMPORT',
  'NEEDS_REVIEW',
  'FAILED',
  'IMPORTED',
  'CANCELLED',
];

const RUNNING: ReadonlySet<VocalImportJobStatus> = new Set(['PENDING_EXTRACT', 'EXTRACTING', 'VERIFYING']);
const ATTENTION: ReadonlySet<VocalImportJobStatus> = new Set(['NEEDS_REVIEW', 'FAILED']);

function jobTitle(job: VocalImportJob): string {
  if (job.title?.trim()) return job.title;
  const file = job.original?.relPath ?? '';
  return (file.split('/').at(-1) ?? '').replace(/\.[^.]+$/, '') || '未命名曲目';
}

function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

function unavailableMessage(error: unknown): string {
  const status = errorStatus(error);
  if (status !== null && [404, 405, 501, 503].includes(status)) return 'Mac mini 尚未启用本地智能导入（未挂载导入接口）。';
  if (status === 401) return '配对这台设备后可查看 Mac mini 的导入任务。';
  if (error instanceof Error && error.message) return error.message;
  return '暂时读不到 Mac mini 的导入任务，可检查连接后再试。';
}

export default function VocalImportStatus() {
  const [jobs, setJobs] = useState<VocalImportJob[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const value = await api<{ jobs?: VocalImportJob[] }>('/api/vocal-import/jobs?limit=200');
      setJobs(Array.isArray(value.jobs) ? value.jobs : []);
    } catch (cause) {
      setError(unavailableMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const hasRunning = jobs.some((job) => RUNNING.has(job.status));
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => { void load(); }, 6000);
    return () => clearInterval(timer);
  }, [hasRunning, load]);

  const counts = STATUS_ORDER.reduce<Record<VocalImportJobStatus, number>>(
    (result, status) => { result[status] = 0; return result; },
    {} as Record<VocalImportJobStatus, number>,
  );
  for (const job of jobs) {
    if (job.status in counts) counts[job.status] += 1;
  }
  const summary = STATUS_ORDER
    .filter((status) => counts[status] > 0)
    .map((status) => `${STATUS_LABEL[status]} ${counts[status]}`)
    .join(' · ');
  const attention = jobs.filter((job) => ATTENTION.has(job.status));

  const retry = async (job: VocalImportJob) => {
    setRetrying(job.id);
    setError('');
    try {
      await api<VocalImportJob>(`/api/vocal-import/jobs/${job.id}/retry`, { method: 'POST' });
      await load();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : '重试没有发出去，请检查连接。');
    } finally {
      setRetrying(null);
    }
  };

  if (loading) return <section className="vocal-import-status-bar" aria-label="本地导入任务状态"><p className="vocal-import-status-bar__summary">正在读取 Mac mini 导入任务…</p></section>;

  if (error) {
    return (
      <section className="vocal-import-status-bar" aria-label="本地导入任务状态">
        <p className="vocal-import-status-bar__summary">{error}</p>
        <div className="vocal-import-status-bar__actions">
          <button type="button" onClick={() => { setLoading(true); void load(); }}>重试读取</button>
          <Link to="/settings">去「我的」查看导入设置</Link>
        </div>
      </section>
    );
  }

  if (!jobs.length) {
    return (
      <section className="vocal-import-status-bar" aria-label="本地导入任务状态">
        <p className="vocal-import-status-bar__summary">暂无本地智能导入任务。</p>
        <div className="vocal-import-status-bar__actions">
          <Link to="/settings">在 Mac mini 上智能导入音乐文件夹</Link>
        </div>
      </section>
    );
  }

  return (
    <section className="vocal-import-status-bar" aria-label="本地导入任务状态">
      <div className="vocal-import-status-bar__head">
        <span className="vocal-import-status-bar__title">本地导入</span>
        <button type="button" onClick={() => void load()}>刷新</button>
      </div>
      <p className="vocal-import-status-bar__summary">
        {summary}
      </p>
      {attention.length > 0 && (
        <ul className="vocal-import-status-bar__list">
          {attention.map((job) => (
            <li key={job.id} className="vocal-import-status-bar__item">
              <span>{STATUS_LABEL[job.status] ?? job.status} · {jobTitle(job)}</span>
              {job.status === 'FAILED' && (
                <button type="button" disabled={retrying === job.id} onClick={() => void retry(job)}>
                  {retrying === job.id ? '重试中…' : '重试'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {(counts.NEEDS_REVIEW > 0 || counts.PENDING_EXTRACT > 0 || counts.EXTRACTING > 0 || counts.VERIFYING > 0) && (
        <p className="vocal-import-status-bar__summary">
          需核对或等待提取的任务请在 Mac mini 管理页处理；手机不会运行提取模型。任务会保留，是否自动继续取决于 Mac mini 是否启用了导入 worker。
        </p>
      )}
      <div className="vocal-import-status-bar__actions">
        <Link to="/settings">打开导入管理</Link>
      </div>
    </section>
  );
}
