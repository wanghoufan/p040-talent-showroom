# T064 完全离线冷启动（真机 note11tpro）

日期：2026-10-02　设备：192.168.31.63:5555（Redmi Note 11T Pro+ / 22041216UC / xagapro）
APK：bundled 交付态 `app-debug.apk`（11,297,029 bytes，http scheme + allowMixedContent）。

## 场景与方法

- 本机固定真机**只有网络 ADB**，开启真正飞行模式会断开 adb 通道；因此以「停掉 Mac 后端（`HOST=0.0.0.0 PORT=8791 node server/index.mjs` 进程结束、8791 无监听）」近似「完全断网」，App 侧等同后端不可达。**如实标注：非物理断网**。
- 前置：已连接过一次并「同步离线曲库」→ 31 首 / 62 文件落盘（localStorage 索引 62 条）。
- 步骤：`am force-stop` → `am start`（冷启动）→ 观察曲库 → 手动切歌。

## 结果

- 冷启动后：`location.href=http://localhost/`，曲库渲染 **31 张卡片**，顶部提示「当前无法连接服务器，已显示本地曲库」（离线快照）；`想学 31`。
- 快速播放（曲库页，新增离线优先解析后）：`audio.currentSrc` 为 `http://localhost/_capacitor_file_/data/...`（Capacitor 本地文件桥接，非 LAN 地址），`paused=false`、`currentTime` 前进（约 3s）、`duration=19.46`、`error=null`。
- **手动切歌 10 条**（依次点击第 1–10 张卡片的快速播放）：10/10 均 `local=true`、`err=null`、`currentTime` 前进（见下表）。

| # | currentTime(s) | error | 本地文件 |
|---|---|---|---|
| 1 | 3.3 | null | true |
| 2 | 3.1 | null | true |
| 3 | 3.4 | null | true |
| 4 | 3.1 | null | true |
| 5 | 2.8 | null | true |
| 6 | 3.0 | null | true |
| 7 | 2.8 | null | true |
| 8 | 2.7 | null | true |
| 9 | 2.9 | null | true |
| 10 | 2.4 | null | true |

- 截图：`docs/verification/screens/t064-offline-coldstart.png`。

## 本轮修复（为满足 US5）

- 曲库快速播放原先只使用 LAN 地址，离线不可播；抽统一 `playbackSource(item, cached)`（`src/native/filesystem.ts`）：离线文件就绪优先本地，否则回落网络。曲库与演出模式共用。

## 未闭环

- 「实际出声」仍需用户确认（见 `audio-diagnosis.txt`：设备媒体音量 0 + MIUI 录屏占用 remote_submix 路由）。
