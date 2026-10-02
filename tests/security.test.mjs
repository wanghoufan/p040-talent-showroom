import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlledPath } from '../server/security/paths.mjs';
import { isPublicAddress, normalizeSourceLink } from '../server/security/source-policy.mjs';

test('media root rejects traversal and symlink escapes while retaining Unicode names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dance-root-'));
  const root = join(dir, 'media'); mkdirSync(root);
  writeFileSync(join(root, '舞蹈 🎵.mp4'), 'fixture');
  writeFileSync(join(dir, 'outside'), 'outside');
  symlinkSync(join(dir, 'outside'), join(root, 'escape'));
  try {
    assert.equal(controlledPath(root, '舞蹈 🎵.mp4'), realpathSync(join(root, '舞蹈 🎵.mp4')));
    for (const name of ['../outside', '/etc/passwd', 'escape', '..\\outside', '\u0000.mp4']) assert.throws(() => controlledPath(root, name));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('source links accept only exact registered HTTPS hosts, never generic downloads', () => {
  assert.equal(normalizeSourceLink('分享 https://v.douyin.com/abc123/ 看看'), 'https://v.douyin.com/abc123/');
  for (const url of ['http://v.douyin.com/a', 'https://v.douyin.com.evil.test/a', 'https://user@v.douyin.com/a', 'https://127.0.0.1/a', 'https://[::1]/', 'file:///etc/passwd', 'https://v.douyin.com:8080/a']) assert.throws(() => normalizeSourceLink(url));
});

test('SSRF addresses reject local, link-local, mapped IPv4 and reserved ranges', () => {
  for (const ip of ['0.0.0.0','10.0.0.1','127.0.0.1','169.254.169.254','172.16.0.1','192.168.0.1','100.64.0.1','::1','::','fe80::1','fc00::1','::ffff:127.0.0.1','::ffff:7f00:1']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
});
