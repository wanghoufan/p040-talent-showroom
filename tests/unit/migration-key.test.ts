import { describe, expect, it } from 'vitest';
import { isValidMigrationKey, normalizeMigrationKey } from '../../src/lib/migration-key';

describe('换机迁移配对码格式', () => {
  it('接受紧凑、分组、短横线与前后空白，归一为「123 456」', () => {
    expect(normalizeMigrationKey('123456')).toBe('123 456');
    expect(normalizeMigrationKey('123 456')).toBe('123 456');
    expect(normalizeMigrationKey(' 123-456 ')).toBe('123 456');
    expect(normalizeMigrationKey('000000')).toBe('000 000');
    expect(isValidMigrationKey('123456')).toBe(true);
  });

  it('拒绝长度不符、非数字与旧版 32 位字母密钥', () => {
    expect(isValidMigrationKey('12345')).toBe(false);
    expect(isValidMigrationKey('1234567')).toBe(false);
    expect(isValidMigrationKey('12a456')).toBe(false);
    expect(isValidMigrationKey('')).toBe(false);
    expect(isValidMigrationKey('ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-4567-89AB')).toBe(false);
  });
});
