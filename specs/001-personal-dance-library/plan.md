# Implementation Plan: 个人舞蹈曲库 V1.5

**Branch**: `001-personal-dance-library` | **Date**: 2026-10-02 | **Spec**: `specs/001-personal-dance-library/spec.md`  
**Input**: Constitution 1.1.0-draft + Feature Specification V1.1 + Approved UI assets

## Summary

新建独立项目，不直接改写 P038。Mac Mini 负责媒体收录、FFmpeg、识曲适配、SQLite 主数据与同步 API；React 19 + TypeScript + Vite 7 负责共享 UI；Capacitor 8 将同一 UI 打包成 Android 客户端，使用本地媒体/目录快照实现完全离线演出。视觉实现必须以 `docs/ui/prototype-dark-approved.png` 为主视觉、`prototype-light-approved.png` 为浅色映射，并使用包内 app icon / splash 资源。

## Technical Context

**Language/Version**: Node.js 22+、TypeScript 5.x、Java 17/Android Gradle toolchain  
**Primary Dependencies**: React 19、Vite 7、Capacitor 8.x stable（core/android/cli 同 major）、@capacitor/filesystem、@capacitor/preferences 或等价官方小型设置存储、@capacitor/assets；服务端 Node HTTP + SQLite driver + FFmpeg/ffprobe  
**Storage**: Mac Mini SQLite + 文件目录；Android 本地 JSON catalog/manifest + Capacitor Filesystem 媒体缓存  
**Testing**: Vitest、Node integration/media/security tests、ADB 真机 QA、Gradle assembleDebug/assembleRelease  
**Target Platform**: Android API 24+；compileSdk/targetSdk 36；Mac Mini Docker  
**Project Type**: Mobile + local API + desktop/web admin  
**Performance Goals**: 离线冷启动后 3 次操作内播放；1000 条以内曲库筛选无感延迟；Range/本地播放不整片读入内存  
**Constraints**: offline-first、单用户、无登录、无云数据库依赖、识曲可关闭、外部链接能力可降级  
**Scale/Scope**: 个人曲库，预期 50～1000 DanceItem；单台 Mac Mini + 1～数台自用 Android 设备

**Android App Identity**: `appName=舞蹈曲库`；`appId=com.wanghoufan.dancelibrary`；debug `applicationIdSuffix=.dev`。若用户在正式签名前明确要求改包名，必须在 Human Gate 前一次性迁移并重跑升级/离线数据验证。

### Current official baseline locked for this plan

- GitHub Spec Kit 当前模板仍要求 Constitution → SPEC → PLAN → TASKS；SPEC 用户故事按优先级、可独立验收，TASKS 按 story 分组并使用 `- [ ] T001 [P] [US1] ...` 格式。
- Capacitor 官方稳定文档当前为 v8；Capacitor 9 尚未 GA，不采用 prerelease。
- Capacitor 8 Android 基线：minSdk 24、compileSdk/targetSdk 36；Node 22+。
- Google Play 自 2026-08-31 起新应用/更新 target Android 16 / API 36+。
- Android interactive target ≥48dp。
- Android 12+ 使用标准 SplashScreen；adaptive icon 使用前景/背景/monochrome 思路。

## Constitution Check

| Principle | Plan response | Status |
|---|---|---|
| 收录比手工更省事 | local-file 是稳定主链路；识曲/封面/平台失败降级 | PASS |
| 来源音频真源 | SourceMedia/PerformanceClip/SongIdentity 分离；hash 回归 | PASS |
| 3状态+4标签 | enum + DB/API 校验 + AND 单测 | PASS |
| 原视频可学习 | 详情显眼“查看原视频”；Range/本地播放 | PASS |
| 演出 offline-first | Android local catalog + file manifest；断网冷启动 | PASS |
| UI approved SSOT | 资产入库 + Theme tokens + 真机截图视觉核对 | PASS |
| Android 官方规范 | API36/48dp/System Splash/adaptive icon | PASS |
| 安全边界 | no generic fetch、SSRF guard、key server-only、non-destructive delete | PASS |

**Design re-check**: 数据模型、API、UI 路由、Android 分享和离线策略完成后再次跑，任何 FAIL 在进入实现前必须修正。

## Architecture

