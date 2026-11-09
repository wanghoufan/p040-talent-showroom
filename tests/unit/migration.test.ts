import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  applyMigrationState,
  collectMigrationState,
  mergeMigrationState,
  planCacheIndex,
  planOperations,
  planPendingFiles,
  planPendingImports,
  validateMigrationState,
  type LocalMigrationData,
  type MigrationFileResult,
  type MigrationOperation,
  type MigrationPendingFile,
  type MigrationPendingImport,
  type MigrationState,
  type VideoCopyVerification,
} from '../../src/lib/migration';
import { commitLocal, deleteLocalFile, initializeLocalDatabase, localFiles, localOperations, readMetadata, saveLocalFile, writeMetadata } from '../../src/lib/local-database';
import { readCachedIndex, saveCachedIndex } from '../../src/lib/offline-manifest';
import type { DanceItem, TalentItem } from '../../src/lib/types';
import type { LocalOperation } from '../../src/lib/offline-editing';
import type { PendingFile } from '../../src/lib/offline-files';

const disk = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    readFile: async ({ path }: { path: string }) => {
      const data = disk.files.get(path);
      if (data === undefined) throw Object.assign(Error('missing'), { code: 'OS-PLUG-FILE-0008' });
      return { data };
    },
    mkdir: async () => undefined,
    writeFile: async ({ path, data }: { path: string; data: string }) => { disk.files.set(path, String(data)); },
  },
}));

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);

function catalogItem(id: string, title: string, revision: number, learningStatus: DanceItem['learningStatus'] = 'PRACTICING'): DanceItem {
  return {
    id, title, artist: '', learningStatus, sceneTags: [], performanceClipId: `${id}-clip`,
    audio: { id: `${id}-audio`, url: `/api/media/audio/${id}`, sha256: A, sizeBytes: 10, version: 1 },
    durationMs: 1000, revision,
  };
}

function vocalItem(id: string, title: string, revision: number, learningStatus: TalentItem['learningStatus'] = 'CAN_DANCE'): TalentItem {
  return {
    id, kind: 'VOCAL', title, artist: '', learningStatus, originalKey: '', performanceKey: '', capo: 0,
    scoreText: '', notes: '', audioRole: 'REFERENCE', durationMs: 1000, revision,
  };
}

function stateOf(overrides: Partial<MigrationState> = {}): MigrationState {
  return {
    schema: 1, createdAt: '2026-11-09T00:00:00.000Z', metadata: {}, cacheIndex: [], scorePages: {},
    operations: [], pendingFiles: [], pendingImports: [], ...overrides,
  };
}

function verifiedCopies(...ids: string[]): VideoCopyVerification {
  return { verified: new Set(ids), reasons: new Map() };
}

function fileOf(overrides: Partial<MigrationFileResult>): MigrationFileResult {
  const path = overrides.path ?? 'dance-offline/audio-00000001.audio';
  return {
    path,
    destination: overrides.destination ?? path,
    uri: 'file:///data/user/0/com.wanghoufan.dancelibrary/files/dance-offline/audio-00000001.audio',
    status: 'received', error: '', retryable: false, sizeBytes: 10, sha256: A,
    ...overrides,
  };
}

function localOf(overrides: Partial<LocalMigrationData> = {}): LocalMigrationData {
  return { catalog: [], repertoire: [], trash: [], program: null, scorePages: {}, ...overrides };
}

beforeEach(() => { localStorage.clear(); disk.files.clear(); });

