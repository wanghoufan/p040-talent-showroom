# P040 只读根因分析｜手机「全部没有翻译 + 播放无声」｜2026-10-31

- 执行边界：只读。未触碰手机、未播放音频、未读/未输出任何 token、未改任何数据库或文件、未跑全量回归、未 commit/push。
- 分析方法：`ps`/`lsof`/`socketfilterfw` 查运行态；`sqlite3 -readonly` 只读查库；`curl` 只打无需凭据的 `/api/health`；`ffprobe`/`ffmpeg volumedetect` 只读分析音轨（不发声）。

## 一、当前运行的服务（实测）

| 项 | 实测值 |
|---|---|
| 进程 | pid `27651`，`node server/index.mjs`，无 `--watch` |
| 启动时刻 | 2026-10-30 22:26:40（已运行 5h40m） |
| 环境 | `HOST=0.0.0.0` `PORT=28794` |
| 数据库 | `var/vocal-v31-work/real-qa-20261030/db/qa.db` |
| 媒体根 | `var/vocal-v31-work/real-qa-20261030/media` |
| 其它 | `VOCAL_IMPORT_WORKER=0`；日志 `var/vocal-v31-work/logs/lan-server.log` 仅启动三行，无请求日志 |
| 可达性 | `http://127.0.0.1:28794/api/health` → 200；`http://192.168.31.61:28794/api/health` → 200；系统防火墙关闭 |
| 手机连接 | `192.168.31.226` 有 3 条 ESTABLISHED 连到 28794 → 手机确实连的是这台服务 |

## 二、根因 A：译文（可证）

1. **进程是 10-30 22:26 的旧代码**。译文/结构模块与迁移文件的创建时间全部晚于进程启动：
   - `0009_vocal_structure.sql` → 2026-10-30 23:47:41
   - `0010_vocal_translation.sql` → 2026-10-31 00:39:09
   - `server/vocal-structure/routes.mjs` → 23:48:14；`server/vocal-translation/*` → 00:39:34 ~ 02:18:40
   - `server/index.mjs` → 00:40:59（译文挂载 `mountTranslationRoutes` 属未提交改动，`git show HEAD:server/index.mjs` 无该导入）
   Node 在启动时一次性加载模块，因此该进程**既没有结构路由，也没有译文路由与 `translations` 字段**。
2. **它的库没迁移到 0010**：`real-qa` 库 `schema_migrations` 只到 `0008_vocal_import.sql`；`repertoire_items` 无 `translations_json` 列；无 `vocal_translation_cache`、无 `vocal_structure_drafts`。
3. **译文数据在另一个库**：`var/vocal-v31-work/translation-20261031/db/qa.db`（0001–0010 全在），31 首唱歌中仅 5 首有译文：
   `덤더럼` 4677B、`사뿐사뿐` 9562B、`보여줄게` 4849B、`베베 (BABE)` 6796B、`Insomnia (불면증)` 4529B；其余 26 首 `translations_json` 为 `{}`；缓存表 183 行。
4. 两库其余数据一致（31 曲目/46 音轨；VOCAL 的 `lyrics_json`/`sections_json` 长度逐首相同，仅 revision 因译文写入更高）；凭据 real-qa 4 条、translation 3 条，translation 的 3 条全部是 real-qa 的子集。

结论：手机连的服务返回的曲目 JSON 里**根本没有 `translations` 字段**，客户端 `readTranslations()` 只能拿到 null → 全曲不显示译文。即便重启该服务，若仍指向 real-qa 库，也必须先导入译文数据；且**26 首本来就没有译文数据**，属数据覆盖问题，不是显示 bug。

## 三、根因 B：播放无声（分段证据）

服务端音轨是好的（已证）：
- 46 条 `performance_clips` 的 `internal_audio_path` **46/46 全部存在于磁盘**，无缺失。
- `사뿐사뿐` 原唱 mp3：44.1kHz/2ch，`mean_volume -8.1 dB`、`max 0.0 dB`，时长 219.57s（与库中一致）；伴奏 flac：`mean -16.2 dB`。**不是静音文件**。
- 服务端 `/api/media/audio/:id` 支持 Range，`?owner=` 可鉴权；无凭据访问返回 401（属预期）。

客户端侧的两条路径不对称（`src/pages/PerformancePage.tsx:31`、`src/native/filesystem.ts:39`）：
- **演出页**：原生端 `resolveMediaUrl()` 只接受“已下载且 `cachedFileValid` 落盘校验通过”的离线文件，未下载返回空串 → `toggle()` 直接 `setNotice(blockedReason())`，元素没有 `src`，**必然无声**（只弹提示，不出声）。这是设计行为，不是解码问题。
- **练习页**：`playbackSource()` 缓存未命中回落网络地址，可局域网直连播放；但它只信任离线索引里的 `sha256/version/sizeBytes`，**不校验文件是否还在盘上**（对比演出页的 `cachedFileValid`）。索引残留 → 指向已不存在的本地文件 → `onError` 后无声。

因此“播放无声”在服务端不存在可归因缺陷；剩下三种可能无法在不动手机的前提下排除：
①用户在演出页试播（未下载离线）；②手机离线索引残留（练习页）；③手机媒体音量/静音/蓝牙输出或 401（若 token 失效，会同时出现曲库同步报错）。

## 四、同源影响（现在或稍后必现）

同一旧进程还缺 `0009` 与结构路由：手机端「校准歌曲结构」的保存/草稿/恢复请求会打到不存在的路由（或库缺表），会失败。这不是新 bug，是同一个版本错位。

## 五、最小修复方案（待主代理执行，本人未做）

1. 备份 `real-qa` 库（含 `-wal`/`-shm`）到 `var/backups/`。
2. 停 pid 27651，**用完全相同的 env 重启** `node server/index.mjs`：`openDatabase()` 启动时自动应用 `0009`+`0010`（纯 `ADD COLUMN`/`CREATE TABLE`，可逆）。
3. 从 `translation-20261031/db/qa.db` 复制 5 首的 `translations_json` 到 real-qa 库（按 id 精确 UPDATE），**保留 real-qa 的 4 条凭据不变**，手机配对不受影响。
   备选：直接把服务指向 translation 库——只需 3 条凭据，手机 token 可能失效需重新配对，风险更高。
4. 验证：带 token 请求 `GET /api/repertoire/...` 确认 5 首含 `translations.lines`；`GET /api/media/audio/:id` 返回 206 且 `Content-Type: audio/mpeg`。
5. 无声：先在**练习页**复测并记录提示文案；若仍无声而媒体接口为 200/206，再处理客户端缓存（清除离线缓存或给 `playbackSource` 补落盘校验）。演出页必须先“下载全部音乐”才会出声，属预期。
6. 26 首无译文需另跑批处理，属新增数据，不在本次修复范围。
