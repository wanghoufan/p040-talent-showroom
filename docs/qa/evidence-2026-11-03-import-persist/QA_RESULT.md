# 导入本地视频后重开 App 丢失｜修复与真机验证（2026-11-03）

## 一、用户现象

用户报告：导入视频 / 导入本地视频后，退出 App 再打开，视频就像丢了，只能重新导入。

## 二、根因（两层）

1. **收录任务没有在手机端留痕**：`ImportSheet` 上传成功后会跳到 `/imports/<jobId>` 确认页，但 jobId 只存在于当前页面路由。
   App 被杀掉或退出后重开，路由回到曲库，服务器上的 READY 任务没有任何入口，用户只能重新选文件。这是“视频丢失”的直接原因。
2. **手机指向的服务地址早已失效**：Note 12 Pro 上 `apiEndpoint = http://192.168.31.42:8791`，该地址已不可达（本机现为 `192.168.31.61`，8791 被其他项目占用）。
   这种情况下上传直接失败，用户会看到“收录未完成”，但重开 App 后同样没有任何可继续的入口，观感就是“视频丢了”。

## 三、修复

- 新增 `src/lib/pending-imports.ts`：上传成功后把 `{ jobId, name, createdAt }` 落到 localStorage（`dance.pending-imports.v1`，按 jobId 去重，最多 20 条）。
- 新增 `src/components/PendingImports.tsx`：曲库页顶部显示「未完成的收录」，提供「继续」（回到确认页）和「移除」。
- `ImportSheet`：文件/链接收录成功即记录；`ImportReviewPage`：保存成功、任务 FAILED 或服务器 404 时移除；分享补视频后同步分享条目状态，保存后移除，避免队列停在「需要补充本地视频」。
- `pending-shares.ts`：离线判定改为识别 `ApiError.status === 0`（原先只认 TypeError，实际 api 层已包装，离线状态一直映射成 NEEDS_INPUT）。

## 四、针对性测试（未跑全量回归）

- `npx tsc -b`：通过。
- `npx vitest run tests/unit/pending-imports.test.ts tests/unit/pending-shares.test.ts tests/unit/local-database.test.ts`：3 文件 20 项全通过。
- `npx vitest run tests/browser/repertoire.test.tsx tests/browser/bulk-edit.test.tsx`：2 文件 7 项全通过。

## 五、真机验证（Redmi Note 12 Pro / ruby / 22101316C）

版本：`1.1.18 (21)`（功能验证）→ `1.1.19 (22)`（样式回滚，功能代码同 1.1.18）。
服务：`http://192.168.31.61:28794`（p040-vocal-lan-28794，real-qa 库），已配对。

实测步骤与结果（CDP 驱动真实 WebView，不是静态检查）：

1. 曲库「＋ → 选择视频」注入 4 秒测试视频（480×270，h264+aac）。
2. 服务器处理为 READY，跳转 `/imports/0a09ca1a-315d-427a-b4bf-aa0b84cb5a67`，确认页显示 `p040-test`。
3. **force-stop 后重开 App**：曲库页出现「未完成的收录 / 1 条 / p040-test.mp4 / 视频已导入，等待确认保存 / 继续 / 移除」——修复前此处为空。
4. 点「继续」回到同一确认页，任务与视频仍在（服务器 job 持久化）。
5. 点「保存到我的舞蹈库」，进入 `/dances/f6deaff9-...`，标题 `p040-test`，片段 0–4s，`dance.pending-imports.v1` 变为 `[]`。
6. **再次 force-stop 后重开**：曲库卡片仍为 `p040-test 0:04`，未完成列表为空 —— 退出重进不再丢失。
7. 验证后删除该测试曲目（`DELETE /api/dances/<id>?media=1`，200），来源媒体目录已清空。

截图：`01-after-restart-item-kept.png`（第 6 步重开后仍在曲库）。

## 六、样式回滚（用户反馈“比较丑”）

`b62deb3`（1.1.17）在开发唱歌结构功能时顺带改了库卡片样式（封面文字 14px→20px、卡片内边距压紧、标签区高度 48→0、网格间距 10→8），与 1.1.16 已验收外观不一致。
本次只回滚这批卡片样式（`src/index.css` 9 处），不动功能与 `dvh` 兜底；版本 `1.1.19 (22)`，已装到 Note 12 Pro。

## 七、未完成 / 限制

- Note 12T Pro（`UKCESWB67PUO7LPB`）在安装过程中被拔线，未能推送；插回 USB 后执行 `adb -s UKCESWB67PUO7LPB install -r android/app/build/outputs/apk/debug/app-debug.apk` 即可。
- 本次未跑全量回归（按用户红线）。
- 真机只有 Note 12 Pro 一台复验；其他机型未测。
## 八、把舞蹈条目放回 Note 12 Pro（2026-11-03 续）

用户要求「舞蹈条目也要能在 12 Pro 上测试」。real-qa 库原本只有唱歌条目（32 首），舞蹈库在生产库 `var/personal-dance-library.db`（31 首可见 + 1 条已删）。
已把生产库的舞蹈相关数据并入 real-qa（先备份 `var/backups/merge-dance-20261103/qa-before.db`，SHA-256 `ded8074a…`）：

- 复制表：`song_identities`、`source_media`、`performance_clips`、`assets`、`dance_items`、`score_assets`、`score_links`、`program_items`、`tonight_playlist_items`、`demo_records`、`guest_requests`、`request_sessions`（`INSERT OR IGNORE`，ID 无冲突）。
- 复制引用媒体 107 个文件到 real-qa media 根，缺失 0。
- `catalog_version` 51；`PRAGMA foreign_key_check` 无返回。
- 真机复验（1.1.19）：曲库显示 31 首舞蹈（鲨鱼舞…等），唱歌仍 32 首。
