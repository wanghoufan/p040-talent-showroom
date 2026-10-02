# US5 Android 离线演出 / 离线缓存 真机验证（T058–T064）

设备：固定真机 `192.168.31.63:5555`（Redmi Note 11T Pro+ / `22041216UC` / `xagapro`）。
未使用另一台 USB Note12 Pro。APK：debug live 预览（`CAP_LIVE=1`，WebView 加载 `http://127.0.0.1:5173`，`/api` 经 adb reverse + Vite 代理到 8791，媒体由原生直连同源下载）。

## 本轮修复的真实缺陷

1. **相对媒体地址导致原生下载全失败**：`mediaUrl()` 在未配置端点时返回相对路径（`/api/media/...`），`Filesystem.downloadFile` 报 `no protocol`，每条下载异常被静默吞掉 → `downloaded=0`。修为未配置端点时回落到 `window.location.origin` 拼绝对地址（原生经 Vite 代理下载）。
2. **播放地址无效**：`CachedMedia.path` 存的是相对路径（`dance-offline/audio-*.audio`），`Capacitor.convertFileSrc` 对相对路径不做转换，`<audio>` 源仍为相对路径不可播。修为下载时保存原生返回的**绝对 URI**（去掉 `.tmp`），播放用 `convertFileSrc(uri)`；`isMediaReady` 增加“无 URI 判未就绪”。

修复后 `tsc -b` 0 错、`eslint .` 通过、`vitest run` 5 文件 9 用例通过、`node --test` 通过。

## 清单接口（T059）

`GET /api/sync/manifest`（主机实测）：`count=31`、`catalogVersion=32`、`playlist=0`，每条含 audio/cover 的 `url/sha256/sizeBytes/version`，**无绝对路径、无 `internal_audio_path`**。

## 真机证据

同步（T061）：点“同步离线曲库” → 状态“已同步 31 首，新缓存 62 个文件”。
设备落盘核对：
```
$ adb shell run-as com.wanghoufan.dancelibrary.dev ls files/dance-offline | wc -l
62
（audio-*.audio 313 个 KB 级别 + cover-*.img）
```
`localStorage['dance.offline.cache']` 62 条，每条含绝对 `uri`，例如
`/data/user/0/com.wanghoufan.dancelibrary.dev/files/dance-offline/audio-311f3db5.audio`
→ `convertFileSrc` = `http://127.0.0.1:5173/_capacitor_file_/.../audio-311f3db5.audio`。

演出页离线播放（T062）：`<audio>` `src=_capacitor_file_…`、`currentTime` 持续前进（3~6s）、`paused=false`、`readyState=4`、`error=null`。
**强化证据（无数据源仍可播）**：临时停止本项目 API（8791，测试后立即重启）后重载演出页，缓存曲目仍正常播放（`currentTime=3.1s`，源为本地文件）→ 媒体确为离线文件而非网络。

未缓存 UI（T063）：移除某会跳曲目的缓存条目后重载演出页 →
列表项显示“未缓存，不可播”，副标题“未识别 · 未缓存”，点击播放弹提示“这首歌还没有离线缓存，请先在设置里同步。”，`audio.src` 保持 `null`。测试后已还原缓存索引（62 条）与数据状态（31 条 `WANT_TO_LEARN`）。

## 未完成 / 边界

- **T064 完全断网冷启动（kill app → cold start → ≤3 操作播放 → 10 条切歌）未做**：当前为 live 预览（WebView 加载 Mac 上的 Vite，依赖 `adb reverse`），断 WiFi 会同时断开 adb over TCP，无法代表真实离线冷启动。此项须在**交付态打包 APK**（打包 dist，无 `server.url`）上执行，届时补 `android-offline.md`。
- 全程保留 31 条真实导入数据与原始媒体；临时数据改动均已还原。未上传任何真实素材/数据库/密钥。
- 正式签名、commit/push、长期部署留 Human Gate。
