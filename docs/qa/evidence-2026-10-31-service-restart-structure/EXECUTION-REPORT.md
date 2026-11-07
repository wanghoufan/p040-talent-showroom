# 执行报告｜重启 p040-vocal-lan-28794 以加载结构参考目录与波形接口

- 日期：2026-10-31（CST）
- 服务 ID：`p040-vocal-lan-28794`
- 授权：用户当次明确选择 **A1**（允许重启当前隔离曲库服务以加载 Papillon 参考及波形接口），并要求不暂停、不再追问
- 结论：**PASS（服务层）**；鉴权后的端到端验证与手机侧验证不在本轮范围（见 §7）

## 1. 重启前核对

| 项 | 实测 |
|---|---|
| 原进程 | pid 3170、PPID 1、启动 2026-10-31 04:31:47、`node server/index.mjs` |
| 工作目录 | 项目根 `/…/040-ing-才艺展示厅` |
| 环境（白名单读取） | `HOST=0.0.0.0`、`PORT=28794`、`SQLITE_DB_PATH=…/var/vocal-v31-work/real-qa-20261030/db/qa.db`、`MEDIA_ROOT=…/real-qa-20261030/media`、`VOCAL_IMPORT_WORKER=0` |
| 数据指向 | **real-qa 隔离库**（非生产库 `var/personal-dance-library.db`） |
| 后台伴奏 worker | 关闭（`VOCAL_IMPORT_WORKER=0`）；重启前后均无 `audio-separator`/`demucs`/`spleeter` 进程 |
| 迁移 | `server/db/migrations/` 仅 0001–0010；`schema_migrations` 已应用 0001–0010（0009/0010 于 2026-10-30 20:20:30）⇒ **无新增迁移** |
| 旧代码判定 | pid 3170 启动 04:31:47 早于 `vocal-structure/routes.mjs` 05:22:51 与 `service.mjs` 05:23:16 ⇒ 线上为旧接口集 |
| 自启排查 | `~/Library/LaunchAgents`、`launchctl list`、`crontab -l` 均无 p040/vocal 条目 |

**关于未认证探测的说明**：`server/index.mjs:67` 的全局配对门会对任何 `/api/*` 请求先返回 401（"请先在“我的”配对这台设备"），结构路由在 `server/index.mjs:79` 才分发。因此 401 不能证明路由存在——重启前用目标路径与任意伪造路径探测，响应完全相同。

## 2. 重启前一致性备份

- 命令：`sqlite3 qa.db ".backup 'var/backups/real-qa-20261031-prerestart-structure/qa.db'"`
- 完整性：备份 `pragma integrity_check = ok`；线上 `ok`
- 内容哈希：线上 `.dump` = 备份 `.dump` = `945253cd0468da77d79d3e46792f73a46b064616c5e12bceb4aff9f136f9a56f`
- 物理文件 SHA-256：备份 `28b6e1ef…`、线上 `1de4b4d7…`（`.backup` 重排页，**以 `.dump` 内容哈希为准**）
- 关键计数：`repertoire_items` 31｜`sections_json` 非空 31｜`translations_json` 非空 22｜`vocal_translation_cache` 677｜`vocal_structure_drafts` 0｜`vocal_import_jobs` 35｜`owner_credentials` 4（仅计数）｜`source_media` 31
- 媒体基线：48 文件（其中 mp3/lrc 31），清单哈希（路径+大小+mtime 排序）`34dfa12f6566cf74dc3b5639307dd11289ca86fc484007e9955b5bbfa700d8ed`
- 基线文件：`var/backups/real-qa-20261031-prerestart-structure/BASELINE.md`

## 3. 优雅停止

- `kill -TERM 3170` → 进程退出，端口 28794 释放，`qa.db-wal`/`qa.db-shm` 正常移除（WAL 已 checkpoint）
- 停止后 `pragma integrity_check = ok`，`.dump` 哈希仍为 `945253cd…`（数据未变）
- 未停止、未影响任何其他进程；仅目标服务被停

## 4. 同环境重启

- 命令：项目根下 `HOST=0.0.0.0 PORT=28794 SQLITE_DB_PATH=…/real-qa-20261030/db/qa.db MEDIA_ROOT=…/real-qa-20261030/media VOCAL_IMPORT_WORKER=0 node server/index.mjs >> var/vocal-v31-work/logs/lan-server.log 2>&1`
- 新进程：**pid 5164、PPID 1、启动 2026-10-31 08:54:43**，`node server/index.mjs`，工作目录为项目根
- 环境与停机前逐项一致（同上白名单复核）
- 未安装 LaunchAgent、未设自动重启、未加开机自启（`launchctl`/`crontab` 复核无条目）
- `NODE_OPTIONS` 为空、无 `NODE_COMPILE_CACHE` ⇒ 启动时直接读取源码，不受字节码缓存影响
- 日志新增标记：`=== restart 2026-10-31T00:54:35Z (structure reference catalog + waveform routes, user-authorized A1) ===`

## 5. 健康与路由验证

| 项 | 结果 |
|---|---|
| 端口监听 | `node pid 5164` LISTEN `*:28794` |
| `GET /api/health` | **200**，`{"ok":true,"recognition":"disabled"}` |
| 未配对访问 `/api/repertoire/<id>/structure-draft/reference/catalog` | 401（全局配对门） |
| 未配对访问 `/api/repertoire/<id>/structure-waveform` | 401（同上） |
| 未配对访问任意伪造路径 | 401（同上，证明 401 无区分力） |

