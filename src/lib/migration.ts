import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { commitLocal, localFiles, localOperations, readMetadata, saveLocalFile } from './local-database';
import { readCachedIndex, saveCachedIndex, type CachedIndex } from './offline-manifest';
import { listPendingImports } from './pending-imports';
import type { DanceItem, TalentItem } from './types';
import type { Program } from './program';
import type { LocalOperation } from './offline-editing';
import type { PendingFile } from './offline-files';
import { Migration, type MigrationFileResult, type MigrationReceiveResult } from '../native/migration';

export type { MigrationFileResult } from '../native/migration';

/**
 * 换机迁移的数据层。
 *
 * 只迁移「旧机本地已有」的内容：曲名/学习进度/谱面页码/节目单等快照，尚未同步的离线修改
 * （operations）、待上传文件队列，以及已缓存的原视频、音乐、封面、谱件和单视频收录副本。
 * 登录 token、设备地址、同步游标一律不导出。
 *
 * 合并原则：默认只补缺，不覆盖新机已有数据；冲突逐条列出。只有用户明确点「采用旧机数据」，
 * 且旧机 revision 更高时才覆盖，并先写回滚备份。operations 以 operationId 为幂等键、
 * 待上传文件以 id/uploadId 为幂等键，状态（pending/conflict/failed/blocked）原样保留。
 */

export const MIGRATION_SCHEMA = 1;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_ITEMS = 20_000;
const MAX_SCORE_PAGES = 5_000;
const MAX_CACHE_ENTRIES = 20_000;
const MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_OPERATIONS = 2_000;
const MAX_PENDING_FILES = 1_000;
const MAX_OPERATION_BYTES = 256 * 1024;
const MAX_FIELDS_BYTES = 256 * 1024;
const MAX_PENDING_IMPORTS = 20;

const OFFLINE_MANIFEST_KEY = 'dance.offline.manifest';
const PENDING_IMPORTS_KEY = 'dance.pending-imports.v1';

const METADATA_KEYS = [
  'dance.catalog-snapshot',
  'dance.repertoire-snapshot',
  'dance.trash',
  'dance.program',
] as const;

export type MigrationMetadataKey = (typeof METADATA_KEYS)[number];

export interface MigrationCacheEntry {
  key: string;
  path: string;
  sha256: string;
  version: number;
  sizeBytes: number;
}

/** 待同步的离线操作；operationId 是服务端幂等键，状态与错误必须原样保留。 */
export interface MigrationOperation {
  operationId: string;
  kind: LocalOperation['kind'];
  id: string;
  action: LocalOperation['action'];
  baseRevision: number;
  fields?: Record<string, unknown>;
  state?: 'pending' | 'conflict' | 'failed';
  error?: string;
  server?: Record<string, unknown> | null;
  serverRevision?: number;
  createdAt?: number;
}

/** 待上传文件记录；id/uploadId 是上传幂等键，jobId/videoId 指向旧机已有任务或副本。 */
export interface MigrationPendingFile {
  id: string;
  name: string;
  mime: string;
  kind: string;
  itemId: string;
  state: string;
  path?: string;
  jobId?: string;
  uploadId?: string;
  error?: string;
  title?: string;
  learningStatus?: string;
  createFields?: Record<string, unknown>;
  track?: 'original' | 'accompaniment';
  replace?: boolean;
  videoId?: string;
}

/** 未完成的收录（只含可续接任务所需的最小字段）；videoId 指向已核实的私有副本。 */
export interface MigrationPendingImport {
  jobId: string;
  name: string;
  createdAt?: string;
  videoId?: string;
  sizeBytes?: number;
}

/**
 * 离线清单摘要：只带重建所需的版本与播放列表，曲目正文由合并后的曲库快照重建。
 * 直接搬运整份 manifest 会与 catalog/repertoire 快照重复，并有超出 8 MB 上限的风险。
 */
export interface MigrationOfflineManifest {
  catalogVersion: number;
  playlist: string[];
}

/** 未能完整迁移的条目；用于让上层明确报告「哪些没做、为什么」，不能只报成功数。 */
export interface MigrationUnfinished {
  area: 'file' | 'cache' | 'pending-file' | 'pending-import';
  id: string;
  reason: string;
}

export interface MigrationState {
  schema: 1;
  createdAt: string;
  metadata: Partial<Record<MigrationMetadataKey, string>>;
  cacheIndex: MigrationCacheEntry[];
  scorePages: Record<string, string>;
  operations: MigrationOperation[];
  pendingFiles: MigrationPendingFile[];
  pendingImports: MigrationPendingImport[];
  offlineManifest?: MigrationOfflineManifest;
}

export interface CollectedMigrationState {
  state: MigrationState;
  warnings: string[];
}

export type MigrationArea = 'catalog' | 'repertoire' | 'trash' | 'program' | 'score-page' | 'cache'
  | 'operation' | 'pending-file' | 'pending-import';

export interface MigrationConflict {
  area: MigrationArea;
  id: string;
  title?: string;
  kind?: string;
  localRevision?: number;
  incomingRevision?: number;
  reason: string;
  resolution: 'kept-local' | 'used-incoming';
}

export interface MigrationTrashEntry {
  kind: string;
  id: string;
  revision?: number;
  [key: string]: unknown;
}

export interface LocalMigrationData {
  catalog: DanceItem[];
  repertoire: TalentItem[];
  trash: MigrationTrashEntry[];
  program: Program | null;
  scorePages: Record<string, string>;
}

export interface MergeMigrationOptions {
  /** 默认 false：冲突只报告，不覆盖新机数据。 */
  preferIncoming?: boolean;
}

export interface MergeMigrationOutcome {
  catalog: DanceItem[];
  repertoire: TalentItem[];
  trash: MigrationTrashEntry[];
  program: Program | null;
  scorePages: Record<string, string>;
  changes: { catalog: boolean; repertoire: boolean; trash: boolean; program: boolean };
  added: { catalog: number; repertoire: number; trash: number; program: boolean; scorePages: number };
  overwritten: number;
  unchanged: number;
  conflicts: MigrationConflict[];
}

export interface CachePlanOutcome {
  next: CachedIndex;
  added: number;
  unchanged: number;
  skipped: number;
  conflicts: MigrationConflict[];
  skips: MigrationUnfinished[];
}

export interface ApplyMigrationOutcome extends MergeMigrationOutcome {
  cacheAdded: number;
  cacheUnchanged: number;
  cacheSkipped: number;
  cacheConflicts: MigrationConflict[];
  /** 待同步操作：按 operationId 幂等合并，冲突保留新机。 */
  operationsAdded: number;
  operationsUnchanged: number;
  operationsConflicts: MigrationConflict[];
  /** 待上传文件：仅登记对应文件已接收/跳过的记录，状态与幂等键原样保留。 */
  pendingFilesAdded: number;
  pendingFilesUnchanged: number;
  pendingFilesSkipped: number;
  pendingFilesConflicts: MigrationConflict[];
  /** 未完成的收录：只有可续接且副本已核实才登记。 */
  pendingImportsAdded: number;
  pendingImportsUnchanged: number;
  pendingImportsSkipped: number;
  pendingImportsConflicts: MigrationConflict[];
  /** 因内容不同被隔离保存的文件数；非 0 时不能显示「完整成功」。 */
  conflictFiles: number;
  failedFiles: number;
  /** 未完成项明细（文件隔离/失败、缓存与待办遗漏），供上层逐条展示。 */
  incomplete: MigrationUnfinished[];
  complete: boolean;
  backupPath?: string;
}

export interface MigrationImportOutcome {
  received: MigrationReceiveResult;
  state: MigrationState;
  applied: ApplyMigrationOutcome;
}

export interface ReceiveMigrationOptions {
  host: string;
  port: number;
  /** 6 位数字配对码（手动连接时用）；自动发现路径不需要。 */
  key?: string;
  /** 自动发现拿到的一次性 token；旧手机用户点「允许」后才能确认。 */
  discoveryToken?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,120}$/;
