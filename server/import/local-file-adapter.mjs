/** 本地文件来源 adapter（T029）：由上传流提供，无需网络取得。 */
export const localFileAdapter = {
  id: 'local-file',
  label: '本地视频 / 音频文件',
  canAcquire: true,
  matches() { return false; }, // 本地文件不通过链接匹配，由 receiveFile 直接使用。
};
