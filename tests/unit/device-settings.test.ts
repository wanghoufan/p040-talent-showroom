import { expect, it } from 'vitest';
import { validateEndpoint, readDeviceSettings, saveDeviceSettings } from '../../src/lib/device-settings';
it('服务器地址只接受私有网络，开发回环必须显式允许', () => {
  expect(validateEndpoint('http://192.168.31.10:8791')).toBe('http://192.168.31.10:8791');
  expect(validateEndpoint('http://dance.local:8791/')).toBe('http://dance.local:8791');
  expect(() => validateEndpoint('https://example.com')).toThrow();
  expect(() => validateEndpoint('http://127.0.0.1:8791')).toThrow();
  expect(validateEndpoint('http://127.0.0.1:8791',true)).toBe('http://127.0.0.1:8791');
  for(const value of ['http://user:pass@192.168.1.2','http://192.168.1.2/path','http://192.168.1.2?key=x','file:///etc/passwd','http://999.168.1.2']) expect(() => validateEndpoint(value)).toThrow();
});
it('Tailscale 通道：接受 100.64/10 与 *.ts.net，拒绝相邻公网段', () => {
  expect(validateEndpoint('http://100.125.100.15:28794')).toBe('http://100.125.100.15:28794');
  expect(validateEndpoint('http://100.64.0.1:28794')).toBe('http://100.64.0.1:28794');
  expect(validateEndpoint('http://100.127.255.254:28794')).toBe('http://100.127.255.254:28794');
  expect(validateEndpoint('http://mac-mini.tail1234.ts.net:28794')).toBe('http://mac-mini.tail1234.ts.net:28794');
  for(const value of ['http://100.63.0.1:28794','http://100.128.0.1:28794','http://ts.net:28794','http://evil-ts.net:28794']) expect(() => validateEndpoint(value)).toThrow();
});
it('主题持久化且非法数据安全回退', () => {
  localStorage.clear();
  expect(readDeviceSettings().themeMode).toBe('system');
  saveDeviceSettings({themeMode:'dark',apiEndpoint:'http://192.168.1.10:8791',cachePolicyVersion:1});
  expect(readDeviceSettings().themeMode).toBe('dark');
  localStorage.setItem('dance.device-settings','invalid-json');
  expect(readDeviceSettings().themeMode).toBe('system');
});
