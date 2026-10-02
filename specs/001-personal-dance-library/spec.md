# Feature Specification: 个人舞蹈曲库 V1.5

**Feature Branch**: `001-personal-dance-library`  
**Created**: 2026-10-02  
**Status**: Draft / Cross-checked V1.1  
**Input**: 复用 Keep 家庭版成熟信息架构，建立男性化、轻/深双主题的 K-pop / 抖音舞蹈个人曲库；把“看到想学的舞”自动变成“能学习原视频、能播放原音乐片段、能现场演出”的个人条目。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 第一次打开就能收录第一支舞 (Priority: P1)

作为第一次使用的用户，我打开产品后无需注册或先配置标签，能直接理解“收录舞蹈”并从视频建立第一条舞蹈记录。

**Why this priority**: 产品第一价值就是替代“下载视频 → 转 MP3 → 查歌名/封面 → 手工整理”。

**Independent Test**: provider=off，从空库选择一个本地视频，完成自动处理并保存为“想学”；识曲/封面失败仍能完成。

**Acceptance Scenarios**:
1. **Given** 曲库为空，**When** App 首次启动，**Then** 直接出现空库、固定标签/状态框架和“+ 收录舞蹈”，不要求登录。
2. **Given** 点击“+ 收录舞蹈”，**When** 收录面板打开，**Then** Android 至少提供“从抖音/分享链接收录、选择手机视频、手动音频+封面”；桌面 Web 额外支持拖入/选择文件。
3. **Given** 用户选了可读取视频，**When** 自动处理，**Then** UI 依序反馈“获取视频/提取音乐/识别歌曲/获取封面/生成曲目”，不暴露 ffmpeg/provider 技术细节。
4. **Given** 处理完成，**When** 进入确认页，**Then** 可试听实际提取音频、看到歌曲信息候选、查看原视频入口、默认“想学”、0～4 场景标签并保存。
5. **Given** 识曲失败或封面失败，**When** 用户继续，**Then** 可使用未识别信息/来源截图/占位图完成保存。

---

### User Story 2 - 保存短视频里真正跳舞用的声音 (Priority: P1)

作为用户，我需要的是短视频里实际跳舞用的那一段，而不是识曲以后自动换成完整版。

**Why this priority**: 舞蹈动作经常对应变速、剪辑或特定起点，音乐被替换会直接导致练习/表演错位。

**Independent Test**: 导入含已知剪辑/变速特征的 fixture；保存后验证 PerformanceClip 与来源音轨对应，修改 SongIdentity 不改变 clip hash。

**Acceptance Scenarios**:
1. 默认保留整个来源音频，不自动变速、升降调或响度标准化。
2. 用户可进入“调整音乐片段”，只拖动 start/end、试听、恢复完整音频。
3. 裁剪不覆盖 SourceMedia；识曲元数据更新不替换 PerformanceClip。
4. 来源音轨目标机不兼容时允许一次兼容转码，但时间轴/速度/音调保持。

---

### User Story 3 - 用 3 个状态 + 4 个场景标签快速找到舞 (Priority: P1)

作为用户，我只想维护非常少的分类：左侧“会跳/正在练/想学”，顶部“耍酷/性感/户外/转场”。

**Independent Test**: 建 8 条固定数据验证状态单选、顶部多选 AND、清除筛选、0 标签条目行为。

**Acceptance Scenarios**:
1. 新舞默认“想学”；每条仅一个学习状态。
2. 场景标签只能从四个固定值中选 0～4 个。
3. 顶部“户外 + 转场”只显示同时具有两者的条目。
4. 左侧状态筛选单选、可取消；状态 + 标签跨维度同样取 AND。
5. 卡片直接提供表演音频播放按钮；点击卡片主体进入详情。

---

### User Story 4 - 抖音分享可以一键收，平台能力不行也不中断 (Priority: P1)

作为用户，我刷到想学的抖音舞蹈时，希望从系统分享菜单把链接交给舞蹈曲库，不想自己下载/转格式；但平台暂时拿不到媒体时也不能丢失这条收藏意图。

**Independent Test**: Android ACTION_SEND 分享 `text/plain` 链接：Mac Mini 在线时创建 ImportJob；Mac Mini 离线时写 PendingShare；Douyin adapter disabled 时进入 NEEDS_INPUT 并能选择本地视频补充。

**Acceptance Scenarios**:
1. App 在 Android Sharesheet 可作为明确的文本链接接收目标出现。
2. 在线且 adapter 可处理时，分享后进入自动收录流程。
3. 离线/不在家时，分享链接保存为 PendingShare，并明确显示“已保存，回家后继续处理”。
4. adapter 无法合规取得媒体时，保留来源链接并引导“一键选择本地视频补充”，不得调用通用第三方无水印解析。
5. 相同 share intent 不得被 onCreate/onNewIntent 重复消费成两条任务。

---

### User Story 5 - 出门完全断网仍能表演 (Priority: P1)

