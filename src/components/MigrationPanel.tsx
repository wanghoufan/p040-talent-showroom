import { useEffect, useRef, useState } from 'react';
import type { PluginListenerHandle } from '@capacitor/core';
import {
  Migration,
  migrationSupported,
  type MigrationDiscoveryDevice,
  type MigrationPairRequest,
  type MigrationReceiveProgress,
  type MigrationReceiveResult,
  type MigrationShareInfo,
  type MigrationShareProgress,
  type MigrationShareReady,
} from '../native/migration';
import {
  applyIncomingConflicts,
  collectMigrationState,
  receiveMigrationFromPeer,
  type ApplyMigrationOutcome,
  type MigrationConflict,
  type MigrationFileResult,
  type MigrationState,
  type MigrationUnfinished,
} from '../lib/migration';
import { isValidMigrationKey, normalizeMigrationKey } from '../lib/migration-key';
import { beginMigrationSyncGuard, type MigrationSyncGuardHandle } from '../lib/migration-sync-guard';

function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message
    : typeof error === 'string' ? error
      : (error as { message?: unknown } | null)?.message;
  if (typeof raw !== 'string' || !raw.trim()) return '操作未完成，请重试';
  // 原生层只回错误码时，别把 MIGRATION_FAILED 这种内部代号丢给用户看。
  if (/^[A-Z][A-Z0-9_]{3,}$/.test(raw.trim())) {
    return raw === 'MIGRATION_FAILED' ? '迁移中断，已完成的文件与断点会保留，可再次点击接收' : '迁移未完成，请重试';
  }
  return raw;
}

function conflictLabel(conflict: MigrationConflict): string {
  const name = conflict.title || conflict.id;
  const revision = conflict.localRevision !== undefined && conflict.incomingRevision !== undefined
    ? `（新机 r${conflict.localRevision} / 旧机 r${conflict.incomingRevision}）`
    : '';
  return `${name}${revision}：${conflict.reason}`;
}

function unfinishedAreaLabel(area: MigrationUnfinished['area']): string {
  switch (area) {
    case 'file': return '文件';
    case 'cache': return '离线记录';
    case 'pending-file': return '待上传文件';
    case 'pending-import': return '未完成收录';
    default: return area;
  }
}

/**
 * 未完成原因必须逐类给真实数字：`complete=false` 只代表「没全成」，
 * 不代表「有文件失败」——隔离冲突、缓存/待办/收录跳过同样会让 complete 为 false。
 */
function incompleteReasons(applied: ApplyMigrationOutcome): string[] {
  const reasons: string[] = [];
  if (applied.failedFiles > 0) reasons.push(`${applied.failedFiles} 个文件接收失败`);
  if (applied.conflictFiles > 0) reasons.push(`${applied.conflictFiles} 个文件内容不同，旧机版本已隔离保存`);
  if (applied.cacheSkipped > 0) reasons.push(`${applied.cacheSkipped} 个离线记录未登记`);
  const mergeConflicts = applied.cacheConflicts.length + applied.operationsConflicts.length
    + applied.pendingFilesConflicts.length + applied.pendingImportsConflicts.length;
  if (mergeConflicts > 0) reasons.push(`${mergeConflicts} 项数据冲突保留新机`);
  if (applied.pendingFilesSkipped > 0) reasons.push(`${applied.pendingFilesSkipped} 个待上传记录未登记`);
  if (applied.pendingImportsSkipped > 0) reasons.push(`${applied.pendingImportsSkipped} 条未完成收录未登记`);
  return reasons;
}

