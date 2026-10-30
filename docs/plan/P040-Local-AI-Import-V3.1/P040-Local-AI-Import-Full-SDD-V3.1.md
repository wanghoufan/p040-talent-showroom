# P040 才艺展示厅｜本地 AI 智能导入完整开发计划 V3.1

> 制定：2026-10-30；适用已有 P040 的唱歌 V2.1 增量项目。**执行模式：唯一主开发者**；不启动 ORCA TM/Supervisor，不引入新的用户审批 Gate；旧项目保留原有四 Tab、舞蹈/吉他能力、资料和本地 API/SQLite。  
> **正式术语：AI 人声分离 / 伴奏提取**，绝非“AI 伴奏生成/重新创作”。以原曲节拍与编曲为基准，提取去除主唱后的乐器混合音轨；提取可能留下和声/主唱残余或损伤乐器，需真实听测。  
> **目标交付**：用户在 Mac mini 选择一次 Mac mini 上已提供的 `/Volumes/三星/网易云音乐/音乐（用于转换）` 音乐目录（包含其递归子目录），MP3 与 LRC 混放即可；系统自动配对、检测版本/重复、提取伴奏、整合歌词、保存同一首曲目，手机同步用于练唱及 KTV 演出。无需用户手动给每首歌提供独立伴奏，不需要云端 AI API Key。  
> **基线**：V2.1 已存在双音轨、练唱、节目单和演出模式的未提交代码；V3.1 只在此基础上增量接入本地 AI 导入。不得拿旧 starter 压缩包覆盖实际 P040 未提交代码。  
> **本包状态**：已在隔离环境实现可运行的文件扫描/配对、LRC 检查和伴奏提取命令任务规划器及一个“需显式执行”的音频分离适配器，31 项自动化测试通过。**尚未在用户 M4 上安装或运行真实分离模型；未修改真实 P040 本地数据库/源码；没有用截图中的真实 MP3 实测音质。**

## 0. 用户确认的全部产品决定（不可丢）

1. 单次可以选择**整个本地文件夹**；MP3 + 同名/近似同名 LRC 已有，直接使用，避免用 Whisper 重新猜歌词。
2. 默认 **Mac mini M4 24GB 在 macOS 原生运行本地 AI**；不依赖收费云 API。模型权重首次下载及选用联网歌词查询是可选外部依赖，不等于把 MP3 上传云端。正式模式优先完全本地，无歌词才询问是否启用在线歌词检索。原始 MP3 不上传第三方。
3. 自动执行 **MP3 身份识别（文件名、ID3 和 LRC 标签交叉核验）→ MP3/LRC 关联→ 音频提取伴奏（人声分离）→ 歌词时间线检查 → 结构分析 → 入库**。对存在歧义的条目留在待核对队列，其余歌曲继续自动处理；不因一首失败阻塞整批。
4. 伴奏是**提取**，不是 AI 合成新编曲。**原唱文件保持原始比特和原名**；生成新的 *派生媒体文件*，后端记录来源哈希、模型、参数、处理结果、音质待确认状态。
5. 同一首歌只有一个 `songId`，关联 `original` 与 `accompaniment` 两轨、`lyrics`、`sections`。歌词 LRC 的文本和原时间戳优先保留，有漂移才校准；不能制造假的同步时间戳。
6. 保留原 P040 曲库顶部「舞蹈/吉他/唱歌」，底部四 Tab「曲库/今晚节目单/演出模式/我的」。唱歌曲库筛选只有紧凑两行：状态和语言，**无 Rap 含量筛选**；练习时 Rap 跳段和 N 句循环保留。
7. **演出默认伴奏**，可切到原唱，尽量保持时间位置与暂停状态；舞蹈/吉他不变，今晚节目单仍是统一多才艺曲目序列，提前下载离线音乐/同步歌词，无伴奏时明确缺失。
8. AI 识别的主歌/副歌/Rap/重复歌词结构只作为标注建议；不能把“旋律相同而歌词不同”当成不需要学习。自动结构识别尚无成熟通用高可靠保证，必须有校准/unknown 状态。
9. 显示名称示例：`3LAU, Carly Paige — Touch`；8D、翻唱、Live、Remix 等版本保留版本标识。物理文件不依赖中文名称，采用不可变内部 ID，避免文件改名导致丢媒体关联。
10. 开发在唯一主开发者模式下连续推进，不需要中途等待“继续”；仅真正不可代办的授权、生产发布、设备使用和破坏性操作单独提出。

