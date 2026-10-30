import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, jsonBody } from '../lib/api';
import '../styles/vocal-import-manager.css';

/**
 * V3.1 本地智能导入管理（Mac mini 管理页 / 单体管理面板）。
 *
 * 约束：
 * - 只使用服务端已登记的 rootId，扫描请求体绝不携带本机绝对路径；
 * - 界面只读接口状态，不假装扫描、提取或入库已经成功；
 * - 这里的「AI」指本机人声分离**提取**伴奏，不是生成新编曲。
 */

export interface VocalImportRoot {
  id: string;
  label: string;
  available: boolean;
}

export type VocalImportJobStatus =
  | 'NEEDS_REVIEW'
  | 'PENDING_EXTRACT'
  | 'EXTRACTING'
  | 'VERIFYING'
  | 'READY_TO_IMPORT'
  | 'IMPORTED'
  | 'FAILED'
  | 'CANCELLED';

export interface VocalRepeatOccurrence {
  startMs: number;
  lineIndex: number;
}

/** 仅来自 LRC 文本/时间行的重复候选；不推断旋律、Rap 或主副歌。 */
export interface VocalRepeatCandidate {
  id: string;
  kind: 'lyric-repeat' | string;
  source: string;
  status: string;
  sectionType: string;
  text: string;
  count: number;
  occurrences: VocalRepeatOccurrence[];
  occurrencesTruncated?: boolean;
}

