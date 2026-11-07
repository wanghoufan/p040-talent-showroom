# 翻译 UI 真机全流程 + 409 身份不匹配｜P040 1.1.16 (19)

日期：2026-10-31（Asia/Shanghai）
设备：Redmi Note 11 5G（`21091116AC`/evergo，USB，序列号已按设备锁 `status → resolve → adb -s` 使用）
视口：393×791 CSS px（DPR 2.75，WebView 1080×2174 @ y=96）
APK：debug `371a6336…`，versionCode 19 / versionName 1.1.16，装机 11:14:38
服务：`p040-vocal-lan-28794`（pid 5164）**未重启、未改配置**；App 端点 `http://192.168.31.61:28794`，`/api/health` 200
数据：隔离 real-qa 库 `var/vocal-v31-work/real-qa-20261030/db/qa.db`；测试前备份 `var/backups/real-qa-20261031-pre-translation-ui-qa/`
本轮**未跑全量回归、未出声、未改正式结构/生产库/源 MP3-LRC、未 commit/push**。

## 一、范围

补 HANDOFF 两项 P0：

1. **翻译 UI 手机端全流程**：双语切换、缺失句批量翻译、逐句人工纠错与保存后持久化。
2. **409 实测 + 文件选择器**：同名不同歌手参考文件被整份拒绝、不落草稿、正式结构不变；WebView `<input type=file>` 能否拉起系统选择器。

## 二、翻译 UI 真机（全部为真机真实触摸，读数取自页面 DOM）

选择《덤더럼 (Dumhdurum)》（44 行、44/44 已译，来源「人工 / LRC / AI 混合」）。

| # | 操作 | 真机读数 | 判定 |
|---|---|---|---|
| 1 | 打开非沉浸详情页 | 译文条 `隐藏中文（韩中）`、`44/44 句 · 人工 / LRC / AI 混合`；译文行 `44` 个 | 通过 |
| 2 | 点双语开关（关） | 按钮文案变 `显示中文（韩中）`、`aria-pressed=false`；译文行 `44 → 0`；原文行仍 44 | 通过 |
| 3 | 再点开关（开） | 恢复 44 个译文节点 | 通过 |
| 4 | 点第 1 句「纠错」 | 编辑器出现，`textarea` 预填 `Hey 这感觉有点太奇怪了`，标签「第 1 句中文译文」 | 通过 |
| 5 | 改文案并保存 | 真实 adb 触摸「保存」后编辑器关闭，第 1 句显示 `QA手机纠错-这感觉太奇怪了`；库内该行 `source=manual`、`sourceHash` 未变（原文未动） | 通过 |
| 6 | 恢复原文再保存 | 真实 adb 触摸「保存」（键盘弹起状态，单次点击）后编辑器关闭，第 1 句回到 `Hey 这感觉有点太奇怪了` | 通过 |
| 7 | 缺失句批量翻译 | 数据库临时移除 1 行译文 → 译文条出现 `翻译缺失 1 句`；点按钮 → 提示 `已翻译 0 句（另复用缓存 1 句）。`；随后 `44/44`、按钮消失 | 通过（走缓存通道，未新调模型） |

- 第 5/6 步核对：测试后该曲 `translations_json` 与备份文件 **逐字节一致**（`restored identical: true`）。
- 术语口径：练习页默认双语、可切原文；译文只写 `translations_json`，按行 `id` 绑定，`lyrics_json` 未被改。

## 三、409 身份不匹配（真实客户端 + 真实服务）

目标曲目：Let Go（石玺彤，54 行，原唱 206206ms，原曲 SHA `a4cae482…`）。
参考文件：同名 `Let Go`、歌手写 `BTS`、时长与 SHA 与本地一致，其余合法（`schema=p040.structure-reference.v1`）。

| 项 | 结果 |
|---|---|
| 富余身份：歌名/时长/原曲 SHA | 与本地一致，仅歌手不一致 |
| 界面结果 | `参考文件没载入：参考结构核验不通过：歌手/歌名/版本/时长/原音频摘要与本地不一致，已拒绝载入（artist: 参考=BTS / 本地=石玺彤）`（`role=alert`） |
| 参考候选面板 | 未出现（`refPanel=false`），输入框被清空（label 回到「载入参考文件」） |
| 草稿表 `vocal_structure_drafts` | 与备份相同，**无 Let Go 草稿**（仅原有 Papillon 一条 `DRAFT`） |
| 正式结构 `sections_json` | 与备份 **逐字节相同**（2149 字节） |

## 四、WebView 文件选择器

- 真机点「载入参考文件」后，前台切到系统选择器：`com.google.android.documentsui/...PickerActivity`，截图 `07-native-file-picker.png`。
- 说明：`<input type="file" accept=".json,application/json">` 在 Capacitor WebView **能拉起原生选择器**，不是无响应。
- **未完成**：在 MIUI「选择文件」(`com.android.fileexplorer`) 里用 `adb input tap` 选中文件后，`确定` 节点 `bounds=[0,0][0,0]`，无法用 adb 完成确认；因此第三节的 409 是把同一份 JSON 以 `File` 对象注入该 input（`dispatchEvent('change')`），走的是**同一条** `loadReferenceFile → 服务端核验 → 界面报错` 路径。
- 结论口径：「选择器能打开」已验证；「用户手动点选并确认的最后一跳」仍属**未实测**，不写成通过。

## 五、数据边界与恢复

- 备份：`sqlite3 .backup` → `var/backups/real-qa-20261031-pre-translation-ui-qa/qa.db`（`integrity_check=ok`）；另存该曲原始 `translations_json` → 同目录 `dumhdurum-translations.json`。
- 临时改动：删除《덤더럼》第 3 行译文（原 `source=ai`），用于让「翻译缺失 1 句」按钮出现。
- 恢复：按备份 JSON 原样写回该曲 `translations_json`；31 行曲目的 `translations_json` 与备份**逐行比对 0 处差异**；`integrity_check=ok`。
- 未改：`sections_json`、媒体文件、源 MP3/LRC、生产库、服务进程。

## 六、未做 / 未过

1. 出声听辨、扬声器听感（无采集，不代报）。
2. 系统文件选择器的手动确认跳（见 §四）。
3. 真实调用模型的批量翻译：本轮缺行命中缓存，未产生新的通道调用；通道级真实翻译仍以 5 首 292 行的历史证据为准。
4. 沉浸页「更多 → 歌词与译文」入口的逐句纠错未单独走一遍（组件测试已覆盖，真机未点）。
5. 全量回归（用户明确禁止）。

## 七、探测口径（本轮踩到，后续沿用）

- **CDP `Input.dispatchTouchEvent` 在软键盘弹起时点按钮会被吞**：第一次点「保存」只收起键盘、不触发保存（编辑器仍在）；改用 `adb shell input tap` 单次即成功。**键盘弹起时的点击一律走 adb**。
- **抽屉内被遮挡/滚动元素用 CDP tap 不可靠**（`<summary>` 展开无效），改用 `adb shell input tap` 并先 `scrollIntoView`、按 `CSS×2.75 + 96` 换算屏幕坐标。
- **adb push 的文件要先触发媒体扫描**：未扫描时系统选择器显示 `0 B`、点击无反应；`am broadcast MEDIA_SCANNER_SCAN_FILE` 后变为 435 B 才正常列出。
- 页面 `location.assign` 深链后 CDP target 的 `title` 会变成 URL，按标题过滤的探针会找不到页面；按 `url.startsWith('http://localhost')` 匹配更稳。