## 1. 已读取的实际 P040 起点（2026-10-30，只读证据）

P040 仓库：`/Users/zzymima0000/Developer/coding/1.Active/040-ing-才艺展示厅`，`main...origin/main` 有大量**未提交修改**，包含 `server/repertoire/service.mjs`、`server/sync-operations.mjs`、`src/lib/types.ts`、`src/lib/sync.ts`、`src/pages/PerformancePage.tsx`、`TonightPlaylistPage.tsx`、`TalentDetailPage.tsx`、`MultiImportSheet.tsx`，并有 `server/db/migrations/0007_vocal_tracks.sql` 与 `src/lib/vocal/import-contract.ts`。**这表明 V2.1 已有实际集成改动，开发者必须读取当前最新代码，不得从旧设计包硬复制。**

已有条件：React/Vite/TypeScript + Capacitor Android、Node 本地 API、SQLite `repertoire_items`、`import_jobs`、`source_media`、`performance_clips`、`src/lib/offline-files.ts` 本地上传与离线编辑、`src/lib/sync.ts` 全量缓存、双音轨 `original`/`accompaniment`、节目单 `{kind,id}`、演出页默认伴奏。

发现的待办/风险：

- `src/components/MultiImportSheet.tsx` 当前按**精确归一键**分组，漏掉了复杂版本和文件名不同的 LRC（如 `88rising, Joji, Rich Brian, AUGUST 08` 与 LRC 省略 `AUGUST 08`）；并且无真实 SHA-256 媒体去重和服务器目录级扫描。不能把界面旧批量导入当作新的“智能导入”已实现。
- `src/lib/vocal/import-contract.ts` 已有 AI 导入草案，但其中“伴奏生成”措辞应统一更名为“伴奏提取”，并把导入状态由笼统 `ready` 明确为技术处理完成、音质复核待定、已可演出等，不冒称人工 QA。
- `server/import/import-service.mjs` 是泛用“上传→解析→媒体入库”链路，未包含 native macOS 本地人声分离；直接复用/扩展既有媒体注册与导入任务，不重复建立并行的第二套曲库系统。
- 原有 `HANDOFF.md` 最新日期 2026-10-13，与 V2.1 未提交源码不是同一时间点；不能只读 HANDOFF 决定当前实现状态，必须比对代码、Git diff 与运行测试。
- 历史上原 Android 用户数据在 `com.wanghoufan.dancelibrary.dev`，Release 包可能为空；任何安装与真机操作必须遵守设备锁，**禁止无授权操作 note11tpro**。预检、本地副本测试与 AI 选型不需要操作手机。
- `ncm/已转换` 截图只是文件名照片，现已获知真实绝对路径 `/Volumes/三星/网易云音乐/音乐（用于转换）`，但当前对话环境无法直接挂载其卷，真实 MP3/LRC 字节仍未提供，不能报告“已在真实歌单成功提取伴奏”。

## 2. 最终使用场景与界面

### 2.1 导入入口

**主入口放在 Mac mini 管理页面**（P040 现有服务的同一账号/权限），按钮为「智能导入音乐文件夹」。本机使用 OS 文件夹选取或受控服务端目录清单，**不能让任何网络请求传任意本机绝对路径并读取**。若通过浏览器实现文件选择，可在本机管理 Web 使用 `webkitdirectory` 或系统桌面桥接：需检查上传/复制开销，优先直接引用用户指定的本地音乐文件夹，**不拷贝整批 MP3**。服务器只允许显式配置的导入根目录、禁止符号链接逃逸、只读扫描，媒体处理保存到独立 `var/media/` 下受控目录。

