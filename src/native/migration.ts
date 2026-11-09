import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * 旧安卓机 → 新安卓机局域网直传桥。
 *
 * 迁出端只读本机缓存与曲库快照；迁入端由原生层做加密握手、Range 断点续传与 SHA-256 校验。
 * 同 Wi-Fi 时新手机用 UDP 广播自动发现旧手机（旧手机点一次「允许」即建立加密会话），
 * 发现失败可手动输入 6 位数字配对码。会话密钥只存在原生内存，不写 localStorage、不经过 JS。
 */

export interface MigrationShareInfo {
  port: number;
  /** 6 位数字配对码（形如 `123 456`），手动连接时使用。 */
  code: string;
  addresses: string[];
  /** 配对码过期时间（毫秒时间戳）。 */
  expiresAt: number;
  stateBytes: number;
  /** 旧手机是否已开启 UDP 自动发现。 */
  autoDiscovery: boolean;
}

export interface MigrationDiscoveryDevice {
  host: string;
  port: number;
  token: string;
}

export interface MigrationPairRequest {
  handshakeId: string;
  ip: string;
}

export interface MigrationPairProgress {
  stage: 'waiting-approval';
}

export interface MigrationShareStatus {
  running: boolean;
  building: boolean;
  ready: boolean;
  fileCount: number;
  totalBytes: number;
  codeExpiresAt: number;
  error: string;
}

export type MigrationFileStatus = 'received' | 'skipped' | 'conflict' | 'failed';

export interface MigrationFileResult {
  path: string;
  destination: string;
  uri: string;
  status: MigrationFileStatus;
  error: string;
  retryable: boolean;
  sizeBytes: number;
  sha256: string;
}

export interface MigrationReceiveResult {
  files: MigrationFileResult[];
  statePath: string;
  complete: boolean;
  totalBytes: number;
  receivedBytes: number;
  availableBytes: number;
  sessionExpiresAt: number;
}

export interface MigrationShareProgress {
  scannedFiles: number;
  scannedBytes: number;
  currentPath?: string;
}

export interface MigrationShareReady {
  fileCount: number;
  totalBytes: number;
}

export interface MigrationShareError {
  message: string;
}

export interface MigrationReceiveProgress {
  stage: 'download' | 'verify';
  fileIndex: number;
  fileCount: number;
  path: string;
  fileBytes: number;
  fileTotalBytes: number;
  transferredBytes: number;
  totalBytes: number;
  resumed: boolean;
}

export interface MigrationEventMap {
  shareProgress: MigrationShareProgress;
  shareReady: MigrationShareReady;
  shareError: MigrationShareError;
  receiveProgress: MigrationReceiveProgress;
  pairRequest: MigrationPairRequest;
  pairRequestCleared: MigrationPairRequest;
  pairProgress: MigrationPairProgress;
}

interface MigrationPlugin {
  startShare(options: { stateJson: string }): Promise<MigrationShareInfo>;
  stopShare(): Promise<void>;
  shareStatus(): Promise<MigrationShareStatus>;
  discover(): Promise<{ devices: MigrationDiscoveryDevice[] }>;
  receive(options: { host: string; port: number; key?: string; discoveryToken?: string }): Promise<MigrationReceiveResult>;
  allowPair(options: { handshakeId: string }): Promise<{ ok: boolean }>;
  denyPair(options: { handshakeId: string }): Promise<{ ok: boolean }>;
  cancelReceive(): Promise<void>;
  readState(options: { path: string }): Promise<{ stateJson: string }>;
  freeSpace(): Promise<{ availableBytes: number }>;
  addListener<E extends keyof MigrationEventMap>(
    eventName: E,
    listener: (data: MigrationEventMap[E]) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

export const Migration = registerPlugin<MigrationPlugin>('Migration');

export function migrationSupported(): boolean {
  return Capacitor.isNativePlatform();
}
