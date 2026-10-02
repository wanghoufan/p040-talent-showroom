# US4 Android 分享 / PendingShare 真机验证（T051–T057）

设备：固定真机 `192.168.31.63:5555`（Redmi Note 11T Pro+ / `22041216UC` / `xagapro`）。
未使用另一台 USB Note12 Pro。APK：debug live 预览（`CAP_LIVE=1`，WebView 加载 `http://127.0.0.1:5173`，`/api` 由 Vite 代理到 8791）。

## 前置修复（本轮）

发现并修复两处真实缺陷：

1. **打包态无法连 API**：`capacitor.config.ts` 原先无 `server.url`，App 加载打包 dist（`https://localhost/`），而 `validateEndpoint` 在非 DEV 下拒绝回环地址 → 设备永远无法连本地 API。改为 `CAP_LIVE=1` 时 `server.url=http://127.0.0.1:5173`（走 adb reverse + Vite 代理），交付态仍为打包 dist。
2. **原生队列未交付 JS**：`ShareTargetPlugin` 用 `JSArray.from(...)` 序列化，Capacitor 侧丢失 `shares` 字段（`peek()` 返回 `{}`），导致原生 `drain()` 已清空队列但 JS 收到空数组。改为返回 JSON 字符串（`{json:"[]"}`），JS 侧 `JSON.parse`。
3. **warm start 不触发 drain**：App 已在前台时再次分享没有可见性变化事件。新增原生→JS 事件 `shareReceived`（`MainActivity.onNewIntent` → `ShareTargetPlugin.notifyListeners`），JS 订阅后 drain。
4. **MIUI 分享面板把文本放入 ClipData 而非 `EXTRA_TEXT`**：`PendingShareStore.capture` 增加 ClipData 回退提取（text 与 video 的 Uri 均覆盖）。

## 意图注册（T051）

```
$ adb shell cmd package query-activities -a android.intent.action.SEND -t text/plain
   -> com.wanghoufan.dancelibrary.dev  (命中)
$ adb shell cmd package query-activities -a android.intent.action.SEND -t video/mp4
   -> com.wanghoufan.dancelibrary.dev  (命中)
```
未注册 `*/*`；仅 `text/plain` 与 `video/*`。

## 四场景（T057）

所有分享经 MIUI 分享面板（`MiuiResolverActivity`）→ 点选“舞蹈曲库”，与真实用户操作一致。

| 场景 | 操作 | 结果 |
|---|---|---|
| A 在线（adapter 无取得能力） | 冷启动分享 `https://v.douyin.com/A1/` | `submitState=NEEDS_INPUT`，`serverJobId` 已建（服务端保留原链接，等补本地视频） |
| B 重复 intent | warm 再次分享同链接 | 队列长度仍为 1（token sha256 去重）；另 warm 分享新链接 `B2` 正常入队并 NEEDS_INPUT（证明 warm 事件生效） |
| C 离线 | 端点不可达时分享 `C3` | `OFFLINE_SAVED`（“离线，已保存待联网重试”）；恢复端点后重载触发 `submitAllPending` → 自动转 `NEEDS_INPUT` |
| D 来源不支持 | 分享 `https://example.com/v` | 服务端按 source-policy 拒绝 → `NEEDS_INPUT` + `lastError`，无 serverJobId |
| 附加 video/* | 分享 `video/mp4` + `file://.../dance.mp4` | 捕获 `streamUri` → `NEEDS_INPUT`（需补本地视频） |

device localStorage 原始记录（节选）：
```
A1:NEEDS_INPUT | B2:NEEDS_INPUT | C3:NEEDS_INPUT | example.com:NEEDS_INPUT
video/mp4:NEEDS_INPUT:file:///sdcard/Download/dance.mp4
```

## UI 三状态（T056）

曲库页顶部“来自分享”卡片，逐条显示：
- 在线处理 → “已提交，正在收录”（SUBMITTED，带“查看”）
- 离线保存 → “离线已保存，联网后自动重试”（OFFLINE_SAVED，带“重试”）
- 需补本地视频 → “需要补充本地视频”（NEEDS_INPUT，带“补充视频”跳 `/imports/:id`）

真机 `document.body.innerText` 实测含“来自分享\n4 条 / 需要补充本地视频 / 补充视频 / 移除”。

## 自动化

- `tests/unit/pending-shares.test.ts`：extractUrl 提取/去重/三状态映射（SUBMITTED / NEEDS_INPUT / OFFLINE_SAVED）。
- `tests/link-cover.test.mjs`：`POST /api/imports/link` 保留链接 + 补本地视频 + 人工封面。
- `tests/security.test.mjs`：source-policy 主机白名单 + SSRF 地址拒绝。

## 边界

- 当前 APK 为 live 预览（依赖 Mac 的 Vite/API）；正式签名与完整离线交付仍在 Human Gate 处理。
- 抖音链接按合规只保留链接并提示补本地视频，不做通用网页抓取（无 `canAcquire`）。