安卓曲库 `+` 可提供「通过 Mac mini 导入」「从手机选择音乐」两种轻入口；主要批量处理放在 Mac mini，不在手机运行大型模型、不要求传重复数据。手机页面只显示任务状态及结果、失败重试和待核对项。原先的手动原唱/伴奏上传保留为高级兜底，不作为日常主入口。

### 2.2 导入队列状态

`扫描中 → 匹配歌词 → 待提取 → 正在提取伴奏 → 校验音轨/歌词 → 已入库`，若不能确认则 `需核对`，可重新指定单首 LRC 或替换伴奏、无须重跑整批。支持取消、失败重试、退出管理页面/手机锁屏后在 Mac mini 继续跑、服务进程重启后从持久队列恢复（已完成阶段不得重算）。

正常批量入库后仍在原“唱歌”双列曲库展示，名称紧凑，不在首页新增 Rap 百分比；详情有歌词、结构地图、原唱/伴奏切换。演出页面只增加原唱/伴奏双按钮，原有四 Tab 不变。

## 3. 数据处理策略

### 3.1 扫描、配对与去重

1. 允许 MP3/M4A/WAV/FLAC、LRC。只读检查媒体格式与时长，忽略不相关文件、符号链接，禁止修改或重命名源目录。
2. 对文件名执行 Unicode NFKC、统一标点/逗号空格/大小写及中英文括号；`(1)` 等 Finder 副本后缀归一化，但不抹去 `8D Audio`、`Live`、`Remix`、`Cover`、`Radio Edit` 等版本差异。
3. 同曲唯一标识**不能只靠归一文件名**。先按音频 SHA-256 去除完全重复文件；同名但不同音频 SHA 视为不同版本/潜在冲突，暂不静默合并。
4. MP3 ID3 `title/artist`、文件名、LRC `[ti:]`/`[ar:]` 跨来源核验。确定性匹配且单一候选时自动关联；标题相同但歌手不全、同名多个歌词、翻唱、8D 版本混合等只显示候选供快速确认，不在后台错误配对。
5. LRC 支持 UTF-8 BOM、`[mm:ss.xx]` / `[mm:ss.xxx]`、多标签同句、`[offset:]`，保留原文。无时间戳、全错、最后一句明显超出音频时长分别标记；不把普通文本歌词伪装成逐句同步。
6. 处理缺歌词、孤立 LRC、伴奏已存在、配对多候选、两个文件同 SHA 却标签不同、已入库歌曲不同版本等分支。
7. 全局 songId 与原项目 UUID 兼容，优先匹配现有源 SHA/曲目元数据，禁止重复创建同一首；已有手工修改的歌词、段落优先级高于新 AI 结果。

**本包已经实现** `tool/p040_smart_import.py` 扫描器（标准库 + 可选 ffprobe），输出 JSON 预检报告与待分离的命令清单；文件名归一、重复检测、8D 严格隔离、歧义禁自动配对、LRC 解析等已做自动测试。它是**可运行预检工具**，不是已接入 P040 服务的正式后台。

### 3.2 本地 AI 伴奏提取（不是生成）

选型基线：`audio-separator` 官方支持 Apple Silicon MPS/CoreML、RoFormer 和常见源文件，CLI 可指定 `--single_stem Instrumental` 并保存 FLAC；在 macOS 原生 Python 虚拟环境运行。可把 MLX 实现作为候选在同一 Mac M4 上做 A/B，不能仅以项目 README 的速度表认定实际效果。开发**先选稳定主线**；硬件验证后决定是否启用 MLX 默认。  
源码：`https://github.com/nomadkaraoke/python-audio-separator` 与 `https://github.com/ssmall256/mlx-audio-separator`。

