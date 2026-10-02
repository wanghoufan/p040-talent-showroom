# US7 今晚歌单 / 离线准备 真机验证（T073–T078）

设备：固定真机 `192.168.31.63:5555`（Redmi Note 11T Pro+ / `22041216UC` / `xagapro`）。
APK：debug live 预览（WebView 加载 `http://127.0.0.1:5173`，`/api` 经 adb reverse + Vite 代理到 8791）。

## 接口与测试（T073/T074）

`GET/PUT /api/playlists/tonight`：PUT 覆盖式写入，position 稳定递增，事务内完成；拒绝重复 id / 未知 id（400）且不破坏原歌单；软删除曲目不可入单。
`tests/playlist.test.mjs`：3 用例全过。`tests/unit/playlist.test.ts`：`moveItem` 顺序 + 删除本地文件 readiness 立即失效（negative）。

修复的真实缺陷：`prepareOffline` 原先只依据索引判断就绪，**文件被删后仍误判 Ready**。修为先 `fileExists` 校验索引命中项、作废丢失项，下载后再逐条校验“索引就绪且文件存在”。

## 真机证据

1. **增删**：今晚歌单页逐条“＋”加入 10 首（鲨鱼舞郭富城版/青苹果乐园/胆小鬼/…/爱情鸟），列表 10 行。
2. **排序**：`下移` 按钮与**真实触摸拖动**（`Input.dispatchTouchEvent` 手势，从把手纵向拖 175px）均可重排；重载页面 + `GET /api/playlists/tonight` 顺序持久化一致。
   ```
   drag .playlist__handle 175
   before: [青苹果乐园, 鲨鱼舞, 胆小鬼, 青春修炼手册, …]
   after : [鲨鱼舞, 胆小鬼, 青苹果乐园, 青春修炼手册, …]
   ```
3. **准备离线演出（T076）**：点击后逐条下载/校验 → “已准备好”（10/10 均可离线）。
4. **readiness 失效（T078 negative）**：删除某歌单条目的本地音频文件（`run-as … rm files/dance-offline/audio-311f3db5.audio`，62→61）+ 停止 API（断网）→ 再点“准备离线演出”得到**“未准备好”**，该条列表显示**“未缓存，不可播”**。恢复 API 后再点一次自动重下、回到“已准备好”（62 文件）。
5. **演出页从歌单启动（T077）**：`/perform` 列表为 10 条，顺序与歌单一致；点播放 `currentTime` 前进（3.14s, paused=false）。
   **下一首只选中不发声**：点“下一首”后 `audio.src = null`、`paused = true`，标题切到“胆小鬼”，未自动播放。

## 边界

- 全程保留 31 条真实数据与原始媒体；歌单验证为临时数据，结束后已 `PUT items:[]` 清空、设备重新同步（playlist 空、cache 62）。未上传任何真实素材/数据库/密钥。
- 完全断网冷启动（kill app）仍待交付态 APK，见 `us5-offline.md` 边界。
