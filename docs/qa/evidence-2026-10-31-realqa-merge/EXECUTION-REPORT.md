# P040 real-qa 译文合并｜执行报告（2026-10-31）

前置预案：`docs/qa/evidence-2026-10-31-merge-clone/MERGE-PLAN.md` §六（已授权后执行）。
本轮按该预案执行，未改动预案中的任何判据。

## 一、结论

| 项 | 结果 | 证据 |
|---|---|---|
| 五首译文已合并进 real-qa 库 | 是，287 行 / 5 首 | `real-qa-apply.json` |
| 逐行与源库一致（id/text/source） | 5/5 首 `identical=true`，`mismatches=0` | `translation-parity.json` |
| 合并前后非目标数据零变化 | `problems=[]` | `db-compare.json` |
| 迁移 0009/0010 已应用 | 8 → 10 条，`dataPreserved=true` | `real-qa-plan.json` / `real-qa-apply.json` |
| 28794 服务已用原环境重启 | 是，PID 74097，PPID 1，`/api/health` 200 | `service-restart.json` |
| 原媒体 / 原音频 / LRC 未改 | 48 文件摘要改动前后完全一致 | `media-before.sha256` |
| 配对凭据未改 | `owner_credentials` 仍 4 行（只统计行数） | `db-before.json` / `db-after.json` |
| 云端翻译未触发 | 全部日志无 `/translations/translate` | 见 §六 |
| commit / push | 未做 | — |

## 二、执行步骤与实测输出

### 1) 记录现场（只读）
- 原进程 27651，PPID 1，启动 2026-10-30 22:26:40，`node server/index.mjs`，监听 `*:28794`。
- 环境变量（原样）：`HOST=0.0.0.0 PORT=28794 SQLITE_DB_PATH=<项目>/var/vocal-v31-work/real-qa-20261030/db/qa.db MEDIA_ROOT=<项目>/var/vocal-v31-work/real-qa-20261030/media VOCAL_IMPORT_WORKER=0`。
- 停止前三件套哈希与预案 `HASHES.txt` 完全一致：
  - `qa.db` `ae1e2261…`
  - `qa.db-wal` `409b72ad…`
  - `qa.db-shm` `d9e31506…`
- 媒体：48 文件、581,910,101 字节，manifest 记录于 `media-before.sha256`。
- 记录文件：`pre-stop-site.txt`。

### 2) 优雅停止（仅原 28794）
- `kill -TERM 27651`，约 1 秒内退出（`server/index.mjs` 的 `shutdown` 走 `server.close` → `db.close`）。
- 退出后 `PID_27651_GONE`、`PORT_28794_FREE`。
- **副作用（已核对，非异常）**：`db.close()` 触发 WAL checkpoint，数据并入主库，`qa.db` 由 729,088 → 749,568 字节，`-wal` / `-shm` 被正常移除。停止后 `qa.db` 哈希 `f1bd242e…`，即包含原 WAL 内已提交数据的完整状态；未丢数据（后续 31 首、4 条凭据、各表行数均已核对）。

### 3) 备份并核验
- 备份：`var/backups/real-qa-20261031-premerge/qa.db`（749,568 字节）。
- 哈希与源文件一致：`f1bd242e1a2a8e2e2b56322c481436bc4edbd63b7155cb167d02920724b86659`，`BACKUP_HASH_MATCH`。
- 备份库 `PRAGMA integrity_check` = `ok`；`schema_migrations` 8 条；无 `translations_json` 列（符合预案起点）。
- 合并脚本自身另备份一份：`var/backups/merge-clone-2026-10-30T20-20-33-954Z.db`，`707f2da9…`。
- 只读打开备份库时 SQLite 生成的空 `-wal`/`-shm` 已删除，避免遗留派生文件干扰恢复；`qa.db` 哈希复核不变。

### 4) dry-run（对原库）
- `--mode plan --confirm-original YES-WITH-AUTHORIZATION`，输出 `real-qa-plan.json`。
- 迁移：`appliedNow=[0009_vocal_structure.sql, 0010_vocal_translation.sql]`，`dataPreserved=true`。
- 计划：`songsChanging=5`、`linesAdding=287`、`linesRejected=0`、`staleLines=0`、`warnings=0`、缓存待补 183 —— 与预案 §五 克隆结果逐项一致。

### 5) 合并（单事务）
- `--mode apply`，输出 `real-qa-apply.json`。
- `verification.ok=true`、`problems=[]`。
- 逐曲（行数 / manual / ai / 修订号）：

| 曲目 | 译文行 | manual | ai | 修订 |
|---|---:|---:|---:|---|
| Insomnia (불면증) | 40 | 7 | 33 | 1→2 |
| 덤더럼 (Dumhdurum) | 44 | 14 | 30 | 5→6 |
| 베베 (BABE) | 65 | 20 | 45 | 1→2 |
| 보여줄게 | 47 | 13 | 34 | 2→3 |
| 사뿐사뿐 | 91 | 14 | 77 | 2→3 |
| 合计 | 287 | 68 | 219 | — |