const SCORE_PAGE_KEY = /^dance\.score-page\.([A-Za-z0-9_-]{1,80})$/;
const SCORE_PAGE_VALUE = /^[1-9]\d{0,5}$/;
const KIND_SET = new Set(['DANCE', 'GUITAR', 'VOCAL']);
const STATUS_SET = new Set(['CAN_DANCE', 'PRACTICING', 'WANT_TO_LEARN']);
const ACTION_SET = new Set(['create', 'update', 'trash', 'restore', 'program', 'bulk']);
const OPERATION_STATE_SET = new Set(['pending', 'conflict', 'failed']);
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const PENDING_STATE = /^[A-Za-z0-9_-]{1,20}$/;
const PENDING_KIND = /^(DANCE|GUITAR|VOCAL)(:SCORE)?$/;
const FORBIDDEN_MARKERS = ['dance.owner-token', 'dance.device-settings'];
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 240 || value.startsWith('/')) return false;
  if (value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every((part) => SAFE_SEGMENT.test(part) && part !== '.' && part !== '..');
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value);
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000_000;
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function boundedJson(value: unknown, label: string, maxBytes = MAX_FIELDS_BYTES): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new Error(`${label} 无法序列化`);
  }
  if (text === undefined || utf8Bytes(text) > maxBytes) throw new Error(`${label} 过大`);
  for (const marker of FORBIDDEN_MARKERS) {
    if (text.includes(marker)) throw new Error(`${label} 包含登录凭据或设备地址`);
  }
  return text;
}

function assertPlainRecord(value: unknown, label: string, maxBytes = MAX_FIELDS_BYTES): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} 格式无效`);
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) throw new Error(`${label} 包含不允许的字段`);
  }
  boundedJson(value, label, maxBytes);
  return value;
}

function validateOperation(value: unknown): MigrationOperation {
  if (!isRecord(value)) throw new Error('待同步操作格式无效');
  if (!isSafeId(value.operationId) || value.operationId.length < 8) throw new Error('待同步操作缺少幂等键');
  if (typeof value.kind !== 'string' || !KIND_SET.has(value.kind)) throw new Error('待同步操作类型无效');
  if (typeof value.action !== 'string' || !ACTION_SET.has(value.action)) throw new Error('待同步操作动作无效');
  if (typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 120) throw new Error('待同步操作曲目 id 无效');
  if (!isRevision(value.baseRevision)) throw new Error('待同步操作基线版本无效');
  const operation: MigrationOperation = {
    operationId: value.operationId,
    kind: value.kind as MigrationOperation['kind'],
    id: value.id,
    action: value.action as MigrationOperation['action'],
    baseRevision: value.baseRevision,
  };
  if (value.fields !== undefined) operation.fields = assertPlainRecord(value.fields, '待同步操作字段', MAX_OPERATION_BYTES);
  if (value.state !== undefined) {
    if (typeof value.state !== 'string' || !OPERATION_STATE_SET.has(value.state)) throw new Error('待同步操作状态无效');
    operation.state = value.state as MigrationOperation['state'];
  }
  if (value.error !== undefined) {
    if (typeof value.error !== 'string' || value.error.length > 500) throw new Error('待同步操作错误信息无效');
    operation.error = value.error;
  }
  if (value.server !== undefined) {
    if (value.server !== null) assertPlainRecord(value.server, '待同步操作服务器快照');
    operation.server = value.server as Record<string, unknown> | null;
  }
  if (value.serverRevision !== undefined) {
    if (!isRevision(value.serverRevision)) throw new Error('待同步操作服务器版本无效');
    operation.serverRevision = value.serverRevision;
  }
  if (value.createdAt !== undefined) {
    if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt < 0 || value.createdAt > 1e16) {
      throw new Error('待同步操作时间戳无效');
    }
    operation.createdAt = value.createdAt;
  }
  return operation;
}

function validatePendingFile(value: unknown): MigrationPendingFile {
  if (!isRecord(value)) throw new Error('待上传文件格式无效');
  if (!isSafeId(value.id)) throw new Error('待上传文件 id 无效');
  if (typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 255) throw new Error('待上传文件名无效');
  if (typeof value.mime !== 'string' || value.mime.length > 120) throw new Error('待上传文件类型无效');
  if (typeof value.kind !== 'string' || !PENDING_KIND.test(value.kind)) throw new Error('待上传文件用途无效');
  if (typeof value.itemId !== 'string' || value.itemId.length < 1 || value.itemId.length > 120) throw new Error('待上传文件曲目 id 无效');
  if (typeof value.state !== 'string' || !PENDING_STATE.test(value.state)) throw new Error('待上传文件状态无效');
  const file: MigrationPendingFile = {
    id: value.id,
    name: value.name,
    mime: value.mime,
    kind: value.kind,
    itemId: value.itemId,
    state: value.state,
  };
  if (value.path !== undefined) {
    if (typeof value.path !== 'string' || value.path !== `dance-pending/${value.id}`) throw new Error('待上传文件路径无效');
    file.path = value.path;
  }
  for (const key of ['jobId', 'uploadId', 'videoId'] as const) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (!isSafeId(raw)) throw new Error(`待上传文件 ${key} 无效`);
    file[key] = raw;
  }
  if (value.error !== undefined) {
    if (typeof value.error !== 'string' || value.error.length > 500) throw new Error('待上传文件错误信息无效');
    file.error = value.error;
  }
  if (value.title !== undefined) {
    if (typeof value.title !== 'string' || value.title.length > 500) throw new Error('待上传文件标题无效');
    file.title = value.title;
  }
  if (value.learningStatus !== undefined) {
    if (typeof value.learningStatus !== 'string' || !STATUS_SET.has(value.learningStatus)) throw new Error('待上传文件学习状态无效');
    file.learningStatus = value.learningStatus;
  }
  if (value.createFields !== undefined) file.createFields = assertPlainRecord(value.createFields, '待上传文件创建字段');
  if (value.track !== undefined) {
    if (value.track !== 'original' && value.track !== 'accompaniment') throw new Error('待上传文件音轨无效');
    file.track = value.track;
  }
  if (value.replace !== undefined) {
    if (typeof value.replace !== 'boolean') throw new Error('待上传文件替换标记无效');
    file.replace = value.replace;
  }
  return file;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validatePendingImport(value: unknown): MigrationPendingImport {
  if (!isRecord(value)) throw new Error('未完成收录格式无效');
  if (!isSafeId(value.jobId)) throw new Error('未完成收录任务 id 无效');
  if (typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 255) throw new Error('未完成收录名称无效');
  const item: MigrationPendingImport = { jobId: value.jobId, name: value.name };
  if (value.createdAt !== undefined) {
    if (typeof value.createdAt !== 'string' || value.createdAt.length > 40) throw new Error('未完成收录时间无效');
    item.createdAt = value.createdAt;
  }
  if (value.videoId !== undefined) {
    if (!isSafeId(value.videoId)) throw new Error('未完成收录视频 id 无效');
    item.videoId = value.videoId;
  }
  if (value.sizeBytes !== undefined) {
    if (typeof value.sizeBytes !== 'number' || !Number.isInteger(value.sizeBytes)
      || value.sizeBytes < 0 || value.sizeBytes > MAX_MEDIA_BYTES) {
      throw new Error('未完成收录体积无效');
    }
    item.sizeBytes = value.sizeBytes;
  }
  return item;
}

function validateOfflineManifest(value: unknown): MigrationOfflineManifest {
  if (!isRecord(value)) throw new Error('离线清单摘要格式无效');
  if (!isRevision(value.catalogVersion)) throw new Error('离线清单版本无效');
  if (!Array.isArray(value.playlist) || value.playlist.length > MAX_ITEMS) throw new Error('离线清单播放列表无效');
  const playlist: string[] = [];
  const seen = new Set<string>();
  for (const id of value.playlist) {
    if (!isSafeId(id) || seen.has(id)) throw new Error('离线清单播放列表条目无效');
    seen.add(id);
    playlist.push(id);
  }
  return { catalogVersion: value.catalogVersion, playlist };
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} 不是有效 JSON，已停止迁移`);
  }
}

function parseArray(raw: string | null, label: string): unknown[] {
  if (raw === null || raw === '') return [];
  const value = parseJson(raw, label);
  if (!Array.isArray(value)) throw new Error(`${label} 格式无效`);
  return value;
}

function revisionOf(item: unknown): number {
  if (!isRecord(item)) return 0;
  return isRevision(item.revision) ? item.revision : 0;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftObject);
  const rightKeys = Object.keys(rightObject);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightObject, key) && deepEqual(leftObject[key], rightObject[key]));
}

