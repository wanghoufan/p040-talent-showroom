# P040 译文合并｜克隆 dry-run 与授权后执行预案（2026-10-31）

- 目标：把 `translation-20261031` 隔离库已审校的 5 首韩文歌译文，按 **歌曲 ID + 稳定行 ID** 合并进 `real-qa` 库，使手机端在服务重启后能读到 `translations`。
- 本轮状态：**只在独立克隆与临时前台服务中完成验证**。原 `real-qa` 库、原媒体、生产库、正在运行的服务、手机均未写入/未停止/未改动。
- 授权状态：向用户申请「更新现有 real-qa 隔离曲库 + 重启其后台服务」，**未获授权前不执行 §六**。

## 一、边界与未做事项（实测结论）

| 项 | 本轮是否发生 |
|---|---|
| 写原 `real-qa` 库（`var/vocal-v31-work/real-qa-20261030/db/qa.db`） | 否。哈希前后一致（见 `HASHES.txt`） |
| 写原媒体（`real-qa-20261030/media`） | 否。48 文件整体摘要前后一致，最新 mtime 仍是 2026-10-30T11:18:45Z |
| 写生产库 `var/personal-dance-library.db` | 否。未打开 |
| 停止/重启现有 28794 服务（pid 27651） | 否。未发信号 |
| 操作手机（adb/截图/设置） | 否 |
| 读取或输出任何 token / 配对码 / 凭据内容 | 否。只统计 `owner_credentials` 行数 |
| 调用云端翻译、播放音频、做伴奏分离 | 否。临时服务固定 `P040_TRANSLATE_DISABLED=1`，未请求 `/translations/translate` |
| 启动常驻服务 | 否。临时服务只绑 `127.0.0.1:28795`，抓完即停，端口已确认无监听 |
| commit / push | 否 |

工作副本位置（均在 `var/`，已 gitignore，可整体删除）：`var/vocal-v31-work/merge-20261031/{db,api,migrate-check,media,logs}`；备份在 `var/backups/merge-clone-*.db`。临时服务端口 `28795`（接口冒烟）与 `28796`（启动迁移验证）均已停止，复查无监听。

## 二、实测事实

1. **迁移 0009/0010 在克隆上通过**：克隆库起始 8 个迁移（到 `0008_vocal_import.sql`），跑最新版 `openDatabase()` 后为 10 个，新增 `0009_vocal_structure.sql`、`0010_vocal_translation.sql`。
   - 另用**最新版 `server/index.mjs` 直接启动**（`127.0.0.1:28796`，独立副本）复验：启动前 8 条、启动后 10 条，`/api/health` 200；该副本保留 4 条凭据，不带 token 请求曲目返回 401（预期）。见 `service-migration-check.json`。
   - `vocal_structure_drafts` 建表成功（0 行）；`repertoire_items.translations_json` 新增，31 首中 26 首为默认 `{}`。
   - **数据零变化**：迁移前后对 31 首逐列摘要、歌词摘要、各表行数比对，`problems=[]`（脚本 `dataPreserved.ok=true`）；`owner_credentials` 仍是 4 行（未读取内容）。
2. **合并结果**：5 首共写入 287 行译文，`rejected=0`、`stale=0`、`warnings=0`；合并后逐行与源库 `id/text/source` **完全一致**（5/5 首 `identical=true`）。
3. **人工优先规则有效**：在一次性副本把 `사뿐사뿐 line-1` 改成 `manual` 且文本不同，再跑 apply → `KEEP_MANUAL`、`changes=0`、`skipped=NO_CHANGES`，该行仍为注入文本（`manual-guard-selftest.json`）。
4. **幂等**：合并后重跑 dry-run → `songsChanging=0`、`linesAdding=0`、`linesUnchanged=287`、缓存待补 0（`idempotency-plan.json`）。
5. **缓存**：`vocal_translation_cache` 183 行全部补齐（`INSERT OR IGNORE`），源键 183/183 在目标中存在，无删除、无改写。
6. **API 冒烟（仅隔离副本）**：`GET /api/repertoire?kind=VOCAL` → 31 首中 5 首带 `translations`，每首 `lines` 与歌词 id 全部可对应、`stale=0`；另 26 首无 `translations` 字段（`api-smoke.json`）。
7. **原库未被本轮改动**：`qa.db` 仍是 `ae1e2261…`；它的 WAL/SHM 与 1.1.8 轮记录（`6c5440…` / `07457c…`）已不同，但**本轮开工前后完全一致**，说明差异来自这段时间内手机正常连服务产生的业务写入，不是本轮动作。

## 三、关键口径：不要把「12 句曲目」和「5 首已译」混在一起