- 本地工作器独立于 Node API 进程运行（建议同机原生 launchd 守护/工作进程），Node/API 入队并查询任务。不要要求在普通 Linux Docker 中运行 Metal/MPS；P040 Node/SQLite 现有部署不必强制迁移。
- 模型文件预先下载缓存。首次联网下载权重可以被允许，但**音频处理不上传云端**；断网时使用本地权重。模型版本和版权许可在选择前核验。
- 从原始 MP3 产生 `instrumental.flac`（无损中间母版），必要时转换兼容 Android 缓存的 M4A/MP3（文件名只依赖曲目 UUID），保留母版与源音频哈希，记录媒体 `durationMs/sha256/sizeBytes/version`。禁止音轨覆盖、源文件重编码/覆盖。未经过质量验证的输出不应标为“干净伴奏”。
- 要做 **真实音质 A/B**：同曲同模型/设置比较 audio-separator vs MLX；主唱残留、齿音/回声、鼓和贝斯损伤、立体声/高频损失、前奏对齐、速度、峰值内存、模型冷启动；多类型真实歌曲中文/英文/韩文/多 Rap/和声重的样本至少 5 首。优先伴奏质量，再看处理耗时和内存。
- 模型效果差时可只对单首重跑更高质量模型（例如 RoFormer 模型变体或 ensemble），**不要求所有歌曲都用最慢方案**。
- “原唱切伴奏保持同一时间位置”依赖两轨时间轴；后期由分离器引入的长度或前奏差异记录 `offsetMs`，超过阈值应标记不适合现场切轨；UI 不保证无缝零延时。

**本包已经实现** `tool/run_separation.py` 任务执行器，默认 `dry-run`；主开发者在 M4 完成模型预检后明确加 `--execute`，它才调用已安装的 `audio-separator`。分离输出会做长度等技术校验并标记 `ready-for-listening-QA`，不虚构人声分离质量。注意：本包环境未安装模型、未跑真实 M4 音质。

### 3.3 歌词与结构

- 用户文件夹有配套 LRC，**优先使用**，无需默认调用 Whisper，也无需每首联网取歌词。LRC 标签能辅助确定名称/语言，不必假装大模型已识别。
- 对 LRC 与 MP3 版本差导致的统一偏移，用音频对齐步骤做建议，操作记录保持可逆，手工修正高于自动覆盖；处理前奏、说唱快句、韩文等失配。LRC 的时间戳已存在，不需要重新转写全首。
- 无 LRC 时回退顺序：本机已授权歌词库 → 可选联网 LRCLIB 按歌名/歌手/时长匹配（**只有用户启用才发元数据，不发送音频**）→ 本地模型转写补缺并标记“待核对”。自动转写演唱不稳定，**绝非默认第一方案**。
- 歌曲结构：V2.1 已有 `sections`、`lyrics` 和 Rap 区间字段。先用 LRC 重复片段/短句模式生成“歌词重复候选”，再引入有验证基础的音乐结构分析；未知段落保留 `unknown` 或 `待确认`。**不能把重复歌词直接等同于相同旋律，也不能保证自动识别 Rap 100% 准确**。
- LRC 的文本可能有版权，不把歌词或音频自动上传到公共平台，不向社区自动发布歌词。

### 3.4 批量事务入库与离线同步

- Node/API 只负责受控入队、进度查询、最终事务入库；Mac 本地分离工作器返回文件路径/校验/任务状态，**不得把模型进程直接阻塞 HTTP 请求**。
- 复用 `repertoire_items`、`source_media`、`performance_clips`、`original_clip_id`、`accompaniment_clip_id` 等现有 V2.1 迁移，并通过 `server/repertoire/service.mjs` 暴露单首双音轨媒体；新增 AI 任务/工件表/队列（例如 `0008_vocal_import_jobs.sql`）必须在 DB 副本验证后增量新增，不改已有 `0003/0007` 迁移历史。
- 原始媒体 hash 用于**幂等定位**；处理失败可按阶段恢复，同一批任务重试不复制曲目、不覆盖用户修改的歌词/结构。DB 事务确保“媒体对象可用→一次提交”且断电后可恢复；临时文件不被标为可播放。
- 手机快照里保留 `tracks.original/tracks.accompaniment`、`lyrics`、`sections` 和媒体校验字段；“准备离线演出”需至少有可用伴奏，存在原唱时也缓存供现场切轨。**只有原唱不得自动充当伴奏**。
- 节目单仍按 `{kind:'VOCAL', id:songId}` 加入，不创建多条“原唱版/伴奏版”；演出模式默认伴奏 + 双轨现场切换 + 切歌后暂停，不能意外继承跳 Rap 或倍速。

## 4. SDD 分阶段任务（连续执行，不设新增审批停顿）

