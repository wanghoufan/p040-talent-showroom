# HANDOFF｜个人舞蹈曲库 V1.5（P040 才艺展示厅）

更新时间：2026-10-03（Asia/Shanghai），接续复验 6（吉他 / 唱歌 V2 最小版本 + 全部下载）。本文件是恢复开发的唯一当前快照，取代此前所有过时交接。

> 开发状态：**用户已授权持续推进到吉他/唱歌，V2 最小可用版本已实现、自动化及固定真机静音验证、APK 已覆盖安装。V1.5 剩余验收按用户“先继续开发”指令暂缓，T096 保持 OPEN；正式签名/长期部署/首次发布签收仍属 Human Gate。亲自开发，不恢复编排；commit/push main 已获授权。**

## 0. 项目一句话

个人舞蹈曲库：家里 Mac 收歌/同步，手机带出去纯离线演出（无网可冷启动播放）。SDD V1.1：`specs/001-personal-dance-library/{plan,spec,tasks,data-model}.md` + `contracts/openapi.yaml`。技术栈 React 19 + TS + Vite 7 + Capacitor 8（Android）+ Node 24 本地 API + SQLite(node:sqlite)。WebView 用 HTML5 `<audio>` 播放；交付态为 bundled（`server.androidScheme:'http'` + `allowMixedContent:true`，无 server.url）。

## 1. 当前工作进展

- **最新无声反馈已定位为 scrcpy 音频转发**：用户确认接线投屏声音到 Mac、拔线手机正常。当前 scrcpy 会话已加 `--no-audio`，接线状态下 `STREAM_MUSIC Devices: speaker(2)`，AudioFlinger 无 REMOTE_SUBMIX 采集输出；未重启手机、未改应用代码。此前“路由卡死必须重启”的归因证据不足，以 audio-diagnosis.txt 最后章节为准。未来投屏必须继续用 `scrcpy -s IN9LZTAYV4UGU4JF --no-audio --stay-awake`；只改当前会话，未改全局默认。

- **实现面**：T001–T095 全部实现；基线 96 项仅 T096 未勾；批量分类增量 T097–T099 已验证。
  - 曲库/筛选/卡片快速播放、收录（文件/链接 NEEDS_INPUT/桌面 drop/人工封面/候选识曲）、导入确认、详情、原视频、主题与私有 endpoint 设置、Android 分享（cold/warm ACTION_SEND + PendingShare）、真实离线缓存（T058–T063 真机通过）、今晚歌单 + 演出模式（T073–T078 真机通过）、安全删除（T071 通过）、备份恢复、缓存管理均已落地。
- **证据面**（`docs/verification/`）：`traceability.md`（T094，FR-001~028 全 PASS；SC-001/004/010 PARTIAL，其余 PASS，无 GAP）、`ui-visual-qa.md`（T083/SC-008）、`docker.md`（T089 隔离实测通过）、`android-preflight.md`（T014/SC-009）、`HUMAN-GATE.md`（T095）、`audio-diagnosis.txt`（本轮更新）、`device-verify-round3.md`、`us1–us5`、`tonight-playlist.md`、`automated.md`。
- **自动化面**：`lint` 0 / `tsc` 0 / `Vitest` 10 文件 26 用例 / `node:test` 27 用例 / `vite build` 全绿。
- **真机修复**：T083 系统栏/导航栏跟随主题（`ThemeBarsPlugin` 补 `FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS`）已修并验证；T072 原视频、T071 安全删除真机通过。
- **APK（bundled，交付态）**：`android/app/build/outputs/apk/debug/app-debug.apk`，**11,305,168 bytes**，SHA-256 `5757d93d7f0b326f5ab8389c505cd43f7cc2daba2078c4beaa7702e23f390391`（debug 签名，证书 SHA-256 `8e82a7975008e8ec87ff0f2ecadf495b5263effa34aaec9ab6f135ebea911cf3`）。release unsigned：8,567,746 bytes，SHA-256 `3fa185bb3bee32e81f10372c9d55b1b15ca631767ed8f51dfcf093546a5d2f24`。
- **本轮新增（首页播放体验增强，已真机复验）**：
  - `src/pages/LibraryPage.tsx`：`paused` 状态 + 播放/暂停切换；mini-player 改为播放时加 `onPlay/onPause/onEnded` 同步。
  - `src/components/DanceCard.tsx`：接收 `isCurrent/paused`，当前曲目卡片高亮、按钮 ▶↔⏸。
  - `src/index.css`：`.mini-player` 改**底部悬浮固定条**（`position:fixed; bottom:calc(72px+safe-area)`，坐在底栏之上），新增 `.mini-player__title`、`.dance-card--active`、`.quick-play--active`；`.app-main` 底部 padding 100→170px 防遮挡。
  - 状态：**已重建 bundled debug APK 并覆盖安装固定 USB 真机。原生触摸：播放条出现、当前卡片高亮、按钮 ▶↔⏸、暂停时间停止、滚动后播放条固定、十首切换反馈全部通过。截图与结果已写 ui-visual-qa.md / offline-playback-round4.json。**

