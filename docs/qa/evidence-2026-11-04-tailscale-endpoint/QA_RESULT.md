# QA_RESULT｜Tailscale 外网地址白名单放开（1.1.20 / 23）

- 日期：2026-11-04 09:46
- 设备：Note 12 Pro（ruby / indq5xfi6hovay4d / 22101316C），USB，用户锁定本机
- 判定：**PASS（能力层）**；**室外实际可用未验证**，原因见 §五
- 未跑全量回归（按用户口径）

## 一、改动

| 文件 | 内容 |
|---|---|
| `src/lib/device-settings.ts` | `validateEndpoint` 私有网段白名单增加 `100.64.0.0/10`（Tailscale/CGNAT）；`localName` 增加 `*.ts.net`（MagicDNS） |
| `tests/unit/device-settings.test.ts` | 新增 1 条用例：接受 100.64/10 两端与 `*.ts.net`；拒绝 100.63、100.128、裸 `ts.net`、`evil-ts.net` |
| `android/app/build.gradle` | versionCode 22→23，versionName 1.1.19→1.1.20 |

未改服务端鉴权（仍是配对码/owner token），未改 CORS、未开放公网端口。

## 二、自动化

```
npx vitest run tests/unit/device-settings.test.ts
→ 3 tests passed (3)
```

## 三、产物与装机

| 项 | 值 |
|---|---|
| 构建链 | `npm run build` → `npx cap sync android` → `./gradlew :app:assembleDebug`（JDK 21） |
| APK | `android/app/build/outputs/apk/debug/app-debug.apk`，14,106,237 B，2026-11-04 09:46 |
| 新逻辑进包 | `unzip -p … assets/public/assets/index-Dh_188gx.js \| grep -c "ts.net"` → `1` |
| 安装 | `adb -s indq5xfi6hovay4d install -r` → Success |
| 装机后版本 | `versionName=1.1.20`，`lastUpdateTime=2026-11-04 09:46:20` |

## 四、真机行为（WebView CDP 实测）

方法：`adb forward tcp:9225 localabstract:webview_devtools_remote_<pid>`，CDP 写 `localStorage['dance.device-settings'].apiEndpoint` 后 `location.reload()`，用 `Network.requestWillBeSent` 抓实际请求基址。

| 项 | 结果 |
|---|---|
| 改动前保存值 | `http://192.168.31.61:28794`（`lastSyncAt` 2026-10-03） |
| 写入目标 | `http://100.125.100.15:28794` |
| 重载后 API 基址 | `http://100.125.100.15:28794`，首个请求 `/api/catalog` |

结论：旧包（1.1.19）在此处会抛「仅支持可信本地或私有网络地址」并退回 `window.location.origin`；新包已按 Tailscale 地址发起真实请求。**白名单拦截已解除。**

## 五、未完成 / 已知阻塞

1. **手机当前无任何网络**：`wlan0` 无 IPv4；`mDataRegState=POWER_OFF`（移动数据 radio 关闭）；
   `ping 223.5.5.5` → `Network is unreachable`。故 CDP 观察到的 `/api/catalog` 请求必然失败，
   **室外可用性无法在本轮取证**。
2. **Tailscale 客户端未连接**：`com.tailscale.ipn` 进程在（pid 7711），但无 tun 接口，
   `ping 100.125.100.15` → `Network is unreachable`；tailnet 后台显示 `redmi-note-12-pro … offline, last seen 1d ago`。
   需用户在手机上手动连接。
3. **离线缓存未下载**：手机 `files/dance-offline/` 现存音频最后写入 2026-10-12，不含 11-03 导入的歌曲。
   下载必须能连上服务端（`src/native/filesystem.ts:84` 走 HTTP），联网后需重新点「下载全部音乐到手机」。

## 六、给用户的操作路径（无需再改包）

1. 手机开移动数据或连 Wi-Fi → 打开 Tailscale，开关置于「已连接」，确认 `wanghoufan13` 账号下本机在线。
2. 才艺展示厅 →「我的」→「本地服务地址」填 `http://100.125.100.15:28794` →「连接测试并保存」。
3. 连通后立刻做一次离线：同一页「离线音乐」→「下载全部音乐到手机」，等「全部完成」；此后断网也能听。