**路由存在性的确定性断言**（离线、只加载工作区代码，不触库/不读音频/不写文件）：

```text
PASS handled=true  GET  /api/repertoire/<id>/structure-draft/reference/catalog   status=404 NOT_FOUND
PASS handled=true  GET  /api/repertoire/<id>/structure-waveform                  status=503 波形不可用（桩 mediaRoot）
PASS handled=true  POST /api/repertoire/<id>/structure-draft/reference/reapply   status=404 DRAFT_NOT_FOUND
PASS handled=false GET  /api/repertoire/<id>/definitely-not-a-route-xyz          （不接管）
RESULT pass=4 fail=0
```

- 脚本：`.local/verify/route-presence.mjs`（一次性验证件，未入库）
- 配合启动时间 08:54:43 晚于路由代码 mtime（05:05–05:23）且无字节码缓存，可判定运行进程已加载包含两个新路由的最新代码
- 静态挂载链：`server/index.mjs:19` import `mountStructureRoutes` → `:211` 挂载 → `:79` 分发；`ffmpeg`/`ffprobe` 存在于 `/opt/homebrew/bin`
- 前后端路径契约一致：`src/lib/vocal/structure-api.ts:104/111` 与 `:126` 请求的 `…/structure-draft/reference/catalog`、`…/structure-waveform` 与服务端 `routes.mjs:33-34` 的正则完全对应（无路径错配）

## 6. 重启后数据一致性

| 项 | 重启前 | 重启后 |
|---|---|---|
| `.dump` SHA-256 | `945253cd…a56f` | `945253cd…a56f` |
| `pragma integrity_check` | ok | ok |
| `repertoire_items` / `with_sections` / `with_translations` | 31 / 31 / 22 | 31 / 31 / 22 |
| `vocal_translation_cache` | 677 | 677 |
| `vocal_structure_drafts` | 0 | 0 |
| `vocal_import_jobs` | 35 | 35 |
| `owner_credentials`（仅计数） | 4 | 4 |
| `source_media` | 31 | 31 |
| 媒体文件数 / 清单哈希 | 48 / `34dfa12f…` | 48 / `34dfa12f…` |

结论：重启与加载新路由**未改写**任何曲目结构、译文、练习数据、导入任务或媒体文件；`structure_drafts` 仍为 0，说明没有触发任何结构生成。

## 7. 边界与未做项（不作为已完成）

- **未读取、未输出**任何 token、配对码或含凭据 URL；`owner-pairing.json` 未打开
- 未修改生产库 `var/personal-dance-library.db`（mtime 仍为 2026-10-14 10:02）、未迁移生产库
- 未修改源 MP3/LRC、未改历史人工结构或练习数据（以 `.dump` 与媒体清单哈希为证）
- **未做**伴奏提取/生成/分离（`VOCAL_IMPORT_WORKER=0`，无分离进程）
- 未做鉴权后的真实 `reference/catalog` 与 `structure-waveform` 响应验证（需已配对设备，手机侧由主代理后续验证）
- 未操作手机、未安装包、未跑全量回归、未 commit/push
- 未新增任何开机自启或自动重启

## 8. 回滚

```bash
# 停服务 → 用备份库覆盖 → 同环境重启
kill -TERM 5164
cp var/backups/real-qa-20261031-prerestart-structure/qa.db var/vocal-v31-work/real-qa-20261030/db/qa.db
# 再按 §4 命令重启
```

## 9. 后续事实：原服务复验与数据漂移（2026-10-31 09:02 补记）

本节记录 §6 之后发生的事，**不修改上面任何实测值**；§6 的 `vocal_structure_drafts = 0` 是 08:54 重启时快照，不是当前值。

- 手机侧（1.1.13 / 16，用户指定 Redmi Note 11 5G）在**真实服务**上完成一次参考复验，无代理、无替身：`/api/repertoire` 200、音频 Range 206；结构室首屏即显示 Papillon 五项身份一致、10 段候选、2 段争议、真实 SVG 波形（15 个边界手柄）。
- 载入前只读核查：该曲无 `vocal_structure_drafts` 行、正式结构 16 段。经用户授权只点击一次「载入这份参考」。
- 载入后只读回读：**新增 1 条 `DRAFT`**（10 段、2 段 disputed/unknown、`DRAFT_REVIEW_REQUIRED`、`applied_revision=null`）；正式 16 段结构哈希与载入前完全相同；未保存人工结构、未确认类型或重复关系、未应用草稿。
- 原唱播放：`paused=true, muted=false, volume=1, readyState=4, error=null, guard=false`；播放约 3.5 秒由 0 推进到约 3.53 秒，随后暂停，终态仍 `muted=false, volume=1`、错误为空。未改系统音量。
- 服务自身未再重启、环境变量未改；`/api/health` 200。媒体文件与生产库未变。
- **限制**：控制通道无法采集手机扬声器 ⇒ 不报听感；五首真实人工听辨未做；底栏四 Tab 遮挡仍在；身份不匹配文件的 409 未测。
- 细节与截图见 `docs/qa/evidence-2026-10-31-reference-phone/QA_RESULT.md` 末节。
