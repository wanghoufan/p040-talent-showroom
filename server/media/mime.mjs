/**
 * 容器格式 → HTTP MIME（T089）。
 * ffprobe 的 format_name 是逗号分隔的 demuxer 家族（如 "mov,mp4,m4a,3gp,3g2,mj2"），
 * 首个名字不一定是最贴切的；matroska/webm 还会共用前缀，需结合视频编码区分。
 * 因此按来源类型给出优先顺序，而不是简单取第一个可识别名字。
 */
const MIME = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  webm: 'video/webm',
  matroska: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  flv: 'video/x-flv',
  ogg: 'video/ogg',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
};

const WEBM_CODECS = ['vp8', 'vp9', 'av1', 'opus', 'vorbis'];
const VIDEO_ORDER = ['matroska', 'mp4', 'mov', '3gp', '3g2', 'avi', 'mpeg', 'mpg', 'flv', 'ogg', 'webm'];
const AUDIO_ORDER = ['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'mp4', 'webm', 'matroska'];

export function mimeForContainer(container, kind = 'video', codec = null) {
  const names = String(container || '').toLowerCase().split(',').map((n) => n.trim());
  const has = (name) => names.includes(name);
  const isVideo = kind === 'video';
  const codecName = String(codec || '').toLowerCase();

  if ((has('webm') || has('matroska')) && WEBM_CODECS.includes(codecName)) return 'video/webm';
  if (isVideo && has('webm')) return 'video/webm';

  for (const name of isVideo ? VIDEO_ORDER : AUDIO_ORDER) if (has(name) && MIME[name]) return MIME[name];
  for (const name of names) if (MIME[name]) return MIME[name];
  return isVideo ? 'video/mp4' : 'audio/mp4';
}