## 七、地图入口（用户 11-04 提问同步核实）

「歌曲地图/结构工作室」未被删除，git 全历史无删除提交。入口被沉浸模式挡住：

- 曲库点歌 → `TalentLibraryPage.tsx:40` 固定带 `?immersive=1` → `VocalPracticePlayer.tsx:802` 的 `!immersive` 条件使「歌曲地图」整块不渲染。
- 现路径：沉浸页右上「…」→「结构与其他」→「地图与结构」；或顶栏 `▤ 分段`（`VocalPracticePlayer.tsx:767`，需已有分段）。
- 收起沉浸（退出 `?immersive=1`）后「歌曲地图」恢复常驻显示。

## 八、室外真机实测（Note 12T Pro / UKCESWB67PUO7LPB）

> 设备变更：原锁定机 Note 12 Pro 于 09:52 被拔线，Tailscale 侧显示 `offline, last seen 1d ago`，`ping 100.91.121.33` 100% 丢包，`adb connect` 超时 —— **无法远程操作**。改在 12T Pro 实测，该机处于**真实室外形态**：无 Wi-Fi（`wlan0` 无 IPv4）、走移动数据、Tailscale `tun1` UP（`100.94.116.99/32`）。

### 8.1 在线通路（Tailscale）

| 项 | 结果 |
|---|---|
| 装机 | 1.1.20 → 后升 1.1.21 (24) |
| `validateEndpoint` | 接受 `http://100.125.100.15:28794` |
| `/api/catalog` | **200** |
| `/api/sync/operations` | **200** |
| 音频元素 | `src=http://100.125.100.15:28794/api/media/audio/…`，`readyState=4`，`duration=17.9`，无 `error` |
| 播放 | `paused=false`，`currentTime 0 → 3.28`（`duration 17.9`） |

### 8.2 下载

「我的」→「离线音乐」→「下载全部音乐到手机」：

- 启动前：`可离线播放 31/69 首`、`已缓存 101 个文件 / 372.6 MB`、`上次下载：全部完成`
- 启动后出现 `停止下载` 与 `已处理 x/53 · 成功 x · 失败 x`，`本次需下载约 613.4 MB`
- 落盘证据：`files/dance-offline` `373M → 382M`，新增 `audio-54e12845.audio`（8,723,982 B，09:58），计数 `101 → 102`，UI `成功 1`
- 实测速率约 **0.6 MB / 15 s**（走 DERP 中继 + 移动数据），613.4 MB 全量约需数小时
- 由用户口径停止（避免长时间占用移动流量）；停止后残留 `audio-3c210522.audio.tmp`（3.1 MB），下轮下载会覆盖，不影响就绪判定

### 8.3 完全断网（`svc data disable`，`ping 223.5.5.5` → Network is unreachable）

| 场景 | 结果 |
|---|---|
| 曲库打开 | **通过**，提示「当前无法连接服务器，已显示本地曲库」，31+ 首列表完整 |
| 曲库 `▶` 速听（`LibraryPage.tsx:64` 走 `playbackSource`） | **通过**，`src=http://localhost/_capacitor_file_/data/user/0/…/dance-offline/audio-311f3db5.audio`，`readyState=4`，`currentTime 0 → 3.14` |
| 舞蹈详情页「播放音乐」（修复前） | **失败**，`src` 仍为 `http://100.125.100.15:28794/api/media/…`，`readyState=0`、`duration=0` |
| 舞蹈详情页「播放音乐」（1.1.21 修复后） | **通过**，`src=http://localhost/_capacitor_file_/data/user/0/…`，`readyState=4`，`currentTime 0 → 3.28` |

## 九、缺陷与修复（1.1.21 / 24）

**缺陷**：舞蹈详情页播音乐绕过了离线缓存解析。