```text
Android / Capacitor 8
├─ React UI (light/dark)
├─ ACTION_SEND receiver -> PendingShare
├─ DeviceSettings
├─ local catalog.json + offline-manifest.json
├─ performance audio / cover files
└─ ADB live reload in development
             │ trusted LAN sync
             ▼
Mac Mini local service
├─ React Web admin/import UI
├─ Node API
├─ ImportJob + SourceAdapter registry
├─ FFmpeg/ffprobe
├─ RecognitionProvider (optional)
├─ SQLite
└─ controlled media roots
```

## UI / Asset Authority

必须直接把以下内容复制到新项目并纳入版本控制：

```text
reference/ui/prototype-dark-approved.png   <- 主视觉 SSOT
reference/ui/prototype-light-approved.png  <- 浅色主题映射
assets/app-icon-master.png                  <- Android 图标视觉源
assets/splash.png                           <- light splash source 2732²
assets/splash-dark.png                      <- dark splash source 2732²
reference/ui/launch-screen-preview-dark.png <- 启动视觉预览
```

实现规则：
1. 深色版布局/层级/蓝黑视觉为主，浅色版不是独立产品而是同组件 token 映射。
2. 原型中的示例 K-pop 图片仅作占位，不打包；用 CSS/本地占位图 + 用户封面。
3. exact copy 以 SPEC 为准；不得 OCR 原型文字。
4. “收录舞蹈”入口必须清楚解释：把舞蹈来源变成“原视频 + 原音乐片段 + 歌曲信息 + 状态/标签”的条目。
5. 详情页必须有 `查看原视频`；不可藏在三级菜单。
6. 底部导航采用 `曲库 / 今晚歌单 / 演出模式 / 我的`；“我的”只做主题、连接、存储、关于，无账号。

### Theme tokens

- Dark: bg `#060B12`, surface `#0D1621`, surface-2 `#111D2A`, primary `#1677FF`, text `#F5F8FF`, muted `#94A3B8`。
- Light: bg `#F6F8FB`, surface `#FFFFFF`, surface-2 `#EEF3F9`, primary `#1677FF`, text `#101828`, muted `#667085`。
- UI chrome 禁止粉色/可爱插画；用户封面自身颜色不受限制。

## Project Structure

```text
.specify/memory/constitution.md
specs/001-personal-dance-library/
├── spec.md
├── plan.md
├── tasks.md
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/openapi.yaml

reference/ui/
├── prototype-dark-approved.png
├── prototype-light-approved.png
└── launch-screen-preview-dark.png
assets/
├── app-icon-master.png
├── splash.png
└── splash-dark.png

src/
├── app/{App.tsx,routes.tsx,theme.ts}
├── components/{DanceCard,SceneTagBar,LearningStatusRail,ImportSheet,ImportProgress,ClipTrimmer,PlayerControls}.tsx
├── pages/{LibraryPage,ImportReviewPage,DanceDetailPage,ReferenceVideoPage,TonightPlaylistPage,PerformancePage,SettingsPage}.tsx
├── lib/{api,filters,offline-manifest,pending-shares,device-settings,types}.ts
└── native/{filesystem,share-target}.ts

server/
├── index.mjs
├── db/{database.mjs,schema.sql,migrations/}
├── import/{import-service,source-adapter,local-file-adapter,manual-audio-adapter,douyin-adapter}.mjs
├── media/{ffmpeg,clips,covers,fingerprints}.mjs
├── recognition/{provider,disabled-provider,configured-provider}.mjs
├── routes/{catalog,dances,imports,media,playlists,sync,health}.mjs
└── security/{paths,source-policy}.mjs

android/            # committed Capacitor native project + Gradle Wrapper
scripts/
tests/{unit,integration,fixtures}/
docs/{android,verification,operations}/
```

## Data Model

### DanceItem
`id, songIdentityId?, sourceMediaId?, performanceClipId, titleOverride?, learningStatus, sceneTags[], coverAssetId?, createdAt, updatedAt, deletedAt?`

### SourceMedia
`id, sourceKind, sourceLocator?, internalPath?, sha256?, durationMs, audioCodec?, videoCodec?, status`

### PerformanceClip
`id, sourceMediaId, startMs, endMs, internalAudioPath, codec, sourcePreserving, sha256, sizeBytes, durationMs, version`

### SongIdentity
`id, title?, artist?, recognitionStatus, provider?, providerRef?, confidence?, coverAssetId?`

### ImportJob
`id, sourceKind, status, stage, errorCode?, draftJson?, createdAt, updatedAt`

### PendingShare (Android local)
`id, sharedText, normalizedUrl?, receivedAt, submitState, lastError?`

