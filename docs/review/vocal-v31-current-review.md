# P040 V3.1 当前实现只读审查（数据安全与状态机）

- 审查对象：`server/vocal-import/`（queue / importer / routes / scan / store / accompaniment-verify）、`server/index.mjs` 的挂载与鉴权、`src/components/VocalImport*` 的导入 UI。
- 代码基线：`HEAD a03dcdf` + 未提交的 V3.1 工作树。
- 审查时点：2026-10-30 10:31（CST）。工作树在审查期间被并行修改过，以下结论绑定本次快照的 SHA-256 前 12 位：

| 文件 | sha256 前 12 位 |
|---|---|
| `server/vocal-import/queue.mjs` | `24a5cbd3a5f5` |
| `server/vocal-import/importer.mjs` | `3b20999618f8` |
| `server/vocal-import/routes.mjs` | `ba5fd4d9ffc5` |
| `server/vocal-import/scan.mjs` | `56aff3c92780` |
| `server/vocal-import/store.mjs` | `eb22c187e922` |
| `server/vocal-import/accompaniment-verify.mjs` | `f53264f97be3` |
| `server/index.mjs` | `5ac757e11d91` |
| `src/components/VocalImportManager.tsx` | `10732758bfe1` |
| `src/components/VocalImportStatus.tsx` | `bc1cd9c6f3fc` |
| `src/components/VocalImportPanel.tsx` | `926da85d1f47` |
| `tests/vocal-import-lease-race-v31.test.mjs` | `be72fc8a40c4` |

> 若上述文件 hash 已变化，请以新快照重新核验；本文不假设后续修复。

## 结论摘要

- 未发现 P0（未发现源文件被写/删、生产库被误写、凭据泄露）。
- **P1（当前快照必现，触发需要并发/双 worker 或并发 HTTP+worker）**：状态写入没有绑定租约/状态守卫，迟到的旧 worker 或并发的原唱兜底会把已完成状态覆盖回 `PENDING_EXTRACT`，或把 `DUAL_TRACK` 改成 `ORIGINAL_ONLY`。仓库内新增的专项回归测试 `tests/vocal-import-lease-race-v31.test.mjs` 在当前快照下 **2/2 失败**。
- **P2（需特定历史数据或操作序列）**：①同一伴奏内容的幂等收尾没有校验“原唱轨是否存在”，可把只有旧伴奏的曲目直接标成 `IMPORTED/DUAL_TRACK`；②`READY_TO_IMPORT` 任务在重扫后自带伴奏消失/变歧义时会被保留为不可领取状态。
- 已核对通过：替换必须显式确认（V3.1 与手动补录两条路径）、源文件只读、HTTP 配对鉴权、路径越界防护、原唱兜底重试保持同一 `songId`。
- 未验证：真实 audio-separator/MLX 提取、真实 ffprobe/ffmpeg 解码、真实浏览器/真机、全量测试、生产库与真实音乐目录。

## 审查方法

1. 静态阅读上述快照源码与 UI。
2. 只跑 V3.1 定向测试（非全量）：`tests/vocal-import-{v31,conflict-v31,integration-v31,routes-v31,original-only-retry-v31,v31-fixes,batch-recovery-v31}.test.mjs`。结果 64/64 通过。
3. 只跑新增专项：`tests/vocal-import-lease-race-v31.test.mjs`。结果 **0/2 通过，2 个失败**（见 P1）。
4. 在系统临时目录用独立 SQLite + 假音频/假探测器做最小复现；不触生产库、不读写真实音乐、不连真机、不启动真实分离进程。

---

## P1｜迟到写入覆盖新状态（租约/状态无守卫）

### 证据 A：仓库内专项测试当前失败

命令：

```bash
node --test tests/vocal-import-lease-race-v31.test.mjs
```

当前快照实测（节选）：

