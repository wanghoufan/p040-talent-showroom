import { beforeEach, expect, it, vi } from 'vitest';
import { forgetImport, listPendingImports, rememberImport } from '../../src/lib/pending-imports';

beforeEach(() => localStorage.clear());

it('收录任务按 jobId 去重并保留最近一条文件名', () => {
  rememberImport('job-1', '第一支舞.mp4');
  rememberImport('job-2', '第二支舞.mp4');
  rememberImport('job-1', '第一支舞（改名）.mp4');

  const items = listPendingImports();
  expect(items.map((item) => item.jobId)).toEqual(['job-1', 'job-2']);
  expect(items[0].name).toBe('第一支舞（改名）.mp4');
});

it('确认保存或明确失败后移除任务；损坏的存档按空处理', () => {
  rememberImport('job-1', 'demo.mp4');
  forgetImport('job-1');
  expect(listPendingImports()).toEqual([]);

  localStorage.setItem('dance.pending-imports.v1', '{not json');
  expect(listPendingImports()).toEqual([]);

  localStorage.setItem('dance.pending-imports.v1', JSON.stringify([{ name: '无 jobId' }, { jobId: 'kept' }]));
  expect(listPendingImports().map((item) => item.jobId)).toEqual(['kept']);
});

it('最多保留 20 条，避免长期堆积占满本地存储', () => {
  for (let i = 0; i < 25; i += 1) rememberImport(`job-${i}`, `视频 ${i}.mp4`);
  const items = listPendingImports();
  expect(items).toHaveLength(20);
  expect(items[0].jobId).toBe('job-24');
});

it('写入后派发变更事件，曲库页可即时刷新', () => {
  const listener = vi.fn();
  window.addEventListener('dance-pending-imports-changed', listener);
  rememberImport('job-1', 'a.mp4');
  forgetImport('job-1');
  expect(listener).toHaveBeenCalledTimes(2);
  window.removeEventListener('dance-pending-imports-changed', listener);
});