# P040 真机 QA｜Redmi Note 11 5G｜1.1.7 (10)

- 日期：2026-10-31（Asia/Shanghai）
- 设备绑定：`codex-p040-qa` → Redmi Note 11 5G（USB）；未操作 note11tpro。
- 包：`android/app/build/outputs/apk/debug/app-debug.apk`；`com.wanghoufan.dancelibrary.dev`；aapt 实测 `versionName=1.1.7`、`versionCode=10`；14,087,245 bytes。
- 包内 `assets/public/index.html` SHA256 与 `dist/index.html` 一致：`ee7673aab01b49e74194cb8a280e405f18131abf314324506e1903ab593df14c`。APK 已覆盖安装，`MainActivity` 已前台启动；截图 `00-launch.png`。
- 数据边界：临时 API 18899 使用从 `var/vocal-v31-work/translation-20261031/db/qa.db` 复制出的 `var/qa-phone-20261031/db/qa.db` 与两首歌的隔离媒体副本；worker 关闭。生产库、源素材目录未读写。

## 实测结果

| 项目 | 结果 | 证据 |
|---|---|---|
| 安装、启动与首页 | PASS；前台为目标 dev 包 | `00-launch.png` |
| 本地服务连接与隔离库配对 | PASS；App 设置原 endpoint 从 `192.168.31.61:28794` 临时改到本轮 18899，测试后恢复原地址；未读取旧 token | `01-settings-before.png`；`02-connect-test.png`；`08-restored-endpoint.png` |
| 歌曲地图 | PASS；`사뿐사뿐` 显示 9 段 | `04-sabun-detail.png` |
| 地图跳转 | PASS；点副歌 0:40 后 `currentTime=40.46s`、`paused=true`，没有触发播放 | `05-map-jump.png`；CDP 观测 |
| 韩文 / 中文及长歌词显示 | PASS；`사뿐사뿐` 显示 91/91 句，页面有韩文原句及中文译文 | `04-sabun-detail.png`；DOM 观测 |
| 整段循环 | 未验收。误点后发现按钮会自动开始播放；约 11 秒内通过 WebView 将音频 muted 并 pause，最终观测 `paused=true`、`muted=true`、`currentTime=58.67s`。无法确认扬声器是否实际发声；不得报告静音通过 | `06-section-loop.png`、`07-paused-muted.png`；见下方事件说明 |
| 拆分 / 合并 | 未测；按后续安全要求停止进一步交互 | — |
| 正式库、生产数据、手机系统设置 | 未改；未播放其他音频 | — |

## 静音事件说明

测试开始时音频元素为 `paused=true`、`muted=false`、`volume=1`。地图跳转保持暂停。点击地图上的「整段循环」后，播放器自动播放；发现后立即停止后续触控，并通过 WebView 设置 `muted=true`、调用 `pause()`，实测恢复为暂停且静音。此行为说明整段循环会自动播放，当前静音约束下不能继续验证循环边界或重复回绕。

## 收尾与限制

- 原 App endpoint 已恢复为 `http://192.168.31.61:28794`。该端口进程持有本地隔离库 `var/vocal-v31-work/real-qa-20261030/db/qa.db`；未读取旧 token。用该隔离服务现有配对码通过 App 正常重新配对成功，配对码和新 token 均未写入证据。
- 本轮临时服务与克隆 DB 已停止、清理；本轮创建的 ADB reverse/forward 映射已清空；`codex-p040-qa` 绑定已 release。原 28794 隔离服务未停止。生产库 SHA256 仍为 `6c246314de6e3cd24587d5127a5091812700bde4a710fc322e280b2a8d32d0ca`，与 HANDOFF 记录一致。
- 正式 Android SOP 提及的 scan → deps → preflight → smoke 本项目未发现对应 CLI；本轮完成 APK 包名/版本检查、Web 资源哈希对比、隔离 API health/配对和真机定向操作，不等同全量预检或全量回归。

## 补测二｜无声结构编辑与长歌词（2026-10-31）

- 新建 `var/qa-phone-20261031-r2/` 测试克隆：数据来自歌词译文隔离库副本；只向克隆复制原隔离服务的 `owner_credentials` 行以复用现有 App token，未读取、改写或重新配对 token。媒体只复制 `사뿐사뿐` 原唱副本。该克隆仅提供临时 API。
- 进入唱歌详情前，在当前 WebView 注入临时保护：HTML media 的 `play()` 拒绝播放，`AudioContext.resume()` 被阻止；现存及新建媒体元素均强制 `muted=true`、`volume=0`。每次检查均观测 `paused=true`、`muted=true`、`volume=0`；未触发播放。结束时恢复 App endpoint，随后刷新 WebView 清除仅本页的保护。

