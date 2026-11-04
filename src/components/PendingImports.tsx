import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { forgetImport, listPendingImports, subscribePendingImports, type PendingImport } from '../lib/pending-imports';

/**
 * 未完成的收录：退出 App 再打开后仍能从这里继续确认保存，不用重新选文件。
 * 与「来自分享」并列，复用同一套队列样式。
 */
export default function PendingImports() {
  const navigate = useNavigate();
  const [items, setItems] = useState<PendingImport[]>(() => listPendingImports());

  useEffect(() => {
    const refresh = () => setItems(listPendingImports());
    refresh();
    return subscribePendingImports(refresh);
  }, []);

  if (items.length === 0) return null;

  return (
    <section className="pending-shares" aria-label="未完成的收录">
      <header className="pending-shares__head">
        <h2>未完成的收录</h2>
        <span className="muted">{items.length} 条</span>
      </header>
      <ul className="pending-shares__list">
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