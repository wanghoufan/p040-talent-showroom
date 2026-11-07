# QA｜1.1.29 (32) 版本号纪律与旧包清理

日期：2026-11-07｜执行：主开发者（本窗口）｜范围：出包版本纪律 + 真机推送

## 1. 目标

1. 每次出包版本号必增，用户能在「设置→关于」分清新旧。
2. 删除旧调试包（`.dev`），三台手机只留生产包。
3. 三台生产包配置服务器主备地址与配对码，曲库在线。

## 2. 变更

| 项 | 内容 |
|---|---|
| 版本 | `versionCode 31 → 32`、`versionName 1.1.28 → 1.1.29`（`android/app/build.gradle`） |
| 纪律脚本 | 新增 `scripts/bump-android-version.mjs` + `npm run android:bump`（versionCode+1、版本名末位+1，写后回读校验） |
| 旧产物 | 删除 `android/app/build/outputs/apk/debug/`（旧 `app-debug.apk` 14,130,177 B，11-06 23:39） |

## 3. 出包核验

- `npm run build` OK（vite 1.28s）→ `npx cap sync android` OK → `:app:assembleRelease` BUILD SUCCESSFUL (17s)。
- APK `android/app/build/outputs/apk/release/app-release.apk`，11,277,752 B，2026-11-07 15:35。
- `aapt2 dump badging` → `versionCode='32' versionName='1.1.29'`，包名 `com.wanghoufan.dancelibrary`，minSdk 24 / targetSdk 36。

## 4. 真机结果

| 设备 | 卸 `.dev` | 装 1.1.29 | dumpsys 版本 | 地址/配对 | 曲库在线 | 关于页 |
|---|---|---|---|---|---|---|
| Note 11 5G `WGBMXWDIAIFMPFCQ` | Success | `install -r` Success | 32 / 1.1.29 | 主备 + 配对成功 | PASS（截图见 `n11-lib.png`） | — |
| Note 12 `indq5xfi6hovay4d` | Success | `install -r` Success | 32 / 1.1.29 | 主备 + 配对成功 | PASS（`n12-lib2.png`） | **版本 1.1.29（构建 32）**（`n12-ver3.png`） |
| 12T Pro `UKCESWB67PUO7LPB` | 未做 | 未做 | — | — | — | —（当日 USB 断开） |

## 5. 踩坑

- Note 12 在**配对码输入框弹起软键盘**时 WebView 必黑屏（两次复现）；先 `ime disable` 再点框输入即正常，输入后 `ime enable` + `ime set` 复原。
- 该机 WebView 默认不向 uiautomator 暴露节点，且系统 `accessibility_enabled` 会被自动复位；改用「截图定位 + 坐标点按」逐项核对。

## 6. 未完成

- 12T Pro 补装 1.1.29 (32)、删 `.dev`、配地址配对（需重插 USB）。
- 旧备份 `var/backups/apk/p040-1.0.1-dev.apk`（1.0.1 调试包，11-03）未删，等用户决定。

## 7. 证据文件

- `n12-ver3.png`｜关于页版本
- `n11-lib.png`｜Note 11 曲库在线
- `n12-q2.png`｜Note 12 配对成功
- `n12-lib2.png`｜Note 12 曲库在线
