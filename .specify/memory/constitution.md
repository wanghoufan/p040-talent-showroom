# 个人舞蹈曲库 Constitution

<!--
Sync Impact Report
- Version: 1.1.0-draft
- Ratified: 待用户批准
- Last Amended: 2026-10-02
- Governs: specs/001-personal-dance-library/{spec.md,plan.md,tasks.md}
- UI authority: reference/ui/prototype-dark-approved.png（主视觉）+ reference/ui/prototype-light-approved.png（浅色映射）
- Product scope: V1.5 舞蹈曲库；架构预留未来 V2，但本轮不得实现吉他/唱歌/公开点歌台。
-->

## Core Principles

### I. 收录必须比手工整理更省事

系统的核心价值是把“看到想学的舞”变成“可直接练、可直接表演的个人条目”。

- 新用户 MUST 能在不注册、不预配置标签的情况下开始收录。
- 从视频收录时 MUST 自动完成可自动完成的步骤：取得/保存用户提供的来源、探测媒体、提取表演音频、尝试识曲、尝试取得封面、生成待确认条目。
- 新舞蹈 MUST 默认进入“想学”。
- 识曲、封面、平台来源适配任一失败 MUST NOT 阻止保存；必须存在“未识别 / 默认封面 / 本地视频补充 / 待收录”降级路径。
- 本地视频导入 MUST 永远作为稳定主路径；产品不得把可用性绑定到任何短视频平台下载能力。

### II. 来源音频是真源，识曲不得偷换音乐

- 表演音频 MUST 来自用户实际导入/分享的媒体中所听到的版本，而不是识曲后替换为完整版歌曲。
- MUST 保留片段原本的速度、音调、剪辑与起止逻辑；不得自动“修复”、升降调、标准化速度。
- 技术允许时 SHOULD stream-copy 原音轨；仅为目标设备兼容性允许一次转码。
- 裁剪 MUST 非破坏：保存 start/end 或派生 clip，不覆盖 SourceMedia。
- SongIdentity 与 PerformanceClip MUST 数据隔离；修改歌名/歌手/封面不得改变音频 hash。

### III. 分类体系固定且极简

- 顶部场景标签只有：`耍酷 / 性感 / 户外 / 转场`。
- 一条舞蹈 MAY 具有 0～4 个场景标签；顶部多选筛选 MUST 使用 AND。
- 左侧学习状态只有：`会跳 / 正在练 / 想学`；每条舞蹈 MUST 且只能有一个状态。
- 状态筛选 MUST 单选并可清除。
- V1.5 禁止开发者自行增加“炸场、可爱、K-pop、Solo”等一级标签。

### IV. 原视频必须可学习，表演操作必须更短

- 每条由视频导入的 DanceItem MUST 保留参考视频关联。
- 详情页 MUST 有明显的“查看原视频”入口；从详情到开始播放参考视频最多 1 次明确点击。
- 曲库卡片 MUST 有一键播放表演音频入口，无需先进入详情。
- 普通模式负责收录/学习/管理；演出模式负责现场筛选/播放，MUST 隐藏编辑、删除、参考视频等非现场操作。
- 播放结束 MUST 停止，不得自动连播下一首。
- 今晚歌单 MUST 支持人工排序并与演出模式直接连通。

### V. 外出演出必须 offline-first

- Android 客户端 MUST 在 Mac Mini 不可达、Wi‑Fi/蜂窝均关闭时冷启动并播放已缓存表演音频。
- “已准备好演出” MUST 建立在真实文件存在 + size/hash/version 校验上，不得只信任 boolean。
- 离线至少保留：DanceItem 展示快照、封面、状态、场景标签、今晚歌单顺序、PerformanceClip。
- 参考视频默认不强制缓存；用户主动“离线学习”时才下载。
- 在外收到分享时 MAY 先保存 PendingShare，回到 Mac Mini 可达网络后再处理。

### VI. UI 以已确认原型为视觉 SSOT，但文字与业务规则以 SPEC 为准

- 深色原型 `reference/ui/prototype-dark-approved.png` 是主视觉 SSOT；浅色原型用于 light theme 映射。
- UI MUST 保持男性化、克制、运动/街舞感：深海军蓝/黑 + 电光蓝为主，不使用可爱卡通人物、粉色少女化 UI 装饰。
- 原型中的歌曲封面/人物仅是占位视觉，不得作为应用内置版权素材；运行时使用用户导入封面、来源截图或系统占位图。
- ImageGen 原型中文字可能存在视觉性错字，MUST NOT OCR 后直接照抄；精确文案、标签、状态和按钮语义以 SPEC/PLAN 为准。
- 所有交互触控目标 MUST ≥ 48dp × 48dp。
- V1.5 MUST 同时完成 light/dark theme；默认跟随系统，用户可在“我的”选择 跟随系统/浅色/深色。