describe('旧机迁移快照收集', () => {
  it('只导出白名单曲库数据，不包含 owner token / 设备地址', async () => {
    localStorage.setItem('dance.catalog-snapshot', JSON.stringify([catalogItem('d1', '旧舞', 3)]));
    localStorage.setItem('dance.repertoire-snapshot', JSON.stringify([vocalItem('v1', '旧歌', 2)]));
    localStorage.setItem('dance.trash', '[]');
    localStorage.setItem('dance.program', JSON.stringify({ revision: 1, items: [{ kind: 'DANCE', id: 'd1' }] }));
    localStorage.setItem('dance.offline.cache', JSON.stringify({
      '/api/media/audio/d1': {
        key: '/api/media/audio/d1', sha256: A, version: 1, sizeBytes: 10,
        path: 'dance-offline/audio-00000001.audio', uri: 'file:///old/audio',
      },
    }));
    localStorage.setItem('dance.score-page.asset-1', '3');
    localStorage.setItem('dance.owner-token', 'secret-owner-token');
    localStorage.setItem('dance.device-settings', JSON.stringify({ themeMode: 'dark', apiEndpoint: 'http://192.168.1.9:1' }));

    const { state, warnings } = await collectMigrationState();
    const serialized = JSON.stringify(state);

    expect(warnings).toEqual([]);
    expect(state.metadata['dance.catalog-snapshot']).toContain('旧舞');
    expect(state.metadata['dance.repertoire-snapshot']).toContain('旧歌');
    expect(state.cacheIndex).toEqual([{
      key: '/api/media/audio/d1', path: 'dance-offline/audio-00000001.audio', sha256: A, version: 1, sizeBytes: 10,
    }]);
    expect(state.scorePages['dance.score-page.asset-1']).toBe('3');
    expect(serialized).not.toContain('secret-owner-token');
    expect(serialized).not.toContain('dance.owner-token');
    expect(serialized).not.toContain('dance.device-settings');
    expect(serialized).not.toContain('192.168.1.9');
  });

  it('本地曲库 JSON 损坏时停止导出，不把坏数据发给新机', async () => {
    localStorage.setItem('dance.catalog-snapshot', '{bad json');
    await expect(collectMigrationState()).rejects.toThrow(/不是有效 JSON/);
  });

  it('缓存路径不在 dance-offline 时跳过并给出警告', async () => {
    localStorage.setItem('dance.offline.cache', JSON.stringify({
      '/api/media/audio/x': {
        key: '/api/media/audio/x', sha256: A, version: 1, sizeBytes: 10,
        path: '../outside.mp4', uri: 'file:///old/x',
      },
    }));
    const { state, warnings } = await collectMigrationState();
    expect(state.cacheIndex).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});

describe('新机迁移输入校验', () => {
  it('拒绝登录凭据字段', () => {
    expect(() => validateMigrationState(stateOf({ metadata: { 'dance.owner-token': 'secret' } as never }))).toThrow(/登录凭据/);
  });

  it('拒绝路径穿越、非法 hash 与非法页码', () => {
    expect(() => validateMigrationState(stateOf({
      cacheIndex: [{ key: '/api/media/audio/a', path: '../escape.mp4', sha256: A, version: 1, sizeBytes: 1 }],
    }))).toThrow(/路径无效/);
    expect(() => validateMigrationState(stateOf({
      cacheIndex: [{ key: '/api/media/audio/a', path: 'dance-offline/a.mp4', sha256: 'z'.repeat(64), version: 1, sizeBytes: 1 }],
    }))).toThrow(/校验信息无效/);
    expect(() => validateMigrationState(stateOf({ scorePages: { 'dance.score-page.x': '0' } }))).toThrow(/页码无效/);
  });

  it('拒绝非数组曲库与错误协议版本', () => {
    expect(() => validateMigrationState({ ...stateOf(), schema: 2 })).toThrow(/版本不兼容/);
    expect(() => validateMigrationState(stateOf({ metadata: { 'dance.catalog-snapshot': '{"not":"array"}' } }))).toThrow(/格式/);
  });

  it('接受合法快照并丢弃未知顶层字段', () => {
    const validated = validateMigrationState({
      ...stateOf({
        metadata: { 'dance.catalog-snapshot': JSON.stringify([catalogItem('d1', '歌', 1)]) },
        cacheIndex: [{ key: '/api/media/audio/d1', path: 'dance-offline/audio-1.audio', sha256: A, version: 1, sizeBytes: 10 }],
        scorePages: { 'dance.score-page.asset-1': '12' },
      }),
      extra: 'ignored',
    });
    expect(Object.keys(validated).sort()).toEqual(['cacheIndex', 'createdAt', 'metadata', 'operations', 'pendingFiles', 'pendingImports', 'schema', 'scorePages']);
    expect(validated.schema).toBe(1);
  });
});

describe('迁移合并：默认不覆盖新机', () => {
  it('补入缺失曲目，冲突项保留新机数据并报告', () => {
    const local = localOf({ catalog: [catalogItem('d1', '新机版本', 5, 'CAN_DANCE')] });
    const state = stateOf({
      metadata: {
        'dance.catalog-snapshot': JSON.stringify([catalogItem('d1', '旧机版本', 9, 'WANT_TO_LEARN'), catalogItem('d2', '旧机新增', 2)]),
      },
    });
    const merged = mergeMigrationState(state, local);

    expect(merged.catalog.map((item) => item.title)).toEqual(['新机版本', '旧机新增']);
    expect(merged.added.catalog).toBe(1);
    expect(merged.overwritten).toBe(0);
    expect(merged.conflicts).toHaveLength(1);
    expect(merged.conflicts[0]).toMatchObject({ area: 'catalog', id: 'd1', resolution: 'kept-local' });
  });

  it('用户确认后只覆盖旧机 revision 更高的条目', () => {
    const local = localOf({ catalog: [catalogItem('d1', '新机版本', 5), catalogItem('d2', '新机更新', 8)] });
    const state = stateOf({
      metadata: {
        'dance.catalog-snapshot': JSON.stringify([catalogItem('d1', '旧机版本', 9), catalogItem('d2', '旧机旧版', 4)]),
      },
    });
    const merged = mergeMigrationState(state, local, { preferIncoming: true });

    expect(merged.catalog.find((item) => item.id === 'd1')?.title).toBe('旧机版本');
    expect(merged.catalog.find((item) => item.id === 'd2')?.title).toBe('新机更新');
    expect(merged.overwritten).toBe(1);
    expect(merged.conflicts[0].resolution).toBe('used-incoming');
    expect(merged.conflicts[1].resolution).toBe('kept-local');
  });

  it('旧机回收站标记不会删除新机仍在使用的曲目', () => {
    const local = localOf({ catalog: [catalogItem('d1', '新机在用', 3)] });
    const state = stateOf({
      metadata: {
        'dance.trash': JSON.stringify([{ kind: 'DANCE', id: 'd1', revision: 99, title: '已删' }]),
      },
    });
    const merged = mergeMigrationState(state, local, { preferIncoming: true });
    expect(merged.catalog).toHaveLength(1);
    expect(merged.trash).toHaveLength(0);
    expect(merged.conflicts[0]).toMatchObject({ area: 'trash', resolution: 'kept-local' });
  });

  it('节目单冲突保留新机；谱面页码只补缺不覆盖', () => {
    const local = localOf({
      program: { revision: 2, items: [{ kind: 'DANCE', id: 'd1' }] },
      scorePages: { 'dance.score-page.asset-1': '8' },
    });
    const state = stateOf({
      metadata: { 'dance.program': JSON.stringify({ revision: 1, items: [{ kind: 'DANCE', id: 'd9' }] }) },
      scorePages: { 'dance.score-page.asset-1': '2', 'dance.score-page.asset-2': '4' },
    });
    const merged = mergeMigrationState(state, local, { preferIncoming: true });

    expect(merged.program).toEqual(local.program);
    expect(merged.scorePages).toEqual({ 'dance.score-page.asset-1': '8', 'dance.score-page.asset-2': '4' });
    expect(merged.conflicts.map((item) => item.area)).toEqual(['program', 'score-page']);
  });
});

describe('缓存索引登记', () => {
  it('只登记已完整接收且 hash/大小一致的文件，不覆盖新机同 key 映射', () => {
    const state = stateOf({
      cacheIndex: [
        { key: '/api/media/audio/a', path: 'dance-offline/audio-1.audio', sha256: A, version: 1, sizeBytes: 10 },
        { key: '/api/media/reference/b', path: 'dance-offline/reference-2.mp4', sha256: B, version: 1, sizeBytes: 20 },
        { key: '/api/media/audio/c', path: 'dance-offline/audio-3.audio', sha256: C, version: 1, sizeBytes: 30 },
        { key: '/api/media/audio/d', path: 'dance-offline/audio-4.audio', sha256: D, version: 1, sizeBytes: 40 },
      ],
    });
    const local = {
      '/api/media/audio/a': {
        key: '/api/media/audio/a', sha256: B, version: 1, sizeBytes: 10,
        path: 'dance-offline/audio-9.audio', uri: 'file:///old/a',
      },
    };
    const files = [
      fileOf({ path: 'dance-offline/audio-1.audio', status: 'received', sizeBytes: 10, sha256: A }),
      fileOf({ path: 'dance-offline/reference-2.mp4', status: 'conflict', sizeBytes: 20, sha256: B }),
      fileOf({ path: 'dance-offline/audio-3.audio', status: 'received', sizeBytes: 31, sha256: C }),
      fileOf({ path: 'dance-offline/audio-4.audio', status: 'received', sizeBytes: 40, sha256: D, uri: 'file:///new/d' }),
    ];
    const planned = planCacheIndex(local, state, files);

    expect(planned.added).toBe(1);
    expect(planned.next['/api/media/audio/d']).toMatchObject({ path: 'dance-offline/audio-4.audio', uri: 'file:///new/d' });
    expect(planned.next['/api/media/audio/a']).toEqual(local['/api/media/audio/a']);
    // 冲突隔离的文件必须按 conflict 报告，不能混进 skipped 当作已处理。
    expect(planned.skipped).toBe(0);
    expect(planned.conflicts).toHaveLength(3);
    expect(planned.conflicts.map((item) => item.reason)).toEqual([
      '新机已有同一媒体的缓存映射，未覆盖',
      '新机已有同名文件且内容不同，旧机文件已隔离保存，未登记缓存',
      '接收文件与旧机校验信息不一致，未登记缓存',
    ]);
    expect(planned.skips).toHaveLength(3);
  });
});

describe('写回合并结果（默认不覆盖新机）', () => {
  beforeEach(async () => {
    await initializeLocalDatabase();
  });

  it('只把缺失曲目与已接收文件写进新机，冲突曲目保持原值', async () => {
    await commitLocal({ 'dance.catalog-snapshot': JSON.stringify([catalogItem('d1', '新机版本', 5)]) });
    saveCachedIndex({});
    const state = stateOf({
      metadata: {
        'dance.catalog-snapshot': JSON.stringify([catalogItem('d1', '旧机版本', 9), catalogItem('d2', '旧机新增', 2)]),
      },
      cacheIndex: [{ key: '/api/media/audio/d2', path: 'dance-offline/audio-d2.audio', sha256: A, version: 1, sizeBytes: 10 }],
    });
    const files = [fileOf({ path: 'dance-offline/audio-d2.audio', sizeBytes: 10, sha256: A, uri: 'file:///new/d2' })];

    const applied = await applyMigrationState(state, files);
    const saved = JSON.parse(readMetadata('dance.catalog-snapshot') || '[]') as DanceItem[];

    expect(saved.map((item) => item.title)).toEqual(['新机版本', '旧机新增']);
    expect(saved.find((item) => item.id === 'd1')?.learningStatus).toBe('PRACTICING');
    expect(applied.added.catalog).toBe(1);
    expect(applied.conflicts).toHaveLength(1);
    expect(applied.cacheAdded).toBe(1);
    expect(readCachedIndex()['/api/media/audio/d2']).toMatchObject({
      path: 'dance-offline/audio-d2.audio', sha256: A, sizeBytes: 10, uri: 'file:///new/d2',
    });
  });
});

const OP_ID = '0f7c2a1e-1b2c-4d5e-8f90-123456789abc';
const OP_ID_2 = '1a2b3c4d-5e6f-4a8b-9c0d-abcdefabcdef';

async function clearLocalQueues(): Promise<void> {
  await initializeLocalDatabase();
  const operations = await localOperations<LocalOperation>();
  await commitLocal({}, [], operations.map((operation) => operation.operationId));
  for (const file of await localFiles<PendingFile>()) await deleteLocalFile(file.id);
}

/** 每个用例从「全新新机」开始：清空曲库快照、清单、队列与待完成收录。 */
async function resetMigrationStore(): Promise<void> {
  await clearLocalQueues();
  await commitLocal({
    'dance.catalog-snapshot': '[]',
    'dance.repertoire-snapshot': '[]',
    'dance.trash': '[]',
    'dance.offline.manifest': '',
    'dance.program': '',
  });
  localStorage.clear();
  localStorage.setItem('dance.offline.cache', '{}');
  disk.files.clear();
}

function operationOf(overrides: Partial<MigrationOperation> = {}): MigrationOperation {
  return {
    operationId: OP_ID,
    kind: 'VOCAL',
    id: 'v1',
    action: 'update',
    baseRevision: 3,
    fields: { lyrics: [{ text: '旧机改词' }] },
    state: 'pending',
    createdAt: 1_760_000_000_000_000,
    ...overrides,
  };
}

function pendingFileOf(overrides: Partial<MigrationPendingFile> = {}): MigrationPendingFile {
  return {
    id: '3f2a1b0c-1111-4222-8333-444455556666',
    name: '伴奏.mp3',
    mime: 'audio/mpeg',
    kind: 'VOCAL',
    itemId: 'v1',
    state: 'pending',
    path: 'dance-pending/3f2a1b0c-1111-4222-8333-444455556666',
    uploadId: '3f2a1b0c-1111-4222-8333-444455556666',
    ...overrides,
  };
}

describe('待同步 operations 迁移', () => {
  beforeEach(clearLocalQueues);

  it('校验幂等键、动作、状态，并拒绝夹带登录凭据', () => {
    expect(() => validateMigrationState(stateOf({ operations: [operationOf({ operationId: 'x' })] }))).toThrow(/幂等键/);
    expect(() => validateMigrationState(stateOf({ operations: [operationOf({ action: 'delete' as never })] }))).toThrow(/动作/);
    expect(() => validateMigrationState(stateOf({ operations: [operationOf({ state: 'done' as never })] }))).toThrow(/状态/);
    expect(() => validateMigrationState(stateOf({
      operations: [operationOf({ fields: { 'dance.owner-token': 'secret' } })],
    }))).toThrow(/登录凭据/);
    expect(() => validateMigrationState(stateOf({ operations: [operationOf(), operationOf()] }))).toThrow(/重复/);
  });

  it('按 operationId 幂等合并；同键不同内容保留新机状态，不覆盖', () => {
    const local = [{
      operationId: OP_ID, kind: 'VOCAL' as const, id: 'v1', action: 'update' as const,
      baseRevision: 3, fields: { lyrics: [{ text: '新机版本' }] }, state: 'failed' as const,
      error: '服务器拒绝', createdAt: 1,
    }];
    const plan = planOperations(local, [
      operationOf({ state: 'pending', fields: { lyrics: [{ text: '旧机版本' }] } }),
      operationOf({ operationId: OP_ID_2, id: 'v2', state: 'conflict', server: { title: '远端' }, serverRevision: 7 }),
    ]);

    expect(plan.added).toHaveLength(1);
    expect(plan.added[0].operationId).toBe(OP_ID_2);
    expect(plan.added[0].state).toBe('conflict');
    expect(plan.added[0].serverRevision).toBe(7);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({ area: 'operation', id: OP_ID, resolution: 'kept-local' });
  });

  it('完全相同只计已存在，不重复写', () => {
    const operation = operationOf();
    const plan = planOperations([operation as unknown as LocalOperation], [operation]);
    expect(plan.added).toHaveLength(0);
    expect(plan.unchanged).toBe(1);
    expect(plan.conflicts).toHaveLength(0);
  });

  it('写回时保留 operationId、状态、错误与 createdAt，冲突不覆盖', async () => {
    await initializeLocalDatabase();
    await commitLocal({}, [{
      operationId: OP_ID, kind: 'VOCAL', id: 'v1', action: 'update', baseRevision: 3,
      fields: { lyrics: [{ text: '新机版本' }] }, state: 'failed', error: '新机失败', createdAt: 1,
    }]);
    const state = stateOf({
      operations: [
        operationOf({ state: 'pending', fields: { lyrics: [{ text: '旧机版本' }] } }),
        operationOf({ operationId: OP_ID_2, id: 'v2', state: 'failed', error: '旧机失败' }),
      ],
    });
    const applied = await applyMigrationState(state, []);
    const saved = await localOperations<LocalOperation>();

    expect(applied.operationsAdded).toBe(1);
    expect(applied.operationsConflicts).toHaveLength(1);
    expect(saved).toHaveLength(2);
    expect(saved.find((op) => op.operationId === OP_ID)?.error).toBe('新机失败');
    expect(saved.find((op) => op.operationId === OP_ID)?.state).toBe('failed');
    expect(saved.find((op) => op.operationId === OP_ID_2)).toMatchObject({
      state: 'failed', error: '旧机失败', baseRevision: 3,
    });
  });
});

describe('待上传文件迁移', () => {
  beforeEach(clearLocalQueues);

  const pendingPath = `dance-pending/${pendingFileOf().id}`;

  it('只有对应文件已接收或已存在时才登记；状态与幂等键原样保留', () => {
    const plan = planPendingFiles([], [
      pendingFileOf({ state: 'blocked', error: '等待歌词同步', jobId: 'job-1' }),
      pendingFileOf({ id: '3f2a1b0c-1111-4222-8333-444455556667', path: undefined, videoId: 'video-1', state: 'failed', uploadId: 'upload-video-1' }),
    ], [
      fileOf({ path: pendingPath, destination: pendingPath, status: 'received' }),
      fileOf({
        path: 'dance-videos/video-1.mp4', destination: 'dance-videos/video-1.mp4',
        status: 'skipped', sizeBytes: 20, sha256: B,
      }),
    ], verifiedCopies('video-1'));

    expect(plan.added).toHaveLength(2);
    expect(plan.added[0]).toMatchObject({ state: 'blocked', error: '等待歌词同步', jobId: 'job-1', uploadId: pendingFileOf().uploadId });
    expect(plan.added[1]).toMatchObject({ state: 'failed', videoId: 'video-1' });
    expect(plan.skipped).toBe(0);
  });

  it('文件冲突按 conflict 报告；视频缺少 sidecar 核实或只存在内存时跳过并给出原因', () => {
    const plan = planPendingFiles([], [
      pendingFileOf(),
      pendingFileOf({ id: '3f2a1b0c-1111-4222-8333-444455556667', path: undefined, videoId: 'video-1' }),
      pendingFileOf({ id: '3f2a1b0c-1111-4222-8333-444455556668', path: undefined, videoId: undefined }),
    ], [
      fileOf({ path: pendingPath, destination: `migration-inbox/conflicts/${pendingPath}`, status: 'conflict' }),
      fileOf({
        path: 'dance-videos/video-1.mp4', destination: 'dance-videos/video-1.mp4',
        status: 'received', sizeBytes: 20, sha256: B,
      }),
    ]);
    expect(plan.added).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].reason).toContain('已隔离保存');
    expect(plan.skipped).toBe(2);
    expect(plan.skips.map((item) => item.area)).toEqual(['pending-file', 'pending-file', 'pending-file']);
    expect(plan.skips[1].reason).toContain('缺少 sidecar');
  });

  it('同 id 内容不同、或同 uploadId 已在新机时保留新机，不覆盖', () => {
    const local: PendingFile[] = [{
      id: pendingFileOf().id, name: '新机同名.mp3', mime: 'audio/mpeg', kind: 'VOCAL', itemId: 'v1',
      state: 'failed', path: pendingPath, uploadId: 'other-upload', error: '新机失败',
    }];
    const plan = planPendingFiles(local, [
      pendingFileOf({ state: 'pending' }),
      pendingFileOf({
        id: '3f2a1b0c-1111-4222-8333-444455556667', uploadId: 'other-upload', path: undefined,
        videoId: 'video-2',
      }),
    ], [
      fileOf({ path: pendingPath, destination: pendingPath, status: 'received' }),
      fileOf({
        path: 'dance-videos/video-2.mp4', destination: 'dance-videos/video-2.mp4',
        status: 'received', sizeBytes: 20, sha256: B,
      }),
    ], verifiedCopies('video-2'));

    expect(plan.added).toHaveLength(0);
    expect(plan.conflicts.map((item) => item.reason)).toEqual([
      '新机已有同一 id 的待上传记录且内容不同，未覆盖',
      '新机已有相同上传幂等键的记录，未重复登记',
    ]);
  });

  it('旧机收集时导出 operations 与待上传记录，状态不丢失', async () => {
    await initializeLocalDatabase();
    await commitLocal({}, [{
      operationId: OP_ID, kind: 'VOCAL', id: 'v1', action: 'update', baseRevision: 3,
      fields: { notes: '旧机修改' }, state: 'conflict', error: '冲突待选', server: { title: '远端' },
      serverRevision: 5, createdAt: 1_760_000_000_000_000,
    }]);
    await saveLocalFile(pendingFileOf({ state: 'blocked', jobId: 'job-1' }));
    const { state } = await collectMigrationState();

    expect(state.operations).toHaveLength(1);
    expect(state.operations[0]).toMatchObject({
      operationId: OP_ID, state: 'conflict', error: '冲突待选', serverRevision: 5, createdAt: 1_760_000_000_000_000,
    });
    expect(state.pendingFiles).toHaveLength(1);
    expect(state.pendingFiles[0]).toMatchObject({ id: pendingFileOf().id, state: 'blocked', jobId: 'job-1', uploadId: pendingFileOf().uploadId });
    expect(JSON.stringify(state)).not.toContain('dance.owner-token');
  });

  it('写回时只为已接收文件登记待上传记录', async () => {
    await initializeLocalDatabase();
    const state = stateOf({ pendingFiles: [pendingFileOf({ state: 'failed', error: '旧机失败' })] });
    const applied = await applyMigrationState(state, [
      fileOf({ path: pendingPath, destination: pendingPath, status: 'received' }),
    ]);
    const saved = await localFiles<PendingFile>();

    expect(applied.pendingFilesAdded).toBe(1);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      id: pendingFileOf().id, state: 'failed', error: '旧机失败', uploadId: pendingFileOf().uploadId,
    });
  });
});