function validateItem(value: unknown, area: 'catalog' | 'repertoire'): void {
  if (!isRecord(value)) throw new Error(`${area === 'catalog' ? '舞蹈' : '才艺'}曲目格式无效`);
  if (typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 120) throw new Error('曲目 id 无效');
  if (typeof value.title !== 'string' || value.title.length > 500) throw new Error('曲目标题无效');
  if (value.kind !== undefined) {
    if (typeof value.kind !== 'string' || !KIND_SET.has(value.kind)) throw new Error('曲目类型无效');
    if (area === 'catalog' && value.kind !== 'DANCE') throw new Error('舞蹈曲目类型无效');
  }
  if (area === 'repertoire' && (typeof value.kind !== 'string' || (value.kind !== 'GUITAR' && value.kind !== 'VOCAL'))) {
    throw new Error('才艺曲目类型无效');
  }
  if (value.learningStatus !== undefined && (typeof value.learningStatus !== 'string' || !STATUS_SET.has(value.learningStatus))) {
    throw new Error('学习进度无效');
  }
  if (value.revision !== undefined && !isRevision(value.revision)) throw new Error('曲目 revision 无效');
}

function validateTrashEntry(value: unknown): void {
  if (!isRecord(value)) throw new Error('回收站条目格式无效');
  if (typeof value.kind !== 'string' || !KIND_SET.has(value.kind)) throw new Error('回收站曲目类型无效');
  if (typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 120) throw new Error('回收站曲目 id 无效');
  if (value.revision !== undefined && !isRevision(value.revision)) throw new Error('回收站 revision 无效');
}

function validateProgram(value: unknown): void {
  if (!isRecord(value)) throw new Error('节目单格式无效');
  if (!isRevision(value.revision)) throw new Error('节目单 revision 无效');
  if (!Array.isArray(value.items) || value.items.length > MAX_ITEMS) throw new Error('节目单条目过多');
  for (const item of value.items) {
    if (!isRecord(item) || typeof item.kind !== 'string' || !KIND_SET.has(item.kind)) throw new Error('节目单曲目类型无效');
    if (typeof item.id !== 'string' || item.id.length < 1 || item.id.length > 120) throw new Error('节目单曲目 id 无效');
  }
}

function validateMetadataValue(key: MigrationMetadataKey, value: unknown): void {
  if (key === 'dance.catalog-snapshot' || key === 'dance.repertoire-snapshot') {
    if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error(`${key} 条目过多或格式无效`);
    const area = key === 'dance.catalog-snapshot' ? 'catalog' : 'repertoire';
    for (const item of value) validateItem(item, area);
    return;
  }
  if (key === 'dance.trash') {
    if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error('回收站条目过多或格式无效');
    for (const item of value) validateTrashEntry(item);
    return;
  }
  validateProgram(value);
}

function metadataValueOf(state: MigrationState, key: MigrationMetadataKey): unknown {
  const raw = state.metadata[key];
  return raw === undefined ? undefined : parseJson(raw, key);
}

function collectScorePages(): { pages: Record<string, string>; warnings: string[] } {
  const pages: Record<string, string> = {};
  const warnings: string[] = [];
  let count = 0;
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || !key.startsWith('dance.score-page.')) continue;
    const value = localStorage.getItem(key);
    if (!SCORE_PAGE_KEY.test(key) || value === null || !SCORE_PAGE_VALUE.test(value)) {
      warnings.push(`跳过无效谱面页码：${key}`);
      continue;
    }
    if (count >= MAX_SCORE_PAGES) throw new Error('谱面页码超过 5000 条，请先清理后再迁移');
    pages[key] = value;
    count += 1;
  }
  return { pages, warnings };
}

function collectCacheIndex(): { entries: MigrationCacheEntry[]; warnings: string[] } {
  const entries: MigrationCacheEntry[] = [];
  const warnings: string[] = [];
  const index = readCachedIndex();
  for (const [key, cached] of Object.entries(index)) {
    if (!cached || typeof cached !== 'object') continue;
    const path = cached.path;
    const sha256 = typeof cached.sha256 === 'string' ? cached.sha256.toLowerCase() : '';
    if (typeof path !== 'string' || !path.startsWith('dance-offline/') || !isSafeRelativePath(path)) {
      warnings.push(`跳过无法识别的缓存路径：${key}`);
      continue;
    }
    if (!isSha256(sha256) || !isRevision(cached.version) || typeof cached.sizeBytes !== 'number'
      || !Number.isInteger(cached.sizeBytes) || cached.sizeBytes < 0 || cached.sizeBytes > MAX_MEDIA_BYTES
      || !key.startsWith('/api/media/') || key.length > 300) {
      warnings.push(`跳过信息不完整的缓存：${key}`);
      continue;
    }
    if (entries.length >= MAX_CACHE_ENTRIES) throw new Error('离线缓存条目超过 20000 条，请先清理后再迁移');
    entries.push({ key, path, sha256, version: cached.version, sizeBytes: cached.sizeBytes });
  }
  return { entries, warnings };
}

async function collectOperations(): Promise<{ operations: MigrationOperation[]; warnings: string[] }> {
  const operations: MigrationOperation[] = [];
  const warnings: string[] = [];
  let rows: (LocalOperation & { createdAt?: number })[];
  try {
    rows = await localOperations<LocalOperation & { createdAt?: number }>();
  } catch {
    return { operations, warnings: ['无法读取待同步修改队列，本次未迁移这些修改'] };
  }
  for (const row of rows) {
    try {
      const operation = validateOperation({
        operationId: row.operationId,
        kind: row.kind,
        id: row.id,
        action: row.action,
        baseRevision: row.baseRevision,
        fields: row.fields,
        state: row.state,
        error: row.error,
        server: row.server,
        serverRevision: row.serverRevision,
        createdAt: row.createdAt,
      });
      if (operations.length >= MAX_OPERATIONS) throw new Error('待同步修改超过 2000 条');
      operations.push(operation);
    } catch (error) {
      warnings.push(`跳过无法迁移的待同步修改 ${row.operationId || ''}：${error instanceof Error ? error.message : '格式无效'}`);
    }
  }
  return { operations, warnings };
}

async function collectPendingFiles(): Promise<{ pendingFiles: MigrationPendingFile[]; warnings: string[] }> {
  const pendingFiles: MigrationPendingFile[] = [];
  const warnings: string[] = [];
  let rows: PendingFile[];
  try {
    rows = await localFiles<PendingFile>();
  } catch {
    return { pendingFiles, warnings: ['无法读取待上传文件队列，本次未迁移这些文件'] };
  }
  for (const row of rows) {
    try {
      if (!row.path && !row.videoId) {
        warnings.push(`跳过只存在于内存的待上传文件：${row.name || row.id}`);
        continue;
      }
      const file = validatePendingFile({
        id: row.id,
        name: row.name,
        mime: row.mime,
        kind: row.kind,
        itemId: row.itemId,
        state: row.state,
        path: row.path,
        jobId: row.jobId,
        uploadId: row.uploadId,
        error: row.error,
        title: row.title,
        learningStatus: row.learningStatus,
        createFields: row.createFields,
        track: row.track,
        replace: row.replace,
        videoId: row.videoId,
      });
      if (pendingFiles.length >= MAX_PENDING_FILES) throw new Error('待上传文件超过 1000 个');
      pendingFiles.push(file);
    } catch (error) {
      warnings.push(`跳过无法迁移的待上传文件 ${row.id || ''}：${error instanceof Error ? error.message : '格式无效'}`);
    }
  }
  return { pendingFiles, warnings };
}

function collectPendingImports(): { pendingImports: MigrationPendingImport[]; warnings: string[] } {
  const pendingImports: MigrationPendingImport[] = [];
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(PENDING_IMPORTS_KEY) || '[]');
  } catch {
    return { pendingImports, warnings: ['未完成的收录列表损坏，本次未迁移这些记录（可在新机重新导入）'] };
  }
  if (!Array.isArray(raw)) return { pendingImports, warnings: ['未完成的收录列表格式无效，本次未迁移这些记录'] };
  const seen = new Set<string>();
  for (const entry of raw) {
    try {
      const item = validatePendingImport(entry);
      if (seen.has(item.jobId)) continue;
      if (pendingImports.length >= MAX_PENDING_IMPORTS) {
        warnings.push('未完成的收录超过 20 条，多余记录未迁移');
        break;
      }
      seen.add(item.jobId);
      pendingImports.push(item);
    } catch (error) {
      warnings.push(`跳过无法迁移的未完成收录：${error instanceof Error ? error.message : '格式无效'}`);
    }
  }
  return { pendingImports, warnings };
}

