# QA 回执｜1.1.32 (35) 取消配对码（局域网自动信任）＋新机离线缓存

- 日期：2026-11-08
- 版本：1.1.32 / versionCode 35
- 设备：OPPO 新机（192.168.31.85），同 Wi-Fi 与 Mac mini（192.168.31.61）同网段
- 服务：`node server/index.mjs`，`HOST=0.0.0.0 PORT=28794`，库 `var/vocal-v31-work/real-qa-20261030/db/qa.db`

## 变更

- `server/requests/service.mjs`：`pairOwner` 增加 `{trusted}`，可信来源免 32 位配对码仍签发独立凭据。
- `server/index.mjs`：新增 `trustedPeer(remoteAddress)`（127/::1、10/8、172.16-31、192.168/16、100.64/10），`/api/pair` 传入 `trusted`。
- `src/pages/SettingsPage.tsx`：`connect()` 保存成功后若无本地 token 自动调用 `/api/pair` 并落盘，提示「设备已自动配对」；配对码标签改为「家庭局域网/Tailscale 内可留空，自动配对」。
- `tests/requests.test.mjs`：新增 trusted 签发 / 非 trusted 仍拒绝用例。

## 结果（PASS）

| 项 | 证据 |
|---|---|
| 单元测试 `node --test tests/requests*.test.mjs` 4/4 | 终端输出 |
| `npx tsc --noEmit` 无报错；`npm run build` 成功 | 终端输出 |
| aapt2 `versionCode='35' versionName='1.1.32'`；APK 11278812 B，sha256 前缀 `243da1782a08ba07e88fff34cc842513` | aapt2 / shasum |
| 新机 `adb install -r` 覆盖安装 1.1.32 (35) | `dumpsys package` |
| 设置页点「连接测试并保存」→「连接成功，已保存：主地址可用 · 备用不通 · 设备已自动配对」 | `01-auto-pair-success.png` |
| 服务端 `owner_credentials` 12→13（新增一条，即手机凭据）；测试用 curl 凭据已删除（回到 13） | SQLite 查询 |
| 音乐缓存：70 文件 / 82.7 MB，31/39 首可离线播放 | `02-music-cached.png` |
| 原视频缓存：31/31 个，约 361.4 MB | `03-video-cached.png` |
| 主题仍为「跟随系统」 | `04-theme-system.png` |

## 说明与边界

- 备用地址 `http://100.125.100.15:28794`（Tailscale）在家庭 Wi-Fi 下不通属预期，主地址可用即保存成功。
- 31/39 中缺 8 首可离线音频：这 8 项清单里没有可下载音频资产，不是下载失败。
- 自动信任放宽到 RFC1918 + Tailscale CGNAT + 本机回环；公网来源仍需配对码。
- 未 commit / 未 push。