const STATE_PATH = 'migration-share/state.json';

function stateFileOf(): MigrationFileResult {
  return fileOf({ path: STATE_PATH, destination: STATE_PATH, status: 'received', sizeBytes: 100, sha256: C });
}

function videoMediaOf(videoId: string, sizeBytes = 20): MigrationFileResult {
  const path = `dance-videos/${videoId}.mp4`;
  return fileOf({ path, destination: path, status: 'received', sizeBytes, sha256: B });
}

function videoSidecarOf(videoId: string, body: Record<string, unknown>): MigrationFileResult {
  const path = `dance-videos/${videoId}.mp4.json`;
  disk.files.set(path, JSON.stringify({ id: videoId, path: `dance-videos/${videoId}.mp4`, sizeBytes: 20, ...body }));
  return fileOf({ path, destination: path, status: 'received', sizeBytes: JSON.stringify(body).length, sha256: D });
}

describe('A1 视频副本 sidecar 完整性', () => {
  beforeEach(resetMigrationStore);

  it('媒体文件到位但 sidecar 未核实时不登记待办，并报告原因', async () => {
    const state = stateOf({
      pendingFiles: [pendingFileOf({ path: undefined, videoId: 'video-1', uploadId: 'upload-video-1' })],
    });
    const applied = await applyMigrationState(state, [
      stateFileOf(), videoMediaOf('video-1'), videoSidecarOf('video-1', { verified: false }),
    ]);
    const saved = await localFiles<PendingFile>();

    expect(saved).toHaveLength(0);
    expect(applied.pendingFilesAdded).toBe(0);
    expect(applied.pendingFilesSkipped).toBe(1);
    expect(applied.complete).toBe(false);
    expect(applied.incomplete.some((item) => item.reason.includes('未核实'))).toBe(true);
  });

  it('sidecar verified:true 且大小一致时才登记待办与未完成收录', async () => {
    const media = videoMediaOf('video-2');
    const state = stateOf({
      pendingFiles: [pendingFileOf({ id: '3f2a1b0c-1111-4222-8333-444455556667', path: undefined, videoId: 'video-2', uploadId: 'upload-video-2' })],
      pendingImports: [{ jobId: 'job-video-2', name: '旧机舞蹈', videoId: 'video-2' }],
      offlineManifest: { catalogVersion: 1, playlist: [] },
    });
    const sidecarPath = 'dance-videos/video-2.mp4.json';
    disk.files.set(sidecarPath, JSON.stringify({
      id: 'video-2', path: 'dance-videos/video-2.mp4', sizeBytes: 20, verified: true, checksum: 'abc123',
    }));
    const sidecar = fileOf({ path: sidecarPath, destination: sidecarPath, status: 'received', sizeBytes: 200, sha256: D });

    const applied = await applyMigrationState(state, [stateFileOf(), media, sidecar]);
    const saved = await localFiles<PendingFile>();
    const imports = JSON.parse(localStorage.getItem('dance.pending-imports.v1') || '[]') as MigrationPendingImport[];

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ videoId: 'video-2' });
    expect(applied.pendingFilesAdded).toBe(1);
    expect(applied.incomplete.filter((item) => item.area === 'file')).toEqual([]);
    expect(applied.pendingImportsAdded).toBe(1);
    expect(imports[0]).toMatchObject({ jobId: 'job-video-2', videoId: 'video-2' });
    expect(applied.complete).toBe(true);
  });

  it('视频副本文件被隔离保存时不登记，按冲突报告', async () => {
    const state = stateOf({
      pendingFiles: [pendingFileOf({ path: undefined, videoId: 'video-3', uploadId: 'upload-video-3' })],
    });
    const media = fileOf({
      path: 'dance-videos/video-3.mp4', destination: 'migration-inbox/conflicts/dance-videos/video-3.mp4',
      status: 'conflict', sizeBytes: 20, sha256: B,
    });
    const applied = await applyMigrationState(state, [stateFileOf(), media]);
    expect(applied.pendingFilesAdded).toBe(0);
    expect(applied.pendingFilesSkipped).toBe(1);
    expect(applied.complete).toBe(false);
  });
});