function collectOfflineManifest(): { manifest?: MigrationOfflineManifest; warning?: string } {
  let raw: string | null;
  try {
    raw = readMetadata(OFFLINE_MANIFEST_KEY);
  } catch {
    return { warning: '无法读取离线清单，本次只迁移曲库快照（新机连服务器同步后会重新生成）' };
  }
  if (raw === null || raw === '') return {};
  try {
    const parsed = parseJson(raw, OFFLINE_MANIFEST_KEY);
    if (!isRecord(parsed)) throw new Error('离线清单格式无效');
    const catalogVersion = parsed.catalogVersion;
    if (!isRevision(catalogVersion)) throw new Error('离线清单版本无效');
    const playlist = Array.isArray(parsed.playlist)
      ? parsed.playlist.filter((id): id is string => isSafeId(id)).slice(0, MAX_ITEMS)
      : [];
    return { manifest: { catalogVersion, playlist } };
  } catch (error) {
    return { warning: `离线清单无法迁移（${error instanceof Error ? error.message : '格式无效'}），新机连服务器同步后会重新生成` };
  }
}

/** 旧机：生成只含白名单数据的迁移快照；不包含 owner token、设备地址与同步游标。 */
export async function collectMigrationState(): Promise<CollectedMigrationState> {
  const metadata: Partial<Record<MigrationMetadataKey, string>> = {};
  for (const key of METADATA_KEYS) {
    const raw = readMetadata(key);
    if (raw === null || raw === '') continue;
    validateMetadataValue(key, parseJson(raw, key));
    metadata[key] = raw;
  }
  const cache = collectCacheIndex();
  const score = collectScorePages();
  const operations = await collectOperations();
  const pendingFiles = await collectPendingFiles();
  const pendingImports = collectPendingImports();
  const offline = collectOfflineManifest();
  const state: MigrationState = {
    schema: MIGRATION_SCHEMA,
    createdAt: new Date().toISOString(),
    metadata,
    cacheIndex: cache.entries,
    scorePages: score.pages,
    operations: operations.operations,
    pendingFiles: pendingFiles.pendingFiles,
    pendingImports: pendingImports.pendingImports,
    ...(offline.manifest ? { offlineManifest: offline.manifest } : {}),
  };
  if (utf8Bytes(JSON.stringify(state)) > MAX_STATE_BYTES) {
    throw new Error('迁移数据超过 8 MB，请先清理本地曲库缓存后再试');
  }
  return {
    state,
    warnings: [
      ...cache.warnings,
      ...score.warnings,
      ...operations.warnings,
      ...pendingFiles.warnings,
      ...pendingImports.warnings,
      ...(offline.warning ? [offline.warning] : []),
    ],
  };
}

/** 新机：把外部输入（旧机 state.json）当成不可信数据，逐项校验后才允许写入。 */
export function validateMigrationState(input: string | unknown): MigrationState {
  if (typeof input === 'string' && utf8Bytes(input) > MAX_STATE_BYTES) throw new Error('迁移状态文件超过 8 MB');
  const raw = typeof input === 'string' ? parseJson(input, '迁移状态文件') : input;
  if (!isRecord(raw)) throw new Error('迁移状态格式无效');
  if (raw.schema !== MIGRATION_SCHEMA) throw new Error('迁移协议版本不兼容，请把两台手机升级到同一版本');
  const serialized = JSON.stringify(raw);
  for (const marker of FORBIDDEN_MARKERS) {
    if (serialized.includes(marker)) throw new Error('迁移数据包含登录凭据或设备地址');
  }
  const metadataInput = raw.metadata;
  if (!isRecord(metadataInput)) throw new Error('迁移元数据格式无效');
  const metadata: Partial<Record<MigrationMetadataKey, string>> = {};
  for (const key of Object.keys(metadataInput)) {
    if (!(METADATA_KEYS as readonly string[]).includes(key)) {
      throw new Error(`迁移数据包含不允许的字段：${key}`);
    }
    const value = metadataInput[key];
    if (typeof value !== 'string' || value.length > MAX_STATE_BYTES) throw new Error(`迁移字段 ${key} 格式无效`);
    validateMetadataValue(key as MigrationMetadataKey, parseJson(value, key));
    metadata[key as MigrationMetadataKey] = value;
  }

  const cacheIndexInput = raw.cacheIndex;
  if (!Array.isArray(cacheIndexInput) || cacheIndexInput.length > MAX_CACHE_ENTRIES) {
    throw new Error('迁移缓存清单格式无效或条目过多');
  }
  const seenKeys = new Set<string>();
  const cacheIndex: MigrationCacheEntry[] = [];
  for (const entry of cacheIndexInput) {
    if (!isRecord(entry)) throw new Error('迁移缓存条目格式无效');
    const key = entry.key;
    const path = entry.path;
    const sha256 = typeof entry.sha256 === 'string' ? entry.sha256.toLowerCase() : '';
    if (typeof key !== 'string' || !key.startsWith('/api/media/') || key.length > 300 || seenKeys.has(key)) {
      throw new Error('迁移缓存 key 无效或重复');
    }
    if (typeof path !== 'string' || !path.startsWith('dance-offline/') || !isSafeRelativePath(path)) {
      throw new Error('迁移缓存路径无效');
    }
    if (!isSha256(sha256) || !isRevision(entry.version) || typeof entry.sizeBytes !== 'number'
      || !Number.isInteger(entry.sizeBytes) || entry.sizeBytes < 0 || entry.sizeBytes > MAX_MEDIA_BYTES) {
      throw new Error('迁移缓存校验信息无效');
    }
    seenKeys.add(key);
    cacheIndex.push({ key, path, sha256, version: entry.version, sizeBytes: entry.sizeBytes });
  }

  const scoreInput = raw.scorePages;
  if (scoreInput !== undefined && !isRecord(scoreInput)) throw new Error('迁移谱面页码格式无效');
  const scorePages: Record<string, string> = {};
  let scoreCount = 0;
  for (const key of Object.keys(scoreInput ?? {})) {
    const value = (scoreInput as Record<string, unknown>)[key];
    if (!SCORE_PAGE_KEY.test(key) || typeof value !== 'string' || !SCORE_PAGE_VALUE.test(value)) {
      throw new Error('迁移谱面页码无效');
    }
    if (scoreCount >= MAX_SCORE_PAGES) throw new Error('迁移谱面页码过多');
    scorePages[key] = value;
    scoreCount += 1;
  }

  const operationsInput = raw.operations;
  if (operationsInput !== undefined && !Array.isArray(operationsInput)) throw new Error('待同步操作格式无效');
  const operations: MigrationOperation[] = [];
  const operationIds = new Set<string>();
  for (const entry of operationsInput ?? []) {
    const operation = validateOperation(entry);
    if (operationIds.has(operation.operationId)) throw new Error('待同步操作幂等键重复');
    if (operations.length >= MAX_OPERATIONS) throw new Error('待同步操作过多');
    operationIds.add(operation.operationId);
    operations.push(operation);
  }

  const pendingInput = raw.pendingFiles;
  if (pendingInput !== undefined && !Array.isArray(pendingInput)) throw new Error('待上传文件格式无效');
  const pendingFiles: MigrationPendingFile[] = [];
  const pendingIds = new Set<string>();
  for (const entry of pendingInput ?? []) {
    const file = validatePendingFile(entry);
    if (pendingIds.has(file.id)) throw new Error('待上传文件 id 重复');
    if (pendingFiles.length >= MAX_PENDING_FILES) throw new Error('待上传文件过多');
    if (file.uploadId && pendingFiles.some((item) => item.uploadId === file.uploadId)) {
      throw new Error('待上传文件幂等键重复');
    }
    pendingIds.add(file.id);
    pendingFiles.push(file);
  }

  const importsInput = raw.pendingImports;
  if (importsInput !== undefined && !Array.isArray(importsInput)) throw new Error('未完成的收录格式无效');
  const pendingImports: MigrationPendingImport[] = [];
  const importIds = new Set<string>();
  for (const entry of importsInput ?? []) {
    const item = validatePendingImport(entry);
    if (importIds.has(item.jobId)) throw new Error('未完成收录任务 id 重复');
    if (pendingImports.length >= MAX_PENDING_IMPORTS) throw new Error('未完成的收录过多');
    importIds.add(item.jobId);
    pendingImports.push(item);
  }

  const offlineManifest = raw.offlineManifest === undefined ? undefined : validateOfflineManifest(raw.offlineManifest);

  return {
    schema: MIGRATION_SCHEMA,
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt.length <= 40 ? raw.createdAt : '',
    metadata,
    cacheIndex,
    scorePages,
    operations,
    pendingFiles,
    pendingImports,
    ...(offlineManifest ? { offlineManifest } : {}),
  };
}

