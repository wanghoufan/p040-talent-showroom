import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  supported: true,
  truncated: false,
  failSidecar: false,
  /** 命中该路径时 deleteFile 抛错（模拟文件系统拒绝删除）。 */
  failDelete: '',
  /** 大于 0 时二进制 readFile 每次最多返回这么多字节（模拟短读）。 */
  shortRead: 0,
  /** 二进制 readFile 调用次数，用来断言播放没有反复全量读取。 */
  reads: 0,
  /** 每个文件的 mtime；真实 Capacitor stat 必带 mtime，测试显式给值。 */
  mtime: new Map<string, number>(),
  clock: 1000,
  uriBase: 'file:///DATA/',
  files: new Map<string, { bytes: Uint8Array; text?: string }>(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => native.supported, convertFileSrc: (uri: string) => uri },
}));

function decode64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encode64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    mkdir: async () => {},
    writeFile: async ({ path, data, encoding }: { path: string; data: string; encoding?: string }) => {
      if (native.failSidecar && path.endsWith('.json.tmp')) throw Error('disk full');
      const text = encoding === 'utf8' ? String(data) : undefined;
      native.files.set(path, { bytes: text !== undefined ? new TextEncoder().encode(text) : decode64(String(data)), text });
      native.mtime.set(path, ++native.clock);
    },
    appendFile: async ({ path, data }: { path: string; data: string }) => {
      const current = native.files.get(path);
      if (!current) throw Error('missing');
      const extra = decode64(data);
      const bytes = new Uint8Array(current.bytes.length + extra.length);
      bytes.set(current.bytes);
      bytes.set(extra, current.bytes.length);
      native.files.set(path, { ...current, bytes });
      native.mtime.set(path, ++native.clock);
    },
    stat: async ({ path }: { path: string }) => {
      const file = native.files.get(path);
      if (!file) throw Object.assign(Error('missing'), { code: 'OS-PLUG-FILE-0008' });
      return { size: native.truncated ? 1 : file.bytes.length, mtime: native.mtime.get(path) ?? 0 };
    },
    readFile: async ({ path, encoding, offset, length }: { path: string; encoding?: string; offset?: number; length?: number }) => {
      const file = native.files.get(path);
      if (!file) throw Error('missing');
      if (encoding === 'utf8') return { data: file.text ?? '' };
      native.reads += 1;
      const start = offset ?? 0;
      const end = length === undefined ? file.bytes.length : start + length;
      const cap = native.shortRead > 0 ? Math.min(end, start + native.shortRead) : end;
      return { data: encode64(file.bytes.subarray(start, cap)) };
    },
    readdir: async ({ path }: { path: string }) => ({
      files: [...native.files.keys()]
        .filter((name) => name.startsWith(`${path}/`))
        .map((name) => ({ name: name.slice(path.length + 1), size: native.files.get(name)!.bytes.length })),
    }),
    getUri: async ({ path }: { path: string }) => ({ uri: native.uriBase + path }),
    rename: async ({ from, to }: { from: string; to: string }) => {
      const file = native.files.get(from);
      if (!file) throw Error('missing');
      native.files.delete(from);
      native.files.set(to, file);
      native.mtime.set(to, native.mtime.get(from) ?? ++native.clock);
      native.mtime.delete(from);
    },
    deleteFile: async ({ path }: { path: string }) => {
      if (native.failDelete && path === native.failDelete) throw Object.assign(Error('delete refused'), { code: 'OS-PLUG-FILE-9999' });
      native.files.delete(path);
      native.mtime.delete(path);
    },
  },
}));

import { discardStoredVideo, findStoredVideoBySource, findStoredVideo, listStagedVideos, linkStoredVideo, listStoredVideos, readStoredVideo, recoverStoredVideos, stageVideo, uploadStoredVideo, verifiedVideoUri, VideoCopyError } from '../../src/lib/video-store';
import { findPendingImport, listPendingImports } from '../../src/lib/pending-imports';
import { referenceSource } from '../../src/native/filesystem';

function videoFile(bytes = 600000) {
  return new File([new Uint8Array(bytes)], '测试舞蹈.mp4', { type: 'video/mp4' });
}

