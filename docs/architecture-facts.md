# 架构与构建事实（P040）

仅记录可回源的事实；数字与哈希均出自 `docs/qa/evidence-2026-10-31-*/` 与本机命令输出。最后核对：2026-11-04 15:45；2026-11-09 追加 §六（本轮未构建、未装机）。

## 一、技术栈与运行形态

- 前端：React + Vite（TS/TSX），测试用 vitest（`tests/browser/`、`tests/unit/`、`tests/*.mjs`）。
- 原生壳：Capacitor 8；`npx cap sync android` 同步 `dist/` 到 `android/app/src/main/assets/public/`。
- 服务端：Node 单进程，端口 28794（`p040-vocal-lan-28794`，现由 LaunchAgent `local.p040-vocal-lan-28794` 托管：登录自启＋KeepAlive），用 real-qa 隔离库，`VOCAL_IMPORT_WORKER=0`。plist 见 `~/Library/LaunchAgents/local.p040-vocal-lan-28794.plist`。
- 数据库：生产库已从 0006 迁至 0010；备份及核验见 `docs/qa/evidence-2026-10-31-production-migration/QA_RESULT.md`。

## 二、构建链（唯一口径）

1. `npm run build` → 产出 `dist/`（本轮 205 个文件）。
2. `npx cap sync android`（JDK 21，3 个 Capacitor 插件）。
3. `./gradlew :app:assembleDebug`（Debug 包即真机验收包）。

- JDK：Temurin **21.0.12.1+1**，`JAVA_HOME=~/android-toolchain/jdk-21.0.12.1+1/Contents/Home`（macOS 包结构，少了 `/Contents/Home` 会报 invalid directory）；JDK 17 构建失败。
- 版本真源：`android/app/build.gradle` 的 `versionCode` / `versionName`；构建后需 grep `dist/` 确认注入值，且不得残留上一版本号。
- 产物元数据：`android/app/build/outputs/apk/debug/output-metadata.json`（release 目录下的 metadata 是 2026-10-13 的旧包，`versionCode 2 / 1.0.1`，不可当现状引用）。
- 包名：debug `com.wanghoufan.dancelibrary.dev`；release `com.wanghoufan.dancelibrary`。

## 三、产物核验方法（每轮必做）

- 2026-11-03 起：`real-qa` 库已并入生产库的 31 首舞蹈及其媒体（107 文件），手机（Note 12 Pro）同时可见舞蹈 31 + 唱歌 32；详见 `docs/qa/evidence-2026-11-03-import-persist/QA_RESULT.md` §八。

- `aapt2 badging` 读 APK 实际 `versionCode/versionName` 与包名。
- `dist/` ↔ `android/app/src/main/assets/public/` ↔ APK `assets/public/` 三方 SHA-256 逐一比对（本轮 0 处不一致；APK 另有 `cordova.js`、`cordova_plugins.js` 两个 0 B 占位）。
- 新代码是否进包：在 APK 内 bundle 里 grep 本轮新增文案。
- 代码是否晚于产物：`find src server tests -type f -newer <apk>`，输出为空才说明产物包含当前代码。

## 四、构建记录（同日多次出包）

| 版本 | 产物 | 大小 | SHA-256 前缀 | 时间 |
|---|---|---|---|---|
| 1.1.14 (17) | debug | 14,117,386 B | `c4553738…` | 10-31（dock-fit 轮） |
| 1.1.15 (18) | debug | 14,105,157 B | `a3c5f1da…` | 10-31（player-seek 轮） |
| 1.1.15 (18) | debug | 14,303,703 B | `76a0b679…` | 10-31 10:28:56（map-autoselect 轮） |
| 1.1.16 (19) | debug | 14,304,114 B | `371a6336…` | 10-31 11:14:38（dock-tighten 轮） |
| 1.1.18 (21) | debug | —（已被 1.1.19 覆盖，未留哈希） | — | 11-03（导入持久化修复，Note 12 Pro 验证） |
| 1.1.22 (25) | debug | 14,125,477 B | `3f8890ca…` | 11-04 15:31（V1.3-R2，Note 11 5G 装机） |
| 1.1.19 (22) | debug | 14,106,025 B | `a5cc5e60…` | 11-03 17:08:23（卡片样式回滚 + 导入修复；当前盘上包与 Note 12 Pro 装机版本） |
| 1.1.20 (23) | debug | 14,106,237 B | `615378d2…` | 11-04 09:46（Tailscale 地址白名单放开；Note 12 Pro 已装） |
| 1.1.21 (24) | debug | 14,106,265 B | `91f26b1d…` | 11-04 10:01（详情页走 playbackSource 修离线播放；12T Pro 已装） |

同一 `versionCode 18` 存在两个不同哈希的包，装机前必须按哈希认包（见 `docs/risks.md`）。

## 五、关键前端资源哈希（1.1.15 二包）

- `index.html` `42942c29…`
- `index-DkO7qQZh.js` `eacee088…`（含本轮地图自动选段文案）
- `index-CIXvh_pW.css` `006d696b…`（含 `.vocal-studio--drawer .vocal-map__head` sticky 规则）
- `ScoreReader-DB3l_ak9.js` `82629049…`