export function readLocalMigrationData(): LocalMigrationData {
  const catalog = parseArray(readMetadata('dance.catalog-snapshot'), 'dance.catalog-snapshot');
  const repertoire = parseArray(readMetadata('dance.repertoire-snapshot'), 'dance.repertoire-snapshot');
  const trash = parseArray(readMetadata('dance.trash'), 'dance.trash') as MigrationTrashEntry[];
  const programRaw = readMetadata('dance.program');
  let program: Program | null = null;
  if (programRaw !== null && programRaw !== '') {
    const parsed = parseJson(programRaw, 'dance.program');
    validateProgram(parsed);
    program = parsed as Program;
  }
  return {
    catalog: catalog as DanceItem[],
    repertoire: repertoire as TalentItem[],
    trash,
    program,
    scorePages: collectScorePages().pages,
  };
}

/**
 * 纯函数合并：默认只补缺；冲突保留新机值。
 * preferIncoming=true 时也只覆盖「旧机 revision 严格更高」的条目，避免旧数据压掉新进度。
 */
export function mergeMigrationState(state: MigrationState, local: LocalMigrationData, options: MergeMigrationOptions = {}): MergeMigrationOutcome {
  const preferIncoming = options.preferIncoming === true;
  const conflicts: MigrationConflict[] = [];
  let overwritten = 0;
  let unchanged = 0;

  const incomingCatalog = (metadataValueOf(state, 'dance.catalog-snapshot') ?? []) as DanceItem[];
  const incomingRepertoire = (metadataValueOf(state, 'dance.repertoire-snapshot') ?? []) as TalentItem[];
  const incomingTrash = (metadataValueOf(state, 'dance.trash') ?? []) as MigrationTrashEntry[];
  const incomingProgramRaw = metadataValueOf(state, 'dance.program');
  const incomingProgram = incomingProgramRaw === undefined ? null : incomingProgramRaw as Program;

  const nextCatalog = [...local.catalog];
  const catalogIndex = new Map(nextCatalog.map((item, index) => [item.id, index]));
  let addedCatalog = 0;
  for (const item of incomingCatalog) {
    const index = catalogIndex.get(item.id);
    if (index === undefined) {
      catalogIndex.set(item.id, nextCatalog.length);
      nextCatalog.push(item);
      addedCatalog += 1;
      continue;
    }
    const current = nextCatalog[index];
    if (deepEqual(current, item)) {
      unchanged += 1;
      continue;
    }
    const localRevision = revisionOf(current);
    const incomingRevision = revisionOf(item);
    if (preferIncoming && incomingRevision > localRevision) {
      nextCatalog[index] = item;
      overwritten += 1;
      conflicts.push({ area: 'catalog', id: item.id, title: item.title, kind: 'DANCE', localRevision, incomingRevision, reason: '旧机 revision 更高，已按用户确认覆盖', resolution: 'used-incoming' });
    } else {
      conflicts.push({ area: 'catalog', id: item.id, title: item.title, kind: 'DANCE', localRevision, incomingRevision, reason: '新机已有同名曲目且内容不同，未覆盖', resolution: 'kept-local' });
    }
  }

  const nextRepertoire = [...local.repertoire];
  const repertoireIndex = new Map(nextRepertoire.map((item, index) => [`${item.kind}:${item.id}`, index]));
  let addedRepertoire = 0;
  for (const item of incomingRepertoire) {
    const mapKey = `${item.kind}:${item.id}`;
    const index = repertoireIndex.get(mapKey);
    if (index === undefined) {
      repertoireIndex.set(mapKey, nextRepertoire.length);
      nextRepertoire.push(item);
      addedRepertoire += 1;
      continue;
    }
    const current = nextRepertoire[index];
    if (deepEqual(current, item)) {
      unchanged += 1;
      continue;
    }
    const localRevision = revisionOf(current);
    const incomingRevision = revisionOf(item);
    if (preferIncoming && incomingRevision > localRevision) {
      nextRepertoire[index] = item;
      overwritten += 1;
      conflicts.push({ area: 'repertoire', id: item.id, title: item.title, kind: item.kind, localRevision, incomingRevision, reason: '旧机 revision 更高，已按用户确认覆盖', resolution: 'used-incoming' });
    } else {
      conflicts.push({ area: 'repertoire', id: item.id, title: item.title, kind: item.kind, localRevision, incomingRevision, reason: '新机已有同名曲目且内容不同，未覆盖', resolution: 'kept-local' });
    }
  }

  const liveKeys = new Set([
    ...nextCatalog.map((item) => `DANCE:${item.id}`),
    ...nextRepertoire.map((item) => `${item.kind}:${item.id}`),
  ]);
  const nextTrash = [...local.trash];
  const trashIndex = new Map(nextTrash.map((item, index) => [`${item.kind}:${item.id}`, index]));
  let addedTrash = 0;
  for (const item of incomingTrash) {
    const mapKey = `${item.kind}:${item.id}`;
    if (liveKeys.has(mapKey)) {
      conflicts.push({ area: 'trash', id: item.id, kind: item.kind, reason: '旧机回收站标记指向新机仍在使用的曲目，未删除', resolution: 'kept-local' });
      continue;
    }
    const index = trashIndex.get(mapKey);
    if (index === undefined) {
      trashIndex.set(mapKey, nextTrash.length);
      nextTrash.push(item);
      addedTrash += 1;
      continue;
    }
    const current = nextTrash[index];
    if (deepEqual(current, item)) {
      unchanged += 1;
      continue;
    }
    const localRevision = revisionOf(current);
    const incomingRevision = revisionOf(item);
    if (preferIncoming && incomingRevision > localRevision) {
      nextTrash[index] = item;
      overwritten += 1;
      conflicts.push({ area: 'trash', id: item.id, kind: item.kind, localRevision, incomingRevision, reason: '旧机 revision 更高，已按用户确认覆盖回收站标记', resolution: 'used-incoming' });
    } else {
      conflicts.push({ area: 'trash', id: item.id, kind: item.kind, localRevision, incomingRevision, reason: '回收站标记不同，保留新机', resolution: 'kept-local' });
    }
  }

  let nextProgram = local.program;
  let addedProgram = false;
  if (incomingProgram) {
    if (!nextProgram) {
      nextProgram = incomingProgram;
      addedProgram = true;
    } else if (deepEqual(nextProgram, incomingProgram)) {
      unchanged += 1;
    } else if (preferIncoming && revisionOf(incomingProgram) > revisionOf(nextProgram)) {
      nextProgram = incomingProgram;
      overwritten += 1;
      conflicts.push({ area: 'program', id: 'program', localRevision: revisionOf(local.program), incomingRevision: revisionOf(incomingProgram), reason: '旧机节目单 revision 更高，已按用户确认覆盖', resolution: 'used-incoming' });
    } else {
      conflicts.push({ area: 'program', id: 'program', localRevision: revisionOf(nextProgram), incomingRevision: revisionOf(incomingProgram), reason: '新机节目单不同，未覆盖', resolution: 'kept-local' });
    }
  }

  const nextScorePages = { ...local.scorePages };
  let addedScorePages = 0;
  for (const [key, value] of Object.entries(state.scorePages)) {
    if (nextScorePages[key] === undefined) {
      nextScorePages[key] = value;
      addedScorePages += 1;
    } else if (nextScorePages[key] === value) {
      unchanged += 1;
    } else {
      // 页码没有 revision，任何覆盖都可能把新机进度改回旧页；只报告，不覆盖。
      conflicts.push({ area: 'score-page', id: key, localRevision: Number(nextScorePages[key]), incomingRevision: Number(value), reason: '新机已有谱面页码，未覆盖', resolution: 'kept-local' });
    }
  }

  return {
    catalog: nextCatalog,
    repertoire: nextRepertoire,
    trash: nextTrash,
    program: nextProgram,
    scorePages: nextScorePages,
    changes: {
      catalog: !deepEqual(nextCatalog, local.catalog),
      repertoire: !deepEqual(nextRepertoire, local.repertoire),
      trash: !deepEqual(nextTrash, local.trash),
      program: !deepEqual(nextProgram, local.program),
    },
    added: { catalog: addedCatalog, repertoire: addedRepertoire, trash: addedTrash, program: addedProgram, scorePages: addedScorePages },
    overwritten,
    unchanged,
    conflicts,
  };
}

/**
 * 只登记已完整接收且 hash/大小与旧机一致的文件；不覆盖新机同 key 的缓存映射。
 * 被隔离到 migration-inbox 的冲突文件按 conflict 报告，不能混进 skipped 里当作「已处理」。
 */