```text
✖ 旧提取 worker 租约过期：新 worker 已入库后旧 worker 不得覆盖为 PENDING_EXTRACT/CONFLICT
  actual:   { status: 'PENDING_EXTRACT', errorCode: 'CONFLICT', importMode: 'DUAL_TRACK', ... }
  expected: { status: 'IMPORTED',       errorCode: null,       importMode: 'DUAL_TRACK', ... }

✖ 原唱兜底与提取并发：新 worker 已双轨入库时旧兜底不得覆盖 import_mode
  actual:   { status: 'IMPORTED', importMode: 'ORIGINAL_ONLY', accompaniment: '.../worker-extract.flac' }
  expected: { status: 'IMPORTED', importMode: 'DUAL_TRACK',    accompaniment: '.../worker-extract.flac' }
```

两个用例的前置条件都已满足（新 worker 已先完成 `IMPORTED/DUAL_TRACK`），失败点是旧调用返回后覆盖了状态。

### 证据 B：单队列（同一 SQLite 连接）也能复现“兜底覆盖提取”

用同一个 queue 实例，让 `importOriginalOnly()` 在入库器里等待、让 `runOnce()` 的 worker 在此期间领取任务，实测：

```text
before worker claim: status=PENDING_EXTRACT import_mode=NONE
after worker claim:  status=EXTRACTING       lease_owner=W
after original-only: status=IMPORTED         import_mode=ORIGINAL_ONLY
worker result:       processed=false reason=CONFLICT
FINAL:               status=PENDING_EXTRACT  stage=EXTRACT import_mode=ORIGINAL_ONLY attempts=1 last_error_code=CONFLICT
```

即：用户点“只入库原唱”后，worker 的提取结果被丢弃，任务又被改回 `PENDING_EXTRACT`，之后 worker 还会再提取一次。

### 根因（代码位）

- `server/vocal-import/store.mjs:172` `updateJob()` 生成无条件 `UPDATE ... WHERE id=?`，没有 `AND status=?` / `AND lease_owner=?` 守卫；任何持有旧行的调用方都能覆盖任意新状态。
- `server/vocal-import/queue.mjs:714` `fail()` 不做状态/租约校验，直接写 `attempts/status/lease`；`runOnce` 的 catch 在 `server/vocal-import/queue.mjs:1219` 调用它。
- `server/vocal-import/queue.mjs:614` `completeExtraction()` 虽有 `status==='EXTRACTING'` 检查，但检查失败后抛出的错误会被 catch 转成 `fail()`，从而把新 worker 的 `IMPORTED` 覆盖回 `PENDING_EXTRACT/FAILED`。
- `server/vocal-import/queue.mjs:819` `importOriginalOnly()` 与 `server/vocal-import/queue.mjs:856` `resolveImportConflict()` 都是“先读状态 → await 入库器 → 再写状态”，中间没有领取/租约；worker 可在 await 窗口内领取任务，随后被旧调用覆盖。
- 默认租约 `leaseMs=120000`（`queue.mjs:83`），而真实提取超时默认 30 分钟（`config.mjs` / `separator.mjs`），单次提取可能远超租约；一旦同一 DB 被两个 worker 进程/连接看到，过期租约会被接管，旧 worker 仍会回来写。

### 影响与边界

- 影响：任务状态与实际曲库不一致；已入库任务被改回 `PENDING_EXTRACT` 后会再次提取/再次尝试入库；用户明确选择的 `ORIGINAL_ONLY` 可能被改成双轨，或双轨被写成 `ORIGINAL_ONLY`。当前复现中曲库行数未重复（`items=1, clips=2`），未观察到源文件或旧音轨被删除；因此是状态/重复处理风险，不是不可逆数据丢失。
- 触发边界：单进程单 worker 串行正常路径未复现（`startWorker` 的 `running` 守卫会阻止同进程重入）。但“HTTP 原唱兜底/冲突处理与 worker 并发”在单进程内可以触发；两个 worker/两个进程共享同一试用 DB 时，租约过期路径可触发。

### 建议改法（未实施）

