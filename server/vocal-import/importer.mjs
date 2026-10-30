import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { bumpCatalog } from '../catalog.mjs';
import { createAccompanimentVerifier } from './accompaniment-verify.mjs';
import { fail } from './errors.mjs';
import { parseLrcFile } from './lrc.mjs';
import { buildSections } from './sections.mjs';
import { withTransaction } from './store.mjs';
import { uuid5, VOCAL_IMPORT_NAMESPACE } from './uuid5.mjs';

/**
 * 队列 → 既有曲库的入库适配器。
 *
 * 约束：
 * - 只引用既有 `source_media` / `performance_clips` / `repertoire_items`，不新建第二套曲库；
 * - 同一 songId 只对应一条 VOCAL 曲目，原唱与伴奏各一轨；
 * - 全程一个事务；重复调用幂等，不复制曲目、不覆盖人工歌词与结构；
 * - 源文件只读：只在受控 mediaRoot 生成独立副本，源目录一个字节都不改；
 * - 旧音轨行只解绑不删除，避免误删仍在播放/缓存的媒体。
 */
const CODEC_BY_EXT = Object.freeze({
  '.mp3': 'mp3',
  '.m4a': 'aac',
  '.aac': 'aac',
  '.wav': 'wav',
  '.flac': 'flac',
  '.ogg': 'ogg',
  '.opus': 'opus',
});
const MAX_LYRICS = 1000;
const MAX_LINE_CHARS = 500;

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
    const value = JSON.parse(text ?? '');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function insideMediaRoot(mediaRoot, relPath) {
  const absolute = resolve(mediaRoot, relPath);
  if (absolute !== mediaRoot && !absolute.startsWith(mediaRoot + sep)) fail('PATH_NOT_ALLOWED', '媒体路径越出受控目录');
  return absolute;
}

/** LRC → 既有 `lyrics_json` 结构。无时间戳不伪造，空行丢弃。 */
function lyricsFromLrc(filePath) {
  const doc = parseLrcFile(filePath);
  const lines = doc.timedLines
    .filter(line => line.text && line.text.trim())
    .slice(0, MAX_LYRICS)
    .map((line, index) => ({
      id: `line-${index + 1}`,
      startMs: Math.max(0, Math.round(line.startMs)),
      text: line.text.trim().slice(0, MAX_LINE_CHARS),
    }));
  return lines;
}

