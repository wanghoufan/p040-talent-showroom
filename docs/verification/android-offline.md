# T064 完全离线冷启动（真机 note11tpro）

日期：2026-10-02（Asia/Shanghai）　设备：USB `IN9LZTAYV4UGU4JF`，`22041216UC` / `xagapro`。
APK：bundled debug（11,297,194 bytes），SHA-256 `2a9d96e8d825188ba8663894b0c4b923fb105dba1c6b8d51843e7c8a4393889c`。

## 结论：T064 物理断网冷启动与 10 条手动切歌 PASS

- 前置：31 首真实曲库、62 条缓存索引；覆盖安装保留原数据。
- `cmd connectivity airplane-mode enable` + `svc wifi disable` + `svc data disable`；读回 `airplane_mode_on=1`、`wifi_on=0`，`dumpsys connectivity` 显示 `Active default network: none`。双卡 MIUI 的 global `mobile_data` 读数仍为 1，因此以飞行模式和无默认网络作为断网证据，不以该读数冒充蜂窝状态。USB ADB 不依赖网络。
- `am force-stop` → `am start` 冷启动；页面 `http://localhost/`，31 张卡、62 条缓存；**1 次原生屏幕点击**开始第一首音乐，符合 ≤3 操作。
- 依次真实触摸前 10 张卡片播放，逐首断言曲名与目标一致、使用 `/_capacitor_file_/` 本地文件、`paused=false`、`error=null`、`currentTime>0`。
- 第一首暂停后 `paused=true`，0.6 秒内时间不再前进，按钮变回 ▶；播放条保留。
- 每首播放均仅 1 张高亮卡，按钮显示 ⏸，悬浮播放条可见且固定；后面曲目通过即时滚动后点击，不用 JS `play()` 代替点击。
- `finally` 恢复原网络开关：飞行模式 0、Wi-Fi 1、蜂窝设置 1；播放已暂停。

| # | 曲目 | currentTime(s) | error | 本地文件 / 反馈 |
|---|---|---|---|---|
| 1 | 鲨鱼舞郭富城版 | 1.213 | null | PASS |
| 2 | 青苹果乐园 | 1.349 | null | PASS |
| 3 | 胆小鬼 | 1.209 | null | PASS |
| 4 | 青春修炼手册 | 1.326 | null | PASS |
| 5 | 跳楼机dj版 | 1.328 | null | PASS |
| 6 | 红日 | 1.330 | null | PASS |
| 7 | 第一次爱的人 | 1.240 | null | PASS |
| 8 | 等你的回答 | 1.320 | null | PASS |
| 9 | 爱 | 1.318 | null | PASS |
| 10 | 爱情鸟 | 1.351 | null | PASS |

原始状态证据：`offline-playback-round4.json`；截图：`screens/t064-physical-offline-playing.png`、`screens/library-play-enhanced-paused.png`。

## 边界与历史

- 本轮证明的是实际物理断网下的曲库播放；现有曲库 31 首均为“想学”，没有“会跳”条目，未修改真实学习状态。SC-004 的“已缓存会跳”指定前置尚未按字面验证，继续保留 PARTIAL；不把 T064 通过扩大成全部现场验收完成。
- 出声：用户本轮明确表示“是有声音”，此前无声路由问题已重启解决；本轮由播放状态和本地文件桥接验证链路，最终现场试听签收仍属 Human Gate。
- 旧测试使用停后端近似断网，已由本轮飞行模式真机证据替代；旧截图 `t064-offline-coldstart.png` 保留历史。
- 测试工具曾遇 DOM 渲染定位短暂缺失、滚动时点击命中上一首；增加元素等待、即时滚动、曲名身份断言后，重新执行十首全部通过，不以失败轮作为通过证据。
