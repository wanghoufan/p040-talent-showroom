# IMPORT 参数错位测试补齐（batch20）

- 日期：2026-10-30
- 靶点：`server/vocal-import/importer.mjs` 新建曲目的 `INSERT INTO repertoire_items(...)`
- 约束遵守：只新增 `tests/` 下文件与本文档；未改 `server/`、未 commit/push、未启动/重启任何服务、未写 `var/`、未连真实库、未跑真实分离器。

## 1. 结论

1. 新增 `tests/vocal-import-created-row-v31.test.mjs`（3 条用例），锁定新建分支的返回值与列落位；对故意少一个占位符的 importer 副本，3/3 全部失败（`ERR_SQLITE_ERROR: 15 values for 16 columns`）。
2. `source_media`、`performance_clips` 两处 INSERT 的列数 / 占位符数 / 参数个数**均为一致**，无需改动。
3. 原 `tests/vocal-import-original-only-retry-v31.test.mjs` 未改动，仍 6/6 绿。

## 2. 盲区成因（含实测修正）

原始判断是「现有测试根本没走到新建曲目这条 INSERT 分支」。用隔离副本实测后需要修正这个判断：

做法（不动仓库）：把 `importer.mjs` 复制到 `/tmp/b20-broken-sql/importer.broken.mjs`，只把占位符改回少一个的形态
`VALUES(?,'VOCAL',?,?,'WANT_TO_LEARN',?,?,?,'{}',?,?,?,?,0,0)`，相对导入改写成绝对路径；再把既有测试同样改写后指向该副本运行。

结果：`tests/vocal-import-original-only-retry-v31.test.mjs` **6/6 失败**，全部报 `15 values for 16 columns`：

```
not ok 1 - 仅原唱兜底后：重试只补跑提取，并入同一 songId 并完成双轨
  error: '15 values for 16 columns'
  code: 'ERR_SQLITE_ERROR'
...
# tests 6
# pass 0
# fail 6
```

同理 `tests/vocal-import-conflict-v31.test.mjs` 在该副本上 2/4 失败（另 2 条本就不走新建分支）。

因此：

- 该 INSERT 分支在既有用例里**是被走到的**，「修复前 34/34 全绿」那一轮运行读到的应是已经修好的 `importer.mjs`（该文件当前未被 git 跟踪，无法回溯当时版本，故此处只陈述可复现的事实）。
- 真正残留的缺口是**断言强度**，而不是路径覆盖：
  - 没有任何用例断言过 `CREATED_ORIGINAL_ONLY`（原有用例只看 job 的 `status/importMode`，不看入库器返回值）；
  - 没有任何用例断言过 `MERGED_ORIGINAL_ONLY`（同曲二次入库走 UPDATE 分支，`grep MERGED_ORIGINAL_ONLY tests/` 此前为空）；
  - 没有任何用例把「列 → 值」映射逐列钉住（title/artist/audio_role/language/source_media_id/original_clip_id/accompaniment_clip_id/两个 offset），也没断言 `practice_json === '{}'`。占位符少一个会先炸在 SQL 上，但**占位符数量对、顺序错**这种错位只能靠逐列断言拦住。

新用例补的正是这三项，并且不依赖队列调度、不依赖分离器、不依赖网络/GPU/ffmpeg。

## 3. 新测试的思路与断言

文件：`tests/vocal-import-created-row-v31.test.mjs`
搭法与既有 `*-v31.test.mjs` 一致：临时目录 + `openDatabase`（真实 sqlite 迁移）+ `createSourcePolicy` + `createRepertoireImporter` + `createTestAccompanimentVerifier`（只替换探测实现，校验规则仍是生产同一份）+ 真实文件写入。

公共断言 `assertCreatedRowShape()`：逐列核对落位（title / artist / learning_status / audio_role / vocal_language / 两个 offset / `source_media_id` / `original_clip_id` / `accompaniment_clip_id` / `performance_clip_id`），并断言 `practice_json === '{}'`、`lyrics_json` 与 `sections_json` 可 `JSON.parse` 且为数组。

1. `新建曲目：原唱兜底入库走 INSERT 分支，返回 CREATED_ORIGINAL_ONLY 且各列落位`
   - 走真实队列路径：`enqueueScan` → 补 `source_duration_ms` → `queue.importOriginalOnly(jobId)`。
   - 断言 job 为 `IMPORTED / ORIGINAL_ONLY`；`imported` 事件 detail 里入库器返回值为 `CREATED_ORIGINAL_ONLY`。
   - 断言 `repertoire_items` 中 VOCAL 行数 = 1；逐列落位；`lyrics_json` 文本为 `['第一句','第二句']`；`sections_json` 非空且字段合法；`practice_json === '{}'`；`getRepertoire` 只有原唱轨、无伴奏轨。
