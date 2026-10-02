---
description: "个人舞蹈曲库 V1.5 implementation task list"
---

# Tasks: 个人舞蹈曲库 V1.5

**Input**: `constitution.md`, `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/openapi.yaml`, approved UI assets.  
**Tests**: 本规格明确要求 TDD/自动化、媒体、安全、真机测试，因此测试任务为必选。  
**Execution rule**: 独立开发者按编号连续推进；Phase checkpoint 自检，不向用户询问 ordinary implementation questions；所有 task 完成后才进入 Human Gate。

## Format
`- [ ] T001 [P?] [US?] Description with exact paths`

## Phase 1: SDD / Asset / Repository Setup

- [x] T001 在目标新项目目录建立独立 Git 工作树/仓库骨架，不得覆盖 P038；如本机 Project Steward 能自动分配正式项目 ID 则使用它，不能自动分配时不得编造 P 号，先以 slug `personal-dance-library` 开发并记录到 Human Gate；写入本包 `.specify/`、`specs/`、`reference/`、`assets/`。
- [x] T002 读取 `specs/001-personal-dance-library/research.md` 并在 `docs/verification/official-baseline.md` 记录实际安装的 Node/Capacitor/JDK/SDK/adb 版本；不得擅自升级共享 SDK。
- [x] T003 核对 P038 当前 Project Reader worktree 落后/缺源码事实，自动定位 `origin/main` fresh clone 或已记录最新源码副本；输出 `docs/migration/p038-shell-reuse.md`，只列可复用 UI/Range 思路与来源 revision。
- [x] T004 [P] 验证包内 `reference/ui/prototype-dark-approved.png`、`prototype-light-approved.png`、`launch-screen-preview-dark.png` 均存在并生成 sha256 manifest，开发时直接作为视觉 SSOT。
- [x] T005 [P] 验证包内 `assets/app-icon-master.png`、`splash.png`、`splash-dark.png`；安装 `@capacitor/assets` 并验证 icon ≥1024²、splash ≥2732²。
- [x] T006 复核包内 `docs/ui/ui-contract.md` 与 SPEC/approved prototypes：底部四 Tab、3 状态、4 标签、收录流程、详情“查看原视频”、light/dark tokens、原型文字不作为 copy source。

**Gate**: SDD/asset SSOT 完整，P038 原项目未被修改。

## Phase 2: Foundation + Android Early Prebuild

- [x] T007 初始化 React 19 + TypeScript + Vite 7 + Vitest/ESLint，建立 `src/app/App.tsx`、`src/app/routes.tsx`、`src/app/theme.ts`。
- [x] T008 [P] 初始化 Node 22 本地 API，建立 `server/index.mjs`、health route、统一 JSON error envelope 与测试入口。
- [x] T009 [P] 初始化 SQLite schema/migration runner，按 `data-model.md` 建表/枚举约束与 migration tests。
- [x] T010 [P] 建立媒体目录配置与 `.env.example`、`.gitignore`、Docker ignore；真实媒体/db/key 不进 Git/image。
- [x] T011 初始化 Capacitor 8 stable Android，`minSdk=24 compileSdk=36 targetSdk=36`，提交完整 Gradle Wrapper；debug 使用 `applicationIdSuffix '.dev'`。
- [x] T012 用 `@capacitor/assets` 从包内 approved master 生成 Android icon/splash；检查 adaptive icon 安全区、monochrome、Android 12+ SplashScreen，不增加假 Splash Activity。
- [x] T013 实现基础 light/dark CSS tokens、safe-area/system-bars；所有基础交互组件 touch target ≥48dp。
- [x] T014 执行 Android machine preflight：`java -version`、`ANDROID_HOME`、`adb version`、`adb devices -l`，结果写 `docs/verification/android-preflight.md`。
- [x] T015 配置 ADB USB live reload：Vite 5173 + API 8791 localhost，`adb reverse` 两端口，`npx cap run android --live-reload` 在已连接真机显示空壳。
- [x] T016 **Early APK prebuild**：`npm run build && npx cap sync android && ./android/gradlew :app:assembleDebug`；记录 `app-debug.apk` 路径/大小/debug 签名。
- [x] T017 用 `adb install -r` 安装 debug APK，不卸载已有正式 app；记录 `pm path` 与启动 smoke screenshot。
- [x] T018 [P] 建立 `Dockerfile`/`compose.yaml` 但不正式部署；静态校验端口/volume/只读媒体边界。

**Gate**: 手机可实时预览；debug APK 已真实生成并安装；Web/API/Android shell 均可启动。

