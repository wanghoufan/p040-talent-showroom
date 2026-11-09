/**
 * 换机迁移期间的本地同步闸门（迁出端）。
 *
 * 为什么需要它：迁移清单只在「开始分享」那一刻构建一次（原生层 `MigrationPlugin` 扫描
 * `dance-pending/`、`dance-videos/` 并算出每个文件的 SHA-256）。之后老机若仍在后台上传，
 * `offline-files.flushLocalFiles()` 会在上传成功后 `deleteFile` 删掉刚被清单登记的文件：
 * 哈希前被删 → 建清单失败；哈希后被删 → 分享服务器打开文件抛异常、连接断开无响应，
 * 接收端判为 `NETWORK` 且属致命错误，整轮迁移中止，重试仍对着一份陈旧清单反复失败。
 *
 * 用法（迁移 UI 负责调用，本模块不依赖任何 UI）：
 * ```ts
 * const guard = await beginMigrationSyncGuard(); // 先等完在途上传，再开始构建清单
 * try {
 *   await Migration.startShare({ stateJson });    // 清单在这之后才生成
 * } catch (error) {
 *   guard.release();                              // 失败必须释放，别把上传永久锁死
 *   throw error;
 * }
 * // …停止分享时
 * await Migration.stopShare();
 * guard.release();
 * ```
 *
 * 限制：
 * - 只拦 `flushLocalFiles()`（含 15 秒定时器、前台切换、`online` 事件与 `queueFile` 的自动触发）。
 * - 不取消已经在跑的上传（取消会留下半截文件），只会等它自然结束；等不到就超时报错并释放。
 * - 迁移期间用户手动移除待办（`discardPendingFile`）也会删文件，由 `offline-files` 用同一个
 *   `isMigrationSyncGuardActive()` 拦下，不在此模块里做。
 * - 进程被杀后保护状态随内存消失；原生分享也会一并停掉，不存在「有分享、没保护」的持久状态。
 */

export interface MigrationSyncGuardHandle {
  /** 本句柄是否仍持有保护（被 `release`／`end` 释放后为 false）。 */
  readonly active: boolean;
  /** 释放本句柄；幂等，重复调用不会把别人的持有计数减成负数。 */
  release(): void;
}

export interface BeginMigrationSyncGuardOptions {
  /**
   * 等待在途上传结束的最长时间（毫秒）。超时视为本次开始保护失败：抛错并自动释放，
   * 让 UI 提示「还有文件在上传」，而不是带着被删风险开始迁移。默认 30 秒。
   */
  timeoutMs?: number;
}

export const MIGRATION_SYNC_GUARD_TIMEOUT = 'MIGRATION_SYNC_GUARD_TIMEOUT' as const;
/** 默认等待在途上传的上限；单次上传本身有 120 秒上限，这里只等「已经接近结束」的那一批。 */
export const DEFAULT_MIGRATION_GUARD_TIMEOUT_MS = 30_000;

/** 开始保护失败：在途上传在时限内没有结束。保护已自动释放，调用方不得继续开始迁移。 */
export class MigrationSyncGuardTimeoutError extends Error {
  readonly code = MIGRATION_SYNC_GUARD_TIMEOUT;
  readonly pendingUploads: number;
  readonly timeoutMs: number;
  constructor(pendingUploads: number, timeoutMs: number) {
    super(
      `还有 ${pendingUploads} 个文件正在上传，${Math.round(timeoutMs / 1000)} 秒内没有结束；` +
        '为避免迁移中途删掉文件，本次没有开始。请等上传完成后再试。',
    );
    this.name = 'MigrationSyncGuardTimeoutError';
    this.pendingUploads = pendingUploads;
    this.timeoutMs = timeoutMs;
  }
}

interface Holder {
  released: boolean;
}

/** 当前持有保护的调用方（引用计数）：迁移面板与嵌套调用各自 release，不会互相提前解锁。 */
const holders = new Set<Holder>();
/** 已登记但尚未结束的后台同步任务（`flushLocalFiles` 的整个 perform 流程）。 */
const inFlight = new Set<Promise<void>>();

export function isMigrationSyncGuardActive(): boolean {
  return holders.size > 0;
}

/** 仍在进行中的同步任务数量，供诊断与测试断言用。 */
export function pendingSyncWorkCount(): number {
  return inFlight.size;
}

/**
 * 登记一个「会读写本地待上传文件」的后台任务，供 `beginMigrationSyncGuard()` 等待。
 *
 * 只做观测，不改写调用方的 Promise：失败仍然向原调用方抛出，绝不吞掉错误。
 */
export function trackSyncWork<T>(work: Promise<T>): Promise<T> {
  // 用独立的不抛错 Promise 记录生命周期，避免任务失败时产生未处理的拒绝；
  // 出列与结算放在同一个回调里，await 原任务的调用方恢复时计数已经归零。
  const settled: Promise<void> = work.then(
    () => {
      inFlight.delete(settled);
    },
    () => {
      inFlight.delete(settled);
    },
  );
  inFlight.add(settled);
  return work;
}

/**
 * 开始迁移保护：同步置位（此后 `flushLocalFiles()` 一律不发起新上传），
 * 再等待所有在途上传自然结束。
 *
 * - 已持有保护时再次调用会叠加一层持有（引用计数），只多等安全的在途任务。
 * - 等待超时抛 `MigrationSyncGuardTimeoutError` 并自动释放本次持有。
 * - 无论成功还是失败，都不会取消正在跑的上传。
 */
export async function beginMigrationSyncGuard(
  options: BeginMigrationSyncGuardOptions = {},
): Promise<MigrationSyncGuardHandle> {
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const holder: Holder = { released: false };
  // 先同步置位：本次 await 之后才可能有人检查标志，绝不能先等上传再置位——那之间新起的 flush 会漏网。
  holders.add(holder);
  try {
    await waitForInFlightSyncWork(timeoutMs);
  } catch (error) {
    releaseHolder(holder);
    throw error;
  }
  return {
    get active() {
      return !holder.released;
    },
    release() {
      releaseHolder(holder);
    },
  };
}

/**
 * 结束保护：释放所有持有者（迁移面板卸载、原生 `stopShare` 失败兜底等场景）。
 *
 * 返回实际释放的持有层数；幂等，没人持有时返回 0。
 */
export function endMigrationSyncGuard(): number {
  const released = holders.size;
  for (const holder of holders) holder.released = true;
  holders.clear();
  return released;
}

function releaseHolder(holder: Holder): void {
  if (holder.released) return;
  holder.released = true;
  holders.delete(holder);
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MIGRATION_GUARD_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError('迁移保护的等待时长必须是非负毫秒数');
  }
  return value;
}

async function waitForInFlightSyncWork(timeoutMs: number): Promise<void> {
  if (!inFlight.size) return;
  // 只等进入保护前已登记的任务；保护置位后不会有新任务登记（flushLocalFiles 已被拦下）。
  const snapshot = [...inFlight];
  const all = Promise.all(snapshot).then(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // 用当前数量而非快照：报给用户的是「现在还剩几个没传完」。
      reject(new MigrationSyncGuardTimeoutError(inFlight.size, timeoutMs));
    }, timeoutMs);
  });
  try {
    await Promise.race([all, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
