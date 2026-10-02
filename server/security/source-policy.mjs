import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
const HOSTS = new Set(['v.douyin.com', 'www.douyin.com', 'douyin.com']);
export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a,b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    const first = parseInt(normalized.split(':')[0], 16);
    return first >= 0x2000 && first <= 0x3fff && !normalized.startsWith('2001:db8:') && !normalized.startsWith('2001:0:');
  }
  return false;
}
export function normalizeSourceLink(text) {
  if (typeof text !== 'string' || text.length > 8192) throw new Error('INVALID_SOURCE');
  const raw = text.match(/https?:\/\/[^\s<>"，。]+/)?.[0];
  if (!raw) throw new Error('INVALID_SOURCE');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw new Error('SOURCE_NOT_ALLOWED');
  url.hash = '';
  return url.href;
}
export async function validateSourceResolution(link, resolver = lookup) {
  const url = new URL(normalizeSourceLink(link));
  const addresses = await resolver(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({address}) => !isPublicAddress(address))) throw new Error('SOURCE_NOT_ALLOWED');
  return addresses;
}
// Every redirect must be normalized and resolved again before an adapter request.
// Default Douyin adapter has no media capability and never makes any request.