describe('B1 离线清单迁移与重建', () => {
  beforeEach(resetMigrationStore);

  it('旧机导出清单摘要（只带版本与播放列表）', async () => {
    writeMetadata('dance.offline.manifest', JSON.stringify({
      catalogVersion: 7, items: [{ id: 'd1' }], playlist: ['d1', 'd9'], repertoire: [],
    }));
    const { state, warnings } = await collectMigrationState();
    expect(warnings).toEqual([]);
    expect(state.offlineManifest).toEqual({ catalogVersion: 7, playlist: ['d1', 'd9'] });
  });

  it('全新新机迁移后按合并结果重建清单，离线库不再显示 0/0', async () => {
    const state = stateOf({
      metadata: { 'dance.catalog-snapshot': JSON.stringify([catalogItem('d1', '旧舞', 2)]) },
      offlineManifest: { catalogVersion: 7, playlist: ['d1'] },
    });
    const applied = await applyMigrationState(state, [stateFileOf()]);
    const manifest = JSON.parse(readMetadata('dance.offline.manifest') || 'null') as {
      catalogVersion: number; items: DanceItem[]; repertoire: TalentItem[]; playlist: string[];
    };

    expect(manifest.items.map((item) => item.id)).toEqual(['d1']);
    expect(manifest.repertoire).toEqual([]);
    expect(manifest.playlist).toEqual(['d1']);
    expect(manifest.catalogVersion).toBe(7);
    expect(applied.complete).toBe(true);
  });

  it('新机已有清单时只补缺，不覆盖已有曲目、播放列表与更高版本号', async () => {
    await commitLocal({
      'dance.offline.manifest': JSON.stringify({
        catalogVersion: 9, items: [catalogItem('d1', '新机舞', 5)], repertoire: [], playlist: ['d1'],
      }),
    });
    const state = stateOf({
      metadata: {
        'dance.catalog-snapshot': JSON.stringify([catalogItem('d1', '旧机舞', 9), catalogItem('d2', '旧机新增', 2)]),
      },
      offlineManifest: { catalogVersion: 3, playlist: ['d2'] },
    });
    await applyMigrationState(state, [stateFileOf()]);
    const manifest = JSON.parse(readMetadata('dance.offline.manifest') || 'null') as {
      catalogVersion: number; items: DanceItem[]; playlist: string[];
    };

    expect(manifest.items.map((item) => item.title)).toEqual(['新机舞', '旧机新增']);
    expect(manifest.playlist).toEqual(['d1']);
    expect(manifest.catalogVersion).toBe(9);
  });

  it('旧机清单损坏时只给警告，不阻断曲库迁移', async () => {
    writeMetadata('dance.offline.manifest', '{bad json');
    const { state, warnings } = await collectMigrationState();
    expect(state.offlineManifest).toBeUndefined();
    expect(warnings.some((item) => item.includes('离线清单'))).toBe(true);
  });
});

