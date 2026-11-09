/**
 * 换机迁移配对码的展示/输入规范化（与原生 MigrationWire 同口径）。
 *
 * 6 位数字，中间加一个空格便于口述与核对（形如 `123 456`）；
 * 归一化时接受空格、短横线与前后空白。安全靠限速、一次性、10 分钟有效期，
 * 以及自动发现路径下旧手机必须点一次「允许」，不靠加长码长。
 */
/** 返回 `123 456` 形式；格式不合法时返回空字符串。 */
export function normalizeMigrationKey(raw: string): string {
  const digits = raw.replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(digits)) return '';
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

export function isValidMigrationKey(raw: string): boolean {
  return normalizeMigrationKey(raw) !== '';
}