作为用户，我在酒吧、户外或朋友聚会现场必须能直接筛选并播放，不能依赖家里 Mac Mini。

**Independent Test**: 真机缓存至少 10 条后关闭 Wi‑Fi/蜂窝、杀进程冷启动，完成筛选、一键播放、暂停、从头、人工下一首。

**Acceptance Scenarios**:
1. 已缓存条目在完全离线冷启动后仍展示并可播放。
2. 演出模式默认优先“会跳”，隐藏编辑/删除/原视频等非现场控件。
3. 四场景标签仍使用 AND；未缓存项目明确显示“未离线保存”并禁用假可播按钮。
4. 音频自然播放结束后停止，不自动连播。
5. 主播放/暂停/从头/上一首/下一首均为大触控目标，最小 48dp。

---

### User Story 6 - 平时练舞能随时看原视频 (Priority: P2)

作为用户，我需要在详情页直接回看收藏时的原舞蹈，因为同一首歌可能有不同编舞。

**Independent Test**: 导入同歌不同来源两条记录均可存在；详情点击“查看原视频”播放对应 SourceMedia；重复同源第三次导入会提示。

**Acceptance Scenarios**:
1. 视频导入条目详情必须显示“查看原视频”，1 次点击开始播放/进入原视频页。
2. 同一歌曲的不同来源/不同编舞允许并存。
3. 相同来源 URL 或文件 fingerprint 再导入时提示“已收藏过”，提供查看已有/仍创建一份。
4. 改歌名/歌手/封面不影响参考视频、PerformanceClip、状态和标签。

---

### User Story 7 - 出门前准备今晚歌单 (Priority: P2)

作为用户，我要提前挑好今晚可能跳的舞并排序，现场只需手动切换。

**Independent Test**: 创建 10 首歌单、拖动排序、执行“准备离线演出”，断网 10/10 可播；删除一个本地文件后 readiness 立即失败。

**Acceptance Scenarios**:
1. 曲库条目可加入/移出今晚歌单而不影响原曲库。
2. 歌单支持拖动排序并持久化。
3. “已准备好”只在所有必要音频/封面/元数据真实存在且校验通过时显示。
4. 任一文件缺失/损坏时列出具体条目并显示“未准备好”。
5. “下一首”只切换选中项；必须再次点击播放才发声。

---

### User Story 8 - 主题、连接和本地缓存状态可管理 (Priority: P2)

作为用户，我需要浅色/深色模式，并能知道手机连接的是哪台 Mac Mini、缓存占用多少、是否可同步。

**Independent Test**: 切换系统/light/dark 三种模式后重启保持；修改本地服务地址并通过 health 检测；缓存统计与真实文件一致。

**Acceptance Scenarios**:
1. “我的”页提供主题：跟随系统 / 浅色 / 深色；两主题 UI 与 approved prototype 风格一致。
2. “我的”页提供 Mac Mini 服务地址、连接测试、最近同步时间。
3. 地址必须是用户显式配置的本地/私有网络 endpoint；无效地址不能静默保存为可用。
4. 显示音频/封面/参考视频缓存占用，并允许“清理可重新下载缓存”；不得删除原服务器媒体。
5. 无账号系统；“我的”是设备/主题/存储设置，不代表用户账户。

## Edge Cases

