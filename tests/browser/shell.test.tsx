import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import App from '../../src/app/App';
describe('基础界面', () => {
  it('四个入口可访问，空库不向用户展示开发过程', () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    for (const name of ['曲库', '今晚节目单', '演出模式', '我的']) {
      expect(screen.getByRole('link', { name })).toBeVisible();
    }
    expect(screen.queryByText(/后续阶段|基础工程/)).not.toBeInTheDocument();
    expect(screen.getByText('还没有收录舞蹈')).toBeVisible();
  });
});