### TonightPlaylist
单一逻辑歌单；item 为 `danceItemId + position`。

### OfflineManifest
每个 DanceItem 保存 audio/cover/referenceVideo 的 path/sha256/size/version/ready；Ready 必须实际校验。

### DeviceSettings
`themeMode: system|light|dark`, `apiEndpoint`, `lastSyncAt`, `cachePolicyVersion`。

## API Contracts

- `GET /api/health`
- `GET /api/catalog`
- `POST /api/imports/file`
- `POST /api/imports/link`
- `GET /api/imports/:id`
- `POST /api/imports/:id/finalize`
- `GET/PATCH/DELETE /api/dances/:id`
- `GET/HEAD /api/media/audio/:clipId`
- `GET/HEAD /api/media/reference/:sourceId`
- `GET /api/media/cover/:assetId`
- `GET/PUT /api/playlists/tonight`
- `GET /api/sync/manifest`

详细 shape 见 `contracts/openapi.yaml`；所有媒体 endpoint 以 opaque ID 工作，不接受用户绝对路径。

## Import Pipeline

`ACQUIRE -> PROBE -> EXTRACT -> RECOGNIZE -> COVER -> REVIEW -> FINALIZE`

- Acquire: local file/manual media/approved adapter；Douyin 不可取时 `NEEDS_INPUT`。
- Probe: ffprobe 实测轨道/时长，不信 MIME。
- Extract: 首选 source-preserving stream copy；不兼容才 AAC 转码。
- Recognize: 只取最小短音频；provider off/失败继续。
- Cover: 合法 provider cover -> 来源视频取帧 -> 内置占位。
- Review: 试听、原视频入口、可选裁剪、默认想学、四标签。
- Finalize: 持久化并递增 catalog/manifest version。

## Android Development & Real-time Preview

### Machine preflight

当前本机档案已记录 JDK 17、Android SDK Platform 36、Build Tools 35/36、platform-tools；但 Gradle/ADB 能力标记为“待复测”，因此开发者必须真实执行：

```bash
source "$HOME/android-toolchain/android-env.zsh" 2>/dev/null || true
java -version
printf 'ANDROID_HOME=%s\n' "$ANDROID_HOME"
adb version
adb devices -l
```

若只有一台 `device` 状态真机，自动设置 `ANDROID_SERIAL`；多台时选择唯一 USB physical device，不问用户。不得对 unauthorized/offline 设备做破坏操作。

### Early APK prebuild gate（必须在业务开发早期完成）

Capacitor Android 壳建立、图标/主题最小接线后立即：

```bash
npm run build
npx cap sync android
cd android
./gradlew :app:assembleDebug
APK=app/build/outputs/apk/debug/app-debug.apk
ls -lh "$APK"
adb -s "$ANDROID_SERIAL" install -r "$APK"
```

- Debug 使用 `applicationIdSuffix '.dev'`，避免与未来 release 签名冲突。
- 不允许为安装 debug APK 擅自卸载用户已有应用。
- Gate 证据必须写：命令、产物真实路径、大小、debug 签名、`adb shell pm path <devPackage>`。

### USB real-time preview

Vite 和 Node API 都绑定 localhost，通过 ADB reverse 转给手机，避免把开发端口暴露到局域网：

```bash
npm run dev -- --host 127.0.0.1 --port 5173
# second terminal
npm run server:dev -- --host 127.0.0.1 --port 8791
adb -s "$ANDROID_SERIAL" reverse tcp:5173 tcp:5173
adb -s "$ANDROID_SERIAL" reverse tcp:8791 tcp:8791
npx cap run android --target "$ANDROID_SERIAL" --live-reload --host 127.0.0.1 --port 5173
```

如果 CLI target 参数接受的是设备 ID 而非 serial，先 `npx cap run android --list` 匹配同一真机；不得凭猜测卸载/重置设备。

开发期间每完成一个用户故事，都必须在手机上走一次该故事 smoke；视觉任务必须用 `adb exec-out screencap -p` 保存截图与 reference 对比。

## Android Runtime Decisions

