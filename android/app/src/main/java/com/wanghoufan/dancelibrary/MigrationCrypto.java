package com.wanghoufan.dancelibrary;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECFieldFp;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.security.spec.EllipticCurve;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * 换机迁移的加密与认证原语（纯 JCE，不依赖 Android API，便于单独编译测试）。
 *
 * <p>方案：6 位数字配对码（或发现 token）派生的材料 + ECDH(P-256) 派生会话密钥，HKDF-SHA256 扩展，AES-256-GCM 加密，
 * 请求用 HMAC-SHA256 签名。配对码/token 从不发送；它只在本机参与密钥派生，因此局域网被动抓包
 * 无法解出文件或清单。6 位数字码本身熵不高，安全性由「同网段 + 握手限速 + 5 次失败锁 60 秒 +
 * 一次性 + 10 分钟有效期」兜住；自动发现路径使用 128 位随机 token，且必须由旧手机用户点「允许」。
 * 确认阶段双方各出示 HMAC 证明，且证明同时绑定握手标识与双方临时公钥，冒充者无法伪造任何一侧。
 *
 * <p>文件按 256 KiB 明文分块独立加密，每块使用发送时新生成的随机 96 位 nonce 并随帧下发，
 * AAD 绑定握手标识、文件 id、块序号与清单大小。同一块即使因续传被重复加密，nonce 也不复用；
 * 清单响应同样绑定本次请求的 nonce。服务端发送前复核文件长度与修改时间，内容变化即要求重取清单。
 */
public final class MigrationCrypto {

    public static final int FILE_CHUNK_SIZE = 256 * 1024;
    public static final int NONCE_BYTES = 12;
    public static final int TAG_BITS = 128;
    public static final int TAG_BYTES = TAG_BITS / 8;
    public static final int PUBLIC_KEY_BYTES = 65;
    /** 每个加密块在线路上的额外开销：随机 nonce + GCM tag。 */
    public static final int CHUNK_FRAME_OVERHEAD = NONCE_BYTES + TAG_BYTES;
    private static final int HASH_BYTES = 32;
    private static final String PROTOCOL = "dance-migration-v3";

    private MigrationCrypto() {}

    public static final class Keys {
        public final byte[] enc;
        public final byte[] mac;
        public final byte[] file;

        public Keys(byte[] enc, byte[] mac, byte[] file) {
            this.enc = enc;
            this.mac = mac;
            this.file = file;
        }
    }

    public static KeyPair newKeyPair() throws GeneralSecurityException {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        return generator.generateKeyPair();
    }

    /** 未压缩点格式：0x04 || X(32) || Y(32)，共 65 字节。 */
    public static byte[] publicBytes(PublicKey key) {
        if (!(key instanceof ECPublicKey)) throw new IllegalArgumentException("必须是 EC 公钥");
        ECPoint point = ((ECPublicKey) key).getW();
        byte[] out = new byte[PUBLIC_KEY_BYTES];
        out[0] = 0x04;
        System.arraycopy(fixed(point.getAffineX(), 32), 0, out, 1, 32);
        System.arraycopy(fixed(point.getAffineY(), 32), 0, out, 33, 32);
        return out;
    }

