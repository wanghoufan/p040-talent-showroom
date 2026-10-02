/** 手动音频来源 adapter：用户自备音频（含封面）时使用。 */
export const manualAudioAdapter = {
  id: 'manual-audio',
  label: '手动音频',
  canAcquire: true,
  matches() { return false; },
};
