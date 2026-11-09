import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

/**
 * 换机迁移 UI 接线：
 * 1) 开始分享前先建上传闸门并等在途上传，失败时不得启动；
 * 2) 停止、失败、卸载都必须释放闸门；
 * 3) 接收未完成时按 conflictFiles / cacheSkipped / inverse 等真实原因展示，
 *    不得在 failedFiles=0 时显示「0 个文件失败」。
 */
const native = vi.hoisted(() => ({
  startShare: vi.fn(),
  stopShare: vi.fn(),
  shareStatus: vi.fn(),
  addListener: vi.fn(),
  cancelReceive: vi.fn(),
  discover: vi.fn(),
  receive: vi.fn(),
  allowPair: vi.fn(),
  denyPair: vi.fn(),
  readState: vi.fn(),
  freeSpace: vi.fn(),
  removeAllListeners: vi.fn(),
}));

/** 组件注册的原生事件回调，测试里用来模拟旧手机弹「允许 / 拒绝」。 */
const listeners: Record<string, (data: unknown) => void> = {};

vi.mock('../../src/native/migration', () => ({
  migrationSupported: () => true,
  Migration: native,
}));

const data = vi.hoisted(() => ({
  collect: vi.fn(),
  receive: vi.fn(),
  applyConflicts: vi.fn(),
}));

vi.mock('../../src/lib/migration', () => ({
  collectMigrationState: data.collect,
  receiveMigrationFromPeer: data.receive,
  applyIncomingConflicts: data.applyConflicts,
}));

// 闸门本身用真实实现，只把 begin 包一层便于强制超时；其余语义（引用计数、幂等）保持真实。
vi.mock('../../src/lib/migration-sync-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/migration-sync-guard')>();
  return { ...actual, beginMigrationSyncGuard: vi.fn(actual.beginMigrationSyncGuard) };
});

import MigrationPanel from '../../src/components/MigrationPanel';
import {
  beginMigrationSyncGuard,
  endMigrationSyncGuard,
  isMigrationSyncGuardActive,
  MigrationSyncGuardTimeoutError,
} from '../../src/lib/migration-sync-guard';
import type { ApplyMigrationOutcome } from '../../src/lib/migration';

const SHARE_INFO = {
  port: 28795,
  code: '123 456',
  addresses: ['192.168.31.61'],
  expiresAt: Date.now() + 600_000,
  stateBytes: 128,
  autoDiscovery: true,
};

const VALID_KEY = '123456';

function appliedOutcome(overrides: Partial<ApplyMigrationOutcome> = {}): ApplyMigrationOutcome {
  return {
    catalog: [],
    repertoire: [],
    trash: [],
    program: null,
    scorePages: {},
    changes: { catalog: false, repertoire: false, trash: false, program: false },
    added: { catalog: 1, repertoire: 0, trash: 0, program: false, scorePages: 0 },
    overwritten: 0,
    unchanged: 0,
    conflicts: [],
    cacheAdded: 2,
    cacheUnchanged: 1,
    cacheSkipped: 0,
    cacheConflicts: [],
    operationsAdded: 0,
    operationsUnchanged: 0,
    operationsConflicts: [],
    pendingFilesAdded: 0,
    pendingFilesUnchanged: 0,
    pendingFilesSkipped: 0,
    pendingFilesConflicts: [],
    pendingImportsAdded: 0,
    pendingImportsUnchanged: 0,
    pendingImportsSkipped: 0,
    pendingImportsConflicts: [],
    conflictFiles: 0,
    failedFiles: 0,
    incomplete: [],
    complete: true,
    ...overrides,
  };
}

function receiveResult(applied: ApplyMigrationOutcome) {
  return {
    received: {
      files: [],
      statePath: '/tmp/state.json',
      complete: true,
      totalBytes: 0,
      receivedBytes: 0,
      availableBytes: 0,
      sessionExpiresAt: 0,
    },
    state: { schema: 1, metadata: {}, cacheIndex: [], scorePages: {}, operations: [], pendingFiles: [], pendingImports: [] },
    applied,
  };
}

