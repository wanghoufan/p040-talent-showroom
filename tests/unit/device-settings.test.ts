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
it('主题持久化且非法数据安全回退', () => {
  localStorage.clear();
  expect(readDeviceSettings().themeMode).toBe('system');
  saveDeviceSettings({themeMode:'dark',apiEndpoint:'http://192.168.1.10:8791',cachePolicyVersion:1});
  expect(readDeviceSettings().themeMode).toBe('dark');
  localStorage.setItem('dance.device-settings','invalid-json');
  expect(readDeviceSettings().themeMode).toBe('system');
});
