import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { forgetImport, listPendingImports, subscribePendingImports, type PendingImport } from '../lib/pending-imports';
import { discardStoredVideo, listStagedVideos, recoverStoredVideos, uploadStoredVideo, type StoredVideo } from '../lib/video-store';

/**
 * 未完成的收录：退出 App 再打开后仍能从这里继续确认保存，不用重新选文件。
 * 上传失败但源视频已落盘的条目单独列出，可直接重试上传。
 */
export default function PendingImports() {
  const navigate = useNavigate();
  const [items, setItems] = useState<PendingImport[]>(() => listPendingImports());
  const [staged, setStaged] = useState<StoredVideo[]>(() => listStagedVideos());
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const refresh = () => { setItems(listPendingImports()); setStaged(listStagedVideos()); };
    refresh();
    // 冷启动先把私有目录里的 sidecar 补登记，localStorage 被清也不会把已保存的视频当成没导入。
    void recoverStoredVideos().finally(refresh);
    const unsubscribe = subscribePendingImports(refresh);
    window.addEventListener('dance-videos-changed', refresh);
    return () => {
      unsubscribe();
      window.removeEventListener('dance-videos-changed', refresh);
    };
  }, []);

  if (items.length === 0 && staged.length === 0) return null;

  const retry = async (video: StoredVideo) => {
    setBusy(video.id); setError('');
    try {
      const job = await uploadStoredVideo(video);
      navigate(`/imports/${job.id}`);
    } catch {
      setError('上传尚未完成，视频仍保存在手机里，可稍后重试');
    } finally { setBusy(''); }
  };

  const removeCopy = async (video: StoredVideo) => {
    setBusy(video.id); setError('');
    try {
      await discardStoredVideo(video.id);
      setStaged(listStagedVideos());
    } catch {
      // 删除失败时文件还在手机里，条目也还在，不能假装已删除。
      setError('删除失败，视频仍保存在手机里，请重试');
    } finally { setBusy(''); }
  };

  return (
    <section className="pending-shares" aria-label="未完成的收录">
      <header className="pending-shares__head">
        <h2>未完成的收录</h2>
        <span className="muted">{items.length + staged.length} 条</span>
      </header>
      {error && <p role="alert">{error}</p>}
      <ul className="pending-shares__list">
        {staged.map((video) => (
          <li key={video.id} className="pending-share">
            <div className="pending-share__body">
              <p className="pending-share__title">{video.name}</p>
              <p className="pending-share__state" role="status">
                {video.verified
                  ? '视频已保存到手机，等待上传'
                  : '内容待核实：缺少原始大小与摘要，无法确认副本完整，暂不能上传或播放；文件仍保留在手机里'}
              </p>
            </div>
            <div className="pending-share__actions">
              <button className="primary" disabled={busy === video.id || !video.verified} onClick={() => void retry(video)}>
                {busy === video.id ? '上传中…' : '继续上传'}
              </button>
              <button disabled={busy === video.id} onClick={() => void removeCopy(video)} aria-label="删除副本">删除副本</button>
            </div>
          </li>
        ))}
        {items.map((item) => (
          <li key={item.jobId} className="pending-share">
            <div className="pending-share__body">
              <p className="pending-share__title">{item.name}</p>
              <p className="pending-share__state" role="status">视频已导入，等待确认保存</p>
            </div>
            <div className="pending-share__actions">
              <button className="primary" onClick={() => navigate(`/imports/${item.jobId}`)}>继续</button>
              <button onClick={() => { forgetImport(item.jobId); setItems(listPendingImports()); }} aria-label="移除">移除</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