| 项目 | 结果 | 证据 |
|---|---|---|
| 韩中长歌词 | PASS；`사뿐사뿐` 91/91 句，歌词容器 3,945 字符；滚到末尾可见第 88–91 句及对照文本 | `10-r2-sabun-long-bilingual.png`；`13-r2-long-lyrics-tail.png` |
| 按歌词句拆分 | PASS（未保存预览）；A1 从 4.0–12.4s 按 7.7s 歌词句拆为 A1 4.0–7.7s 与 A2 7.7–12.4s；段数由 9 增至 10，错误列表为空。未按“保存结构”，关闭编辑器后状态丢弃 | `11-r2-split-preview.png`；WebView DOM 观测 |
| 合并上一段 | 未测：拆分后 A2 在弹层上方，原始页面 `校准歌曲结构` 弹层实际高 1,138.8 CSS px，视口高 791 CSS px，运行时 `max-height=none`。A2 按钮边界 y=-224，触摸没有选中；当前选中仍是 A1，“与上一段合并”按钮 disabled。未用样式改动或脚本点击绕过可达性 | `12-r2-merge-blocked.png`；WebView DOM 观测 |
| 配对和地址恢复 | PASS；endpoint 恢复为 `http://192.168.31.61:28794`，连接测试成功；owner-token 仅确认仍存在，未读取值/未重新配对 | `14-r2-restored-endpoint.png` |

### 原隔离库只读核对

克隆前后 `var/vocal-v31-work/real-qa-20261030/db/qa.db` 与 `qa.db-wal` SHA256 一致，没有对原库表执行写语句。原库 `qa.db-shm` 哈希发生变化；这是 SQLite shared-memory 状态文件，测试前后原服务仍在运行，因此没有手工覆盖或删除。该文件差异已如实记录，不能宣称整个 DB 目录逐字节不变。

### 补测收尾

补测临时 API、克隆库与媒体副本已清理；补测 ADB forward 和设备临时截图已清理；App endpoint 已恢复，原有配对仍在；`codex-p040-qa` 随后释放。

原隔离库文件哈希核对值：`qa.db` 前后均为 `ae1e22614bf66f3780b1b7eca8eae22297d1860368db40598337089f14ce1c71`；`qa.db-wal` 前后均为 `6c5440eef67e9a999c54a3927fc9c0f9282910e23695ddcabf00e91bd2ce0857`；`qa.db-shm` 从 `9b78ad84c012e0f9ca3c4309fb44d2526dad39998012e1a5c3190c409ad74ecd` 变为 `07457ced15c023ce6abf13995faf48690ebe830786ceb1e6805adcc86e7696ae`。

## 补测三｜1.1.8 (11) 真机静音 QA（2026-10-31）

- APK：`android/app/build/outputs/apk/debug/app-debug.apk`；包 `com.wanghoufan.dancelibrary.dev`，实测 `versionName=1.1.8`、`versionCode=11`；SHA256 `fb8f4d3075d4f20bc81eb2d593bd6fc70721af9baafcef99cc5ece7fd20b6420`。包内 Web 资源与 `dist/index.html` 哈希一致。覆盖安装并启动 MainActivity，真机截图 `15-v118-launch.png`。
- 隔离：使用新克隆 `var/qa-phone-20261031-r4/` 和临时 API `18899`；歌词/结构测试及服务端写入仅发生在克隆。配对沿用克隆里的既有 credential 行，未读取 token 明文、未重新配对。
- 静音保护：进入歌曲详情前安装 WebView 保护，并在页面检查 `HTMLMediaElement.play` 被包装、`AudioContext.resume` 被阻断、所有媒体节点 `paused=true / muted=true / volume=0`。未触发播放或循环；结束时恢复页面原型并移除临时保护。