export function createRepertoireImporter({ db, mediaRoot, policy, verifyAccompaniment = null, logger = null } = {}) {
  if (!db) throw new TypeError('createRepertoireImporter 需要 db');
  if (!mediaRoot) throw new TypeError('createRepertoireImporter 需要 mediaRoot');
  if (!policy) throw new TypeError('createRepertoireImporter 需要 policy');
  // 生产默认严格校验；测试只能注入探测实现（假音频隔离），不能关闭规则。
  const verifyAccompanimentArtifact = verifyAccompaniment ?? createAccompanimentVerifier();

  async function ensureOriginalCopy({ songId, sourceFile, sourceSha256, sourceSizeBytes }) {
    const directory = join(mediaRoot, 'vocal-import', songId);
    mkdirSync(directory, { recursive: true });
    const extension = extname(sourceFile).toLowerCase() || '.bin';
    const destination = join(directory, `original${extension}`);
    if (existsSync(destination)) {
      const stat = statSync(destination);
      if (stat.isFile() && stat.size === sourceSizeBytes && (await hashFile(destination)) === sourceSha256) {
        return { absolute: destination, relPath: relative(mediaRoot, destination).split(sep).join('/'), ext: extension };
      }
    }
    const temp = `${destination}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      copyFileSync(sourceFile, temp);
      if ((await hashFile(temp)) !== sourceSha256) fail('CONFLICT', '复制后的原唱文件校验失败');
      renameSync(temp, destination);
    } finally {
      if (existsSync(temp)) {
        try {
          unlinkSync(temp);
        } catch {
          /* 临时文件清理失败不影响重试，下一次会覆盖 */
        }
      }
    }
    return { absolute: destination, relPath: relative(mediaRoot, destination).split(sep).join('/'), ext: extension };
  }

  function upsertSource({ songId, sourceLocator, internalPath, codec, sourceSha256, durationMs }) {
    const bySha = db.prepare("SELECT id FROM source_media WHERE sha256=? AND status='READY' LIMIT 1").get(sourceSha256);
    if (bySha) return bySha.id;
    const id = uuid5(VOCAL_IMPORT_NAMESPACE, `${songId}:source`);
    const existing = db.prepare('SELECT id,internal_path FROM source_media WHERE id=?').get(id);
    if (existing) return existing.id;
    db.prepare(
      'INSERT INTO source_media(id,source_kind,source_locator,internal_path,sha256,duration_ms,audio_codec,video_codec,container) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(id, 'AUDIO', sourceLocator, internalPath, sourceSha256, durationMs, codec, null, null);
    return id;
  }

  function upsertClip({ id, sourceId, internalPath, codec, sourcePreserving, sha256, sizeBytes, durationMs }) {
    const existing = db.prepare('SELECT id FROM performance_clips WHERE id=?').get(id);
    if (existing) return id;
    db.prepare(
      'INSERT INTO performance_clips(id,source_media_id,start_ms,end_ms,internal_audio_path,codec,source_preserving,sha256,size_bytes,duration_ms,version) VALUES(?,?,0,?,?,?,?,?,?,?,1)',
    ).run(id, sourceId, durationMs, internalPath, codec, sourcePreserving ? 1 : 0, sha256, sizeBytes, durationMs);
    return id;
  }

  /** 与 `readTracks` 完全一致：旧单轨只有在两条显式轨都为空时，才按 audio_role 落到对应轨。 */
  function legacySingleTrackClipId(row) {
    if (!row || row.original_clip_id || row.accompaniment_clip_id) return null;
    return row.performance_clip_id ?? null;
  }

  /** 已有伴奏 = 显式伴奏轨，或旧单轨且 audioRole=ACCOMPANIMENT；旧 REFERENCE 是原唱，不算伴奏。 */
  function existingAccompanimentClipId(row) {
    if (!row) return null;
    if (row.accompaniment_clip_id) return row.accompaniment_clip_id;
    const legacy = legacySingleTrackClipId(row);
    return legacy && row.audio_role === 'ACCOMPANIMENT' ? legacy : null;
  }

  /** 与入库判定同源：先按 songId，再按源 SHA 并入既有 VOCAL 曲目。 */
  function findExistingRow({ songId, sourceSha256 } = {}) {
    const byId = db.prepare('SELECT * FROM repertoire_items WHERE id=?').get(String(songId ?? ''));
    if (byId?.deleted_at) return null;
    if (byId) return byId.kind === 'VOCAL' ? byId : null;
    if (!sourceSha256) return null;
    const bySourceSha = db
      .prepare(
        `SELECT r.id FROM repertoire_items r
         LEFT JOIN source_media m ON m.id=r.source_media_id
         LEFT JOIN performance_clips c ON c.id=r.original_clip_id
         WHERE r.kind='VOCAL' AND r.deleted_at IS NULL AND (m.sha256=? OR c.sha256=?)
         LIMIT 1`,
      )
      .get(sourceSha256, sourceSha256);
    return bySourceSha ? db.prepare('SELECT * FROM repertoire_items WHERE id=?').get(bySourceSha.id) : null;
  }

  /**
   * 统一入库实现。
   * - 默认：使用新伴奏；已有伴奏时返回冲突，绝不静默替换。
   * - choice='keep-existing'：保留曲库里已有的伴奏，只补原唱/歌词/语言。
   * - choice='use-new'：用户明确选择新伴奏，旧音轨只解绑不删除。
   * - originalOnly：分离失败/未配置时先安全入库原唱 + LRC，不写伴奏轨。
   */
  async function performImport({ job, artifact = null, choice = null, originalOnly = false } = {}) {
    if (!job || !job.songId) fail('BAD_REQUEST', '导入任务缺少 songId');
    const keepExisting = choice === 'keep-existing';
    const useNew = choice === 'use-new';
    if (choice !== null && !keepExisting && !useNew) fail('BAD_REQUEST', '未知的伴奏冲突处理方式');
    const usingIncoming = !originalOnly && !keepExisting;
    if (usingIncoming) {
      if (!artifact || !artifact.relPath) fail('BAD_REQUEST', '导入任务缺少伴奏工件');
      if (typeof artifact.sha256 !== 'string' || !artifact.sha256) fail('BAD_REQUEST', '伴奏工件缺少 SHA-256');
    }

    const songId = String(job.songId);
    const byId = db.prepare('SELECT * FROM repertoire_items WHERE id=?').get(songId);
    if (byId?.deleted_at) return { status: 'SKIPPED_DELETED', repertoireId: songId };
    if (byId && byId.kind !== 'VOCAL') fail('CONFLICT', '同一 songId 已被非唱歌曲目占用');

    const source = policy.resolveFile(job.rootId, job.original.relPath);
    const sourceStat = statSync(source.filePath);
    if (!sourceStat.isFile()) fail('PATH_NOT_ALLOWED', '源音频不是普通文件');
    if (job.original.sha256 && (await hashFile(source.filePath)) !== job.original.sha256) {
      fail('SOURCE_CHANGED', '源音频与扫描记录不一致，已停止入库', { status: 409 });
    }
    const sourceSha256 = job.original.sha256;
    const sourceSizeBytes = sourceStat.size;
    const originalDurationMs =
      Number(job.original.durationMs) > 0 ? Math.round(Number(job.original.durationMs)) : null;
    const sourceDurationMs =
      originalDurationMs ?? (Number(artifact?.durationMs) > 0 ? Math.round(Number(artifact.durationMs)) : null);
    if (!sourceDurationMs) fail('CONFLICT', '缺少可核验的音频时长，无法登记音轨');

    // 入库前的最后一道闸：不只看“文件非空/SHA 对得上”，还必须真实可解码、
    // 与原唱内容不同，并与原曲时长在容差内。失败在这里抛出，事务一个字段都不写。
    let verifiedAccompaniment = null;
    if (usingIncoming) {
      verifiedAccompaniment = await verifyAccompanimentArtifact({
        filePath: insideMediaRoot(mediaRoot, artifact.relPath),
        relPath: artifact.relPath,
        originalFilePath: source.filePath,
        originalSha256: sourceSha256,
        sourceDurationMs: originalDurationMs,
        expectedSha256: artifact.sha256,
      });
    }

    // 已有手工/旧路径导入的 VOCAL 曲目若源 SHA 相同，并入那一首，不再新建第二张卡片。
    const bySourceSha = byId
      ? null
      : db
          .prepare(
            `SELECT r.id FROM repertoire_items r
             LEFT JOIN source_media m ON m.id=r.source_media_id
             LEFT JOIN performance_clips c ON c.id=r.original_clip_id
             WHERE r.kind='VOCAL' AND r.deleted_at IS NULL AND (m.sha256=? OR c.sha256=?)
             LIMIT 1`,
          )
          .get(sourceSha256, sourceSha256);
    const existing = byId ?? (bySourceSha ? db.prepare('SELECT * FROM repertoire_items WHERE id=?').get(bySourceSha.id) : null);
    const repertoireId = existing?.id ?? songId;

    const originalClipId = uuid5(VOCAL_IMPORT_NAMESPACE, `${songId}:original:${sourceSha256}`);
    const previousAccompanimentClipId = existingAccompanimentClipId(existing);
    const incomingAccompanimentClipId = usingIncoming
      ? uuid5(
          VOCAL_IMPORT_NAMESPACE,
          `${songId}:accompaniment:${verifiedAccompaniment.sha256}:${artifact.relPath}`,
        )
      : null;

    // 数据保护：已有伴奏（含旧 audioRole=ACCOMPANIMENT 单轨）默认视为用户选择，
    // 新 AI 伴奏一律不静默替换；只有内容完全相同才复用旧指针，避免制造重复音轨。
    let accompanimentClipId = incomingAccompanimentClipId;
    let replacedAccompanimentClipId = null;
    if (usingIncoming && previousAccompanimentClipId && previousAccompanimentClipId !== incomingAccompanimentClipId) {
      const previousSha = db.prepare('SELECT sha256 FROM performance_clips WHERE id=?').get(previousAccompanimentClipId)?.sha256 ?? null;
      if (previousSha && previousSha === verifiedAccompaniment.sha256) {
        accompanimentClipId = previousAccompanimentClipId;
      } else if (useNew) {
        replacedAccompanimentClipId = previousAccompanimentClipId;
      } else {
        return {
          status: 'CONFLICT_ACCOMPANIMENT',
          repertoireId,
          existingAccompanimentClipId: previousAccompanimentClipId,
          incomingAccompanimentClipId,
          originalClipId: existing?.original_clip_id ?? null,
        };
      }
    }
    if (!usingIncoming) accompanimentClipId = previousAccompanimentClipId ?? null;
    const willWriteAccompaniment = usingIncoming && accompanimentClipId === incomingAccompanimentClipId;

    const accompanimentSizeBytes = willWriteAccompaniment ? verifiedAccompaniment.sizeBytes : null;
    const accompanimentDurationMs = willWriteAccompaniment ? verifiedAccompaniment.durationMs : null;

    const original = await ensureOriginalCopy({
      songId,
      sourceFile: source.filePath,
      sourceSha256,
      sourceSizeBytes,
    });

    const lyrics = job.lyrics?.relPath
      ? (() => {
          const resolved = policy.resolveFile(job.rootId, job.lyrics.relPath);
          return lyricsFromLrc(resolved.filePath);
        })()
      : [];

    // 原唱轨、歌词、结构已有记录就保留（不静默替换人工选择）；伴奏只在没有旧伴奏或用户明确选择新伴奏时合并。
    const alreadyTracked =
      existing && Boolean(existing.original_clip_id) && (existing.accompaniment_clip_id ?? null) === (accompanimentClipId ?? null);
    const existingLyrics = existing ? parseJson(existing.lyrics_json, []) : [];
    if (alreadyTracked && (!Array.isArray(existingLyrics) || existingLyrics.length > 0 || lyrics.length === 0)) {
      return {
        status: 'UNCHANGED',
        repertoireId,
        originalClipId: existing.original_clip_id,
        accompanimentClipId,
        originalOnly,
      };
    }

    const result = withTransaction(db, () => {
      const sourceId = upsertSource({
        songId,
        sourceLocator: `${job.rootId}:${job.original.relPath}`,
        internalPath: original.relPath,
        codec: CODEC_BY_EXT[original.ext] ?? 'unknown',
        sourceSha256,
        durationMs: sourceDurationMs,
      });
      upsertClip({
        id: originalClipId,
        sourceId,
        internalPath: original.relPath,
        codec: CODEC_BY_EXT[original.ext] ?? 'unknown',
        sourcePreserving: true,
        sha256: sourceSha256,
        sizeBytes: sourceSizeBytes,
        durationMs: sourceDurationMs,
      });
      if (willWriteAccompaniment) {
        upsertClip({
          id: accompanimentClipId,
          sourceId,
          internalPath: artifact.relPath,
          codec: artifact.codec || CODEC_BY_EXT[extname(artifact.relPath).toLowerCase()] || 'unknown',
          sourcePreserving: false,
          sha256: verifiedAccompaniment.sha256,
          sizeBytes: accompanimentSizeBytes,
          durationMs: accompanimentDurationMs,
        });
      }

      const title = String(job.title ?? '').trim().slice(0, 200) || '未命名歌曲';
      const artist = String(job.artist ?? '').trim().slice(0, 200);
      const language = ['zh', 'en', 'ko'].includes(job.language) ? job.language : null;
      // 结构按歌词重复与留白推测（不猜旋律）；用户在结构编辑器里可改。
      const sections = buildSections(lyrics, sourceDurationMs);

      if (!existing) {
        db.prepare(
          `INSERT INTO repertoire_items(
            id,kind,title,artist,learning_status,audio_role,vocal_language,lyrics_json,sections_json,practice_json,
            source_media_id,original_clip_id,accompaniment_clip_id,performance_clip_id,original_offset_ms,accompaniment_offset_ms
          ) VALUES(?,'VOCAL',?,?,'WANT_TO_LEARN',?,?,?,?,'{}',?,?,?,?,0,0)`,
        ).run(
          repertoireId,
          title,
          artist,
          accompanimentClipId ? 'ACCOMPANIMENT' : 'REFERENCE',
          language,
          JSON.stringify(lyrics),
          JSON.stringify(sections),
          sourceId,
          originalClipId,
          accompanimentClipId,
          accompanimentClipId,
        );
        bumpCatalog(db);
        return {
          status: originalOnly ? 'CREATED_ORIGINAL_ONLY' : 'CREATED',
          repertoireId,
          originalClipId,
          accompanimentClipId,
          lyrics: lyrics.length,
        };
      }

      // 人工歌词/结构优先：只在该曲目尚无歌词时才补 LRC；已有内容一律不动。
      // 原唱轨已有记录就保留，避免把手工选择的原唱顶掉；无旧伴奏时才合并新伴奏。
      const fillLyrics = Array.isArray(existingLyrics) && existingLyrics.length === 0 && lyrics.length > 0;
      // 结构同理：只在曲目还没有结构时才补，已有（含手工编辑的）一律不动。
      const existingSections = parseJson(existing.sections_json, []);
      const fillSections = sections.length > 0 && (!Array.isArray(existingSections) || existingSections.length === 0);
      if (originalOnly) {
        db.prepare(
          `UPDATE repertoire_items SET
            source_media_id=COALESCE(source_media_id,?),
            original_clip_id=COALESCE(original_clip_id,?),
            vocal_language=COALESCE(vocal_language,?),
            lyrics_json=CASE WHEN ? THEN ? ELSE lyrics_json END,
            sections_json=CASE WHEN ? THEN ? ELSE sections_json END,
            updated_at=CURRENT_TIMESTAMP
          WHERE id=?`,
        ).run(sourceId, originalClipId, language, fillLyrics ? 1 : 0, JSON.stringify(lyrics), fillSections ? 1 : 0, JSON.stringify(sections), repertoireId);
        bumpCatalog(db);
        return {
          status: 'MERGED_ORIGINAL_ONLY',
          repertoireId,
          originalClipId,
          accompanimentClipId: existingAccompanimentClipId(existing),
          lyricsFilled: fillLyrics,
        };
      }
      db.prepare(
        `UPDATE repertoire_items SET
          source_media_id=COALESCE(source_media_id,?),
          original_clip_id=COALESCE(original_clip_id,?),
          accompaniment_clip_id=?,
          performance_clip_id=COALESCE(performance_clip_id,?),
          audio_role=CASE WHEN COALESCE(original_clip_id,accompaniment_clip_id,performance_clip_id) IS NULL THEN 'ACCOMPANIMENT' ELSE audio_role END,
          vocal_language=COALESCE(vocal_language,?),
          lyrics_json=CASE WHEN ? THEN ? ELSE lyrics_json END,
          sections_json=CASE WHEN ? THEN ? ELSE sections_json END,
          updated_at=CURRENT_TIMESTAMP
        WHERE id=?`,
      ).run(
        sourceId,
        originalClipId,
        accompanimentClipId,
        accompanimentClipId,
        language,
        fillLyrics ? 1 : 0,
        JSON.stringify(lyrics),
        fillSections ? 1 : 0,
        JSON.stringify(sections),
        repertoireId,
      );
      bumpCatalog(db);
      return {
        status: 'MERGED',
        repertoireId,
        originalClipId,
        accompanimentClipId,
        lyricsFilled: fillLyrics,
        ...(replacedAccompanimentClipId ? { replacedAccompanimentClipId } : {}),
      };
    });

    logger?.info?.(`vocal-import imported ${songId}: ${result.status}`);
    return result;
  }

  async function importToRepertoire({ job, artifact = null } = {}, options = {}) {
    return performImport({ job, artifact, choice: options.choice ?? null });
  }

  /** 分离失败/未配置时的安全兜底：只入库原唱 + LRC，不伪造伴奏。 */
  importToRepertoire.importOriginalOnly = ({ job } = {}) => performImport({ job, artifact: null, originalOnly: true });

  /**
   * 供队列在分离前做只读预检：已有伴奏就不再调用分离器，避免覆盖旧文件。
   * 判定与入库阶段同源（songId 优先，其次源 SHA 并入）。
   */
  importToRepertoire.findExisting = ({ songId, sourceSha256 } = {}) => {
    const row = findExistingRow({ songId, sourceSha256 });
    if (!row) return null;
    return {
      repertoireId: row.id,
      title: row.title,
      audioRole: row.audio_role,
      legacySingleTrack: Boolean(legacySingleTrackClipId(row)),
      originalClipId: row.original_clip_id ?? null,
      accompanimentClipId: existingAccompanimentClipId(row),
    };
  };

  return importToRepertoire;
}
