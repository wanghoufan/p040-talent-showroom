# HANDOFF｜个人舞蹈曲库 V1.5

更新时间：2026-10-02 18:05（Asia/Shanghai）。本文件取代此前过时的编排交接，是恢复开发的当前快照。

> 恢复后新增：已构建并真机复验 **bundled 交付态 APK**（非 live 预览），修复 https→http mixed content 导致的接口/媒体被拦截；LAN 连通、31 曲库、同步 62 文件、快速播放均通过。详见 `docs/verification/bundled-build.txt`。用户已授权 commit+push(main)。仍未完成：T064 离线冷启动、「播放没有声音」实际出声验证。

## 1. 当前状态与执行边界

- 用户明确要求暂时结束开发，当前已暂停。不是完工，也没有到 Human Gate。
- 总目标：按 SDD V1.1 完成个人舞蹈曲库 V1.5，T001–T095 全部实现、验证、留证后，进入 T096 用户验收。
- PROJECT_PHASE：DEVELOP；开发暂停不改变产品阶段。基线：`specs/001-personal-dance-library/plan.md`、`spec.md`、`tasks.md`、`data-model.md`、`contracts/openapi.yaml`。
- 用户专门覆盖指令：本窗口/接续智能体亲自负责全部开发、测试和交付，不作为编排者，不派角色或子智能体；固定使用 note11tpro。不要恢复旧 ORCA 派工链。
- Git 分支：`codex/personal-dance-library`。尚未 commit/push。仓库存在启动前的用户变更（含 README.md 删除）以及大量未跟踪文件；不得 reset/clean、覆盖或擅自归因。本轮没有修改 AGENTS.md 和 USER_MODEL_OVERRIDE.md。
- 正式签名、commit/push、正式长期部署留 Human Gate，不因为泛化的默认部署规则擅自执行。

## 2. 已实现及已验证的进度

### 输入、视觉与真实素材

- 用户原始提示词和 ZIP 位于 `docs/plan/`，名称分别为：
  - `2026-10-02 - Mac Mini - ChatGPT - 个人舞蹈曲库连续开发-提示词 - V1.1.md`
  - `2026-10-02 - Mac Mini - ChatGPT - 个人舞蹈曲库SDD开发计划包-附件 - V1.1.zip`
- ZIP CRC 与 19 个可定位 manifest SHA256 核验通过；安全接入 `.specify/`、`specs/`、`reference/`、`assets/`、相关 docs，没有覆盖既有文件。ZIP 根提示词名称乱码未解压，使用独立中文提示词。
- 主视觉 SSOT：`reference/ui/prototype-dark-approved.png`，以及 light 对照；UI 合同：`docs/ui/ui-contract.md`。已查看原型并按黑蓝配色、左侧状态、顶部场景标签、舞蹈卡片、底栏四 Tab 实现基础页面。
- `导入素材/按作品分割` 下 31 MP4，`导入素材/按作品分割_MP3` 下 31 同名 MP3；全部 62 文件 ffprobe 有效、31 对完整配对。
- 31 个真实视频已通过本项目 API 导入开发 SQLite，生成来源音轨及取帧封面。目录核验得到 31 条 DanceItem、31 原视频、31 音频、31 封面，catalogVersion 32。原件 SHA 未改变。
- 导入报告：`var/import-first-batch.json`；真实库：`var/personal-dance-library.db`；派生媒体：`var/media/`。都已忽略 Git。没有把 MP3 再次导入造成重复；原始 MP3 保留。
- 当前条目默认“想学”、无场景标签，标题沿用文件名、歌手“未识别”，没有真实识曲服务。

### Web / API / 数据 / 媒体

- React 19 + TypeScript + Vite 7 + Capacitor 8 工程和 ESLint/Vitest/node:test 建立。Node 24.19.0，npm 11.17.0。
- SQLite 使用 Node 内置 node:sqlite，migration 事务、WAL、foreign_keys、busy_timeout；八张计划表及固定状态/标签约束。
- API 已有 health、catalog 筛选、文件 streaming 收录、链接 NEEDS_INPUT、导入状态/确认保存、详情查询、状态/标签/歌名/歌手修改、opaque ID 媒体 GET/HEAD 与 Range。
- 媒体使用 execFile 参数数组；ffprobe 校验、SHA/size、AAC/MP3 优先 stream copy、必要时单次 AAC 转码、视频取帧；修改歌名不替换来源音轨。已有真实 fixture 证明 AAC packet hash 一致、原媒体 hash 不变。
- 安全已有 controlled-root realpath 防 traversal/symlink escape、明确 HTTPS 抖音主机白名单、IP 私网/回环/link-local 等拒绝。链接下载没有通用抓取，当前返回 NEEDS_INPUT；DNS/redirect 完整接入和测试尚缺。
- disabled/mock RecognitionProvider 已有超时/异常/坏响应降级测试；无 key 可正常收录。
- 前端已实现：曲库及筛选、卡片快速播放、收录面板、导入确认、详情、原视频播放、主题和私有 API endpoint 设置。今晚歌单与演出模式仍是空壳。
- snapshot 在 localStorage，仅提供目录快照，不能冒充真实离线音频缓存。

