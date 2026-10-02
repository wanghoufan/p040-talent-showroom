# 独立开发者连续开发提示词｜个人舞蹈曲库 V1.5

你现在是本项目唯一的独立开发者。请从当前项目目录开始，连续执行 SDD 直到 `tasks.md` 中 T001–T095 全部完成并有证据，然后才进入 T096 Human Gate。中途不要因为 ordinary implementation choice、小错误、UI 微调、依赖选择、命名、端口冲突、测试失败而询问用户，也不要停下来要求“继续”。你负责自己定位问题、修复、重跑、推进。

## 0. 本次目标

完成“个人舞蹈曲库 V1.5”：

- 看到/导入想学的舞 -> 自动提取原视频里的实际音乐片段 -> 尝试识曲/封面 -> 保存；
- 左侧只用 会跳/正在练/想学，顶部只用 耍酷/性感/户外/转场，多标签 AND；
- 详情显眼保留“查看原视频”用于学习；
- 曲库卡片一键播音乐；
- Android 分享链接可在线收录或离线 PendingShare；
- 今晚歌单 + 演出模式；
- Android 完全离线可冷启动/播放；
- light/dark 双主题，视觉严格使用包内 approved prototypes；
- Android USB ADB 实时预览；开发早期就完成可安装 debug APK 预构建。
- Android identity 固定：`appName=舞蹈曲库`、`appId=com.wanghoufan.dancelibrary`、debug suffix `.dev`。

## 1. 开始前唯一允许的一次“提前索取”

如果本机环境里没有识曲服务密钥，而你希望本轮验证真实识曲服务，可以在开始编码前一次性向用户索取：

- `MUSIC_RECOGNITION_PROVIDER`（AudD 或 ACRCloud）
- 对应 API key/secret

只允许这一次提前询问。若用户没给、跳过或 key 不可用：**不要再次追问，不要阻塞开发**。按 `provider=disabled + mock contract` 完成全部核心功能与降级测试。数据库使用本地 SQLite，不需要向用户索取数据库 key。

## 2. 必读 SSOT，顺序不能乱

1. `.specify/memory/constitution.md`
2. `specs/001-personal-dance-library/spec.md`
3. `specs/001-personal-dance-library/plan.md`
4. `specs/001-personal-dance-library/tasks.md`
5. `specs/001-personal-dance-library/research.md`
6. `specs/001-personal-dance-library/data-model.md`
7. `specs/001-personal-dance-library/contracts/openapi.yaml`
8. `docs/ui/ui-assets-manifest.md`
9. `reference/ui/prototype-dark-approved.png`（主视觉）
10. `reference/ui/prototype-light-approved.png`
11. `reference/ui/launch-screen-preview-dark.png`
12. `assets/app-icon-master.png`、`assets/splash.png`、`assets/splash-dark.png`

冲突优先级：**Constitution > SPEC 业务语义/精确文案 > PLAN 技术决策 > TASKS > UI 原型里的生成文字**。UI 原型只负责布局/视觉/信息层级，不要 OCR 里面可能生成错的字。

## 3. P038 复用规则

当前已知 Project Reader 指向的 P038 working tree 落后远端且看不到正式 app 源码。不得从它直接盲拷。

自动定位最新真实 P038 源码：优先 `origin/main` fresh read-only clone/worktree，其次已记录的最新 source/deploy copy。只抽取通用 React 卡片/筛选/Range 逻辑和样式思路。绝对禁止复制：P038 `.git`、健身视频、annotations、`.env`、keys、DockerData、旧业务模型。

## 4. 连续执行规则

- 严格按 `tasks.md` 编号推进，完成一项立即把 checkbox 改为 `[x]` 并在 `docs/verification/task-ledger.md` 记录证据。
- [P] 只表示理论可并行；你是单人开发者，默认串行，优先稳定和缓存命中，不为了并行增加复杂度。
- 每个 bug：先复现/定位根因 -> 加回归测试 -> 最小修复 -> 相关测试 -> 全量必要门禁；禁止拍脑袋补丁。
- 用户故事完成后必须 Android 真机 smoke，不得只用桌面浏览器冒充。
- UI 关键页同时检查 light/dark，并通过 adb screenshot 与 approved prototype 做人工视觉核对。
- 遇到不明确的小问题，使用 PLAN 的 `No-Clarification Defaults` 自行决策并记录；不要问用户。
- 如果第三方接口/平台能力真的不可用，走规格里的降级路径，而不是暂停项目。

## 5. Android 本地规范：强制早期建立实时预览和 APK 预构建

先读取项目内 `docs/android/realtime-preview-and-apk.md`；同时遵守 Mac Mini 的 Android 本地规范。

### ADB preflight

```bash
source "$HOME/android-toolchain/android-env.zsh" 2>/dev/null || true
java -version
printf 'ANDROID_HOME=%s\n' "$ANDROID_HOME"
adb version
adb devices -l
```

用户已经说明手机通过 ADB USB 有线连接。若短暂 offline/unauthorized，先执行非破坏性诊断（adb server/reconnect/线缆状态），不要卸载任何用户 App。若当时确实无法恢复，继续做非设备任务，之后在每个 Android Gate 自动重试，不要问用户。

### 实时手机预览

开发早期就建立：

```bash
npm run dev -- --host 127.0.0.1 --port 5173
npm run server:dev -- --host 127.0.0.1 --port 8791
adb -s "$ANDROID_SERIAL" reverse tcp:5173 tcp:5173
adb -s "$ANDROID_SERIAL" reverse tcp:8791 tcp:8791
npx cap run android --target "$ANDROID_SERIAL" --live-reload --host 127.0.0.1 --port 5173
```