## Phase 3: Shared Data / Security Prerequisites

- [x] T019 [P] 在 `src/lib/types.ts` 定义 DanceItem/SourceMedia/PerformanceClip/SongIdentity/ImportJob/PendingShare/Playlist/OfflineManifest/DeviceSettings。
- [x] T020 [P] 在 `server/security/paths.mjs` 写 controlled-root canonicalization；测试 `..`、symlink escape、中文/空格/Emoji。
- [x] T021 [P] 在 `server/security/source-policy.mjs` 写 SourceAdapter registry、scheme/host/redirect/DNS 后 IP 校验；测试 SSRF/loopback/link-local/private 探测。
- [x] T022 在 `server/media/ffmpeg.mjs` 封装 ffprobe/extract/transcode/frame，参数数组化禁止 shell 拼接；fixture test。
- [x] T023 [P] 在 `server/recognition/provider.mjs` 建接口 + disabled/mock provider；无 key 服务必须健康。
- [x] T024 [P] 实现 `src/lib/device-settings.ts`：themeMode/apiEndpoint/lastSyncAt；生产 API endpoint 仅允许可信私有 LAN/`.local`，dev 允许 adb reverse loopback。
- [x] T025 实现 `GET /api/health` 与 app connection check，不泄露 path/key/db 信息。

## Phase 4: User Story 1 - 首次收录 (P1)

- [x] T026 [P] [US1] 先写空库/收录入口组件测试：`LibraryPage` 必须显示“+ 收录舞蹈”且无登录门槛。
- [x] T027 [P] [US1] 实现 `src/pages/LibraryPage.tsx` 空库和顶部/左侧固定框架，匹配 approved light/dark layout。
- [x] T028 [P] [US1] 实现 `src/components/ImportSheet.tsx`：清楚解释“收录舞蹈”，Android 三入口 + desktop file/drop。
- [x] T029 [US1] 实现 `server/import/local-file-adapter.mjs`、`manual-audio-adapter.mjs` 和 `source-adapter.mjs`。
- [x] T030 [US1] 实现 `server/import/import-service.mjs` 状态机 `ACQUIRE→PROBE→EXTRACT→RECOGNIZE→COVER→REVIEW`。
- [x] T031 [US1] 实现 `POST /api/imports/file` 大文件 streaming、size/MIME/ffprobe 校验与 `GET /api/imports/:id`。
- [x] T032 [P] [US1] 实现 `ImportProgress.tsx` 用户语言进度，禁止显示内部命令/provider stack。
- [x] T033 [US1] 实现 cover fallback：provider 可用 cover → 来源视频取帧 → app placeholder。
- [x] T034 [P] [US1] 实现 `ImportReviewPage.tsx`：试听、歌曲候选、原视频入口、默认想学、四标签、保存。
- [x] T035 [US1] 实现 finalize API/transaction，provider off/cover fail 时照样创建 DanceItem。
- [x] T036 [US1] 跑 local-file/provider-off E2E + Android 真机 smoke，截图保存到 `docs/verification/screens/us1-*`。

## Phase 5: User Story 2 - 来源音频真源 (P1)

- [x] T037 [P] [US2] 先写媒体真源 tests：SongIdentity 更新不得改变 PerformanceClip hash；裁剪不修改 SourceMedia。
- [x] T038 [US2] 实现 `server/media/clips.mjs`：首选 stream-copy，目标不兼容时一次 AAC compatibility transcode。
- [x] T039 [P] [US2] 实现 `ClipTrimmer.tsx`，仅 start/end、试听、恢复完整音频。
- [x] T040 [US2] finalize 保存 start/end 与派生 clip mapping，不覆盖原媒体。
- [x] T041 [P] [US2] 实现 `scripts/verify-media.mjs` 检查 duration/codec/hash/source mapping。
- [x] T042 [US2] 建 ≥10 条 fixture/样本回归并输出 `docs/verification/media-truth.md`。

## Phase 6: User Story 3 - 曲库/筛选/卡片播放 (P1)

- [x] T043 [P] [US3] 先写 `filters.test.ts` 覆盖状态 exact + scene subset AND 的全部组合。
- [x] T044 [P] [US3] 实现 `LearningStatusRail.tsx`：会跳/正在练/想学，单选可取消。
- [x] T045 [P] [US3] 实现 `SceneTagBar.tsx`：耍酷/性感/户外/转场，多选无新增入口。
- [x] T046 [P] [US3] 实现 `DanceCard.tsx`：用户封面/占位、歌名/歌手、状态、标签、独立 quick-play hit area。
- [x] T047 [US3] 实现 `GET /api/catalog` 与 LibraryPage 接入筛选、结果数、clear filter。
- [x] T048 [US3] 实现 `PATCH /api/dances/:id`；服务端拒绝第四种状态/第五种标签。
- [x] T049 [US3] 实现状态快捷动作“开始练 / 我会跳了”。
- [x] T050 [US3] 真机 light/dark 各跑一次曲库 smoke + screenshot compare；禁止示例封面进入 bundle。