## 2. 关键约束（恢复前必读）

- **亲自完成**：本窗口/接续智能体亲自负责全部开发、测试、交付，**不作为编排者、不派角色或子智能体**；不恢复旧 ORCA 派工链。
- **固定真机**：note11tpro，model `22041216UC`，marketname `Redmi Note 11T Pro+`，device `xagapro`。
  - 重启后经 **USB 接入，serial `IN9LZTAYV4UGU4JF`**；此前无线 `192.168.31.63:5555` 重启后已 `Connection refused`（无线调试未自动恢复）。恢复时先 `adb devices` 确认用哪个连。
  - USB 设备 `indq5xfi6hovay4d`（22101316C）是 Note12 Pro，**禁止替代固定真机**。
- **正式签名 / 长期部署**：留 Human Gate，除用户明确指令外不自作主张。2026-10-03 用户明确授权把封面/README 与批量分类分两提交，push main 并打包 APK。
- 中文沟通；不重复问已授权的普通实现问题；不碰 secrets / 正式 keystore / 不提交 env·key·token·真实素材·数据库。
- `.gitignore` 已覆盖 `var/`、`导入素材/`、`按作品分割_MP3/`、`temp/`、`android/local.properties`、`.DS_Store` 等。

## 3. 下一步任务（按优先级）

- 本轮 V2 最小开发范围已完成，详见第 7 节及 `specs/002-guitar-vocal/`。用户要求暂缓旧验收、全程不播放可听声音；勿主动恢复声音或继续旧验收。
- 后续产品范围为混合才艺歌单/演出、图片/PDF谱、公开点歌台，尚未实现；不得混称为 V2 最小版本已含。
- 正式签名/长期部署/首次发布签收保持 Human Gate，不自动跨越。以下是 V1.5 历史任务状态。

1. **首页播放增强真机复验已完成**：bundled debug 覆盖安装；播放/暂停/切歌/悬浮条与卡片反馈均通过，见 `ui-visual-qa.md`。
2. **T064 物理断网冷启动已完成**：固定 USB 真机，飞行模式 1、Wi-Fi 0、无默认网络；kill app → cold start → 1 次点击播放 → 10 首逐曲断言通过，网络已恢复。详见 `android-offline.md`。当轮 SC-004 的“会跳”指定前置未满足（当时真实 31 首均想学；用户后续已改为会跳，旧验收暂缓），不擅改真实分类，矩阵继续 PARTIAL。
3. **T089 Docker 已完成**：用户批准重启 Docker Desktop 后 daemon 29.7.2 恢复；`p040-v15-qa` 隔离项目 + 专用测试卷，build、health/页面/合成视频导入/Range/重建持久化/rollback 全 PASS。QA 容器与合成测试卷已清理，8792 无监听，P038 healthy；见 `docker.md`。不长期部署。
4. **批量分类 + 封面/README 合并已完成验证**：首页批量勾选/筛选全选、三种学习状态、四标签增删替换、事务回滚、失败保留选择、手机离线元数据更新均通过；最终合并 APK 已覆盖安装。证据 `bulk-edit-round5.json` / `bulk-classification.md`。
5. **T096 Human Gate**：待用户一次性验收（试听确认出声 / 正式签名 / 长期部署 Docker / 物理断网现场验收）。首次发布需用户签收。