明细：`docs/qa/evidence-2026-10-31-map-autoselect/assets-summary.json`，脚本 `verify-assets.mjs`。

## 六、视频持久化与局域网换机迁移（2026-11-09 更新：已构建、已两机真机验收）

> 事实出处：`docs/qa/evidence-2026-11-09-migration-e2e/QA_RESULT.md`、`docs/handoff/2026-11-09-video-migration-status.md`；
> 包与版本以 `android/app/build.gradle` 与 APK 回读为准。

- **视频持久层**（`src/lib/video-store.ts`、`src/lib/offline-files.ts`）：索引内 `StoredVideo.stamp`＝`字节数:mtime`；`contentVerified` 依指纹跳过重启后的整份重算；`hashFile` 短读直接抛错，不完整副本不得标 `verified:true`；`discardStoredVideo` 先删文件成功才摘索引；`linkStoredVideo` 索引缺失先 recovery、按 id 串行，播放/上传用当前容器 `getUri` 重解析；`recoverStoredVideos` 并发共享一轮、索引一次性写回；无 sidecar/摘要的孤儿仅登记 `verified:false`、`checksum:undefined`，保留文件与 `.part` 现场，读取抛错拦截播放/上传；`discardPendingFile` 只删待办临时文件与记录，不删持久副本/sidecar/jobId/sourceMediaId。
- **迁移数据层**（`src/lib/migration.ts`）：`MigrationState` 含 `operations`/`pendingFiles`；旧机只读收集、新机幂等写回；清单纳入 `dance-pending/` 与 `dance.offline.manifest` 摘要（新机无清单时按合并后曲库重建）；`inspectVideoCopies` 要求 sidecar 到位、`verified:true`、checksum 存在且 path/size 一致；`planCacheIndex` 冲突单列 `conflict`，不混入 `skipped`；`dance.pending-imports.v1` 按 `jobId` 幂等合并；`complete` 要求无失败、无隔离冲突、无缓存/待办/未完成收录的跳过或冲突。
- **同步保护**（`src/lib/migration-sync-guard.ts`）：内存态闸门；`begin` 后等在途上传自然结束，默认 30s 超时自动释放；保护期内 `flushLocalFiles` 不发起上传、`perform` 传完当前文件即止、`discardPendingFile` 拒绝执行；不改上传协议。**仅单测覆盖，真机未核验。**
- **原生加密与配对**（`android/app/src/main/java/com/wanghoufan/dancelibrary/` 下 `MigrationCrypto.java`、`MigrationWire.java`、`MigrationPairingGuard.java`、`MigrationPlugin.java`、`MigrationShareServer.java`）：
  - 手动路径：**6 位数字配对码**（`123 456` 分组，Crockford 长码已删除），码经 SHA-256 展开后进 HKDF（`pairingCodeBytes`）；一次性、10 分钟有效；握手限速 500ms/来源、确认失败 5 次锁 60 秒、未确认会话按来源与总量限额。
  - 自动路径：旧机 UDP `42872` 应答 `{schema,tcpPort,token}`（128 位一次性 token，不回数字码）；新机广播搜索并把 token 放进握手；服务端标记会话 `auto` 并**等待旧机用户点「允许」**（`allowPair`/`denyPair`），未允许时确认回 428，新机轮询到 90s 超时；拒绝回 403；token 派生材料进 HKDF。
  - 其余：清单整体加密、文件 256 KiB 分块独立加密（96 位随机 nonce，AAD＝`handshakeId|fileId|chunkIndex|size`，发送前复核 size/lastModified 变化即 409）、清单响应绑定请求 nonce、请求 HMAC + 时间戳/nonce 且按会话保存已用 nonce（满则拒绝，会话结束丢弃）；连接总量 8 / 单 IP 3，请求头读超时 10s、传输 30s；半包名绑定握手与内容摘要，续传前截断到块边界；旧明文 `/api/migration/pair` 入口已删除。
- **UI**（`src/components/MigrationPanel.tsx`）：旧机显示 6 位数字码/端口/局域网地址与「允许 / 拒绝」确认条；新机提供「自动搜索旧手机」（结果列表一键连接）＋「6 位数字配对码手动连接」兜底；展示逐类未完成原因与冲突；迁移成功广播 `dance-migration-applied`，设置页即时重算缓存统计。
- **构建与测试状态（2026-11-09 21:3x）**：
  - 版本 **1.1.36（构建 39）**，`assembleRelease` 成功，APK `849b60cf226846ef520c4c555208ac38650937eedf1fa42fd734f15d02cb0ebc`，11,333,220 B；两台真机覆盖安装后「关于」显示 1.1.36（构建 39）。
  - 定向测试：JS 10 个文件、92 用例全过（迁移/视频持久/同步保护/面板/导入持久化）；Java 单测整套 24 用例全过（`MigrationCryptoTest` 10 + `MigrationWireTest` 5 + `MigrationPairingGuardTest` 8 + 1）；`tsc -b`、相关 ESLint 通过。
  - 真机：自动发现→旧机允许→102 文件 444.3 MB 传输完成、二次迁移幂等（0 新增/101 跳过）、断网杀进程后原视频可播、旧机数据不变；证据见上。