| 口径 | 数字 | 说明 |
|---|---|---|
| 唱歌曲目总数 | 31 | 全库 `kind='VOCAL'` |
| 韩文歌 | 9 | 其中 5 首有译文、4 首没有 |
| 已合并译文 | 5 首 / 287 行 | 사뿐사뿐 91、베베 65、보여줄게 47、덤더럼 44、Insomnia 40 |
| 用户截图「翻译缺失 12 句」的曲目 | **여름 안에서 (Live)**，12 行、0 译文 | 是 4 首未覆盖韩文歌之一，**不在本次 5 首内**；修完服务重启后这首歌仍不会显示译文 |
| 未译韩文歌 | 4 首 / 167 行 | 여름 안에서 12、소나기 49、흉터 58、Bubble Pop! 48 |
| 全库无译文 | 26 首 | 其余中文/英文歌同样没有译文数据 |
| 베베 未译 5 行 | line-1…line-5 | 全部是制作署名（Chorus：김보아、All Programming by 等），审校结论为不译，不是漏译 |

结论：本次修复只解决「5 首已有译文但服务读不到」；截图那首 12 句歌属于**数据未覆盖**，需要另跑翻译，不在本合并范围。

## 四、合并规则（脚本 `scripts/merge-translations-clone.mjs`）

- **对齐键**：先按 `repertoire_items.id`（歌曲 UUID），再按歌词行 `id`（`line-N` 稳定行 id），不使用数组下标。
- **原文闸门**：逐行要求目标库与源库该行 `text` 完全一致，否则以 `STALE_SOURCE_TEXT` 拒绝；`sourceHash` 按目标原文重算，不一致记 `SOURCE_HASH_REPAIRED`（本轮 0 条）。
- **优先级**：复用服务端 `mergeTranslations` —— `manual` 覆盖一切；`lrc` 可覆盖 `ai`，但不覆盖 `manual`；`ai` 只填空或刷新 `ai` 自己。
- **写入范围**：只 `UPDATE repertoire_items SET translations_json=?`；`lyrics_json`、时间轴、`sections_json`、`practice_json`、音轨、封面、来源等**一律不写**。`revision` 由既有触发器 `repertoire_revision` 自动 +1；`updated_at` 不改（自检 `changedFields` 只有 `revision`）。
- **元数据**：`updatedAt/provider/model` 目标已有则保留，缺失才从源库补（本轮补为 `2026-10-30T18:16:55Z / manual / user`）。
- **缓存**：只补缺，不删不改。
- **硬护栏**：生产库永远拒绝；原 `real-qa` 隔离库默认拒绝，只有显式 `--confirm-original YES-WITH-AUTHORIZATION` 才放行；目标等于源、或指向译文源库也拒绝。

## 五、Dry-run 汇总（克隆 `var/vocal-v31-work/merge-20261031/db/qa.db`）

| 曲目 | 歌词行 | 合并译文 | 其中 manual / ai | 变更行 | 拒绝 | 修订号 1→2 |
|---|---:|---:|---|---:|---:|---|
| Insomnia (불면증) | 40 | 40 | 7 / 33 | 40 | 0 | 1→2 |
| 덤더럼 (Dumhdurum) | 44 | 44 | 14 / 30 | 44 | 0 | 5→6 |
| 베베 (BABE) | 70 | 65 | 20 / 45 | 65 | 0 | 1→2 |
| 보여줄게 | 47 | 47 | 13 / 34 | 47 | 0 | 2→3 |
| 사뿐사뿐 | 91 | 91 | 14 / 77 | 91 | 0 | 2→3 |
| 合计 | 292 | 287 | 68 / 219 | 287 | 0 | — |

缓存新增 183 行；`stale=0`；`warnings=0`。逐曲明细见 `merge-plan.json` / `merge-apply-result.json`。

## 六、授权后对 real-qa 的执行步骤（未执行，待用户点头）

> 前置：用户明确同意「更新 real-qa 隔离曲库 + 重启 28794 服务」。以下 `cd` 到项目根执行，逐步核对输出再走下一步。