function summaryText(applied: ApplyMigrationOutcome): string {
  const parts = [
    `新增舞蹈 ${applied.added.catalog} 首`,
    `新增才艺 ${applied.added.repertoire} 首`,
    `登记离线文件 ${applied.cacheAdded} 个`,
    `谱面页码 ${applied.added.scorePages} 条`,
    `待同步修改 ${applied.operationsAdded} 条`,
    `待上传文件 ${applied.pendingFilesAdded} 个`,
  ];
  if (applied.added.program) parts.push('采用旧机节目单');
  if (applied.pendingImportsAdded > 0) parts.push(`未完成收录 ${applied.pendingImportsAdded} 条`);
  const conflicts = applied.conflicts.length + applied.cacheConflicts.length
    + applied.operationsConflicts.length + applied.pendingFilesConflicts.length
    + applied.pendingImportsConflicts.length;
  if (conflicts > 0) parts.push(`冲突 ${conflicts} 项（默认未覆盖）`);
  const unfinished = incompleteReasons(applied);
  if (unfinished.length > 0) parts.push(unfinished.join('，'));
  const suffix = applied.complete ? '' : '；可再次点击接收，已完成的文件与断点会保留';
  return `${applied.complete ? '迁移完成' : '迁移未完全完成'}：${parts.join(' · ')}${suffix}。`;
}

/**
 * 设置页的「换机迁移」入口。
 *
 * 同 Wi-Fi 时新手机用「自动搜索旧手机」发现旧手机，旧手机在这一页点一次「允许」即开始传输；
 * 自动发现失败可改用旧手机显示的 6 位数字配对码手动连接。
 * 不迁移 owner token、设备地址或登录凭据；默认只补缺，冲突保留新机数据。
 */