| 项目 | 结果 | 证据 |
|---|---|---|
| 安装、启动与长歌词入口 | PASS；`사뿐사뿐` 显示 `91/91` 句及韩文/中文；歌词列表可见中段韩文/中文内容（第 21–23 句） | `15-v118-launch.png`、`16-v118-detail-long-lyrics.png`、`24-v118-long-lyrics-mid.png` |
| 结构弹层滚动 | PASS；弹层实测 `max-height=696.32px`、内容 `scrollHeight=1139px`、实际滚动 `scrollTop=442.5px`；底部拆分/合并/保存控件可滚动到达 | `17-v118-modal-top.png`、`18-v118-modal-scrolled.png` |
| 按歌词句拆分 | PASS（预览）；A1 4.0–12.4s 按第 2 句 7.7s 拆成 4.0–7.7s 与 7.7–12.4s，段数增至 10 | `19-v118-merge-preview.png`（拆分过程见 CDP/真机交互记录） |
| 相邻合并 | PASS（预览）；A2 与上一段合并回 A1 4.0–12.4s，恢复 9 段地图 | `19-v118-merge-preview.png`、`22-v118-merged-before-save.png` |
| 草稿保存 / 旧结构恢复 | PASS（克隆）；分析生成 11 段草稿（3.273s），应用后地图变 11 段；“恢复旧结构（9 段）”成功，状态显示恢复 9 段。恢复后当前详情地图为 9 段；未刷新时重开校准弹层仍短暂显示 11 段，刷新后弹层显示 9 段，存在页面状态未同步现象 | `20-v118-structure-draft.png`、`21-v118-restore-modal-stale.png`；页面状态消息与克隆 revision 核对 |
| 拆分/合并后的手工保存 | FAIL；保存时报“段落超出歌曲总时长”。克隆音轨时长 219572ms，原末段终点 219600ms，超出 28ms；未改数据或阈值规避。保存失败，克隆段落未改变 | `23-v118-save-rejected-duration.png` |
| 整段循环 | 未测；本轮严格未触发音频交互，静音保护只用于确保导航与状态检查无声 | — |
| endpoint 与配对恢复 | PASS；恢复为原隔离地址 `http://192.168.31.61:28794`，连接测试成功；未读取或改动原 token | `25-v118-endpoint-restored.png` |

### 三补测收尾核对

- 原隔离数据库主文件、WAL、SHM 三项 SHA256 均与本轮克隆前记录完全一致；未对原库执行 SQL 写操作。
- 临时 API `18899` 已停止；克隆数据库和媒体目录已删除；ADB WebView forward `tcp:9225` 已移除；手机临时截图已从设备删除；`codex-p040-qa` 已 release。应用当前 endpoint 已恢复，原有配对状态未改。
- 本轮不构成全量回归；整段循环未验收。拆分/合并保存受到现有种子段末端比音轨时长多 28ms 的校验拦截，当前未验证修正数据后的保存结果。

## 补测四｜1.1.9 (12) 修复回归与静音循环（2026-10-31）

- APK：`android/app/build/outputs/apk/debug/app-debug.apk`，14,087,777 bytes；`aapt` 实测包 `com.wanghoufan.dancelibrary.dev`、`versionName=1.1.9`、`versionCode=12`；SHA256 `770b41b910daffb116b6d3d0fe6e220bf0f44ea1e78bc8539b1eac5ec322ae7c`。包内 `assets/public/index.html` 与 `dist/index.html` SHA256 均为 `f55715d79202bf8f2b1df37f8501ac05377c51bbb202333d903b86a9808a8f84`；APK 已覆盖安装、启动并截图。
- 隔离：临时 API 18899 使用 `var/qa-phone-20261031-r5/` 克隆；原唱文件为克隆媒体副本。为明确复测旧边界，先在**克隆**将末段 `endMs` 设为 219600ms（超过音轨 219572ms），未改原隔离库。克隆随收尾删除。
- 静音保护在任何页面触控前安装并验证：`HTMLMediaElement.play()` 先静音后调用，`muted` setter 强制 true，`volume` setter 强制 0，所有现存/新增 media 均暂停并静音；`AudioContext.resume()` 被阻断。另在暂停状态主动尝试写 `muted=false`、`volume=1`，回读仍为 `muted=true`、`volume=0`。源码中播放器使用 HTML media element；循环期间持续检查媒体状态。