## 4. 恢复环境（快速上手）

- 启动：`npm run dev`（Vite 5173）、`npm run server:dev`（API 8791）。先查端口避免冲突：`lsof -nP -iTCP:5173 -sTCP:LISTEN`、`:8791`；不擅自杀其他服务。健康检查 `http://127.0.0.1:8791/api/health`。
- 构建：`npm run build` → `npx cap sync android`。
- APK 构建（本项目 Capacitor 8 需 **Java 21**，勿用旧 Java17 文档）：
  `JAVA_HOME="$HOME/android-toolchain/jdk-21.0.12.1+1/Contents/Home" ANDROID_HOME="$HOME/android-toolchain/sdk" ./android/gradlew -p android :app:assembleDebug --offline`
- ADB：所有动作显式指定当前设备 serial；需要时 `adb reverse tcp:5173` / `tcp:8791`；CDP 调试 `node scripts/android-cdp.mjs targets|eval "<expr>"|tap <sel>|drag <sel> <dy>`（注意带子命令；脚本无 timeout，长异步表达式会挂，建议先补 timeout）。
- 沙箱内 adb / gradle 缓存锁 / localhost 调试可能被拦，按实际失败申请权限，不冒充成功。

## 5. 注意事项与相关规矩

- 附加文档（AGENTS.md 等治理原文）与用户本次「亲自开发、固定设备」专门指令并存：治理原文不擅改，用户专门指令优先。
- 按需读 `docs/sop/`（docker/sqlite/android/webqa/decision-router），不扫全部中央规则。
- 安装依赖优先复用兼容缓存，需下载时先国内镜像后官方源，保持版本与 integrity，不盲目 `audit --force`（现存 5 个 moderate 开发依赖问题待审，不得写「零漏洞」）。
- 无真实识曲密钥用 disabled/mock，不编造识别结果。
- 保留原始媒体；清缓存只删可重下客户端缓存；主数据/来源视频删除走二次确认与引用检查。
- `tasks.md` 复选框**按证据逐项勾**，不批量勾选；未验证不得写完成。
- **红线**：P0 未闭环不得报完工；产品验收未落盘或关键 AC 未测不得报完工；首次发布未签收不得报完工。

目标：完成吉他 / 唱歌最小版本与全部音乐下载。
剩 P0：本轮新功能无已知 P0；V1.5 未完成验收保持原状态，首次发布未签收。
下一步：本轮增量交付后，后续产品扩展另立范围；Human Gate 保留，睡眠期间保持静音。


## 6. 2026-10-03 上一轮增量交付（封面 / 批量分类）