把状态变更改成条件更新：`UPDATE ... WHERE id=? AND status=? AND (lease_owner=? OR lease_owner IS NULL)`；`fail()`、`markImportConflict()`、`markCancelled()`、`importOriginalOnly()`、`resolveImportConflict()` 的最终写回都要带“仍由本次调用持有”的条件；过期 worker 的写回应变成 no-op/事件记录，而不是覆盖。租约应覆盖单次提取的最长时限，或在提取期间续租。

---

## P2-1｜幂等收尾未校验原唱轨，可能把“只有旧伴奏”标成双轨已入库

### 证据

- `queue.mjs:253` `alreadyImportedSameArtifact()` 只比较 `existing.accompanimentClipId` 的 `sha256` 与本次工件 `sha256`。
- `queue.mjs:1062` 命中后调用 `queue.mjs:354` `markImportedIdempotent()`，后者固定写 `status='IMPORTED'`、`importMode='DUAL_TRACK'`，不检查曲目是否已有 `original_clip_id`，也不检查旧单轨的 `audio_role` 是否真的代表原唱。

最小复现（独立临时 SQLite，注入只替换探测实现的测试校验器）：

1. 造一条历史 VOCAL 曲目：`source_media.sha256` = 本次扫描的原唱 SHA，`performance_clip_id` = 旧伴奏，`audio_role='ACCOMPANIMENT'`，`original_clip_id=NULL`、`accompaniment_clip_id=NULL`。
2. 扫描“原唱 + 与旧伴奏内容相同的自带伴奏”。
3. `runOnce()`。

实测：

```text
job  = { status: 'IMPORTED', import_mode: 'DUAL_TRACK' }
item = { original_clip_id: null, accompaniment_clip_id: null, performance_clip_id: '<旧伴奏 clip>' }
```

### 影响与边界

- 任务/界面显示“已入库（双轨）”，但曲目没有绑定原唱轨，只有旧伴奏；用户去曲库看不到原唱。
- 需要“已有同一份伴奏内容 + 历史单轨缺原唱”这一特定数据形态；不是所有导入都会触发。
- 建议：`alreadyImportedSameArtifact()` 至少要求 `existing.original_clip_id` 非空且 `existing.accompaniment_clip_id` 指向当前伴奏；否则走正常 `performImport()` 补原唱。

---

## P2-2｜重扫后 `READY_TO_IMPORT` 可能变成不可领取状态

### 证据

- `queue.mjs:433` 把 `READY_TO_IMPORT` 放进 `keepStage`，重扫时保留旧状态/阶段；`queue.mjs:448-477` 仍会把 `suppliedAccompanimentRelPath` 更新为本次扫描结果（无人工标记时可为 `null`）。
- `queue.mjs:562-565` 领取 `READY_TO_IMPORT` 的条件只有：`stage='VERIFY' AND supplied_accompaniment_rel_path IS NOT NULL`，或 `stage='IMPORT'`。
- 因此：一个自带伴奏、处于 `READY_TO_IMPORT/VERIFY` 的任务，在伴奏文件被删除/改名或变成歧义后重扫，会保留 `READY_TO_IMPORT/VERIFY`，但 `supplied_accompaniment_rel_path` 变成 `null`，永远不满足领取条件。

实测：

```text
after scan1: status=READY_TO_IMPORT stage=VERIFY supplied='A - B 伴奏.mp3'
删除伴奏并重扫后: status=READY_TO_IMPORT stage=VERIFY supplied=null
claimNext() -> null
```

### 影响与边界

- 任务停在“已提取 · 待入库”，worker 不会处理；`VocalImportManager` 对 `READY_TO_IMPORT` 只给“取消”按钮，没有“重试/重新核对”入口。
- 用户可先点“取消”再点“重试”恢复（`retry()` 会因无 `supplied` 退回 `PENDING_EXTRACT`），但界面没有提示这是恢复路径。
- 不涉及数据写入或覆盖；是可达性/状态机卡死问题。
- 建议：重扫计算 `nextStatus/nextStage` 时不要把“已无伴奏的 `READY_TO_IMPORT`”继续保留为 `READY_TO_IMPORT/VERIFY`；至少回退为 `NEEDS_REVIEW/MATCH` 或 `PENDING_EXTRACT/EXTRACT`，并在 UI 提供对应入口。

