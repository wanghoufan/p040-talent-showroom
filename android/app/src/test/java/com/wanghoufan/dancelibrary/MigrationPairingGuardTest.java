package com.wanghoufan.dancelibrary;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 配对准入的定向测试（F4）：限速与失败退避只作用于来源 IP，
 * 未确认会话有名额上限且不做 LRU 淘汰，一次性确认不能被第二次确认抢走。
 *
 * <p>纯内存策略测试，不启动 HTTP 服务、不接触真机或真实数据。
 */
public class MigrationPairingGuardTest {

    private static final long T0 = 1_700_000_000_000L;

    @Test
    public void handshakeThrottleOnlyBlocksTheSameSource() {
        MigrationPairingGuard guard = new MigrationPairingGuard();
        assertEquals(0, guard.beginHandshake("192.168.1.10", T0));
        assertTrue(guard.beginHandshake("192.168.1.10", T0 + 100) > 0);
        // 另一台设备（合法新机）不受攻击机限速影响。
        assertEquals(0, guard.beginHandshake("192.168.1.11", T0 + 100));
        // 间隔够了以后同一来源也能再次握手。
        assertEquals(0, guard.beginHandshake("192.168.1.10",
                T0 + MigrationPairingGuard.HANDSHAKE_INTERVAL_MS));
    }

    @Test
    public void failuresLockOnlyTheFailingSource() {
        MigrationPairingGuard guard = new MigrationPairingGuard();
        for (int i = 0; i < MigrationPairingGuard.MAX_FAILURES - 1; i++) {
            assertEquals(0, guard.recordFailure("192.168.1.66", T0));
            assertEquals(0, guard.confirmWait("192.168.1.66", T0));
        }
        assertEquals(MigrationPairingGuard.FAILURE_LOCK_MS, guard.recordFailure("192.168.1.66", T0));
        assertTrue(guard.confirmWait("192.168.1.66", T0 + 1_000) > 0);
        // 合法用户来自别的地址：不能被别人的失败次数锁死。
        assertEquals(0, guard.confirmWait("192.168.1.10", T0 + 1_000));
        // 攻击者也不能用自己的失败锁住别人的握手。
        assertEquals(0, guard.beginHandshake("192.168.1.10", T0 + 1_000));
        // 退避到期后自动恢复。
        assertEquals(0, guard.confirmWait("192.168.1.66", T0 + MigrationPairingGuard.FAILURE_LOCK_MS + 1));
    }

    @Test
    public void failureWindowResetsInsteadOfAccumulatingForever() {
        MigrationPairingGuard guard = new MigrationPairingGuard();
        for (int i = 0; i < MigrationPairingGuard.MAX_FAILURES - 1; i++) {
            guard.recordFailure("10.0.0.9", T0);
        }
        long later = T0 + MigrationPairingGuard.FAILURE_WINDOW_MS + 1;
        assertEquals(0, guard.recordFailure("10.0.0.9", later));
        assertEquals(0, guard.confirmWait("10.0.0.9", later));
    }

    @Test
    public void pendingSessionsAreCappedPerSourceWithoutEvictingOthers() {
        MigrationPairingGuard guard = new MigrationPairingGuard();
        for (int i = 0; i < MigrationPairingGuard.MAX_PENDING_PER_IP; i++) {
            assertTrue(guard.canRegister("192.168.1.66", T0));
            guard.register("handshake-" + i, "192.168.1.66", T0 + 60_000, T0);
        }
        assertFalse(guard.canRegister("192.168.1.66", T0 + 1));
        // 攻击机占满自己的名额，不影响合法新机登记。
        assertTrue(guard.canRegister("192.168.1.10", T0 + 1));
        guard.register("legit", "192.168.1.10", T0 + 60_000, T0 + 1);
        // 合法来源只占了 1 个名额，仍可继续；上限是按来源独立计算的。
        assertTrue(guard.canRegister("192.168.1.10", T0 + 2));
    }

    @Test
    public void expiredPendingSessionsReleaseQuota() {
        MigrationPairingGuard guard = new MigrationPairingGuard();
        for (int i = 0; i < MigrationPairingGuard.MAX_PENDING_PER_IP; i++) {
            guard.register("old-" + i, "192.168.1.66", T0 + 1_000, T0);
        }
        assertFalse(guard.canRegister("192.168.1.66", T0 + 500));
        // 握手 TTL 过后名额自动释放，不必重启分享。
        assertTrue(guard.canRegister("192.168.1.66", T0 + 1_001));
    }

    @Test
    public void globalCapacityRejectsNewcomersWithoutDroppingLiveSessions() {
        MigrationPairingGuard guard = new MigrationPairingGuard();
        int sources = MigrationPairingGuard.MAX_PENDING_TOTAL / MigrationPairingGuard.MAX_PENDING_PER_IP;
        for (int source = 0; source < sources; source++) {
            String ip = "10.1." + source + ".1";
            for (int slot = 0; slot < MigrationPairingGuard.MAX_PENDING_PER_IP; slot++) {
                assertTrue(guard.canRegister(ip, T0));
                guard.register("hs-" + source + "-" + slot, ip, T0 + 60_000, T0);
            }
        }
        assertFalse(guard.canRegister("10.2.0.1", T0));
        // 删掉一个旧会话后名额恢复：说明是计数上限，不是淘汰已有会话。
        guard.unregister("hs-0-0");
        assertTrue(guard.canRegister("10.2.0.1", T0));
    }

    @Test
    public void confirmationIsOneTimeAndCannotBePreempted() {
        MigrationPairingGuard guard = new MigrationPairingGuard();
        assertFalse(guard.isConfirmed());
        assertTrue(guard.claimConfirmed());
        assertTrue(guard.isConfirmed());
        // 第二个握手/确认不能抢走已确认会话，也不能把一次性密钥再用一次。
        assertFalse(guard.claimConfirmed());
    }

    @Test
    public void clearResetsEverythingForTheNextSharingSession() {
        MigrationPairingGuard guard = new MigrationPairingGuard();
        guard.register("hs", "192.168.1.66", T0 + 60_000, T0);
        guard.recordFailure("192.168.1.66", T0);
        assertTrue(guard.claimConfirmed());
        guard.clear();
        assertFalse(guard.isConfirmed());
        assertEquals(0, guard.confirmWait("192.168.1.66", T0));
        assertTrue(guard.canRegister("192.168.1.66", T0 + 1));
    }
}