beforeEach(() => {
  native.supported = true;
  native.files.clear();
  native.mtime.clear();
  native.clock = 1000;
  native.truncated = false;
  native.failSidecar = false;
  native.failDelete = '';
  native.shortRead = 0;
  native.reads = 0;
  native.uriBase = 'file:///DATA/';
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('本地视频副本', () => {
  it('完整写入私有目录、核对字节数与内容摘要后才提交 sidecar 与索引', async () => {
    const file = videoFile();
    const record = await stageVideo(file);

    expect(record.verified).toBe(true);
    expect(record.checksum).toBeTruthy();
    expect(record.path).toMatch(/^dance-videos\/.+\.mp4$/);
    expect(native.files.has(`${record.path}.part`)).toBe(false);
    expect(native.files.get(record.path)?.bytes.length).toBe(file.size);
    const sidecar = `${record.path}.json`;
    expect(native.files.has(sidecar)).toBe(true);
    expect(JSON.parse(native.files.get(sidecar)!.text!)).toMatchObject({ id: record.id, sizeBytes: file.size, verified: true, checksum: record.checksum });
    expect(listStoredVideos().map((item) => item.id)).toContain(record.id);
  });

  it('字节数不一致时明确失败，保留 .part 现场且不提交元数据', async () => {
    native.truncated = true;
    const file = videoFile(1024);
    await expect(stageVideo(file)).rejects.toBeInstanceOf(VideoCopyError);

    const parts = [...native.files.keys()].filter((name) => name.endsWith('.mp4.part'));
    expect(parts).toHaveLength(1);
    expect([...native.files.keys()].some((name) => name.endsWith('.mp4'))).toBe(false);
    expect(native.files.has(`${parts[0].replace(/\.part$/, '')}.json`)).toBe(false);
    expect(listStoredVideos()).toEqual([]);
  });

  it('索引超过 100 项也不截断，最早的副本仍可按 id 找到', async () => {
    const records = [];
    for (let i = 0; i < 105; i += 1) {
      records.push(await stageVideo(new File([new Uint8Array([i + 1])], `片段-${i}.mp4`, { type: 'video/mp4' })));
    }

    expect(listStoredVideos()).toHaveLength(105);
    expect(findStoredVideo(records[0].id)?.path).toBe(records[0].path);
    expect(findStoredVideo(records[104].id)?.path).toBe(records[104].path);
  });

  it('只改内容不改长度时不再提供播放地址（写入后 mtime 变化必须重核）', async () => {
    const record = await stageVideo(videoFile(1000));
    const file = native.files.get(record.path)!;
    file.bytes[0] = file.bytes[0] ^ 0xff;
    native.mtime.set(record.path, ++native.clock); // 真实文件被改写时 mtime 一定变
    expect((await verifiedVideoUri(findStoredVideo(record.id)!))).toBeNull();
  });

  it('索引丢失后从 sidecar 恢复；副本缺失则跳过且不删除现场', async () => {
    const kept = await stageVideo(videoFile(1000));
    const missing = await stageVideo(videoFile(1000));
    localStorage.clear();
    native.files.delete(missing.path);

    await recoverStoredVideos();

    expect(listStoredVideos().map((item) => item.id)).toEqual([kept.id]);
    expect(native.files.has(missing.path)).toBe(false);
    expect(native.files.has(`${missing.path}.json`)).toBe(true); // sidecar 没有被顺手删除
  });

  it('索引丢失且同一路径内容被改成同样长度时，恢复不再把它当成可用副本', async () => {
    const record = await stageVideo(videoFile(1000));
    localStorage.clear();
    const file = native.files.get(record.path)!;
    file.bytes[file.bytes.length - 1] ^= 0xff;

    expect(await recoverStoredVideos()).toBe(0);
    expect(listStoredVideos()).toEqual([]);
    expect(native.files.has(record.path)).toBe(true); // 不删除现场
  });

  it('崩溃在 sidecar 已写、正式文件未改名时，可凭 .part 补完改名', async () => {
    const record = await stageVideo(videoFile(1000));
    native.files.set(`${record.path}.part`, native.files.get(record.path)!);
    native.files.delete(record.path);
    localStorage.clear();

    expect(await recoverStoredVideos()).toBe(1);
    expect(native.files.has(record.path)).toBe(true);
    expect(native.files.has(`${record.path}.part`)).toBe(false);
    expect(listStoredVideos().map((item) => item.id)).toEqual([record.id]);
  });

  it('正式文件已落盘但 sidecar 没写成时，按文件名补登记为「待核实」，不冒充可用', async () => {
    const record = await stageVideo(videoFile(1000));
    native.files.delete(`${record.path}.json`);
    localStorage.clear();

    expect(await recoverStoredVideos()).toBe(1);
    const recovered = listStoredVideos();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ id: record.id, path: record.path, verified: false, sizeBytes: record.sizeBytes });
    // 没有原始预期摘要：不得自算摘要后标成已核实，也不得伪造 sidecar。
    expect(recovered[0].checksum).toBeUndefined();
    expect(native.files.has(`${record.path}.json`)).toBe(false);
    expect(await verifiedVideoUri(recovered[0])).toBeNull();
    await expect(readStoredVideo(recovered[0])).rejects.toBeInstanceOf(VideoCopyError);
    expect(native.files.has(record.path)).toBe(true); // 保留现场
  });

  it('sidecar 比索引新时（索引写失败）恢复会补回 jobId 与 sourceMediaId', async () => {
    const record = await stageVideo(videoFile(1000));
    const sidecar = `${record.path}.json`;
    const meta = JSON.parse(native.files.get(sidecar)!.text!);
    meta.jobId = 'job-side';
    meta.sourceMediaId = 'source-side';
    native.files.set(sidecar, { bytes: new TextEncoder().encode(JSON.stringify(meta)), text: JSON.stringify(meta) });

    await recoverStoredVideos();

    expect(findStoredVideo(record.id)).toMatchObject({ jobId: 'job-side', sourceMediaId: 'source-side' });
    expect(findStoredVideoBySource('source-side')?.id).toBe(record.id);
  });

  it('sidecar 写失败必须抛错，不能假装关联成功', async () => {
    const record = await stageVideo(videoFile(1000));
    native.failSidecar = true;

    await expect(linkStoredVideo(record.id, { sourceMediaId: 'src-fail' })).rejects.toThrow('disk full');
    expect(findStoredVideoBySource('src-fail')).toBeUndefined();
    expect(findStoredVideo(record.id)?.sourceMediaId).toBeUndefined();
    expect(JSON.parse(native.files.get(`${record.path}.json`)!.text!)).not.toHaveProperty('sourceMediaId', 'src-fail');

    native.failSidecar = false;
    await linkStoredVideo(record.id, { sourceMediaId: 'src-ok' });
    expect(findStoredVideoBySource('src-ok')?.id).toBe(record.id);
    expect(JSON.parse(native.files.get(`${record.path}.json`)!.text!)).toMatchObject({ sourceMediaId: 'src-ok' });
  });

  it('副本被改动后不再提供播放地址，避免假就绪', async () => {
    const record = await stageVideo(videoFile(1000));
    native.files.set(record.path, { bytes: new Uint8Array(3) });
    expect(await verifiedVideoUri(record)).toBeNull();
  });

  it('上传使用私有副本，成功后只补 jobId；待办记录带 videoId，副本保留', async () => {
    const file = videoFile(2048);
    const record = await stageVideo(file);
    const seen: { bodySize?: number; name?: string } = {};
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('file:///')) return new Response(new Uint8Array(file.size));
      seen.bodySize = (init?.body as Blob).size;
      seen.name = String((init?.headers as Record<string, string>)['x-file-name']);
      return new Response(JSON.stringify({ id: 'job-9', status: 'PROCESSING', stage: 'ACQUIRE' }), { status: 202, headers: { 'Content-Type': 'application/json' } });
    }));

    const job = await uploadStoredVideo(record);

    expect(job.id).toBe('job-9');
    expect(seen.bodySize).toBe(file.size);
    expect(decodeURIComponent(seen.name!)).toBe('测试舞蹈.mp4');
    expect(findPendingImport('job-9')).toMatchObject({ videoId: record.id, sizeBytes: file.size });
    expect(listPendingImports()).toHaveLength(1);
    expect(listStagedVideos()).toEqual([]); // 已有 jobId，不再出现在“等待上传”
    expect(native.files.has(record.path)).toBe(true); // 上传成功也不删源副本
  });

  it('确认保存后本地副本可直接作为原视频播放，索引丢失也能从 sidecar 恢复', async () => {
    const record = await stageVideo(videoFile(4096));
    await linkStoredVideo(record.id, { sourceMediaId: 'src-1' });

    // 模拟重启后 localStorage 索引被清空：只剩私有目录里的视频和 sidecar。
    localStorage.clear();
    expect(listStoredVideos()).toEqual([]);

    const source = await referenceSource('src-1');
    expect(source.offline).toBe(true);
    expect(source.src).toBe('file:///DATA/' + record.path);
    expect(findStoredVideoBySource('src-1')?.id).toBe(record.id);
  });

  it('网页端不写私有目录，保留内存 File 供直接上传', async () => {
    native.supported = false;
    const file = videoFile(10);
    const record = await stageVideo(file);
    expect(record.path).toBe('');
    expect(record.blob).toBe(file);
    expect(native.files.size).toBe(0);
  });

  it('不完整孤儿（无 sidecar、只剩前几十字节）不得被标为已核实或当成可播放/可上传', async () => {
    const record = await stageVideo(videoFile(2000));
    native.files.delete(`${record.path}.json`);
    // 模拟崩溃后只落下部分内容、且没有 sidecar：没有原始预期大小与摘要可对。
    native.files.set(record.path, { bytes: native.files.get(record.path)!.bytes.subarray(0, 64) });
    localStorage.clear();

    expect(await recoverStoredVideos()).toBe(1);
    const orphan = findStoredVideo(record.id)!;
    expect(orphan).toMatchObject({ verified: false, sizeBytes: 64 });
    expect(orphan.checksum).toBeUndefined();
    expect(orphan.jobId).toBeUndefined();
    expect(await verifiedVideoUri(orphan)).toBeNull();
    await expect(readStoredVideo(orphan)).rejects.toBeInstanceOf(VideoCopyError);
    await expect(uploadStoredVideo(orphan)).rejects.toBeInstanceOf(VideoCopyError);
    expect(listStagedVideos().map((item) => item.id)).toContain(record.id); // 界面可见「待核实」
    expect(native.files.has(record.path)).toBe(true); // 不删除现场

    // 再扫一次也不能凭自算摘要把它洗成已核实。
    await recoverStoredVideos();
    const rescan = findStoredVideo(record.id)!;
    expect(rescan.verified).toBe(false);
    expect(rescan.checksum).toBeUndefined();
    expect(native.files.has(`${record.path}.json`)).toBe(false);
  });

  it('sidecar 缺少摘要时也保持待核实，不自算摘要补成可用', async () => {
    const record = await stageVideo(videoFile(1000));
    const sidecar = `${record.path}.json`;
    const meta = JSON.parse(native.files.get(sidecar)!.text!);
    delete meta.checksum;
    meta.verified = false;
    native.files.set(sidecar, { bytes: new TextEncoder().encode(JSON.stringify(meta)), text: JSON.stringify(meta) });
    native.reads = 0;
    localStorage.clear();

    expect(await recoverStoredVideos()).toBe(1);
    const recovered = findStoredVideo(record.id)!;
    expect(recovered.verified).toBe(false);
    expect(recovered.checksum).toBeUndefined();
    expect(native.reads).toBe(0); // 没有期望摘要就不该读全文件自算
    expect(await verifiedVideoUri(recovered)).toBeNull();
    expect(JSON.parse(native.files.get(sidecar)!.text!).verified).toBe(false); // 不把 sidecar 改写成已核实
    expect(native.files.has(record.path)).toBe(true);
  });

  it('并发恢复共用同一轮扫描，不重复全量读取', async () => {
    await stageVideo(videoFile(1000));
    await stageVideo(videoFile(1000));
    localStorage.clear();
    native.reads = 0;

    await Promise.all([recoverStoredVideos(), recoverStoredVideos()]);

    expect(native.reads).toBe(2); // 两个文件各读一次
    expect(listStoredVideos()).toHaveLength(2);
  });

  it('收录后立即播放不再重读整份文件，同一进程内重复播放也不重读', async () => {
    const record = await stageVideo(videoFile(4096));
    native.reads = 0;

    expect(await verifiedVideoUri(findStoredVideo(record.id)!)).toBe(`file:///DATA/${record.path}`);
    expect(await verifiedVideoUri(findStoredVideo(record.id)!)).toBe(`file:///DATA/${record.path}`);

    expect(native.reads).toBe(0);
  });

  it('重启后（进程内缓存清空）播放仍按落盘指纹跳过全量读取', async () => {
    const record = await stageVideo(videoFile(4096));
    native.reads = 0;
    vi.resetModules();
    const fresh = await import('../../src/lib/video-store');
    const loaded = fresh.findStoredVideo(record.id)!;

    expect(await fresh.verifiedVideoUri(loaded)).toBe(`file:///DATA/${record.path}`);
    expect(native.reads).toBe(0);
  });

  it('平台拿不到 mtime 时退回逐次校验，不拿未核实的文件当可用', async () => {
    const record = await stageVideo(videoFile(1024));
    native.mtime.set(record.path, 0);
    native.reads = 0;
    vi.resetModules();
    const fresh = await import('../../src/lib/video-store');
    const loaded = fresh.findStoredVideo(record.id)!;

    expect(await fresh.verifiedVideoUri(loaded)).toBe(`file:///DATA/${record.path}`);
    expect(await fresh.verifiedVideoUri(loaded)).toBe(`file:///DATA/${record.path}`);
    expect(native.reads).toBe(2); // 没有 mtime 每次都要读全文件
  });

  it('冷启动后按当前容器重新解析绝对路径，不复用索引里的旧 URI', async () => {
    const record = await stageVideo(videoFile(1000));
    native.uriBase = 'file:///DATA-NEW/';
    vi.resetModules();
    const fresh = await import('../../src/lib/video-store');

    expect(await fresh.verifiedVideoUri(fresh.findStoredVideo(record.id)!)).toBe(`file:///DATA-NEW/${record.path}`);
  });

  it('删除文件失败必须报错并保留条目，不能谎报已删除', async () => {
    const record = await stageVideo(videoFile(1000));
    native.failDelete = record.path;

    await expect(discardStoredVideo(record.id)).rejects.toBeInstanceOf(VideoCopyError);
    expect(findStoredVideo(record.id)?.path).toBe(record.path);
    expect(native.files.has(record.path)).toBe(true);
    expect(native.files.has(`${record.path}.json`)).toBe(true);

    native.failDelete = '';
    await discardStoredVideo(record.id);
    expect(findStoredVideo(record.id)).toBeUndefined();
    expect(native.files.has(record.path)).toBe(false);
    expect(native.files.has(`${record.path}.json`)).toBe(false);
  });

  it('索引被清空后仍能凭 sidecar 绑上 sourceMediaId，而不是静默丢失', async () => {
    const record = await stageVideo(videoFile(1000));
    localStorage.clear();

    await linkStoredVideo(record.id, { sourceMediaId: 'src-lost-index' });

    expect(findStoredVideoBySource('src-lost-index')?.id).toBe(record.id);
    expect(JSON.parse(native.files.get(`${record.path}.json`)!.text!)).toMatchObject({ sourceMediaId: 'src-lost-index' });
  });

  it('并发关联 jobId 与 sourceMediaId 不互相覆盖', async () => {
    const record = await stageVideo(videoFile(1000));

    await Promise.all([
      linkStoredVideo(record.id, { jobId: 'job-c' }),
      linkStoredVideo(record.id, { sourceMediaId: 'src-c' }),
    ]);

    expect(findStoredVideo(record.id)).toMatchObject({ jobId: 'job-c', sourceMediaId: 'src-c' });
    expect(JSON.parse(native.files.get(`${record.path}.json`)!.text!)).toMatchObject({ jobId: 'job-c', sourceMediaId: 'src-c' });
  });
});