- 位置：`src/pages/DanceDetailPage.tsx:58`，原为 `src={mediaUrl(item.audio.url)}`
- 影响：已下载的曲目在详情页断网仍播不了，而曲库速听、练歌页（`TalentDetailPage.tsx:35`、`VocalPracticePlayer.tsx:122`）却正常 —— 用户从「点开这首歌」进去必然踩到
- 修复：改为 `src={playbackSource(item, readCachedIndex())}`，与曲库/练歌页同一解析口径
- 验证：`npx tsc -b` exit 0；1.1.21 装机后断网复验通过（见 8.3 末行）
- 未改：`ClipTrimmer.tsx:47`（片段试听）仍走 `mediaUrl` —— 属编辑功能，未纳入离线范围；如需要另开变更

## 十、交付物

| 项 | 值 |
|---|---|
| APK | 14,106,265 B，`android/app/build/outputs/apk/debug/app-debug.apk`，sha256 `91f26b1d…` |
| 装机 | 12T Pro `1.1.21`；Note 12 Pro `1.1.21`（11-04 10:22:56 装机，见 §十一） |
| 未提交 | 全部改动留在工作区，未 commit / 未 push |
| 未跑 | 全量回归（按用户口径） |


## 十一、Note 12 Pro 补装 1.1.21 + Tailscale 复验（11-04 10:22–10:30）

设备 `indq5xfi6hovay4d`（ruby / 22101316C）重新插线后补做，闭合 §十 遗留项。

| 步骤 | 实测 |
|---|---|
| 装包 | `adb install -r` 成功，`versionName=1.1.21`，`lastUpdateTime=2026-11-04 10:22:56` |
| 网络形态 | 移动数据 CTNET（`ccmni2` 10.152.127.153），Wi-Fi 开启但未关联，无局域网通路 |
| Tailscale | 客户端 `com.tailscale.ipn` 启起后开关为 **Connected**，`tun1` 100.91.121.33/32 UP；`mac-mini` 100.125.100.15 在线（绿点） |
| 链路 | `ping 100.125.100.15` 2/2 收包，0% 丢包（DERP 中继，RTT 1001–1550 ms） |
| 曲库 | 重载后 `/api/catalog` 204 → 200，68 首列表完整渲染 |
| 播放 | 曲库 ▶ 命中本地缓存 `dance-offline/audio-311f3db5.audio`，`readyState=4`、`duration=17.9`，`currentTime 3.69 → 6.19 → 8.70` 连续前进 |
| 详情页（1.1.21 修复点） | `/dances/9eea7a34…` 主播放器 `src` = `_capacitor_file_/…/dance-offline/audio-311f3d…`（不再走 `/api/media/audio/…`），修复在该机同样生效 |

同机遗留（不变，非本轮范围）：`ClipTrimmer` 片段试听仍走 `mediaUrl`，需联网。

## 十二、离线下载体积构成（11-04 10:30 核算，回答「为什么这么大」）

清单 `catalogVersion=60`，69 条（31 舞蹈 + 38 唱歌）；「下载全部音乐」实际入列 115 个文件，合计 **624.4 MB**，与界面显示的 613.4 MB 待下载一致（差额为已缓存部分）。

| 类别 | 体积 | 说明 |
|---|---|---|
| 唱歌（VOCAL） | **613.4 MB** | 38 首，每首存「原唱 + 伴奏」两条完整 MP3 320 kbps 立体声全曲，单首 16–22 MB |
| 舞蹈（DANCE） | 11.1 MB | 31 首，AAC 128 kbps 单声道、15–31 秒片段，单首 0.2–0.5 MB |
| 封面 | 1.9 MB | 31 张 JPEG |
| 原视频（另档） | 361.4 MB | 31 个 H.264 1080×2460 竖屏、约 7 Mbps、25–31 秒，单个 5–25 MB |

结论：体积不在舞蹈音频，也不在原视频（原视频是独立开关），而在 38 首唱歌「原唱 + 伴奏双轨 × 320 kbps 全曲」。若是想省空间，可只下伴奏或把长曲轨降到 192 kbps，属产品决策，未擅自改。

## 十三、移动网络+Tailscale 实测唱歌（11-04 12:08–12:35，Note 12 Pro）