| 项目 | 结果 | 证据 |
|---|---|---|
| 草稿应用→恢复→不刷新重开结构弹层 | PASS；应用 11 段草稿后恢复到旧 9 段；不刷新详情页立即重开弹层，弹层显示 A1–A5、共 9 段，与详情地图一致 | `27-v119-restore-modal-synced.png`；操作时 DOM/状态消息核对 |
| 按句拆分、相邻合并、保存旧 219600ms 尾段 | PASS；按 7.7s 句界拆分 A1，再合并回原边界并保存；克隆 DB 落库 9 段，末段 `endMs=219600`，revision=7，值未被裁剪 | `28-v119-split-merge-preview.png`、`29-v119-legacy-boundary-preview.png`；克隆 DB 查询 |
| 新增越界边界拒绝 | PASS；仅在克隆中把 A5 结束秒数编辑为 220.0s 后保存，UI 报“段落超出歌曲总时长”；保存被拒，克隆 DB 仍为 219600ms、revision=7 | `30-v119-new-overrun-rejected.png`；克隆 DB 查询 |
| 整段循环 | PASS（软件静音保护下）；A1 区间 4.0–12.4s。循环按钮首试被浏览器 autoplay 策略拦截；用户触控显式启动后 `paused=false / muted=true / volume=0`。播放时钟从 4.37s 到 12.19s，随后回到 7.79s，证明越过段尾后回绕；立即暂停并退出循环，最终 `paused=true / muted=true / volume=0`、时间约 4.33s。静音 setter 夹紧有效，未发声 | `31-v119-loop-silent-paused.png`；WebView 实时状态记录 |
| 地址恢复与清理 | PASS；endpoint 恢复为 `http://192.168.31.61:28794`，连接测试成功；未查看、修改或重配原凭据。18899 服务已停止、克隆已删除、ADB forward 已移除、手机临时截图已删除、设备锁已 release | `32-v119-endpoint-restored.png`；服务端口与文件清理核对 |

### 原隔离库完整性

本轮克隆前后原隔离库 `qa.db`、`qa.db-wal`、`qa.db-shm` SHA256 三项完全相同；所有人为构造的 219600ms 越界旧值和操作均仅在 r5 克隆中发生。未测试其他功能，未进行全量回归。


## P040 真机静音 QA｜1.1.10 (13)｜2026-10-31

- APK：`com.wanghoufan.dancelibrary.dev`，版本 `1.1.10` / versionCode `13`；已覆盖安装并启动，首页截图 `33-v110-launch.png`。
- 静音 guard：任何页面交互前注入，HTMLMediaElement `play` 包装器已生效、媒体元素均保持 `paused=true / muted=true / volume=0`，AudioContext.resume 被拦截。未触发音频播放或循环。
- 隔离边界：仅用无凭据克隆库；生产库、源素材、原隔离库和凭据未读取/改写。克隆服务无云翻译。

| 项目 | 结果 | 证据 |
|---|---|---|
| 安装、启动 | PASS；目标 debug 包前台运行 | `33-v110-launch.png` |
| 韩中练习默认显示、长歌词 | PASS；Sabun 克隆详情显示 `91/91`，第 3 行韩文及中文并列；歌词列表 scrollHeight 8238px | DOM 观测；本轮未保留独立详情截图 |
| 演出默认原文 | PASS；初始按钮 `显示中文（韩中）`、aria-pressed=false，91 行内容只有原文 | `36-v110-performance-original.png` |
| 演出双语切换 | PASS；点切换后按钮变 `隐藏中文（韩中）`、aria-pressed=true，91 个译文节点出现；媒体持续暂停且静音 | `35-v110-performance-bilingual.png`；WebView 状态 |
| 人工译文保护、制作人员过滤 | DEGRADED（隔离服务级）；BeBe 克隆本地 fake translator 验证结果 `NOTHING_TO_DO`、人工译文未变化、5 条制作人员行仍无译文且 translator 未被调用；未调用受凭据保护的 app endpoint，因此不是手机端翻译 UI 验收 | `37-v110-isolated-translation-service.json` |
| 整段循环/音频播放 | 未测；本轮安全要求不触发任何播放交互 | — |
| 原 endpoint 与清理 | PASS（本机状态恢复）；用此前保存的非凭据设置快照恢复 `dance.device-settings` 与 IndexedDB 元数据，确认 endpoint 不再是临时 18899；未读取 token、未做重新配对/连通性测试。18899 服务停止、克隆目录删除、ADB forward 移除、设备锁已释放 | CDP 只返回 endpoint restored 布尔值；清理命令输出 |

未做全量回归。静音保护只覆盖本次 WebView 媒体播放路径；由于未实际播放，不报告循环静音通过。


### 原连接只读复核（2026-10-31）

- 按 `devices → pin → status → resolve` 重新绑定并解析 Redmi Note 11 5G；结束后已 release。未触发音频、未改系统设置。
- 只读检查 `src/pages/SettingsPage.tsx` 的现有连接测试：GET `/api/health` 成功后会调用 `saveDeviceSettings(next)` 写入设备设置。因此按“不写状态”边界未点击该按钮，未做连接测试；仅确认先前恢复的 endpoint 不再指向临时端口。原连接当前可用性未验证。
- 未读取、输出或修改 token；未重新配对。