| 编号 | 交付单元 | 主要代码 / 成果 | 完成判定 |
|---|---|---|---|
| T0 | 现状快照与备份 | 完整核对 P040 Git diff、`HANDOFF`、V2.1 未提交代码、真实 DB/媒体占用；建立只用于测试的 DB 副本，保护 `.dev` 数据和设备锁 | 备份可恢复；不改生产数据、不覆盖工作树 |
| T1 | 文件扫描与批量关联 | 将本包 Python 扫描器（或等价 Node 实现）集成服务端；配置导入根目录与只读目录选择；SHA 去重、版本归一、LRC 匹配、异常报告 | 截图所示错空格/`(1)` 自动配对；8D/翻唱不误并；多候选停在待核对 |
| T2 | 本地 AI 运行环境 | Mac arm64 原生 Python 虚拟环境、ffmpeg、audio-separator 预检、模型缓存、进程与模型版本记录；MLX 只作可选 A/B | `--env_info` 显示可用 MPS/CoreML；至少 1 首真实 MP3 产生两轨且时长可核验 |
| T3 | 持久任务队列 | 增量 SQLite 任务表、状态机、工作器、失败重试/取消/重启恢复、并发限流；临时/输出目录隔离 | 20 首批处理，退出 UI/短暂重启后可继续；坏文件不阻断其余 |
| T4 | 媒体入库与命名 | 注册原唱（不变）、提取伴奏 FLAC 与手机版衍生编码、SHA/时长校验、同 songId 两轨、LRC 文本与时间戳 | 单首只有 1 个曲库卡片；双轨对应不同媒体；原始媒体不变；重试无重影 |
| T5 | 结构与自动标记 | LRC 语句、重复候选、Rap/主歌/副歌建议、来源置信和手动修正优先级 | AI 不确定显示 unknown，手工修改不被重处理覆盖 |
| T6 | 管理 UI 和手机状态 | Mac 批量导入页、任务状态、仅异常小列表/快速确认；手机曲库即时显示入库结果、缓存准备 | 不新增一级 Tab；两行筛选、双列卡片、原 KTV 演出页完好 |
| T7 | 真实音乐 AB/端到端 QA | `docs/Real-Music-Samples.json` 中八组由用户截图确认的真实 MP3/LRC；不同语种/版本/多 Rap，听测、测速、断网、重启、离线演出、重复导入、数据库校验 | 关键 AC 实证通过；舞蹈/吉他、四 Tab 与原 `.dev` 用户数据无回退 |
| T8 | 文档交付与回滚 | README、SPEC、TASKS、HANDOFF、运行/恢复 SOP、故障一键重试、审查证据与已知限制 | 另一位开发者不依赖聊天上下文即可恢复；发布与真机安装仍遵守现有授权 |

**并发策略**：Mac mini 24GB 的真实内存峰值未测试前，先让 AI 分离**单任务串行**，文件哈希/歌词配对可轻量并行，稳定后根据实测内存与速度上调。正常断网不影响已缓存模型及本机 MP3/LRC，用户正常使用 APP 不必远控 Mac mini。失败时 App 展示“重新处理”而非要求打开终端。

## 5. 量化验收矩阵（AC）

