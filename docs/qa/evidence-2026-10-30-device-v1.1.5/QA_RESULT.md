# 真机 QA｜V3.1 真实入库 + 播放/切轨/离线（1.1.5）

- 日期：2026-10-30 11:20–12:30（Asia/Shanghai）
- 设备：Redmi Note 11 5G（USB/adb，已按设备锁 profile 绑定；序列号不记录）
- 构建：APK `1.1.5（构建 8）`，安装包 `android/app/build/outputs/apk/debug/app-debug.apk`（11:42 构建）
- 隔离环境：`var/vocal-v31-work/real-qa-20261030/`（独立 SQLite / 媒体根 / 真实曲库副本根），真实 `audio-separator` 0.47.2 + `model_bs_roformer_ep_317_sdr_12.9755.ckpt`
- 连接：手机经局域网直连隔离 API；配对在 WebView 内完成，token 不落文档
- 出声：系统音乐流音量 10/15、`audio` 元素 `muted=false, volume=1`；播放时进度持续推进

## AC 结果

| AC | 场景 | 操作 | 实际结果 | 证据 | 状态 |
|---|---|---|---|---|---|
| AC-DEV2-01 | P1 AbortSignal 复验 | 1.1.5 打开「我的 → 本地智能导入」，读取 roots 与任务列表 | 目录/任务均正常加载，无 `AbortSignal.timeout` 报错 | 05-import-status-real.png | PASS |
| AC-DEV2-02 | 真实歌曲隔离入库 | 真实分离器提取 Dumhdurum 后由手机查看 | 任务 `IMPORTED`；唱歌曲库出现 1 首；详情有原唱/伴奏双轨、32 句同步歌词、3:28 | 05/06、库列表文本 | PASS |
| AC-DEV2-03 | 原唱播放/暂停/续播出声 | 点「▶ 播放」→「❚❚ 暂停」→「▶ 播放」 | 播放 `0:05 / 3:28`；暂停后 `paused=true` 且 `ct=9.68` 冻结 3 秒不动；续播 `ct=12.79, paused=false`；`volume=1, err=null` | 07-v1.1.5-playing.png | PASS |
| AC-DEV2-04 | 播放中切伴奏（BUG-V21-001 复验） | 播放中原唱→伴奏，再切回 | 音轨媒体 ID 变化，进度连续（4.88s→7.63s），未暂停、无 error | CDP 记录见下方 | PASS |
| AC-DEV2-05 | 离线播放（AC-V21-10） | 我的→「下载全部音乐到手机」→ 1/1 首、2 文件 29.8 MB；停掉 API 后重开 App 播放 | 顶部提示「当前无法连接服务器，已显示本地曲库」；曲目仍在；播放源为 `_capacitor_file_`，进度推进、无 error；伴奏也可离线切换 | 03-offline-playing.png | PASS |
| AC-DEV2-06 | 离线错误本地化（本轮修复项） | 停服后进「唱歌」曲库 | 原显示英文 `Failed to fetch`，修复后显示「无法连接本地服务，请检查服务器地址与网络后重试」 | 04-offline-cn-message.png | PASS |
| AC-DEV2-07 | Touch 真实入库 | 真实分离器提取 Touch（首轮被服务重启打断，12:05 租约到期后自动重跑） | 12:17:29 `IMPORTED`；曲库出现第 2 首，3:26、双轨+同步歌词；结构如实显示「待分析」，不猜段落 | 08/09、库列表文本 | PASS |
| AC-DEV2-08 | Touch 播放/切伴奏 | 播放原唱 → 切伴奏 | `paused=false`、`0:05 / 3:25`、切轨后 9.75s 继续、`err=null` | 08-touch-playing.png、09-touch-accomp.png | PASS |

## 关键 CDP 记录（原始观测）

- 在线原唱：`paused=false, ct=4.85, dur=208.08, err=null`，`src=/api/media/audio/86dcf18b…`（`?owner=` 仅键名，值未记录）
- 切伴奏：`src=/api/media/audio/5cb3dc74…`，`ct=20.46, paused=false, err=null`
- 1.1.5 回归：在线播放取本地缓存 `_capacitor_file_`，`ct=5.87`；切伴奏后 `ct=7.63, paused=false, err=null`
- 离线：`src=http://localhost/_capacitor_file_…`，`ct=4.84→9.18`，`err=null`

## 本轮修复

- `src/lib/api.ts`：`fetch` 网络失败（服务未启动/断网）由浏览器原文 `Failed to fetch` 统一归一为中文 `CONNECTION_ERROR_MESSAGE`（`ApiError(…, 0)`），AbortError 仍原样抛出。
- 版本：`android/app/build.gradle` 升至 `versionCode 8 / versionName 1.1.5`；App 内「我的」显示「版本 1.1.5（构建 8）」。

## 真实限制与未完成

1. **未做人耳听感判定**：只能证明播放推进、未静音、音量 10/15；主唱残留/乐器损伤未听测。
2. **未做 20 首批量**：本轮跑通 2 首真实曲目（Dumhdurum、Touch）；「爱的恰恰」停在 NEEDS_REVIEW（文件名/标签歌手不一致，属正常歧义，待人工选择或确认）。
3. **未跑全量回归**：只做了针对性真机复测；构建内含 `tsc -b`。
4. **一次黑屏观测**：11:25 左右用 adb 连续注入按键配对后，App WebView 画面全黑、`screencap` 返回空文件；logcat 仅见 `GPUAUX Null anb`，重启 App 即恢复，后续未复现，暂记为环境/渲染偶发，不作缺陷定论。
5. **配套隔离服务为临时进程**：QA 结束即停，未写入生产库 `var/personal-dance-library.db`。
