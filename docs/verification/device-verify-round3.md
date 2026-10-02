# 真机验证 · 第 3 轮（note11tpro）

日期：2026-10-02　设备：192.168.31.63:5555（Redmi Note 11T Pro+ / 22041216UC / xagapro，Android 14 / SDK 34）
APK：bundled 交付态 `app-debug.apk`（11,297,029 bytes，SHA-256 `aab1680e499d144bcb05553c7f9dcfd9f0c7af997d2bfd42b68299fa15a8b0bb`，debug 签名）
后端：Mac `HOST=0.0.0.0 PORT=8791`（192.168.31.43），endpoint `http://192.168.31.43:8791`。

## T083 系统状态栏/导航栏跟随主题（已修复）

- 现象：深色主题下，顶部状态栏与底部系统导航栏恒为白/浅色（截图像素 `(250,250,250)`），不跟随 App 主题。
- 根因：Capacitor 默认主题未声明 `FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS`，导致 `Window.setStatusBarColor` / `setNavigationBarColor` 被系统忽略（MIUI 下表现为恒白）。
- 修复（`android/.../ThemeBarsPlugin.java`）：`apply()` 中新增
  `window.addFlags(FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)` + 清除 `FLAG_TRANSLUCENT_STATUS/NAVIGATION`，并对 Decor 设置同色背景兜底、关闭系统栏对比度强制（API29+）。
- 复验（重建 + `adb install -r` 后冷启动，全屏 `screencap` 采样）：
  - 深色：状态栏 `(6,11,18)`、导航栏 `(6,11,18)`（= `#060b12`）。
  - 浅色：状态栏 `(246,248,251)`、导航栏 `(246,248,251)`（= `#f6f8fb`）。
  - 截图：`docs/verification/screens/theme-dark-bars.png`、`theme-light-bars.png`。

## T072 详情 → 查看原视频（一击播放，通过）

- 步骤：`/dances/:id`（鲨鱼舞郭富城版）→ 点击「查看原视频」链接 → `/reference/53696cbc-…`。
- 结果：`video.paused=false`、`currentTime` 前进（3.27s）、`duration=19.47s`、`readyState=4`、`error=null`（autoPlay 一击即播）。
- 截图：`docs/verification/screens/t072-detail.png`、`t072-reference-play.png`。

## T071 安全删除（软删除 + 恢复，通过）

- 步骤：`/dances/:id` → 「删除这支舞」→「仅移除（保留文件）」。
- 结果：曲库 `31 → 30`（`/api/catalog` items 计数），媒体文件未删除（`deleteMedia=false` 分支）。
- 恢复：`UPDATE dance_items SET deleted_at=NULL WHERE id=…` → 曲库 `30 → 31`。
- 说明：本条验证「默认软删除+可恢复」；「同时删除本地媒体文件」为二次确认分支，本轮未触发。

## 未闭环

- 「播放没有声音」仍需用户关停 MIUI 录屏后复听确认（见 `audio-diagnosis.txt`）。
