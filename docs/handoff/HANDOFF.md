# HANDOFF｜个人舞蹈曲库 V1.5（P040 才艺展示厅）

更新时间：2026-10-02（Asia/Shanghai），大交接 2。本文件是恢复开发的唯一当前快照，取代此前所有过时交接。

> 开发状态：**用户已明确「开发先到这里暂时结束」→ 暂停中，不是完工，未到 Human Gate。** 恢复后请先读本文件，再按第 3 节继续。

## 0. 项目一句话

个人舞蹈曲库：家里 Mac 收歌/同步，手机带出去纯离线演出（无网可冷启动播放）。SDD V1.1：`specs/001-personal-dance-library/{plan,spec,tasks,data-model}.md` + `contracts/openapi.yaml`。技术栈 React 19 + TS + Vite 7 + Capacitor 8（Android）+ Node 24 本地 API + SQLite(node:sqlite)。WebView 用 HTML5 `<audio>` 播放；交付态为 bundled（`server.androidScheme:'http'` + `allowMixedContent:true`，无 server.url）。

## 1. 当前工作进展

- **实现面**：T001–T095 全部实现；`tasks.md` 共 96 项，**仅 T064 / T089 / T096 未勾**。
  - 曲库/筛选/卡片快速播放、收录（文件/链接 NEEDS_INPUT/桌面 drop/人工封面/候选识曲）、导入确认、详情、原视频、主题与私有 endpoint 设置、Android 分享（cold/warm ACTION_SEND + PendingShare）、真实离线缓存（T058–T063 真机通过）、今晚歌单 + 演出模式（T073–T078 真机通过）、安全删除（T071 通过）、备份恢复、缓存管理均已落地。
- **证据面**（`docs/verification/`）：`traceability.md`（T094，FR-001~028 全 PASS；SC-001/004/010 PARTIAL，其余 PASS，无 GAP）、`ui-visual-qa.md`（T083/SC-008）、`docker.md`（T089 仅静态）、`android-preflight.md`（T014/SC-009）、`HUMAN-GATE.md`（T095）、`audio-diagnosis.txt`（本轮更新）、`device-verify-round3.md`、`us1–us5`、`tonight-playlist.md`、`automated.md`。
- **自动化面**：`lint` 0 / `tsc` 0 / `Vitest` 6 文件 11 用例 / `node:test` 20 用例 / `vite build` 全绿。
- **真机修复**：T083 系统栏/导航栏跟随主题（`ThemeBarsPlugin` 补 `FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS`）已修并验证；T072 原视频、T071 安全删除真机通过。
- **APK（bundled，交付态）**：`android/app/build/outputs/apk/debug/app-debug.apk`，**11,297,027 bytes**，SHA-256 `682b7255015aabbfa1c97e6aba6cda9bcdc3c162d48df6608274cf83beb4bfce`（debug 签名，证书 SHA-256 `8e82a7975008e8ec87ff0f2ecadf495b5263effa34aaec9ab6f135ebea911cf3`）。release unsigned：8,560,222 bytes，SHA-256 `af3ddb7220f703897ada7183eda2994a7dd5fe4e4f5b56dbc43cc1fc389121ec`。
- **「播放没有声音」已闭环**：定位为**设备侧音频路由卡死**（真机 `dumpsys media.audio_flinger` 实证：媒体输出轨被钉在 `REMOTE_SUBMIX` 虚拟采集设备，物理扬声器收不到），**重启 note11tpro 后输出轨回到 `AUDIO_DEVICE_OUT_SPEAKER`，声音恢复**；App 播放链路本就正常（`currentTime` 前进 / `error=null`），**代码无缺陷、无需改动**。详见 `docs/verification/audio-diagnosis.txt`。
- **本轮新增（首页播放体验增强，未真机复验）**：
  - `src/pages/LibraryPage.tsx`：`paused` 状态 + 播放/暂停切换；mini-player 改为播放时加 `onPlay/onPause/onEnded` 同步。
  - `src/components/DanceCard.tsx`：接收 `isCurrent/paused`，当前曲目卡片高亮、按钮 ▶↔⏸。
  - `src/index.css`：`.mini-player` 改**底部悬浮固定条**（`position:fixed; bottom:calc(72px+safe-area)`，坐在底栏之上），新增 `.mini-player__title`、`.dance-card--active`、`.quick-play--active`；`.app-main` 底部 padding 100→170px 防遮挡。
  - 状态：**已改代码 + lint/tsc/Vitest/build 全绿；尚未重建 APK、未真机复验。**

## 2. 关键约束（恢复前必读）

- **亲自完成**：本窗口/接续智能体亲自负责全部开发、测试、交付，**不作为编排者、不派角色或子智能体**；不恢复旧 ORCA 派工链。
- **固定真机**：note11tpro，model `22041216UC`，marketname `Redmi Note 11T Pro+`，device `xagapro`。
  - 重启后经 **USB 接入，serial `IN9LZTAYV4UGU4JF`**；此前无线 `192.168.31.63:5555` 重启后已 `Connection refused`（无线调试未自动恢复）。恢复时先 `adb devices` 确认用哪个连。
  - USB 设备 `indq5xfi6hovay4d`（22101316C）是 Note12 Pro，**禁止替代固定真机**。
- **正式签名 / commit·push / 长期部署**：留 Human Gate，除用户明确指令外不自作主张。
- 中文沟通；不重复问已授权的普通实现问题；不碰 secrets / 正式 keystore / 不提交 env·key·token·真实素材·数据库。
- `.gitignore` 已覆盖 `var/`、`导入素材/`、`按作品分割_MP3/`、`temp/`、`android/local.properties`、`.DS_Store` 等。

## 3. 下一步任务（按优先级）

1. **真机复验首页播放增强**（本轮未验）：重建 bundled debug APK → `adb install -r` → 点首页 ▶ 应见**底部悬浮播放条**（含暂停键/进度）+ 当前卡片高亮 + 按钮变 ⏸；点 ⏸ 暂停；截图留证并补进 `ui-visual-qa.md`。
2. **T064 物理断网冷启动**：kill app → cold start → ≤3 操作播放 → 10 条手动切歌，记录 `android-offline.md`。现固定机可 USB 接入，具备现场条件时执行。
3. **T089 Docker**：Docker daemon 曾无响应，仅做 `docker compose config --quiet` 静态校验（exit 0）。daemon 可用后补 isolated build/run（独立端口，不影响 P038）并记录 health/rollback。**勿擅自重启 Docker**。
4. **T096 Human Gate**：待用户一次性验收（试听确认出声 / 正式签名 / 长期部署 Docker / 物理断网现场验收）。首次发布需用户签收。

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
剩 P0：①首页播放增强真机复验（本轮未验）；②T064 物理断网冷启动（待现场）。「播放没有声音」已闭环（设备侧，重启解决）。
下一步：等用户指示恢复；恢复后先做第 3 节第 1 项。
