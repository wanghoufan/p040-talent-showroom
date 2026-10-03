import {flushLocalFiles} from './lib/offline-files';
import {initializeLocalDatabase} from './lib/local-database';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './app/App';
import { applyTheme, parseStoredTheme, resolveTheme, systemPrefersDark, watchSystemTheme, THEME_STORAGE_KEY } from './app/theme';
import { applySystemBars } from './native/theme-bars';
import { watchSystemInsets } from './native/system-insets';
import './app/theme.css';
import './index.css';

// 启动即应用主题（默认跟随系统），避免首帧闪白/闪黑。
const mode = parseStoredTheme(
  typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_STORAGE_KEY) : null,
);
const initial = resolveTheme(mode, systemPrefersDark());
applyTheme(initial, document.documentElement);
void applySystemBars(initial === 'dark');
watchSystemInsets();
watchSystemTheme((prefersDark) => {
  if (parseStoredTheme(localStorage.getItem(THEME_STORAGE_KEY)) === 'system') {
    const resolved = resolveTheme(mode, prefersDark);
    applyTheme(resolved, document.documentElement);
    void applySystemBars(resolved === 'dark');
  }
});

const container = document.getElementById('root');
if (container === null) {
  throw new Error('root container missing');
}

await initializeLocalDatabase().catch(()=>window.dispatchEvent(new Event('dance-storage-error')));
void flushLocalFiles();window.addEventListener('online',()=>void flushLocalFiles());setInterval(()=>{if(document.visibilityState==='visible')void flushLocalFiles();},15000);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void flushLocalFiles();});
createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