describe('C3 未完成的收录迁移', () => {
  beforeEach(resetMigrationStore);

  it('校验任务 id、名称与视频 id，并拒绝重复任务', () => {
    expect(() => validateMigrationState(stateOf({ pendingImports: [{ jobId: 'bad id', name: 'a' }] }))).toThrow(/任务 id/);
    expect(() => validateMigrationState(stateOf({ pendingImports: [{ jobId: 'job-1', name: '' }] }))).toThrow(/名称/);
    expect(() => validateMigrationState(stateOf({ pendingImports: [{ jobId: 'job-1', name: 'a', videoId: '../x' }] }))).toThrow(/视频 id/);
    expect(() => validateMigrationState(stateOf({
      pendingImports: [{ jobId: 'job-1', name: 'a' }, { jobId: 'job-1', name: 'b' }],
    }))).toThrow(/重复/);
  });

  it('按 jobId 幂等合并；同 jobId 保留新机，videoId 未核实则跳过', () => {
    const plan = planPendingImports(
      [{ jobId: 'job-1', name: '新机名' }],
      [
        { jobId: 'job-1', name: '旧机名' },
        { jobId: 'job-2', name: '旧机新增' },
        { jobId: 'job-3', name: '旧机视频', videoId: 'video-9' },
      ],
      verifiedCopies(),
    );

    expect(plan.added.map((item) => item.jobId)).toEqual(['job-2']);
    expect(plan.unchanged).toBe(0);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({ area: 'pending-import', id: 'job-1', resolution: 'kept-local' });
    expect(plan.skipped).toBe(1);
    expect(plan.skips[0].reason).toContain('未核实');
  });

  it('写回保留新机同 jobId 记录，并追加缺失记录', async () => {
    localStorage.setItem('dance.pending-imports.v1', JSON.stringify([
      { jobId: 'job-1', name: '新机名', createdAt: '2026-01-01T00:00:00.000Z' },
    ]));
    const state = stateOf({
      pendingImports: [
        { jobId: 'job-1', name: '旧机名' },
        { jobId: 'job-2', name: '旧机新增' },
      ],
    });
    const applied = await applyMigrationState(state, [stateFileOf()]);
    const saved = JSON.parse(localStorage.getItem('dance.pending-imports.v1') || '[]') as MigrationPendingImport[];

    expect(applied.pendingImportsAdded).toBe(1);
    expect(applied.pendingImportsConflicts).toHaveLength(1);
    expect(saved.map((item) => item.name)).toEqual(['新机名', '旧机新增']);
    expect(applied.complete).toBe(false);
  });
});