### 1.1.10 当前状态只读根因排查（2026-10-31）

- 设备锁：按 `devices → pin → status → resolve` 绑定 Redmi Note 11 5G；完成后移除本轮 ADB forward 并 release。确认安装版本 `1.1.10` / versionCode `13`。未触发播放、未改手机设置或应用配置。
- 静音残留：当前 WebView 仍有上轮 `__p040Guard`，且 `HTMLMediaElement.prototype.play` 仍为该 guard 包装器。唯一音频元素实测 `muted=true`、`volume=0`、`paused=true`、`readyState=4`、`error=null`、存在 src。src 含敏感查询参数，证据不保存、不披露其内容。当前静音可由残留 guard 直接解释；本轮没有播放以验证扬声器输出。
- 译文状态：当前曲目页面显示“翻译缺失 48 句”；本地 `dance.repertoire-snapshot` 对应 48 行歌词且 `translations` 文档缺失。页面提示后续 AI 翻译使用 CodeBuddy 云端模型。未触发翻译。
- endpoint：应用当前 endpoint 的 GET `/api/health` 返回 HTTP 200 / `ok=true`。只读直查曲目 GET 返回 401（未附加凭据）；按约束不读取 token，故不能据此检查服务器权威曲目记录。页面资源记录可见 `/api/repertoire` 与媒体请求，但 WebView 暴露的 resource status 为 0，不能当作成功/失败判据。
- 测试残留：`sessionStorage` 仍有 `__p040_state_backup`；本轮未读其值或删除。当前页面标题显示曲目详情，截图 `38-v110-current-state.png`。
- 结论：已证实本机残留静音 guard；已证实当前本地曲库快照无该曲目译文；endpoint 健康探测可达。未确认服务器权威译文是否存在，也未确认认证曲目请求状态。清除 guard 应在用户不需保持现状后通过重启应用进程完成；译文需由有权人员在不暴露凭据的前提下检查服务器侧记录，若重新请求 AI 翻译应先确认愿意将歌词发送到 CodeBuddy 云端。


### 静音 guard 清理与正常媒体状态复核（2026-10-31）

- 按设备锁重新绑定指定 Redmi Note 11 5G 后，对 debug App 执行 `am force-stop` 并通过包管理器解析出的正式 launcher 重新启动；未清 App 数据、未动 token、未改系统设置、未操作系统音量。最初一次 launcher 类名猜测失败但未启动任何组件，随后用只读 `resolve-activity` 找到真实 launcher 并成功启动。
- 新 WebView：`window.__p040Guard` 不存在；`HTMLMediaElement.prototype.play` 与 `AudioContext.prototype.resume` 均未含测试 wrapper 标记。当前媒体元素 `paused=true / muted=false / volume=1 / readyState=4 / error=null`。
- 对页面做一次普通 WebView reload 后复核同样状态：guard 未再出现，媒体仍暂停、未静音、音量属性为 1，媒体 readyState=4 且无 error。没有触发 `play()`，没有实际出声验证。
- 截图：`39-v110-after-app-restart.png`、`40-v110-restarted-webview.png`、`41-v110-post-reload.png`。本轮 ADB forward 已移除，profile 已 release。


### 隔离库补译后手机页面复核（2026-10-31）

- 使用应用现有 endpoint 的曲库页正常刷新流程：从歌曲详情返回唱歌曲库页，触发 `useRepertoire` 的 GET `/api/repertoire`，本地曲目快照更新；未改 endpoint、配对或凭据。列表页未显示连接错误，目标歌曲 IndexedDB 与 localStorage 快照均为 12 句/12 条 AI 译文。未执行可能下载大量媒体的离线全库下载流程。
- `여름 안에서 (Live)`：手机详情实际显示 12/12 中文，翻译栏为“隐藏中文（韩中）”，无“翻译缺失”按钮。首句在屏幕显示“언제나 꿈꿔 온 순간이”及“⼀直梦想着的瞬间”；第 2、3 句也显示中文。截图 `43-v110-summer-live-translated.png`。
- 英文歌 `Let Go`：详情实际显示 54/54 AI 译文，翻译栏“隐藏中文（英中）”，无缺失按钮。首句 `He used to be the center of your universe` 对应“他曾是你宇宙的中心”。截图 `44-v110-let-go-translated.png`。
- 安全状态：静音 guard 不存在；页面媒体保持 `paused=true / muted=false / volume=1` 且无 error；未触发播放。结束时应用留在 `여름 안에서 (Live)` 详情并保持现有连接和正常媒体属性。ADB forward 已移除，设备锁已 release。