---

## 已核对通过（有证据）

1. **替换需要显式确认**（V3.1）  
   - 后端：`routes.mjs:124-131` 只接受 `keep-existing|use-new`；`queue.resolveImportConflict()` 默认不会替换已有伴奏。  
   - UI：`VocalImportManager.tsx:598-605` 先弹出确认，`639-651` 只有“确认改用新伴奏”才调用 `use-new`。  
   - 测试：`tests/vocal-import-routes-v31.test.mjs` 的“已有伴奏冲突必须显式选择”“明确选择 use-new 才提取并替换”通过。

2. **手动补录替换也需确认，且服务端拒绝静默顶替**  
   - `VocalImportPanel.tsx:43-51` 同角色已有音轨时先 `setConfirmRole`，`confirmReplace` 才带 `replace:true`。  
   - `server/repertoire/service.mjs:202-224` 对 `DUPLICATE_TRACK`/`TRACK_EXISTS` 做拒绝，内容相同也拒绝。

3. **源文件只读**  
   - 扫描只 `createReadStream`/`stat`/`readdir`（`scan.mjs`）；分离器前后校验源大小/mtime（`separator.mjs:203-211`）；原唱与自带伴奏都先复制到 `mediaRoot/vocal-import/<songId>/`（`importer.mjs:84-110`、`queue.mjs:147-196`）；队列在提取前后校验源 SHA（`queue.mjs:1124` 附近）。  
   - 测试：“本机分离器：真实子进程契约、输出在受控目录、并发强制为一、源只读”“扫描后源音频被改动则拒绝提取”“提取期间源音频被替换”通过；复现脚本结束时源目录字节未变。

4. **HTTP 认证**  
   - `server/index.mjs:60` 全局 owner 鉴权；`:64-69` 对 `/api/vocal-import/*` 即使 `owner_credentials` 为空也强制 401；`integration.mjs` 的 `authorize` 与 `routes.mjs:56-67` 再校验一次。  
   - 测试：“V3.1 路由继承现有配对鉴权”“设备未配对时 V3.1 接口也必须 401”通过。

5. **路径安全**  
   - `source-policy.mjs`：请求只接受 `rootId + 相对 subPath`，拒绝绝对路径、盘符、UNC、NUL、`..`、根目录以下符号链接；`resolveFile()` 再做 realpath 归属校验。  
   - `routes.mjs:79/126/134` 拒绝绝对路径字段；错误信息不回显本机绝对路径。  
   - 测试：“路径安全：拒绝绝对路径、..、符号链接与白名单外 rootId”“路由：不接受绝对路径、只回显 rootId”通过。

6. **原唱兜底重试保持同一首歌**  
   - `queue.retry()` 对 `IMPORTED/ORIGINAL_ONLY` 允许回到 `PENDING_EXTRACT`，任务不换 `songId`；`importer.performImport()` 以 `songId`/源 SHA 并入同一曲目。  
   - 测试：`tests/vocal-import-original-only-retry-v31.test.mjs` 6/6 通过（同一 `songId`、原唱轨不变、歌词保留、只新增伴奏轨）。

7. **伴奏工件新增的严格校验已生效**  
   - `accompaniment-verify.mjs` 拒绝非音频扩展名、与原唱 SHA 相同、不可完整解码、时长超容差；`queue.completeExtraction/verifyArtifacts` 与 `importer.performImport` 都走同一校验。  
   - 实测：把原唱自身或 `.lrc` 指定为自带伴奏，运行后被拒绝（`ACCOMPANIMENT_DUPLICATES_ORIGINAL` / `ACCOMPANIMENT_NOT_AUDIO`），`performance_clips` 未新增。

---

## 明确未验证项

