import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import LibraryFilters from '../../src/components/LibraryFilters';
it('筛选草稿只有应用后生效，取消和重置草稿不改变当前条件', () => {
 const changes: unknown[] = [];
 render(<LibraryFilters kind="DANCE" value={{ status: 'CAN_DANCE', scenes: ['OUTDOOR'], demoOnly: false, cachedOnly: false }} onChange={v => changes.push(v)} />);
 fireEvent.click(screen.getByRole('button', { name: /筛选/ }));
 fireEvent.click(screen.getByRole('button', { name: '重置' }));
 fireEvent.click(screen.getByRole('button', { name: '取消' })); expect(changes).toEqual([]);
 fireEvent.click(screen.getByRole('button', { name: /筛选/ }));
 expect(screen.getByRole('button', { name: '户外' })).toHaveAttribute('aria-pressed','true');
 fireEvent.click(screen.getByRole('button', { name: '想学' }));
 fireEvent.click(screen.getByLabelText('仅示例')); fireEvent.click(screen.getByRole('button', { name: '应用筛选' }));
 expect(changes).toEqual([{ status:'WANT_TO_LEARN',scenes:['OUTDOOR'],demoOnly:true,cachedOnly:false }]);
});
it('唱歌使用会唱状态且不展示舞蹈场景', () => {
 render(<LibraryFilters kind="VOCAL" value={{status:null,scenes:[],demoOnly:false,cachedOnly:false}} onChange={()=>{}} />);
 fireEvent.click(screen.getByRole('button',{name:/筛选/}));expect(screen.getByRole('button',{name:'会唱'})).toBeVisible();expect(screen.queryByRole('button',{name:'户外'})).not.toBeInTheDocument();
});
