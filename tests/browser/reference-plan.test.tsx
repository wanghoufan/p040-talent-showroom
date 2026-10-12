import {MemoryRouter} from 'react-router-dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import SettingsPage from '../../src/pages/SettingsPage';

const holder = vi.hoisted(() => ({ manifest: null as unknown }));
vi.mock('../../src/lib/api', () => ({ api: vi.fn(async () => holder.manifest), jsonBody: (value: unknown) => value }));
// cachedFileValid 故意变慢，让「缓存检查」晚于联网清单一事完成：旧实现会用落后的本地清单把计划覆盖成 0/0。
vi.mock('../../src/native/filesystem', () => ({ offlineBytes: async () => 0, clearOfflineMedia: async () => {}, isOfflineSupported: () => true, downloadMedia: vi.fn(), cachedFileValid: () => new Promise(r => setTimeout(() => r(true), 30)) }));

const fresh = {
  catalogVersion: 1, playlist: [],
  items: [1, 2].map(i => ({ id: `d${i}`, title: `舞${i}`, artist: '', learningStatus: 'CAN_DANCE', sceneTags: [], performanceClipId: `c${i}`, durationMs: 1000, audio: { id: `c${i}`, url: `/api/media/audio/${i}`, sha256: `a${i}`, sizeBytes: 10, version: 1 }, source: { id: `s${i}`, sourceKind: 'VIDEO', durationMs: 1000, sha256: `s${i}hash`, url: `/api/media/reference/s${i}`, version: 1, sizeBytes: 100 * i } })),
};
// 旧版服务器写下的本地清单：有 source 但没有 url / 体积，referencePlan(本地) 应为 0。
const stale = {
  catalogVersion: 1, playlist: [],
  items: [{ id: 'old', title: '旧', learningStatus: 'CAN_DANCE', sceneTags: [], performanceClipId: 'c', durationMs: 1, audio: { id: 'c', url: '/api/media/audio/c', sha256: 'h', sizeBytes: 1, version: 1 }, source: { id: 's', sourceKind: 'VIDEO', durationMs: 1, sha256: 'sh' } }],
};

beforeEach(() => { localStorage.clear(); });

it('原视频计划以联网清单为准：落后的本地清单不会把总数/体积覆盖成 0', async () => {
  localStorage.setItem('dance.offline.manifest', JSON.stringify(stale));
  holder.manifest = fresh;
  await act(async () => { render(<MemoryRouter><SettingsPage /></MemoryRouter>); });
  await waitFor(() => expect(screen.getByText(/已缓存到手机：0\/2 个/)).toBeVisible());
  expect(screen.getByText(/全部下载约 300 B/)).toBeVisible();
});