2. `新建曲目：双轨入库同一条 INSERT，返回 CREATED 且伴奏指针落位`
   - 直接调 `importer({ job, artifact })`，断言 `CREATED`、伴奏指针与 `performance_clip_id` 同时落位、`audio_role='ACCOMPANIMENT'`、`performance_clips` 恰好 2 条。
3. `同曲二次入库：并入既有曲目返回 MERGED_ORIGINAL_ONLY，不新增行`
   - 第一次不带 LRC → `CREATED_ORIGINAL_ONLY`（`lyrics_json = []`）；第二次同 songId 补 LRC → `MERGED_ORIGINAL_ONLY`、`lyricsFilled === true`。
   - 断言 VOCAL 行数仍为 1、`original_clip_id`/`source_media_id` 未被替换、`performance_clips` 仍为 1（UPDATE 分支不新增音轨）、`practice_json === '{}'`、歌词已补齐。

## 4. 定向验证输出

`node --test tests/vocal-import-created-row-v31.test.mjs`：

```
ok 1 - 新建曲目：原唱兜底入库走 INSERT 分支，返回 CREATED_ORIGINAL_ONLY 且各列落位
ok 2 - 新建曲目：双轨入库同一条 INSERT，返回 CREATED 且伴奏指针落位
ok 3 - 同曲二次入库：并入既有曲目返回 MERGED_ORIGINAL_ONLY，不新增行
# tests 3
# suites 0
# pass 3
# fail 0
# duration_ms 133.638917
```

`node --test tests/vocal-import-original-only-retry-v31.test.mjs`（确认未被改坏）：

```
ok 1 - 仅原唱兜底后：重试只补跑提取，并入同一 songId 并完成双轨
ok 2 - 补伴奏不覆盖用户歌词、结构与旧轨
ok 3 - 补伴奏遇到用户旧伴奏：先冲突不分离，保留旧伴奏后可收尾为双轨
ok 4 - 仅原唱兜底后取消仍生效，不得擅自提取
ok 5 - 补伴奏失败仍保留仅原唱状态，可再次重试直到双轨
ok 6 - 重复扫描不篡改已完成双轨，也不把仅原唱改成双轨
# tests 6
# suites 0
# pass 6
# fail 0
# duration_ms 185.4135
```

反向验证（新用例能否真实失败）：用 `/tmp/b20-broken-sql/importer.broken.mjs`（少一个占位符）替换被测模块后运行同一份测试代码：

```
not ok 1 - 新建曲目：原唱兜底入库走 INSERT 分支，返回 CREATED_ORIGINAL_ONLY 且各列落位
  error: '15 values for 16 columns'
  code: 'ERR_SQLITE_ERROR'
not ok 2 - 新建曲目：双轨入库同一条 INSERT，返回 CREATED 且伴奏指针落位
  error: '15 values for 16 columns'
  code: 'ERR_SQLITE_ERROR'
not ok 3 - 同曲二次入库：并入既有曲目返回 MERGED_ORIGINAL_ONLY，不新增行
  error: '15 values for 16 columns'
  code: 'ERR_SQLITE_ERROR'
# tests 3
# pass 0
# fail 3
```

## 5. 同类 INSERT 核对（未改动任何语句）

### `source_media`（importer.mjs:122-124，`upsertSource`）

```sql
INSERT INTO source_media(id,source_kind,source_locator,internal_path,sha256,duration_ms,audio_codec,video_codec,container)
VALUES(?,?,?,?,?,?,?,?,?)
```
- 列：9（`container` 由后续迁移追加，同表其余列有默认值）
- 占位符：9
- `.run(...)`：9（`id,'AUDIO',sourceLocator,internalPath,sourceSha256,durationMs,codec,null,null`）
- 结论：一致，无错位。

### `performance_clips`（importer.mjs:131-134，`upsertClip`）

```sql
INSERT INTO performance_clips(id,source_media_id,start_ms,end_ms,internal_audio_path,codec,source_preserving,sha256,size_bytes,duration_ms,version)
VALUES(?,?,0,?,?,?,?,?,?,?,1)
```
- 列：11
- 值：9 个占位符 + 2 个字面量（`start_ms=0`、`version=1`）= 11
- `.run(...)`：9（`id,sourceId,durationMs,internalPath,codec,sourcePreserving?1:0,sha256,sizeBytes,durationMs`）
- 顺序核对：`end_ms` 收到的是第三参 `durationMs`（配合 `start_ms=0` 即整轨），`duration_ms` 收到第九参 `durationMs`，两处同源一致。
- 结论：一致，无错位。

## 6. 变更清单

- 新增：`tests/vocal-import-created-row-v31.test.mjs`
- 新增：`docs/qa/evidence-2026-10-30-batch20/IMPORT-参数错位测试补齐.md`
- 未改动：`server/vocal-import/importer.mjs` 及任何其他 `server/` 文件；`tests/vocal-import-original-only-retry-v31.test.mjs` 保持原样。
