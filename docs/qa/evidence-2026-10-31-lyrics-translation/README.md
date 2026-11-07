# P040 歌词中文译文｜定向证据（2026-10-31）

本轮实现「优先复用 LRC 中文译文 + CodeBuddy 通道补译 + 原译分离 + 人工纠错」，并在**隔离库副本**上用五首真实韩文歌跑通。
**翻译质量只做了抽样对照，没有逐句人工听辨/审校，不能宣称「翻译准确率通过」。**

> 2026-10-31 追加：已做**逐句文本审校**（292/292 行，只读、未改数据、未出声、未调其他模型），结果见 `TRANSLATION-REVIEW-2026-10-31.md`。结论：行关联 PASS；68/292 行被标记（32 行同源不一致 + 36 行独立问题，含 5 条严重语义错误）；**听辨准确率仍未测定**。本文 §3「抽样对照」与 §6 的「未逐句审校」以该报告为准更新。
>
> 2026-10-31 再追加：上述 68 行**已修正并落地到隔离副本**（68 行改写 + 5 行署名不译，同源不一致归零），同时改了 3 处翻译逻辑防止重现，并重建 1.1.10 (13)。依据与不确定项见 `CORRECTION-2026-10-31.md`。

## 1. 隔离与红线

| 项 | 实测 |
|---|---|
| 生产库 `var/personal-dance-library.db` | SHA256 `6c246314…d32d0ca`，本轮前后一致，全程未打开 |
| 原隔离 QA 库 `var/vocal-v31-work/real-qa-20261030/db/qa.db` | SHA256 `ae1e2261…f14ce1c71`，本轮前后一致；只做 `.backup` 复制出副本 |
| 实际写入库 | `var/vocal-v31-work/translation-20261031/db/qa.db`（副本）与 `.../smoke/qa.db`（二次副本） |
| 源素材目录 | 未读取音频、未写入、未移动；未启动任何分离进程（`ps` 未见 demucs / audio-separator / spleeter / uvr） |
| 声音 | 全程未播放任何音频 |
| 手机 | 未连接、未操作 adb、未装包 |
| git | 未 commit、未 push；保留全部既有未提交改动 |

## 2. 翻译通道（如实说明）

- 通道：`scripts/codebuddy-auto.sh --model deepseek-v4.1-flash --effort high -y -p ...`
- 实际路径：**本机启动 CodeBuddy CLI → 连接 CodeBuddy 云端模型**。歌词原文会离开本机；练习页翻译按钮旁已写明这一点。
- **不是本地模型**；没有下载或部署任何翻译权重，没有使用付费翻译 API。
- 本机确有 `/opt/homebrew/bin/llama-server`（llama.cpp 0.7.0），但**本轮未启动、未加载模型、未用于翻译**（`pgrep -x llama-server` 无进程）。
- 合并规则：`manual` 永不被覆盖；`lrc` 可覆盖 `ai`；`ai` 只填空或刷新 `ai` 自己；服务端与客户端同一口径。

## 3. 五首真实韩文歌（隔离库副本）

数据来自 `real-run/report.json`：

| 歌 | 语言 | 句数 | 结果 | 通道新增 | 缓存 | LRC 复用 | 原文时间轴 |
|---|---|---|---|---|---|---|---|
| 덤더럼 (Dumhdurum) / Apink | ko | 44 | COMPLETE | 44 | 0 | 0 | 未变 |
| 사뿐사뿐 / AOA | ko | 91 | COMPLETE | 91 | 0 | 0 | 未变 |
| 보여줄게 / Ailee | ko | 47 | COMPLETE | 47 | 0 | 0 | 未变 |
| 베베 (BABE) / 泫雅 | ko | 70 | COMPLETE | 70 | 0 | 0 | 未变 |
| Insomnia (불면증) / 辉星 | ko | 40 | COMPLETE | 40 | 0 | 0 | 未变 |

- 合计 292 句，`remaining=0`、`failed=[]`、`lyricsUnchanged=true` 全部为 true。
- 逐首耗时约 17–38 秒（含每次 CLI 启动），完整日志 `real-run/run.log`。
- 抽样对照（덤더럼 前 12 句）逐行语义对应，未发现串行/合并/漏行；例如
  `하루하루 밀어냈던 느낌 그대로` → `一天天推开的那种感觉，就那样`。