- 缓存补齐 183 行（`INSERT OR IGNORE`），`cacheIntegrity.complete=true`，无删除、无改写。
- 合并前目标库译文为 0 首（`db-before.json` `translated: 0`），**不存在可被覆盖的人工译文**；`manual > lrc > ai` 规则本轮命中 `linesKeptProtected=0`，与克隆期注入 `manual` 行的护栏自测结论一致。

### 6) 独立复核（不复用脚本自检）

| 检查 | 工具 | 结果 |
|---|---|---|
| 逐行与源库一致 | `verify-translation-parity.mjs` | 5 首、287 行、`mismatches=0` |
| 前后快照 diff（只允许 translations/修订/账本/缓存/新表） | `compare-db-state.mjs` | `ok=true`、`problems=[]` |
| 表行数 | 同上 | 仅 `schema_migrations` 8→10、`vocal_translation_cache` 0→183、新增 `vocal_structure_drafts`（0 行） |
| 31 首 lyrics / title / artist / created_at / updated_at | 同上 | 全部一致；`lyricsDigest` 全等 |
| 修订号 | 同上 | 仅 5 首各 +1，无其他变动 |
| 媒体 48 文件 | `shasum` diff | `MEDIA_UNCHANGED` |

### 7) 同环境重启
- 命令与原进程逐项相同（含绝对路径、`VOCAL_IMPORT_WORKER=0`），日志追加 `var/vocal-v31-work/logs/lan-server.log`。
- 新 PID 74097，PPID 1（脱离会话，复用原「手动启动、无自启」形态；未安装 LaunchAgent、未设自动重启）。
- `GET /api/health` → `{"ok":true,"recognition":"disabled"}` HTTP 200。
- 无凭据 `GET /api/repertoire?kind=VOCAL` → HTTP 401（凭据未动、鉴权仍生效）。
- 启动日志仅 `Dance API http://0.0.0.0:28794`，无异常堆栈。

### 8) 接口层译文可见性（不读真实凭据）
- 做法：把合并后的库复制到 `var/vocal-v31-work/merge-20261031/api-check/`，**仅在副本**清空 `owner_credentials`（4→0），临时服务 `127.0.0.1:28797` 抓一次接口后立即停止，端口已确认释放。
- 结果（`api-repertoire-after.json`）：31 首中 5 首带 `translations`，逐首行数 40/44/65/47/91，`orphanLineIds=0`、`stale=0`，manual/ai 与库内一致；另 26 首无 `translations` 字段。
- `여름 안에서 (Live)` 仍 12 行 0 译文 —— 与预案 §三 一致，属数据未覆盖，不在本次范围。

## 三、证据分级（按 P040 验收口径）

- **确认发生**：服务停止与重启、库迁移、5 首 287 行写入、缓存补齐、媒体不变、健康检查 200、401 鉴权、接口返回 5 首译文。
- **确认未发生**：写生产库、改原媒体与原音频/LRC、改配对凭据、调用云端翻译、commit/push、操作手机、播放音频。
- **未测**：手机端实际刷新后是否显示译文（本轮不操作手机）；译文听辨准确率（仍只有文本审校）。

## 四、失败处置预案（本轮未触发）

回滚路径保持可用：停服务 → `node scripts/merge-translations-clone.mjs --mode rollback --target-db <库> --backup-file var/backups/real-qa-20261031-premerge/qa.db --confirm-original YES-WITH-AUTHORIZATION`；或 `cp -p` 备份覆盖后删除残留 `-wal/-shm` → 重启。回滚后 `qa.db` 哈希应回到 `f1bd242e…`，`schema_migrations` 回到 8 条。

## 五、本轮新增文件

| 文件 | 内容 |
|---|---|
| `pre-stop-site.txt` | 停止前进程、环境、端口、三件套哈希 |
| `media-before.sha256` | 48 个媒体文件摘要基线（事后 diff 一致） |
| `db-before.json` | 合并前库快照（8 迁移、31 首、0 译文） |
| `db-after.json` | 合并后库快照（10 迁移、5 首有译文） |
| `db-compare.json` | 前后 diff 判定（`ok=true`） |
| `real-qa-plan.json` | 原库 dry-run 全量判定 |
| `real-qa-apply.json` | 原库 apply 结果、自动备份路径与自检 |
| `translation-parity.json` | 与源库逐行一致性核对 |
| `api-repertoire-after.json` | 副本服务接口快照（无凭据副本） |
| `capture-db-state.mjs` / `compare-db-state.mjs` / `verify-translation-parity.mjs` | 上述三条独立复核脚本，可复跑 |