function startSharing() {
  fireEvent.click(screen.getByRole('button', { name: '开始迁移分享' }));
  return screen.findByText(SHARE_INFO.code);
}

function startReceiving() {
  fireEvent.change(screen.getByLabelText(/旧手机地址/), { target: { value: '192.168.31.61' } });
  fireEvent.change(screen.getByLabelText(/^端口/), { target: { value: '28795' } });
  fireEvent.change(screen.getByLabelText(/6 位数字配对码/), { target: { value: VALID_KEY } });
  fireEvent.click(screen.getByRole('button', { name: '开始接收' }));
}

beforeEach(() => {
  endMigrationSyncGuard();
  vi.mocked(beginMigrationSyncGuard).mockClear();
  native.startShare.mockReset().mockResolvedValue(SHARE_INFO);
  native.stopShare.mockReset().mockResolvedValue(undefined);
  native.shareStatus.mockReset().mockResolvedValue({
    running: false, building: false, ready: false, fileCount: 0, totalBytes: 0, codeExpiresAt: 0, error: '',
  });
  for (const key of Object.keys(listeners)) delete listeners[key];
  native.addListener.mockReset().mockImplementation((event: string, callback: (data: unknown) => void) => {
    listeners[event] = callback;
    return Promise.resolve({ remove: vi.fn() });
  });
  native.cancelReceive.mockReset().mockResolvedValue(undefined);
  native.discover.mockReset().mockResolvedValue({ devices: [] });
  native.allowPair.mockReset().mockResolvedValue({ ok: true });
  native.denyPair.mockReset().mockResolvedValue({ ok: true });
  data.collect.mockReset().mockResolvedValue({
    state: { operations: [], pendingFiles: [] },
    warnings: [],
  } as never);
  data.receive.mockReset();
  data.applyConflicts.mockReset();
});

it('开始分享先建立上传闸门并等在途任务，停止后释放闸门恢复同步', async () => {
  let guardSeenWhileCollecting = false;
  data.collect.mockImplementation(async () => {
    guardSeenWhileCollecting = isMigrationSyncGuardActive();
    return { state: { operations: [], pendingFiles: [] }, warnings: [] } as never;
  });

  render(<MigrationPanel />);
  await startSharing();

  expect(guardSeenWhileCollecting).toBe(true);
  expect(beginMigrationSyncGuard).toHaveBeenCalledTimes(1);
  expect(isMigrationSyncGuardActive()).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: '停止分享' }));
  await waitFor(() => expect(native.stopShare).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(isMigrationSyncGuardActive()).toBe(false));
  expect(await screen.findByText('已停止旧手机分享。')).toBeVisible();
});