## Phase 7: User Story 4 - Android 抖音分享 / PendingShare (P1)

- [x] T051 [P] [US4] 在 AndroidManifest 注册明确 `ACTION_SEND text/plain` 与受支持 `video/*` intent-filter，不注册 `*/*`。
- [x] T052 [US4] 实现小型 Capacitor native bridge / MainActivity ShareIntentHandler，统一处理 cold start `onCreate` 与 warm `onNewIntent`，生成去重 token。
- [x] T053 [P] [US4] 实现 `src/native/share-target.ts` 与 `src/lib/pending-shares.ts`，先本地落盘再尝试 server submit。
- [x] T054 [US4] 实现 `server/import/douyin-adapter.mjs` capability contract：无允许取得方式返回 NEEDS_INPUT，禁止通用网页抓取。
- [x] T055 [US4] 实现 `POST /api/imports/link`，只走 registry/source-policy；覆盖 redirect/SSRF tests。
- [x] T056 [US4] UI 实现 online processing / offline saved / adapter needs local video 三状态。
- [x] T057 [US4] 真机从 Android Sharesheet 分享测试链接；在线/离线/重复 intent/adapter unavailable 四场景全部记录。

## Phase 8: User Story 5 - Android 离线演出 (P1)

- [x] T058 [P] [US5] 先写 offline manifest readiness tests：missing/hash mismatch/version mismatch 必须 false。
- [x] T059 [US5] 实现 `/api/sync/manifest`，输出 catalogVersion、media size/hash/version，无绝对路径。
- [x] T060 [P] [US5] 实现 `src/lib/offline-manifest.ts` 与 `src/native/filesystem.ts`，下载采用 temp + atomic replace。
- [x] T061 [US5] 实现 Android sync：catalog snapshot + selected audio/cover，断网首屏不等待 network timeout。（真机 note11tpro 实测 62 文件落盘）
- [x] T062 [P] [US5] 实现 `PerformancePage.tsx`：默认会跳、四标签 AND、大播放/暂停/从头/上一首/下一首。（真机离线播放通过）
- [x] T063 [US5] 未缓存/损坏 UI 明确不可播；播放 ended 只停止。（真机"未缓存，不可播"+提示通过）
- [x] T064 [US5] 完全断网真机：kill app → cold start → ≤3 操作播放 → 10 条手动切歌；记录 `android-offline.md`。（2026-10-02 bundled debug + USB 固定真机飞行模式/关闭 Wi-Fi，冷启动 1 击播放、10 首逐曲通过；见 android-offline.md）

## Phase 9: User Story 6 - 原视频学习 / 去重 (P2)

- [x] T065 [P] [US6] 先写同歌不同源/同源重复 fingerprint tests。
- [x] T066 [US6] 实现 `GET/HEAD /api/media/reference/:sourceId` Range + opaque ID mapping。
- [x] T067 [P] [US6] 实现 `DanceDetailPage.tsx`，`查看原视频` 为主操作之一，不能藏在 overflow。
- [x] T068 [P] [US6] 实现 `ReferenceVideoPage.tsx`，原视频播放/进度/全屏，返回后保持详情状态。
- [x] T069 [US6] 实现 source sha/fingerprint duplicate detection；提示查看已有/仍创建。
- [x] T070 [US6] 实现歌名/歌手/封面人工修改，回归确认不改变 SourceMedia/PerformanceClip。
- [x] T071 [US6] 实现安全删除：默认仅记录；deleteMedia 二次确认 + 引用检查。
- [x] T072 [US6] 真机验证“详情→查看原视频”1 次点击开始，并截图留证。

## Phase 10: User Story 7 - 今晚歌单 (P2)

- [x] T073 [P] [US7] 先写 playlist order/readiness tests，包括人为删除一个本地文件的 negative test。
- [x] T074 [US7] 实现 `GET/PUT /api/playlists/tonight`，position 稳定且 transaction。
- [x] T075 [P] [US7] 实现 `TonightPlaylistPage.tsx` 增删、拖动排序、清空确认。（真机真实触摸拖动通过）
- [x] T076 [US7] 实现“准备离线演出”逐条下载/校验与进度；全部通过才 Ready。
- [x] T077 [US7] PerformancePage 从今晚歌单启动；下一首只选中、不自动发声。（真机通过）
- [x] T078 [US7] 10 首真机断网 + 删除 1 文件后 readiness 失效，记录 `tonight-playlist.md`。