1. **真实分离器/模型未实测**：`index.mjs` 自述、`docs/vocal-v31-operations.md` 均说明 audio-separator/MLX 未在用户 M4 上安装与验收；本次未运行真实分离。
2. **真实解码未实测**：本次复现使用测试校验器替换 `probe`；没有在真实音乐上跑 ffprobe/ffmpeg 全解码与时长容差。`ACCOMPANIMENT_VERIFIER_UNAVAILABLE` 在缺少 ffmpeg 时的实际 UI 表现未验证。
3. **真实浏览器/真机未验证**：UI 结论来自源码阅读；未点开页面、未连 Mac mini、未在手机端执行。
4. **未跑全量测试**：只跑了 V3.1 定向测试；其它模块回归不在本次范围。
5. **多进程/多 worker 部署未定义**：操作说明推荐单前台实例；P1 的租约过期路径用两个连接模拟，未在真实双进程部署下验证。
6. **`MEDIA_ROOT` 与源目录重叠**：操作说明明确警告“不要把音乐目录设为 MEDIA_ROOT”，但代码未强制隔离；若误配，扫描可能把 `vocal-import/` 副本当新音频。未实测。
7. **标题/歌手人工修改的 HTTP 入口**：`queue.resolve()` 支持 `title/artist`，但 `routes.mjs:134` 的允许字段只有两个路径，HTTP 无法改标题/歌手；是否为预期产品行为未确认（不影响安全）。
8. **旧单轨 `performance_clip_id` 残留**：`use-new` 后旧单轨行仍留在 `performance_clip_id`（读取时因显式轨非空而被忽略，文件也不删除）。是否符合“只解绑”的预期未确认；未观察到功能影响。

---

## 复现附录（独立临时目录，不触真实数据）

### A. 直接运行仓库内失败用例

```bash
cd /Users/zzymima0000/Developer/coding/1.Active/040-ing-才艺展示厅
node --test tests/vocal-import-lease-race-v31.test.mjs
# 当前快照：2 failed / 0 passed
```

### B. P2-1 与 P2-2 的最小复现（Node 24，使用仓库模块与测试校验器）

