package com.wanghoufan.dancelibrary;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * 配对准入策略（纯 Java，不依赖 Android/HTTP，便于单独编译做安全用例测试）。
 *
 * <p>约束的是「谁能占用配对窗口」，不参与任何密钥计算：
 * <ul>
 *   <li>握手限速与失败退避都按来源 IP 计，任一设备失败或轰炸只影响它自己，
 *       不会把合法用户锁死（F4）；</li>
 *   <li>未确认握手同时受「单来源上限」与「全局上限」约束，先到先得，后来者被拒，
 *       不做 LRU 淘汰——不会悄悄挤掉别人正在进行的配对；</li>
 *   <li>配对码一次性：确认成功后 {@link #claimConfirmed()} 只成功一次，
 *       之后既不能再握手，也不能用第二个握手覆盖已确认会话。</li>
 * </ul>
 */
final class MigrationPairingGuard {

    static final int MAX_PENDING_TOTAL = 64;
    static final int MAX_PENDING_PER_IP = 4;
    static final int MAX_FAILURES = 5;
    static final long HANDSHAKE_INTERVAL_MS = 500L;
    static final long FAILURE_LOCK_MS = 60_000L;
    static final long FAILURE_WINDOW_MS = 10L * 60L * 1000L;

    private static final class Peer {
        long lastHandshakeAt;
        int failures;
        long failureWindowStart;
        long lockedUntil;
    }

    private static final class Pending {
        final String ip;
        final long expiresAt;

        Pending(String ip, long expiresAt) {
            this.ip = ip;
            this.expiresAt = expiresAt;
        }
    }

    private final Map<String, Peer> peers = new HashMap<>();
    private final Map<String, Pending> pending = new HashMap<>();
    private boolean confirmed;

    /**
     * 尝试开始一次握手。返回 0 表示放行并已计入限速；返回正数表示需要等待的毫秒数。
     * 只按来源 IP 限速，因此同一网段的其他设备不会互相拖累。
     */
    synchronized long beginHandshake(String ip, long now) {
        Peer peer = peer(ip);
        if (now < peer.lockedUntil) return peer.lockedUntil - now;
        if (peer.lastHandshakeAt != 0 && now - peer.lastHandshakeAt < HANDSHAKE_INTERVAL_MS) {
            return HANDSHAKE_INTERVAL_MS - (now - peer.lastHandshakeAt);
        }
        peer.lastHandshakeAt = now;
        return 0;
    }

    /** 是否还能为该来源登记新的未确认握手；过期的未确认握手会先被清出。 */
    synchronized boolean canRegister(String ip, long now) {
        prune(now);
        if (pending.size() >= MAX_PENDING_TOTAL) return false;
        int mine = 0;
        for (Pending value : pending.values()) {
            if (value.ip.equals(ip)) mine++;
        }
        return mine < MAX_PENDING_PER_IP;
    }

    synchronized void register(String handshakeId, String ip, long expiresAt, long now) {
        prune(now);
        pending.put(handshakeId, new Pending(ip, expiresAt));
    }

    synchronized void unregister(String handshakeId) {
        pending.remove(handshakeId);
    }

    /** 该来源是否因连续失败处于退避中；返回需等待的毫秒数。 */
    synchronized long confirmWait(String ip, long now) {
        Peer peer = peers.get(ip);
        if (peer == null || now >= peer.lockedUntil) return 0;
        return peer.lockedUntil - now;
    }

    /** 记录一次确认失败，只累加该来源；达到阈值后仅锁定该来源。 */
    synchronized long recordFailure(String ip, long now) {
        Peer peer = peer(ip);
        if (peer.failureWindowStart == 0 || now - peer.failureWindowStart > FAILURE_WINDOW_MS) {
            peer.failureWindowStart = now;
            peer.failures = 0;
        }
        peer.failures++;
        if (peer.failures < MAX_FAILURES) return 0;
        peer.failures = 0;
        peer.failureWindowStart = 0;
        peer.lockedUntil = now + FAILURE_LOCK_MS;
        return FAILURE_LOCK_MS;
    }

    synchronized boolean isConfirmed() {
        return confirmed;
    }

    /**
     * 占用一次性配对。返回 false 表示已被另一次确认占用，
     * 调用方必须拒绝本次确认，不能覆盖已确认会话。
     */
    synchronized boolean claimConfirmed() {
        if (confirmed) return false;
        confirmed = true;
        return true;
    }

    synchronized void clear() {
        peers.clear();
        pending.clear();
        confirmed = false;
    }

    private Peer peer(String ip) {
        Peer peer = peers.get(ip);
        if (peer == null) {
            peer = new Peer();
            peers.put(ip, peer);
        }
        return peer;
    }

    private void prune(long now) {
        Iterator<Map.Entry<String, Pending>> iterator = pending.entrySet().iterator();
        while (iterator.hasNext()) {
            if (now > iterator.next().getValue().expiresAt) iterator.remove();
        }
    }
}
