package com.wanghoufan.dancelibrary;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 续传边界与配对密钥格式的定向测试（纯 Java，不启动服务、不读写真实数据）。
 */
public class MigrationWireTest {

    private static final long CHUNK = MigrationCrypto.FILE_CHUNK_SIZE;

    @Test
    public void partNameIsDeterministicAndBoundToHandshakeAndContent() {
        String sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        String name = MigrationWire.partName("aaaabbbbccccddddeeeeffff00001111", sha, "dance-offline/audio-1.mp3");
        assertEquals(name, MigrationWire.partName("aaaabbbbccccddddeeeeffff00001111", sha, "dance-offline/audio-1.mp3"));
        assertTrue(name.startsWith(".mig-"));
        assertTrue(name.endsWith(".part"));
        assertTrue(name.contains("0123456789abcdef"));
        assertTrue(name.contains("audio-1.mp3"));
        assertFalse(name.contains("/"));
        assertFalse(name.contains("\\"));

        // 换握手或换内容都不会复用同一个半包。
        assertNotEquals(name, MigrationWire.partName("11112222333344445555666677778888", sha,
                "dance-offline/audio-1.mp3"));
        assertNotEquals(name, MigrationWire.partName("aaaabbbbccccddddeeeeffff00001111", "f".repeat(64),
                "dance-offline/audio-1.mp3"));
        // 冲突分支按原始 entry.path 派生，不依赖随机冲突名，跨次运行可继续。
        assertEquals(name, MigrationWire.partName("aaaabbbbccccddddeeeeffff00001111", sha,
                "dance-offline/audio-1.mp3"));
    }

    @Test
    public void conflictNameIsDeterministicAndBoundToContent() {
        String sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        String name = MigrationWire.conflictName(sha, "dance-offline/video-1.mp4");
        // 同内容同名重试命中同一份隔离副本，不会每重试一次就多堆一份。
        assertEquals(name, MigrationWire.conflictName(sha, "dance-offline/video-1.mp4"));
        assertTrue(name.startsWith("conflict-"));
        assertTrue(name.contains("video-1.mp4"));
        assertFalse(name.contains("/"));
        assertFalse(name.contains("\\"));
        // 内容不同或文件名不同都不会互相覆盖。
        assertNotEquals(name, MigrationWire.conflictName("f".repeat(64), "dance-offline/video-1.mp4"));
        assertNotEquals(name, MigrationWire.conflictName(sha, "dance-offline/video-2.mp4"));
        // 超长路径按 basename 截断，仍不超过文件名上限。
        String longName = MigrationWire.conflictName(sha, "dance-offline/" + "a".repeat(120) + ".mp4");
        assertTrue(longName.length() <= 255);
        // 隔离副本名与断点文件名是两套命名，不会混用。
        assertNotEquals(name, MigrationWire.partName("aaaabbbbccccddddeeeeffff00001111", sha,
                "dance-offline/video-1.mp4"));
    }

    @Test
    public void onlyPartsFromOtherHandshakesAreSweepable() {
        String sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        String path = "dance-offline/audio-1.mp3";
        String handshake = "aaaabbbbccccddddeeeeffff00001111";
        String current = MigrationWire.partName(handshake, sha, path);
        String sameSessionOtherFile = MigrationWire.partName(handshake, "f".repeat(64), "dance-offline/audio-2.mp3");
        String otherSession = MigrationWire.partName("11112222333344445555666677778888", sha, path);

        assertTrue(MigrationWire.isForeignPart(otherSession, handshake));
        // 同一会话的其他未完成文件必须保留，否则「继续接收」的断点会丢。
        assertFalse(MigrationWire.isForeignPart(current, handshake));
        assertFalse(MigrationWire.isForeignPart(sameSessionOtherFile, handshake));
        // 普通文件与相似后缀不动。
        assertFalse(MigrationWire.isForeignPart("audio-1.mp3", handshake));
        assertFalse(MigrationWire.isForeignPart(current + ".bak", handshake));
        assertFalse(MigrationWire.isForeignPart(null, handshake));
    }

    @Test
    public void resumableOffsetDropsPartialAndOutOfRangePrefixes() {
        assertEquals(0, MigrationWire.resumableOffset(0, 10 * CHUNK, CHUNK));
        assertEquals(0, MigrationWire.resumableOffset(-1, 10 * CHUNK, CHUNK));
        assertEquals(0, MigrationWire.resumableOffset(10 * CHUNK + 1, 10 * CHUNK, CHUNK));
        assertEquals(3 * CHUNK, MigrationWire.resumableOffset(3 * CHUNK, 10 * CHUNK, CHUNK));
        assertEquals(3 * CHUNK, MigrationWire.resumableOffset(3 * CHUNK + 123, 10 * CHUNK, CHUNK));
        assertEquals(10 * CHUNK, MigrationWire.resumableOffset(10 * CHUNK, 10 * CHUNK, CHUNK));
        // 小于一个块的短文件，写满即视为完整；写了一半则回退到 0。
        assertEquals(123, MigrationWire.resumableOffset(123, 123, CHUNK));
        assertEquals(0, MigrationWire.resumableOffset(61, 123, CHUNK));
    }

    @Test
    public void pairingCodeNormalizationAcceptsCopyPasteVariants() {
        String code = MigrationWire.newPairingCode(new java.security.SecureRandom());
        String compact = code.replace(" ", "");
        assertEquals(code, MigrationWire.normalizePairingCode(compact));
        assertEquals(code, MigrationWire.normalizePairingCode(" " + compact + " "));
        assertEquals(code, MigrationWire.normalizePairingCode(compact.substring(0, 3) + "-" + compact.substring(3)));
        assertEquals(32, MigrationWire.pairingCodeBytes(code).length);
        assertTrue(MigrationWire.isValidPairingCode("000000"));
        assertFalse(MigrationWire.isValidPairingCode(compact.substring(0, 5)));
    }
}