## Android / Platform Constraints

1. 当前稳定基线使用 Capacitor 8.x，不使用尚未 GA 的 Capacitor 9 prerelease。
2. Android 基线锁定 `minSdk 24 / compileSdk 36 / targetSdk 36`；与 2026-08-31 起 Google Play 新应用/更新要求一致。
3. 使用 Android 12+ 官方 SplashScreen 机制；不得实现额外“假 Splash Activity”延长启动。`assets/splash*.png` 是品牌/资产生成源与 in-app loading 视觉参考。
4. Android launcher icon MUST 按 adaptive icon 规范生成；主图形保持在安全区，避免双重圆角 mask。
5. Android 分享接收使用 ACTION_SEND 的明确 MIME intent-filter；禁止 `*/*` 无边界接收。
6. 开发时必须支持 USB ADB 真机实时预览；正式离线验收不能只在浏览器/桌面完成。

## Media, Privacy & Security Boundaries

- 只处理用户主动提供、分享或平台明确允许取得的媒体；不得实现绕过平台限制、破解签名、通用“无水印下载器”。
- 抖音链接入口是 capability adapter：无法合规取得媒体时返回 `NEEDS_INPUT` 并引导本地视频补充。
- URL 导入 MUST 经过 scheme/host/redirect 白名单和 SSRF 防护；服务端禁止 `fetch(userUrl)` 泛化抓取。
- 第三方识曲只发送最小必要短音频，不发送完整参考视频；API key 只存在 Mac Mini 服务端环境变量。
- 客户端不得获得服务器绝对路径、识曲 key、数据库路径或其他秘密。
- destructive media delete 必须二次确认并检查引用；默认仅软删/移除记录。
- Debug APK 与正式 release package 必须隔离 applicationId；不得为解决签名冲突擅自卸载用户已有应用。

## Scope

### V1.5 MUST
- 空库直接收录；本地视频、手动音频+封面；Android 分享/粘贴链接与桌面文件导入。
- 自动音频提取、识曲候选、封面候选、失败降级。
- 原视频保留与“查看原视频”。
- 可选 start/end 裁剪与试听。
- 三学习状态、四场景标签、AND 筛选。
- 卡片一键播放、详情页、今晚歌单、演出模式。
- Android 离线缓存与 PendingShare。
- Light/Dark 双主题；“我的”承载主题、Mac Mini 地址、缓存/存储状态与关于信息。

### V1.5 MUST NOT
- 吉他/唱歌具体 UI、Capo/和弦/歌词谱。
- 二维码公开点歌台、访客端、多人点歌请求。
- 登录、多用户、社交关系。
- AI 自动判定舞蹈风格或自动新增标签。
- 内置第三方商业歌曲/封面作为正式内容。

## Quality Gates

1. SPEC → PLAN → TASK 追溯完整，无悬空 MUST。
2. TypeScript/Lint/unit/integration/media/security tests 全绿。
3. UI 两主题关键页面与 approved prototype 做真机视觉核对。
4. Android ADB 真机实时预览在开发早期建立并持续可用。
5. Foundation 阶段即生成、安装 `app-debug.apk` 作为 APK 预构建证据。
6. 完全断网 Android 真机完成演出流程。
7. ≥10 条媒体真源抽样证明识曲未替换 PerformanceClip。
8. recognition off / cover failure / Douyin adapter unavailable 三类降级均通过。
9. Human Gate 之前不得声称发布完成；Human Gate 是所有 task 完成后的唯一用户验收点。

## Governance

- Constitution 高于临时实现偏好；冲突必须修改下游文档/代码，不得降低 MUST。
- SPEC 负责 WHAT/WHY；PLAN 负责 HOW；TASKS 负责可执行工作与证据。
- PLAN 的 Constitution Check 在设计前后各跑一次。
- 版本遵循 SemVer；本稿为 `1.1.0-draft`，用户批准后再写正式 Ratified 日期。
- Git commit/push、正式签名/keystore、删除用户应用、删除 SDK/缓存等高风险动作不因“连续开发”自动获得授权；开发期间采用非破坏性替代路径，最终 Human Gate 再处理。

**Version**: 1.1.0-draft | **Ratified**: 待用户批准 | **Last Amended**: 2026-10-02
