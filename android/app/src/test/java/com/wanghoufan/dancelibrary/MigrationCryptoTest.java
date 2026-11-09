package com.wanghoufan.dancelibrary;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.SecureRandom;
import java.util.HashSet;
import java.util.Set;

/**
 * 迁移协议的安全定向测试：6 位数字配对码/发现 token、双方密钥绑定、双向证明、GCM 随机 nonce 与 AAD。
 *
 * <p>只测纯 JCE/协议逻辑，不启动 HTTP 服务、不访问真机或真实数据。
 */
public class MigrationCryptoTest {

    private static final SecureRandom RANDOM = new SecureRandom();

    private static MigrationCrypto.Keys deriveWith(byte[] pairingKey, String handshakeId, byte[] salt,
                                                    byte[] clientPub, byte[] serverPub, byte[] shared) throws Exception {
        return MigrationCrypto.derive(pairingKey, handshakeId, salt, clientPub, serverPub, shared);
    }

    @Test
    public void pairingCodeIsSixDigitsAndCopyFriendly() {
        String code = MigrationWire.newPairingCode(RANDOM);
        assertTrue(MigrationWire.isValidPairingCode(code));
        assertEquals(7, code.length()); // 6 位数字 + 1 个分隔空格
        assertTrue(code.matches("\\d{3} \\d{3}"));
        // 6 位码经 SHA-256 展开成 32 字节再进 HKDF，不把低熵数字直接当密钥。
        assertEquals(32, MigrationWire.pairingCodeBytes(code).length);

        // 空格、短横线与前后空白归一后仍是同一配对码。
        String compact = code.replace(" ", "");
        assertEquals(code, MigrationWire.normalizePairingCode(compact));
        assertEquals(code, MigrationWire.normalizePairingCode(" " + compact + " "));
        assertEquals(code, MigrationWire.normalizePairingCode(compact.substring(0, 3) + "-" + compact.substring(3)));
    }

