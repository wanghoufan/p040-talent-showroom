import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { createAccompanimentVerifier } from './accompaniment-verify.mjs';
import { isLyricsFile } from './canonical.mjs';
import { fail } from './errors.mjs';
import { parseLrcFile } from './lrc.mjs';
import { buildLyricRepeatSuggestions } from './lyrics-repeat.mjs';
import { needsReview } from './issues.mjs';
import { scanSource } from './scan.mjs';
import {
  assertVocalImportSchema,
  appendEvent,
  getJobRow,
  insertJob,
  listArtifacts,
  listEvents,
  listJobRows,
  requireJobRow,
  toPublicJob,
  updateJob,
  updateJobIf,
  upsertArtifact,
  withTransaction,
} from './store.mjs';

/**
 * 独立后台导入队列。
 *
 * 设计要点（对应 AC12 / AC13）：
 * - 队列只写 `vocal_import_*`；不引用任何曲库写入函数，未注入 `importer` 时不可能写生产库；
 * - 每个任务独立事务、独立失败：一首失败不影响同批其余任务；
 * - 任务带租约，进程重启后 `recover()` 把过期租约退回待处理，已完成阶段不重算；
 * - 幂等键 `rootId:songId`：重复扫描不重复建任务，也不覆盖已完成结果；
 * - 分离模型不在本模块内：未注入 `extractor` 时任务保持 `PENDING_EXTRACT` 并如实报告未配置。
 */
function hashFile(filePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const digest = createHash('sha256');
    createReadStream(filePath)
      .on('error', rejectPromise)
      .on('data', chunk => digest.update(chunk))
      .on('end', () => resolvePromise(digest.digest('hex')));
  });
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text ?? '') ?? fallback;
  } catch {
    return fallback;
  }
}

const ACCOMPANIMENT_CONFLICT_ISSUE = 'existing-accompaniment-conflict';
/** 这些失败来自“伴奏本身不可用”，重试同一份文件不会变好。 */
const ACCOMPANIMENT_REJECTED_CODES = new Set([
  'ACCOMPANIMENT_NOT_AUDIO',
  'ACCOMPANIMENT_NOT_FOUND',
  'ACCOMPANIMENT_EMPTY',
  'ACCOMPANIMENT_DUPLICATES_ORIGINAL',
  'ACCOMPANIMENT_NOT_DECODABLE',
  'ACCOMPANIMENT_DURATION_UNKNOWN',
  'ACCOMPANIMENT_DURATION_MISMATCH',
  'ACCOMPANIMENT_VERIFIER_UNAVAILABLE',
]);
/** 这些是“用户选的文件不合格”，可以退回人工核对重新选择；工具缺失不在此列。 */
const SUPPLIED_REJECTED_CODES = new Set([
  'ACCOMPANIMENT_NOT_AUDIO',
  'ACCOMPANIMENT_NOT_FOUND',
  'ACCOMPANIMENT_EMPTY',
  'ACCOMPANIMENT_DUPLICATES_ORIGINAL',
  'ACCOMPANIMENT_NOT_DECODABLE',
  'ACCOMPANIMENT_DURATION_UNKNOWN',
  'ACCOMPANIMENT_DURATION_MISMATCH',
]);

