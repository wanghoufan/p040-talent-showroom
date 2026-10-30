/**
 * 扫描与队列共用的「必须人工核对」问题清单。
 *
 * 判定口径：只有**无法安全自动决定**的问题才进这里（版本/歌词/伴奏/标签歧义）。
 * 可以如实记录但不需要人工点头的问题（缺歌词、尾部少量损坏、无时戳歌词、
 * 文件名未标原唱/伴奏）不阻断自动流程，符合 AC08「一首异常不拖垮整批」。
 */
export const REVIEW_ISSUES = Object.freeze([
  'multiple-lyrics-candidates',
  'lyrics-needs-confirmation',
  'invalid-audio',
  'lyrics-invalid-tags',
  'lyrics-timestamp-exceeds-audio',
  'multiple-accompaniment-candidates',
  'same-title-different-audio-review',
  'role-conflict-same-audio',
  'filename-id3-title-conflict',
  'filename-id3-artist-conflict',
  'pcm-duplicate-different-file',
]);

const REVIEW_SET = new Set(REVIEW_ISSUES);

export function isReviewIssue(issue) {
  return REVIEW_SET.has(issue);
}

export function needsReview(issues = []) {
  return issues.some(issue => REVIEW_SET.has(issue));
}