- AC01 目录有 50 MP3+50 LRC，单次导入无需逐首点选；无待核对的歌曲后台自动继续。
- AC02 `3LAU, Carly Paige - Touch.mp3` + `3LAU,Carly Paige - Touch.lrc` 自动配对；另验证 2Someone/Lanfranchi/Farina 的多逗号空格差异。
- AC03 `宝石...爱的恰恰 (1).mp3` 与相应无 `(1)` LRC 可匹配；同名不同 SHA 不自动覆盖；若不同歌词内容的重复 LRC，明确待核对。
- AC04 `4MINUTE - 미쳐.mp3` 与 `4MINUTE - 미쳐.lrc` 韩文无乱码；UTF-8 BOM/offset/multi-tag 正常。
- AC05 `8D Audio`、Live、翻唱/Remix 不与普通版本合并，也不拿普通版本的时间轴盲配。
- AC06 无时间戳 LRC 仍可保存文本，逐句循环禁用并显示原因；错误时间戳不会被当正常。
- AC07 真实主唱 MP3 **提取**的伴奏可播放，节拍/长度与原唱基本一致，听测检查主唱残留、伴奏损伤；未听测不得宣布质量 PASS。
- AC08 人声分离失败、模型不可用、存储不足时，原唱+LRC 仍可入库/播放；重试只重跑失败步骤，异常显示准确。
- AC09 源 MP3/LRC **SHA-256 前后不变**；内部生成文件不覆盖来源，任务失败残留可识别、可安全清理临时文件。
- AC10 伴奏默认演出，切回原唱保持当前位置、暂停状态；下一首恢复伴奏但不自动发声。只有原唱不可误称伴奏；离线双轨可切。
- AC11 LRC 多句同步、N 句循环、多 Rap 跳段、同旋律新歌词标记、人手修改的结构持久化；AI 不确定不伪造结果。
- AC12 20+ 曲目中一首坏音频/歌词冲突不能让其他成功曲目停止；重启恢复、重复扫描与导入保持幂等。
- AC13 Node API 不允许远端提供任意 Mac 路径进行读取；源目录和网络传输有授权及路径限制，软链接逃逸被阻止。
- AC14 全量 `npm run typecheck`、`npm run lint`、`npm test`、`npm run build`、`npm run test:integration`（在本机项目环境）；Python `python -m unittest discover ...`，真实 Android QA 后才能报告完成。
- AC15 P040 既有底部四 Tab、舞蹈/吉他、节目单混排、手机真实数据不回退；不推送仓库、不动手机、不上线发布，除非已获明确授权。

## 5A. 用户真实文件夹与指定八组验收素材（2026-10-30 最新补充）

**唯一真实素材入口（Mac mini 外置卷本地路径，不是 HTTP URL）：** `/Volumes/三星/网易云音乐/音乐（用于转换）`。截图显示一个 `ncm/已转换` 层级，但不能武断假设该层级一定在指定目录之下；**先检目录，再递归定位**。如果目录有多个同名文件，必须报告相对路径候选，不可任取其一。程序只读输入，所有 JSON、提取伴奏与临时文件放在独立测试/媒体输出目录；不改名、不覆盖、不删除原音乐。

本包 `docs/Real-Music-Samples.json` 将以下真实截图文件名写为可机检清单。`tool/verify_real_samples.py` 逐条定位、校验 ffprobe/LRC 时间戳/哈希，并输出 `/tmp/p040-real-music-audit.json`；该工具**不运行 AI 模型、不写音乐目录**。

| ID | MP3（均选自用户截图） | 对应 LRC / 验证点 | 预期 |
|---|---|---|---|
| T01 | `3LAU, Carly Paige - Touch.mp3` | `3LAU,Carly Paige - Touch.lrc`，逗号后空格不同 | 格式和时间轴正常则自动配对 |
| T02 | `2Someone, Lanfranchi, Farina - Star Unkind (Lanfranchi & Farina Radio).mp3` | `2Someone,Lanfranchi,Farina - Star Unkind (Lanfranchi & Farina Radio).lrc` | 识别同一 Radio 版本 |
| T03 | `4MINUTE - 미쳐.mp3` | `4MINUTE - 미쳐.lrc` | 韩文无乱码，正确对齐 |
| T04 | `5 Seconds of Summer - Teeth.mp3` | `5 Seconds of Summer - Teeth.lrc` | 英文标准基线，真实伴奏听测 |
| T05 | `宝石 Gem,俞天时,王洋 EVIS - 爱的恰恰 (1).mp3` 与无 `(1)` 的 MP3 | 各自对应 `(1)` / 无 `(1)` LRC，测试同曲重复与版本冲突 | 音频 SHA 一样则去重；不同则待核对，禁止覆盖 |
| T06 | `8D Tunes - Mood (8D Audio).mp3` | 同名 `.lrc`；截图显示 LRC 体积很小 | 8D 作为独立版本；空/无时间戳不伪造同步 |
| T07 | `88rising, Joji, Rich Brian, AUGUST 08 - Midsummer Madness.mp3` | `88rising,Joji,Rich Brian - Midsummer Madness.lrc`，歌手列表不同 | 只提供候选，必须待核对 |
| T08（可选） | `陈从雨xiaoyu0,石玺彤 - senorita (翻自 Shawn Mendes) (1).mp3` / 无 `(1)` 版本 | 相应 LRC；翻唱标识、重复副本 | 翻唱与原版隔离，不无声覆盖 |