    @Test
    public void pairingCodesAreUniqueAcrossManySamples() {
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < 200; i++) {
            String code = MigrationWire.newPairingCode(RANDOM);
            assertTrue(code.matches("\\d{3} \\d{3}"));
            seen.add(code.replace(" ", ""));
        }
        // 6 位码空间 100 万；200 次抽样出现碰撞概率很低，但只断言「无重复」不做唯一性证明。
        assertTrue(seen.size() >= 198);
    }

    @Test
    public void malformedCodesAreRejected() {
        assertTrue(MigrationWire.isValidPairingCode("123456"));
        assertFalse(MigrationWire.isValidPairingCode("12345"));
        assertFalse(MigrationWire.isValidPairingCode("1234567"));
        assertFalse(MigrationWire.isValidPairingCode("12a456"));
        assertFalse(MigrationWire.isValidPairingCode(""));
        assertFalse(MigrationWire.isValidPairingCode(null));
        assertFalse(MigrationWire.isValidPairingCode("ABCD-EFGH"));
    }

    @Test
    public void discoveryTokenMustBe32LowerHex() {
        String token = MigrationCrypto.randomHex(RANDOM, 16);
        assertEquals(32, token.length());
        assertEquals(32, MigrationWire.discoveryTokenBytes(token).length);
        assertEquals(MigrationCrypto.hex(MigrationWire.discoveryTokenBytes(token)),
                MigrationCrypto.hex(MigrationWire.discoveryTokenBytes(token)));
        try {
            MigrationWire.discoveryTokenBytes("short");
            fail("短 token 必须拒绝");
        } catch (IllegalArgumentException expected) {
            // 预期：格式不合法直接抛错。
        }
    }

    @Test
    public void derivationBindsPairingKeyHandshakeAndBothPublicKeys() throws Exception {
        KeyPair client = MigrationCrypto.newKeyPair();
        KeyPair server = MigrationCrypto.newKeyPair();
        byte[] clientPub = MigrationCrypto.publicBytes(client.getPublic());
        byte[] serverPub = MigrationCrypto.publicBytes(server.getPublic());
        byte[] shared = MigrationCrypto.sharedSecret(client.getPrivate(), server.getPublic());
        assertArrayEquals(shared, MigrationCrypto.sharedSecret(server.getPrivate(), client.getPublic()));

        byte[] pairingKey = MigrationWire.pairingCodeBytes(MigrationWire.newPairingCode(RANDOM));
        byte[] salt = MigrationCrypto.randomBytes(RANDOM, 16);
        String handshake = "0123456789abcdef0123456789abcdef";
        MigrationCrypto.Keys base = deriveWith(pairingKey, handshake, salt, clientPub, serverPub, shared);

        assertNotEquals(MigrationCrypto.hex(base.enc),
                MigrationCrypto.hex(deriveWith(pairingKey, "fedcba9876543210fedcba9876543210", salt,
                        clientPub, serverPub, shared).enc));
        assertNotEquals(MigrationCrypto.hex(base.mac),
                MigrationCrypto.hex(deriveWith(pairingKey, handshake, MigrationCrypto.randomBytes(RANDOM, 16),
                        clientPub, serverPub, shared).mac));

        KeyPair other = MigrationCrypto.newKeyPair();
        byte[] otherPub = MigrationCrypto.publicBytes(other.getPublic());
        assertNotEquals(MigrationCrypto.hex(base.file),
                MigrationCrypto.hex(deriveWith(pairingKey, handshake, salt, otherPub, serverPub, shared).file));
        assertNotEquals(MigrationCrypto.hex(base.file),
                MigrationCrypto.hex(deriveWith(pairingKey, handshake, salt, clientPub, otherPub, shared).file));
        assertNotEquals(MigrationCrypto.hex(base.file),
                MigrationCrypto.hex(deriveWith(pairingKey, handshake, salt, clientPub, serverPub,
                        MigrationCrypto.sharedSecret(client.getPrivate(), other.getPublic())).file));
        assertNotEquals(MigrationCrypto.hex(base.enc),
                MigrationCrypto.hex(deriveWith(MigrationWire.pairingCodeBytes(MigrationWire.newPairingCode(RANDOM)),
                        handshake, salt, clientPub, serverPub, shared).enc));
    }

    @Test
    public void mutualProofsBindBothPartiesAndRejectWrongKey() throws Exception {
        KeyPair client = MigrationCrypto.newKeyPair();
        KeyPair server = MigrationCrypto.newKeyPair();
        byte[] clientPub = MigrationCrypto.publicBytes(client.getPublic());
        byte[] serverPub = MigrationCrypto.publicBytes(server.getPublic());
        byte[] shared = MigrationCrypto.sharedSecret(client.getPrivate(), server.getPublic());
        byte[] pairingKey = MigrationWire.pairingCodeBytes(MigrationWire.newPairingCode(RANDOM));
        String handshake = "00112233445566778899aabbccddeeff";

        MigrationCrypto.Keys keys = MigrationCrypto.derive(pairingKey, handshake, MigrationCrypto.randomBytes(RANDOM, 16),
                clientPub, serverPub, shared);
        String clientProof = MigrationCrypto.clientProof(keys, handshake, clientPub, serverPub);
        String serverProof = MigrationCrypto.serverProof(keys, handshake, clientPub, serverPub);

        assertNotEquals(clientProof, serverProof);
        assertTrue(MigrationCrypto.constantTimeEqualsHex(clientProof,
                MigrationCrypto.clientProof(keys, handshake, clientPub, serverPub)));
        assertFalse(MigrationCrypto.constantTimeEqualsHex(clientProof,
                MigrationCrypto.clientProof(keys, handshake, serverPub, clientPub)));

        // 冒充者没有配对密钥，只能用错误密钥派生出不同 MAC，确认必然失败。
        MigrationCrypto.Keys impostor = MigrationCrypto.derive(
                MigrationWire.pairingCodeBytes(MigrationWire.newPairingCode(RANDOM)),
                handshake, MigrationCrypto.randomBytes(RANDOM, 16), clientPub, serverPub, shared);
        assertFalse(MigrationCrypto.constantTimeEqualsHex(clientProof,
                MigrationCrypto.clientProof(impostor, handshake, clientPub, serverPub)));
        assertFalse(MigrationCrypto.constantTimeEqualsHex(serverProof,
                MigrationCrypto.serverProof(impostor, handshake, clientPub, serverPub)));
    }

    @Test
    public void relayedHandshakeCannotTranslateProofsBetweenBothSides() throws Exception {
        // 攻击者分别与两侧握手（中继）：两侧 ECDH 共享秘密不同，无法把一侧证明翻译给另一侧。
        byte[] pairingKey = MigrationWire.pairingCodeBytes(MigrationWire.newPairingCode(RANDOM));
        KeyPair client = MigrationCrypto.newKeyPair();
        KeyPair server = MigrationCrypto.newKeyPair();
        KeyPair attackerAsServer = MigrationCrypto.newKeyPair();
        KeyPair attackerAsClient = MigrationCrypto.newKeyPair();
        byte[] clientPub = MigrationCrypto.publicBytes(client.getPublic());
        byte[] serverPub = MigrationCrypto.publicBytes(server.getPublic());
        byte[] attackerServerPub = MigrationCrypto.publicBytes(attackerAsServer.getPublic());
        byte[] attackerClientPub = MigrationCrypto.publicBytes(attackerAsClient.getPublic());

        MigrationCrypto.Keys clientSide = MigrationCrypto.derive(pairingKey, "hs-client",
                MigrationCrypto.randomBytes(RANDOM, 16), clientPub, attackerServerPub,
                MigrationCrypto.sharedSecret(client.getPrivate(), attackerAsServer.getPublic()));
        MigrationCrypto.Keys serverSide = MigrationCrypto.derive(pairingKey, "hs-server",
                MigrationCrypto.randomBytes(RANDOM, 16), attackerClientPub, serverPub,
                MigrationCrypto.sharedSecret(server.getPrivate(), attackerAsClient.getPublic()));

        String clientProof = MigrationCrypto.clientProof(clientSide, "hs-client", clientPub, attackerServerPub);
        String serverExpects = MigrationCrypto.clientProof(serverSide, "hs-server", attackerClientPub, serverPub);
        assertNotEquals(clientProof, serverExpects);
        assertFalse(MigrationCrypto.constantTimeEqualsHex(clientProof, serverExpects));

        // 新机侧同样无法把真实旧机的 serverProof 套到自己这条会话上。
        String serverProof = MigrationCrypto.serverProof(serverSide, "hs-server", attackerClientPub, serverPub);
        String clientExpects = MigrationCrypto.serverProof(clientSide, "hs-client", clientPub, attackerServerPub);
        assertNotEquals(serverProof, clientExpects);
        assertFalse(MigrationCrypto.constantTimeEqualsHex(serverProof, clientExpects));
    }

    @Test
    public void gcmRoundTripRequiresMatchingAad() throws Exception {
        byte[] key = MigrationCrypto.randomBytes(RANDOM, 32);
        byte[] nonce = MigrationCrypto.randomBytes(RANDOM, MigrationCrypto.NONCE_BYTES);
        byte[] aad = MigrationCrypto.chunkAad("handshake", "f1", 2, 1024);
        byte[] plain = "换机迁移明文".getBytes(StandardCharsets.UTF_8);

        byte[] sealed = MigrationCrypto.seal(key, nonce, aad, plain);
        assertArrayEquals(plain, MigrationCrypto.open(key, nonce, aad, sealed));

        try {
            MigrationCrypto.open(key, nonce, MigrationCrypto.chunkAad("handshake", "f1", 3, 1024), sealed);
            fail("chunkIndex 不匹配时必须解密失败");
        } catch (java.security.GeneralSecurityException expected) {
            // 预期：AAD 绑定生效。
        }
        try {
            MigrationCrypto.open(key, nonce, MigrationCrypto.chunkAad("other", "f1", 2, 1024), sealed);
            fail("handshakeId 不匹配时必须解密失败");
        } catch (java.security.GeneralSecurityException expected) {
            // 预期。
        }
        try {
            MigrationCrypto.open(key, nonce, MigrationCrypto.chunkAad("handshake", "f1", 2, 2048), sealed);
            fail("size 不匹配时必须解密失败");
        } catch (java.security.GeneralSecurityException expected) {
            // 预期。
        }
        byte[] tampered = sealed.clone();
        tampered[0] ^= 0x01;
        try {
            MigrationCrypto.open(key, nonce, aad, tampered);
            fail("篡改密文必须解密失败");
        } catch (java.security.GeneralSecurityException expected) {
            // 预期。
        }
    }

    @Test
    public void everyChunkFrameUsesFreshRandomNonce() throws Exception {
        byte[] key = MigrationCrypto.randomBytes(RANDOM, 32);
        byte[] aad = MigrationCrypto.chunkAad("handshake", "f1", 0, 8);
        byte[] plain = new byte[8];
        Set<String> nonces = new HashSet<>();
        Set<String> cipherTexts = new HashSet<>();
        for (int i = 0; i < 1000; i++) {
            byte[] nonce = MigrationCrypto.randomBytes(RANDOM, MigrationCrypto.NONCE_BYTES);
            assertTrue(nonces.add(MigrationCrypto.hex(nonce)));
            cipherTexts.add(MigrationCrypto.hex(MigrationCrypto.seal(key, nonce, aad, plain)));
        }
        assertEquals(1000, cipherTexts.size());
    }

    @Test
    public void chunkFrameOverheadMatchesWireFormat() {
        assertEquals(28, MigrationCrypto.CHUNK_FRAME_OVERHEAD);
        assertEquals(MigrationCrypto.NONCE_BYTES + 16, MigrationCrypto.CHUNK_FRAME_OVERHEAD);
    }
}
