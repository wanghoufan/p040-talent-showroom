import { createHash } from 'node:crypto';

/**
 * 与计划包 Python 端 `uuid.uuid5(ID_NS, audio_sha256)` 完全一致的 UUIDv5。
 * songId 必须跨语言稳定：同一首音频在 Python 预检与 Node 队列里得到同一个 songId。
 */
export const VOCAL_IMPORT_NAMESPACE = '630cf7b7-e9fa-48ac-adc5-c8b983f1d8d5';

export function uuid5(namespace, name) {
  const namespaceBytes = Buffer.from(String(namespace).replace(/-/g, ''), 'hex');
  if (namespaceBytes.length !== 16) throw new TypeError('INVALID_UUID_NAMESPACE');
  const digest = createHash('sha1')
    .update(namespaceBytes)
    .update(Buffer.from(String(name), 'utf8'))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 音频内容 → songId。不同 SHA 必为不同 songId，所以不同版本不会被静默合并。 */
export function songIdForAudioSha(sha256) {
  return uuid5(VOCAL_IMPORT_NAMESPACE, sha256);
}