### 测试及真机证据

- 暂停前最近一次完整检查：Vitest 3 文件 4 测试、node:test 8 测试、ESLint、tsc/Vite build 均通过。本次重新安装前 Web build 再次通过。
- 覆盖数据库约束/迁移、上传→处理→保存、来源音轨不变、重复来源、伪 MIME、provider 降级、路径/SSRF、endpoint/theme、状态和标签 AND 全组合。证据及 RED 输出在 `docs/verification/`。
- npm audit 已去除原有 critical/high，仍有 5 个 moderate 开发依赖问题待审查；不能写“零漏洞”。
- 固定真机已实际验证曲库 31 条、搜索 Levitating 得 1 条、滚动、主题切换、快速播放、详情到原视频一击播放并自然结束。截图在 `docs/verification/screens/`。
- 深色页系统状态栏/导航栏仍白色，尚未修；原视频初始 loading 时 paused=true 不代表播放失败，后续已实测播放至结束，不要误修 autoplay。
- `tasks.md` 仍未逐项更新复选框；`task-ledger.md` 和 `official-baseline.md` 有过时初始信息。应按实际证据修正，不能批量勾选。

## 3. 最新“重新安装”结果及未闭环点（恢复首要任务）

- 固定设备：ADB `192.168.31.63:5555`，marketname `Redmi Note 11T Pro+`，model `22041216UC`，device `xagapro`，用户称 note11tpro。
- 另一个 USB 设备 `indq5xfi6hovay4d` 是 Note12 Pro，禁止改用它替代固定真机。
- 本次先构建/覆盖安装成功，但启动出现 `net::ERR_CLEARTEXT_NOT_PERMITTED`，已定位为 debug Manifest 没允许开发 HTTP。
- 新增 `android/app/src/debug/AndroidManifest.xml`：仅 debug 设置 usesCleartextTraffic=true。主 Manifest 未扩大 release 权限。
- 修复后再次离线 Gradle BUILD SUCCESSFUL，`adb install -r` 再次返回 Success；没有卸载，没有清数据。已启动 MainActivity。
- 最后新进程 PID 31468；转发 `tcp:9225` 到 `webview_devtools_remote_31468` 的命令被用户暂停打断，可能执行也可能未执行。**修复后的最终页面、31 条曲库和播放尚未复验，不可称重新安装已全部验证。**
- APK：`android/app/build/outputs/apk/debug/app-debug.apk`，最后实测大小 11,338,758 bytes（若后续重建必须重测）。debug 签名；此前证书 SHA256：`8e82a7975008e8ec87ff0f2ecadf495b5263effa34aaec9ab6f135ebea911cf3`。
- APK 内含开发预览 server.url `http://127.0.0.1:5173`；安装后的 App 依赖 Mac Vite/API 和 ADB reverse。不是完整独立离线交付版。
- 构建后已运行 cap sync 恢复源目录 config，无 server.url；因此**项目源目录配置与当前 APK 的 live 配置不同**。下次普通构建将变成 bundled 模式，须先完成 native 私网 endpoint/CORS 等连通方案。
- 本次构建证据：`docs/verification/reinstall-build.txt`。恢复后第一步确认 phone 页面、目录、播放，再补 screenshot/结果。

## 4. 下一步任务顺序

