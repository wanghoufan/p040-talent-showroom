# 架构与构建事实（P040）

仅记录可回源的事实；数字与哈希均出自 `docs/qa/evidence-2026-10-31-*/` 与本机命令输出。最后核对：2026-11-04 15:45。

## 一、技术栈与运行形态

- 前端：React + Vite（TS/TSX），测试用 vitest（`tests/browser/`、`tests/unit/`、`tests/*.mjs`）。
- 原生壳：Capacitor 8；`npx cap sync android` 同步 `dist/` 到 `android/app/src/main/assets/public/`。
- 服务端：Node 单进程，端口 28794（`p040-vocal-lan-28794`，pid 29603，PPID 1、手动启动），用 real-qa 隔离库，`VOCAL_IMPORT_WORKER=0`。
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