export function planCacheIndex(local: CachedIndex, state: MigrationState, files: MigrationFileResult[]): CachePlanOutcome {
  const conflicts: MigrationConflict[] = [];
  const skips: MigrationUnfinished[] = [];
  const byPath = new Map<string, MigrationFileResult>();
  const conflictByPath = new Map<string, MigrationFileResult>();
  const failedByPath = new Map<string, MigrationFileResult>();
  for (const file of files) {
    if ((file.status === 'received' || file.status === 'skipped') && file.destination === file.path) byPath.set(file.path, file);
    else if (file.status === 'conflict') conflictByPath.set(file.path, file);
    else if (file.status === 'failed') failedByPath.set(file.path, file);
  }
  const next: CachedIndex = { ...local };
  let added = 0;
  let unchanged = 0;
  let skipped = 0;
  for (const entry of state.cacheIndex) {
    const file = byPath.get(entry.path);
    if (!file) {
      const conflictFile = conflictByPath.get(entry.path);
      if (conflictFile) {
        conflicts.push({ area: 'cache', id: entry.key, reason: '新机已有同名文件且内容不同，旧机文件已隔离保存，未登记缓存', resolution: 'kept-local' });
        skips.push({ area: 'cache', id: entry.key, reason: '旧机缓存文件与新机同名文件冲突，已隔离保存' });
        continue;
      }
      const failedFile = failedByPath.get(entry.path);
      skipped += 1;
      skips.push({
        area: 'cache',
        id: entry.key,
        reason: failedFile
          ? `旧机缓存文件接收失败：${failedFile.error || '未知原因'}`
          : '旧机声明的缓存文件未出现在接收结果中（旧机可能已删除该文件）',
      });
      continue;
    }
    if (file.sizeBytes !== entry.sizeBytes || file.sha256 !== entry.sha256) {
      conflicts.push({ area: 'cache', id: entry.key, reason: '接收文件与旧机校验信息不一致，未登记缓存', resolution: 'kept-local' });
      skips.push({ area: 'cache', id: entry.key, reason: '接收文件的大小或摘要与旧机清单不一致' });
      continue;
    }
    if (!file.uri.startsWith('file://')) {
      conflicts.push({ area: 'cache', id: entry.key, reason: '接收文件没有本地 URI，未登记缓存', resolution: 'kept-local' });
      skips.push({ area: 'cache', id: entry.key, reason: '接收文件没有本地 URI' });
      continue;
    }
    const existing = local[entry.key];
    if (existing) {
      if (existing.sha256 === entry.sha256 && existing.path === entry.path) {
        unchanged += 1;
      } else {
        conflicts.push({ area: 'cache', id: entry.key, reason: '新机已有同一媒体的缓存映射，未覆盖', resolution: 'kept-local' });
        skips.push({ area: 'cache', id: entry.key, reason: '新机已有同一媒体的缓存映射，保留新机' });
      }
      continue;
    }
    next[entry.key] = {
      key: entry.key,
      sha256: entry.sha256,
      version: entry.version,
      sizeBytes: entry.sizeBytes,
      path: entry.path,
      uri: file.uri,
    };
    added += 1;
  }
  return { next, added, unchanged, skipped, conflicts, skips };
}

function mergeMissingById<T extends { id: string }>(current: T[], incoming: T[], keyOf: (item: T) => string = (item) => item.id): T[] {
  const seen = new Set(current.map(keyOf));
  const next = [...current];
  for (const item of incoming) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

function operationComparable(operation: MigrationOperation): Record<string, unknown> {
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    id: operation.id,
    action: operation.action,
    baseRevision: operation.baseRevision,
    fields: operation.fields,
    state: operation.state,
    error: operation.error,
    server: operation.server,
    serverRevision: operation.serverRevision,
  };
}

export interface OperationsPlan {
  added: MigrationOperation[];
  unchanged: number;
  conflicts: MigrationConflict[];
}

/**
 * 待同步操作按 operationId 幂等合并。
 * 同一幂等键但内容不同（包括状态、错误、服务器快照）一律保留新机，不静默覆盖。
 */
export function planOperations(local: LocalOperation[], incoming: MigrationOperation[]): OperationsPlan {
  const byId = new Map(local.map((operation) => [operation.operationId, operation]));
  const added: MigrationOperation[] = [];
  const conflicts: MigrationConflict[] = [];
  let unchanged = 0;
  for (const operation of incoming) {
    const existing = byId.get(operation.operationId);
    if (!existing) {
      added.push(operation);
      byId.set(operation.operationId, operation as unknown as LocalOperation);
      continue;
    }
    if (deepEqual(operationComparable(existing as unknown as MigrationOperation), operationComparable(operation))) {
      unchanged += 1;
      continue;
    }
    conflicts.push({
      area: 'operation',
      id: operation.operationId,
      title: operation.id,
      kind: operation.kind,
      reason: `新机已有同一幂等键的待同步操作（状态 ${existing.state || 'pending'}），未覆盖`,
      resolution: 'kept-local',
    });
  }
  return { added, unchanged, conflicts };
}

function pendingComparable(file: MigrationPendingFile): Record<string, unknown> {
  return {
    id: file.id, name: file.name, mime: file.mime, kind: file.kind, itemId: file.itemId,
    state: file.state, path: file.path, jobId: file.jobId, uploadId: file.uploadId,
    error: file.error, title: file.title, learningStatus: file.learningStatus,
    createFields: file.createFields, track: file.track, replace: file.replace, videoId: file.videoId,
  };
}

function receivedPaths(files: MigrationFileResult[]): Set<string> {
  return new Set(files
    .filter((file) => (file.status === 'received' || file.status === 'skipped')
      && file.destination === file.path && file.path.startsWith('dance-pending/'))
    .map((file) => file.path));
}

/**
 * 已核实可用的视频副本。新机只凭 sidecar 重建索引，所以「媒体文件到了」不等于「副本可用」：
 * 必须 sidecar 也到位、且 sidecar 自身记录 verified:true 与摘要，才能登记依赖它的待办/未完成收录。
 */
export interface VideoCopyVerification {
  verified: Set<string>;
  reasons: Map<string, string>;
}

export function noVerifiedVideoCopies(): VideoCopyVerification {
  return { verified: new Set(), reasons: new Map() };
}

const VIDEO_SIDECAR = /^dance-videos\/([A-Za-z0-9_-]{1,100})\.[A-Za-z0-9]{1,5}\.json$/;

function videoIdOfPath(path: string): string | undefined {
  if (!path.startsWith('dance-videos/')) return undefined;
  const base = path.slice('dance-videos/'.length);
  const dot = base.indexOf('.');
  if (dot <= 0) return undefined;
  const id = base.slice(0, dot);
  return SAFE_ID.test(id) ? id : undefined;
}

async function inspectVideoCopies(files: MigrationFileResult[]): Promise<VideoCopyVerification> {
  const verified = new Set<string>();
  const reasons = new Map<string, string>();
  const received = new Map<string, MigrationFileResult>();
  const conflicted = new Set<string>();
  for (const file of files) {
    if ((file.status === 'received' || file.status === 'skipped') && file.destination === file.path) received.set(file.path, file);
    else if (file.status === 'conflict') conflicted.add(file.path);
  }
  for (const path of received.keys()) {
    const match = VIDEO_SIDECAR.exec(path);
    if (!match) continue;
    const videoId = match[1];
    const mediaPath = path.slice(0, -'.json'.length);
    const media = received.get(mediaPath);
    if (!media) {
      reasons.set(videoId, '视频副本媒体文件未到位，只有 sidecar，未登记待办');
      continue;
    }
    try {
      const raw = await Filesystem.readFile({ path, directory: Directory.Data, encoding: Encoding.UTF8 });
      if (typeof raw.data !== 'string') throw new Error('sidecar 不是文本');
      const parsed = JSON.parse(raw.data) as unknown;
      if (!isRecord(parsed)) throw new Error('sidecar 格式无效');
      if (parsed.id !== videoId) throw new Error('sidecar 与视频文件名不一致');
      if (parsed.path !== mediaPath) throw new Error('sidecar 记录的路径与文件名不一致');
      if (parsed.verified !== true) throw new Error('旧机未核实该副本（缺少完整校验记录）');
      if (typeof parsed.checksum !== 'string' || parsed.checksum.length === 0) throw new Error('sidecar 缺少内容摘要');
      if (parsed.sizeBytes !== media.sizeBytes) throw new Error('sidecar 与媒体文件大小不一致');
      verified.add(videoId);
      reasons.delete(videoId);
    } catch (error) {
      reasons.set(videoId, `视频副本 sidecar 不可用：${error instanceof Error ? error.message : '格式无效'}`);
    }
  }
  for (const path of received.keys()) {
    if (path.endsWith('.json')) continue;
    const videoId = videoIdOfPath(path);
    if (!videoId || verified.has(videoId) || reasons.has(videoId)) continue;
    reasons.set(videoId, '视频副本缺少 sidecar，无法确认完整性，未登记待办');
  }
  for (const path of conflicted) {
    const videoId = videoIdOfPath(path);
    if (!videoId || verified.has(videoId)) continue;
    reasons.set(videoId, '视频副本在新机已有同名文件，已隔离保存，未核实，未登记待办');
  }
  return { verified, reasons };
}