export default function MigrationPanel() {
  const native = migrationSupported();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [share, setShare] = useState<MigrationShareInfo | null>(null);
  const [shareProgress, setShareProgress] = useState<MigrationShareProgress | null>(null);
  const [shareReady, setShareReady] = useState<MigrationShareReady | null>(null);
  const [shareError, setShareError] = useState('');
  const [pairRequest, setPairRequest] = useState<MigrationPairRequest | null>(null);
  const [devices, setDevices] = useState<MigrationDiscoveryDevice[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchHint, setSearchHint] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [key, setKey] = useState('');
  const [receiveProgress, setReceiveProgress] = useState<MigrationReceiveProgress | null>(null);
  const [waitingApproval, setWaitingApproval] = useState(false);
  const [received, setReceived] = useState<MigrationReceiveResult | null>(null);
  const [applied, setApplied] = useState<ApplyMigrationOutcome | null>(null);
  const [pendingConflicts, setPendingConflicts] = useState<{ state: MigrationState; files: MigrationFileResult[] } | null>(null);
  /** 本次页面持有的上传闸门；停止、失败、卸载都必须释放，否则后台上传会被永久挡住。 */
  const guardRef = useRef<MigrationSyncGuardHandle | null>(null);
  /** 原生分享是否可能仍在运行：决定卸载时是否要先停分享，再放开上传闸门。 */
  const shareActiveRef = useRef(false);
  const mountedRef = useRef(true);

  const releaseGuard = () => {
    guardRef.current?.release();
    guardRef.current = null;
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const guard = guardRef.current;
      guardRef.current = null;
      if (!shareActiveRef.current) {
        guard?.release();
        return;
      }
      // 卸载（切走设置页）时原生分享不会自己停；先停分享再放开闸门，
      // 否则上传会继续删掉正在分享的文件（C1）。stopShare 自身失败时也释放：
      // 组件已不在，留着保护只会让上传永久卡死。
      shareActiveRef.current = false;
      void Migration.stopShare().catch(() => undefined).finally(() => guard?.release());
    };
  }, []);

  useEffect(() => {
    if (!native) return;
    let active = true;
    const handles: PluginListenerHandle[] = [];
    void Migration.addListener('shareProgress', (data) => { if (active) setShareProgress(data); }).then((handle) => handles.push(handle));
    void Migration.addListener('shareReady', (data) => { if (active) { setShareReady(data); setShareError(''); } }).then((handle) => handles.push(handle));
    void Migration.addListener('shareError', (data) => { if (active) setShareError(data.message); }).then((handle) => handles.push(handle));
    void Migration.addListener('receiveProgress', (data) => { if (active) setReceiveProgress(data); }).then((handle) => handles.push(handle));
    void Migration.addListener('pairRequest', (data) => {
      if (!active) return;
      setPairRequest(data);
      setMessage(`新手机 ${data.ip} 请求接收这台手机的内容。确认是你自己的新手机后，点下面的「允许」。`);
    }).then((handle) => handles.push(handle));
    void Migration.addListener('pairRequestCleared', () => {
      if (active) setPairRequest(null);
    }).then((handle) => handles.push(handle));
    void Migration.addListener('pairProgress', (data) => {
      if (!active) return;
      if (data.stage === 'waiting-approval') setWaitingApproval(true);
    }).then((handle) => handles.push(handle));
    return () => {
      active = false;
      for (const handle of handles) void handle.remove();
    };
  }, [native]);

  const startShare = async () => {
    setBusy(true);
    setError('');
    setShareError('');
    setShareReady(null);
    setShareProgress(null);
    setMessage('');
    setShare(null);
    setPairRequest(null);
    let guard: MigrationSyncGuardHandle | null = null;
    try {
      // 先置位闸门并等在途上传结束，再构建清单：清单里的文件一旦被后台上传删掉，
      // 分享端就会打开失败、整轮迁移中止（详见 migration-sync-guard 模块注释）。
      // 等待超时会抛错，此时绝不能继续开始迁移。
      guard = await beginMigrationSyncGuard();
      if (!mountedRef.current) {
        guard.release();
        return;
      }
      const collected = await collectMigrationState();
      setWarnings(collected.warnings);
      const info = await Migration.startShare({ stateJson: JSON.stringify(collected.state) });
      if (!mountedRef.current) {
        // 构建清单/启动分享期间页面已卸载：卸载回调当时还看不到句柄，这里补停并释放。
        void Migration.stopShare().catch(() => undefined).finally(() => guard?.release());
        return;
      }
      guardRef.current = guard;
      shareActiveRef.current = true;
      setShare(info);
      const extras = collected.state.operations.length + collected.state.pendingFiles.length;
      setMessage(`旧手机已开始准备文件。${extras > 0 ? `将一并迁移 ${collected.state.operations.length} 条待同步修改和 ${collected.state.pendingFiles.length} 个待上传文件。` : ''}同 Wi-Fi 的新手机点「自动搜索旧手机」即可；搜不到时把下面的 6 位数字配对码告诉对方。`);
    } catch (caught) {
      // 闸门可能已置位：开始失败必须放回，否则后台上传会被永久挡住。
      // 原生 startShare 失败时已自行 stopShareInternal，这里只需释放闸门。
      guard?.release();
      guardRef.current = null;
      shareActiveRef.current = false;
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const stopShare = async () => {
    setBusy(true);
    setError('');
    try {
      await Migration.stopShare();
      shareActiveRef.current = false;
      setPairRequest(null);
      releaseGuard();
      setShare(null);
      setShareProgress(null);
      setShareReady(null);
      setShareError('');
      setMessage('已停止旧手机分享。');
    } catch (caught) {
      // 停止失败时原生分享可能还在跑：保留闸门（不恢复上传），避免删掉正在分享的文件。
      setError(`停止分享失败：${messageOf(caught)}。为保护正在分享的文件，旧手机暂不恢复后台上传；请重试停止。`);
    } finally {
      setBusy(false);
    }
  };

  const allowPairRequest = async () => {
    if (!pairRequest) return;
    setBusy(true);
    setError('');
    try {
      const result = await Migration.allowPair({ handshakeId: pairRequest.handshakeId });
      setPairRequest(null);
      setMessage(result.ok ? '已允许新手机接收，正在传文件。旧手机请保持本页亮屏。' : '这次连接已失效，请让新手机重新搜索。');
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const denyPairRequest = async () => {
    if (!pairRequest) return;
    setBusy(true);
    setError('');
    try {
      await Migration.denyPair({ handshakeId: pairRequest.handshakeId });
      setPairRequest(null);
      setMessage('已拒绝这次连接。');
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const discoverDevices = async () => {
    setSearching(true);
    setError('');
    setSearchHint('正在同一 Wi-Fi 内搜索旧手机…');
    try {
      const result = await Migration.discover();
      setDevices(result.devices);
      setSearchHint(result.devices.length > 0
        ? `找到 ${result.devices.length} 台正在分享的旧手机，点下面的按钮连接。`
        : '没有搜到旧手机。确认两台手机连同一个 Wi-Fi、旧手机已点「开始迁移分享」，或改用下面的 6 位数字配对码手动连接。');
    } catch (caught) {
      setSearchHint(`自动搜索失败：${messageOf(caught)}。可改用下面的 6 位数字配对码手动连接。`);
    } finally {
      setSearching(false);
    }
  };

  const runReceive = async (device?: MigrationDiscoveryDevice) => {
    setBusy(true);
    setError('');
    setMessage('');
    setApplied(null);
    setPendingConflicts(null);
    setReceiveProgress(null);
    setWaitingApproval(false);
    setWarnings([]);
    try {
      const hostValue = device?.host ?? host.trim();
      const portValue = device?.port ?? Number(port.trim());
      let keyValue = '';
      if (!device) {
        if (!hostValue) throw new Error('请输入旧手机在局域网内的 IPv4 地址');
        if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) throw new Error('端口无效');
        keyValue = normalizeMigrationKey(key);
        if (!received && !isValidMigrationKey(keyValue)) {
          throw new Error('请输入旧手机显示的 6 位数字配对码（可整段复制）');
        }
      }
      const outcome = await receiveMigrationFromPeer({
        host: hostValue,
        port: portValue,
        ...(keyValue ? { key: keyValue } : {}),
        ...(device ? { discoveryToken: device.token } : {}),
      });
      setReceived(outcome.received);
      setApplied(outcome.applied);
      setPendingConflicts(outcome.applied.conflicts.some((item) => item.resolution === 'kept-local')
        ? { state: outcome.state, files: outcome.received.files }
        : null);
      setMessage(summaryText(outcome.applied));
      // 设置页的缓存/原视频统计挂在页面挂载时算一次；迁移后主动通知它重算，
      // 否则用户会看到「已缓存 0 个文件」直到离开再进。
      window.dispatchEvent(new Event('dance-migration-applied'));
    } catch (caught) {
      setError(messageOf(caught));
      if (device) setSearchHint('连接没完成。可以重新搜索，或改用 6 位数字配对码手动连接。');
    } finally {
      setBusy(false);
      setReceiveProgress(null);
      setWaitingApproval(false);
    }
  };

  const cancelReceive = async () => {
    try {
      await Migration.cancelReceive();
      setMessage('已请求停止接收；已完成的文件与断点会保留，可稍后继续。');
    } catch (caught) {
      setError(messageOf(caught));
    }
  };

  const copyPairingCode = async () => {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.code);
      setError('');
      setMessage('6 位数字配对码已复制，可发到新手机粘贴。');
    } catch {
      setError('复制失败，请长按上面的数字手动抄写。');
    }
  };

  const applyIncomingData = async () => {
    if (!pendingConflicts) return;
    setBusy(true);
    setError('');
    try {
      const next = await applyIncomingConflicts(pendingConflicts.state, pendingConflicts.files);
      setApplied(next);
      setPendingConflicts(next.conflicts.some((item) => item.resolution === 'kept-local') ? pendingConflicts : null);
      setMessage(next.backupPath
        ? `已按旧机数据覆盖 ${next.overwritten} 项；覆盖前备份已写入 ${next.backupPath}。`
        : `没有可覆盖的旧机条目，新机数据保持不变（覆盖 ${next.overwritten} 项）。`);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h2>换机迁移（旧手机 → 新手机）</h2>
      <p className="muted">两台手机连同一个局域网（同一 Wi-Fi；不在同一 Wi-Fi 时，两台都开着 Tailscale 也可以）。视频、曲库名称、学习进度、待同步修改和待上传文件直接从旧手机传到新手机，不经过 Mac mini，也不迁移登录 token。传输使用 ECDH P-256 + 配对码/一次性发现令牌派生会话密钥，再用 AES-256-GCM 加密；双方会互相校验，密钥本身不上网。默认只补缺；冲突项保留新机数据，不静默覆盖。</p>
      <p className="muted">已迁移：已缓存的原视频/音乐/封面/谱件、单视频收录副本、曲名、学习进度、练习设置、谱面页码、节目单、尚未同步的离线修改与待上传文件队列。播放器上次听到的位置本机没有持久化，无法迁移。</p>
      {!native ? <p className="muted">换机迁移只在安卓 App 内可用，旧手机与新手机都需要安装本 App。</p> : <>
        <h3>旧手机：迁出</h3>
        <p className="muted">迁移已缓存的原视频、音乐、封面、谱件，以及曲名、学习进度、谱面页码和节目单。旧手机的文件只读，不会被改动。</p>
        <div className="button-row">
          <button className="primary" disabled={busy} onClick={() => void startShare()}>{busy ? '正在准备…' : '开始迁移分享'}</button>
          {share && <button disabled={busy} onClick={() => void stopShare()}>停止分享</button>}
        </div>
        {share && <div className="settings-block">
          <p>6 位数字配对码（自动搜不到时手动输入）</p>
          <p style={{ fontFamily: 'monospace', fontSize: '34px', letterSpacing: '6px', fontWeight: 700 }}>{share.code}</p>
          <div className="button-row">
            <button disabled={busy} onClick={() => void copyPairingCode()}>复制配对码</button>
          </div>
          <p className="muted">有效期到 {new Date(share.expiresAt).toLocaleTimeString()}，只能使用一次；输错几次会短暂锁定。</p>
          {share.addresses.length > 0
            ? <p>端口 <strong>{share.port}</strong>；局域网地址 {share.addresses.map((address) => <code key={address} style={{ marginRight: '8px' }}>{address}</code>)}</p>
            : <p role="status">没有读到局域网地址，请确认旧手机已连 Wi-Fi 或 Tailscale 后重新开始。</p>}
          <p className="muted">同 Wi-Fi 的新手机点「自动搜索旧手机」后，本页会弹出「允许 / 拒绝」，点「允许」才开始传输。</p>
          {shareError && <p role="alert">准备文件失败：{shareError}</p>}
          {!shareReady && !shareError && <p role="status">正在扫描并校验文件…{shareProgress ? ` 已扫描 ${shareProgress.scannedFiles} 个文件，${humanBytes(shareProgress.scannedBytes)}` : ''}</p>}
          {shareReady && <p role="status">已准备 {shareReady.fileCount} 个文件，共 {humanBytes(shareReady.totalBytes)}。旧手机请保持本页亮屏。</p>}
        </div>}
        {pairRequest && <div className="settings-block" role="alert">
          <p>新手机 {pairRequest.ip} 请求接收这台手机的内容。</p>
          <p className="muted">确认是你自己的新手机再点允许；不是的话点拒绝。</p>
          <div className="button-row">
            <button className="primary" disabled={busy} onClick={() => void allowPairRequest()}>允许这台新手机接收</button>
            <button disabled={busy} onClick={() => void denyPairRequest()}>拒绝</button>
          </div>
        </div>}
        <h3>新手机：迁入</h3>
        <p className="muted">同一 Wi-Fi 下点「自动搜索旧手机」，在旧手机上点一次「允许」就开始传输；自动搜不到时再用下面的 6 位数字配对码手动连接。</p>
        <div className="button-row">
          <button className="primary" disabled={busy || searching} onClick={() => void discoverDevices()}>{searching ? '正在搜索旧手机…' : '自动搜索旧手机'}</button>
        </div>
        {searchHint && <p role="status">{searchHint}</p>}
        {devices.length > 0 && <div className="settings-block">
          {devices.map((device) => <div className="button-row" key={`${device.host}:${device.port}`}>
            <button className="primary" disabled={busy} onClick={() => void runReceive(device)}>连接 {device.host}（端口 {device.port}）</button>
          </div>)}
        </div>}
        {waitingApproval && <p role="status">已连上旧手机，等待旧手机点「允许」…</p>}
        <details>
          <summary>自动搜不到？用 6 位数字配对码手动连接</summary>
          <label>旧手机地址（局域网 IPv4，同一 Wi-Fi 或 Tailscale）<input value={host} onChange={(event) => setHost(event.target.value)} placeholder="192.168.31.61" inputMode="decimal" autoComplete="off" /></label>
          <label>端口<input value={port} onChange={(event) => setPort(event.target.value)} placeholder="旧手机显示的端口" inputMode="numeric" autoComplete="off" /></label>
          <label>6 位数字配对码<input value={key} onChange={(event) => setKey(event.target.value)} placeholder="123 456" autoComplete="off" inputMode="numeric" spellCheck={false} maxLength={7} /></label>
          <div className="button-row">
            <button className="primary" disabled={busy} onClick={() => void runReceive()}>{busy ? '正在接收…' : received ? '继续接收 / 重试' : '开始接收'}</button>
            {busy && <button onClick={() => void cancelReceive()}>停止接收</button>}
          </div>
        </details>
        {receiveProgress && <div className="download-progress" role="status">
          <progress aria-label="换机迁移进度" max={Math.max(receiveProgress.totalBytes, 1)} value={receiveProgress.transferredBytes} />
          <p>文件 {receiveProgress.fileIndex}/{receiveProgress.fileCount} · {receiveProgress.path || '正在准备'} · {humanBytes(receiveProgress.fileBytes)} / {humanBytes(receiveProgress.fileTotalBytes)}{receiveProgress.resumed ? ' · 断点续传' : ''}</p>
        </div>}
      </>}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {warnings.length > 0 && <details><summary>旧机有 {warnings.length} 条信息未纳入迁移（点击查看）</summary><ul>{warnings.slice(0, 20).map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
      {applied && <div className="download-result">
        <p role="status">{applied.complete
          ? '接收与校验完成。'
          : `接收未完全完成：${incompleteReasons(applied).join('，') || '迁移状态文件未完整接收'}。可再次点击接收继续。`}</p>
        <p className="muted">新增舞蹈 {applied.added.catalog} 首 · 才艺 {applied.added.repertoire} 首 · 离线文件 {applied.cacheAdded} 个 · 跳过已存在 {applied.cacheUnchanged} 个 · 待同步修改 {applied.operationsAdded} 条 · 待上传文件 {applied.pendingFilesAdded} 个 · 未完成收录 {applied.pendingImportsAdded} 条 · 冲突 {applied.conflicts.length + applied.cacheConflicts.length + applied.operationsConflicts.length + applied.pendingFilesConflicts.length} 项</p>
        {applied.backupPath && <p className="muted">覆盖前备份：{applied.backupPath}</p>}
        {pendingConflicts && <button disabled={busy} onClick={() => void applyIncomingData()}>明确采用旧机数据（仅旧机 revision 更高）</button>}
        {(applied.conflicts.length + applied.cacheConflicts.length + applied.operationsConflicts.length + applied.pendingFilesConflicts.length) > 0 && <details><summary>冲突 {applied.conflicts.length + applied.cacheConflicts.length + applied.operationsConflicts.length + applied.pendingFilesConflicts.length} 项（默认保留新机数据）</summary><ul>{[...applied.conflicts, ...applied.cacheConflicts, ...applied.operationsConflicts, ...applied.pendingFilesConflicts].slice(0, 50).map((conflict) => <li key={`${conflict.area}:${conflict.id}`}>{conflictLabel(conflict)}</li>)}</ul></details>}
        {applied.incomplete.length > 0 && <details><summary>未完成 {applied.incomplete.length} 项（点击查看逐条原因）</summary><ul>{applied.incomplete.slice(0, 50).map((item) => <li key={`${item.area}:${item.id}`}>{unfinishedAreaLabel(item.area)} · {item.id}：{item.reason}</li>)}</ul></details>}
        {applied.pendingFilesSkipped > 0 && <p className="muted">另有 {applied.pendingFilesSkipped} 个待上传记录因对应文件未成功接收，未在新机登记。</p>}
        {applied.pendingImportsSkipped > 0 && <p className="muted">另有 {applied.pendingImportsSkipped} 条未完成的收录因可续接信息或视频副本未核实，未在新机登记。</p>}
        {applied.cacheSkipped > 0 && <p className="muted">另有 {applied.cacheSkipped} 个离线记录因文件缺失或未通过校验，未在新机登记。</p>}
        {applied.conflictFiles > 0 && <p className="muted">另有 {applied.conflictFiles} 个文件因新机已有同名但内容不同，旧机版本已隔离保存，未覆盖新机。</p>}
      </div>}
    </div>
  );
}