    public static PublicKey parsePublicKey(byte[] raw) throws GeneralSecurityException {
        if (raw == null || raw.length != PUBLIC_KEY_BYTES || raw[0] != 0x04) {
            throw new GeneralSecurityException("公钥格式无效");
        }
        byte[] xBytes = new byte[32];
        byte[] yBytes = new byte[32];
        System.arraycopy(raw, 1, xBytes, 0, 32);
        System.arraycopy(raw, 33, yBytes, 0, 32);
        BigInteger x = new BigInteger(1, xBytes);
        BigInteger y = new BigInteger(1, yBytes);
        ECParameterSpec spec = p256();
        if (!onCurve(x, y, spec.getCurve())) throw new GeneralSecurityException("公钥不在曲线上");
        return KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(new ECPoint(x, y), spec));
    }

    public static byte[] sharedSecret(PrivateKey own, PublicKey peer) throws GeneralSecurityException {
        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(own);
        agreement.doPhase(peer, true);
        return normalize(fixed(new BigInteger(1, agreement.generateSecret()), 32));
    }

    /**
     * 用「配对码/发现 token 派生的材料 + ECDH 共享秘密」派生会话密钥。
     * 派生盐同时绑定 salt、握手标识与双方临时公钥，任一项不同都会得到不同密钥。
     */
    public static Keys derive(byte[] pairingKey, String handshakeId, byte[] salt, byte[] clientPub,
                              byte[] serverPub, byte[] sharedSecret) throws GeneralSecurityException {
        if (pairingKey == null || pairingKey.length < 16) {
            throw new GeneralSecurityException("配对材料格式无效");
        }
        if (handshakeId == null || handshakeId.isEmpty()) throw new GeneralSecurityException("握手标识无效");
        if (salt == null || clientPub == null || serverPub == null || sharedSecret == null) {
            throw new GeneralSecurityException("握手材料不完整");
        }
        byte[] material = concat(pairingKey, sharedSecret);
        byte[] extractSalt = sha256(concat(salt, clientPub, serverPub,
                handshakeId.getBytes(StandardCharsets.UTF_8),
                PROTOCOL.getBytes(StandardCharsets.UTF_8)));
        byte[] prk = hkdfExtract(extractSalt, material);
        String info = PROTOCOL + "|" + handshakeId;
        return new Keys(
                hkdfExpand(prk, info + "|enc", HASH_BYTES),
                hkdfExpand(prk, info + "|mac", HASH_BYTES),
                hkdfExpand(prk, info + "|file", HASH_BYTES));
    }

    /** 新机 → 旧机：证明自己持有配对密钥，且双方临时公钥与握手标识未被替换。 */
    public static String clientProof(Keys keys, String handshakeId, byte[] clientPub, byte[] serverPub)
            throws GeneralSecurityException {
        return hmacHex(keys.mac, "client-confirm|" + handshakeId + "|" + hex(clientPub) + "|" + hex(serverPub));
    }

    /** 旧机 → 新机：反向证明，避免新机只验证单向确认而被中间人套用会话。 */
    public static String serverProof(Keys keys, String handshakeId, byte[] clientPub, byte[] serverPub)
            throws GeneralSecurityException {
        return hmacHex(keys.mac, "server-confirm|" + handshakeId + "|" + hex(clientPub) + "|" + hex(serverPub));
    }

    /** 请求签名：方法、路径、查询串、Range、时间戳与一次性 nonce 全部纳入，防止篡改与重放。 */
    public static String requestAuth(Keys keys, String method, String path, String query, String range,
                                     long timeMillis, String nonce) throws GeneralSecurityException {
        String material = method + "\n" + path + "\n" + (query == null ? "" : query) + "\n"
                + (range == null ? "" : range) + "\n" + timeMillis + "\n" + (nonce == null ? "" : nonce);
        return hmacHex(keys.mac, material);
    }

    public static byte[] seal(byte[] key, byte[] nonce, byte[] aad, byte[] plain) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(TAG_BITS, nonce));
        if (aad != null && aad.length > 0) cipher.updateAAD(aad);
        return cipher.doFinal(plain);
    }

    public static byte[] open(byte[] key, byte[] nonce, byte[] aad, byte[] cipherText) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(TAG_BITS, nonce));
        if (aad != null && aad.length > 0) cipher.updateAAD(aad);
        return cipher.doFinal(cipherText);
    }

    public static byte[] fileKey(byte[] sessionFileKey, String fileId) throws GeneralSecurityException {
        return hkdfExpand(sessionFileKey, "file|" + fileId, HASH_BYTES);
    }

    /** AAD 绑定本次握手、文件、块序号与清单大小；任一项不符则解密失败。 */
    public static byte[] chunkAad(String handshakeId, String fileId, long chunkIndex, long size) {
        return ("chunk|" + handshakeId + "|" + fileId + "|" + chunkIndex + "|" + size)
                .getBytes(StandardCharsets.UTF_8);
    }

    /** 清单响应绑定本次签名请求的 nonce，防止同会话内的陈旧响应被原样替换。 */
    public static byte[] manifestAad(String handshakeId, String requestNonce) {
        return ("manifest|" + handshakeId + "|" + (requestNonce == null ? "" : requestNonce))
                .getBytes(StandardCharsets.UTF_8);
    }

    public static long chunkIndex(long plainOffset) {
        return plainOffset / FILE_CHUNK_SIZE;
    }

    public static long alignDown(long plainOffset) {
        return chunkIndex(plainOffset) * FILE_CHUNK_SIZE;
    }

    public static byte[] hkdfExtract(byte[] salt, byte[] ikm) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        byte[] actualSalt = salt == null || salt.length == 0 ? new byte[HASH_BYTES] : salt;
        mac.init(new SecretKeySpec(actualSalt, "HmacSHA256"));
        return mac.doFinal(ikm);
    }

    public static byte[] hkdfExpand(byte[] prk, String info, int length) throws GeneralSecurityException {
        if (length < 1 || length > 255 * HASH_BYTES) throw new GeneralSecurityException("HKDF 长度无效");
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(prk, "HmacSHA256"));
        byte[] infoBytes = info == null ? new byte[0] : info.getBytes(StandardCharsets.UTF_8);
        byte[] out = new byte[length];
        byte[] previous = new byte[0];
        int offset = 0;
        for (int counter = 1; offset < length; counter++) {
            mac.update(previous);
            mac.update(infoBytes);
            mac.update((byte) counter);
            previous = mac.doFinal();
            int copy = Math.min(previous.length, length - offset);
            System.arraycopy(previous, 0, out, offset, copy);
            offset += copy;
        }
        return out;
    }

    public static String hmacHex(byte[] key, String value) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return hex(mac.doFinal(value.getBytes(StandardCharsets.UTF_8)));
    }

    public static byte[] sha256(byte[] value) throws GeneralSecurityException {
        return MessageDigest.getInstance("SHA-256").digest(value);
    }

    public static byte[] randomBytes(SecureRandom random, int length) {
        byte[] bytes = new byte[length];
        random.nextBytes(bytes);
        return bytes;
    }

    public static String randomHex(SecureRandom random, int byteLength) {
        return hex(randomBytes(random, byteLength));
    }

    public static String hex(byte[] bytes) {
        if (bytes == null) return "";
        char[] out = new char[bytes.length * 2];
        final char[] table = "0123456789abcdef".toCharArray();
        for (int i = 0; i < bytes.length; i++) {
            int value = bytes[i] & 0xff;
            out[i * 2] = table[value >>> 4];
            out[i * 2 + 1] = table[value & 0x0f];
        }
        return new String(out);
    }

    public static byte[] unhex(String value) {
        if (value == null || (value.length() & 1) != 0) throw new IllegalArgumentException("十六进制格式无效");
        byte[] out = new byte[value.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int high = Character.digit(value.charAt(i * 2), 16);
            int low = Character.digit(value.charAt(i * 2 + 1), 16);
            if (high < 0 || low < 0) throw new IllegalArgumentException("十六进制包含非法字符");
            out[i] = (byte) ((high << 4) | low);
        }
        return out;
    }

    public static boolean constantTimeEquals(byte[] left, byte[] right) {
        if (left == null || right == null) return false;
        int diff = left.length ^ right.length;
        int length = Math.max(left.length, right.length);
        for (int i = 0; i < length; i++) {
            byte a = i < left.length ? left[i] : 0;
            byte b = i < right.length ? right[i] : 0;
            diff |= a ^ b;
        }
        return diff == 0;
    }

    public static boolean constantTimeEqualsHex(String left, String right) {
        if (left == null || right == null) return false;
        try {
            return constantTimeEquals(unhex(left), unhex(right));
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    private static ECParameterSpec p256() throws GeneralSecurityException {
        java.security.AlgorithmParameters parameters = java.security.AlgorithmParameters.getInstance("EC");
        parameters.init(new ECGenParameterSpec("secp256r1"));
        return parameters.getParameterSpec(ECParameterSpec.class);
    }

    private static boolean onCurve(BigInteger x, BigInteger y, EllipticCurve curve) {
        if (!(curve.getField() instanceof ECFieldFp)) return false;
        BigInteger p = ((ECFieldFp) curve.getField()).getP();
        if (x.signum() < 0 || x.compareTo(p) >= 0 || y.signum() < 0 || y.compareTo(p) >= 0) return false;
        BigInteger left = y.modPow(BigInteger.valueOf(2), p);
        BigInteger right = x.modPow(BigInteger.valueOf(3), p)
                .add(curve.getA().multiply(x))
                .add(curve.getB())
                .mod(p);
        return left.equals(right);
    }

    private static byte[] fixed(BigInteger value, int length) {
        byte[] raw = value.toByteArray();
        byte[] out = new byte[length];
        if (raw.length > length) {
            System.arraycopy(raw, raw.length - length, out, 0, length);
        } else {
            System.arraycopy(raw, 0, out, length - raw.length, raw.length);
        }
        return out;
    }

    private static byte[] normalize(byte[] secret) {
        if (secret.length == 32) return secret;
        byte[] out = new byte[32];
        if (secret.length > 32) {
            System.arraycopy(secret, secret.length - 32, out, 0, 32);
        } else {
            System.arraycopy(secret, 0, out, 32 - secret.length, secret.length);
        }
        return out;
    }

    private static byte[] concat(byte[]... parts) {
        int length = 0;
        for (byte[] part : parts) length += part == null ? 0 : part.length;
        byte[] out = new byte[length];
        int offset = 0;
        for (byte[] part : parts) {
            if (part == null) continue;
            System.arraycopy(part, 0, out, offset, part.length);
            offset += part.length;
        }
        return out;
    }
}