用户口径：先把最新版推到 12 Pro，再断 Wi-Fi、仅用移动数据 + Tailscale，实测「外面能不能听和学」。

### 13.1 版本
`adb install -r` 1.1.21 (24)，`lastUpdateTime 2026-11-04 12:08:56`。源码无新于 APK 的改动，即工作区最新。

### 13.2 移动数据 + Tailscale（Wi-Fi 已 `svc wifi disable`，`wifi_on=0`）

| 项 | 结果 |
|---|---|
| 曲库 | ✅ `/api/catalog` 204 → 200，68 首完整 |
| 舞蹈播放 | ✅ 命中本地缓存 `dance-offline/audio-311f3db5.audio`，`readyState=4`，`currentTime 3.69 → 8.70` |
| 唱歌缓存覆盖 | ❌ **38 首，0 首缓存**（`fullyCached:0 / partial:0 / none:38`） |
| 唱歌在线播放 | ❌ 点播放后 `paused=false` 但 `readyState=0`、`duration=0`、`currentTime` 恒为 0（`networkState=2` 卡在加载） |

### 13.3 根因：Tailscale 直连失败，全部经美国 SFO 中继

```
tailscale ping 100.91.121.33 → pong via DERP(sfo) in 576–1493 ms
→ "direct connection not established"
tailscale status → 两台手机 relay="sfo"
```

链路吞吐实测（页内 fetch，服务端 Range 206 正常）：

| Range | 实际 | 速率 |
|---|---|---|
| 16 KB | 696 ms | 23 KB/s |
| 64 KB | 1 794 ms | 36 KB/s |
| 256 KB | 18 572 ms | 14 KB/s |
| 1 MB | >120 s 未完成 | <8.5 KB/s |

对照：同一手机移动数据直连公网 CDN ≈ 146 KB/s。服务端本地 `curl` 取 8.7 MB 仅 13 ms，**服务端与 Range 实现无问题，瓶颈在中继路径**。

一首唱歌曲 8.7 MB ÷ 约 20 KB/s ≈ 7 分钟 ⇒ 表现即「点了没反应」。

### 13.4 补做：Wi-Fi 下全量下载 → 全断网复测

Wi-Fi 恢复后自动连回家网（192.168.31.30），Tailscale 转为直连（`via 140.240.31.41:15740`，68 ms）。触发「下载全部音乐到手机」：

```
本次需下载约 613.4 MB · 已处理 53/53 个文件 · 成功 53 · 失败 0
落盘：files/dance-offline 625 MB / 123 files（/data 剩余 96 GB）
```

随后 **Wi-Fi + 移动数据全部关闭**（`wifi_on=0`、`ping 223.5.5.5 → Network is unreachable`）重启 App 复测：

| 项 | 结果 |
|---|---|
| 曲库 | ✅ 显示「当前无法连接服务器，已显示本地曲库」，列表完整 |
| 唱歌页 | ✅ 可进入 `风吹一夏` 详情 |
| 音源 | ✅ `_capacitor_file_/…/dance-offline/…`，`readyState=4`，`duration=198.9` |
| 播放 | ✅ `currentTime 3.80 → 6.81 → 9.40` 连续前进，`err=null` |
| 歌词 | ✅ 全段中文歌词正常展示；`▤ 分段` 入口在（该曲尚无结构） |

### 13.5 结论

1. **功能链路本身没坏**：唱歌播放已走 `playbackSource`/`trackSource`，有缓存即本地播放，断网可用。
2. **「外面听不了」的真因是没缓存 + 中继太慢**，不是代码缺陷。38 首唱歌曲在测试前一首未下载。
3. 已把 12 Pro 全量缓存到位（625 MB），该机现在断网可听可学。
4. 12T Pro 仍为 0 缓存，需回家 Wi-Fi 下一次（同样 53 个文件 / 613 MB）。
5. 若要「不下载也能在线听」，须解决 Tailscale 直连或就近 DERP（自建 DERP / VPS 中转），属基础设施改造，待用户拍板。
