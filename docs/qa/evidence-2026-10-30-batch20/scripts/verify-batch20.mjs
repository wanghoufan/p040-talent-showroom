#!/usr/bin/env node
/**
 * 批量 20 首入库核验（只读）。
 *
 * 只做三件事：读导入任务接口、读曲库接口、对源文件与产物重算 SHA/时长。
 * 不写库、不改任务、不删除、不调用任何会改变状态的接口。
 *
 * 用法：
 *   API=http://127.0.0.1:28794 TOKEN_FILE=var/vocal-v31-work/real-qa-20261030/db/.qa-token \
 *   MUSIC_DIR=var/vocal-v31-work/batch-20-20261030/music \
 *   node docs/qa/evidence-2026-10-30-batch20/scripts/verify-batch20.mjs > out.json
 *
 * token 只从文件读取，不打印、不写进输出。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const API = process.env.API ?? 'http://127.0.0.1:28794';
const TOKEN_FILE = process.env.TOKEN_FILE ?? 'var/vocal-v31-work/real-qa-20261030/db/.qa-token';
const MUSIC_DIR = resolve(process.env.MUSIC_DIR ?? 'var/vocal-v31-work/batch-20-20261030/music');
const ROOT_ID = process.env.ROOT_ID ?? 'batch20';

const token = (await readFile(TOKEN_FILE, 'utf8')).trim();

async function api(path) {
  const response = await fetch(API + path, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`);
  return response.json();
}

function sha256File(path) {
  return new Promise((ok, fail) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', fail)
      .on('end', () => ok(hash.digest('hex')));
  });
}

const { jobs } = await api(`/api/vocal-import/jobs?rootId=${encodeURIComponent(ROOT_ID)}`);
const rows = [];
for (const job of jobs) {
  const row = {
    title: job.title,
    artist: job.artist,
    status: job.status,
    importMode: job.importMode,
    language: job.language ?? null,
    songId: job.songId,
    sourceRelPath: job.original?.relPath ?? null,
    sourceSha256: job.original?.sha256 ?? null,
    lyricsTimedLines: job.lyrics?.timedLines ?? 0,
    issues: job.issues ?? [],
    errorCode: job.lastErrorCode ?? null,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
  };

  // 源文件未被改动：重算 SHA 与任务记录比对
  if (job.original?.relPath) {
    const sourcePath = join(MUSIC_DIR, job.original.relPath);
    try {
      const info = await stat(sourcePath);
      const sha = await sha256File(sourcePath);
      row.sourceUnchanged = sha === job.original.sha256 && info.size === job.original.sizeBytes;
      row.sourceSizeBytes = info.size;
    } catch (error) {
      row.sourceUnchanged = null;
      row.sourceError = String(error?.message ?? error);
    }
  }

  if (job.status === 'IMPORTED') {
    const detail = await api(`/api/repertoire/${job.songId}`);
    const item = detail.item ?? detail;
    const tracks = item.tracks ?? {};
    row.repertoire = {
      language: item.language ?? null,
      audioRole: item.audioRole ?? null,
      lyricsLines: Array.isArray(item.lyrics) ? item.lyrics.length : 0,
      sectionCount: Array.isArray(item.sections) ? item.sections.length : 0,
      sectionTypes: (item.sections ?? []).map((section) => section.type),
      tracks: Object.fromEntries(
        Object.entries(tracks).map(([key, value]) => [
          key,
          {
            codec: value?.media?.codec ?? null,
            durationMs: value?.media?.durationMs ?? null,
            sha256: value?.media?.sha256 ?? null,
          },
        ]),
      ),
      originalDurMs: job.original?.durationMs ?? null,
    };
    const accompaniment = tracks.accompaniment?.media;
    if (accompaniment) {
      // 伴奏必须与原唱不同源，且时长相容
      row.accompanimentDistinct = accompaniment.sha256 !== job.original?.sha256;
      const delta = Math.abs((accompaniment.durationMs ?? 0) - (job.original?.durationMs ?? 0));
      row.durationDeltaMs = delta;
      row.durationWithin4161ms = delta <= 4161;
    }
  }

  rows.push(row);
}

const summary = {
  at: new Date().toISOString(),
  rootId: ROOT_ID,
  total: rows.length,
  byStatus: rows.reduce((acc, row) => ({ ...acc, [row.status]: (acc[row.status] ?? 0) + 1 }), {}),
  dualTrack: rows.filter((row) => row.importMode === 'DUAL_TRACK').length,
  originalOnly: rows.filter((row) => row.importMode === 'ORIGINAL_ONLY').length,
  byLanguage: rows.reduce((acc, row) => {
    const key = row.language ?? '未判定';
    return { ...acc, [key]: (acc[key] ?? 0) + 1 };
  }, {}),
  sourceAllUnchanged: rows.every((row) => row.sourceUnchanged !== false),
  accompanimentAllDistinct: rows.every((row) => row.accompanimentDistinct !== false),
  durationAllWithinTolerance: rows.every((row) => row.durationWithin4161ms !== false),
};

console.log(JSON.stringify({ summary, rows }, null, 2));