export interface VocalImportJob {
  id: string;
  songId: string;
  rootId: string;
  status: VocalImportJobStatus;
  stage: string;
  importMode?: 'NONE' | 'DUAL_TRACK' | 'ORIGINAL_ONLY' | string;
  title: string;
  artist: string;
  language: string | null;
  original: { relPath: string; durationMs: number | null };
  lyrics: { relPath: string; timedLines: number } | null;
  suppliedAccompaniment: string | null;
  issues: string[];
  repeatCandidates?: VocalRepeatCandidate[] | null;
  repeatCandidateStatus?: string | null;
  artifacts?: { accompaniment?: { relPath?: string; sha256?: string } | null } | null;
  conflict?: {
    code?: string;
    repertoireId?: string | null;
    existingAccompanimentClipId?: string | null;
    incomingAccompanimentRelPath?: string | null;
    options?: string[];
  } | null;
  attempts: number;
  maxAttempts: number;
  cancelRequested: boolean;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

interface ScanResponse {
  created: number;
  reused: number;
  scan?: {
    summary?: {
      audioFiles?: number;
      lrcFiles?: number;
      readyToExtract?: number;
      needsReview?: number;
      duplicates?: number;
    };
  };
}

const ACTIVE_STATUSES: ReadonlySet<VocalImportJobStatus> = new Set(['PENDING_EXTRACT', 'EXTRACTING', 'VERIFYING']);

const IMPORT_CONFLICT_ISSUE = 'existing-accompaniment-conflict';

/** 文件名与 ID3 标签不一致：只有人工明确指定歌名 / 歌手才能消解，否则任务永远停在需核对。 */
const TITLE_CONFLICT_ISSUE = 'filename-id3-title-conflict';
const ARTIST_CONFLICT_ISSUE = 'filename-id3-artist-conflict';

/** 分离器/模型不可用不是任务失败，后端会把任务退回待提取并带这些错误码。 */
const MODEL_UNAVAILABLE_CODES: ReadonlySet<string> = new Set(['EXTRACTOR_NOT_CONFIGURED', 'SEPARATOR_NOT_CONFIGURED']);

const STATUS_META: Record<VocalImportJobStatus, { label: string; tone: string; hint: string }> = {
  NEEDS_REVIEW: { label: '需核对', tone: 'warn', hint: '存在歧义，需要人工确认；下方列出具体原因，确认前不会自动入库。' },
  PENDING_EXTRACT: { label: '待提取', tone: 'wait', hint: '已入队，等待 Mac mini 的导入 worker 领取；若服务端未启用 worker，任务会停在待提取（本页无法确认）。' },
  EXTRACTING: { label: '正在提取伴奏', tone: 'run', hint: 'Mac mini 正在本地做人声分离（提取，不是生成）。' },
  VERIFYING: { label: '校验音轨 / 歌词', tone: 'run', hint: '正在检查时长、文件哈希与歌词时间轴。' },
  READY_TO_IMPORT: { label: '已提取 · 待入库', tone: 'ok', hint: '伴奏已提取并通过技术校验，尚未写入曲库；音质仍需人工听测。' },
  IMPORTED: { label: '已入库', tone: 'ok', hint: '任务已完成入库，可在唱歌曲库查看；音质结论以实际听测为准。' },
  FAILED: { label: '提取失败', tone: 'bad', hint: '可点重试；只重跑失败阶段，不复制曲目。' },
  CANCELLED: { label: '已取消', tone: 'muted', hint: '已按你的操作停止；需要时可重新处理。' },
};

const ISSUE_LABELS: Record<string, string> = {
  'multiple-lyrics-candidates': '同一首歌有多个歌词候选',
  'lyrics-needs-confirmation': '歌词需要人工确认',
  'invalid-audio': '音频无法解码',
  'lyrics-invalid-tags': '歌词标签格式异常',
  'lyrics-timestamp-exceeds-audio': '歌词时间超出音频时长',
  'multiple-accompaniment-candidates': '同一首歌有多个伴奏候选',
  'same-title-different-audio-review': '同名但音频不同，需要确认版本',
  'role-conflict-same-audio': '同一音频被标成不同角色',
  'filename-id3-title-conflict': '文件名与标签歌名不一致',
  'filename-id3-artist-conflict': '文件名与标签歌手不一致',
  'pcm-duplicate-different-file': '音频指纹重复但文件不同',
  'existing-accompaniment-conflict': '曲库已有伴奏轨，已保留旧轨，未替换',
  'audio-role-unmarked-original-assumed': '文件未标原唱 / 伴奏，按原唱处理',
  'audio-tail-truncated': '音频尾部少量损坏，可继续但需留意',
  'audio-damaged': '音频损坏较严重',
  'duplicate-suffix': '文件名带 (1) 等副本后缀',
  'missing-lyrics': '未找到歌词（不阻断提取）',
  'lyrics-no-timestamps': '歌词没有时间戳，不能逐句同步',
};

const ISSUE_REASONS: Record<string, string> = {
  'multiple-lyrics-candidates': '找到多份歌词候选，无法确定用哪一份。',
  'lyrics-needs-confirmation': '歌词与音频的匹配不确定，需要人工确认。',
  'invalid-audio': '音频无法解码，需要确认文件是否损坏。',
  'lyrics-invalid-tags': '歌词标签格式异常，需要确认后再使用。',
  'lyrics-timestamp-exceeds-audio': '歌词时间超出音频时长，需要确认歌词是否配错。',
  'multiple-accompaniment-candidates': '找到多份伴奏候选，无法确定用哪一份。',
  'same-title-different-audio-review': '同名歌曲的音频不同，需要确认保留哪个版本。',
  'role-conflict-same-audio': '同一音频被标成不同角色（原唱 / 伴奏），需要确认。',
  'filename-id3-title-conflict': '文件名与音频标签里的歌名不一致，需要确认以哪个为准。',
  'filename-id3-artist-conflict': '文件名与音频标签里的歌手不一致，需要确认以哪个为准。',
  'pcm-duplicate-different-file': '音频指纹重复但文件不同，需要确认保留哪一份。',
  'existing-accompaniment-conflict': '曲库已有伴奏轨，系统已保留旧轨、没有替换新提取的伴奏。',
};

function issueLabel(issue: string): string {
  return ISSUE_LABELS[issue] ?? issue;
}

function issueReason(issue: string): string {
  return ISSUE_REASONS[issue] ?? '';
}

function hasExistingAccompanimentConflict(job: VocalImportJob): boolean {
  return job.issues.includes(IMPORT_CONFLICT_ISSUE) || job.error?.code === 'ACCOMPANIMENT_CONFLICT';
}

function isImportConflict(job: VocalImportJob): boolean {
  // 当前后端在入库阶段遇到已有伴奏会停 NEEDS_REVIEW / stage=IMPORT，且 resolve 明确拒绝入库冲突；
  // 这里同时看 stage 与问题码，避免后端只改其中一处时误给出无效的“核对”入口。
  return job.stage === 'IMPORT' || hasExistingAccompanimentConflict(job);
}

/** 只有标签冲突才需要歌名 / 歌手输入；其他核对场景不显示，避免误把歌名当成核对结果提交。 */
function needsTagConfirmation(job: VocalImportJob): boolean {
  return job.issues.includes(TITLE_CONFLICT_ISSUE) || job.issues.includes(ARTIST_CONFLICT_ISSUE);
}

/** 文件名一侧的原始文本（含扩展名），仅用于让用户对比标签一侧，不做任何清洗。 */
function originalFileName(job: VocalImportJob): string {
  const file = job.original?.relPath ?? '';
  return file.split('/').at(-1) ?? file;
}

/** 后端只允许尚未产生伴奏工件的失败/待提取任务走“只入库原唱 + 歌词”。 */
function canImportOriginalOnly(job: VocalImportJob): boolean {
  if (job.artifacts?.accompaniment?.relPath) return false;
  if (job.status === 'FAILED') return true;
  if (job.status !== 'PENDING_EXTRACT') return false;
  return Boolean(job.error?.code && MODEL_UNAVAILABLE_CODES.has(job.error.code));
}

function resolveNotice(status: VocalImportJobStatus): string {
  switch (status) {
    case 'PENDING_EXTRACT':
      return '已保存核对结果，任务进入「待提取」；伴奏尚未提取，也尚未入库。';
    case 'READY_TO_IMPORT':
      return '已保存核对结果，伴奏已就绪但尚未写入曲库。';
    case 'NEEDS_REVIEW':
      return '已保存，但任务仍有问题需要继续核对，尚未进入提取。';
    default:
      return `已保存核对结果，当前状态：${STATUS_META[status]?.label ?? status}。`;
  }
}

function displayTitle(job: VocalImportJob): string {
  if (job.title.trim()) return job.title;
  const file = job.original?.relPath ?? '';
  const name = file.split('/').at(-1) ?? file;
  return name.replace(/\.[^.]+$/, '') || '未命名曲目';
}

/** 只展示 LRC 原时间戳，不补 endMs、不插值。 */
function formatRepeatStart(startMs: number): string {
  if (!Number.isFinite(startMs) || startMs < 0) return '时间未知';
  const minutes = Math.floor(startMs / 60000);
  const seconds = Math.floor((startMs % 60000) / 1000);
  const millis = Math.round(startMs % 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return '无法连接 Mac mini 本地服务，请先在「我的 → Mac Mini 连接」检查地址和配对。';
}

function describeRootsError(error: unknown): { unconfigured: boolean; message: string } {
  const status = errorStatus(error);
  if (status === 401) {
    return { unconfigured: false, message: '请先在「我的 → 设备配对码」配对这台设备，才能读取 Mac mini 的导入目录。' };
  }
  if (status !== null && [404, 405, 501, 503].includes(status)) {
    return {
      unconfigured: true,
      message: 'Mac mini 尚未启用本地智能导入接口，当前不能扫描或提取。请由主开发者在服务端挂载后再试。',
    };
  }
  return { unconfigured: false, message: describeError(error) };
}

/** 只允许登记目录内的相对路径；绝对路径、盘符、UNC 与 .. 在提交前就被拒绝。 */
function relativePathProblem(value: string): string | null {
  if (!value) return null;
  if (value.includes('\0')) return '路径包含非法字符';
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    return '只接受已登记目录下的相对路径，不接受本机绝对路径';
  }
  if (value.replace(/\\/g, '/').split('/').includes('..')) return '路径不能包含 ..';
  return null;
}

export default function VocalImportManager() {
  const [roots, setRoots] = useState<VocalImportRoot[]>([]);
  const [rootsState, setRootsState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [rootsError, setRootsError] = useState('');
  const [unconfigured, setUnconfigured] = useState(false);
  const [selectedRootId, setSelectedRootId] = useState('');
  const [subPath, setSubPath] = useState('');
  const [subPathError, setSubPathError] = useState('');

  const [jobs, setJobs] = useState<VocalImportJob[]>([]);
  const [jobsState, setJobsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [jobsError, setJobsError] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [replaceConfirmJobId, setReplaceConfirmJobId] = useState<string | null>(null);

  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanSummary, setScanSummary] = useState('');

  const [reviewJob, setReviewJob] = useState<VocalImportJob | null>(null);
  const [reviewLyrics, setReviewLyrics] = useState('');
  const [reviewAccompaniment, setReviewAccompaniment] = useState('');
  const [reviewTitle, setReviewTitle] = useState('');
  const [reviewArtist, setReviewArtist] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [reviewNotice, setReviewNotice] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);

  const loadJobs = useCallback(async (showLoading = true) => {
    if (showLoading) setJobsState('loading');
    try {
      const value = await api<{ jobs?: VocalImportJob[] }>('/api/vocal-import/jobs?limit=200');
      setJobs(Array.isArray(value.jobs) ? value.jobs : []);
      setJobsError('');
      setJobsState('ready');
    } catch (error) {
      setJobsError(describeError(error));
      setJobsState('error');
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const value = await api<{ roots?: VocalImportRoot[] }>('/api/vocal-import/roots');
        if (!active) return;
        const list = Array.isArray(value.roots) ? value.roots : [];
        setRoots(list);
        setRootsState('ready');
        setSelectedRootId((current) => current || list.find((root) => root.available)?.id || list[0]?.id || '');
      } catch (error) {
        if (!active) return;
        const detail = describeRootsError(error);
        setUnconfigured(detail.unconfigured);
        setRootsError(detail.message);
        setRootsState('error');
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => { void loadJobs(); }, [loadJobs]);

  const hasActiveJobs = jobs.some((job) => ACTIVE_STATUSES.has(job.status));
  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = setInterval(() => { void loadJobs(false); }, 6000);
    return () => clearInterval(timer);
  }, [hasActiveJobs, loadJobs]);

  const selectedRoot = roots.find((root) => root.id === selectedRootId) ?? null;

  const scan = async () => {
    setSubPathError('');
    setScanError('');
    setScanSummary('');
    setActionNotice('');
    const problem = relativePathProblem(subPath.trim());
    if (problem) { setSubPathError(problem); return; }
    if (!selectedRoot) { setScanError('请选择一个已登记的导入目录。'); return; }
    if (!selectedRoot.available) { setScanError('这个导入目录当前不可用（外置卷未挂载或没有权限），不会假装开始扫描。'); return; }
    setScanning(true);
    const controller = new AbortController();
    try {
      const result = await api<ScanResponse>('/api/vocal-import/scan', {
        method: 'POST',
        ...jsonBody({ rootId: selectedRoot.id, ...(subPath.trim() ? { subPath: subPath.trim() } : {}) }),
        signal: controller.signal,
      });
      const summary = result.scan?.summary ?? {};
      setScanSummary(
        `扫描完成：音频 ${summary.audioFiles ?? 0} 个，歌词 ${summary.lrcFiles ?? 0} 个；` +
        `新增任务 ${result.created} 个，复用 ${result.reused} 个；` +
        `可自动提取 ${summary.readyToExtract ?? 0} 首，需核对 ${summary.needsReview ?? 0} 首，重复文件 ${summary.duplicates ?? 0} 个。` +
        '任务只是入队，伴奏要等 Mac mini 本地提取完成才算好；只有服务端启用了导入 worker 才会自动提取，未启用时任务会停在待提取。',
      );
      await loadJobs(false);
    } catch (error) {
      setScanError(controller.signal.aborted
        ? '已停止等待，但服务端扫描可能仍在继续；稍后点“刷新”查看任务。'
        : describeError(error));
    } finally {
      setScanning(false);
    }
  };

  const act = async (job: VocalImportJob, action: 'retry' | 'cancel') => {
    setBusyJobId(job.id);
    setActionError('');
    setActionNotice('');
    try {
      await api<VocalImportJob>(`/api/vocal-import/jobs/${job.id}/${action}`, { method: 'POST' });
      await loadJobs(false);
    } catch (error) {
      setActionError(describeError(error));
    } finally {
      setBusyJobId(null);
    }
  };

  const importOriginalOnly = async (job: VocalImportJob) => {
    setBusyJobId(job.id);
    setActionError('');
    setActionNotice('');
    try {
      const updated = await api<VocalImportJob>(`/api/vocal-import/jobs/${job.id}/original-only`, { method: 'POST' });
      setActionNotice(
        updated.status === 'IMPORTED'
          ? `「${displayTitle(job)}」已按你的操作只入库原唱与歌词，没有写入伴奏；可稍后点「继续提取伴奏」重试。`
          : `已提交只入库原唱请求，当前状态：${STATUS_META[updated.status]?.label ?? updated.status}。`,
      );
      await loadJobs(false);
    } catch (error) {
      setActionError(describeError(error));
    } finally {
      setBusyJobId(null);
    }
  };

  const resolveConflict = async (job: VocalImportJob, choice: 'keep-existing' | 'use-new') => {
    setBusyJobId(job.id);
    setActionError('');
    setActionNotice('');
    try {
      const updated = await api<VocalImportJob>(`/api/vocal-import/jobs/${job.id}/resolve-conflict`, {
        method: 'POST',
        ...jsonBody({ choice }),
      });
      setReplaceConfirmJobId(null);
      setActionNotice(
        choice === 'keep-existing'
          ? `已保留「${displayTitle(job)}」在曲库里的旧伴奏，只补原唱与歌词；旧轨未被替换。`
          : `已按你的明确选择改用新伴奏；旧音轨只解除绑定，文件没有删除。当前状态：${STATUS_META[updated.status]?.label ?? updated.status}。`,
      );
      await loadJobs(false);
    } catch (error) {
      setActionError(describeError(error));
    } finally {
      setBusyJobId(null);
    }
  };

  const openReview = (job: VocalImportJob) => {
    setReviewJob(job);
    setReviewLyrics(job.lyrics?.relPath ?? '');
    setReviewAccompaniment(job.suppliedAccompaniment ?? '');
    setReviewTitle(job.title ?? '');
    setReviewArtist(job.artist ?? '');
    setReviewError('');
    setReviewNotice('');
  };

  const submitReview = async () => {
    if (!reviewJob) return;
    setReviewError('');
    setReviewNotice('');
    setActionNotice('');
    const lyrics = reviewLyrics.trim();
    const accompaniment = reviewAccompaniment.trim();
    const tagConfirmation = needsTagConfirmation(reviewJob);
    const title = reviewTitle.trim();
    const artist = reviewArtist.trim();
    const lyricsProblem = relativePathProblem(lyrics);
    if (lyricsProblem) { setReviewError(`歌词相对路径：${lyricsProblem}`); return; }
    const accompanimentProblem = relativePathProblem(accompaniment);
    if (accompanimentProblem) { setReviewError(`伴奏相对路径：${accompanimentProblem}`); return; }
    if (!tagConfirmation && !lyrics && !accompaniment) {
      setReviewError('至少填写一个相对路径；不用本机绝对路径，也不要猜一个不存在的文件。');
      return;
    }
    if (tagConfirmation) {
      // 后端 resolve 对空歌名直接 400，这里先拦住，避免提交后才报错。
      if (!title) { setReviewError('歌名不能为空：文件名与标签冲突时需要明确以哪个歌名为准。'); return; }
      if (title.length > 200) { setReviewError('歌名不能超过 200 字。'); return; }
      if (artist.length > 200) { setReviewError('歌手名不能超过 200 字。'); return; }
    }
    const body: Record<string, string> = {};
    if (lyrics) body.lyricsRelPath = lyrics;
    if (accompaniment) body.suppliedAccompanimentRelPath = accompaniment;
    // 后端只要收到 title / artist 就记为人工确认；因此只在标签冲突场景带上，其它核对场景不提交。
    if (tagConfirmation) {
      body.title = title;
      body.artist = artist;
    }
    setReviewBusy(true);
    try {
      const updated = await api<VocalImportJob>(`/api/vocal-import/jobs/${reviewJob.id}/resolve`, { method: 'POST', ...jsonBody(body) });
      if (updated.status === 'NEEDS_REVIEW') {
        // 后端可能只消除了部分问题；不能关掉对话框假装已完成。
        setReviewJob(updated);
        setReviewLyrics(updated.lyrics?.relPath ?? '');
        setReviewAccompaniment(updated.suppliedAccompaniment ?? '');
        setReviewTitle(updated.title ?? '');
        setReviewArtist(updated.artist ?? '');
        setReviewNotice(updated.issues.length > 0
          ? `已保存，但仍有 ${updated.issues.length} 项需要核对，任务尚未进入提取。`
          : '已保存，但服务端仍将该任务标为需核对，尚未进入提取；请查看任务详情确认原因。');
        await loadJobs(false);
        return;
      }
      setReviewJob(null);
      setActionNotice(resolveNotice(updated.status));
      await loadJobs(false);
    } catch (error) {
      setReviewError(describeError(error));
    } finally {
      setReviewBusy(false);
    }
  };

  return (
    <section className="vocal-import" aria-labelledby="vocal-import-manager-title">
      <h2 id="vocal-import-manager-title">本地智能导入</h2>
      <p className="vocal-import__lead">
        在 Mac mini 上扫描你已登记的音乐文件夹，用本机模型<strong>提取</strong>伴奏（人声分离），不是 AI 生成新伴奏；不会把音频上传到云端。
      </p>
      <p className="vocal-import__hint">
        只使用服务端登记的 rootId。界面不会向服务端发送 <code>/Volumes/...</code> 这类本机绝对路径，也无法读取任意目录。
      </p>

      {rootsState === 'loading' && <p className="vocal-import__hint" role="status">正在读取 Mac mini 已登记的导入目录…</p>}

      {rootsState === 'error' && (
        <div className={`vocal-import__notice${unconfigured ? ' vocal-import__notice--warn' : ''}`} role="status">
          <p>{rootsError}</p>
          <p className="vocal-import__hint">
            {unconfigured
              ? '当前不能扫描、提取或入库；界面不会假装已开始或已完成。'
              : '目录列表尚未加载成功，稍后可点下方“刷新任务”再试。'}
          </p>
        </div>
      )}

      {rootsState === 'ready' && roots.length === 0 && (
        <div className="vocal-import__notice vocal-import__notice--warn" role="status">
          <p>Mac mini 还没有登记任何导入目录（rootId）。</p>
          <p className="vocal-import__hint">导入根目录只能由服务端白名单登记；本界面不接受本机绝对路径。</p>
        </div>
      )}

      {rootsState === 'ready' && roots.length > 0 && (
        <div className="vocal-import__roots">
          <div className="vocal-import__root-row" role="group" aria-label="选择已登记的导入目录">
            {roots.map((root) => (
              <button
                key={root.id}
                type="button"
                className="vocal-import__root"
                aria-pressed={selectedRootId === root.id}
                disabled={scanning}
                onClick={() => setSelectedRootId(root.id)}
              >
                <strong>{root.label}</strong>
                <small>rootId：{root.id}{root.available ? '' : ' · 当前不可用'}</small>
              </button>
            ))}
          </div>
          {selectedRoot && !selectedRoot.available && (
            <p className="vocal-import__hint" role="alert">这个目录当前不可用（外置卷未挂载或没有权限），不能扫描。</p>
          )}
          <label className="vocal-import__field">
            子目录（可选，相对路径）
            <input
              value={subPath}
              onChange={(event) => { setSubPath(event.target.value); setSubPathError(''); }}
              placeholder="例如 ncm/已转换；留空扫描整个已登记目录"
              inputMode="text"
              aria-describedby={subPathError ? 'vocal-import-subpath-error' : undefined}
            />
          </label>
          {subPathError && <p className="vocal-import__error" id="vocal-import-subpath-error" role="alert">{subPathError}</p>}
          <div className="vocal-import__actions">
            <button
              type="button"
              className="primary"
              disabled={scanning || !selectedRoot || !selectedRoot.available}
              onClick={() => void scan()}
            >
              {scanning ? '正在扫描（可能需要几分钟）…' : '扫描并入队'}
            </button>
            <button type="button" disabled={scanning} onClick={() => void loadJobs()}>刷新任务</button>
          </div>
          {scanning && <p className="vocal-import__hint" role="status">正在只读扫描并创建任务；源文件不会被改名、覆盖或删除。</p>}
          {scanSummary && <p className="vocal-import__notice" role="status">{scanSummary}</p>}
          {scanError && <p className="vocal-import__error" role="alert">{scanError}</p>}
        </div>
      )}

      <div className="vocal-import__jobs">
        <div className="vocal-import__jobs-head">
          <h3>任务状态</h3>
          <button type="button" disabled={jobsState === 'loading'} onClick={() => void loadJobs()}>
            {jobsState === 'loading' ? '读取中…' : '刷新任务'}
          </button>
        </div>
        <p className="vocal-import__hint">
          手机关屏或关闭本页不会让任务消失；是否继续自动提取取决于 Mac mini 是否启用了导入 worker，本页无法确认。失败和异常只影响对应的一首。
        </p>
        {actionNotice && <p className="vocal-import__notice" role="status">{actionNotice}</p>}
        {actionError && <p className="vocal-import__error" role="alert">{actionError}</p>}
        {jobsState === 'error' && <p className="vocal-import__error" role="alert">{jobsError}</p>}
        {jobsState !== 'error' && jobs.length === 0 && (
          <p className="vocal-import__hint" role="status">{jobsState === 'loading' ? '正在读取任务…' : '还没有导入任务。'}</p>
        )}
        {jobs.length > 0 && (
          <ul className="vocal-import__list">
            {jobs.map((job) => {
              const meta = STATUS_META[job.status] ?? { label: job.status, tone: 'wait', hint: '' };
              const busy = busyJobId === job.id;
              const importConflict = isImportConflict(job);
              const existingAccompanimentConflict = hasExistingAccompanimentConflict(job);
              const repeatCandidates = Array.isArray(job.repeatCandidates) ? job.repeatCandidates : [];
              return (
                <li className={`vocal-import-job vocal-import-job--${meta.tone}`} key={job.id}>
                  <div className="vocal-import-job__head">
                    <p className="vocal-import-job__title">{displayTitle(job)}</p>
                    <span className="vocal-import-status">{meta.label}</span>
                  </div>
                  {job.artist && <p className="vocal-import-job__meta">{job.artist}</p>}
                  <p className="vocal-import-job__meta">{job.original?.relPath}</p>
                  <p className="vocal-import-job__meta">{meta.hint}</p>
                  {job.cancelRequested && ACTIVE_STATUSES.has(job.status) && (
                    <p className="vocal-import-job__meta">已请求取消，当前阶段结束后停止。</p>
                  )}
                  {job.error && (
                    <p className="vocal-import__error" role="alert">
                      {job.error.message}{job.error.code ? `（${job.error.code}）` : ''}
                    </p>
                  )}
                  {job.status === 'NEEDS_REVIEW' ? (
                    <div className="vocal-import-job__review">
                      <p className="vocal-import-job__review-label">需核对原因</p>
                      {job.issues.length > 0 ? (
                        <ul className="vocal-import-job__issues" aria-label="需核对原因">
                          {job.issues.map((issue) => (
                            <li key={issue}>
                              <strong>{issueLabel(issue)}</strong>
                              {issueReason(issue) ? `：${issueReason(issue)}` : ''}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="vocal-import-job__meta">服务端没有给出具体原因，请到 Mac mini 管理页查看任务详情。</p>
                      )}
                      {existingAccompanimentConflict ? (
                        <div className="vocal-import-job__review">
                          <p className="vocal-import-job__meta">
                            曲库已有伴奏轨，系统没有自动替换。请明确选择：保留旧伴奏（只补原唱 / 歌词），或改用本次提取的新伴奏（旧音轨只解除绑定，文件不删除）。
                          </p>
                          {job.conflict?.incomingAccompanimentRelPath && (
                            <p className="vocal-import-job__meta">本次新伴奏：{job.conflict.incomingAccompanimentRelPath}</p>
                          )}
                        </div>
                      ) : importConflict ? (
                        <p className="vocal-import-job__meta">
                          当前是入库阶段的冲突，后端不允许用歌词或伴奏候选在这里消除；请按服务端给出的冲突信息处理。
                        </p>
                      ) : null}
                    </div>
                  ) : job.issues.length > 0 ? (
                    <ul className="vocal-import-job__issues" aria-label="需要留意的问题">
                      {job.issues.map((issue) => <li key={issue}>{issueLabel(issue)}</li>)}
                    </ul>
                  ) : null}
                  {job.lyrics && repeatCandidates.length > 0 && (
                    <details className="vocal-import-job__repeat">
                      <summary>
                        <span className="vocal-import-job__review-label">
                          歌词重复行清单：{repeatCandidates.length} 组（仅供参照，无需逐条确认）
                        </span>
                      </summary>
                      <p className="vocal-import__hint">
                        这些重复歌词已用于自动推测歌曲结构（副歌、前奏 / 尾奏）。这里是原始重复行清单，仅供参考，不会阻塞导入，也不需要在本页逐条确认。
                      </p>
                      <ul className="vocal-import-job__issues" aria-label="歌词重复行清单（仅供参照）">
                        {repeatCandidates.map((candidate) => (
                          <li key={candidate.id}>
                            <strong>{candidate.text}</strong>
                            {` · ${candidate.count} 次 · 来源：${candidate.source}`}
                            <span className="vocal-import-job__meta">
                              {` · 时间：${candidate.occurrences.map((item) => formatRepeatStart(item.startMs)).join('、')}`}
                              {candidate.occurrencesTruncated ? '（仅列前若干次）' : ''}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {job.status === 'FAILED' && (
                    <p className="vocal-import-job__meta">已尝试 {job.attempts}/{job.maxAttempts} 次。</p>
                  )}
                  {job.status === 'IMPORTED' && job.importMode === 'ORIGINAL_ONLY' && (
                    <p className="vocal-import-job__meta">当前只入库了原唱与歌词，还没有伴奏；需要时可点「继续提取伴奏」重试，不会覆盖已有原唱。</p>
                  )}
                  <div className="vocal-import-job__actions">
                    {job.status === 'NEEDS_REVIEW' && !importConflict && (
                      <button type="button" className="primary" onClick={() => openReview(job)} aria-label={`核对 ${displayTitle(job)}`}>核对歌词 / 伴奏</button>
                    )}
                    {job.status === 'NEEDS_REVIEW' && existingAccompanimentConflict && (
                      <>
                        <button
                          type="button"
                          className="primary"
                          disabled={busy}
                          onClick={() => void resolveConflict(job, 'keep-existing')}
                          aria-label={`保留旧伴奏 ${displayTitle(job)}`}
                        >
                          {busy ? '处理中…' : '保留旧伴奏'}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setReplaceConfirmJobId(job.id)}
                          aria-label={`改用新伴奏 ${displayTitle(job)}`}
                        >
                          改用新伴奏
                        </button>
                      </>
                    )}
                    {job.status === 'NEEDS_REVIEW' && importConflict && !existingAccompanimentConflict && (
                      <button type="button" disabled={busy} onClick={() => void act(job, 'retry')} aria-label={`重新检查 ${displayTitle(job)}`}>
                        {busy ? '处理中…' : '重新检查'}
                      </button>
                    )}
                    {canImportOriginalOnly(job) && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void importOriginalOnly(job)}
                        aria-label={`只入库原唱和歌词 ${displayTitle(job)}`}
                      >
                        {busy ? '处理中…' : '只入库原唱 + 歌词'}
                      </button>
                    )}
                    {(job.status === 'FAILED' || job.status === 'CANCELLED') && (
                      <button type="button" disabled={busy} onClick={() => void act(job, 'retry')} aria-label={`重试 ${displayTitle(job)}`}>
                        {busy ? '处理中…' : '重试'}
                      </button>
                    )}
                    {job.status === 'IMPORTED' && job.importMode === 'ORIGINAL_ONLY' && (
                      <button type="button" disabled={busy} onClick={() => void act(job, 'retry')} aria-label={`继续提取伴奏 ${displayTitle(job)}`}>
                        {busy ? '处理中…' : '继续提取伴奏'}
                      </button>
                    )}
                    {job.status !== 'IMPORTED' && job.status !== 'CANCELLED' && (
                      <button type="button" disabled={busy} onClick={() => void act(job, 'cancel')} aria-label={`取消 ${displayTitle(job)}`}>
                        {busy ? '处理中…' : '取消'}
                      </button>
                    )}
                  </div>
                  {replaceConfirmJobId === job.id && (
                    <div role="alertdialog" aria-label={`确认改用新伴奏：${displayTitle(job)}`} className="vocal-import__notice vocal-import__notice--warn">
                      <p role="alert">
                        确认改用「{displayTitle(job)}」本次提取的新伴奏？旧伴奏音轨只解除绑定、文件保留，但曲目会改用新文件；确认后才会替换。
                      </p>
                      <div className="vocal-import__actions">
                        <button type="button" className="primary" disabled={busy} onClick={() => void resolveConflict(job, 'use-new')}>
                          {busy ? '处理中…' : '确认改用新伴奏'}
                        </button>
                        <button type="button" disabled={busy} onClick={() => setReplaceConfirmJobId(null)}>取消</button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="vocal-import__hint">
        提取可能留下主唱残余或损伤乐器，未经真实听测不能算音质合格。手机端可在唱歌曲库查看任务状态；
        <Link to="/repertoire/vocal">去唱歌曲库</Link>。
      </p>

      {reviewJob && (
        <div className="modal-backdrop">
          <section className="import-sheet vocal-import-review" role="dialog" aria-modal="true" aria-label={`核对导入任务：${displayTitle(reviewJob)}`}>
            <h3>核对「{displayTitle(reviewJob)}」</h3>
            <p>只填已登记目录下的相对路径，例如 <code>歌手 - 歌名.lrc</code>；不要填 <code>/Volumes/...</code> 这类本机绝对路径。</p>
            {reviewJob.issues.length > 0 && (
              <ul className="vocal-import-job__issues" aria-label="需核对原因">
                {reviewJob.issues.map((issue) => (
                  <li key={issue}>
                    <strong>{issueLabel(issue)}</strong>
                    {issueReason(issue) ? `：${issueReason(issue)}` : ''}
                  </li>
                ))}
              </ul>
            )}
            {needsTagConfirmation(reviewJob) && (
              <div className="vocal-import__notice" role="group" aria-label="文件名与标签冲突确认">
                <p>
                  文件名一侧：<code>{originalFileName(reviewJob)}</code>
                </p>
                <p>
                  音频标签一侧：歌名「{reviewJob.title || '（空）'}」，歌手「{reviewJob.artist || '（空）'}」。
                </p>
                <p className="vocal-import__hint">
                  下面两个输入是要写入曲库的最终值，默认取当前解析结果；改完保存即视为你人工确认，任务不会再因这条冲突停在需核对。
                </p>
                <label className="vocal-import__field">
                  歌名（不能为空，以此值为准）
                  <input
                    value={reviewTitle}
                    onChange={(event) => { setReviewTitle(event.target.value); setReviewError(''); setReviewNotice(''); }}
                  />
                </label>
                <label className="vocal-import__field">
                  歌手（可留空，以此值为准）
                  <input
                    value={reviewArtist}
                    onChange={(event) => { setReviewArtist(event.target.value); setReviewError(''); setReviewNotice(''); }}
                  />
                </label>
              </div>
            )}
            <label className="vocal-import__field">
              歌词相对路径（.lrc，可留空）
              <input value={reviewLyrics} onChange={(event) => { setReviewLyrics(event.target.value); setReviewError(''); setReviewNotice(''); }} />
            </label>
            <label className="vocal-import__field">
              已有伴奏相对路径（可留空）
              <input value={reviewAccompaniment} onChange={(event) => { setReviewAccompaniment(event.target.value); setReviewError(''); setReviewNotice(''); }} />
            </label>
            {reviewNotice && <p className="vocal-import__notice" role="status">{reviewNotice}</p>}
            {reviewError && <p className="vocal-import__error" role="alert">{reviewError}</p>}
            <div className="vocal-import__actions">
              <button type="button" className="primary" disabled={reviewBusy} onClick={() => void submitReview()}>
                {reviewBusy ? '保存中…' : '保存核对'}
              </button>
              <button type="button" disabled={reviewBusy} onClick={() => setReviewJob(null)}>取消</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