```js
// 保存到任意临时 .mjs 后运行；只使用临时 SQLite 与临时目录。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const REPO = '/Users/zzymima0000/Developer/coding/1.Active/040-ing-才艺展示厅';
const { openDatabase } = await import(`${REPO}/server/db/database.mjs`);
const { createSourcePolicy } = await import(`${REPO}/server/vocal-import/source-policy.mjs`);
const { openVocalImportQueue } = await import(`${REPO}/server/vocal-import/queue.mjs`);
const { createRepertoireImporter } = await import(`${REPO}/server/vocal-import/importer.mjs`);
const { songIdForAudioSha } = await import(`${REPO}/server/vocal-import/uuid5.mjs`);
const { createTestAccompanimentVerifier } = await import(`${REPO}/tests/helpers/test-accompaniment-verifier.mjs`);
const NO_PROBE = { probe: false, fingerprint: false, deep: false };
const sha = b => createHash('sha256').update(b).digest('hex');
function rig() {
  const d = mkdtempSync(join(tmpdir(), 'v31-review-'));
  const music = join(d, 'music'); const mediaRoot = join(d, 'media');
  mkdirSync(music, { recursive: true }); mkdirSync(mediaRoot, { recursive: true });
  const db = openDatabase(join(d, 'db.sqlite'));
  const policy = createSourcePolicy({ roots: [{ id: 'music', path: music }] });
  const verifier = createTestAccompanimentVerifier();
  const importer = createRepertoireImporter({ db, mediaRoot, policy, verifyAccompaniment: verifier });
  const open = (o = {}) => openVocalImportQueue({ db, policy, mediaRoot, importer, verifyAccompaniment: verifier, ...o });
  return { d, music, mediaRoot, db, open };
}

// P2-1：历史“只有旧伴奏、无原唱”的曲目 + 自带同一伴奏 → 被标双轨
{
  const { d, music, mediaRoot, db, open } = rig();
  const ORIG = Buffer.from('ORIGINAL-AUDIO'); const ACC = Buffer.from('LEGACY-ACC');
  writeFileSync(join(music, 'A - B.mp3'), ORIG);
  writeFileSync(join(music, 'A - B 伴奏.mp3'), ACC);
  const songId = songIdForAudioSha(sha(ORIG));
  const srcId = randomUUID();
  db.prepare('INSERT INTO source_media(id,source_kind,source_locator,internal_path,sha256,duration_ms,audio_codec) VALUES(?,?,?,?,?,?,?)')
    .run(srcId, 'AUDIO', 'legacy', 'legacy/acc.mp3', sha(ORIG), 120000, 'mp3');
  const acc = join(mediaRoot, 'legacy', 'acc.mp3'); mkdirSync(join(mediaRoot, 'legacy'), { recursive: true }); writeFileSync(acc, ACC);
  const clipId = randomUUID();
  db.prepare('INSERT INTO performance_clips(id,source_media_id,start_ms,end_ms,internal_audio_path,codec,source_preserving,sha256,size_bytes,duration_ms,version) VALUES(?,?,?,?,?,?,?,?,?,?,1)')
    .run(clipId, srcId, 0, 120000, 'legacy/acc.mp3', 'mp3', 0, sha(ACC), statSync(acc).size, 120000);
  db.prepare("INSERT INTO repertoire_items(id,kind,title,artist,learning_status,audio_role,source_media_id,performance_clip_id,original_clip_id,accompaniment_clip_id) VALUES(?,'VOCAL','A - B','','WANT_TO_LEARN','ACCOMPANIMENT',?,?,NULL,NULL)")
    .run(songId, srcId, clipId);
  const { queue } = open({ extractor: null });
  const s = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
  const jobId = s.created[0];
  db.prepare('UPDATE vocal_import_jobs SET source_duration_ms=120000 WHERE id=?').run(jobId);
  await queue.runOnce({ owner: 'repro' });
  console.log('P2-1', db.prepare('SELECT status,import_mode FROM vocal_import_jobs WHERE id=?').get(jobId));
  console.log('P2-1 item', db.prepare('SELECT original_clip_id,accompaniment_clip_id,performance_clip_id FROM repertoire_items WHERE id=?').get(songId));
  db.close(); rmSync(d, { recursive: true, force: true });
}

// P2-2：READY_TO_IMPORT 的自带伴奏在重扫时消失 → 不可领取
{
  const { d, music, db, open } = rig();
  writeFileSync(join(music, 'A - B.mp3'), 'ORIGINAL-AUDIO');
  writeFileSync(join(music, 'A - B 伴奏.mp3'), 'ACC-ONE');
  const { queue } = open({ extractor: null });
  const s1 = await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
  console.log('P2-2 scan1', s1.jobs[0].status, s1.jobs[0].stage, s1.jobs[0].suppliedAccompaniment);
  unlinkSync(join(music, 'A - B 伴奏.mp3'));
  writeFileSync(join(music, 'A - B.lrc'), '[00:01.00]hi');
  await queue.enqueueScan({ rootId: 'music', scanOptions: NO_PROBE });
  console.log('P2-2 row', db.prepare('SELECT status,stage,supplied_accompaniment_rel_path FROM vocal_import_jobs').all());
  console.log('P2-2 claim', queue.claimNext({ owner: 'repro' }));
  db.close(); rmSync(d, { recursive: true, force: true });
}
```

实测输出与上文 P2-1/P2-2 一致：P2-1 为 `IMPORTED/DUAL_TRACK` 且 `original_clip_id=null`；P2-2 为 `READY_TO_IMPORT/VERIFY`、`supplied=null`、`claimNext=null`。

---

## 附：本次通过的关键定向测试

```bash
node --test \
  tests/vocal-import-v31.test.mjs \
  tests/vocal-import-conflict-v31.test.mjs \
  tests/vocal-import-integration-v31.test.mjs \
  tests/vocal-import-routes-v31.test.mjs \
  tests/vocal-import-original-only-retry-v31.test.mjs \
  tests/vocal-import-v31-fixes.test.mjs \
  tests/vocal-import-batch-recovery-v31.test.mjs
# 当前快照：64 passed / 0 failed
```