1. 完成本次重装复验；重新核实目标设备、启动 PID、ADB reverse、专用 WebView forward；验证 31 条曲库及一次播放并留证。整理真机 session 能力预检及任务证据，不以命令成功代替产品结果。
2. 修正交接外的旧证据文档与 tasks 状态；核实 T003 P038 来源复用记录。T015 要求 USB，目前固定机只有网络 ADB，不能记 USB PASS。
3. 补收录/来源音频：非破坏裁剪 UI/API、恢复完整音频、≥10 媒体样本报告；适配器模块、桌面 drop、人工封面、候选识曲 UI；NEEDS_INPUT 补视频时必须保留原链接（目前打开新上传导致链接丢失）。
4. 实现 Android 分享 cold/warm ACTION_SEND text/plain 和受支持 video/*、去重 token、PendingShare 先本地落盘、离线保存、适配器缺能力提示及四场景真机测试。
5. 实现真实离线：sync manifest、Android Filesystem temp→atomic replace、size/hash/version 校验、目录+指定音频/封面持久化；断网冷启动和 missing/hash/version negative tests。
6. 实现今晚歌单 CRUD/排序/清空、稳定事务、逐首准备离线，演出大按钮/手动下一首；自然 ended 只停。10 首断网、人为删一文件 readiness 失效、自然结束多轮实测。
7. 补安全删除（记录默认、媒体二次确认及引用检查）、离线视频学习、真实缓存统计/清理、lastSync；修系统栏、mini player 可达性、原生 audio controls 触控尺寸。
8. 完成 CORS/OPTIONS、静态 dist 服务（当前 Docker UI 尚不能靠 server/index.mjs 正常提供）、准确 source MIME/container（目前凭 codec 推断可能错误）、DNS/redirect/Range/provider/删除引用安全回归。
9. backup/restore 与独立 Docker build/run/rollback；不影响 P038 或其他服务。再完成自动化全套、最终非 live APK 升级保留数据测试、unsigned release 可构建性、关键页面双主题真机视觉检查。
10. 建 FR-001～FR-028 / SC-001～SC-010 → task/evidence 矩阵，补齐 T001–T095 后生成 HUMAN-GATE.md，才请求 T096 用户验收。

## 5. 快速恢复环境

- 2026-10-02 17:00 暂停时仍在监听：Vite localhost5173，PID93745；API localhost8791，PID67419（watch）。未停服务；后续 PID/存活需重新查，不能假定旧 exec session 可恢复。
- 先查端口：`lsof -nP -iTCP:5173 -sTCP:LISTEN` / 8791；不得擅自杀其他服务。项目正常启动命令：`npm run dev`、`npm run server:dev`。
- Web/API：`http://127.0.0.1:5173/` / `http://127.0.0.1:8791/api/health`。
- 构建：`npm run build`、`npx cap sync android`。
- 本项目 Capacitor 8 实际要求 Java21。使用已有 `$HOME/android-toolchain/jdk-21.0.12.1+1/Contents/Home`；SDK `$HOME/android-toolchain/sdk`，API36/buildtools36；Wrapper8.14.3。不改共享环境/SDK/JDK，不使用 baseline 文档里旧的 Java17 构建。
- Android：`JAVA_HOME="$HOME/android-toolchain/jdk-21.0.12.1+1/Contents/Home" ANDROID_HOME="$HOME/android-toolchain/sdk" ./android/gradlew -p android :app:assembleDebug --offline`。
- ADB 所有动作指定 `-s 192.168.31.63:5555`。reverse 5173/8791，获取实时 PID 后 forward9225 到该 App 的 webview socket。`scripts/android-cdp.mjs` 只读/点击本项目页面。
- ADB、Gradle 缓存锁、localhost 调试访问在沙箱内可能被阻止；按实际失败使用平台审批申请必要权限，不能冒充测试成功。
- CDP Input.insertText 曾未真正输入；native adb tap/input text 已有效。keyevent4 可能退掉 App，避免把误退出当缺陷；优先页面返回。CDP helper 尚无 timeout，建议补齐避免挂住。

## 6. 注意事项与相关规则

- 中文沟通。直接单人完成；不让用户搬运反馈，不重复问已授权的普通实现问题。
- 将附加文档的说明与用户请求区分。AGENTS 通用编排规则不覆盖用户本次亲自开发、固定设备的专门指令；保留治理原文不擅改。
- 按需读取 Android/机器档案、SQLite、Docker/Web QA 专项规则，不扫全部中央规则。
- 安装依赖先复用有效兼容缓存；必须下载时先可信国内镜像，失败再官方国外源，保持版本与 integrity，不盲目 audit --force。
- 无真实识曲密钥使用 disabled/mock，不编造识别结果；不碰正式 keystore，不提交 env/key/token/真实素材/数据库。
- `.gitignore` 已覆盖 var/、导入素材/、按作品分割_MP3/、temp/、android/local.properties 等；`docs/verification/input-material-audit.json` 含真实文件名，发布前审查是否应忽略或脱敏。
- 保留原始媒体。清缓存只删除可重下客户端缓存；主数据/来源视频删除须遵守二次确认与引用安全。
- 暂停后未继续开发或真机测试。最终签收待用户，目标保持 paused。

目标：完整实现并验证 V1.5 后进入 Human Gate。
剩 P0：T064 完全断网冷启动（网络 ADB 只能以停后端近似）；「播放没有声音」需单独排查并证明实际出声；关键任务复选框/追溯矩阵未收尾。
下一步：先排查无声音（WebView 媒体音量/系统媒体音量/静音属性），再做 T064 冷启动离线验证；随后 Docker 静态校验、自动化全套、release 可构建性、FR/SC 追溯矩阵、HUMAN-GATE.md。

## 7. 本轮（恢复后）已做

- 已删除陈旧后台进程（8081 端口占用的 `node --watch`、失败重试的 dev job、`du /proc` 任务）；清理 `/tmp/a.bin`。
- 构建 bundled 交付态 APK 并 `adb install -r`；APK 大小 11,297,112 bytes，SHA-256 a027a59c…ecc546，debug 签名（详见 `docs/verification/bundled-build.txt`）。
- 修复交付态连通：`capacitor.config.ts` 设 `server.androidScheme: 'http'` + `android.allowMixedContent: true`，解决 https 页面加载 http 接口/媒体的 mixed content 拦截。
- LAN 起 API（`HOST=0.0.0.0 PORT=8791`）→ 真机配置 `http://192.168.31.43:8791` → 连接成功 → 同步 31 首/62 文件 → 曲库 31 卡 → 快速播放 `currentTime` 前进、无 error。
- 用户已确认最终形态：**家里 Mac 收歌/同步，手机带出去纯离线演出**（符合 spec US5 / SC-004），维持现有架构，不做手机端独立化重做。
- 用户已授权 commit + push（main）。

