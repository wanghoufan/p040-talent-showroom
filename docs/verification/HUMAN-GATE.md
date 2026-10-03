# HUMAN GATE｜首次发布签收仍 OPEN

更新：2026-10-03（Asia/Shanghai）。实际分支：`main`。唯一当前快照为 [HANDOFF](../handoff/HANDOFF.md)；本文件保留发布边界与旧规格验收限制。

> 用户已要求接续开发且亲自完成，不派子智能体、不恢复编排链。T001–T095 已按当前证据勾选，T096 未勾；首次发布签收前不报全项目完工。正式签名、长期部署继续留 Human Gate；本轮用户明确授权统一 commit/push main。

## 1. 当前开发交付

- 实现`8fd92c9`、交付回执`ce94c22`已推送main。舞蹈、唱歌及公共功能完成本轮开发验证；吉他后续开发与数据修改冻结，等待用户新方案。
- 最终debug已覆盖安装固定note11tpro；包路径、大小、SHA256与统一交付目录以HANDOFF为准，不再保留旧候选包的“当前”校验值。debug为Android Debug签名，release仍为unsigned。
- 前端47项、后端43项及lint/build/Java21离线Gradle通过；前台产品覆盖与限制见 [完整化验收矩阵](completion-acceptance.md) 和 [最终续验证据](completion-round8.md)。真实31首、原62缓存、原节目单五首顺序保留；三类登记示例供试用，现67缓存（原62+示例5）。

- 当前包使用 `http://localhost` bundled 资源，`androidScheme:http` + `allowMixedContent:true`，无 `server.url`。
- 未配置或触碰正式 keystore；本轮用户已授权 commit/push main；未建立长期部署。

## 2. V1.5 历史真机证据

以下保留旧规格证据，不能作为最新包数量与功能范围的快照。

固定设备：USB `IN9LZTAYV4UGU4JF`，Redmi Note 11T Pro+，`22041216UC` / `xagapro`；另一台 Note12 Pro 未使用。

- **首页播放反馈**：点 ▶ 后当前卡片蓝框/蓝色标题、按钮变 ⏸；底部固定播放条显示曲名、暂停、时间与进度。点击同一卡片暂停，时间停止、按钮恢复 ▶；滚动后播放条仍在底栏上方。见 `ui-visual-qa.md`、`screens/library-play-enhanced-playing.png` 与 `screens/library-play-enhanced-paused.png`。
- **T064 物理断网**：飞行模式开启 + Wi-Fi 关闭，系统无默认网络；force-stop → cold start，1 次真实屏幕点击播放；十首不同缓存曲目逐首断言曲名/本地文件/currentTime/无错误全部通过。网络开关已恢复原状态。见 `android-offline.md`、`offline-playback-round4.json`。
- 覆盖安装保留 31 条曲库、62 条缓存索引；无卸载/清数据。
- **出声**：用户本轮明确反馈“是有声音”；此前音频路由卡死已在交接中闭环。最终试听/现场演出签收仍由用户完成。
- 原视频、安全删除、分享、今晚歌单、主题/系统栏、媒体真源等前序证据沿用 `device-verify-round3.md`、`us1–us5`、`tonight-playlist.md`、`media-truth.md`。

## 3. V1.5 历史自动化与 Docker

- lint、tsc/build、Vitest 7 文件/14 用例、node:test 24 用例全部通过；localhost 测试沙箱 EPERM 后在允许监听环境复跑成功。
- Java 21、Gradle 8.14.3、缓存离线 assembleDebug/assembleRelease 均成功。release 保持 unsigned。
- **T089**：用户授权重启 Docker Desktop，daemon 恢复；独立 `p040-v15-qa` + 专用 QA 数据卷 + 回环 8792 完成 build/run/health/页面/合成视频导入/Range/重建持久化/rollback。QA 容器与合成测试卷已清理，8792 已关闭，P038 healthy。见 `docker.md`、`docker-round4.json`。
- 当时Dockerfile加入npm cache、国内镜像优先/官方回退，包完整性校验未改；旧依赖审计计数仅属当时结果，本次洁癖未重新进行依赖安全审计。

## 4. 已知验证边界

1. **SC-001 PARTIAL**：空库到首条 UI 的 ≤5 次操作尚未逐步计数；实际 UI 流程、真实导入与自动化已有证据。
2. **SC-004 PARTIAL**：物理断网冷启动与10首播放已闭环；“31首均想学”是旧测试时条件，当前真实分类以HANDOFF为准，禁止按旧快照回写；旧规格指定前置验收状态仍保留。
3. **SC-010 PARTIAL**：ended 仅停止、不自动连播已有代码与单次观测；演出模式 20 次自然结束计数尚未执行。
4. **T015 历史边界**：Foundation 当时用无线 ADB live 预览，未按字面做 USB live reload；本轮 USB bundled 真机复验已完成。
5. 识曲使用 disabled/mock，无真实 key；不能把核心流程通过解释为真实识曲 provider 已验收。

## 5. 仍保留的 Human Gate

|事项|状态|需要决定的内容|
|---|---|---|
|旧T096 / 首次发布签收|OPEN|用户实际试用、试听并明确签收；不能由开发或构建通过代签|
|正式签名|OPEN|正式密钥与发布渠道，不擅自生成或替换用户密钥|
|长期部署|OPEN|部署位置、端口、备份与维护方式|
|公网点歌|OPEN|公开服务、域名与访问范围；现有二维码依赖同网API可达|

Git commit/push main、debug打包安装已获授权，不再列为待批准事项。当前API仅是开发服务；Docker历史隔离验证不等于长期部署。真实识曲provider仍未接入，不能将disabled/mock视为真实服务验收。

## 无声反馈复发说明（最终归因更正）

用户已确认接线投屏时声音到 Mac、拔线后手机正常。根因是 scrcpy 默认音频转发会禁止手机本地播放；本轮将当前投屏会话改为 `--no-audio` 后，USB 仍连接，STREAM_MUSIC 与 AudioFlinger 均回到扬声器，REMOTE_SUBMIX 采集输出消失。未改 App 或重启手机。以后重开投屏需保留此参数；此前“必须重启的路由卡死”归因证据不足，详见 audio-diagnosis.txt 最后章节。


## 2026-10-03 完整化之前的合并回执（历史）

当时封面/双语README与批量分类合并并覆盖安装固定真机；验证见`bulk-classification.md` / `bulk-edit-round5.json`。当时保存分类依赖API，003完整化后手机可离线保存再同步。当前连接、真实数据与包证据统一以HANDOFF为准；此处不作为当前版本说明。

提交回执：`4b936e1`（封面/README）、`804b4b8`（批量分类/验证）已推送 main；最终 debug APK 已重新打包、覆盖安装固定 note11tpro，并在 Finder 展示。`/api/health` 返回200/ok，隔离8793示范进程与测试数据已清理。