- **未做**：五人逐句审校、术语/押韵统一、粉丝译法比对。COMPLETE 只代表「每句都拿到了非空译文」，不代表译文质量合格。

## 4. HTTP 冒烟（真实接口 + 真实通道）

临时服务 `127.0.0.1:18899`，只挂隔离副本，配对后调用：

1. `POST /api/repertoire/:id/translations/translate`（清空缓存后）→ `COMPLETE`，70 句全部由通道返回，25 秒，`lyricsUnchanged=true`，见 `http-smoke/translate-live.json`、`http-smoke/http-live.log`。
2. `PUT /api/repertoire/:id/translations` 写入两句人工译文 → `source=manual`。
3. 再次 `POST .../translate` → `NOTHING_TO_DO`，人工译文原样保留。
4. 另一次带缓存的冒烟：清空 `translations_json` 但保留缓存 → 70 句全部命中缓存、未再调用通道（离线复用路径）。

## 5. 自动化定向测试

| 命令 | 结果 |
|---|---|
| `node --test tests/vocal-translation-service.test.mjs tests/vocal-import-created-row-v31.test.mjs tests/vocal-import-integration-v31.test.mjs tests/vocal-import-original-only-retry-v31.test.mjs tests/sync-vocal-operations.test.mjs tests/repertoire.test.mjs tests/vocal-persistence.test.mjs` | 49 pass / 0 fail |
| `npx vitest run tests/unit/vocal tests/browser/vocal` | 158 pass / 0 fail（18 文件） |
| `npx tsc -b` | 通过 |
| `npx vite build --outDir .local/build-check-translation --emptyOutDir` | 通过（独立目录，未覆盖 `dist/`） |

覆盖：LRC 同时间戳/邻近时间拆行、已入库双语行只关联不删除、AI 不覆盖人工、LRC 覆盖 AI、逐句保存且时间轴不变、二次不重复调用、跨曲缓存、单句失败二分重试、通道级超时不二分空转、通道不可用不写假译文、空文本删除单句、原文改动标记 stale、练习默认双语、演出默认原文可切换、人工纠错只改译文。

## 6. 未完成 / 不能宣称

1. 译文质量未做人工听辨与母语者复核；逐句**文本**审校已于 2026-10-31 完成（`TRANSLATION-REVIEW-2026-10-31.md`），68 行修正也已落地到隔离副本（`CORRECTION-2026-10-31.md`）。听辨准确率仍**未测定**。
2. 未装真机对比译文显示质量；「练习默认双语 / 演出默认韩文」目前只有组件测试与 1.1.9 (12) 隔离克隆上的长歌词截图证据。1.1.10 (13) 未装真机。
3. 生产库未迁移（迁移 `0010_vocal_translation.sql` 只在隔离副本执行）。
4. 首次发布签收仍 OPEN。
5. LRC 自带译文路径只有测试夹具与合成双语样本，真实素材库 688 个 LRC 中没有检到同时间戳韩中译文对；真实五首均为模型翻译。
6. `COMPLETE` 不等于全中文：292 行中 75 行译文与原文逐字相同（英语 hook/拟声），实际中文行约 217。

## 7. 文件

| 内容 | 位置 |
|---|---|
| **逐句语义审校、行关联复核、待修清单** | `TRANSLATION-REVIEW-2026-10-31.md` |
| **68 行修正的定位、依据、不确定项、构建核对** | `CORRECTION-2026-10-31.md`、`corrections-2026-10-31.json`、`correction-result.json` |
| 五首报告与逐首原文/译文 | `real-run/`（`report.json`、`channel.json`、`run.log`、五份 `<songId>.json`） |
| 行关联/时间轴一致性复核 | `verify.json`（五首 `lyricsIdenticalToSource=true`、译文 id 无重复且全部存在、数量对齐、7 项检查全 true） |
| HTTP 冒烟输出 | `http-smoke/`（`http-live.log`、`translate-live.json`） |
| 源库前后哈希 | `source-hashes-before.txt`（运行后复算一致） |
| 复现命令 | 见本文 §3；脚本 `scripts/translate-lyrics-batch.mjs` |
