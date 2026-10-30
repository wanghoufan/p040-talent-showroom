/**
 * V3.1 本地 AI 智能导入——安全扫描 / 匹配 / 独立后台队列 / 本机分离 / 曲库入库。
 *
 * 边界（尚未完成，不得据此宣布 V3.1 完工）：
 * - 本机分离器已接入，但真实 audio-separator / MLX 模型未在用户 M4 上安装与实测；
 * - 曲库入库已接入既有表，保留人工歌词/结构，同 songId 双轨；
 * - UI 与手机端状态尚未接入。
 */
export { readVocalImportConfig } from './config.mjs';
export { createVocalImportIntegration } from './integration.mjs';
export { createLocalSeparator } from './separator.mjs';
export { createRepertoireImporter } from './importer.mjs';
export { createSourcePolicy } from './source-policy.mjs';
export { scanSource } from './scan.mjs';
export { createVocalImportQueue, openVocalImportQueue } from './queue.mjs';
export { mountVocalImportRoutes } from './routes.mjs';
export { VocalImportError, STATUS_BY_CODE } from './errors.mjs';
export { REVIEW_ISSUES, isReviewIssue, needsReview } from './issues.mjs';
export { artistKey, canonical, detectLanguage, nameIdentity, versionLabels } from './canonical.mjs';
export { parseLrcFile, parseLrcText, declaredLengthMs } from './lrc.mjs';
export {
  buildLyricRepeatSuggestions,
  normalizeRepeatText,
  LYRIC_REPEAT_SCHEMA,
  LYRIC_REPEAT_SOURCE,
  LYRIC_REPEAT_STATUS,
  LYRIC_REPEAT_UNKNOWN,
} from './lyrics-repeat.mjs';
export { songIdForAudioSha, uuid5, VOCAL_IMPORT_NAMESPACE } from './uuid5.mjs';
export { probeAudio, TAIL_DAMAGE_MIN_COVERAGE, FULL_DECODE_MIN_COVERAGE } from './probe.mjs';
