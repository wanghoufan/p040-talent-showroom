import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import MultiImportSheet from '../../src/components/MultiImportSheet';

const queueFile = vi.hoisted(() => vi.fn(async () => undefined as unknown));
vi.mock('../../src/lib/offline-files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/offline-files')>();
  return { ...actual, queueFile };
});

beforeEach(() => { queueFile.mockClear(); });

it('批量舞蹈视频进入 queueFile 持久链路，并在完成后明确提示已保存到手机', async () => {
  const { container } = render(<MultiImportSheet kind="DANCE" onClose={() => undefined} />);
  const file = new File([new Uint8Array(1024)], '批量舞蹈.mp4', { type: 'video/mp4' });
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;

  fireEvent.change(input, { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: '确认并开始收录' }));

  await waitFor(() => expect(queueFile).toHaveBeenCalledTimes(1));
  const [queued, ref, kind, options] = queueFile.mock.calls[0] as unknown as [File, { kind: string; id: string }, string, { title?: string }];
  expect(queued).toBe(file);
  expect(ref.kind).toBe('DANCE');
  expect(kind).toBe('MEDIA');
  expect(options.title).toBe('批量舞蹈');
  expect(await screen.findByText(/已保存到手机/)).toBeVisible();
});