## Phase 11: User Story 8 - Theme / Settings / Cache (P2)

- [x] T079 [P] [US8] 先写 DeviceSettings/theme persistence tests；system/light/dark 重启保持。
- [x] T080 [P] [US8] 实现 `SettingsPage.tsx`（底栏“我的”）：主题、Mac Mini endpoint、health、last sync、cache stats、about。
- [x] T081 [US8] 实现可信 endpoint validator；release 拒绝公开明文 HTTP，dev adb reverse loopback 允许。
- [x] T082 [US8] 实现缓存统计与“清理可重新下载缓存”；不得删除服务器主数据/原始媒体。
- [x] T083 [US8] 全部关键页面 light/dark 真机截图，与两个 approved prototype 做层级/风格人工视觉核对，结果写 `ui-visual-qa.md`。

## Phase 12: Recognition Provider / Polish / Operations

- [x] T084 [P] 完成实际 RecognitionProvider adapter（若无真实 key，使用 mock contract + disabled provider），timeout/rate-limit/bad response 全降级。
- [x] T085 [P] 识曲多候选/低置信度 UI：选择/忽略/手填；原音频始终不变。
- [x] T086 [P] 全局加载/空/错误/离线/空间不足文案；不暴露 stack/provider/path。
- [x] T087 完成 API/media integration tests：Range、非法 ID、path traversal、SSRF、伪 MIME、删除引用、provider faults。
- [x] T088 完成 backup/restore scripts：SQLite/catalog/covers/audio/manifest；参考视频按可重建性记录。
- [x] T089 isolated Docker build/run 到独立端口，不影响 P038；记录 compose config、health、rollback，不执行正式长期部署。

## Phase 13: Release Candidate Validation

- [x] T090 运行 `tsc` / eslint / vitest / integration / build 全部 exit 0，真实输出摘要写 `automated.md`。
- [x] T091 再跑 media truth ≥10、recognition off、cover failure、Douyin adapter unavailable 三类降级。
- [x] T092 Android final sync 后 `./gradlew :app:assembleDebug` 再构建并安装；验证升级不清空 catalog/pending shares/cache。
- [x] T093 在不创建/修改正式 keystore 的前提下运行 `:app:assembleRelease` 可构建性检查；若未配置 release signing，明确标记 unsigned，不伪称可发布。
- [x] T094 逐项建立 FR-001～FR-028 / SC-001～SC-010 → task/evidence traceability matrix，任何缺口返工直到清零。
- [x] T095 生成 `docs/verification/HUMAN-GATE.md`：安装包路径/大小/签名类型、手机实测结果、已知非阻断限制、待用户选择的正式签名/commit/push/长期部署动作。

## Phase 14: Human Gate (only after T001–T095 complete)

- [ ] T096 **HUMAN GATE**：开发者停止继续改动，把已安装真机 App、approved UI 对照、自动化证据、debug APK/release build 状态一次性交给用户验收；本任务之前不得以 ordinary question 中断用户。

## Dependencies & Execution Order

```text
Setup/Assets
  -> Foundation + Android live reload + early APK prebuild
  -> Shared security/data
  -> US1 Import -> US2 Media Truth -> US3 Library
  -> US4 Share/Pending
  -> US5 Offline Performance
  -> US6 Reference Learning
  -> US7 Tonight Playlist
  -> US8 Settings/Themes
  -> Polish/Operations
  -> Release Validation
  -> HUMAN GATE
```

**Independent developer rule**: 单人执行按编号最安全；标 `[P]` 的任务仅表示文件/依赖允许并行，但无需为了“并行”增加编排复杂度。


## 2026-10-03 用户局部增量（不重开架构计划）

- [x] T097 首页批量管理：逐卡/全选当前结果/清空/退出；修改三种学习状态与四种固定标签（增删替换），确认预览、取消和失败重试。
- [x] T098 原子批量分类 API、整批校验、回滚、仅所选项变化；更新手机快照/离线元数据，保留音乐缓存；补 OpenAPI 与数据约束。
- [x] T099 lint/test/integration/build、Java21 offline APK 构建；固定 note11tpro 隔离示范原生触摸，最终封面合并版本勾选/取消/主题封面/播放回归。见 `docs/verification/bulk-classification.md` 与 `bulk-edit-round5.json`。
