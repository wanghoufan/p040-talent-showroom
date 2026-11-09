import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';

/**
 * C1 竞态回归：迁移期间老机后台上传不得删掉正在迁移的 dance-pending/<id>。
 * 这里只测保护闸门与 flushLocalFiles/discardPendingFile 的接线，不碰原生迁移实现。
 */
const native=vi.hoisted(()=>({getUri:vi.fn(),deleteFile:vi.fn()}));
vi.mock('@capacitor/core',()=>({Capacitor:{isNativePlatform:()=>true,convertFileSrc:(uri:string)=>uri}}));
vi.mock('@capacitor/filesystem',()=>({Directory:{Data:'DATA'},Filesystem:native}));

import {initializeLocalDatabase,localFiles,saveLocalFile} from '../../src/lib/local-database';
import {discardPendingFile,flushLocalFiles} from '../../src/lib/offline-files';
import {
  beginMigrationSyncGuard,
  endMigrationSyncGuard,
  isMigrationSyncGuardActive,
  MigrationSyncGuardTimeoutError,
  pendingSyncWorkCount,
  trackSyncWork,
} from '../../src/lib/migration-sync-guard';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}

function pendingFile(id:string){return saveLocalFile({id,blob:new Blob(['data']),kind:'VOCAL:SCORE',itemId:crypto.randomUUID(),state:'pending',mime:'image/png'} as never);}

beforeEach(async()=>{
  endMigrationSyncGuard();
  await flushLocalFiles();
  localStorage.clear();
  vi.stubGlobal('indexedDB',new IDBFactory());
  await initializeLocalDatabase();
  native.getUri.mockReset();
  native.deleteFile.mockReset();
});

afterEach(()=>{endMigrationSyncGuard();});

it('begin 同步置位并等在途上传结束；保护期间的重入不再发起上传，release 后恢复',async()=>{
  const gate=deferred();
  let started!:()=>void;
  const uploadStarted=new Promise<void>(r=>{started=r;});
  const fetchMock=vi.fn(async()=>{
    // 只有第一次上传会挂住，模拟「上传正在进行」；之后的重试立即失败，测试不会卡死。
    if(fetchMock.mock.calls.length===1){started();await gate.promise;}
    throw Error('offline');
  });
  vi.stubGlobal('fetch',fetchMock);
  await pendingFile('race');

  const inFlight=flushLocalFiles();
  await uploadStarted;
  expect(pendingSyncWorkCount()).toBe(1);

  let ready=false;
  const begin=beginMigrationSyncGuard().then((handle)=>{ready=true;return handle;});
  // 关键断言：标志在第一个 await 之前就已置位，定时器抢不到缝。
  expect(isMigrationSyncGuardActive()).toBe(true);
  const callsDuringUpload=fetchMock.mock.calls.length;

  // 模拟 15 秒定时器 / 前台切换 / online 的三次重入：必须复用同一个在途任务，不并发上传。
  const reentry=flushLocalFiles();
  expect(reentry).toBe(inFlight);
  void flushLocalFiles();
  await Promise.resolve();
  expect(fetchMock.mock.calls.length).toBe(callsDuringUpload);

  // 上传还没结束，保护不得提前完成。
  await Promise.resolve();
  await Promise.resolve();
  expect(ready).toBe(false);
  expect(await localFiles()).toMatchObject([{id:'race',state:'pending'}]);

  gate.resolve();
  await inFlight;
  const guard=await begin;
  expect(ready).toBe(true);

  // 上传已完成（含失败后的重试），保护期间没有新增上传。
  const callsAfterUpload=fetchMock.mock.calls.length;
  await flushLocalFiles();
  expect(fetchMock.mock.calls.length).toBe(callsAfterUpload);

  guard.release();
  expect(isMigrationSyncGuardActive()).toBe(false);
  await flushLocalFiles();
  expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterUpload);
});

it('保护期间 flushLocalFiles 与移除待办都不动文件；release 后两者恢复',async()=>{
  const fetchMock=vi.fn(async()=>{throw Error('offline');});
  vi.stubGlobal('fetch',fetchMock);
  await pendingFile('guarded');

  const guard=await beginMigrationSyncGuard();
  for(let i=0;i<3;i++)await flushLocalFiles();
  expect(fetchMock).not.toHaveBeenCalled();
  await expect(discardPendingFile('guarded')).rejects.toThrow('请先停止分享');
  expect(await localFiles()).toMatchObject([{id:'guarded',state:'pending'}]);

  guard.release();
  await flushLocalFiles();
  expect(fetchMock).toHaveBeenCalled();
  await discardPendingFile('guarded');
  expect(await localFiles()).toEqual([]);
});

