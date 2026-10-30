/** 统一错误类型：路由层据此映射 HTTP 状态码，不把内部路径回显给客户端。 */
export class VocalImportError extends Error {
  constructor(code, message, { status, cause, detail } = {}) {
    super(message || code);
    this.name = 'VocalImportError';
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code] ?? 400;
    if (cause) this.cause = cause;
    if (detail) this.detail = detail;
  }
}

export const STATUS_BY_CODE = Object.freeze({
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PATH_NOT_ALLOWED: 403,
  ROOT_NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  SOURCE_CHANGED: 409,
  JOB_BUSY: 409,
  VOCAL_IMPORT_SCHEMA_MISSING: 503,
  ROOT_UNAVAILABLE: 503,
});

export function fail(code, message, extra) {
  throw new VocalImportError(code, message, extra);
}