describe('C2/F1 冲突与遗漏不显示完整成功', () => {
  beforeEach(resetMigrationStore);

  it('冲突隔离文件计入 conflictFiles，complete 为 false，并逐条列出未完成项', async () => {
    const state = stateOf({
      cacheIndex: [{ key: '/api/media/audio/d1', path: 'dance-offline/audio-1.audio', sha256: A, version: 1, sizeBytes: 10 }],
    });
    const files = [
      stateFileOf(),
      fileOf({ path: 'dance-offline/audio-1.audio', destination: 'migration-inbox/conflicts/dance-offline/audio-1.audio', status: 'conflict' }),
    ];
    const applied = await applyMigrationState(state, files);

    expect(applied.failedFiles).toBe(0);
    expect(applied.conflictFiles).toBe(1);
    expect(applied.cacheSkipped).toBe(0);
    expect(applied.cacheConflicts).toHaveLength(1);
    expect(applied.complete).toBe(false);
    expect(applied.incomplete.some((item) => item.area === 'file' && item.id === 'dance-offline/audio-1.audio')).toBe(true);
    expect(applied.incomplete.some((item) => item.area === 'cache' && item.id === '/api/media/audio/d1')).toBe(true);
  });

  it('全部到位且无冲突时才报告完整成功', async () => {
    const state = stateOf({
      cacheIndex: [{ key: '/api/media/audio/d1', path: 'dance-offline/audio-1.audio', sha256: A, version: 1, sizeBytes: 10 }],
    });
    const files = [
      stateFileOf(),
      fileOf({ path: 'dance-offline/audio-1.audio', destination: 'dance-offline/audio-1.audio', status: 'received', sizeBytes: 10, sha256: A, uri: 'file:///new/a' }),
    ];
    const applied = await applyMigrationState(state, files);

    expect(applied.failedFiles).toBe(0);
    expect(applied.conflictFiles).toBe(0);
    expect(applied.cacheAdded).toBe(1);
    expect(applied.incomplete).toEqual([]);
    expect(applied.complete).toBe(true);
  });

  it('缓存文件未出现在接收结果时计入遗漏，complete 为 false', async () => {
    const state = stateOf({
      cacheIndex: [{ key: '/api/media/audio/d1', path: 'dance-offline/missing.audio', sha256: A, version: 1, sizeBytes: 10 }],
    });
    const applied = await applyMigrationState(state, [stateFileOf()]);

    expect(applied.cacheSkipped).toBe(1);
    expect(applied.complete).toBe(false);
    expect(applied.incomplete[0]).toMatchObject({ area: 'cache', id: '/api/media/audio/d1' });
  });
});
