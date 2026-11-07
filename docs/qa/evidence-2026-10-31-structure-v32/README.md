# P040 V3.2 结构地图｜定向证据（2026-10-31）

本轮为「主开发者执行代理」连续执行 T0–T8 的证据汇总。**真机安装与首次发布签收仍由主代理/用户完成**；本文不宣称准确率通过。

## 1. 隔离与红线

| 项 | 实测 |
|---|---|
| 生产库 `var/personal-dance-library.db` | 339,968 B，mtime 2026-10-14 10:02，SHA256 前 16 位 `6c246314de6e3cd2`，本轮全程只读 |
| 源素材目录 `/Volumes/三星/网易云音乐/音乐（用于转换）` | exfat 只读读取；五首原曲分析前后 SHA 一致（见 §3） |
| 导入后台 worker | `VOCAL_IMPORT_WORKER` 默认 `0`（`server/vocal-import/config.mjs:76`），本轮未开启 |
| 分离进程 | 运行期 `ps` 未见 demucs / audio-separator / spleeter / uvr |
| git | 未 commit、未 push；保留既有未提交改动（`server/index.mjs`、`src/index.css`） |
| 长驻服务 | 未启动常驻服务；测试用临时 SQLite 与临时目录 |

## 2. 自动化定向测试（全部隔离数据）

| 命令 | 结果 |
|---|---|
| `node --test tests/vocal-*.test.mjs` | 160 pass / 0 fail |
| `node --test tests/vocal-structure-map.test.mjs tests/vocal-structure-service.test.mjs tests/vocal-import-{created-row,integration,original-only-retry}-v31.test.mjs` | 65 pass / 0 fail（日志 `node-tests.log`） |
| `npx vitest run tests/unit/vocal tests/browser/vocal` | 137 pass / 0 fail（16 文件） |
| 其中结构专项 `tests/unit/vocal-structure.test.ts`、`tests/browser/vocal-practice-player.test.tsx`、`tests/browser/vocal-structure-editor.test.tsx` | 34 pass / 0 fail（日志 `vitest.log`） |
| `npx tsc -b` | 通过 |
| `npx vite build --outDir .local/build-check --emptyOutDir` | 通过（独立目录，未覆盖 `dist/`） |

覆盖到的关键行为：没有音频证据不造段；歌词不参与类型判定；越界/重叠/悬空关系拒绝；按歌词句拆分与相邻合并；改类型清关系；Rap 仅逐段显式确认后可跳过（保存结构不等于确认）；韩文同句可判同词、韩中译文不可判同词；草稿与正式结构隔离、旧结构快照与恢复、手工结构覆盖需显式确认；未配置分析器返回 503；分析器拒绝带分离模块的结果。

> **2026-10-31 补丁**：发现并修复「草稿应用后 `source='manual'` 被误当 Rap 已确认」。修复说明、根因与新测试见 `RAP-CONFIRM-FIX.md`；复查日志 `rap-fix-*.log`。

## 3. 五首真实歌（原唱混音直接分析，无分离）

详见 `five-song-report.md`。摘要（数据来自 `var/vocal-v31-work/structure-analysis-20261030/*.json`）：

| 歌 | 时长 | 新段数 | 旧算法段数 | <10s 碎段 | 相似候选 | 分析耗时 | 峰值内存 | 分离 |
|---|---|---|---|---|---|---|---|---|
| 初爱 | 234s | 14 | 11 | 0 | 2 | 71.7s（首次冷启，含 ffmpeg 解码与首次 import） | 694 MB | 否 |
| Let Go | 206s | 12 | 22 | 2 | 9 | 3.8s | 634 MB | 否 |
| Papillon | 195s | 10 | 16 | 0 | 2 | 2.6s | 610 MB | 否 |
| 베베 (BABE) | 193s | 14 | 15 | 6 | 7 | 2.5s | 617 MB | 否 |
| senorita | 190s | 15 | 29 | 4 | 6 | 3.2s | 571 MB | 否 |

