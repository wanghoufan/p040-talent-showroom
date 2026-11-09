import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { uuid } from './uuid';
import { apiWithTimeout } from './api';
import { rememberImport } from './pending-imports';
import type { ImportJob } from './types';

/**
 * 本地视频副本（单视频与批量视频离线收录）。
 *
 * 选中的本地视频先完整写入应用私有目录并核对内容摘要，再写 sidecar 元数据；
 * 只有「文件 + sidecar」都落盘才算收录任务可用。应用重启后从 sidecar 重建索引，
 * 不依赖 localStorage/IndexedDB 是否被清理，也不因为上传失败或退出而删除源副本。
 *
 * 「已核实」只来自写入时与源文件比对过的字节数与摘要。没有 sidecar（或 sidecar 缺摘要）
 * 的孤儿文件没有原始预期大小与摘要，自算摘要只能证明「读得到这些字节」，不能证明副本完整；
 * 这类文件一律登记为 verified:false（界面显示待核实），保留现场，不当作可播放/可上传。
 */

export const VIDEO_COPY_LIMIT = 512 * 1024 * 1024;
const ROOT = 'dance-videos';
const INDEX_KEY = 'dance.videos.v1';
const SIDECAR_SUFFIX = '.json';
const PART_SUFFIX = '.part';
const HASH_CHUNK = 1024 * 1024;

export interface StoredVideo {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  /** 相对 Directory.Data 的路径；网页端无法落盘时为空字符串。 */
  path: string;
  /** 原生返回的绝对 URI，供 convertFileSrc 播放。 */
  uri?: string;
  createdAt: string;
  sourceMediaId?: string;
  jobId?: string;
  /** 写入完成时已核对字节数与内容摘要；false 代表副本存在但无法证明完整（待核实），不可播放/上传。 */
  verified: boolean;
  /** 内容摘要（分块 FNV-1a 双通道 + 字节数），用于识别「长度相同但内容不同」。 */
  checksum?: string;
  /** 上次完整校验通过时文件的「字节数:mtime」指纹；与当前 stat 一致就不再读全文件。 */
  stamp?: string;
  /** 仅网页端使用：不上私有目录，直接保留内存中的 File。 */
  blob?: Blob;
}

export class VideoCopyError extends Error {}

function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

function readIndex(): StoredVideo[] {
  try {
    const raw = JSON.parse(localStorage.getItem(INDEX_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is StoredVideo => Boolean(item)
      && typeof item.id === 'string'
      && typeof item.path === 'string'
      && typeof item.sizeBytes === 'number');
  } catch { return []; }
}

/** 索引只是缓存：绝不截断条目（历史实现 slice(0,100) 会让第 101 条起失联）。 */
function writeIndex(items: StoredVideo[]): void {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(items)); } catch { /* sidecar 仍是真源 */ }
}

function upsert(record: StoredVideo): void {
  const items = readIndex().filter((item) => item.id !== record.id);
  items.unshift(record);
  writeIndex(items);
}

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

interface HashState { a: number; b: number; length: number }

function createHash(): HashState {
  return { a: 0x811c9dc5, b: 0x9e3779b9, length: 0 };
}

/** 双通道流式摘要：只比字节数会把「同样长度但内容不同」误判为完整。 */
function updateHash(state: HashState, bytes: Uint8Array): void {
  let { a, b } = state;
  for (let i = 0; i < bytes.length; i += 1) {
    const value = bytes[i];
    a = Math.imul(a ^ value, 0x01000193);
    b = Math.imul((b + value + 1) | 0, 0x85ebca6b) ^ (b >>> 13);
  }
  state.a = a >>> 0;
  state.b = b >>> 0;
  state.length += bytes.length;
}

function hashHex(state: HashState): string {
  return `${state.a.toString(16).padStart(8, '0')}${state.b.toString(16).padStart(8, '0')}-${state.length.toString(16)}`;
}

