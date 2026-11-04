import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { IDBFactory } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';
import { initializeLocalDatabase } from '../../src/lib/local-database';
import { VocalLibraryFilters, type VocalLanguageValue } from '../../src/components/LibraryFilters';
import TalentLibraryPage from '../../src/pages/TalentLibraryPage';
import type { TalentItem } from '../../src/lib/types';
const vocal = (id: string, title: string, learningStatus: TalentItem['learningStatus'], extra: Record<string, unknown> = {}): TalentItem => ({ id, kind: 'VOCAL', title, artist: '自己', learningStatus, originalKey: 'C', performanceKey: 'C', capo: 0, scoreText: '', notes: '', audioRole: 'ACCOMPANIMENT', durationMs: 0, ...extra });
it('唱歌筛选只有状态与语言两行，语言无数据时禁用且不倒推猜测', () => {
 render(<VocalLibraryFilters value={{ status: null, language: null }} availableLanguages={[]} onChange={() => {}} />);
 const statusRow = screen.getByRole('group', { name: '按学习状态筛选' });
 expect(within(statusRow).getAllByRole('button').map(b => b.textContent)).toEqual(['全部', '想学', '练习中', '已学会']);
 const languageRow = screen.getByRole('group', { name: '按语言筛选' });
 expect(within(languageRow).getAllByRole('button').map(b => b.textContent)).toEqual(['全部', '中文', '英文', '韩文']);
 for (const label of ['中文', '英文', '韩文']) expect(within(languageRow).getByRole('button', { name: label })).toBeDisabled();
 expect(within(languageRow).getByText('暂无语言信息')).toBeVisible();
 expect(screen.queryByRole('button', { name: /筛选/ })).not.toBeInTheDocument();
});
it('语言只在曲目真实携带 language 字段时可用并参与筛选', () => {
 function Harness() { const [value, setValue] = useState<VocalLanguageValue>({ status: null, language: null }); return <><VocalLibraryFilters value={value} availableLanguages={['KO']} onChange={setValue} /><output data-testid="value">{JSON.stringify(value)}</output></>; }
 render(<Harness />);
 const languageRow = screen.getByRole('group', { name: '按语言筛选' });
 expect(within(languageRow).getByRole('button', { name: '韩文' })).toBeEnabled();
 expect(within(languageRow).getByRole('button', { name: '中文' })).toBeDisabled();
 expect(screen.queryByText('暂无语言信息')).not.toBeInTheDocument();
 fireEvent.click(within(languageRow).getByRole('button', { name: '韩文' }));
 fireEvent.click(within(screen.getByRole('group', { name: '按学习状态筛选' })).getByRole('button', { name: '练习中' }));
 expect(JSON.parse(screen.getByTestId('value').textContent!)).toEqual({ status: 'PRACTICING', language: 'KO' });
 fireEvent.click(within(screen.getByRole('group', { name: '按学习状态筛选' })).getByRole('button', { name: '全部' }));
 expect(JSON.parse(screen.getByTestId('value').textContent!)).toEqual({ status: null, language: 'KO' });
});
it('曲库页按状态与语言组合直接筛选，语言缺失的曲目不会被虚构语言', async () => {
 localStorage.clear(); vi.stubGlobal('indexedDB', new IDBFactory()); await initializeLocalDatabase();
 const items = [vocal('v1', '별빛 궤도', 'PRACTICING', { language: 'ko' }), vocal('v2', '海风来信', 'PRACTICING'), vocal('v3', 'Open Windows', 'CAN_DANCE', { language: 'en' })];
 vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items }))));
 await act(async () => { render(<MemoryRouter initialEntries={['/repertoire/vocal']}><Routes><Route path="/repertoire/:kind" element={<TalentLibraryPage />} /></Routes></MemoryRouter>); });
 expect(await screen.findByText('별빛 궤도')).toBeVisible();
 fireEvent.click(screen.getByRole('button', { name: '韩文' }));
 expect(screen.getByText('별빛 궤도')).toBeVisible();
 expect(screen.queryByText('海风来信')).not.toBeInTheDocument();
 expect(screen.queryByText('Open Windows')).not.toBeInTheDocument();
 fireEvent.click(within(screen.getByRole('group', { name: '按语言筛选' })).getByRole('button', { name: '全部' }));
 fireEvent.click(within(screen.getByRole('group', { name: '按学习状态筛选' })).getByRole('button', { name: '已学会' }));
 expect(screen.getByText('Open Windows')).toBeVisible();
 expect(screen.queryByText('海风来信')).not.toBeInTheDocument();
 expect(document.querySelectorAll('.vocal-filters__row')).toHaveLength(2);
});
it('切到吉他时唱歌的语言条件不生效，吉他不出现两行筛选', async () => {
 localStorage.clear(); vi.stubGlobal('indexedDB', new IDBFactory()); await initializeLocalDatabase();
 const guide: TalentItem = { ...vocal('g1', '吉他曲', 'WANT_TO_LEARN'), kind: 'GUITAR', capo: 2 };
 const items = [vocal('v1', '별빛 궤도', 'PRACTICING', { language: 'ko' }), guide];
 vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items }))));
 await act(async () => { render(<MemoryRouter initialEntries={['/repertoire/vocal']}><Routes><Route path="/repertoire/:kind" element={<TalentLibraryPage />} /></Routes></MemoryRouter>); });
 expect(await screen.findByText('별빛 궤도')).toBeVisible();
 fireEvent.click(screen.getByRole('button', { name: '韩文' }));
 /* 类别切换已上移到 App 底栏（§8 V1.3-R2），页面内不再有分类链接：直接以吉他路由重进，验证同一行为。 */
 cleanup();
 await act(async () => { render(<MemoryRouter initialEntries={['/repertoire/guitar']}><Routes><Route path="/repertoire/:kind" element={<TalentLibraryPage />} /></Routes></MemoryRouter>); });
 expect(await screen.findByText('吉他曲')).toBeVisible();
 expect(document.querySelectorAll('.vocal-filters__row')).toHaveLength(0);
 expect(document.querySelector('.filter-entry')).toBeInTheDocument();
});