如果 Capacitor target ID 与 adb serial 不同，用 `npx cap run android --list` 自动映射同一真机。

### APK 预构建必须提前做

完成 Android 空壳、主题、icon/splash 最小接线后立即执行，不得等全部功能完成：

```bash
npm run build
npx cap sync android
cd android
./gradlew :app:assembleDebug
ls -lh app/build/outputs/apk/debug/app-debug.apk
adb -s "$ANDROID_SERIAL" install -r app/build/outputs/apk/debug/app-debug.apk
```

必须把 exact APK path、size、debug signature、device package path 记入验证文档。Debug app 使用 `.dev` applicationId suffix，禁止为了签名冲突擅自卸载已有 App。

## 6. UI 实现不可擅自改风格

- 主视觉：黑/深海军蓝 + 电光蓝，男性化、街舞、克制、技术感。
- 禁止可爱卡通女生、粉色少女化 UI chrome、花哨渐变糖果风。
- Light 是同组件 token 映射，不另造布局。
- 底部：曲库 / 今晚歌单 / 演出模式 / 我的。
- 顶部场景：耍酷 / 性感 / 户外 / 转场，多选 AND。
- 左侧状态：会跳 / 正在练 / 想学，单选。
- “+ 收录舞蹈”要让人知道“收的是舞”：来源会变成原视频 + 原音乐片段 + 歌曲信息 + 状态/标签。
- Dance Detail 的“查看原视频”必须显眼，与“播放音乐”并列或同一级，不得藏 overflow。
- 所有触控目标 ≥48dp。
- 原型里的 K-pop 人物/封面只是视觉占位，不得打包进正式 App；正式内容来自用户媒体/来源截图/系统占位。

## 7. 媒体真源铁律

- `PerformanceClip` 必须来自 `SourceMedia`。
- 识曲只写 SongIdentity，永远不能拿“识别到的完整版歌曲”替换原片段。
- 裁剪是非破坏的 start/end 或派生文件。
- 能 stream copy 就不重复有损转码；不兼容时允许一次 AAC 兼容转码。
- ≥10 条媒体真源抽样必须在最终 gate 前通过。

## 8. 抖音/平台安全边界

- 不开发 generic URL downloader、不绕过平台限制、不接不稳定“无水印解析站”作为核心依赖。
- 链接只走注册 SourceAdapter + whitelist/SSRF guard。
- adapter 不能合法取得媒体 -> `NEEDS_INPUT` -> 一键选本地视频补充。
- 在外分享 -> PendingShare 本地保存 -> 回家 Mac Mini 可达后继续。

## 9. 哪些动作你可以自行做

无需中途问人即可：

- 在**新项目目录内部**创建/修改源码、测试、文档、android/ 原生工程；
- 安装项目级 npm 依赖；
- `npx cap add/sync/run android`；
- Gradle debug/release buildability 构建；
- ADB reverse、install -r 本项目 `.dev` debug APK、启动/截屏/日志读取；
- 建/迁移项目自己的 SQLite；
- FFmpeg 处理项目测试/用户明确导入的媒体；
- 构建并运行隔离的项目 Docker 容器（不占用 P038 端口，不删除 volume）。

## 10. 连续开发仍然禁止的破坏性动作

Human Gate 前不要执行：

- Git push；如项目治理要求 commit，也先保持工作区/本地临时 commit，最终报告，不向远端推送；
- 删除/覆盖 P038 或其他项目；
- 卸载手机现有正式 App、清设备数据；
- 修改用户级 shell/IDE 全局设置；
- 删除共享 Android SDK/JDK/Gradle cache；
- 创建/替换正式 release keystore 或修改用户现有 signing key；
- 删除原始媒体或无法恢复的数据；
- 把 API key 写入 Git、客户端或日志。

如果某个任务原本似乎需要上述动作，改用非破坏性替代方案完成能完成的部分并记录，不要中途找用户。

## 11. 最终验证

Human Gate 前至少必须全部有证据：

- tsc/lint/unit/integration/build = 0 failure；
- path traversal / SSRF / fake MIME / Range / provider failure tests；
- provider off、cover fail、Douyin adapter unavailable 仍可收录/排队；
- light/dark 关键屏真机截图；
- local-file 从空库完整收录；
- 详情“查看原视频”；
- 3状态/4标签 AND；
- Android 分享 online/offline/duplicate；
- 完全断网冷启动；
- 10 首今晚歌单 Ready/negative test；
- 自然播放结束不自动连播；
- debug APK exact path/size/signature + install evidence；
- release buildability 状态（没签名就明确 unsigned，不能谎报）；
- FR/SC/task/evidence 追溯矩阵无缺口。

## 12. Human Gate 输出

只有当 T001–T095 全部 `[x]` 后才停下来找用户。一次性给出：

1. 当前完成度与 Git 状态；
2. 手机上可直接验收的操作顺序；
3. Debug APK 路径/大小/签名与 release build 状态；
4. Docker/API 地址与运行状态；
5. 自动化测试、媒体真源、安全、离线、UI 证据；
6. 未做的仅限需要用户明确批准的动作（正式签名/keystore、commit/push、长期部署等）；
7. 明确写 `HUMAN_GATE_READY`。

除这一个最终 Human Gate 外，不要在中途等待“继续”、不要逐 task 报请示、不要让用户替你做普通工程判断。持续推进直到规格完成。