async function readChunk(path: string, offset: number, length: number): Promise<Uint8Array> {
  const result = await Filesystem.readFile({ path, directory: Directory.Data, offset, length });
  if (result.data instanceof Blob) return new Uint8Array(await result.data.arrayBuffer());
  if (!result.data) throw new VideoCopyError('视频副本无法读取，内容校验失败');
  return fromBase64(result.data);
}

/** 从实际落盘文件重新计算摘要；读不到或中途为空都明确失败。 */
async function hashFile(path: string, size: number): Promise<string> {
  const state = createHash();
  let offset = 0;
  while (offset < size) {
    const length = Math.min(HASH_CHUNK, size - offset);
    const bytes = await readChunk(path, offset, length);
    if (!bytes.length) throw new VideoCopyError('视频副本无法读取，内容校验失败');
    updateHash(state, bytes);
    offset += bytes.length;
    if (bytes.length < length) break;
  }
  // 短读（只读到一部分就结束）不能当成整份文件已核过：总长度对不上就明确失败。
  if (state.length !== size) {
    throw new VideoCopyError(`视频副本读取不完整（读到 ${state.length} / ${size} 字节），内容校验失败`);
  }
  return hashHex(state);
}

async function contentMatches(path: string, size: number, checksum: string): Promise<boolean> {
  try {
    const stat = await Filesystem.stat({ path, directory: Directory.Data });
    if (stat.size !== size) return false;
    return (await hashFile(path, size)) === checksum;
  } catch { return false; }
}

/** 老 WebView 没有 Blob.arrayBuffer，退回 FileReader；读取失败必须抛错，不能把空块当成视频内容。 */
function readBlob(blob: Blob): Promise<ArrayBuffer> {
  const candidate = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof candidate.arrayBuffer === 'function') return candidate.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error || Error('视频分块无法读取'));
    reader.readAsArrayBuffer(blob);
  });
}

function extensionOf(name: string, mime: string): string {
  const fromName = name.split('.').pop()?.toLowerCase() || '';
  if (/^[a-z0-9]{1,5}$/.test(fromName)) return fromName;
  const fromMime = mime.split('/').pop()?.toLowerCase() || '';
  return /^[a-z0-9]{1,5}$/.test(fromMime) ? fromMime : 'bin';
}

function isStoredPath(path: string): boolean {
  return path.startsWith(`${ROOT}/`) && !path.includes('..');
}

function mimeOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const table: Record<string, string> = {
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
    webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  };
  return table[ext] || 'application/octet-stream';
}

async function sidecarPath(path: string): Promise<string> {
  return path + SIDECAR_SUFFIX;
}

/**
 * sidecar 原子写：先写 .tmp，再替换正式文件。
 * 写失败必须抛给调用方，不能像以前那样 .catch 吞掉后仍对外宣称已关联。
 */
async function writeSidecar(record: StoredVideo): Promise<void> {
  if (!record.path) return;
  const data = JSON.stringify({
    id: record.id, name: record.name, mime: record.mime, sizeBytes: record.sizeBytes,
    path: record.path, uri: record.uri, createdAt: record.createdAt,
    sourceMediaId: record.sourceMediaId, jobId: record.jobId,
    verified: record.verified, checksum: record.checksum, stamp: record.stamp,
  });
  const target = await sidecarPath(record.path);
  const temp = `${target}.tmp`;
  await Filesystem.writeFile({ path: temp, directory: Directory.Data, data, encoding: Encoding.UTF8, recursive: true });
  // 旧 sidecar 先移除再改名：中途崩溃时 .tmp 仍可被恢复逻辑读到。
  await Filesystem.deleteFile({ path: target, directory: Directory.Data }).catch(() => undefined);
  await Filesystem.rename({ from: temp, to: target, directory: Directory.Data, toDirectory: Directory.Data });
}

/**
 * 把用户选中的视频复制到应用私有目录：分块写入 .part → 核对字节数与内容摘要
 * → 写 sidecar → 原子改名为正式文件。失败时保留现场（含 .part 与 sidecar），等待重试，
 * 绝不在这里删除；用户明确删除时才由 discardStoredVideo 清理。
 */