- 批量入口：曲库首页→批量管理→点卡片或全选当前结果→修改分类→确认；添加标签保留原分类，替换空集合明确显示清空。选择模式暂时暂停当前播放。
- 服务端新增 `PATCH /api/dances/bulk`，分类事务原子写入，固定状态和标签，不改媒体/歌名/识曲。手机更新本地快照与已有离线元数据，保留音乐缓存。
- 封面/README 并行改动已合并：首页/详情/确认页使用 CoverArt 渐变+水印+舞名，浅深主题；批量卡片逻辑完整保留。
- 本地开发 API 正在 `0.0.0.0:8791`；本机当前 LAN 地址 `192.168.31.42`，手机旧 `.43` 地址已更新。手机保存分类需要能连接该 API；缓存音频仍可带出去断网播放。开发进程不是长期部署。
- 隔离真机 QA 用 8793/临时 SQLite 三首示范，未调用真实曲库分类写接口。测试结束恢复元数据与缓存；之后交互使用中真实 31 首变为会跳、首首加户外，保留用户现状，不用旧备份覆盖。
- T089 证据为前一轮 Docker 隔离构建；本轮检查 daemon 未运行，不启动其他服务，不冒充新合并镜像已复验。当前增量经本地 API/最终 APK 验证。
- Git：封面/README 提交 `4b936e1`，批量分类与最新验证记录提交 `804b4b8`；两笔已推送 `origin/main`，工作区验证无业务未提交改动。APK debug 与 unsigned release 已重建，正式签名/长期部署/首次发布签收仍待 Human Gate。

## 7. 2026-10-03 V2 最小版本增量交付（当前）

- 独立增量基线：`specs/002-guitar-vocal/{plan,data-model,tasks}.md` 与 `contracts.yaml`。用户明确扩展到吉他/唱歌，公开点歌台不在本轮；旧 V1.5 计划不重写。
- 曲库顶部舞蹈/吉他/唱歌，底部四入口保留。吉他保存文本谱、原调/演奏调、Capo；唱歌保存歌词、原调/演唱调、伴奏或示范用途。两类支持搜索、学习状态、创建/编辑、二次确认删除、自己的音频/视频导入、播放反馈、循环与速度。调性/Capo 不改变音高，谱只接受文本。
- 新增 `0003_repertoire.sql` 和 `/api/repertoire` CRUD、`/:id/media` 导入关联；manifest 增加 repertoire。创建/编辑/导入依赖 API，离线可看已有谱/歌词和播放下载音频；纯文本不计入音乐数。现有今晚歌单/演出仍仅舞蹈。
- “我的”→下载全部音乐到手机：三类音频和附属封面，真实文件检查、进度/失败名单、当前文件结束后停止、已完成文件保留、重试仅补缺失、并发下载锁。原视频不批量缓存。
- 证据：`docs/verification/guitar-vocal.md`、`v2-round6.json`、`screens/v2-*.png`。固定 note11tpro 原生 SAF 导入数字静音 WAV，两类实际播放时间前进、卡片高亮/暂停、循环、1.25×、2/2 下载、故障 1/2→补一首、物理断网冷启动本地媒体、失败编辑保留与删除取消全部 PASS。只验证静音播放链路，未做听感签收。
- 自动化：lint 0、Vitest 10 文件 26 用例、node:test 27 用例、tsc/Vite 与 Java 21 离线 Gradle debug/unsigned release 构建通过。
- 最新 debug APK：11,305,168 bytes，SHA-256 `5757d93d7f0b326f5ab8389c505cd43f7cc2daba2078c4beaa7702e23f390391`；已覆盖安装。Unsigned release：8,567,746 bytes，SHA-256 `3fa185bb3bee32e81f10372c9d55b1b15ca631767ed8f51dfcf093546a5d2f24`。第 1 节 APK 信息已同步为当前产物。
- 真实数据：升级前一致性备份 `var/backups/pre-v2-1790959822719.sqlite`；迁移后 31 首 DanceItem 逐字段与升级前相同，真实才艺记录 0。QA 只用 8793 临时库，结束后清理；手机恢复原 8791 地址、62 个缓存索引与真实分类，只删 2 个 QA 缓存和示范 WAV，Wi-Fi 恢复、飞行模式关闭。媒体音量保持 0，用户自行恢复。
- 本机真实 API 8791 继续运行开发服务（不是长期部署），无新增识曲密钥/云服务/依赖；正式签名/长期部署/首次发布签收仍待 Human Gate。第 1、6 节中的运行会话和统计属历史记录，以本节当前结果为准。
