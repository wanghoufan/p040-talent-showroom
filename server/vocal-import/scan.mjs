import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import {
  ALL_EXTENSIONS,
  artistKey,
  canonical,
  detectLanguage,
  isLyricsFile,
  nameIdentity,
  versionLabels,
} from './canonical.mjs';
import { fail } from './errors.mjs';
import { needsReview } from './issues.mjs';
import { parseLrcFile } from './lrc.mjs';
import { buildLyricRepeatSuggestions } from './lyrics-repeat.mjs';
import { probeAudio, skippedProbe } from './probe.mjs';
import { songIdForAudioSha } from './uuid5.mjs';

/**
 * 只读扫描 + 保守配对（对齐计划包 `tool/p040_smart_import.py`，并补 PCM 指纹与尾部损坏探测）。
 * 任何“可能配错”的情况一律进 needs-review，不在后台静默决定。
 */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.venv',
  '__pycache__',
  '$RECYCLE.BIN',
  'System Volume Information',
]);

/** 需要人工确认的问题见 `issues.mjs`；其余问题只记录，不阻断自动处理。 */

async function hashFile(filePath) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
}

function listSourceFiles(rootPath, { maxFiles, maxDepth }) {
  const found = [];
  const stack = [{ dir: rootPath, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限子目录跳过，不阻断整批
    }
    for (const entry of entries) {
      // 不跟随任何符号链接：既避免越界，也避免环。
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth + 1 > maxDepth) continue;
        if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue;
        stack.push({ dir: fullPath, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      // 跳过隐藏文件与 macOS AppleDouble（`._歌名.mp3` 不是音频，只是 4 KB 资源叉）。
      if (entry.name.startsWith('.')) continue;
      if (!ALL_EXTENSIONS.includes(extname(entry.name).toLowerCase())) continue;
      found.push(fullPath);
      if (found.length > maxFiles) fail('BAD_REQUEST', `文件数量超过上限 ${maxFiles}`);
    }
  }
  return found;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

const byCopyThenLength = (a, b) =>
  Number(Boolean(a.copyNumber)) - Number(Boolean(b.copyNumber)) ||
  a.name.length - b.name.length ||
  (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const byCopyThenPath = (a, b) =>
  Number(Boolean(a.copyNumber)) - Number(Boolean(b.copyNumber)) ||
  a.relPath.length - b.relPath.length ||
  (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

export async function scanSource({ policy, rootId, subPath = '', options = {} }) {
  const {
    maxFiles = 20000,
    maxDepth = 16,
    probe = true,
    // 真实扫描默认整轨解码一遍，才能发现「能读出时长、但解码损坏」的文件；
    // 只需要快速预览时由调用方显式传 deep:false 降级。
    deep = true,
    fingerprint = true,
    includeAbsolutePaths = false,
    concurrency = 4,
    probeOptions = {},
    scannedAt = new Date().toISOString(),
  } = options;

  const resolved = policy.resolveRoot(rootId, subPath);
  const files = listSourceFiles(resolved.targetPath, { maxFiles, maxDepth }).sort((a, b) => {
    const ra = relative(resolved.rootPath, a).toLowerCase();
    const rb = relative(resolved.rootPath, b).toLowerCase();
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });

  // 单个文件读不了/解析失败只记录并跳过，绝不让一首坏歌中断整批（AC08）。
  const unreadableFiles = [];
  const entries = (await mapLimit(files, concurrency, async filePath => {
    const relPath = relative(resolved.rootPath, filePath).split(sep).join('/');
    try {
      const identity = nameIdentity(basename(filePath));
      const sha256 = await hashFile(filePath);
      const entry = {
        name: basename(filePath),
        relPath,
        ...(includeAbsolutePaths ? { absolutePath: filePath } : {}),
        ...identity,
        sha256,
        sizeBytes: statSync(filePath).size,
      };
      if (isLyricsFile(filePath)) {
        entry.lrc = parseLrcFile(filePath);
        return { kind: 'lyrics', entry };
      }
      entry.probe = probe ? await probeAudio(filePath, { deep, fingerprint, ...probeOptions }) : skippedProbe();
      return { kind: 'audio', entry };
    } catch (error) {
      // 只回传相对路径与错误码，不把本机绝对路径或底层堆栈暴露给客户端。
      unreadableFiles.push({
        relPath,
        code: typeof error?.code === 'string' ? error.code : 'READ_FAILED',
        message: '无法读取或解析该文件，已跳过，未影响其它歌曲',
      });
      return null;
    }
  })).filter(Boolean);

  const lyricsEntries = entries.filter(item => item.kind === 'lyrics').map(item => item.entry);
  const audioEntries = entries.filter(item => item.kind === 'audio').map(item => item.entry);

  const duplicateLyrics = [];
  const lyricsByHash = new Map();
  for (const entry of lyricsEntries) {
    if (!lyricsByHash.has(entry.sha256)) lyricsByHash.set(entry.sha256, []);
    lyricsByHash.get(entry.sha256).push(entry);
  }
  const lyrics = [];
  for (const group of lyricsByHash.values()) {
    const chosen = [...group].sort(byCopyThenPath)[0];
    lyrics.push(chosen);
    for (const entry of group) {
      if (entry !== chosen) duplicateLyrics.push({ duplicate: entry.relPath, sameAs: chosen.relPath, sha256: entry.sha256 });
    }
  }

  const duplicateFiles = [];
  const audioByHash = new Map();
  for (const entry of audioEntries) {
    if (!audioByHash.has(entry.sha256)) audioByHash.set(entry.sha256, []);
    audioByHash.get(entry.sha256).push(entry);
  }
  const primary = [];
  for (const [sha256, group] of audioByHash) {
    const chosen = [...group].sort(byCopyThenLength)[0];
    primary.push(chosen);
    for (const entry of group) {
      if (entry !== chosen) duplicateFiles.push({ duplicate: entry.relPath, sameAs: chosen.relPath, sha256 });
    }
  }
  primary.sort((a, b) => {
    const ra = a.relPath.toLowerCase();
    const rb = b.relPath.toLowerCase();
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });

  const originals = primary.filter(entry => entry.role !== 'accompaniment');
  const suppliedAccompaniments = primary.filter(entry => entry.role === 'accompaniment');

  const byNameKey = new Map();
  for (const entry of originals) {
    if (!byNameKey.has(entry.key)) byNameKey.set(entry.key, []);
    byNameKey.get(entry.key).push(entry);
  }

  const usedLyrics = new Set();
  const songs = [];

  for (const track of originals) {
    const issues = [];
    const durationMs = track.probe?.durationMs ?? null;

    const exact = lyrics.filter(entry => entry.key === track.key);
    const weak = exact.length
      ? []
      : lyrics.filter(entry =>
          entry.titleKey &&
          entry.titleKey === track.titleKey &&
          (!versionLabels(entry.title).length || canonical(entry.base) === track.key));

    let chosen = null;
    if (exact.length === 1) chosen = exact[0];
    else if (exact.length > 1) issues.push('multiple-lyrics-candidates');
    else if (weak.length) issues.push('lyrics-needs-confirmation');
    else issues.push('missing-lyrics');

    if (track.probe?.probeState === 'invalid') issues.push('invalid-audio');
    if (track.role === 'unmarked') issues.push('audio-role-unmarked-original-assumed');
    if (track.probe?.decode) {
      // 真实审计里 T02/T03 只有末尾少量损坏（覆盖 >98%）：可继续提取，但要如实标记。
      const decodeState = track.probe.decode.state;
      if (decodeState === 'tail-truncated') issues.push('audio-tail-truncated');
      else if (decodeState === 'damaged' || decodeState === 'failed') issues.push('audio-damaged');
      // 缺 ffmpeg / 解码超时都是工具或配置问题，不是音频损坏；必须分开报，不能冤枉用户文件。
      else if (decodeState === 'not-installed') issues.push('audio-decode-unavailable');
      else if (decodeState === 'timeout') issues.push('audio-decode-timeout');
    }

    const titleTag = (track.probe?.tags?.title ?? '').trim();
    const artistTag = (track.probe?.tags?.artist ?? '').trim();
    if (titleTag && track.artist && canonical(titleTag) !== track.titleKey) issues.push('filename-id3-title-conflict');
    if (artistTag && track.artist && artistKey(artistTag) !== track.artistKey) issues.push('filename-id3-artist-conflict');
    if (track.copyNumber) issues.push('duplicate-suffix');
    if ((byNameKey.get(track.key) ?? []).length > 1) issues.push('same-title-different-audio-review');
    if (audioEntries.some(entry => entry.sha256 === track.sha256 && entry.role === 'accompaniment')) {
      issues.push('role-conflict-same-audio');
    }

    if (chosen) {
      usedLyrics.add(chosen.relPath);
      const doc = chosen.lrc;
      if (!doc.hasTiming) issues.push('lyrics-no-timestamps');
      if (doc.invalidTags) issues.push('lyrics-invalid-tags');
      if (durationMs !== null && doc.maxStartMs !== null && doc.maxStartMs > durationMs + 2000) {
        issues.push('lyrics-timestamp-exceeds-audio');
      }
    }

    const matchedAccompaniments = suppliedAccompaniments.filter(entry => entry.key === track.key);
    const pickedAccompaniment = matchedAccompaniments.length === 1 ? matchedAccompaniments[0] : null;
    if (matchedAccompaniments.length > 1) issues.push('multiple-accompaniment-candidates');

    // 只对已匹配 LRC 的文本/时间行做重复候选；无歌词或无可信重复时为空。
    // 这是只读建议，不进 issues、不影响压力/状态，也不生成 sections。
    const lyricsRepeat = buildLyricRepeatSuggestions(chosen?.lrc?.timedLines ?? []);

    const lyricCandidates = (exact.length > 1 ? exact : weak).map(entry => entry.relPath);

    songs.push({
      songId: songIdForAudioSha(track.sha256),
      title: track.title,
      artist: track.artist,
      language: detectLanguage({
        title: track.title,
        artist: track.artist,
        lyrics: chosen?.lrc?.text ?? '',
      }),
      versions: track.versions,
      original: track.relPath,
      originalHash: track.sha256,
      originalSizeBytes: track.sizeBytes,
      durationMs,
      suppliedAccompaniment: pickedAccompaniment ? pickedAccompaniment.relPath : null,
      lyrics: chosen ? chosen.relPath : null,
      lyricsSha256: chosen ? chosen.sha256 : null,
      lyricsProposal: chosen ? null : lyricCandidates.length === 1 ? lyricCandidates[0] : null,
      lyricsCandidates: lyricCandidates,
      timedLyricsCount: chosen ? chosen.lrc.timedLines.length : 0,
      // 来源固定 lrc-repeat，状态 pending-confirmation / unknown，绝不伪造时间。
      lyricsRepeatCandidates: lyricsRepeat.candidates,
      lyricsRepeatStatus: lyricsRepeat.status,
      pcmFingerprint: track.probe?.fingerprint ?? null,
      probeState: track.probe?.probeState ?? 'skipped',
      decode: track.probe?.decode ?? null,
      issues,
      status: 'ready-to-extract',
    });
  }

  // PCM 指纹只做“重复辅助”：同指纹不同 SHA 常常是同一音频换了封装或只换了内嵌封面，
  // 仍保留为不同版本（不同 songId），只提醒核对，绝不静默合并。
  const byFingerprint = new Map();
  for (const song of songs) {
    if (!song.pcmFingerprint) continue;
    if (!byFingerprint.has(song.pcmFingerprint)) byFingerprint.set(song.pcmFingerprint, []);
    byFingerprint.get(song.pcmFingerprint).push(song);
  }
  const pcmDuplicateGroups = [];
  for (const [fingerprint, group] of byFingerprint) {
    const distinctHashes = new Set(group.map(song => song.originalHash));
    if (distinctHashes.size < 2) continue;
    pcmDuplicateGroups.push({
      fingerprint,
      note: 'same-pcm-different-container-or-cover',
      files: group.map(song => ({
        songId: song.songId,
        relPath: song.original,
        sha256: song.originalHash,
        sizeBytes: song.originalSizeBytes,
        durationMs: song.durationMs,
      })),
    });
    for (const song of group) pushUnique(song.issues, 'pcm-duplicate-different-file');
  }

  // 缺歌词不阻断提取伴奏（AC08）；只有 REVIEW_ISSUES 里的歧义才进待核对。
  for (const song of songs) {
    song.status = needsReview(song.issues) ? 'needs-review' : 'ready-to-extract';
  }

  const unpairedLrc = lyrics.filter(entry => !usedLyrics.has(entry.relPath)).map(entry => entry.relPath);
  const orphanAccompaniments = suppliedAccompaniments
    .filter(entry => !originals.some(song => song.key === entry.key))
    .map(entry => entry.relPath);

  return {
    schema: 'p040.local-ai-import.preflight.v2',
    mode: 'read-only-scan',
    rootId: resolved.rootId,
    relSubPath: resolved.relSubPath,
    scannedAt,
    summary: {
      audioFiles: audioEntries.length,
      originalCandidates: originals.length,
      lrcFiles: lyrics.length,
      exactPairs: songs.filter(song => song.lyrics).length,
      readyToExtract: songs.filter(song => song.status === 'ready-to-extract').length,
      needsReview: songs.filter(song => song.status === 'needs-review').length,
      duplicates: duplicateFiles.length,
      duplicateLyrics: duplicateLyrics.length,
      unpairedLrc: unpairedLrc.length,
      unreadableFiles: unreadableFiles.length,
    },
    songs,
    duplicateFiles,
    duplicateLyrics,
    unpairedLrc,
    orphanAccompaniments,
    pcmDuplicateGroups,
    unreadableFiles,
  };
}