export async function stageVideo(file: File): Promise<StoredVideo> {
  if (!file.size) throw new VideoCopyError('文件为空，请重新选择');
  if (file.size > VIDEO_COPY_LIMIT) throw new VideoCopyError('文件超过 512MiB，未保存到手机');
  const id = uuid();
  const record: StoredVideo = {
    id,
    name: file.name || '未命名视频',
    mime: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    path: '',
    createdAt: new Date().toISOString(),
    verified: false,
  };
  if (!isNative()) {
    record.verified = true;
    record.blob = file;
    return record;
  }
  record.path = `${ROOT}/${id}.${extensionOf(record.name, record.mime)}`;
  const partPath = `${record.path}${PART_SUFFIX}`;
  await Filesystem.mkdir({ path: ROOT, directory: Directory.Data, recursive: true }).catch(() => undefined);
  try {
    const state = createHash();
    for (let offset = 0; offset < file.size; offset += 262144) {
      const bytes = new Uint8Array(await readBlob(file.slice(offset, offset + 262144)));
      updateHash(state, bytes);
      const data = base64(bytes);
      if (!offset) await Filesystem.writeFile({ path: partPath, directory: Directory.Data, data });
      else await Filesystem.appendFile({ path: partPath, directory: Directory.Data, data });
    }
    const stat = await Filesystem.stat({ path: partPath, directory: Directory.Data });
    if (stat.size !== file.size) {
      throw new VideoCopyError(`视频副本不完整（写入 ${stat.size} / ${file.size} 字节），已保留现场，请重试`);
    }
    record.checksum = hashHex(state);
    if (!(await contentMatches(partPath, file.size, record.checksum))) {
      throw new VideoCopyError('视频副本内容校验失败（写入内容与源文件不一致），已保留现场，请重试');
    }
    record.verified = true;
    // 先写 sidecar 再改名：若改名中途被杀，恢复逻辑能凭 sidecar 找到 .part 并补完改名。
    await writeSidecar(record);
    await Filesystem.rename({ from: partPath, to: record.path, directory: Directory.Data, toDirectory: Directory.Data });
    record.uri = (await Filesystem.getUri({ path: record.path, directory: Directory.Data })).uri;
    // 记下落盘指纹：刚核过的文件不必在播放时再读一遍。
    const finalStat = await Filesystem.stat({ path: record.path, directory: Directory.Data });
    record.stamp = stampOf(finalStat);
    if (record.stamp) verifiedStamps.set(record.id, record.stamp);
  } catch (error) {
    // 已写入的 .part 与 sidecar 仍留在手机里，绝不在这里删除：用户可重试，必要时还能人工取回。
    throw error instanceof VideoCopyError ? error : new VideoCopyError(error instanceof Error ? error.message : '视频无法保存到手机');
  }
  upsert(record);
  window.dispatchEvent(new Event('dance-videos-changed'));
  return record;
}

export function listStoredVideos(): StoredVideo[] {
  return readIndex().filter((item) => item.path);
}

export function findStoredVideo(id: string): StoredVideo | undefined {
  return listStoredVideos().find((item) => item.id === id);
}

export function findStoredVideoByJob(jobId: string): StoredVideo | undefined {
  return listStoredVideos().find((item) => item.jobId === jobId);
}

export function findStoredVideoBySource(sourceMediaId: string): StoredVideo | undefined {
  return listStoredVideos().find((item) => item.sourceMediaId === sourceMediaId);
}

export function listStagedVideos(): StoredVideo[] {
  return listStoredVideos().filter((item) => !item.jobId);
}

/** 同一 id 的关联串行执行：jobId 与 sourceMediaId 并发写入时不能互相覆盖。 */
const linkQueue = new Map<string, Promise<unknown>>();