**真实验收分两级**：第 1 级先核实文件真实存在、可解码、LRC 有有效时戳、配对策略正确、原文件 SHA 不变；第 2 级才用至少 3 首不同语言或编曲的真实歌曲在 M4 上运行本地模型，人工对照听测伴奏残留/乐器损伤/时间轴/两轨现场切换。对于截图中看似配对但缺文件、歌词无时戳或 ID3 不一致的，一律如实标异常，不预先断言全部 PASS。

**Mac mini 桌面端可直接执行：**

```bash
# 1. 只检外置卷是否已挂载，不修改任何文件
ls -ld '/Volumes/三星/网易云音乐/音乐（用于转换）'
# 2. 本开发包根目录下，定向验证截图的 8 组文件
python3 tool/verify_real_samples.py --root '/Volumes/三星/网易云音乐/音乐（用于转换）' \
  --report /tmp/p040-real-music-audit.json
# 3. 目录全量只读扫描与提取任务预览，暂不执行分离模型
python3 tool/p040_smart_import.py '/Volumes/三星/网易云音乐/音乐（用于转换）' \
  --report /tmp/p040-all-preview.json --tasks /tmp/p040-all-tasks.json --output /tmp/p040-extracted
```

目录不可读时先定位卷挂载状态和文件是否位于其子目录；不得替用户编造路径、主动复制私有音乐或上传云端。**这份真实样本清单已明确，不再反复询问用户提供歌曲名或路径。**

## 6. 开发依赖预检（开工前一次性检查，不能中途反复让用户准备）

| 依赖 | 本次结论 | 类别/处理时机 |
|---|---|---|
| P040 Mac Mini 路径、Git 与未提交业务改动 | **已只读核查**，存在大量未提交修改 | B：主开发者先备份与 diff，禁覆盖 |
| Mac mini 实际音乐目录与 MP3/LRC 读权限 | **已给出绝对路径** `/Volumes/三星/网易云音乐/音乐（用于转换）`；外置卷是否挂载/可读未验证 | B：开发者自行 `test -d` 并执行只读定向扫描；本次不要求用户重新提供路径；卷未挂载时先做其他工作 |
| Python/macOS arm64、ffmpeg、磁盘与 Metal/MPS | 软件仓库支持，**本机是否已装/兼容尚未实测** | B：主开发者自行检查、安装隔离 venv、缓存模型；遇到收费/管理员权限才请用户 |
| 分离模型权重、许可证、模型大小及一次联网下载 | 可以本地运行；具体候选模型及许可证仍待实测确认 | B/C：下载只需一次、缓存后离线，不用 AI Key；用户不提供任何音频到云端 |
| GH 仓库及账号 | `wanghoufan/p040-talent-showroom` 先前可读；现有 `main` 工作树有未提交改动 | B/D：无需 GitHub 才能开发；commit/push/PR/发布由现有授权约束 |
| Mac mini 本地 Node API、SQLite | 现有架构；**当前在线状态/真实数据盘未实测** | B：在测试 DB 副本完成可做工作，生产环境最后验收 |
| Vercel、域名、DNS | 本次**不需要** | C：绝不当成开工硬阻塞 |
| AI 云 API Key/余额、云数据库 | **不需要** | C：不索取、不引入付费云服务 |
| 手机/真机、设备锁、`.dev` 版本数据 | 历史 `HANDOFF` 有禁止擅动 note11tpro 的要求 | D：全部非真机代码及自动化先做；真正安装与操作前按历史授权执行 |
| 版权及模型许可证 | 用户自行拥有/授权使用相应歌曲；不得擅自发布音源、自动爬站或共享歌词 | D：个人本地处理先行，正式分发/商用另审 |