```bash
# 0) 记录现场（只读）
ps -o pid,etime,command -p 27651
shasum -a 256 var/vocal-v31-work/real-qa-20261030/db/qa.db{,-wal,-shm}

# 1) 停服务（仅此步会改变运行态；用 SIGTERM 让 server 走 shutdown 收尾）
kill -TERM 27651 && sleep 2 && ps -p 27651 >/dev/null || echo stopped

# 2) 三件套整份备份（服务停止后再拷，避免 WAL 半写）
mkdir -p var/backups/real-qa-20261031-premerge
cp -p var/vocal-v31-work/real-qa-20261030/db/qa.db{,-wal,-shm} var/backups/real-qa-20261031-premerge/
shasum -a 256 var/backups/real-qa-20261031-premerge/*

# 3) 再跑一次 dry-run（对原库只做迁移 + 只读计划；此步会写 schema，属授权范围）
node scripts/merge-translations-clone.mjs --mode plan \
  --source-db var/vocal-v31-work/translation-20261031/db/qa.db \
  --target-db var/vocal-v31-work/real-qa-20261030/db/qa.db \
  --confirm-original YES-WITH-AUTHORIZATION \
  --out docs/qa/evidence-2026-10-31-merge-clone/real-qa-plan.json
# 预期：totals.songsChanging=5、linesAdding=287、rejected=0、staleLines=0；
#       migrations.appliedNow=[0009,0010]（若服务已用新代码启动过则可能为空）

# 4) 执行合并（单事务；脚本会再自动备份一份 yyyy-mm-dd 命名的 db）
node scripts/merge-translations-clone.mjs --mode apply \
  --source-db var/vocal-v31-work/translation-20261031/db/qa.db \
  --target-db var/vocal-v31-work/real-qa-20261030/db/qa.db \
  --confirm-original YES-WITH-AUTHORIZATION \
  --backup-dir var/backups \
  --out docs/qa/evidence-2026-10-31-merge-clone/real-qa-apply.json
# 必须看到 verification.ok=true、problems=[]、translations 里 stale=0

# 5) 用**与原来完全相同**的 env 重启，指向 real-qa 库与媒体（不要指向 translation 库，
#    那边只有 3 条凭据，手机 token 会失效）
HOST=0.0.0.0 PORT=28794 \
SQLITE_DB_PATH=var/vocal-v31-work/real-qa-20261030/db/qa.db \
MEDIA_ROOT=var/vocal-v31-work/real-qa-20261030/media \
VOCAL_IMPORT_WORKER=0 \
node server/index.mjs >> var/vocal-v31-work/logs/lan-server.log 2>&1 &

# 6) 复核（不带凭据只能验 health 与 401；带凭据的曲目校验由用户/已配对设备完成）
curl -s http://127.0.0.1:28794/api/health
```

- 重启后手机端需要**刷新/重新同步曲库**才会拿到新 `revision` 与 `translations`；本次不操作手机。
- 不要用「把服务指向 translation 库」的备选方案：凭据 3 条会让现有配对失效。

## 七、失败与回滚

| 失败点 | 处理 |
|---|---|
| 迁移中途失败 | `openDatabase` 对每个迁移文件单独 `BEGIN IMMEDIATE`，失败即 `ROLLBACK` 并关闭连接；库保持原状 |
| 合并中途失败 | 脚本单事务写入，异常 `ROLLBACK`；已生成备份路径写入报告 |
| 写入后自检不通过 | 先看 `problems`（`LYRICS_CHANGED` / `NON_TARGET_COLUMN_CHANGED` / `TABLE_CONTENT_CHANGED`）定位；确认是数据问题时按下面回滚 |
| 需要整体回退 | 停服务 → `node scripts/merge-translations-clone.mjs --mode rollback --target-db <库> --backup-file <备份> --confirm-original YES-WITH-AUTHORIZATION`；或 `cp -p` 三件套覆盖后删除残留 `-wal/-shm` → 重启 |
| 回滚后核对 | `qa.db` 哈希须等于备份哈希；`schema_migrations` 回到 8 条（若连迁移一起回退）或保持 10 条（仅回退数据） |

## 八、风险与未覆盖

1. **26 首仍无译文**（含 4 首韩文 167 行）：本次不产生新译文，也不调用云端。
2. **五首译文质量**：仍只有文本审校，人工听辨准确率 **未验收**，不得报百分比。
3. **服务重启**会中断手机端当前连接几秒；重启后旧进程缺 `0009` 结构路由的问题一并解决（同源缺陷）。
4. **生产库仍停在 0006**，`0010` 迁移需用户单独授权，与本次无关。
5. 合并后 `updated_at` 不变是刻意选择（只改目标列）；若后续有按 `updated_at` 增量同步的逻辑，需要另行确认。

## 九、证据清单（本目录）

| 文件 | 内容 |
|---|---|
| `MERGE-PLAN.md` | 本报告 |
| `merge-plan.json` | 克隆 dry-run 全量判定（含迁移前后比对、逐曲逐行） |
| `merge-apply-result.json` | 克隆 apply 结果、备份路径与自检 |
| `idempotency-plan.json` | 合并后重跑，证明幂等 |
| `manual-guard-selftest.json` | 注入 manual 行后 apply，证明不被覆盖 |
| `api-smoke.json` | 临时服务只读接口结果（5 首带译文、12 句歌定位、韩文歌分布） |
| `service-migration-check.json` | 最新版服务直接启动、自动应用 0009/0010 的实测记录 |
| `HASHES.txt` | 原库/原媒体/克隆/备份哈希与前后对照 |