async function applyLink(id: string, changes: Partial<Pick<StoredVideo, 'jobId' | 'sourceMediaId'>>): Promise<StoredVideo | undefined> {
  let current = findStoredVideo(id);
  if (!current) {
    // 索引被清空但副本还在：先凭 sidecar 补登记，绝不静默丢掉这次关联。
    await recoverStoredVideos();
    current = findStoredVideo(id);
  }
  if (!current) return undefined;
  const next = { ...current, ...changes };
  if (next.path) await writeSidecar(next);
  upsert(next);
  window.dispatchEvent(new Event('dance-videos-changed'));
  return next;
}

/** 关联任务/曲目来源；只更新元数据，不动视频文件。sidecar 写成功后才提交索引。 */
export function linkStoredVideo(id: string, changes: Partial<Pick<StoredVideo, 'jobId' | 'sourceMediaId'>>): Promise<StoredVideo | undefined> {
  const previous = linkQueue.get(id) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(() => applyLink(id, changes));
  linkQueue.set(id, task);
  void task.catch(() => undefined).finally(() => { if (linkQueue.get(id) === task) linkQueue.delete(id); });
  return task;
}

/** 同一进程内按文件指纹缓存「内容已核对」，避免每次播放都重读大文件。 */
const verifiedStamps = new Map<string, string>();
/** 同一文件的并发校验共用一次读取，避免播放页与详情页同时打开时读两遍。 */
const verifying = new Map<string, Promise<boolean>>();

/** 文件指纹；拿不到 mtime（老系统或异常值）时返回空串，表示「无法证明没变」，只能每次重核。 */
function stampOf(stat: { size: number; mtime?: number }): string {
  return typeof stat.mtime === 'number' && Number.isFinite(stat.mtime) && stat.mtime > 0
    ? `${stat.size}:${stat.mtime}`
    : '';
}

async function contentVerified(record: StoredVideo, stamp: string): Promise<boolean> {
  if (!record.checksum) return true;
  // 落盘指纹与上次完整校验一致（含重启后从索引读到的指纹）→ 不必再读全文件。
  if (stamp && record.stamp === stamp) return true;
  if (stamp && verifiedStamps.get(record.id) === stamp) return true;
  const key = `${record.id}:${stamp || 'no-stamp'}`;
  const inflight = verifying.get(key);
  if (inflight) return inflight;
  const task = (async () => {
    try {
      const actual = await hashFile(record.path, record.sizeBytes);
      if (actual !== record.checksum) return false;
      if (stamp) verifiedStamps.set(record.id, stamp);
      return true;
    } catch {
      return false;
    } finally {
      verifying.delete(key);
    }
  })();
  verifying.set(key, task);
  return task;
}

/** 视频文件真实存在、字节数与源文件一致且（有摘要时）内容一致，才返回可播放 URI。 */
export async function verifiedVideoUri(record: StoredVideo): Promise<string | null> {
  if (!record.path || !record.verified) return null;
  try {
    const stat = await Filesystem.stat({ path: record.path, directory: Directory.Data });
    if (stat.size !== record.sizeBytes) return null;
    if (!(await contentVerified(record, stampOf(stat)))) return null;
    // 绝对路径会随重装/升级/数据迁移变化：每次按当前容器解析，不沿用索引里的旧 URI。
    return (await Filesystem.getUri({ path: record.path, directory: Directory.Data })).uri;
  } catch { return null; }
}