开工 A 类硬阻塞：**无**（可先完成目录扫描、API/DB 隔离开发与合成素材测试）。真实歌曲质量验收最终需要在 Mac mini 本机读到上述目录中的 MP3/LRC；若盘未挂载/无权限，先推进不依赖此环节的全部工作。

## 7. 源码与运维接口约定

- Python 工作器输入：指定且授权的目录根（独立文件夹选择）、可选 songId、提取引擎/模型版本、输出根。Node 后端**不接受 arbitrary path 请求**，先把真实路径解析并确认落在预先许可的根目录内。
- 输出预检 JSON：`schema/sourceRoot/summary/songs/duplicateFiles/duplicateLyrics/unpairedLrc/orphanAccompaniments`，`songs[].status` 有 `ready-to-extract` 与 `needs-review`；实际开发可加 `errorCode` 与 `confidence`，但不能替代歧义处理。
- 输出待提取任务 JSON：`tasks[].songId/title/command/input/expectedOutput`。这是工程的命令适配层，不是直接可入库元数据；执行成功还要生成 `sourceSha256/accompanimentSha256/model/version/duration/qualityReview` 和数据库媒体注册。
- 建议后台 REST：`POST /api/vocal-import/scan`（受权目录/已登记选择令牌，不是绝对路径）、`GET /api/vocal-import/jobs`、`POST /api/vocal-import/jobs/:id/retry`、`POST /api/vocal-import/jobs/:id/cancel`、`POST /api/vocal-import/jobs/:id/resolve`。只在已验证服务端权限模型上扩展，所有操作可重试且幂等；**不新增公开上传入口**。
- Python worker 启动：使用已有 Mac mini 主机后台进程服务守护；模型第一次下载后可断网工作；失败可在 APP 点击重试。CPU/MPS 状态与进程退出码可写本地日志，但日志不得泄露手机 token、用户名、敏感路径到前端。
- 文件命名：用户可见「歌手 - 歌名（版本）」；内部 UUID 目录 `songId/original.ext`、`songId/accompaniment.flac`、`songId/lyrics.lrc`、`songId/analysis.json`。**源文件原名与原内容均保持不变**。

## 8. 真实 QA 的不可替代边界

本交付可以证明的是扫描器、匹配、时间戳处理和任务计划代码在此隔离容器通过了单元测试；**不能证明** `audio-separator`/MLX 在用户 Mac mini 的模型实际推理、音质、处理速度和内存占用，更不意味着完整 P040 V3.0 集成、Android APK 和用户真机已验收。要完成本次整体软件开发，必须由具备 Mac mini **写权限**的桌面唯一主开发者把代码集成到真实仓库，实测 M4 并验收。

不得为了“报告完成”把任何尚未执行的模型运行或真机验证标成 PASS；把已完成的 31 项扫描/安全测试与尚未完成的 M4 音质及正式集成分开记录。遇到普通修复和测试自行继续，不因内部阶段暂停。

## 9. 参考来源（2026-10-30 核实）

- `https://github.com/nomadkaraoke/python-audio-separator`：官方支持 Apple Silicon 的 MPS/CoreML、预训练 RoFormer、CLI `--single_stem Instrumental`、FLAC 输出、可配置模型与输出目录；该支持不等于本机已安装验证。
- `https://github.com/ssmall256/mlx-audio-separator`：Apple Silicon 原生 MLX，项目自测 M4 mini 相关加速数据；非独立测试结论，因此只用作 A/B 候选。
- `https://lrclib.net/docs`：在线元数据搜索和 LRC 服务可作**明确选择后的**兜底；当前用户有本地 LRC，默认不联网检索。
- P040 当前代码：`src/components/MultiImportSheet.tsx`、`src/lib/vocal/import-contract.ts`、`src/lib/offline-manifest.ts`、`src/lib/sync.ts`、`server/import/import-service.mjs`、`server/repertoire/service.mjs`、`server/db/migrations/0007_vocal_tracks.sql`、`src/pages/TonightPlaylistPage.tsx`、`src/pages/PerformancePage.tsx`、`docs/handoff/HANDOFF.md`，只读检视，未修改。
