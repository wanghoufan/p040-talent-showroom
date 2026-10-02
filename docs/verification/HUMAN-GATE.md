# HUMAN GATE（T095 / T096 待用户验收）

日期：2026-10-02（Asia/Shanghai）　分支：`codex/personal-dance-library`　基线：`specs/001-personal-dance-library`（V1.1）

> 本文件是「开发者停止改动、把成果一次性交给用户验收」的门。以下为已完成项、已安装真机结果、已知非阻断限制，以及**需要用户决策**的动作（正式签名 / commit+push / 长期部署）。用户签收前不视为「首次发布」完工。

## 1. 交付物（安装包）

| 产物 | 路径 | 大小 | SHA-256 | 签名 |
|---|---|---|---|---|
| debug（bundled 交付态，已装真机） | `android/app/build/outputs/apk/debug/app-debug.apk` | 11,297,027 bytes | `682b7255015aabbfa1c97e6aba6cda9bcdc3c162d48df6608274cf83beb4bfce` | Android Debug（证书 SHA-256 `8e82a7975008e8ec87ff0f2ecadf495b5263effa34aaec9ab6f135ebea911cf3`） |
| release（仅可构建性证明，**unsigned**） | `android/app/build/outputs/apk/release/app-release-unsigned.apk` | 8,560,222 bytes | `af3ddb7220f703897ada7183eda2994a7dd5fe4e4f5b56dbc43cc1fc389121ec` | 无（unsigned，未配置正式 keystore） |

- debug APK 为 **bundled 交付态**：打包 dist，WebView 源 `http://localhost`（`androidScheme:http` + `allowMixedContent:true`），**不含** `server.url`（非 live 预览）。
- 正式签名：**未做**（不碰正式 keystore）。长期部署：**未做**。

## 2. 真机实测结果（固定真机 192.168.31.63:5555 / Redmi Note 11T Pro+ / 22041216UC / xagapro / Android 14）

- 曲库渲染 **31 张卡片**、封面/时长/状态/四标签/底栏四 Tab 正常（`bundled-build.txt`、`screens/bundled-play-*.png`）。
- 快速播放：`audio.paused=false`、`currentTime` 前进、`error=null`（`bundled-build.txt`）。
- 覆盖升级保留数据（T092）：31 曲库 + 62 离线文件（31 audio + 31 img，无 `.tmp`）+ 主题设置保留（`device-verify-round3.md`）。
- 系统栏跟随主题（T083）：深色 `(6,11,18)` / 浅色 `(246,248,251)`（`theme-*-bars.png`）。
- 详情→查看原视频一击播放（T072）；安全软删除/可恢复（T071）（`device-verify-round3.md`）。
- 离线冷启动（T064，**停后端近似断网**）：冷启动渲染 31 卡、快速播放 10 条 `local=true`/`err=null`（`android-offline.md`）。
- Android 分享四场景（T051–T057）：在线 NEEDS_INPUT / 重复 intent 去重 / 离线 OFFLINE_SAVED 自动重试 / 来源不支持拒绝（`us4-share.md`）。
- 今晚歌单（T073–T078）：10 首、真实触摸拖动排序、准备离线演出 10/10、删文件后 readiness 失效、演出“下一首只选中不发声”（`tonight-playlist.md`）。
- 媒体真源（T042/SC-002）：12/12 样本 clip 起止/速度/音调一致、原媒体 SHA 未变、stream-copy（`media-truth.md`）。
- 自动化（T090）：`lint` 0 / `typecheck` 0 / Vitest 6 文件 11 用例 / `node:test` 20 用例 / `vite build` / `assembleDebug` / `assembleRelease`（unsigned）全通过（`automated.md`）。
- FR/SC 追溯矩阵（T094）：FR-001～028 全 PASS；SC-001～010 中 7 PASS、3 PARTIAL（`traceability.md`）。

## 3. 已知非阻断限制（如实标注）

1. **「播放没有声音」**：诊断为**设备侧**（媒体音量 0 + MIUI 录屏占用 `remote_submix` 音频路由），App 链路正常（`volume=1/muted=false/currentTime` 前进/`requestAudioFocus` 成功，`error=null`）。**需用户关闭 MIUI 录屏、确认媒体音量后复听确认实际出声**（`audio-diagnosis.txt`）。此项未由开发者判通过。
2. **T064 物理断网**：本机仅网络 ADB，飞行模式会断 adb 通道，故以「停掉后端」近似「完全断网」；冷启动/切歌已实测，物理断网与现场演出留待交付后确认。
3. **SC-001 逐步计数**：真实 31 条为 API 批量导入（`import-first-batch.mjs`），未在空库上用 UI 逐步计数「空库→首条」的操作次数；UI 全流程已实现并有截图。
4. **SC-010 20 次重复计数**：行为由代码不变量保证（全仓无任何 `ended→下一首` 代码路径；`PerformancePage.tsx:87`、`LibraryPage.tsx:17` 的 `onEnded` 仅停止/隐藏），并有单次观测；未脚本化 20 次逐次计数（真机 WebView 长异步 eval 卡住）。
5. **T089 Docker isolated build/run**：`docker compose config` 静态校验通过；daemon 未响应（socket 无响应），**未执行** isolated build/run，未擅自重启 Docker Desktop。静态配置与端口/volume/只读媒体边界已核查（`docker.md`）。
6. **T015 USB live reload**：固定真机仅网络 ADB，改用网络 ADB live 预览；USB 设备为 Note12 Pro（禁用）。如实标注（`traceability.md`）。
7. **识别服务**：无真实 key，使用 disabled/mock provider；无 key 下全部核心功能可用。`npm audit` 仍有 **5 个 moderate** 开发依赖问题，**不称「零漏洞」**。
8. **T064/无声音为 P0 未完项**：按红线，用户签收前不报「完工」。

## 4. 待用户决策的动作（Human Gate）

1. **试听确认「实际出声」**：关闭 MIUI 录屏 → 提高媒体音量 → 打开已安装 App 播放，确认有声。确认后 SC-004 与「无声音」项方可记通过。
2. **正式签名**：是否配置正式 keystore 生成可发布签名包？（当前仅 debug 签名；不擅自创建/修改正式 keystore。）
3. **commit + push(main)**：本轮文档与源码变更是否提交并推送到 `main`？（用户此前已授权持续 commit+push(main)；本文件生成后按授权执行。）
4. **长期部署**：是否部署 Docker 长期服务（daemon 就绪后 isolated build/run → 回环 `8792`）？是否接入真实识曲 provider？
5. **物理断网现场验收**：是否在真正断网场景（带出门）做一次离线演出确认？

## 5. 环境与复现

- 后端：Mac `HOST=0.0.0.0 PORT=8791 node server/index.mjs`（LAN `192.168.31.43:8791`）。
- 构建：`npm run build && npx cap sync android` → `JAVA_HOME=$HOME/android-toolchain/jdk-21.0.12.1+1/Contents/Home ANDROID_HOME=$HOME/android-toolchain/sdk ./android/gradlew -p android :app:assembleDebug --offline`。
- 安装：`adb -s 192.168.31.63:5555 install -r <apk>`。