/** 读取私有副本内容（重试上传用）；网页端直接用内存 File。 */
export async function readStoredVideo(record: StoredVideo): Promise<Blob> {
  // 未经写入期核对（缺原始大小/摘要的孤儿副本）不能被上传或当作已导入使用。
  if (!record.verified) throw new VideoCopyError('视频副本待核实（缺少原始大小与摘要），不能上传或播放');
  if (record.blob) return record.blob;
  if (!record.path) throw new VideoCopyError('手机副本不存在，请重新选择视频');
  try {
    // 和播放一样按当前容器解析：索引里的绝对 URI 可能是重装/迁移前的旧路径。
    const uri = (await Filesystem.getUri({ path: record.path, directory: Directory.Data })).uri;
    const response = await fetch(Capacitor.convertFileSrc(uri));
    if (!response.ok) throw Error(String(response.status));
    const blob = await response.blob();
    if (blob.size !== record.sizeBytes) throw Error('size');
    if (record.checksum) {
      const state = createHash();
      for (let offset = 0; offset < blob.size; offset += HASH_CHUNK) {
        updateHash(state, new Uint8Array(await readBlob(blob.slice(offset, offset + HASH_CHUNK))));
      }
      // 上传前再核一次内容：长度相同但内容被改写的副本不能送去生成收录任务。
      if (hashHex(state) !== record.checksum) throw Error('checksum');
    }
    return blob;
  } catch {
    throw new VideoCopyError('手机副本无法读取，请重新选择视频');
  }
}

function sidecarNames(listing: { files: { name: string }[] }): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of listing.files) {
    if (file.name.endsWith(`${SIDECAR_SUFFIX}.tmp`)) {
      const target = file.name.slice(0, -4);
      const media = target.slice(0, -SIDECAR_SUFFIX.length);
      if (!map.has(media)) map.set(media, file.name);
    } else if (file.name.endsWith(SIDECAR_SUFFIX)) {
      map.set(file.name.slice(0, -SIDECAR_SUFFIX.length), file.name);
    }
  }
  return map;
}

/**
 * 从私有目录与 sidecar 重建索引。
 * 用于 App 重启、索引被清空或旧版本升级；只补登记，绝不删除任何文件。
 * 能处理三种崩溃现场：索引丢失、sidecar 已写但正式文件还没改名（.part）、
 * 正式文件已改名但 sidecar 没写成（无 sidecar 的媒体按文件名补登记为「待核实」）。
 */