export function createVocalImportQueue({
  db,
  policy,
  mediaRoot = null,
  extractor = null,
  importer = null,
  verifyAccompaniment = null,
  maxAttempts = 3,
  // 单次真实提取可能约 700 秒，分离器默认超时 30 分钟；租约必须覆盖整个提取窗口，
  // 否则任务还在提取就被别的 worker 接管，旧结果回来会覆盖新结果。
  leaseMs = 45 * 60 * 1000,
  workerId = 'vocal-import-local',
  now = () => Date.now(),
  logger = null,
}) {
  assertVocalImportSchema(db);
  const jobOutputRoot = mediaRoot ? join(mediaRoot, 'vocal-import') : null;
  // 生产默认严格：真实 ffprobe + 整轨解码。测试只能注入探测实现，不能关闭规则。
  const verifyAccompanimentArtifact = verifyAccompaniment ?? createAccompanimentVerifier();

  /** 每次领取都生成不可复用的租约标识：同名 worker 重新领取也不等于旧身份。 */
  function newLeaseOwner(owner) {
    return `${owner}#${randomBytes(8).toString('hex')}`;
  }

  function claimHeldBy(row, claim) {
    return Boolean(claim?.owner) &&
      row?.lease_owner === claim.owner &&
      (row.lease_expires_at ?? null) === (claim.expiresAt ?? null);
  }

  function assertClaimHeld(row, claim, statuses = null) {
    if (!claim?.owner || (statuses && !statuses.includes(row.status)) || !claimHeldBy(row, claim)) {
      fail('STALE_CLAIM', '任务已由其它 worker 接管，本次结果已丢弃', { status: 409 });
    }
  }

  /** 条件写入：租约/状态不再是本次领取时抛 STALE_CLAIM，由 runOnce 静默丢弃。 */
  function updateClaimedJob(jobId, fields, claim, statuses) {
    const updated = updateJobIf(db, jobId, fields, {
      statuses,
      leaseOwner: claim.owner,
      leaseExpiresAt: claim.expiresAt,
    });
    if (!updated) fail('STALE_CLAIM', '任务已由其它 worker 接管，本次结果已丢弃', { status: 409 });
    return updated;
  }

  function claimOutputSuffix(claim) {
    return String(claim?.owner ?? 'claim').replace(/[^A-Za-z0-9_-]/g, '-');
  }

  function artifactPath(relPath) {
    if (!mediaRoot) fail('CONFLICT', '未配置 mediaRoot，无法校验伴奏文件');
    const absolute = resolve(mediaRoot, relPath);
    if (absolute !== mediaRoot && !absolute.startsWith(mediaRoot + sep)) fail('PATH_NOT_ALLOWED', '伴奏文件不在受控目录内');
    return absolute;
  }

  /** 原唱文件路径：用于伴奏缺少时长记录时直接探测原唱时长，而不是相信伴奏自报。 */
  function originalFilePathFor(row) {
    if (!row?.source_rel_path) return null;
    try {
      return policy.resolveFile(row.root_id, row.source_rel_path).filePath;
    } catch {
      return null;
    }
  }

  /**
   * 统一校验入口：扩展名、SHA（含与原唱相同）、真实解码、原曲时长容差。
   * 校验失败直接抛错，调用方必须在写库前处理，失败不得登记成可播放伴奏。
   */
  async function verifyIncomingArtifact(row, artifact, { filePath, relPath = artifact?.relPath } = {}) {
    const verified = await verifyAccompanimentArtifact({
      filePath,
      relPath,
      originalFilePath: originalFilePathFor(row),
      originalSha256: row.source_sha256 ?? null,
      sourceDurationMs: row.source_duration_ms ?? null,
      expectedSha256: typeof artifact?.sha256 === 'string' && artifact.sha256 ? artifact.sha256 : null,
    });
    return {
      ...artifact,
      relPath: relPath ?? artifact?.relPath,
      sha256: verified.sha256,
      sizeBytes: verified.sizeBytes,
      durationMs: verified.durationMs,
    };
  }

  /**
   * 用户自带伴奏（扫描时识别的 Instrumental/伴奏文件）要先复制进受控媒体目录，
   * 才能与提取产物走同一套校验/入库路径；源目录只读，不覆盖原始文件。
   * 多次调用幂等：同一路径、同一 SHA 且副本完好时直接复用。
   */
  async function ensureSuppliedArtifact(row, claim = null) {
    if (!row?.supplied_accompaniment_rel_path) return parseJson(row?.artifacts_json, {}).accompaniment ?? null;
    if (!mediaRoot) fail('CONFLICT', '未配置 mediaRoot，无法校验伴奏文件');
    if (claim) assertClaimHeld(requireJobRow(db, row.id), claim);
    const suppliedRel = row.supplied_accompaniment_rel_path;
    const source = policy.resolveFile(row.root_id, suppliedRel);
    let sourceStat;
    try {
      sourceStat = statSync(source.filePath);
    } catch {
      fail('ACCOMPANIMENT_NOT_FOUND', '指定的伴奏文件不存在，无法入库', { status: 422 });
    }
    if (!sourceStat.isFile() || sourceStat.size === 0) fail('ACCOMPANIMENT_EMPTY', '指定的伴奏文件为空或不是普通文件', { status: 422 });
    // 先校验再复制：LRC/与原唱相同/不可解码/时长不符的文件不进入受控目录，也不登记工件。
    const verified = await verifyAccompanimentArtifact({
      filePath: source.filePath,
      relPath: suppliedRel,
      originalFilePath: originalFilePathFor(row),
      originalSha256: row.source_sha256 ?? null,
      sourceDurationMs: row.source_duration_ms ?? null,
    });
    const sourceSha = verified.sha256;
    const current = parseJson(row.artifacts_json, {}).accompaniment ?? null;
    const extension = extname(source.filePath).toLowerCase() || '.bin';
    const directory = join(mediaRoot, 'vocal-import', row.song_id);
    mkdirSync(directory, { recursive: true });
    // 文件名带内容 SHA：重扫后伴奏内容变了也不会覆盖旧副本，迟到的旧 claim 也碰不到新文件。
    const destination = join(directory, `supplied-accompaniment-${sourceSha.slice(0, 12)}${extension}`);
    const relPath = relative(mediaRoot, destination).split(sep).join('/');

    const currentMatches =
      current &&
      current.source === 'supplied' &&
      current.sourceRelPath === suppliedRel &&
      current.sha256 === sourceSha &&
      current.relPath === relPath;
    let copyOk = false;
    if (currentMatches) {
      try {
        const stat = statSync(destination);
        copyOk = stat.isFile() && stat.size === sourceStat.size && (await hashFile(destination)) === sourceSha;
      } catch {
        copyOk = false;
      }
    }
    if (currentMatches && copyOk) return current;

    const temp = `${destination}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      copyFileSync(source.filePath, temp);
      if ((await hashFile(temp)) !== sourceSha) fail('CONFLICT', '复制后的伴奏文件校验失败');
      renameSync(temp, destination);
    } finally {
      if (existsSync(temp)) {
        try {
          unlinkSync(temp);
        } catch {
          /* 临时文件清理失败不影响下一次重试 */
        }
      }
    }

    const artifact = {
      relPath,
      sha256: sourceSha,
      sizeBytes: verified.sizeBytes,
      durationMs: verified.durationMs,
      codec: extension.slice(1) || 'unknown',
      source: 'supplied',
      sourceRelPath: suppliedRel,
    };
    const artifacts = { ...parseJson(row.artifacts_json, {}), accompaniment: artifact };
    withTransaction(db, () => {
      // 先确认租约仍属于本次领取，再登记工件；迟到的旧 worker 不得写工件表或 artifacts_json。
      const updated = claim
        ? updateClaimedJob(row.id, { artifactsJson: JSON.stringify(artifacts) }, claim, [row.status])
        : updateJob(db, row.id, { artifactsJson: JSON.stringify(artifacts) });
      upsertArtifact(db, row.id, { kind: 'accompaniment', version: 1, state: 'ready', ...artifact });
      appendEvent(db, row.id, {
        event: 'supplied-accompaniment-ready',
        stage: 'VERIFY',
        status: updated.status,
        detail: { relPath, sha256: sourceSha, sourceRelPath: suppliedRel },
      });
    });
    return artifact;
  }

  /** 为“用户明确选择新伴奏”单独提取一份，输出到独立子目录，绝不覆盖旧伴奏文件。 */
  async function extractFreshArtifact(row, { suffix = 'replace' } = {}) {
    if (!extractor) fail('CONFLICT', '未配置本地伴奏提取器，无法生成新伴奏');
    if (!jobOutputRoot) fail('CONFLICT', '未配置 mediaRoot，无法生成新伴奏');
    const source = policy.resolveFile(row.root_id, row.source_rel_path);
    const beforeSha = await hashFile(source.filePath).catch(() => null);
    if (beforeSha !== row.source_sha256) fail('SOURCE_CHANGED', '源音频在扫描后已改变，请重新扫描', { status: 409 });
    const outputDir = join(jobOutputRoot, row.song_id, suffix);
    mkdirSync(outputDir, { recursive: true });
    const lyrics = row.lyrics_rel_path ? policy.resolveFile(row.root_id, row.lyrics_rel_path) : null;
    const artifact = await extractor({
      job: toPublicJob(row),
      sourceFile: source.filePath,
      lyricsFile: lyrics?.filePath ?? null,
      outputDir,
    });
    const afterSha = await hashFile(source.filePath).catch(() => null);
    if (afterSha !== row.source_sha256) fail('SOURCE_CHANGED', '源音频在提取期间被改变，本次结果已作废', { status: 409 });
    return artifact;
  }

  /**
   * 分离前的只读预检：已有伴奏就不再调用分离器，避免同名输出覆盖用户旧文件。
   * 判定规则由入库器提供，队列不复制一套曲库逻辑。
   */
  function precheckExistingAccompaniment(row) {
    if (!importer || typeof importer.findExisting !== 'function') return null;
    let existing = null;
    try {
      existing = importer.findExisting({ songId: row.song_id, sourceSha256: row.source_sha256 });
    } catch (error) {
      logger?.warn?.(`vocal-import precheck failed for ${row.id}: ${error?.message ?? error}`);
      return null;
    }
    return existing?.accompanimentClipId ? existing : null;
  }

  /**
   * 同一工件的重试：保留已有音轨，直接幂等收尾，不重新提取。
   * 只有原唱轨也已存在时才可宣称双轨完成；历史“只有旧伴奏”的曲目必须继续走
   * 正常入库补原唱，否则界面会显示 DUAL_TRACK 但曲库没有原唱。
   */
  function alreadyImportedSameArtifact(row, existing) {
    if (!existing?.originalClipId) return false;
    const artifactSha = parseJson(row.artifacts_json, {}).accompaniment?.sha256 ?? null;
    if (!artifactSha) return false;
    const clip = db.prepare('SELECT sha256 FROM performance_clips WHERE id=?').get(existing.accompanimentClipId);
    return Boolean(clip?.sha256) && clip.sha256 === artifactSha;
  }

  /** 本次工件与曲库现有伴奏是否同一内容（内容相同就不再报冲突，继续补原唱）。 */
  function sameAccompanimentArtifact(row, existing) {
    if (!existing?.accompanimentClipId) return false;
    const artifactSha = parseJson(row.artifacts_json, {}).accompaniment?.sha256 ?? null;
    if (!artifactSha) return false;
    const clip = db.prepare('SELECT sha256 FROM performance_clips WHERE id=?').get(existing.accompanimentClipId);
    return Boolean(clip?.sha256) && clip.sha256 === artifactSha;
  }

  function markImportConflict(jobRow, detail = {}, claim = null) {
    const issues = parseJson(jobRow.issues_json, []);
    if (!issues.includes(ACCOMPANIMENT_CONFLICT_ISSUE)) issues.push(ACCOMPANIMENT_CONFLICT_ISSUE);
    const conflict = {
      code: 'ACCOMPANIMENT_CONFLICT',
      repertoireId: detail.repertoireId ?? null,
      existingAccompanimentClipId: detail.existingAccompanimentClipId ?? null,
      incomingAccompanimentClipId: detail.incomingAccompanimentClipId ?? null,
      incomingAccompanimentRelPath: detail.incomingAccompanimentRelPath ?? null,
      incomingSha256: detail.incomingSha256 ?? null,
      options: ['keep-existing', 'use-new'],
    };
    return withTransaction(db, () => {
      const fields = {
        status: 'NEEDS_REVIEW',
        stage: 'IMPORT',
        issuesJson: JSON.stringify(issues),
        conflictJson: JSON.stringify(conflict),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: 'ACCOMPANIMENT_CONFLICT',
        lastErrorMessage: '已有伴奏轨，已保留未替换；请明确选择保留旧伴奏或使用新伴奏',
        finishedAt: new Date().toISOString(),
      };
      const updated = claim
        ? updateClaimedJob(jobRow.id, fields, claim, ['PENDING_EXTRACT', 'EXTRACTING', 'VERIFYING', 'READY_TO_IMPORT', 'NEEDS_REVIEW'])
        : updateJob(db, jobRow.id, fields);
      appendEvent(db, jobRow.id, {
        event: 'needs-review',
        stage: 'IMPORT',
        status: 'NEEDS_REVIEW',
        detail: { reason: 'ACCOMPANIMENT_CONFLICT', ...conflict },
      });
      return updated;
    });
  }

  /**
   * 用户自带伴奏被校验拒绝：不消耗提取重试次数，退回人工核对，
   * 让用户可以重新选择伴奏，而不是把坏文件登记成音轨或反复重试同一份坏文件。
   */
  function markSuppliedAccompanimentInvalid(jobRow, { code, message }, claim = null) {
    const issues = parseJson(jobRow.issues_json, []);
    if (!issues.includes('multiple-accompaniment-candidates')) issues.push('multiple-accompaniment-candidates');
    return withTransaction(db, () => {
      const fields = {
        status: 'NEEDS_REVIEW',
        stage: 'MATCH',
        suppliedAccompanimentRelPath: null,
        issuesJson: JSON.stringify(issues),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: code,
        lastErrorMessage: String(message).slice(0, 500),
        finishedAt: new Date().toISOString(),
      };
      const updated = claim
        ? updateClaimedJob(jobRow.id, fields, claim, ['PENDING_EXTRACT', 'EXTRACTING', 'VERIFYING', 'READY_TO_IMPORT'])
        : updateJob(db, jobRow.id, fields);
      appendEvent(db, jobRow.id, {
        event: 'supplied-accompaniment-invalid',
        stage: 'MATCH',
        status: 'NEEDS_REVIEW',
        detail: { code },
      });
      return updated;
    });
  }

  function withoutIssue(issues, issue) {
    return issues.filter(item => item !== issue);
  }

  function clearedConflictFields(jobRow) {
    return {
      conflictJson: '{}',
      issuesJson: JSON.stringify(withoutIssue(parseJson(jobRow.issues_json, []), ACCOMPANIMENT_CONFLICT_ISSUE)),
    };
  }

  function markCancelled(jobId, stage = 'VERIFY', claim = null) {
    return withTransaction(db, () => {
      const fields = {
        status: 'CANCELLED',
        cancelRequested: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: new Date().toISOString(),
      };
      const updated = claim
        ? updateClaimedJob(jobId, fields, claim, ['PENDING_EXTRACT', 'EXTRACTING', 'VERIFYING', 'READY_TO_IMPORT'])
        : updateJob(db, jobId, fields);
      appendEvent(db, jobId, { event: 'cancelled', stage, status: 'CANCELLED' });
      return updated;
    });
  }

  function stopIfCancelRequested(jobId, stage = 'VERIFY', claim = null) {
    if (!requireJobRow(db, jobId).cancel_requested) return false;
    markCancelled(jobId, stage, claim);
    return true;
  }

  function markImportedDualTrack(jobRow, detail = {}, claim = null) {
    return withTransaction(db, () => {
      const fields = {
        status: 'IMPORTED',
        stage: 'IMPORT',
        importMode: 'DUAL_TRACK',
        ...clearedConflictFields(jobRow),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        finishedAt: new Date().toISOString(),
      };
      const updated = claim
        ? updateClaimedJob(jobRow.id, fields, claim, ['EXTRACTING', 'VERIFYING', 'READY_TO_IMPORT'])
        : updateJob(db, jobRow.id, fields);
      appendEvent(db, jobRow.id, {
        event: 'imported',
        stage: 'IMPORT',
        status: 'IMPORTED',
        detail,
      });
      return updated;
    });
  }

  function markImportedIdempotent(jobRow, detail = {}, claim = null) {
    return markImportedDualTrack(jobRow, { idempotent: true, ...detail }, claim);
  }

  const queue = {
    /**
     * 扫描并入队；返回本次扫描摘要与新增/复用数量。
     * 网络层只能传 rootId + 相对子目录，绝对路径在策略层已被拒绝。
     */
    async enqueueScan({ rootId, subPath = '', scanOptions = {} } = {}) {
      const scan = await scanSource({ policy, rootId, subPath, options: scanOptions });
      const created = [];
      const reused = [];
      for (const song of scan.songs) {
        const idempotencyKey = `${scan.rootId}:${song.songId}`;
        const needsExtraction = !song.suppliedAccompaniment;
        const status = song.status === 'needs-review' ? 'NEEDS_REVIEW' : needsExtraction ? 'PENDING_EXTRACT' : 'READY_TO_IMPORT';
        const stage = song.status === 'needs-review' ? 'MATCH' : needsExtraction ? 'EXTRACT' : 'VERIFY';
        const base = {
          songId: song.songId,
          rootId: scan.rootId,
          sourceRelPath: song.original,
          sourceSha256: song.originalHash,
          sourceSizeBytes: song.originalSizeBytes ?? null,
          sourceDurationMs: song.durationMs ?? null,
          lyricsRelPath: song.lyrics,
          lyricsSha256: song.lyricsSha256 ?? null,
          lyricsTimedLines: song.timedLyricsCount ?? 0,
          suppliedAccompanimentRelPath: song.suppliedAccompaniment,
          title: song.title,
          artist: song.artist,
          language: song.language ?? null,
          status,
          stage,
          issues: song.issues,
          maxAttempts,
          scan: {
            versions: song.versions,
            probeState: song.probeState,
            pcmFingerprint: song.pcmFingerprint,
            lyricsCandidates: song.lyricsCandidates ?? [],
            lyricsProposal: song.lyricsProposal ?? null,
            // 重复候选只存进既有 scan_json，不新增列/表，不改入库数据结构。
            lyricsRepeatCandidates: song.lyricsRepeatCandidates ?? [],
            lyricsRepeatStatus: song.lyricsRepeatStatus ?? 'unknown',
            issues: song.issues,
          },
          idempotencyKey,
        };
        const result = insertJob(db, base);
        if (result.created) {
          created.push(result.row.id);
          continue;
        }
        const row = result.row;
        // 正在提取/校验/已入库的任务不被重扫打断，避免与后台工作器抢同一份状态。
        // 入库阶段的待核对＝已有伴奏冲突：重扫不得把它变回待提取而反复分离。
        const importConflictReview = row.status === 'NEEDS_REVIEW' && row.stage === 'IMPORT';
        if (['IMPORTED', 'EXTRACTING', 'VERIFYING'].includes(row.status) || importConflictReview) {
          reused.push(row.id);
          continue;
        }
        // 取消/失败是用户决定或待处理结论；已提取待入库同样不得被重扫降级后重新分离。
        // READY_TO_IMPORT 只有“已有工件、走 IMPORT 阶段”或“本次重扫仍有自带伴奏”才可保留；
        // 若自带伴奏已消失/变歧义，继续保留会使其永远不满足领取条件，必须回退到可领取状态。
        const manual = parseJson(row.manual_review_json, {});
        const previousScan = parseJson(row.scan_json, {});
        // 人工核对结果优先：重扫只刷新未被人工覆盖的匹配字段，避免把用户选的歌词/伴奏冲掉。
        const sameSource = !row.source_sha256 || row.source_sha256 === song.originalHash;
        const lyricsFields = manual.lyrics
          ? {
              lyricsRelPath: row.lyrics_rel_path,
              lyricsSha256: row.lyrics_sha256,
              lyricsTimedLines: row.lyrics_timed_lines,
            }
          : {
              lyricsRelPath: song.lyrics,
              lyricsSha256: song.lyricsSha256 ?? null,
              lyricsTimedLines: song.timedLyricsCount ?? 0,
            };
        const suppliedPath = manual.suppliedAccompaniment
          ? row.supplied_accompaniment_rel_path
          : song.suppliedAccompaniment;
        const sourceFields = sameSource
          ? {
              sourceRelPath: song.original,
              sourceSha256: song.originalHash,
              sourceSizeBytes: song.originalSizeBytes ?? null,
              sourceDurationMs: song.durationMs ?? null,
            }
          : {};
        const lyricsReviewIssues = ['multiple-lyrics-candidates', 'lyrics-needs-confirmation', 'missing-lyrics'];
        const nextIssues = song.issues.filter(issue => {
          if (manual.lyrics && lyricsReviewIssues.includes(issue)) return false;
          if (manual.suppliedAccompaniment && issue === 'multiple-accompaniment-candidates') return false;
          return true;
        });
        const hasSupplied = Boolean(suppliedPath);
        const keepStage =
          ['CANCELLED', 'FAILED'].includes(row.status) ||
          (row.status === 'READY_TO_IMPORT' && (row.stage === 'IMPORT' || hasSupplied));
        const stillNeedsReview = needsReview(nextIssues);
        const nextStatus = stillNeedsReview ? 'NEEDS_REVIEW' : hasSupplied ? 'READY_TO_IMPORT' : 'PENDING_EXTRACT';
        const nextStage = stillNeedsReview ? 'MATCH' : hasSupplied ? 'VERIFY' : 'EXTRACT';
        // 手工选过歌词时，重复候选必须跟着那份 LRC，不能被本次扫描的另一份歌词覆盖。
        const nextScan = manual.lyrics
          ? {
              ...base.scan,
              lyricsRepeatCandidates: previousScan.lyricsRepeatCandidates ?? [],
              lyricsRepeatStatus: previousScan.lyricsRepeatStatus ?? 'unknown',
            }
          : base.scan;
        withTransaction(db, () => {
          // 状态在读行后可能已被 worker 领取；条件更新失败就放弃本次重扫写入，
          // 不能把 VERIFYING/EXTRACTING 覆盖回扫描时的旧状态。
          const updated = updateJobIf(db, row.id, {
            ...sourceFields,
            ...lyricsFields,
            suppliedAccompanimentRelPath: suppliedPath,
            title: manual.title ? row.title : song.title,
            artist: manual.artist ? row.artist : song.artist,
            language: song.language ?? null,
            ...(keepStage ? {} : { status: nextStatus, stage: nextStage }),
            issuesJson: JSON.stringify(nextIssues),
            scanJson: JSON.stringify(nextScan),
          }, { statuses: [row.status] });
          if (updated) {
            appendEvent(db, row.id, {
              event: 'rescanned',
              stage: keepStage ? row.stage : nextStage,
              status: keepStage ? row.status : nextStatus,
              detail: {
                issues: nextIssues,
                preservedStatus: keepStage ? row.status : null,
                manualReview: Object.keys(manual).length ? manual : undefined,
              },
            });
          }
        });
        reused.push(row.id);
      }
      return {
        scan: {
          schema: scan.schema,
          rootId: scan.rootId,
          relSubPath: scan.relSubPath,
          scannedAt: scan.scannedAt,
          summary: scan.summary,
          songs: scan.songs.map(song => ({
            songId: song.songId,
            title: song.title,
            artist: song.artist,
            language: song.language,
            versions: song.versions,
            status: song.status,
            issues: song.issues,
            original: song.original,
            lyrics: song.lyrics,
            lyricsProposal: song.lyricsProposal,
            suppliedAccompaniment: song.suppliedAccompaniment,
          })),
          duplicateFiles: scan.duplicateFiles,
          duplicateLyrics: scan.duplicateLyrics,
          unpairedLrc: scan.unpairedLrc,
          orphanAccompaniments: scan.orphanAccompaniments,
        },
        created,
        reused,
        jobs: [...created, ...reused].map(id => toPublicJob(getJobRow(db, id))),
      };
    },

    getJob(id, { events = 50 } = {}) {
      const row = getJobRow(db, id);
      if (!row) return null;
      return {
        ...toPublicJob(row, { events: listEvents(db, row.id, events) }),
        artifactRows: listArtifacts(db, row.id).map(artifact => ({
          kind: artifact.kind,
          relPath: artifact.rel_path,
          sha256: artifact.sha256,
          sizeBytes: artifact.size_bytes,
          durationMs: artifact.duration_ms,
          version: artifact.version,
          state: artifact.state,
          qualityState: artifact.quality_state,
        })),
      };
    },

    listJobs(params = {}) {
      return listJobRows(db, params).map(row => toPublicJob(row));
    },

    /** 原子领取：待提取，或租约已过期的校验中任务。 */
    claimNext({ owner = workerId, includeExtraction = true } = {}) {
      return withTransaction(db, () => {
        for (;;) {
          const timestamp = now();
          const conditions = [];
          const params = [];
          if (includeExtraction) {
            // 运行中也可能遇到进程被杀留下的过期提取租约；不能只在启动 recover() 时处理。
            conditions.push("status='PENDING_EXTRACT'");
            conditions.push("(status='EXTRACTING' AND (lease_expires_at IS NULL OR lease_expires_at<=?))");
            params.push(timestamp);
          }
          conditions.push("(status='VERIFYING' AND (lease_expires_at IS NULL OR lease_expires_at<=?))");
          params.push(timestamp);
          const readyToImport = ["(stage='VERIFY' AND supplied_accompaniment_rel_path IS NOT NULL)"];
          // 已提取但当时没有注入 importer 的任务，新进程注入后只补跑校验/入库，不重新提取。
          if (importer) readyToImport.push("stage='IMPORT'");
          conditions.push(`(status='READY_TO_IMPORT' AND (${readyToImport.join(' OR ')}))`);
          const row = db
            .prepare(
              `SELECT * FROM vocal_import_jobs
               WHERE ${conditions.join(' OR ')}
               ORDER BY created_at ASC,id ASC LIMIT 1`,
            )
            .get(...params);
          if (!row) return null;
          if (row.cancel_requested) {
            const cancelled = updateJobIf(
              db,
              row.id,
              { status: 'CANCELLED', leaseOwner: null, leaseExpiresAt: null, finishedAt: new Date().toISOString() },
              { statuses: [row.status], leaseOwner: row.lease_owner ?? null, leaseExpiresAt: row.lease_expires_at ?? null },
            );
            if (!cancelled) continue;
            appendEvent(db, row.id, { event: 'cancelled', stage: row.stage, status: 'CANCELLED' });
            continue;
          }
          const staleLease =
            (row.status === 'EXTRACTING' || row.status === 'VERIFYING') &&
            row.lease_expires_at !== null &&
            row.lease_expires_at <= timestamp;
          if (staleLease) {
            appendEvent(db, row.id, {
              event: 'recovered',
              stage: row.stage,
              status: row.status,
              detail: { from: row.status, reason: 'expired-lease-runtime' },
            });
          }
          const verifying = row.status === 'VERIFYING' || row.status === 'READY_TO_IMPORT';
          const claimed = updateJobIf(
            db,
            row.id,
            {
              status: verifying ? 'VERIFYING' : 'EXTRACTING',
              stage: verifying ? 'VERIFY' : 'EXTRACT',
              leaseOwner: newLeaseOwner(owner),
              leaseExpiresAt: timestamp + leaseMs,
              startedAt: row.started_at ?? new Date().toISOString(),
            },
            { statuses: [row.status], leaseOwner: row.lease_owner ?? null, leaseExpiresAt: row.lease_expires_at ?? null },
          );
          if (!claimed) continue;
          appendEvent(db, row.id, {
            event: verifying ? 'verify-claimed' : 'claimed',
            stage: verifying ? 'VERIFY' : 'EXTRACT',
            status: claimed.status,
            detail: { owner, attempt: row.attempts + 1, resumedFrom: verifying ? row.status : undefined },
          });
          return claimed;
        }
      });
    },

    /**
     * 提取完成：先做严格校验，再登记伴奏工件并进入校验阶段。
     * 校验失败时一个字段都不写，避免坏文件出现在工件表或 artifacts_json 里。
     */
    async completeExtraction(jobId, artifact = {}, claim = null) {
      const row = requireJobRow(db, jobId);
      if (claim) assertClaimHeld(row, claim, ['EXTRACTING']);
      else if (row.status !== 'EXTRACTING') fail('CONFLICT', `任务当前状态 ${row.status} 不能提交提取结果`);
      if (typeof artifact.relPath !== 'string' || !artifact.relPath) fail('BAD_REQUEST', '提取结果必须包含 relPath');
      const verifiedArtifact = await verifyIncomingArtifact(row, artifact, {
        filePath: artifactPath(artifact.relPath),
        relPath: artifact.relPath,
      });
      const artifacts = { ...parseJson(row.artifacts_json, {}), accompaniment: verifiedArtifact };
      return withTransaction(db, () => {
        // 校验期间可能已被新 worker 接管：先按租约条件确认，再写工件和状态。
        const updated = claim
          ? updateClaimedJob(jobId, {
              status: 'VERIFYING',
              stage: 'VERIFY',
              artifactsJson: JSON.stringify(artifacts),
              lastErrorCode: null,
              lastErrorMessage: null,
            }, claim, ['EXTRACTING'])
          : updateJob(db, jobId, {
              status: 'VERIFYING',
              stage: 'VERIFY',
              artifactsJson: JSON.stringify(artifacts),
              leaseOwner: null,
              leaseExpiresAt: null,
              lastErrorCode: null,
              lastErrorMessage: null,
            });
        upsertArtifact(db, jobId, { kind: 'accompaniment', version: 1, state: 'ready', ...verifiedArtifact });
        appendEvent(db, jobId, {
          event: 'extracted',
          stage: 'VERIFY',
          status: 'VERIFYING',
          detail: { relPath: verifiedArtifact.relPath },
        });
        return updated;
      });
    },

    /**
     * 校验已登记工件：存在、非空、SHA 一致，并重新执行真实解码 + 时长容差校验，
     * 防止“登记后被替换/写坏”的文件直接进入曲库。
     */
    async verifyArtifacts(jobId, claim = null) {
      const row = requireJobRow(db, jobId);
      if (claim) assertClaimHeld(row, claim);
      const artifacts = parseJson(row.artifacts_json, {});
      const accompaniment = artifacts.accompaniment;
      if (!accompaniment?.relPath) fail('CONFLICT', '缺少伴奏工件，无法校验');
      const absolute = artifactPath(accompaniment.relPath);
      let stat;
      try {
        stat = statSync(absolute);
      } catch {
        fail('CONFLICT', '伴奏文件不存在');
      }
      if (!stat.isFile() || stat.size === 0) fail('CONFLICT', '伴奏文件为空或不是普通文件');
      const verified = await verifyIncomingArtifact(row, accompaniment, {
        filePath: absolute,
        relPath: accompaniment.relPath,
      });
      const nextAccompaniment = {
        ...accompaniment,
        sha256: verified.sha256,
        sizeBytes: verified.sizeBytes,
        durationMs: verified.durationMs,
      };
      const metadataChanged =
        accompaniment.sha256 !== nextAccompaniment.sha256 ||
        accompaniment.sizeBytes !== nextAccompaniment.sizeBytes ||
        accompaniment.durationMs !== nextAccompaniment.durationMs;
      const issues = parseJson(row.issues_json, []);
      if (row.source_duration_ms && verified.durationMs) {
        const delta = Math.abs(verified.durationMs - row.source_duration_ms);
        if (delta > Math.max(2000, row.source_duration_ms * 0.02) && !issues.includes('accompaniment-duration-mismatch')) {
          issues.push('accompaniment-duration-mismatch');
        }
      }
      return withTransaction(db, () => {
        const patch = {};
        if (issues.length !== parseJson(row.issues_json, []).length) patch.issuesJson = JSON.stringify(issues);
        if (metadataChanged) {
          patch.artifactsJson = JSON.stringify({ ...parseJson(row.artifacts_json, {}), accompaniment: nextAccompaniment });
        }
        if (claim) {
          updateClaimedJob(jobId, patch, claim, ['VERIFYING']);
        } else if (Object.keys(patch).length) {
          updateJob(db, jobId, patch);
        }
        appendEvent(db, jobId, {
          event: 'verified-artifacts',
          stage: 'VERIFY',
          status: 'VERIFYING',
          detail: { sizeBytes: verified.sizeBytes, durationMs: verified.durationMs },
        });
        return { sizeBytes: verified.sizeBytes, durationMs: verified.durationMs, issues };
      });
    },

    /** 校验通过：进入「待入库」。曲库写入必须由集成方显式注入 importer。 */
    markReadyToImport(jobId, claim = null) {
      const row = requireJobRow(db, jobId);
      if (claim) assertClaimHeld(row, claim, ['EXTRACTING', 'VERIFYING']);
      else if (!['EXTRACTING', 'VERIFYING'].includes(row.status)) fail('CONFLICT', `任务当前状态 ${row.status} 不能标记为待入库`);
      return withTransaction(db, () => {
        const fields = { status: 'READY_TO_IMPORT', stage: 'IMPORT', leaseOwner: null, leaseExpiresAt: null };
        const updated = claim
          ? updateClaimedJob(jobId, fields, claim, ['EXTRACTING', 'VERIFYING'])
          : updateJob(db, jobId, fields);
        appendEvent(db, jobId, { event: 'verified', stage: 'IMPORT', status: 'READY_TO_IMPORT' });
        return updated;
      });
    },

    /**
     * 单任务失败：可重试则累计 attempts；超过上限才 FAILED。
     * `retryStage='VERIFY'` 用于入库/校验阶段失败：保留已完成的提取结果，只重跑失败阶段。
     */
    fail(jobId, { code = 'EXTRACT_FAILED', message = '伴奏提取失败', retryable = true, retryStage = 'EXTRACT' } = {}, claim = null) {
      const row = requireJobRow(db, jobId);
      const attempts = row.attempts + 1;
      const exhausted = !retryable || attempts >= row.max_attempts;
      const preserveVerify = retryStage === 'VERIFY';
      return withTransaction(db, () => {
        const current = requireJobRow(db, jobId);
        // 过期 worker 的失败不得把已入库/已取消任务改回待处理，避免覆盖新 worker 的结果。
        if (['IMPORTED', 'CANCELLED'].includes(current.status)) {
          appendEvent(db, jobId, {
            event: 'stale-failure-ignored',
            stage: current.stage,
            status: current.status,
            detail: { code },
          });
          return current;
        }
        const fields = {
          attempts,
          status: exhausted ? 'FAILED' : preserveVerify ? 'VERIFYING' : 'PENDING_EXTRACT',
          stage: exhausted ? row.stage : preserveVerify ? 'VERIFY' : 'EXTRACT',
          lastErrorCode: code,
          lastErrorMessage: String(message).slice(0, 500),
          leaseOwner: null,
          leaseExpiresAt: exhausted ? null : preserveVerify ? now() + Math.min(leaseMs, 30000) : null,
          ...(exhausted ? { finishedAt: new Date().toISOString() } : {}),
        };
        const updated = claim
          ? updateJobIf(db, jobId, fields, {
              statuses: ['EXTRACTING', 'VERIFYING'],
              leaseOwner: claim.owner,
              leaseExpiresAt: claim.expiresAt,
            })
          : updateJob(db, jobId, fields);
        if (!updated) {
          // 已被新 worker 接管：失败写入必须是 no-op，只留事件，不得回写状态/attempts。
          appendEvent(db, jobId, {
            event: 'stale-failure-ignored',
            stage: current.stage,
            status: current.status,
            detail: { code },
          });
          return current;
        }
        appendEvent(db, jobId, {
          event: exhausted ? 'failed' : 'retry-scheduled',
          stage: row.stage,
          status: updated.status,
          detail: { code, attempts, maxAttempts: row.max_attempts, retryStage },
        });
        return updated;
      });
    },

    /** 配置缺失等“非任务错误”：退回待提取，不计入失败次数。 */
    release(jobId, { code = 'RELEASED', message = '' } = {}, claim = null) {
      const row = requireJobRow(db, jobId);
      return withTransaction(db, () => {
        const fields = {
          status: 'PENDING_EXTRACT',
          stage: 'EXTRACT',
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: code,
          lastErrorMessage: String(message).slice(0, 500),
        };
        const updated = claim
          ? updateJobIf(db, jobId, fields, {
              statuses: ['EXTRACTING', 'VERIFYING'],
              leaseOwner: claim.owner,
              leaseExpiresAt: claim.expiresAt,
            })
          : updateJob(db, jobId, fields);
        if (!updated) return requireJobRow(db, jobId);
        appendEvent(db, jobId, { event: 'released', stage: row.stage, status: 'PENDING_EXTRACT', detail: { code } });
        return updated;
      });
    },

    retry(jobId) {
      const row = requireJobRow(db, jobId);
      // 双轨已入库是终态：重试不得把整首任务退回提取，避免已有伴奏被重复生成。
      // 仅原唱兜底入库不是终态：库内只有原唱，重试仍从同一任务只补跑提取，完成后并入同一 songId。
      const originalOnlyImported = row.status === 'IMPORTED' && row.import_mode === 'ORIGINAL_ONLY';
      if (row.status === 'IMPORTED' && !originalOnlyImported) fail('CONFLICT', '任务已入库，不能重新提取');
      // 扫描阶段的待核对要先指定歌词/伴奏；入库阶段的冲突可直接重试，重试时仍会先预检旧伴奏。
      if (row.status === 'NEEDS_REVIEW' && row.stage !== 'IMPORT') fail('CONFLICT', '待核对任务请先指定歌词或伴奏，再重试');
      if (['PENDING_EXTRACT', 'EXTRACTING', 'VERIFYING'].includes(row.status)) fail('JOB_BUSY', '任务正在处理中');
      const conflictReview = row.status === 'NEEDS_REVIEW' && row.stage === 'IMPORT';
      // 自带伴奏的任务只需要重新校验/入库，不重新调用分离器。
      const hasSupplied = Boolean(row.supplied_accompaniment_rel_path) && !conflictReview && !originalOnlyImported;
      const nextStatus = hasSupplied ? 'READY_TO_IMPORT' : 'PENDING_EXTRACT';
      const nextStage = hasSupplied ? 'VERIFY' : 'EXTRACT';
      return withTransaction(db, () => {
        const updated = updateJobIf(db, jobId, {
          status: nextStatus,
          stage: nextStage,
          attempts: 0,
          cancelRequested: 0,
          ...clearedConflictFields(row),
          lastErrorCode: null,
          lastErrorMessage: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          finishedAt: null,
        }, { statuses: [row.status] });
        if (!updated) fail('JOB_BUSY', '任务状态已变化，请刷新后再试');
        appendEvent(db, jobId, {
          event: 'retried',
          stage: nextStage,
          status: nextStatus,
          detail: originalOnlyImported ? { importMode: 'ORIGINAL_ONLY', resume: 'extract-accompaniment' } : undefined,
        });
        return updated;
      });
    },

    cancel(jobId) {
      const row = requireJobRow(db, jobId);
      if (['IMPORTED', 'CANCELLED'].includes(row.status)) {
        return updateJob(db, jobId, { cancelRequested: 1 });
      }
      return withTransaction(db, () => {
        const running = ['EXTRACTING', 'VERIFYING'].includes(row.status);
        // 运行中只登记取消意图，不写 status：否则会把并发完成的新状态覆盖回运行中。
        // 非运行中才直接取消，且要求读取后状态没被别的 worker 改动。
        const updated = updateJobIf(
          db,
          jobId,
          running
            ? { cancelRequested: 1 }
            : {
                status: 'CANCELLED',
                cancelRequested: 1,
                finishedAt: new Date().toISOString(),
                leaseOwner: null,
                leaseExpiresAt: null,
              },
          { statuses: [row.status] },
        );
        if (!updated) return requireJobRow(db, jobId);
        appendEvent(db, jobId, {
          event: running ? 'cancel-requested' : 'cancelled',
          stage: row.stage,
          status: updated.status,
        });
        return updated;
      });
    },

    /**
     * 分离失败/未配置时的安全兜底：只把原唱 + LRC 入库，绝不把原唱冒充伴奏。
     * 只允许尚未产生伴奏工件的任务调用，避免丢弃已经提取好的伴奏。
     */
    async importOriginalOnly(jobId) {
      const row = requireJobRow(db, jobId);
      if (row.status === 'IMPORTED') return row;
      if (!['PENDING_EXTRACT', 'FAILED'].includes(row.status)) {
        fail('CONFLICT', `任务当前状态 ${row.status} 不能只入库原唱`);
      }
      if (parseJson(row.artifacts_json, {}).accompaniment) fail('CONFLICT', '已有伴奏工件，请先完成伴奏入库');
      if (row.cancel_requested) fail('CONFLICT', '任务已请求取消');
      if (!importer || typeof importer.importOriginalOnly !== 'function') fail('CONFLICT', '入库器不支持只入库原唱');
      // 保留原状态，仅登记本次调用的租约身份：worker 仍可在等待入库期间接管，
      // 但旧兜底写回时必须发现租约已易主而放弃覆盖。
      const claim = { owner: newLeaseOwner(workerId), expiresAt: now() + leaseMs };
      const acquired = updateJobIf(
        db,
        jobId,
        { leaseOwner: claim.owner, leaseExpiresAt: claim.expiresAt },
        { statuses: [row.status], leaseOwner: null },
      );
      if (!acquired) fail('JOB_BUSY', '任务正在被其它 worker 处理，请稍后重试');
      let result;
      try {
        result = await importer.importOriginalOnly({ job: toPublicJob(row) });
      } catch (error) {
        updateJobIf(
          db,
          jobId,
          { leaseOwner: null, leaseExpiresAt: null },
          { statuses: [row.status], leaseOwner: claim.owner, leaseExpiresAt: claim.expiresAt },
        );
        throw error;
      }
      return withTransaction(db, () => {
        const current = requireJobRow(db, jobId);
        // 等待入库期间新 worker 可能已接管/完成：旧兜底不得改状态或 import_mode。
        const updated = updateJobIf(db, jobId, {
          status: 'IMPORTED',
          stage: 'IMPORT',
          importMode: 'ORIGINAL_ONLY',
          ...clearedConflictFields(current),
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          finishedAt: new Date().toISOString(),
        }, { statuses: [row.status], leaseOwner: claim.owner, leaseExpiresAt: claim.expiresAt });
        if (!updated) {
          appendEvent(db, jobId, {
            event: 'stale-original-only-ignored',
            stage: current.stage,
            status: current.status,
            detail: { importMode: current.import_mode ?? null },
          });
          return current;
        }
        appendEvent(db, jobId, {
          event: 'imported',
          stage: 'IMPORT',
          status: 'IMPORTED',
          detail: { originalOnly: true, ...(result ?? {}) },
        });
        return updated;
      });
    },

    /**
     * 入库冲突的人工选择：
     * - keep-existing：保留曲库现有伴奏，只补原唱/歌词/语言；
     * - use-new：明确改用新伴奏，旧音轨只解绑不删除。若尚无新伴奏工件，则单独提取一份。
     */
    async resolveImportConflict(jobId, { choice } = {}) {
      if (!['keep-existing', 'use-new'].includes(choice)) fail('BAD_REQUEST', 'choice 必须是 keep-existing 或 use-new');
      if (!importer) fail('CONFLICT', '未配置曲库入库器');
      let row = requireJobRow(db, jobId);
      if (row.status === 'IMPORTED') return row;
      if (row.status !== 'NEEDS_REVIEW' || row.stage !== 'IMPORT') fail('CONFLICT', '任务不在入库冲突状态');

      // 人工处理也持有自己的不可复用租约：并发重复点击或 worker 接管时，旧调用不得写回。
      const claim = { owner: newLeaseOwner(workerId), expiresAt: now() + leaseMs };
      const acquired = updateJobIf(
        db,
        jobId,
        { leaseOwner: claim.owner, leaseExpiresAt: claim.expiresAt },
        { statuses: ['NEEDS_REVIEW'], leaseOwner: null },
      );
      if (!acquired) fail('JOB_BUSY', '任务正在被其它调用处理，请稍后重试');

      let artifact = parseJson(row.artifacts_json, {}).accompaniment ?? null;
      try {
        if (!artifact?.relPath && row.supplied_accompaniment_rel_path) {
          artifact = await ensureSuppliedArtifact(row, claim);
          row = requireJobRow(db, jobId);
          artifact = parseJson(row.artifacts_json, {}).accompaniment ?? artifact;
        }

        if (choice === 'use-new' && !artifact?.relPath) {
          const conflict = parseJson(row.conflict_json, {});
          const started = withTransaction(db, () => {
            const updated = updateClaimedJob(jobId, {
              status: 'EXTRACTING',
              stage: 'EXTRACT',
              lastErrorCode: null,
              lastErrorMessage: null,
            }, claim, ['NEEDS_REVIEW']);
            appendEvent(db, jobId, {
              event: 'replace-claimed',
              stage: 'EXTRACT',
              status: 'EXTRACTING',
              detail: { choice },
            });
            return updated;
          });
          try {
            const fresh = await extractFreshArtifact(started, { suffix: `replace-${claimOutputSuffix(claim)}` });
            if (requireJobRow(db, jobId).cancel_requested) {
              markCancelled(jobId, 'EXTRACT', claim);
              return requireJobRow(db, jobId);
            }
            await queue.completeExtraction(jobId, fresh, claim);
            await queue.verifyArtifacts(jobId, claim);
          } catch (error) {
            // 提取失败时恢复冲突现场：旧伴奏与已登记的工件都不丢，用户可重试或改选保留旧伴奏。
            withTransaction(db, () => {
              const restored = updateJobIf(db, jobId, {
                status: 'NEEDS_REVIEW',
                stage: 'IMPORT',
                conflictJson: JSON.stringify(conflict),
                leaseOwner: null,
                leaseExpiresAt: null,
                lastErrorCode: typeof error?.code === 'string' ? error.code : 'EXTRACT_FAILED',
                lastErrorMessage: String(error?.message ?? error).slice(0, 500),
                finishedAt: new Date().toISOString(),
              }, {
                statuses: ['NEEDS_REVIEW', 'EXTRACTING', 'VERIFYING'],
                leaseOwner: claim.owner,
                leaseExpiresAt: claim.expiresAt,
              });
              if (restored) {
                appendEvent(db, jobId, {
                  event: 'replace-failed',
                  stage: 'IMPORT',
                  status: 'NEEDS_REVIEW',
                  detail: { choice, code: error?.code ?? 'EXTRACT_FAILED' },
                });
              }
            });
            throw error;
          }
          row = requireJobRow(db, jobId);
          artifact = parseJson(row.artifacts_json, {}).accompaniment ?? null;
        } else if (choice === 'use-new') {
          // 已有新伴奏工件：先进入 VERIFYING，再做一次严格校验；整个过程仍受本次租约保护。
          withTransaction(db, () => {
            updateClaimedJob(jobId, { status: 'VERIFYING', stage: 'VERIFY' }, claim, ['NEEDS_REVIEW']);
          });
          await queue.verifyArtifacts(jobId, claim);
          row = requireJobRow(db, jobId);
          artifact = parseJson(row.artifacts_json, {}).accompaniment ?? artifact;
        }

        if (choice === 'use-new' && !artifact?.relPath) fail('CONFLICT', '缺少可用的新伴奏工件');

        const result = await importer({ job: toPublicJob(requireJobRow(db, jobId)), artifact }, { choice });
        if (result?.status === 'CONFLICT_ACCOMPANIMENT') {
          markImportConflict(requireJobRow(db, jobId), {
            repertoireId: result.repertoireId,
            existingAccompanimentClipId: result.existingAccompanimentClipId,
            incomingAccompanimentClipId: result.incomingAccompanimentClipId ?? null,
            incomingAccompanimentRelPath: artifact?.relPath ?? null,
            incomingSha256: artifact?.sha256 ?? null,
          }, claim);
          fail('CONFLICT', '新伴奏仍与现有伴奏冲突，请重新确认');
        }
        const current = requireJobRow(db, jobId);
        return withTransaction(db, () => {
          const updated = updateClaimedJob(jobId, {
            status: 'IMPORTED',
            stage: 'IMPORT',
            importMode: 'DUAL_TRACK',
            ...clearedConflictFields(current),
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            finishedAt: new Date().toISOString(),
          }, claim, ['NEEDS_REVIEW', 'VERIFYING']);
          appendEvent(db, jobId, {
            event: 'import-resolved',
            stage: 'IMPORT',
            status: 'IMPORTED',
            detail: { choice, ...(result ?? {}) },
          });
          return updated;
        });
      } catch (error) {
        // 失败时释放本次租约；若已进入提取/校验阶段则退回冲突现场，绝不覆盖新 worker 的状态。
        withTransaction(db, () => {
          const current = requireJobRow(db, jobId);
          if (!claimHeldBy(current, claim)) return;
          const fields = { leaseOwner: null, leaseExpiresAt: null };
          if (current.status !== 'NEEDS_REVIEW') {
            fields.status = 'NEEDS_REVIEW';
            fields.stage = 'IMPORT';
            fields.lastErrorCode = typeof error?.code === 'string' ? error.code : 'IMPORT_FAILED';
            fields.lastErrorMessage = String(error?.message ?? error).slice(0, 500);
            fields.finishedAt = new Date().toISOString();
          }
          updateJobIf(db, jobId, fields, {
            statuses: ['NEEDS_REVIEW', 'EXTRACTING', 'VERIFYING'],
            leaseOwner: claim.owner,
            leaseExpiresAt: claim.expiresAt,
          });
        });
        throw error;
      }
    },

    /** 人工消除歧义：歌词/伴奏必须来自本次扫描候选，且路径仍通过白名单校验。 */
    resolve(jobId, { lyricsRelPath, suppliedAccompanimentRelPath, title, artist } = {}) {
      const row = requireJobRow(db, jobId);
      if (row.status !== 'NEEDS_REVIEW') fail('CONFLICT', '只有待核对任务需要人工核对');
      if (row.stage === 'IMPORT') fail('CONFLICT', '入库冲突需在曲库中人工确认伴奏，不能用歌词候选消除');
      const scan = parseJson(row.scan_json, {});
      const issues = parseJson(row.issues_json, []);
      const manual = parseJson(row.manual_review_json, {});
      const patch = {};
      let outsideCandidates = false;
      if (title !== undefined) {
        if (typeof title !== 'string' || !title.trim() || title.trim().length > 200) fail('BAD_REQUEST', '歌名必须是 1-200 字');
        patch.title = title.trim();
        manual.title = true;
        // 用户已经指定以哪个歌名为准，标签冲突即视为已消解；不消解会让任务永远停在 NEEDS_REVIEW。
        const titleIssue = issues.indexOf('filename-id3-title-conflict');
        if (titleIssue >= 0) issues.splice(titleIssue, 1);
      }
      if (artist !== undefined) {
        if (typeof artist !== 'string' || artist.trim().length > 200) fail('BAD_REQUEST', '歌手名不能超过 200 字');
        patch.artist = artist.trim();
        manual.artist = true;
        const index = issues.indexOf('filename-id3-artist-conflict');
        if (index >= 0) issues.splice(index, 1);
      }
      if (lyricsRelPath !== undefined) {
        const candidates = [...(scan.lyricsCandidates ?? []), ...(scan.lyricsProposal ? [scan.lyricsProposal] : [])];
        const resolved = policy.resolveFile(row.root_id, lyricsRelPath);
        if (!isLyricsFile(resolved.relPath)) fail('BAD_REQUEST', '指定的歌词必须是 .lrc 文件');
        const doc = parseLrcFile(resolved.filePath);
        patch.lyricsRelPath = resolved.relPath;
        patch.lyricsSha256 = createHash('sha256').update(readFileSync(resolved.filePath)).digest('hex');
        patch.lyricsTimedLines = doc.timedLines.length;
        // 人工换歌词后，重复候选只能基于新选中的 LRC 文本/时间行重算；仍只是建议。
        const repeat = buildLyricRepeatSuggestions(doc.timedLines);
        scan.lyricsRepeatCandidates = repeat.candidates;
        scan.lyricsRepeatStatus = repeat.status;
        patch.scanJson = JSON.stringify(scan);
        manual.lyrics = true;
        // 允许用户从同一白名单目录里另选 LRC，但要把差异记进事件，便于追溯。
        outsideCandidates = !candidates.includes(resolved.relPath);
        for (const issue of ['multiple-lyrics-candidates', 'lyrics-needs-confirmation', 'missing-lyrics']) {
          const index = issues.indexOf(issue);
          if (index >= 0) issues.splice(index, 1);
        }
      }
      if (suppliedAccompanimentRelPath !== undefined) {
        const resolved = policy.resolveFile(row.root_id, suppliedAccompanimentRelPath);
        patch.suppliedAccompanimentRelPath = resolved.relPath;
        manual.suppliedAccompaniment = true;
        const index = issues.indexOf('multiple-accompaniment-candidates');
        if (index >= 0) issues.splice(index, 1);
      }
      if (!Object.keys(patch).length) fail('BAD_REQUEST', '没有可应用的核对结果');
      patch.manualReviewJson = JSON.stringify(manual);
      const stillNeedsReview = needsReview(issues);
      const hasAccompaniment = Boolean(patch.suppliedAccompanimentRelPath ?? row.supplied_accompaniment_rel_path);
      const status = stillNeedsReview ? 'NEEDS_REVIEW' : hasAccompaniment ? 'READY_TO_IMPORT' : 'PENDING_EXTRACT';
      const stage = stillNeedsReview ? 'MATCH' : hasAccompaniment ? 'VERIFY' : 'EXTRACT';
      return withTransaction(db, () => {
        const updated = updateJobIf(
          db,
          jobId,
          { ...patch, issuesJson: JSON.stringify(issues), status, stage },
          { statuses: ['NEEDS_REVIEW'] },
        );
        if (!updated) fail('JOB_BUSY', '任务状态已变化，请刷新后再试');
        appendEvent(db, jobId, {
          event: 'resolved',
          stage,
          status,
          detail: { ...patch, outsideCandidates: outsideCandidates || undefined },
        });
        return updated;
      });
    },

    /** 启动恢复：租约过期任务退回可领取状态，不重复计失败，也不重算已完成阶段。 */
    recover() {
      const stale = db
        .prepare(
          `SELECT * FROM vocal_import_jobs
           WHERE status IN('EXTRACTING','VERIFYING') AND (lease_expires_at IS NULL OR lease_expires_at<=?)`,
        )
        .all(now());
      return withTransaction(db, () => {
        for (const row of stale) {
          const guard = {
            statuses: [row.status],
            leaseOwner: row.lease_owner ?? null,
            leaseExpiresAt: row.lease_expires_at ?? null,
          };
          if (row.cancel_requested) {
            const updated = updateJobIf(
              db,
              row.id,
              { status: 'CANCELLED', leaseOwner: null, leaseExpiresAt: null, finishedAt: new Date().toISOString() },
              guard,
            );
            if (updated) appendEvent(db, row.id, { event: 'cancelled', stage: row.stage, status: 'CANCELLED', detail: { reason: 'recover' } });
            continue;
          }
          const status = row.status === 'VERIFYING' ? 'VERIFYING' : 'PENDING_EXTRACT';
          const updated = updateJobIf(db, row.id, { status, leaseOwner: null, leaseExpiresAt: null }, guard);
          if (updated) appendEvent(db, row.id, { event: 'recovered', stage: row.stage, status, detail: { from: row.status } });
        }
        return stale.length;
      });
    },

    /** 处理一个任务；业务失败只记在任务上，不抛给调用方，保证同批其它任务继续。 */
    async runOnce({ owner = workerId, includeExtraction = true } = {}) {
      const claimed = queue.claimNext({ owner, includeExtraction });
      if (!claimed) return { processed: false, reason: 'EMPTY' };
      const jobId = claimed.id;
      // 本次领取的不可复用身份：后续所有写回都必须同时匹配 owner+expiry。
      const claim = { owner: claimed.lease_owner, expiresAt: claimed.lease_expires_at };
      const claimedStatus = claimed.status;
      try {
        // 用户自带伴奏先落到受控目录，后续校验/入库与 AI 提取产物走同一条安全路径。
        let job = claimed;
        if (job.supplied_accompaniment_rel_path) {
          await ensureSuppliedArtifact(job, claim);
          job = requireJobRow(db, jobId);
        }
        // 分离前预检：已有伴奏一律不覆盖；同一工件重试则幂等收尾，不重新分离。
        const existing = precheckExistingAccompaniment(job);
        if (existing) {
          const latest = requireJobRow(db, jobId);
          if (alreadyImportedSameArtifact(latest, existing)) {
            markImportedIdempotent(latest, {
              repertoireId: existing.repertoireId,
              accompanimentClipId: existing.accompanimentClipId,
            }, claim);
            return { processed: true, jobId, status: 'IMPORTED' };
          }
          // 内容相同但历史曲目缺原唱：继续走正常校验/入库补原唱，不谎报 DUAL_TRACK。
          if (!sameAccompanimentArtifact(latest, existing)) {
            const incoming = parseJson(latest.artifacts_json, {}).accompaniment ?? null;
            markImportConflict(latest, {
              repertoireId: existing.repertoireId,
              existingAccompanimentClipId: existing.accompanimentClipId,
              incomingAccompanimentRelPath: incoming?.relPath ?? null,
              incomingSha256: incoming?.sha256 ?? null,
            }, claim);
            return { processed: true, jobId, status: 'NEEDS_REVIEW', reason: 'ACCOMPANIMENT_CONFLICT' };
          }
        }
        if (job.status === 'VERIFYING') {
          // 进程在“提取完成→入库”之间重启，或自带伴奏：工件已经存在，只补跑校验与入库，不重新提取。
          await queue.verifyArtifacts(jobId, claim);
          if (stopIfCancelRequested(jobId, 'VERIFY', claim)) return { processed: false, reason: 'CANCELLED', jobId };
          if (importer) {
            const verified = requireJobRow(db, jobId);
            const artifact = parseJson(verified.artifacts_json, {}).accompaniment ?? null;
            const importResult = await importer({ job: toPublicJob(verified), artifact });
            if (importResult?.status === 'CONFLICT_ACCOMPANIMENT') {
              markImportConflict(requireJobRow(db, jobId), {
                repertoireId: importResult.repertoireId,
                existingAccompanimentClipId: importResult.existingAccompanimentClipId,
                incomingAccompanimentClipId: importResult.incomingAccompanimentClipId ?? null,
                incomingAccompanimentRelPath: artifact?.relPath ?? null,
                incomingSha256: artifact?.sha256 ?? null,
              }, claim);
              return { processed: true, jobId, status: 'NEEDS_REVIEW', reason: 'ACCOMPANIMENT_CONFLICT' };
            }
            markImportedDualTrack(verified, { resumed: true, ...(importResult ?? {}) }, claim);
            return { processed: true, jobId, status: 'IMPORTED' };
          }
          queue.markReadyToImport(jobId, claim);
          return { processed: true, jobId, status: 'READY_TO_IMPORT' };
        }
        if (!extractor || !includeExtraction) {
          queue.release(jobId, { code: 'EXTRACTOR_NOT_CONFIGURED', message: '本机尚未配置本地伴奏提取器（audio-separator / MLX）' }, claim);
          return { processed: false, reason: 'EXTRACTOR_NOT_CONFIGURED', jobId };
        }
        const source = policy.resolveFile(job.root_id, job.source_rel_path);
        // AC09：扫描后源文件若被改动/替换，提取结果就不能再代表该 songId，必须先让用户重扫。
        const sourceSha = await hashFile(source.filePath).catch(() => null);
        if (sourceSha !== job.source_sha256) {
          queue.fail(jobId, {
            code: 'SOURCE_CHANGED',
            message: '源音频在扫描后已改变，请重新扫描后再提取',
            retryable: false,
          }, claim);
          return { processed: false, reason: 'SOURCE_CHANGED', jobId };
        }
        const lyrics = job.lyrics_rel_path ? policy.resolveFile(job.root_id, job.lyrics_rel_path) : null;
        // 每次领取使用独立输出目录：旧 worker 晚到的产物不会覆盖新 worker 的文件。
        const outputDir = jobOutputRoot ? join(jobOutputRoot, job.song_id, 'runs', claimOutputSuffix(claim)) : null;
        if (outputDir) mkdirSync(outputDir, { recursive: true });
        const artifact = await extractor({
          job: toPublicJob(job),
          sourceFile: source.filePath,
          lyricsFile: lyrics?.filePath ?? null,
          outputDir,
        });
        const latest = requireJobRow(db, jobId);
        if (latest.cancel_requested) {
          markCancelled(jobId, 'EXTRACT', claim);
          return { processed: false, reason: 'CANCELLED', jobId };
        }
        // 提取期间源文件被换掉，同样作废本次结果，避免“同名不同歌”的伴奏被登记进来。
        const afterSha = await hashFile(source.filePath).catch(() => null);
        if (afterSha !== job.source_sha256) {
          queue.fail(jobId, {
            code: 'SOURCE_CHANGED',
            message: '源音频在提取期间被改变，本次结果已作废',
            retryable: false,
          }, claim);
          return { processed: false, reason: 'SOURCE_CHANGED', jobId };
        }
        await queue.completeExtraction(jobId, artifact, claim);
        await queue.verifyArtifacts(jobId, claim);
        if (stopIfCancelRequested(jobId, 'VERIFY', claim)) return { processed: false, reason: 'CANCELLED', jobId };
        if (importer) {
          const verified = requireJobRow(db, jobId);
          const importResult = await importer({ job: toPublicJob(verified), artifact });
          if (importResult?.status === 'CONFLICT_ACCOMPANIMENT') {
            markImportConflict(requireJobRow(db, jobId), {
              repertoireId: importResult.repertoireId,
              existingAccompanimentClipId: importResult.existingAccompanimentClipId,
              incomingAccompanimentClipId: importResult.incomingAccompanimentClipId ?? null,
              incomingAccompanimentRelPath: artifact?.relPath ?? null,
              incomingSha256: artifact?.sha256 ?? null,
            }, claim);
            return { processed: true, jobId, status: 'NEEDS_REVIEW', reason: 'ACCOMPANIMENT_CONFLICT' };
          }
          markImportedDualTrack(verified, importResult ?? {}, claim);
          return { processed: true, jobId, status: 'IMPORTED' };
        }
        queue.markReadyToImport(jobId, claim);
        return { processed: true, jobId, status: 'READY_TO_IMPORT' };
      } catch (error) {
        const code = typeof error?.code === 'string' && error.code ? error.code : 'EXTRACT_FAILED';
        // 旧 worker 迟到：租约已易主，整轮结果丢弃，绝不覆盖新 worker 的工件/状态/文件。
        if (code === 'STALE_CLAIM') {
          logger?.warn?.(`vocal-import ${jobId} stale claim ignored`);
          return { processed: false, reason: 'STALE_CLAIM', jobId };
        }
        // 配置缺失（未安装分离器 / 模型不可用）不是任务失败：退回待提取，不消耗重试次数。
        if (code === 'EXTRACTOR_NOT_CONFIGURED' || code === 'SEPARATOR_NOT_CONFIGURED') {
          queue.release(jobId, { code, message: error?.message ?? '本机伴奏提取器未配置' }, claim);
          return { processed: false, reason: code, jobId };
        }
        // 用户自带伴奏被拒绝：退回人工核对，允许重新选择；绝不写工件或音轨。
        const latestRow = requireJobRow(db, jobId);
        if (SUPPLIED_REJECTED_CODES.has(code) && latestRow.supplied_accompaniment_rel_path && claimHeldBy(latestRow, claim)) {
          markSuppliedAccompanimentInvalid(latestRow, { code, message: error?.message ?? '伴奏校验未通过' }, claim);
          logger?.warn?.(`vocal-import ${jobId} supplied accompaniment rejected: ${code}`);
          return { processed: false, reason: code, jobId };
        }
        queue.fail(jobId, {
          code,
          message: error?.message ?? '伴奏提取失败',
          // 伴奏本身不合格时重试同一份文件不会变好，直接失败并保留可人工重试的入口。
          retryable: error?.retryable !== false && code !== 'SOURCE_CHANGED' && !ACCOMPANIMENT_REJECTED_CODES.has(code),
          retryStage: claimedStatus === 'VERIFYING' || claimedStatus === 'READY_TO_IMPORT' ? 'VERIFY' : 'EXTRACT',
        }, claim);
        logger?.error?.(`vocal-import ${jobId} ${code}: ${error?.message ?? error}`);
        return { processed: false, reason: code, jobId };
      }
    },

    /** 后台循环：单任务串行（M4 内存峰值未实测前不并发跑模型），逐项失败不中断。 */
    startWorker({ intervalMs = 1000, owner = workerId } = {}) {
      let stopped = false;
      let running = false;
      // 提取器不可用不应拖住其它任务：只跳过需要分离的待提取任务，
      // 自带伴奏/已提取待入库的任务仍然继续处理。
      let extractorBlocked = false;
      const tick = async () => {
        if (stopped || running) return;
        running = true;
        try {
          const result = await queue.runOnce({ owner, includeExtraction: !extractorBlocked });
          if (result.reason === 'EXTRACTOR_NOT_CONFIGURED' || result.reason === 'SEPARATOR_NOT_CONFIGURED') {
            if (!extractorBlocked) logger?.warn?.('vocal-import: 本机提取器未配置，先继续处理自带伴奏/待入库任务');
            extractorBlocked = true;
          }
        } catch (error) {
          // 任何未预期异常都只记录：后台循环不能因为一首歌或一次写库失败而整批停摆。
          logger?.error?.(`vocal-import worker: ${error?.message ?? error}`);
        } finally {
          running = false;
        }
      };
      const timer = setInterval(tick, intervalMs);
      timer.unref?.();
      return {
        stop() {
          stopped = true;
          clearInterval(timer);
        },
        tick,
      };
    },
  };

  return queue;
}

/** 便捷入口：迁移校验 + 启动恢复一次。 */
export function openVocalImportQueue(options) {
  assertVocalImportSchema(options.db);
  const queue = createVocalImportQueue(options);
  const recovered = queue.recover();
  return { queue, recovered };
}