export interface PendingFilesPlan {
  added: MigrationPendingFile[];
  unchanged: number;
  skipped: number;
  conflicts: MigrationConflict[];
  skips: MigrationUnfinished[];
}

/**
 * 待上传文件记录按 id 幂等合并；只有对应字节已完整接收（或新机已有同内容）才登记，
 * 避免新机出现「记录在、文件不在」的假待办。状态、jobId、uploadId、videoId 原样保留。
 * videoId 指向的私有副本必须由 sidecar 证明完整（verified:true），否则跳过并明确报告。
 */
export function planPendingFiles(
  local: PendingFile[],
  incoming: MigrationPendingFile[],
  files: MigrationFileResult[],
  videoCopies: VideoCopyVerification = noVerifiedVideoCopies(),
): PendingFilesPlan {
  const paths = receivedPaths(files);
  const conflictPaths = new Set(files.filter((file) => file.status === 'conflict').map((file) => file.path));
  const byId = new Map(local.map((file) => [file.id, file]));
  const uploadIds = new Set(local.map((file) => file.uploadId).filter((value): value is string => Boolean(value)));
  const videoIds = new Set(local.map((file) => file.videoId).filter((value): value is string => Boolean(value)));
  const added: MigrationPendingFile[] = [];
  const conflicts: MigrationConflict[] = [];
  const skips: MigrationUnfinished[] = [];
  let unchanged = 0;
  let skipped = 0;
  for (const file of incoming) {
    if (file.path && !paths.has(file.path)) {
      if (conflictPaths.has(file.path)) {
        conflicts.push({
          area: 'pending-file',
          id: file.id,
          title: file.name,
          reason: '对应文件在新机已有同名文件，旧机文件已隔离保存，未登记待办',
          resolution: 'kept-local',
        });
        skips.push({ area: 'pending-file', id: file.id, reason: '对应文件内容冲突，已隔离保存' });
      } else {
        skipped += 1;
        skips.push({ area: 'pending-file', id: file.id, reason: '对应的待上传文件未成功接收' });
      }
      continue;
    }
    if (file.videoId && !videoCopies.verified.has(file.videoId)) {
      skipped += 1;
      skips.push({
        area: 'pending-file',
        id: file.id,
        reason: videoCopies.reasons.get(file.videoId) || '视频副本未核实（缺少 sidecar），未登记待办',
      });
      continue;
    }
    if (!file.path && !file.videoId) {
      skipped += 1;
      skips.push({ area: 'pending-file', id: file.id, reason: '旧机记录只存在于内存，没有可迁移的文件副本' });
      continue;
    }
    const existing = byId.get(file.id);
    if (existing) {
      if (deepEqual(pendingComparable(existing as unknown as MigrationPendingFile), pendingComparable(file))) {
        unchanged += 1;
      } else {
        conflicts.push({
          area: 'pending-file',
          id: file.id,
          title: file.name,
          reason: '新机已有同一 id 的待上传记录且内容不同，未覆盖',
          resolution: 'kept-local',
        });
      }
      continue;
    }
    if (file.uploadId && uploadIds.has(file.uploadId)) {
      conflicts.push({
        area: 'pending-file',
        id: file.id,
        title: file.name,
        reason: '新机已有相同上传幂等键的记录，未重复登记',
        resolution: 'kept-local',
      });
      continue;
    }
    if (file.videoId && videoIds.has(file.videoId)) {
      conflicts.push({
        area: 'pending-file',
        id: file.id,
        title: file.name,
        reason: '新机已有同一视频副本的待上传记录，未重复登记',
        resolution: 'kept-local',
      });
      continue;
    }
    added.push(file);
    byId.set(file.id, file as unknown as PendingFile);
    if (file.uploadId) uploadIds.add(file.uploadId);
    if (file.videoId) videoIds.add(file.videoId);
  }
  return { added, unchanged, skipped, conflicts, skips };
}

export interface PendingImportsPlan {
  added: MigrationPendingImport[];
  unchanged: number;
  skipped: number;
  conflicts: MigrationConflict[];
  skips: MigrationUnfinished[];
}

function pendingImportComparable(item: MigrationPendingImport): Record<string, unknown> {
  return { jobId: item.jobId, name: item.name, createdAt: item.createdAt, videoId: item.videoId, sizeBytes: item.sizeBytes };
}

/**
 * 未完成的收录按 jobId 幂等合并：任务本体在服务器上，只有本地副本（videoId）必须已核实。
 * 新机已有同 jobId 的记录一律保留，不覆盖。
 */
export function planPendingImports(
  local: MigrationPendingImport[],
  incoming: MigrationPendingImport[],
  videoCopies: VideoCopyVerification = noVerifiedVideoCopies(),
): PendingImportsPlan {
  const byJob = new Map(local.map((item) => [item.jobId, item]));
  const added: MigrationPendingImport[] = [];
  const conflicts: MigrationConflict[] = [];
  const skips: MigrationUnfinished[] = [];
  let unchanged = 0;
  let skipped = 0;
  for (const item of incoming) {
    if (item.videoId && !videoCopies.verified.has(item.videoId)) {
      skipped += 1;
      skips.push({
        area: 'pending-import',
        id: item.jobId,
        reason: videoCopies.reasons.get(item.videoId) || '对应的视频副本未核实，未登记未完成收录',
      });
      continue;
    }
    const existing = byJob.get(item.jobId);
    if (existing) {
      if (deepEqual(pendingImportComparable(existing), pendingImportComparable(item))) {
        unchanged += 1;
      } else {
        conflicts.push({
          area: 'pending-import',
          id: item.jobId,
          title: item.name,
          reason: '新机已有同一收录任务的记录且内容不同，未覆盖',
          resolution: 'kept-local',
        });
      }
      continue;
    }
    if (local.length + added.length >= MAX_PENDING_IMPORTS) {
      skipped += 1;
      skips.push({ area: 'pending-import', id: item.jobId, reason: '新机的未完成收录已达上限 20 条，未再登记' });
      continue;
    }
    added.push(item);
    byJob.set(item.jobId, item);
  }
  return { added, unchanged, skipped, conflicts, skips };
}