async function scanStoredVideos(): Promise<number> {
  if (!isNative()) return 0;
  let listing;
  try { listing = await Filesystem.readdir({ path: ROOT, directory: Directory.Data }); } catch { return 0; }
  const names = new Set(listing.files.map((file) => file.name));
  const sidecars = sidecarNames(listing);
  const indexed = readIndex();
  const known = new Map(indexed.map((item) => [item.id, item]));
  const knownIds = new Set(indexed.map((item) => item.id));
  const knownPaths = new Set(indexed.map((item) => item.path));
  /** 本轮改动过的记录最后一次性写回，避免每补一条就重写整份索引。 */
  const touched = new Map<string, StoredVideo>();
  const remember = (record: StoredVideo) => {
    known.set(record.id, record);
    knownIds.add(record.id);
    knownPaths.add(record.path);
    touched.set(record.id, record);
  };
  let recovered = 0;

  for (const [mediaName, sidecarName] of sidecars) {
    const sidecar = `${ROOT}/${sidecarName}`;
    try {
      const raw = await Filesystem.readFile({ path: sidecar, directory: Directory.Data, encoding: Encoding.UTF8 });
      const parsed = JSON.parse(typeof raw.data === 'string' ? raw.data : '') as StoredVideo;
      if (!parsed || typeof parsed.id !== 'string' || !isStoredPath(parsed.path)) continue;
      if (parsed.path !== `${ROOT}/${mediaName}`) continue;

      let actualPath = parsed.path;
      const isPart = !names.has(mediaName) && names.has(`${mediaName}${PART_SUFFIX}`);
      if (!names.has(mediaName) && !isPart) continue;
      if (isPart) actualPath = `${parsed.path}${PART_SUFFIX}`;

      const stat = await Filesystem.stat({ path: actualPath, directory: Directory.Data });
      if (stat.size !== parsed.sizeBytes) continue;
      const stamp = stampOf(stat);
      const previous = known.get(parsed.id);
      const indexAgrees = previous?.path === parsed.path && previous.verified
        && !!previous.checksum && previous.checksum === parsed.checksum;
      // 只有「索引与 sidecar 完整一致、文件指纹也没变」才跳过内容核对；
      // 拿不到指纹时无法证明文件没变，宁可多读一次。
      const stampAgrees = !!stamp && (previous?.stamp === stamp || parsed.stamp === stamp);
      if (!isPart && !sidecarName.endsWith('.tmp') && indexAgrees && (!stamp || stampAgrees)) {
        // sidecar 是关联信息的真源；索引落盘失败时在这里补回 jobId/sourceMediaId。
        if (previous!.jobId !== parsed.jobId || previous!.sourceMediaId !== parsed.sourceMediaId || previous!.stamp !== stamp) {
          remember({ ...previous!, ...parsed, verified: true, stamp });
        }
        continue;
      }
      // 没有原始期望摘要时，自算摘要只能证明「这份文件读得完」，不能证明副本完整；
      // 这类条目只登记为待核实，绝不用自算摘要把它洗成 verified:true，也不写回带摘要的 sidecar。
      if (!parsed.checksum) {
        if (isPart) continue; // .part 无法核实完整性，保留现场不冒充正式副本
        if (previous && previous.path === parsed.path && !previous.verified && !previous.checksum && previous.stamp === stamp) continue;
        if (!knownIds.has(parsed.id)) recovered += 1;
        remember({
          ...parsed,
          checksum: undefined,
          verified: false,
          stamp,
          uri: (await Filesystem.getUri({ path: parsed.path, directory: Directory.Data })).uri,
          blob: undefined,
        });
        continue;
      }
      const actual = await hashFile(actualPath, parsed.sizeBytes);
      const checksum = parsed.checksum;
      if (actual !== checksum) continue;

      if (isPart) {
        // 上次在「sidecar 已写、正式文件未改名」处被杀：先补完改名，不另建副本。
        await Filesystem.rename({ from: actualPath, to: parsed.path, directory: Directory.Data, toDirectory: Directory.Data });
      }
      if (sidecarName.endsWith('.tmp')) {
        await Filesystem.rename({ from: sidecar, to: `${parsed.path}${SIDECAR_SUFFIX}`, directory: Directory.Data, toDirectory: Directory.Data }).catch(() => undefined);
      }
      const record: StoredVideo = {
        ...parsed,
        checksum,
        verified: true,
        stamp,
        uri: (await Filesystem.getUri({ path: parsed.path, directory: Directory.Data })).uri,
        blob: undefined,
      };
      if (!knownIds.has(record.id)) recovered += 1;
      remember(record);
    } catch { /* 坏 sidecar 或读不到时跳过，不删除现场 */ }
  }

  // 正式文件已改名、sidecar 却没写成：按文件名补登记，让用户能在「未完成收录」里看到它。
  // 没有 sidecar 就没有原始预期大小与摘要，无法证明副本完整：只登记为待核实（verified:false），
  // 不自算摘要、不写 sidecar、不删除现场，也不作为可播放/可上传的副本。
  for (const file of listing.files) {
    const name = file.name;
    if (name.endsWith(SIDECAR_SUFFIX) || name.endsWith('.tmp') || name.endsWith(PART_SUFFIX)) continue;
    if (sidecars.has(name)) continue;
    const path = `${ROOT}/${name}`;
    if (knownPaths.has(path)) continue;
    try {
      const stat = await Filesystem.stat({ path, directory: Directory.Data });
      if (!stat.size) continue;
      const id = name.includes('.') ? name.slice(0, name.indexOf('.')) : name;
      const previous = known.get(id);
      // 索引里已登记为待核实且文件没变：保持原样，不重写索引。
      if (previous && previous.path === path && !previous.verified && !previous.checksum && previous.stamp === stampOf(stat)) continue;
      const record: StoredVideo = {
        id,
        name,
        mime: mimeOf(name),
        sizeBytes: stat.size,
        path,
        uri: (await Filesystem.getUri({ path, directory: Directory.Data })).uri,
        createdAt: new Date(typeof stat.mtime === 'number' && stat.mtime > 0 ? stat.mtime : Date.now()).toISOString(),
        verified: false,
        stamp: stampOf(stat),
      };
      if (!knownIds.has(record.id)) recovered += 1;
      remember(record);
    } catch { /* 读不到就跳过，不删除现场 */ }
  }

  if (touched.size) {
    const ids = new Set(touched.keys());
    writeIndex([...touched.values(), ...readIndex().filter((item) => !ids.has(item.id))]);
  }
  if (recovered) window.dispatchEvent(new Event('dance-videos-changed'));
  return recovered;
}

