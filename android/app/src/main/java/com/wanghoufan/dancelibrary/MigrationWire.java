package com.wanghoufan.dancelibrary;

import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Locale;

/**
 * 换机迁移的纯协议工具（不依赖 Android API，便于单独编译做安全用例测试）。
 *
 * <p>这里只放「输入校验」与「HTTP Range 解析」这类必须可复用的判断：
 * 路径穿越、非法 Range、配对码/会话常时比较、非私有地址拒绝。
 *
 * <p>配对凭据是 6 位数字（与服务器配对码同一形态，用户只需看一眼数字），
 * 由限速、一次性、10 分钟有效期与「同网段 + 旧手机确认」共同兜住在线尝试；
 * 6 位码先经 SHA-256 展开再进 HKDF，不直接当密钥用。
 */
public final class MigrationWire {

    private static final char[] HEX = "0123456789abcdef".toCharArray();
    public static final int PAIRING_CODE_DIGITS = 6;
    /** 自动发现探针：旧手机 UDP 应答里只回 TCP 端口与一次性 token，不回数字码。 */
    public static final String DISCOVERY_PROBE = "P040MIG1";
    public static final int DISCOVERY_PORT = 42872;
    public static final long DISCOVERY_TOKEN_BYTES = 16;

    private MigrationWire() {}