- 视频无音轨、音轨损坏、时长 0、超大文件、伪 MIME。
- 视频前几秒讲话；默认整段保留，用户可手工裁剪。
- 中文/空格/Emoji/括号/特殊符号文件名。
- 识曲多候选、低置信度、超时、限流、key 缺失。
- provider 有歌名但无可合法本地化封面；退回来源截图。
- 同歌不同舞；同源重复；来源 URL 相同但用户坚持复制。
- 手机存储不足；系统清理缓存；hash 不匹配；升级 App 后离线目录迁移。
- Mac Mini 不在线；用户仍能离线演出和保存 PendingShare。
- Android 分享 Intent 在冷启动/热启动重复到达。
- Android 12+ system splash 与 in-app loading 不能叠两次造成闪屏。
- 深色/浅色切换时状态栏、导航栏、安全区、系统字体缩放不遮挡主控件。
- UI 原型中示例封面不得进入正式包。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**：首次进入不强制登录；空库有“+ 收录舞蹈”。
- **FR-002**：Android 收录入口明确解释“收什么”：把参考舞蹈视频/链接变成可学习、可播放的 DanceItem。
- **FR-003**：Android 支持本地视频、手动音频+封面、ACTION_SEND 文本链接；桌面支持拖入/选择文件。
- **FR-004**：视频可读取时自动建立参考视频关联、PerformanceClip、歌曲/封面候选。
- **FR-005**：新舞默认“想学”；状态固定会跳/正在练/想学且单选。
- **FR-006**：场景标签固定耍酷/性感/户外/转场，可选 0～4。
- **FR-007**：顶部多标签 AND；状态筛选单选且与场景跨维度 AND。
- **FR-008**：PerformanceClip 来自来源音频；识曲不得替换。
- **FR-009**：裁剪只有 start/end + 试听 + 恢复完整，非破坏。
- **FR-010**：识曲/封面失败仍能保存；SongIdentity 可后改。
- **FR-011**：视频条目保留 SourceMedia；详情提供显眼“查看原视频”。
- **FR-012**：重复来源提醒；同歌不同来源允许并存。
- **FR-013**：卡片一键播放；详情与 quick-play 点击区域语义区分。
- **FR-014**：演出模式与普通模式分离；播放结束不自动下一首。
- **FR-015**：Android 离线目录/文件校验真实反映可播状态。
- **FR-016**：今晚歌单支持增删、排序、离线准备和 readiness gate。
- **FR-017**：Android ACTION_SEND `text/plain` 分享链接，避免重复 intent 消费。
- **FR-018**：Mac Mini 不可达时 PendingShare 本地持久化，联网后重试。
- **FR-019**：Douyin adapter 不可用时 NEEDS_INPUT + 本地视频补充，不实现 generic URL downloader。
- **FR-020**：第三方识曲仅上传最小短音频，key server-only。
- **FR-021**：支持 light/dark 双主题，默认跟随系统；主题选择持久化。
- **FR-022**：“我的”提供 Mac Mini endpoint/health、最近同步、缓存统计和安全清理。
- **FR-023**：所有可点击交互目标最小 48dp；支持 Android safe-area/system bars。
- **FR-024**：Android 12+ 使用系统 SplashScreen；品牌启动视觉不能额外阻塞正常启动。
- **FR-025**：使用 `assets/app-icon-master.png` 与 adaptive icon 规范生成 launcher icon；支持 monochrome/themed icon 能力。
- **FR-026**：删除必须区分删除记录与删除媒体；媒体有引用时不得误删。
- **FR-027**：UI 不内置原型中的示例商业封面/人物图；只用用户媒体或占位资源。
- **FR-028**：客户端 API endpoint 只能由用户配置为受信任的本地/私有网络地址；公开 HTTP 地址拒绝或明确阻断。

### Key Entities

- **DanceItem**：一支具体编舞；稳定 ID、学习状态、0～4 场景标签、SourceMedia、PerformanceClip、SongIdentity、CoverAsset。
- **SourceMedia**：用户实际提供/分享的原视频或音频及来源元信息。
- **PerformanceClip**：真正表演的音频，保存来源关系、start/end、codec、hash、sourcePreserving。
- **SongIdentity**：歌名、歌手、识曲状态、候选封面等元数据；不是真源。
- **ImportJob**：PENDING/PROCESSING/NEEDS_INPUT/READY/FAILED 收录状态机。
- **PendingShare**：Android 在 Mac Mini 不可达时本地保存的分享意图。
- **TonightPlaylist**：今晚歌单与人工顺序。
- **OfflineManifest**：Android 本地文件 readiness、version/hash/size。
- **DeviceSettings**：themeMode、apiEndpoint、lastSyncAt、cachePolicy 等非账号设置。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**：从空库到保存第一条本地视频舞蹈，正常情况人工必做步骤 ≤5 次有效操作。
- **SC-002**：≥10 条媒体抽样中，PerformanceClip 与来源对应片段在起止/速度/音调上保持一致；改 SongIdentity 不改变 clip hash。
- **SC-003**：固定筛选测试集全部组合结果 100% 符合 3 状态 + 4 标签 AND 规则。
- **SC-004**：Android 完全断网、Mac Mini 不可达，冷启动后 ≤3 次用户操作开始播放已缓存“会跳”舞蹈。
- **SC-005**：10 首今晚歌单 Ready 后断网 10/10 可播；人为删 1 个文件后 Ready 立即失效。
- **SC-006**：详情页从看到“查看原视频”到开始原视频最多 1 次明确点击。
- **SC-007**：recognition off / cover failure / Douyin adapter unavailable 三种故障都不丢失用户收录意图。
- **SC-008**：Light/Dark 关键屏真机视觉检查均达到原型的信息层级、导航和男性化蓝黑视觉，不出现可爱卡通/粉色 UI chrome。
- **SC-009**：开发 Foundation 阶段即能通过 ADB 实时预览，并真实生成、安装本地 debug APK。
- **SC-010**：演出模式自然结束 20 次均不自动播放下一首。

## Assumptions

- 首版单用户、单 Android 主设备；不登录。
- Mac Mini 负责重媒体处理；手机负责 UI、离线缓存、分享接收和现场播放。
- 识曲服务是可选增强；无 key 仍可完成全部核心功能。
- 当前稳定技术基线为 Capacitor 8 + Android API 36；Capacitor 9 仍为 prerelease 时不得切换。
- P038 Project Reader 当前工作树已发现落后远端且缺正式 app 源码，因此只能作为文档/素材参考；迁移 UI 前必须定位 P038 最新真实源码/部署副本或 fresh clone，不得从过期工作树盲拷。