- Capacitor 8.x stable；`minSdk 24 / compileSdk 36 / targetSdk 36`。
- Android 12+ system SplashScreen；使用 `@capacitor/assets` 从包内 master 生成平台资源。
- Adaptive icon：生成 foreground/background/monochrome；核心 mark 保持在 66/108 安全区思想内。
- edge-to-edge：使用 Capacitor 8/System Bars 与 CSS `env(safe-area-inset-*)`，不靠旧 margins workaround。
- ACTION_SEND：只注册 `text/plain` 和明确支持的 `video/*`；收到内容进入统一 ShareIntentHandler。
- Release 时不要求后台播放；V1.5 只保证前台现场播放。

## Offline Strategy

- `catalog.json` + `offline-manifest.json` 写 Android app-internal Filesystem。
- audio/cover/reference 分目录；写临时文件后 fsync/rename 或等价原子替换。
- “准备离线演出”按 manifest 下载并核验 size/hash，再置 Ready。
- 离线冷启动完全从本地 snapshot 读取；API 请求不能阻塞首屏。
- PendingShare 先本地落盘再尝试上传；成功后 idempotent 删除。

## Security & Failure Handling

- SourceAdapter registry 是唯一 URL 取得入口；无 generic downloader。
- scheme/host/redirect、DNS 解析后 IP 再校验；阻断 loopback/link-local/private SSRF 探测（除用户显式配置的 Mac Mini sync endpoint）。
- 客户端 `apiEndpoint` 只允许 RFC1918 / `.local` / loopback(dev via adb reverse)；生产拒绝公开明文 HTTP。
- 服务端文件访问 canonicalize + controlled root。
- upload streaming + max size + ffprobe type check；不信客户端 MIME。
- recognition key/log secret/server path 全部脱敏。
- media delete 做 reference count/transaction。

## P038 Reuse Rule

已发现当前 Project Reader 指向的 P038 working tree `main` 落后远端且缺 `src/`/`server.mjs`，而旧 tasks 记录正式代码在另一 working/deploy copy。因此：

1. 不得从当前 P038 目录直接复制不存在/过期的 App 代码。
2. 开工第一阶段必须自动定位最新真实源码：优先 Git `origin/main` fresh clone/read-only worktree；其次已记录 deploy/source copy。
3. 只迁移通用 UI/layout/Range 思路，并建立 `docs/migration/p038-shell-reuse.md` 列出来源 commit/path。
4. 不复制 P038 `.git`、健身视频、annotations、`.env`、keys、DockerData。

## Phase Gates

1. **SDD/Asset Gate**：四文档一致 + approved UI/assets 入库。
2. **Foundation/Prebuild Gate**：Web/Node/Android 壳启动；ADB live reload；`app-debug.apk` 真实生成安装。
3. **Import Gate**：local-file/provider-off 可完整收录；原音频真源。
4. **Catalog/UI Gate**：3状态4标签、Light/Dark、详情原视频入口、quick play。
5. **Share Gate**：ACTION_SEND online/offline/adapter unavailable 三条通路。
6. **Offline Performance Gate**：完全断网冷启动 + 10首人工切歌。
7. **Tonight Gate**：readiness negative test。
8. **Release Gate**：自动测试、安全/媒体/视觉回归、Docker isolated build、APK candidate。
9. **Human Gate**：唯一最终用户确认；之前不问中间小问题。

## Complexity Tracking

| Complexity | Why needed | Simpler alternative rejected because |
|---|---|---|
| Capacitor Android + local service | 外出演出 offline + 想复用 React | 纯 LAN Web 核心场景失效 |
| SQLite server + file cache mobile | ImportJob/playlist/migration + 大媒体 | 单 JSON 主库易写坏；云 DB 没必要 |
| SourceAdapter/RecognitionProvider | 外部平台/供应商可变 | 硬编码会成为单点故障 |
| OfflineManifest hash gate | 现场必须知道“真的能播” | boolean 无法发现系统清理/损坏 |
| light/dark + Settings | 用户已确认两套主题，且需 Mac Mini endpoint/cache 管理 | 硬编码主题/地址导致不可维护 |

## No-Clarification Defaults for Developer

- Recognition key 缺失：provider=disabled + mock contract，继续开发；真实 provider 验证不阻断核心 release gate。
- Mac Mini 端口冲突：从 8791 起向上选择首个空闲端口并记录，不问用户。
- 多 ADB 设备：自动选择唯一 USB physical device；无法唯一判断则继续非设备任务并把真机 task 保持 blocked，直到最终 gate 再报告。
- UI 文案歧义：SPEC 精确规则 > approved prototype visual text。
- 任何需要删除/卸载/修改正式签名/Git push 的动作：不执行，采用非破坏性替代并记入 Human Gate。
