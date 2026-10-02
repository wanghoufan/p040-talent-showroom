# HUMAN GATE（T095 / T096 待用户验收）

日期：2026-10-03（Asia/Shanghai）　实际分支：`main`　规格基线：`specs/001-personal-dance-library`（V1.1）。

> 用户已要求接续开发且亲自完成，不派子智能体、不恢复编排链。T001–T095 已按当前证据勾选，T096 未勾；首次发布签收前不报全项目完工。正式签名、长期部署继续留 Human Gate；本轮用户明确授权统一 commit/push main。

## 1. 当前交付物

| 产物 | 路径 | 大小 | SHA-256 | 签名 |
|---|---|---|---|---|
| bundled debug（已覆盖安装固定真机） | `android/app/build/outputs/apk/debug/app-debug.apk` | 11,298,913 bytes | `23509e04e9ee47e4f403235598c74b9641fbb36d04fa89cbb140e1831ef74f3b` | Android Debug，证书 SHA-256 `8e82a7975008e8ec87ff0f2ecadf495b5263effa34aaec9ab6f135ebea911cf3` |
| release（仅可构建性证明） | `android/app/build/outputs/apk/release/app-release-unsigned.apk` | 8,562,394 bytes | `a24efe8aa53b3fe487b8a8323d6c4a470776b9579a47804344a2e04bab539467` | unsigned，apksigner 提示 Missing META-INF/MANIFEST.MF |

- 当前包使用 `http://localhost` bundled 资源，`androidScheme:http` + `allowMixedContent:true`，无 `server.url`。
- 未配置或触碰正式 keystore；本轮用户已授权 commit/push main；未建立长期部署。

## 2. 本轮真机结果

固定设备：USB `IN9LZTAYV4UGU4JF`，Redmi Note 11T Pro+，`22041216UC` / `xagapro`；另一台 Note12 Pro 未使用。

- **首页播放反馈**：点 ▶ 后当前卡片蓝框/蓝色标题、按钮变 ⏸；底部固定播放条显示曲名、暂停、时间与进度。点击同一卡片暂停，时间停止、按钮恢复 ▶；滚动后播放条仍在底栏上方。见 `ui-visual-qa.md`、`screens/library-play-enhanced-playing.png` 与 `screens/library-play-enhanced-paused.png`。
- **T064 物理断网**：飞行模式开启 + Wi-Fi 关闭，系统无默认网络；force-stop → cold start，1 次真实屏幕点击播放；十首不同缓存曲目逐首断言曲名/本地文件/currentTime/无错误全部通过。网络开关已恢复原状态。见 `android-offline.md`、`offline-playback-round4.json`。
- 覆盖安装保留 31 条曲库、62 条缓存索引；无卸载/清数据。
- **出声**：用户本轮明确反馈“是有声音”；此前音频路由卡死已在交接中闭环。最终试听/现场演出签收仍由用户完成。
- 原视频、安全删除、分享、今晚歌单、主题/系统栏、媒体真源等前序证据沿用 `device-verify-round3.md`、`us1–us5`、`tonight-playlist.md`、`media-truth.md`。

## 3. 自动化与 Docker

- lint、tsc/build、Vitest 7 文件/14 用例、node:test 24 用例全部通过；localhost 测试沙箱 EPERM 后在允许监听环境复跑成功。
- Java 21、Gradle 8.14.3、缓存离线 assembleDebug/assembleRelease 均成功。release 保持 unsigned。
- **T089**：用户授权重启 Docker Desktop，daemon 恢复；独立 `p040-v15-qa` + 专用 QA 数据卷 + 回环 8792 完成 build/run/health/页面/合成视频导入/Range/重建持久化/rollback。QA 容器与合成测试卷已清理，8792 已关闭，P038 healthy。见 `docker.md`、`docker-round4.json`。
- Dockerfile 加入 npm cache、国内镜像优先/官方回退；锁文件与包完整性校验未改。没有升级项目依赖；仍报告 5 个 moderate 开发依赖问题。

## 4. 已知验证边界

1. **SC-001 PARTIAL**：空库到首条 UI 的 ≤5 次操作尚未逐步计数；实际 UI 流程、真实导入与自动化已有证据。
2. **SC-004 PARTIAL**：物理断网冷启动与 10 首播放已闭环；真实 31 首都标“想学”，未擅改真实分类，“已缓存会跳”指定前置尚未按字面验证。
3. **SC-010 PARTIAL**：ended 仅停止、不自动连播已有代码与单次观测；演出模式 20 次自然结束计数尚未执行。
4. **T015 历史边界**：Foundation 当时用无线 ADB live 预览，未按字面做 USB live reload；本轮 USB bundled 真机复验已完成。
5. 识曲使用 disabled/mock，无真实 key；不能把核心流程通过解释为真实识曲 provider 已验收。

## 5. 【请你决策】

验收手机上的播放、暂停、切歌反馈与实际试听；确认是否签收本次候选版本。Git commit/push main 已获本轮明确授权；正式签名、长期 Docker 部署、真实识曲 provider 是否启用，分别由你明确决定。

## 【说明】

当前手机已安装可离线运行的 bundled debug 候选版本，Docker 只做隔离验证并已回滚。正式部署路径、生产端口/备份与 keystore 尚未配置；此前授权含 Docker Desktop 重启和隔离验证，本轮另明确授权 commit/push main 和 APK 重打；正式签名或长期部署未获授权。

## 无声反馈复发说明（最终归因更正）

用户已确认接线投屏时声音到 Mac、拔线后手机正常。根因是 scrcpy 默认音频转发会禁止手机本地播放；本轮将当前投屏会话改为 `--no-audio` 后，USB 仍连接，STREAM_MUSIC 与 AudioFlinger 均回到扬声器，REMOTE_SUBMIX 采集输出消失。未改 App 或重启手机。以后重开投屏需保留此参数；此前“必须重启的路由卡死”归因证据不足，详见 audio-diagnosis.txt 最后章节。


## 2026-10-03 当前合并候选

封面/双语 README 与批量分类均已保留、合并，debug 覆盖安装固定真机；批量三状态、标签增删替换、筛选全选、断连保留、最终包浅深主题/详情封面/播放均已验证。见 `bulk-classification.md` / `bulk-edit-round5.json`。保存分类需要访问本地 API，当前开发服务地址 `http://192.168.31.42:8791`；手机 endpoint 已更新，未建立长期部署。手机已有31首与缓存保留，隔离QA未写真实分类。当前真实分类由后续交互使用改变为会跳，前述“均想学”为此前T064测试时的历史条件。Git操作已获用户明确授权；正式签名、首次发布用户签收和长期部署仍待 Human Gate。

提交回执：`4b936e1`（封面/README）、`804b4b8`（批量分类/验证）已推送 main；最终 debug APK 已重新打包、覆盖安装固定 note11tpro，并在 Finder 展示。`/api/health` 返回200/ok，隔离8793示范进程与测试数据已清理。