    public static String hex(byte[] bytes) {
        if (bytes == null) return "";
        char[] out = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            int value = bytes[i] & 0xff;
            out[i * 2] = HEX[value >>> 4];
            out[i * 2 + 1] = HEX[value & 0x0f];
        }
        return new String(out);
    }

    /** 6 位数字配对码（000000–999999）；调用方仍须限制有效期与在线尝试次数。 */
    public static String newPairingCode(SecureRandom random) {
        String digits = String.format(Locale.US, "%0" + PAIRING_CODE_DIGITS + "d", random.nextInt(1_000_000));
        return groupPairingCode(digits);
    }

    /** 去掉空格/短横线后必须是 6 位数字；格式不合法返回 null。 */
    public static String normalizePairingCode(String raw) {
        if (raw == null) return null;
        StringBuilder digits = new StringBuilder(PAIRING_CODE_DIGITS);
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c == ' ' || c == '-' || c == '\t' || c == '\n' || c == '\r') continue;
            if (c < '0' || c > '9') return null;
            digits.append(c);
        }
        if (digits.length() != PAIRING_CODE_DIGITS) return null;
        return groupPairingCode(digits.toString());
    }

    public static boolean isValidPairingCode(String raw) {
        return normalizePairingCode(raw) != null;
    }

    /** 6 位码 → SHA-256 摘要，作为 HKDF 的输入密钥材料；不直接使用 6 位数字本身。 */
    public static byte[] pairingCodeBytes(String raw) {
        String normalized = normalizePairingCode(raw);
        if (normalized == null) throw new IllegalArgumentException("配对码格式无效");
        return sha256Bytes("p040-migration-pairing-v1|" + normalized.replace(" ", ""));
    }

    /** 自动发现 token 直接当输入密钥材料；token 是 128 位随机值，不经数字码。 */
    public static byte[] discoveryTokenBytes(String token) {
        if (token == null || token.length() != 32 || !isHexLower(token)) {
            throw new IllegalArgumentException("发现令牌格式无效");
        }
        return sha256Bytes("p040-migration-discovery-v1|" + token);
    }

    private static byte[] sha256Bytes(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return digest.digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (Exception error) {
            throw new IllegalStateException("设备不支持 SHA-256");
        }
    }

    private static boolean isHexLower(String value) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
        }
        return true;
    }

    private static String groupPairingCode(String compact) {
        int split = compact.length() / 2;
        return compact.substring(0, split) + " " + compact.substring(split);
    }

    /** 会话令牌只放内存，不写磁盘、不回传给 JS。 */
    public static String newSessionToken(SecureRandom random) {
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        return hex(bytes);
    }

    /** 常时比较，避免按字符提前返回泄露配对码或会话令牌。 */
    public static boolean constantTimeEquals(String a, String b) {
        if (a == null || b == null) return false;
        byte[] left = a.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] right = b.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        int diff = left.length ^ right.length;
        int length = Math.max(left.length, right.length);
        for (int i = 0; i < length; i++) {
            byte x = i < left.length ? left[i] : 0;
            byte y = i < right.length ? right[i] : 0;
            diff |= (x ^ y);
        }
        return diff == 0;
    }

    /** 只接受回环、链路本地、站点本地、CGNAT/Tailscale 与 IPv6 ULA；公网地址一律拒绝。 */
    public static boolean isPrivateAddress(InetAddress address) {
        if (address == null || address.isMulticastAddress()) return false;
        if (address.isLoopbackAddress() || address.isLinkLocalAddress() || address.isSiteLocalAddress()) return true;
        byte[] bytes = address.getAddress();
        if (bytes.length == 4) {
            int first = bytes[0] & 0xff;
            int second = bytes[1] & 0xff;
            // 100.64.0.0/10（Tailscale / 运营商级 NAT）。
            return first == 100 && second >= 64 && second <= 127;
        }
        if (bytes.length == 16) {
            // fc00::/7 ULA。
            return (bytes[0] & 0xfe) == 0xfc;
        }
        return false;
    }

    public static String normalizeIp(String value) {
        if (value == null) return "";
        String ip = value.trim();
        if (ip.startsWith("::ffff:")) ip = ip.substring(7);
        int zone = ip.indexOf('%');
        if (zone >= 0) ip = ip.substring(0, zone);
        return ip;
    }

    /**
     * 只允许「根目录/子目录/文件名」形式的相对路径：
     * 拒绝绝对路径、反斜杠、NUL、空段、`.`、`..` 与不常见字符，防止路径穿越。
     */
    public static String safeRelativePath(String raw) {
        if (raw == null) throw new IllegalArgumentException("路径为空");
        String value = raw;
        if (value.length() == 0 || value.length() > 240) throw new IllegalArgumentException("路径长度无效");
        if (value.charAt(0) == '/') throw new IllegalArgumentException("不允许绝对路径");
        if (value.indexOf('\\') >= 0) throw new IllegalArgumentException("不允许反斜杠");
        if (value.indexOf('\0') >= 0) throw new IllegalArgumentException("不允许 NUL");
        String[] parts = value.split("/", -1);
        for (String part : parts) {
            if (part.length() == 0 || part.equals(".") || part.equals("..")) {
                throw new IllegalArgumentException("路径包含非法段");
            }
            if (part.length() > 120) throw new IllegalArgumentException("路径段过长");
            for (int i = 0; i < part.length(); i++) {
                char c = part.charAt(i);
                boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                        || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
                if (!ok) throw new IllegalArgumentException("路径包含非法字符");
            }
        }
        return value;
    }

    public static String safeBaseName(String raw) {
        if (raw == null) return "file";
        String value = raw;
        int slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
        if (slash >= 0) value = value.substring(slash + 1);
        if (value.length() == 0) return "file";
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < value.length() && out.length() < 80; i++) {
            char c = value.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
            out.append(ok ? c : '_');
        }
        return out.length() == 0 ? "file" : out.toString();
    }

    /**
     * 断点文件名绑定「本次握手 + 清单里的内容摘要」，跨会话/跨内容不会误用旧半包。
     * 以 '.' 开头，旧机扫描清单时会跳过它。
     */
    public static String partName(String handshakeId, String sha256, String originalPath) {
        String handshakePrefix = prefixOfHex(handshakeId, 12);
        String hashPrefix = prefixOfHex(sha256, 16);
        return ".mig-" + handshakePrefix + "-" + hashPrefix + "-" + safeBaseName(originalPath) + ".part";
    }

    /**
     * 隔离副本名绑定「原始路径 + 内容摘要」，不再用随机名：
     * 同一次迁移重试、或失败后再次点接收，都会命中同一份隔离副本，
     * 既不会重复下载，也不会在 migration-inbox/conflicts 里越堆越多。
     * 内容不同则摘要不同，不会互相覆盖。
     */
    public static String conflictName(String sha256, String originalPath) {
        return "conflict-" + prefixOfHex(sha256, 16) + "-" + safeBaseName(originalPath);
    }

    /**
     * 是否属于「其他握手」留下的旧断点。这类 .part 绑定的是已失效的握手，本次会话不可能复用，
     * 只会在目标目录白占空间；当前会话自己的半包（含同一会话其他未完成文件）一律不动。
     */
    public static boolean isForeignPart(String name, String handshakeId) {
        if (name == null || handshakeId == null) return false;
        if (!name.startsWith(".mig-") || !name.endsWith(".part")) return false;
        return !name.startsWith(".mig-" + prefixOfHex(handshakeId, 12) + "-");
    }

    private static String prefixOfHex(String value, int length) {
        StringBuilder out = new StringBuilder(length);
        if (value != null) {
            for (int i = 0; i < value.length() && out.length() < length; i++) {
                char c = Character.toLowerCase(value.charAt(i));
                boolean hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
                out.append(hex ? c : '0');
            }
        }
        while (out.length() < length) out.append('0');
        return out.toString();
    }

    /**
     * 续传起点：超过清单大小、或不是完整块边界时回退，避免把半块当已认证前缀。
     * 调用方按返回值截断 .part 后才继续写入。
     */
    public static long resumableOffset(long partLength, long expected, long chunkSize) {
        if (partLength <= 0 || expected <= 0 || chunkSize <= 0) return 0;
        if (partLength > expected) return 0;
        if (partLength == expected) return expected;
        long remainder = partLength % chunkSize;
        return remainder == 0 ? partLength : partLength - remainder;
    }

    public static boolean isHexSha256(String value) {
        if (value == null || value.length() != 64) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
            if (!ok) return false;
        }
        return true;
    }

    /** 只解析单段 Range；多段、非法或越界都抛异常，由调用方回 416。 */
    public static ByteRange parseRange(String header, long size) {
        if (header == null || header.trim().isEmpty()) return null;
        if (size <= 0) throw new IllegalArgumentException("空文件不支持 Range");
        String value = header.trim();
        if (!value.startsWith("bytes=")) throw new IllegalArgumentException("Range 单位无效");
        String spec = value.substring(6).trim();
        if (spec.isEmpty() || spec.indexOf(',') >= 0) throw new IllegalArgumentException("只支持单段 Range");
        int dash = spec.indexOf('-');
        if (dash < 0) throw new IllegalArgumentException("Range 格式无效");
        String startText = spec.substring(0, dash).trim();
        String endText = spec.substring(dash + 1).trim();
        long start;
        long end;
        try {
            if (startText.isEmpty()) {
                long suffix = Long.parseLong(endText);
                if (suffix <= 0) throw new IllegalArgumentException("Range 后缀无效");
                if (suffix > size) suffix = size;
                start = size - suffix;
                end = size - 1;
            } else {
                start = Long.parseLong(startText);
                if (start < 0 || start >= size) throw new IllegalArgumentException("Range 起点越界");
                if (endText.isEmpty()) {
                    end = size - 1;
                } else {
                    end = Long.parseLong(endText);
                    if (end < start) throw new IllegalArgumentException("Range 终点无效");
                    if (end >= size) end = size - 1;
                }
            }
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException("Range 数字无效");
        }
        return new ByteRange(start, end);
    }

    public static String mimeOf(String path) {
        String lower = path == null ? "" : path.toLowerCase(Locale.US);
        if (lower.endsWith(".mp4")) return "video/mp4";
        if (lower.endsWith(".m4a")) return "audio/mp4";
        if (lower.endsWith(".mp3")) return "audio/mpeg";
        if (lower.endsWith(".aac")) return "audio/aac";
        if (lower.endsWith(".wav")) return "audio/wav";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".pdf")) return "application/pdf";
        if (lower.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    public static final class ByteRange {
        public final long start;
        public final long end;

        ByteRange(long start, long end) {
            this.start = start;
            this.end = end;
        }

        public long length() {
            return end - start + 1;
        }
    }
}