async function writeRollbackBackup(local: LocalMigrationData): Promise<string> {
  const path = `migration-inbox/rollback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const manifest = readMetadata(OFFLINE_MANIFEST_KEY);
  const data = JSON.stringify({ createdAt: new Date().toISOString(), ...local, manifest });
  try {
    await Filesystem.mkdir({ path: 'migration-inbox', directory: Directory.Data, recursive: true }).catch(() => undefined);
    await Filesystem.writeFile({ path, directory: Directory.Data, data, encoding: Encoding.UTF8, recursive: true });
  } catch {
    throw new Error('无法写入回滚备份，已停止覆盖新机数据');
  }
  return path;
}

/**
 * 重建/补全离线清单：新机没有清单时按合并后的曲库快照生成，已有清单时只补缺失条目，
 * 不覆盖新机的播放列表与曲目内容。返回 null 表示无需写入。
 * 只搬版本与播放列表摘要，是因为清单曲目正文与 catalog/repertoire 快照重复，整份搬运会顶到 8MB 上限。
 */
function buildOfflineManifest(state: MigrationState, merged: MergeMigrationOutcome): string | null {
  const existingRaw = readMetadata(OFFLINE_MANIFEST_KEY);
  if (!existingRaw && !state.offlineManifest) return null;
  let manifest: Record<string, unknown> = {};
  let hasExisting = false;
  if (existingRaw) {
    try {
      const parsed = parseJson(existingRaw, OFFLINE_MANIFEST_KEY);
      if (isRecord(parsed)) {
        manifest = { ...parsed };
        hasExisting = true;
      }
    } catch {
      // 本机清单损坏时按「没有清单」处理：有旧机摘要就重建，否则不写，避免把坏数据继续传下去。
    }
  }
  if (!hasExisting && !state.offlineManifest) return null;
  // 没有本机清单、旧机也没迁来曲目时，不凭空写一份空清单（离线库会显示 0/0，反而误导）。
  if (!hasExisting && merged.catalog.length === 0 && merged.repertoire.length === 0) return null;
  const existingItems = Array.isArray(manifest.items) ? manifest.items as DanceItem[] : [];
  const existingRepertoire = Array.isArray(manifest.repertoire) ? manifest.repertoire as TalentItem[] : [];
  manifest.items = hasExisting ? mergeMissingById(existingItems, merged.catalog) : merged.catalog;
  manifest.repertoire = hasExisting
    ? mergeMissingById(existingRepertoire, merged.repertoire, (item) => `${item.kind}:${item.id}`)
    : merged.repertoire;
  const playlist = Array.isArray(manifest.playlist)
    ? manifest.playlist.filter((id): id is string => isSafeId(id)).slice(0, MAX_ITEMS)
    : [];
  const danceIds = new Set(merged.catalog.map((item) => item.id));
  const incomingPlaylist = (state.offlineManifest?.playlist ?? []).filter((id) => danceIds.has(id));
  manifest.playlist = playlist.length > 0 ? playlist : incomingPlaylist;
  const currentVersion = isRevision(manifest.catalogVersion) ? manifest.catalogVersion : 0;
  manifest.catalogVersion = Math.max(currentVersion, state.offlineManifest?.catalogVersion ?? 0);
  if (!manifest.program && merged.program) manifest.program = merged.program;
  const next = JSON.stringify(manifest);
  return next === existingRaw ? null : next;
}

/**
 * 将旧机快照写入新机。默认只补缺；preferIncoming=true 是用户明确点击后的覆盖动作，
 * 覆盖前先把新机现有快照写到 migration-inbox/rollback-*.json。
 */
export async function applyMigrationState(state: MigrationState, files: MigrationFileResult[], options: MergeMigrationOptions = {}): Promise<ApplyMigrationOutcome> {
  const local = readLocalMigrationData();
  const merged = mergeMigrationState(state, local, options);
  const backupPath = options.preferIncoming === true && merged.overwritten > 0 ? await writeRollbackBackup(local) : undefined;

  const values: Record<string, string> = {};
  if (merged.changes.catalog) values['dance.catalog-snapshot'] = JSON.stringify(merged.catalog);
  if (merged.changes.repertoire) values['dance.repertoire-snapshot'] = JSON.stringify(merged.repertoire);
  if (merged.changes.trash) values['dance.trash'] = JSON.stringify(merged.trash);
  if (merged.changes.program && merged.program) values['dance.program'] = JSON.stringify(merged.program);
  // 离线清单：新机没有时按合并结果重建，已有则只补缺；下次连服务器同步仍以服务器清单为准。
  const manifestValue = buildOfflineManifest(state, merged);
  if (manifestValue !== null) values[OFFLINE_MANIFEST_KEY] = manifestValue;
  if (Object.keys(values).length > 0) await commitLocal(values);

  // 视频副本必须先凭 sidecar 证明完整；媒体文件到位但 sidecar 缺失/未核实的不算可用。
  const pendingImportsIncoming = state.pendingImports ?? [];
  const needsVideoProof = state.pendingFiles.some((file) => file.videoId)
    || pendingImportsIncoming.some((item) => item.videoId);
  const videoCopies = needsVideoProof ? await inspectVideoCopies(files) : noVerifiedVideoCopies();

  // 待同步操作：保留原有 operationId（幂等键）、状态、错误与服务器快照；冲突只报告。
  const operationPlan = planOperations(await localOperations<LocalOperation>(), state.operations);
  if (operationPlan.added.length > 0) await commitLocal({}, operationPlan.added);

  // 待上传文件：只登记对应字节已在新机的记录；失败/阻塞/重复状态不被重置为 pending。
  const pendingPlan = planPendingFiles(await localFiles<PendingFile>(), state.pendingFiles, files, videoCopies);
  for (const file of pendingPlan.added) await saveLocalFile(file);

  // 未完成的收录：任务本体在服务器上，只有本地视频副本必须已核实；同 jobId 保留新机。
  const localImports = listPendingImports();
  const importPlan = planPendingImports(localImports, pendingImportsIncoming, videoCopies);
  if (importPlan.added.length > 0) {
    localStorage.setItem(
      PENDING_IMPORTS_KEY,
      JSON.stringify([...localImports, ...importPlan.added].slice(0, MAX_PENDING_IMPORTS)),
    );
    window.dispatchEvent(new Event('dance-pending-imports-changed'));
  }

  for (const [key, value] of Object.entries(merged.scorePages)) {
    if (local.scorePages[key] === undefined) localStorage.setItem(key, value);
  }

  const cache = planCacheIndex(readCachedIndex(), state, files);
  if (cache.added > 0) saveCachedIndex(cache.next);

  window.dispatchEvent(new Event('dance-catalog-changed'));
  window.dispatchEvent(new Event('dance-repertoire-changed'));
  window.dispatchEvent(new Event('dance-program-changed'));
  if (operationPlan.added.length > 0 || pendingPlan.added.length > 0 || importPlan.added.length > 0) {
    window.dispatchEvent(new Event('dance-sync-changed'));
    window.dispatchEvent(new Event('dance-files-changed'));
  }
  if (files.some((file) => file.path.startsWith('dance-videos/') && file.status !== 'failed')) {
    window.dispatchEvent(new Event('dance-videos-changed'));
  }

  const failedFiles = files.filter((file) => file.status === 'failed').length;
  const conflictFiles = files.filter((file) => file.status === 'conflict').length;
  const stateReceived = files.some((file) => file.path === 'migration-share/state.json' && file.status !== 'failed');

  // 冲突与遗漏必须逐条落到 incomplete：不能只数 failedFiles，否则「隔离保存」会被当成成功。
  const incomplete: MigrationUnfinished[] = [
    ...files.filter((file) => file.status === 'failed').map((file) => ({
      area: 'file' as const, id: file.path, reason: file.error || '文件接收失败',
    })),
    ...files.filter((file) => file.status === 'conflict').map((file) => ({
      area: 'file' as const, id: file.path, reason: file.error || '新机已有同名文件且内容不同，旧机文件已隔离保存',
    })),
    ...cache.skips,
    ...cache.conflicts.map((item) => ({ area: 'cache' as const, id: item.id, reason: item.reason })),
    ...pendingPlan.skips,
    ...pendingPlan.conflicts.map((item) => ({ area: 'pending-file' as const, id: item.id, reason: item.reason })),
    ...importPlan.skips,
    ...importPlan.conflicts.map((item) => ({ area: 'pending-import' as const, id: item.id, reason: item.reason })),
  ];
  const complete = failedFiles === 0 && conflictFiles === 0 && stateReceived
    && cache.skips.length === 0 && cache.conflicts.length === 0
    && pendingPlan.skips.length === 0 && pendingPlan.conflicts.length === 0
    && importPlan.skips.length === 0 && importPlan.conflicts.length === 0;

  return {
    ...merged,
    cacheAdded: cache.added,
    cacheUnchanged: cache.unchanged,
    cacheSkipped: cache.skipped,
    cacheConflicts: cache.conflicts,
    operationsAdded: operationPlan.added.length,
    operationsUnchanged: operationPlan.unchanged,
    operationsConflicts: operationPlan.conflicts,
    pendingFilesAdded: pendingPlan.added.length,
    pendingFilesUnchanged: pendingPlan.unchanged,
    pendingFilesSkipped: pendingPlan.skipped,
    pendingFilesConflicts: pendingPlan.conflicts,
    pendingImportsAdded: importPlan.added.length,
    pendingImportsUnchanged: importPlan.unchanged,
    pendingImportsSkipped: importPlan.skipped,
    pendingImportsConflicts: importPlan.conflicts,
    conflictFiles,
    failedFiles,
    incomplete,
    complete,
    backupPath,
  };
}

/** 新机：接收 → 校验 state.json → 默认安全合并（不覆盖）。 */
export async function receiveMigrationFromPeer(options: ReceiveMigrationOptions): Promise<MigrationImportOutcome> {
  const received = await Migration.receive(options);
  if (!received.statePath) throw new Error('旧手机没有返回迁移状态文件，本次未写入任何曲库数据');
  const raw = await Migration.readState({ path: received.statePath });
  const state = validateMigrationState(raw.stateJson);
  const applied = await applyMigrationState(state, received.files);
  return { received, state, applied };
}

/** 用户在冲突列表里明确点击后，才允许旧机 revision 更高的条目覆盖新机。 */
export function applyIncomingConflicts(state: MigrationState, files: MigrationFileResult[]): Promise<ApplyMigrationOutcome> {
  return applyMigrationState(state, files, { preferIncoming: true });
}
