import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REFERENCE_SCHEMA, normalizeReference, verifyIdentity } from './reference.mjs';

// 私人曲目参考保存在 Git 忽略的本地数据目录，不随公开代码分发。
// 文件不存在时目录为空；格式错误时明确失败，避免悄悄使用错误数据。
const defaultPath = fileURLToPath(new URL('../../var/private-reference/catalog.json', import.meta.url));
const catalogPath = process.env.P040_REFERENCE_CATALOG || defaultPath;
const raw = existsSync(catalogPath) ? JSON.parse(readFileSync(catalogPath, 'utf8')) : [];
if (!Array.isArray(raw)) throw new Error('参考目录文件必须是数组');
export const REFERENCE_CATALOG = Object.freeze(raw.map((entry) => {
  if (!entry || typeof entry.id !== 'string' || entry.schema !== REFERENCE_SCHEMA || !Array.isArray(entry.candidates)) {
    throw new Error('参考目录条目格式无效');
  }
  normalizeReference(entry);
  return Object.freeze(entry);
}));

function cloneEntry(entry) {
  return {
    ...entry,
    artistAliases: [...(entry.artistAliases ?? [])],
    titleAliases: [...(entry.titleAliases ?? [])],
    candidates: entry.candidates.map((candidate) => ({
      ...candidate,
      ...(candidate.alternates ? { alternates: [...candidate.alternates] } : {}),
    })),
  };
}

/** 按 id 取一份可直接交给 `setStructureReference` 的参考载荷；取不到返回 null。 */
export function catalogReference(id) {
  const entry = REFERENCE_CATALOG.find((item) => item.id === String(id ?? ''));
  return entry ? cloneEntry(entry) : null;
}

function norm(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/**
 * 目录条目 × 本机曲目：逐条跑身份五项核验。
 *
 * `relevant` 只用于界面收敛：歌名相同（同一首歌的不同版本/错误歌手）或身份已全过才展示；
 * 其它歌的参考不会出现在这首歌的练歌页里，避免用户误点。
 */
export function catalogEntriesFor({ item, audioSha256 } = {}) {
  return REFERENCE_CATALOG.map((entry) => {
    const reference = normalizeReference(entry);
    const identity = verifyIdentity({ reference, item, audioSha256 });
    const relevant = norm(entry.songTitle) === norm(item?.title);
    return {
      id: entry.id,
      songTitle: entry.songTitle,
      artist: entry.artist,
      version: entry.version,
      candidateCount: entry.candidates.length,
      disputedCount: entry.candidates.filter((candidate) => (candidate.alternates ?? []).length > 0).length,
      source: entry.source,
      note: entry.note,
      relevant: relevant || identity.ok,
      identity,
    };
  });
}