it('在途上传超时：抛明确错误并自动释放，下一次仍可重新开始保护',async()=>{
  const gate=deferred();
  let started!:()=>void;
  const uploadStarted=new Promise<void>(r=>{started=r;});
  vi.stubGlobal('fetch',vi.fn(async()=>{started();await gate.promise;throw Error('offline');}));
  await pendingFile('slow');

  const inFlight=flushLocalFiles();
  await uploadStarted;

  const failure=await beginMigrationSyncGuard({timeoutMs:20}).catch((error:unknown)=>error);
  expect(failure).toBeInstanceOf(MigrationSyncGuardTimeoutError);
  expect(failure).toMatchObject({code:'MIGRATION_SYNC_GUARD_TIMEOUT',pendingUploads:1,timeoutMs:20});
  // 失败必须释放，不能把后台上传永久锁死。
  expect(isMigrationSyncGuardActive()).toBe(false);

  gate.resolve();
  await inFlight;
  const guard=await beginMigrationSyncGuard({timeoutMs:20});
  expect(isMigrationSyncGuardActive()).toBe(true);
  guard.release();
});

it('保护在队列中途置位：当前文件传完后立即收手，不再取下一个待上传文件',async()=>{
  const gate=deferred();
  let started!:()=>void;
  const uploadStarted=new Promise<void>(r=>{started=r;});
  let first=true;
  const fetchMock=vi.fn(async()=>{
    if(first){first=false;started();await gate.promise;}
    return new Response(JSON.stringify({ok:true}),{status:200,headers:{'Content-Type':'application/json'}});
  });
  vi.stubGlobal('fetch',fetchMock);
  // 按 id 升序处理：a 先传，b 排在后面。
  await saveLocalFile({id:'a-mid-flight',blob:new Blob(['a']),kind:'DANCE:SCORE',itemId:crypto.randomUUID(),state:'pending',mime:'image/png'} as never);
  await saveLocalFile({id:'b-queued',blob:new Blob(['b']),kind:'DANCE:SCORE',itemId:crypto.randomUUID(),state:'pending',mime:'image/png'} as never);

  const inFlight=flushLocalFiles();
  await uploadStarted;
  const begin=beginMigrationSyncGuard();
  expect(isMigrationSyncGuardActive()).toBe(true);

  gate.resolve();
  const guard=await begin;
  await inFlight;
  // a 已成功收尾，但 b 在保护期内一次都没上传。
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await localFiles()).toMatchObject([{id:'b-queued',state:'pending'}]);

  guard.release();
  await flushLocalFiles();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(await localFiles()).toEqual([]);
});

it('引用计数：一次 release 不解锁，重复 release 不会减成负数，end 强制释放全部',async()=>{
  const first=await beginMigrationSyncGuard();
  const second=await beginMigrationSyncGuard();
  expect(isMigrationSyncGuardActive()).toBe(true);

  first.release();
  expect(first.active).toBe(false);
  expect(isMigrationSyncGuardActive()).toBe(true);
  first.release();
  expect(isMigrationSyncGuardActive()).toBe(true);

  second.release();
  expect(second.active).toBe(false);
  expect(isMigrationSyncGuardActive()).toBe(false);
  expect(endMigrationSyncGuard()).toBe(0);

  const third=await beginMigrationSyncGuard();
  const fourth=await beginMigrationSyncGuard();
  expect(endMigrationSyncGuard()).toBe(2);
  expect(third.active).toBe(false);
  expect(fourth.active).toBe(false);
  expect(isMigrationSyncGuardActive()).toBe(false);
});

it('trackSyncWork 只观测生命周期：失败照旧抛给调用方，结束后从在途集合移除',async()=>{
  let fail!: (error: Error)=>void;
  const work=new Promise<void>((_,reject)=>{fail=reject;});
  const tracked=trackSyncWork(work);
  expect(pendingSyncWorkCount()).toBe(1);
  fail(Error('upload failed'));
  await expect(tracked).rejects.toThrow('upload failed');
  await Promise.resolve();
  await Promise.resolve();
  expect(pendingSyncWorkCount()).toBe(0);
});

it('上传本来就失败（离线）时保护仍能正常建立与释放，不把队列卡死',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('offline');}));
  await pendingFile('offline');
  await flushLocalFiles();
  expect(pendingSyncWorkCount()).toBe(0);

  const guard=await beginMigrationSyncGuard();
  expect(guard.active).toBe(true);
  guard.release();

  await flushLocalFiles();
  expect(await localFiles()).toMatchObject([{id:'offline',state:'pending'}]);
});