it('在途上传等不到超时：不得开始迁移，并给出明确原因', async () => {
  vi.mocked(beginMigrationSyncGuard).mockRejectedValueOnce(new MigrationSyncGuardTimeoutError(1, 30_000));

  render(<MigrationPanel />);
  fireEvent.click(screen.getByRole('button', { name: '开始迁移分享' }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('还有 1 个文件正在上传');
  expect(alert).toHaveTextContent('本次没有开始');
  expect(data.collect).not.toHaveBeenCalled();
  expect(native.startShare).not.toHaveBeenCalled();
  // 超时由闸门自己释放，不把后台上传永久锁死。
  expect(isMigrationSyncGuardActive()).toBe(false);
});

it('构建清单或启动分享失败：释放闸门，不让后台上传被永久挡住', async () => {
  native.startShare.mockRejectedValueOnce(new Error('SHARE_START_FAILED：端口被占用'));

  render(<MigrationPanel />);
  fireEvent.click(screen.getByRole('button', { name: '开始迁移分享' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('SHARE_START_FAILED');
  await waitFor(() => expect(isMigrationSyncGuardActive()).toBe(false));
  expect(screen.queryByText(SHARE_INFO.code)).not.toBeInTheDocument();
});

it('卸载时先停止原生分享，再释放闸门', async () => {
  const view = render(<MigrationPanel />);
  await startSharing();
  expect(isMigrationSyncGuardActive()).toBe(true);

  view.unmount();

  await waitFor(() => expect(native.stopShare).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(isMigrationSyncGuardActive()).toBe(false));
});

it('failedFiles=0 但存在隔离冲突/缓存跳过/收录跳过时，逐类显示真实原因，不显示 0 个失败', async () => {
  data.receive.mockResolvedValue(receiveResult(appliedOutcome({
    complete: false,
    conflictFiles: 2,
    cacheSkipped: 3,
    pendingImportsSkipped: 4,
    incomplete: [
      { area: 'file', id: 'dance-videos/a.mp4', reason: '新机已有同名文件且内容不同，旧机文件已隔离保存' },
      { area: 'cache', id: 'song-b', reason: '媒体已到位但 sidecar 缺失，未登记' },
      { area: 'pending-import', id: 'job-1', reason: '视频副本未核实' },
    ],
  })));

  render(<MigrationPanel />);
  startReceiving();

  const status = await screen.findByText(/^接收未完全完成：/);
  expect(status).toHaveTextContent('2 个文件内容不同，旧机版本已隔离保存');
  expect(status).toHaveTextContent('3 个离线记录未登记');
  expect(status).toHaveTextContent('4 条未完成收录未登记');
  expect(screen.queryByText(/0 个文件失败/)).not.toBeInTheDocument();

  expect(screen.getByText(/未完成 3 项（点击查看逐条原因）/)).toBeInTheDocument();
  expect(screen.getByText(/媒体已到位但 sidecar 缺失/)).toBeInTheDocument();
  // 「视频副本未核实」同时出现在逐条清单与汇总说明里，这里只要求至少一处可读。
  expect(screen.getAllByText(/视频副本未核实/).length).toBeGreaterThan(0);
  expect(screen.getByText(/3 个离线记录因文件缺失或未通过校验/)).toBeInTheDocument();
  expect(screen.getByText(/4 条未完成的收录因可续接信息或视频副本未核实/)).toBeInTheDocument();
});

it('全部完成时只显示完成，不出现未完成原因', async () => {
  data.receive.mockResolvedValue(receiveResult(appliedOutcome()));

  render(<MigrationPanel />);
  startReceiving();

  expect(await screen.findByText('接收与校验完成。')).toBeVisible();
  expect(screen.queryByText(/接收未完全完成/)).not.toBeInTheDocument();
  expect(screen.queryByText(/个文件接收失败/)).not.toBeInTheDocument();
});

it('自动搜索旧手机：连接时带 discoveryToken 调原生接收，并提示等待旧手机允许', async () => {
  native.discover.mockResolvedValue({ devices: [{ host: '192.168.31.105', port: 42069, token: 'a'.repeat(32) }] });
  data.receive.mockResolvedValue(receiveResult(appliedOutcome()));

  render(<MigrationPanel />);
  fireEvent.click(screen.getByRole('button', { name: '自动搜索旧手机' }));

  const connect = await screen.findByRole('button', { name: /连接 192\.168\.31\.105/ });
  fireEvent.click(connect);

  await waitFor(() => expect(data.receive).toHaveBeenCalledWith({
    host: '192.168.31.105',
    port: 42069,
    discoveryToken: 'a'.repeat(32),
  }));
  expect(await screen.findByText('接收与校验完成。')).toBeVisible();
});

it('旧手机收到新手机请求：显示允许/拒绝，点允许调用原生 allowPair', async () => {
  render(<MigrationPanel />);
  await startSharing();
  await waitFor(() => expect(listeners.pairRequest).toBeTruthy());

  act(() => listeners.pairRequest({ handshakeId: 'hs-1', ip: '192.168.31.105' }));

  const prompt = await screen.findByRole('alert');
  expect(prompt).toHaveTextContent(/请求接收这台手机的内容/);
  fireEvent.click(screen.getByRole('button', { name: '允许这台新手机接收' }));
  await waitFor(() => expect(native.allowPair).toHaveBeenCalledWith({ handshakeId: 'hs-1' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '允许这台新手机接收' })).not.toBeInTheDocument());
});