let recoveryTask: Promise<number> | null = null;

/**
 * 从私有目录与 sidecar 重建索引。
 * 用于 App 重启、索引被清空或旧版本升级；只补登记，绝不删除任何文件。
 * 能处理三种崩溃现场：索引丢失、sidecar 已写但正式文件还没改名（.part）、
 * 正式文件已改名但 sidecar 没写成（无 sidecar 的媒体按文件名补登记）。
 * 冷启动时多处会同时调用（曲库、确认页、原视频页），共享同一轮扫描，避免重复读盘。
 */
export function recoverStoredVideos(): Promise<number> {
  recoveryTask ??= scanStoredVideos().finally(() => { recoveryTask = null; });
  return recoveryTask;
}

/**
 * 上传已保存的私有副本并建立收录任务。
 * 成功只记录 jobId，副本保留；用户确认保存或任务失败都不会自动删除源视频。
 */
export async function uploadStoredVideo(record: StoredVideo): Promise<ImportJob> {
  const body = await readStoredVideo(record);
  const job = await apiWithTimeout<ImportJob>('/api/imports/file', {
    method: 'POST',
    headers: {
      'Content-Type': record.mime,
      'X-File-Name': encodeURIComponent(record.name),
      // 同一个私有副本重试上传时复用 id，服务端已有任务就直接返回，避免生成重复收录。
      'X-Import-Id': record.id,
    },
    body,
  }, 120000);
  // 先把任务记进「未完成的收录」：即使下面 sidecar 关联失败，也能回到确认页，不必重传。
  rememberImport(job.id, record.name, { videoId: record.id, sizeBytes: record.sizeBytes });
  await linkStoredVideo(record.id, { jobId: job.id });
  return job;
}

/** 「文件本来就不存在」可以放过；其它删除失败必须抛给调用方。 */
function isMissingFile(error: unknown): boolean {
  if ((error as { code?: string } | null)?.code === 'OS-PLUG-FILE-0008') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /does not exist|no such file|enoent|not found|不存在/i.test(message);
}

async function removeFile(path: string): Promise<void> {
  try {
    await Filesystem.deleteFile({ path, directory: Directory.Data });
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

/** 用户明确点击「删除副本」时才移除文件、sidecar 与临时文件。 */
export async function discardStoredVideo(id: string): Promise<void> {
  let record = findStoredVideo(id);
  if (!record) {
    // 索引被清理过时先从 sidecar 找回，否则删除会只删索引、把文件留在手机里。
    await recoverStoredVideos();
    record = findStoredVideo(id);
  }
  if (!record?.path) {
    writeIndex(readIndex().filter((item) => item.id !== id));
    window.dispatchEvent(new Event('dance-videos-changed'));
    return;
  }
  try {
    // 先删媒体再摘索引：媒体删失败时条目仍在，用户可重试；反过来先摘索引会把文件留成孤儿，
    // 下次冷启动又被 sidecar 恢复出来，等于「删了还在」。
    await removeFile(record.path);
    await removeFile(await sidecarPath(record.path));
    await removeFile(`${record.path}${SIDECAR_SUFFIX}.tmp`);
    await removeFile(`${record.path}${PART_SUFFIX}`);
  } catch (error) {
    throw error instanceof VideoCopyError ? error : new VideoCopyError('视频副本删除失败，文件仍在手机里，请重试');
  }
  verifiedStamps.delete(id);
  writeIndex(readIndex().filter((item) => item.id !== id));
  window.dispatchEvent(new Event('dance-videos-changed'));
}
