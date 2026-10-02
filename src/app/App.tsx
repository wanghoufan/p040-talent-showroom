import { useEffect } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { NAV_TABS } from './routes';
import { ingestNativeShares, submitAllPending } from '../lib/pending-shares';
import { onNativeShare } from '../native/share-target';
import LibraryPage from '../pages/LibraryPage';
import ImportReviewPage from '../pages/ImportReviewPage';
import DanceDetailPage from '../pages/DanceDetailPage';
import ReferenceVideoPage from '../pages/ReferenceVideoPage';
import PerformancePage from '../pages/PerformancePage';
import SettingsPage from '../pages/SettingsPage';
import TonightPlaylistPage from '../pages/TonightPlaylistPage';

/**
 * Foundation 空壳（T007/T013/T015）。
 *
 * 只实现：四 Tab 底部导航、light/dark token 生效、safe-area、48dp 触控目标。
 * 各用户故事的真实页面在 Phase 4+ 替换这里的 EmptyShell。
 */

interface EmptyShellProps {
  title: string;
  hint: string;
}

function EmptyShell({ title, hint }: EmptyShellProps) {
  return (
    <section className="shell" aria-labelledby="shell-title">
      <header className="shell__header">
        <h1 id="shell-title" className="shell__title">
          {title}
        </h1>
      </header>
      <div className="shell__empty">
        <div className="shell__badge" aria-hidden="true">
          ♪
        </div>
        <p className="shell__hint">{hint}</p>
      </div>
    </section>
  );
}

export default function App() {
  useEffect(() => {
    // 启动即 drain 原生分享队列（冷启动可在冷启动后立即取到），再尝试提交。
    void (async () => {
      await ingestNativeShares();
      await submitAllPending();
    })();
    const onVisible = () => { if (document.visibilityState === 'visible') void (async () => { await ingestNativeShares(); await submitAllPending(); })(); };
    const onOnline = () => void submitAllPending();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    let unsubscribe: () => void = () => {};
    void onNativeShare(() => { void (async () => { await ingestNativeShares(); await submitAllPending(); })(); }).then((fn) => { unsubscribe = fn; });
    return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('online', onOnline); unsubscribe(); };
  }, []);

  return (
    <div className="app-shell">
      <main className="app-main" id="main">
        <Routes>
          <Route
            path="/"
            element={<LibraryPage />}
          />
          <Route
            path="/tonight"
            element={<TonightPlaylistPage />}
          />
          <Route path="/perform" element={<PerformancePage />} />
          <Route
            path="/settings"
            element={<SettingsPage />}
          />
          <Route path="/imports/:id" element={<ImportReviewPage/>}/>
          <Route path="/dances/:id" element={<DanceDetailPage/>}/>
          <Route path="/reference/:id" element={<ReferenceVideoPage/>}/>
          <Route
            path="*"
            element={<EmptyShell title="未找到" hint="页面不存在。" />}
          />
        </Routes>
      </main>
      <nav className="tabbar" aria-label="主导航">
        {NAV_TABS.map((tab) => (
          <NavLink
            key={tab.key}
            to={tab.path}
            end={tab.path === '/'}
            className={({ isActive }) => (isActive ? 'tab tab--active' : 'tab')}
          >
            <span className="tab__label">{tab.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