- 五份 JSON 的 `separation.used=false`、`modulesSeen=[]`；原曲 SHA 分析后复算一致（`045998ed…`、`a4cae482…`、`057306bf…`、`28b18003…`、`5d85d322…`）。
- 旧算法 22/29 段的问题在 Let Go / senorita 上已被压到 12/15 段；Papillon 不再被切成十几段碎块。
- 初爱首跑 71.7s 是冷启（首次 ffmpeg 解码 + librosa 首次导入），端到端复跑同一首只需 2.7–3.8s。
- **未做**人工听辨边界与段落纠错，`boundaryNearLyricLine` 只是「边界是否落在歌词句首 ±1.5s」的合理性检查，不能当准确率。

## 3.1 端到端（真实原曲 → 真分析器 → 草稿接口 → 应用）

`scripts/e2e-draft.mjs`（临时 SQLite + 临时媒体副本 + 独立 venv，生产库与源目录不写）：

- POST 生成草稿：HTTP 200，2.7s，14 段/13 段待标注/4 段有候选类型/2 条相似候选，`separation.used=false`，`modulesSeen=[]`，状态 `NEEDS_REVIEW`；
- 应用前正式结构仍为 0 段（草稿不污染正式字段）；
- PUT 应用（把候选类型当作用户确认）：14 段全部 `source='manual'`，编号重算为 `U1 U2 U3 U4 A1 B1 U5 U6 U7 U8 A2 B2 U9 尾奏`；
- POST 恢复：409 `NO_LEGACY_SECTIONS`（这首原来没有旧结构，拒绝凭空恢复）；
- 源 MP3 分析前后 SHA 与字节数不变。

原始输出见 `e2e-draft.log`。

## 4. 本地 AI 条件（含翻译）

- 结构分析已用**独立 venv**：`var/vocal-v31-work/structure-venv`（Python 3.12.13，librosa 0.11.0，numpy/scipy），**不含** torch / onnxruntime / audio_separator / demucs / spleeter。旧的 `var/vocal-v31-work/.venv` 装了 `audio_separator`，本轮不使用它跑结构分析。
- 本地翻译（韩→中）**当时没有可用的本地翻译模型**：本机无 ollama / LM Studio 服务，8000/8001/18791 端口只是静态 `http.server`；venv 无 `transformers` / `ctranslate2` / `sentencepiece` / `faster_whisper`；模型目录里只有分离模型（MDX / RoFormer），按红线不得用于翻译也不得当作翻译能力。
  - **2026-10-31 更正**：本机确实存在 `/opt/homebrew/bin/llama-server`（llama.cpp 0.7.0），但当时与现在都**未启动、未加载任何翻译模型**；`pgrep -x llama-server` 无进程。因此「本机无 llama.cpp 服务」这一表述不准确，准确说法是「llama-server 可执行文件在，但没有运行、没有可用权重，未用于翻译」。
- 当时若走本地翻译需要新装模型权重（来源、许可、体积），属需用户授权的外部依赖，本轮未下载。
  - **2026-10-31 更新**：按用户决定，韩中翻译改走 CodeBuddy CLI 云端通道（`deepseek-v4.1-flash`），**不是本地模型**，也未下载任何翻译权重；实现与证据见 `docs/qa/evidence-2026-10-31-lyrics-translation/`。
- 已就韩文内容做不依赖翻译的处理：Hangul 原文经 NFKC + 去空白标点后比对，「너는 나의 봄이야」与「너는  나의 봄이야!」可判同词，韩文与中文译句不会被误判为同词（有单测）。

## 5. 未完成 / 需主代理接手

1. 人工听辨五首边界与主副歌类型（AC-01 的准确率证据）。
2. `npm run build && npx cap sync android`、APK 版本核对、授权真机验收（AC-02/06/10）。
3. 首次发布签收、伴奏是否恢复（用户决策）。
4. 结构模型的「主歌/副歌」目前是**同簇重复 + 音量**的候选提示，不是分类模型；若要提高类型准确率需引入新的结构模型（涉及权重下载与可能的 demix，须用户授权）。
