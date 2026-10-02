# HANDOFF｜个人舞蹈曲库 V1.5（P040 才艺展示厅）

更新时间：2026-10-03（Asia/Shanghai），接续复验 5（批量分类 + 渐变封面合并）。本文件是恢复开发的唯一当前快照，取代此前所有过时交接。

> 开发状态：**用户已要求恢复，亲自开发/测试中，不是完工。首页播放反馈与 T064 物理断网复验已通过；T089 隔离 Docker 构建/运行/持久化/回滚已通过，等待 Human Gate，正式签名/长期部署/首次发布签收仍属 Human Gate；本轮用户已明确授权 commit/push main。**

## 0. 项目一句话

个人舞蹈曲库：家里 Mac 收歌/同步，手机带出去纯离线演出（无网可冷启动播放）。SDD V1.1：`specs/001-personal-dance-library/{plan,spec,tasks,data-model}.md` + `contracts/openapi.yaml`。技术栈 React 19 + TS + Vite 7 + Capacitor 8（Android）+ Node 24 本地 API + SQLite(node:sqlite)。WebView 用 HTML5 `<audio>` 播放；交付态为 bundled（`server.androidScheme:'http'` + `allowMixedContent:true`，无 server.url）。

## 1. 当前工作进展

- **最新无声反馈已定位为 scrcpy 音频转发**：用户确认接线投屏声音到 Mac、拔线手机正常。当前 scrcpy 会话已加 `--no-audio`，接线状态下 `STREAM_MUSIC Devices: speaker(2)`，AudioFlinger 无 REMOTE_SUBMIX 采集输出；未重启手机、未改应用代码。此前“路由卡死必须重启”的归因证据不足，以 audio-diagnosis.txt 最后章节为准。未来投屏必须继续用 `scrcpy -s IN9LZTAYV4UGU4JF --no-audio --stay-awake`；只改当前会话，未改全局默认。

- **实现面**：T001–T095 全部实现；基线 96 项仅 T096 未勾；批量分类增量 T097–T099 已验证。
  - 曲库/筛选/卡片快速播放、收录（文件/链接 NEEDS_INPUT/桌面 drop/人工封面/候选识曲）、导入确认、详情、原视频、主题与私有 endpoint 设置、Android 分享（cold/warm ACTION_SEND + PendingShare）、真实离线缓存（T058–T063 真机通过）、今晚歌单 + 演出模式（T073–T078 真机通过）、安全删除（T071 通过）、备份恢复、缓存管理均已落地。
- **证据面**（`docs/verification/`）：`traceability.md`（T094，FR-001~028 全 PASS；SC-001/004/010 PARTIAL，其余 PASS，无 GAP）、`ui-visual-qa.md`（T083/SC-008）、`docker.md`（T089 隔离实测通过）、`android-preflight.md`（T014/SC-009）、`HUMAN-GATE.md`（T095）、`audio-diagnosis.txt`（本轮更新）、`device-verify-round3.md`、`us1–us5`、`tonight-playlist.md`、`automated.md`。
- **自动化面**：`lint` 0 / `tsc` 0 / `Vitest` 7 文件 14 用例 / `node:test` 24 用例 / `vite build` 全绿。
- **真机修复**：T083 系统栏/导航栏跟随主题（`ThemeBarsPlugin` 补 `FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS`）已修并验证；T072 原视频、T071 安全删除真机通过。
- **APK（bundled，交付态）**：`android/app/build/outputs/apk/debug/app-debug.apk`，**11,298,913 bytes**，SHA-256 `23509e04e9ee47e4f403235598c74b9641fbb36d04fa89cbb140e1831ef74f3b`（debug 签名，证书 SHA-256 `8e82a7975008e8ec87ff0f2ecadf495b5263effa34aaec9ab6f135ebea911cf3`）。release unsigned：8,562,394 bytes，SHA-256 `a24efe8aa53b3fe487b8a8323d6c4a470776b9579a47804344a2e04bab539467`。
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

1. **首页播放增强真机复验已完成**：bundled debug 覆盖安装；播放/暂停/切歌/悬浮条与卡片反馈均通过，见 `ui-visual-qa.md`。
2. **T064 物理断网冷启动已完成**：固定 USB 真机，飞行模式 1、Wi-Fi 0、无默认网络；kill app → cold start → 1 次点击播放 → 10 首逐曲断言通过，网络已恢复。详见 `android-offline.md`。SC-004 的“会跳”指定前置未满足（真实 31 首均想学），不擅改真实分类，矩阵继续 PARTIAL。
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

目标：完成 V1.5 验证后进入 T096 Human Gate 用户验收。
剩 P0：本次无声已定位为投屏音频转发，当前会话已禁用并验证扬声器路由；首页播放反馈/T064/T089 已闭环。首次发布未签收，不报完工。
下一步：T096 Human Gate 用户验收；后续真机 QA 投屏必须带 --no-audio，正式签名/长期部署仍待明确授权；commit/push main 已获本轮用户授权。


## 6. 2026-10-03 当前增量交付

- 批量入口：曲库首页→批量管理→点卡片或全选当前结果→修改分类→确认；添加标签保留原分类，替换空集合明确显示清空。选择模式暂时暂停当前播放。
- 服务端新增 `PATCH /api/dances/bulk`，分类事务原子写入，固定状态和标签，不改媒体/歌名/识曲。手机更新本地快照与已有离线元数据，保留音乐缓存。
- 封面/README 并行改动已合并：首页/详情/确认页使用 CoverArt 渐变+水印+舞名，浅深主题；批量卡片逻辑完整保留。
- 本地开发 API 正在 `0.0.0.0:8791`；本机当前 LAN 地址 `192.168.31.42`，手机旧 `.43` 地址已更新。手机保存分类需要能连接该 API；缓存音频仍可带出去断网播放。开发进程不是长期部署。
- 隔离真机 QA 用 8793/临时 SQLite 三首示范，未调用真实曲库分类写接口。测试结束恢复元数据与缓存；之后交互使用中真实 31 首变为会跳、首首加户外，保留用户现状，不用旧备份覆盖。
- T089 证据为前一轮 Docker 隔离构建；本轮检查 daemon 未运行，不启动其他服务，不冒充新合并镜像已复验。当前增量经本地 API/最终 APK 验证。
- Git：封面/README 提交 `4b936e1`，批量分类与最新验证记录为下一提交；用户已授权 push main。APK debug 与 unsigned release 已重建，正式签名/长期部署/首次发布签收仍待 Human Gate。
