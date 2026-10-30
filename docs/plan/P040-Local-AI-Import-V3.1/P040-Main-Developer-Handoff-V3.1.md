# P040 本地 AI 自动提取伴奏｜唯一主开发者交接 V3.1

你是 P040 唯一主开发者。用户已确定 V2.1 唱歌练习/KTV 演出继续实施，下一阶段增量开发 **Mac mini 本地 AI 智能批量导入**；不走 ORCA Manager/Supervisor/角色 Gate，可按需派继承主模型的执行子代理，完成一次检查后自行推进下一项。

## 唯一目标

用户已把自己的音乐从 NCM 转成 MP3，并有配套 LRC，Mac mini 上的**确定路径** `/Volumes/三星/网易云音乐/音乐（用于转换）`（递归查找，照片显示 `ncm/已转换` 层级，但需按磁盘事实定位）。用户只需选一次文件夹，系统自动扫 MP3/LRC→识别曲名、版本与重复→高可靠配对歌词→在 Mac mini **本地使用预训练人声分离模型“提取伴奏”而非重新生成伴奏**→检查音轨时长、歌词与同步→保存原唱/提取伴奏/LRC/结构为同一首 `VOCAL` 曲目→安卓手机曲库练唱、今晚节目单缓存、演出默认伴奏并可切原唱。大多数正常歌曲零人工；歧义只列异常，不强配、不影响其它歌曲。无需云 AI Key、无需第三方上传音频。

## 首先核对现状

读 P040 真实最新 `AGENTS.md`、`HANDOFF.md`、相关 SPEC/PLAN/TASKS、`src/lib/vocal/`、`src/components/MultiImportSheet.tsx`、`src/lib/offline-manifest.ts`、`src/lib/sync.ts`、`src/pages/PerformancePage.tsx`、`server/repertoire/service.mjs`、`server/import/import-service.mjs`、`server/db/migrations/0007_vocal_tracks.sql`、`git status` 和 Git diff。已有大量**未提交的 V2.1 业务改动**，不可覆盖、reset、擅自推送，也不得对已有 DB/手机生产包做测试。真机操作需遵守项目设备锁（note11tpro 禁无授权操作）。先备份与 DB 副本验证。

## 本包现成可用资产

先运行 `python3 -m unittest discover -s tests -v`，然后运行 `python3 tool/verify_real_samples.py --root "/Volumes/三星/网易云音乐/音乐（用于转换）" --report /tmp/p040-real-music-audit.json` 逐首核对真实截图样本；**本包的 `docs/Real-Music-Samples.json` 已给出 8 组测试歌曲**；把 `tool/p040_smart_import.py` / `tool/run_separation.py` 当作源代码起点而不是“已完成产品”。本包 31 项测试覆盖文件名不一致、中英韩、多 LRC、完全重复、同名不同音频、8D 隔离、LRC 超时、路径安全与预检。它输出仅本地 JSON 预检报告和真实 CLI `audio-separator --single_stem Instrumental` 的待执行任务清单；模型**未在用户 M4 上跑过**。安装模型前核实 Apple Silicon MPS/CoreML、版本/权重许可及输出名，先用一首真实歌曲验证再推广。

## 连续实施

1. 严格照 `P040-Local-AI-Import-Full-SDD-V3.1.md` 全部 T0–T8：导入目录白名单、安全扫描→配对去重→Mac 原生 audio-separator/可选 MLX A/B→持久队列→媒体与歌词事务入库→UI/演出离线→实际质量/速度 QA。
2. 复用现有 SQLite/媒体注册、`repertoire_items`/`source_media`/`performance_clips`、双音轨和节目单 `{kind,id}`；不要重写四 Tab、舞蹈/吉他、已有唱歌播放器。更新 `src/lib/vocal/import-contract.ts` 中“伴奏生成”错词为“提取伴奏”，保留旧音频兼容。
3. 没有 LRC 才启动本地转写的低优先级回退；用户已经有大部分 LRC，不要大规模调用 Whisper/云查歌词。已知结构只标记有依据的部分，Rap/旋律重复的不确定性保留手工修正。
4. 建立 Mac 任务持久化/失败重试，确保手机关屏、浏览器关闭与重启后继续，APP 端正常完全零远控，异常只点重试即可。
5. 自动测试、API 集成与 DB 副本、Android 离线冷启动、模型 A/B 音质、曲库/节目单/演出 UI 真机回归连续推进；文档过期同步改 README/SPEC/TASKS/HANDOFF。只有账户授权、真实手机验收、生产写入/发布等真正不可代办环节集中请示，不要阶段中断。

## 当前真实性边界

本包并非已在 P040 Mac mini 正式工程部署的 V3.0；**用户已提供 Mac mini 上的真实绝对路径**，但当前只读连接无法直接访问该卷；截图所示真实 MP3/LRC 未在当前对话中提供文件字节，不能声称“已提取这些歌的伴奏”。该开发包不含真实歌曲及权重。不要把隔离测试结果冒充实际音质、实机 APK 验收。

## 真实样本实测指令（补齐 T7，不再反复找用户要歌）

先在 Mac mini 上检查 `/Volumes/三星/网易云音乐/音乐（用于转换）` 是否存在、能否读到音乐。执行本包 `tool/verify_real_samples.py` 定向核验，覆盖 3LAU（逗号空格）、2Someone（多艺术家）、4MINUTE（韩文）、5 Seconds of Summer（标准英文）、宝石 Gem（(1) 重复副本）、8D Tunes Mood（8D 与短 LRC）、88rising Midsummer Madness（歌手名不完全一致）、可选的 senorita 翻唱。**必须用用户现存真实字节进行后续分离和听测；不能用压缩包的合成 MP3 代替最终音质验收。**先选 3LAU、4MINUTE、宝石 Gem 三首跑质量/内存/进度 A/B；复杂 8D、88rising 作为异常验证。执行时只读原目录、输出到独立工作目录，禁止改动来源。
