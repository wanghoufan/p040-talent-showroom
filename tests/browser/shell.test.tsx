import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import App from '../../src/app/App';

const renderAt = (pathname: string) =>
  render(
    <MemoryRouter initialEntries={[pathname]}>
      <App />
    </MemoryRouter>,
  );

const tabbar = () => within(screen.getByRole('navigation', { name: '主导航' }));

describe('基础界面', () => {
  it('空库不向用户展示开发过程', () => {
    renderAt('/');
    expect(screen.queryByText(/后续阶段|基础工程/)).not.toBeInTheDocument();
    expect(screen.getByText('还没有收录舞蹈')).toBeVisible();
  });
});

describe('导航重组（AC-NAV-01～07）', () => {
  it('AC-NAV-01 底部固定四个主 Tab：舞蹈 / 唱歌 / 吉他 / 我的', () => {
    renderAt('/');
    const bar = tabbar();
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeVisible();
    for (const name of ['舞蹈', '唱歌', '吉他', '我的']) {
      expect(bar.getByRole('link', { name })).toBeVisible();
    }
    expect(bar.getAllByRole('link')).toHaveLength(4);
    expect(bar.getByRole('link', { name: '舞蹈' })).toHaveAttribute('href', '/');
    expect(bar.getByRole('link', { name: '唱歌' })).toHaveAttribute('href', '/repertoire/vocal');
    expect(bar.getByRole('link', { name: '吉他' })).toHaveAttribute('href', '/repertoire/guitar');
    expect(bar.getByRole('link', { name: '我的' })).toHaveAttribute('href', '/settings');
  });

  it('AC-NAV-02 选中态随 pathname 变化，切换后立即生效', () => {
    renderAt('/');
    expect(tabbar().getByRole('link', { name: '舞蹈' })).toHaveAttribute('aria-current', 'page');

    fireEvent.click(tabbar().getByRole('link', { name: '唱歌' }));
    expect(tabbar().getByRole('link', { name: '唱歌' })).toHaveAttribute('aria-current', 'page');
    expect(tabbar().getByRole('link', { name: '舞蹈' })).not.toHaveAttribute('aria-current');

    fireEvent.click(tabbar().getByRole('link', { name: '吉他' }));
    expect(tabbar().getByRole('link', { name: '吉他' })).toHaveAttribute('aria-current', 'page');
    expect(tabbar().getByRole('link', { name: '唱歌' })).not.toHaveAttribute('aria-current');

    fireEvent.click(tabbar().getByRole('link', { name: '我的' }));
    expect(tabbar().getByRole('link', { name: '我的' })).toHaveAttribute('aria-current', 'page');
    expect(tabbar().getByRole('link', { name: '吉他' })).not.toHaveAttribute('aria-current');

    fireEvent.click(tabbar().getByRole('link', { name: '舞蹈' }));
    expect(tabbar().getByRole('link', { name: '舞蹈' })).toHaveAttribute('aria-current', 'page');
  });

  it('AC-NAV-03 顶部分类不再与底栏重复，顶部改为演出专区', () => {
    renderAt('/');
    expect(screen.queryByRole('navigation', { name: '才艺分类' })).not.toBeInTheDocument();
    const shows = within(screen.getByRole('navigation', { name: '演出专区' }));
    expect(shows.getByRole('link', { name: '今晚节目单' })).toBeVisible();
    expect(shows.getByRole('link', { name: '演出模式' })).toBeVisible();
  });

  it('AC-NAV-04 顶部两个演出入口可达（学习页与常规列表同样可见）', () => {
    renderAt('/repertoire/guitar');
    const shows = within(screen.getByRole('navigation', { name: '演出专区' }));
    expect(shows.getByRole('link', { name: '今晚节目单' })).toHaveAttribute('href', '/tonight');
    expect(shows.getByRole('link', { name: '演出模式' })).toHaveAttribute('href', '/perform');

    fireEvent.click(shows.getByRole('link', { name: '今晚节目单' }));
    expect(screen.getByRole('heading', { level: 1, name: '今晚节目单' })).toBeVisible();

    fireEvent.click(within(screen.getByRole('navigation', { name: '演出专区' })).getByRole('link', { name: '演出模式' }));
    expect(screen.getByRole('heading', { level: 1, name: '演出模式' })).toBeVisible();
  });

  it('AC-NAV-05 深链 /repertoire/vocal 直接进入且「唱歌」选中', () => {
    renderAt('/repertoire/vocal');
    expect(tabbar().getByRole('link', { name: '唱歌' })).toHaveAttribute('aria-current', 'page');
    expect(tabbar().getByRole('link', { name: '舞蹈' })).not.toHaveAttribute('aria-current');
  });

  it('AC-NAV-05 深链 /repertoire/guitar 时「吉他」选中', () => {
    renderAt('/repertoire/guitar');
    expect(tabbar().getByRole('link', { name: '吉他' })).toHaveAttribute('aria-current', 'page');
  });

  it('AC-NAV-06 演出页不属于任何底栏 Tab，但底栏仍可回到学习类别', () => {
    renderAt('/tonight');
    for (const name of ['舞蹈', '唱歌', '吉他', '我的']) {
      expect(tabbar().getByRole('link', { name })).not.toHaveAttribute('aria-current');
    }
    fireEvent.click(tabbar().getByRole('link', { name: '唱歌' }));
    expect(tabbar().getByRole('link', { name: '唱歌' })).toHaveAttribute('aria-current', 'page');
  });

  it('「我的」仍可访问设置页', () => {
    renderAt('/settings');
    expect(tabbar().getByRole('link', { name: '我的' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: '我的' })).toBeVisible();
  });
});
