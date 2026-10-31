# HANDOFF｜P040 个人才艺曲库（舞蹈 / 吉他 / 唱歌）

更新：2026-10-31 14:40。恢复入口（≤100 行/≤8KB）；迁出原文见 §四。

> **真机现状**：实装 **1.1.17 (20)**（Redmi Note 11 5G，393×791；包元数据已核）；旧记 1.1.15/1.1.14 失效。
> **1.1.15 五项（0:44 遮挡｜19px｜主歌重复｜地图选段｜抽屉 ✕）：真机通过**，读数见 v115 证据。
> **1.1.16 新增**：Rap 无确认段时可点→进「地图与结构」；去「自由练习」、三排 44px、间距压缩 → 歌词区 497、可见 7 行、播放器 184。证据 `evidence-2026-10-31-dock-tighten/`。
> **署名行过滤**：代码用例通过；当前 28794 进程启动晚于文件修改，但真实链路待验证。
> **原型对照：通过**（0:44 双语截图+真实交互，数值全通过）；并排图待目检。
> **底栏四 Tab：关闭**（沉浸层 z60 覆盖 `.tabbar`，Tab 不可见不可点；列表末项不被底栏遮挡）。
> **翻译 UI + 409（1.1.16 真机）：通过**。证据 `evidence-2026-10-31-translation-ui-phone/`。
> **用户验收**：本阶段验收通过；导入从电脑进行，手机文件选择器不属于验收范围。
> **阶段结论**：用户确认验收及听感通过；不加逐段确认；只导入用户“想学”歌单。当前尚未正式发布。
> **服务**：`p040-vocal-lan-28794` 当前 pid 46217，健康接口正常；启动晚于歌词过滤修改，真实链路待核验。用户授权必要重启。
> **安全事件**：见 `docs/risks.md` §11；该值不入文档、勿外传。
> **其余**：生产库已迁至 0010，备份及核验见 `docs/qa/evidence-2026-10-31-production-migration/QA_RESULT.md`；禁伴奏/音源分离。

## Captured at / 治理字段

- Captured at：2026-10-31 14:40（“想学”单曲导入、手机验证与归档通过；未跑全量回归）
- PROJECT_PHASE：DEVELOP｜CHANGE_REQUEST：NONE
- Stage ID：…→V3.1→V3.2→V3.3→V1.2（内置参考 + 沉浸练歌，未发布）
- 剩 P0：无（本阶段用户已验收通过）
- 后续候选：只循环不播、源文件问题；仅按“想学”歌单导入。
- 用户签收：2026-10-31 本阶段验收通过；未正式发布。
- 下一步：“想学”单曲导入流程已跑通；后续只处理用户歌单里的歌曲。

## 快速恢复入口

- 阅读顺序：根 `AGENTS.md` → 本文件 → 根 `USER_MODEL_OVERRIDE.md` → `经验一句话.md` → 任务目标；冲突才扩大读。
- **设备与授权（用户 10-31 口径）**：出声已授权；真机只动用户点名的 **Redmi Note 11 5G**，按设备锁 `status → resolve → adb -s` 执行，用完 `release`；QA 已 release，勿复用旧 profile。note11tpro 仍禁止任何操作（含只读 adb）。
- **禁止事项**：全量回归｜自动覆盖正式结构｜改源 MP3/LRC｜伴奏/音源分离｜导入用户未选歌曲｜未经核验推送敏感数据。
- **数据安全**：真实 31 首舞曲、原节目单顺序、三类示例、冻结吉他 QA 均保护；备份仅 `var/backups/`；不按歌名猜删；凭据/token 不输出不提交。
- **环境/构建**：见 `docs/architecture-facts.md`。
- **未提交工作区**：V2.1/V3.1/V3.2/V3.3/V1.2 业务与文档改动，不要 reset/clean、覆盖或擅自提交。

## 一、当前有效状态

- 已完成批次（batch20、V3.2、V3.3、译文 22 首/1182 行、备份）→ 归档 §八。
- **V1.2**：内置 Papillon 参考目录 + 练歌一键载入 + 沉浸模式 + 地图抽屉（90vh/90dvh 兜底）；当前真机 1.1.17 (20)。
- **1.1.15 五项：真机通过**（0:44 定位｜19px｜段名去重｜地图按播放位置选段｜抽屉 ✕ 常驻），读数见 v115 证据。
- **原型对照**：0:44 截图 + 交互齐；顶栏 23px/750、播放器圆角 18。
- **版式与底栏（1.1.16）**：三排 44px、歌词 497／7 行（360→6、340→3）、0 越界；z60 覆盖 Tab。
- 点歌直达、歌词/抽屉滚动、参考候选、波形拖动撤销、B2 保存：**真机通过（克隆库）**。
- 原唱推进、B2 循环、合练：媒体状态已测；用户确认听感验收通过。
- **后续事项**：爱的恰恰核对、重复候选、正式发布；不作为本阶段验收阻碍。
- **服务**：28794 pid 46217；生产库已迁结构。real-qa 唱歌 32 首，新增 1 首，手机验证通过。

## 二、下一步

1. 核验署名过滤；参考免逐段确认已真机保存；参考移至 `var/private-reference/catalog.json`（备份 `var/backups/reference-private-prerestart-20261031-134554/`），已推送 `b62deb3`。
2. 用户已确认本阶段及实际听感验收通过。
3. 手机文件选择器不在验收范围内；歌曲从电脑导入。
4. `0010` 已迁移；只导入用户“想学”歌单，`미쳐` 源文件问题留待以后处理。
5. 当前阶段已验收；正式发布另属后续事项。

**接续提示词**：先读「快速恢复入口」与 §二；1.1.15 五项、原型对照、翻译 UI、409 已通过，勿重跑；手机文件选择器不属于验收范围。

## 三、指针（按需读，别全量加载）

| 内容 | 位置 |
|---|---|
| 网易云单曲导入与 Skill | `docs/qa/evidence-2026-10-31-netease-first/QA_RESULT.md`；`netease-want-to-learn-local-zh/`（中央已登记 1.0.0，项目副本与中央源一致，未入 Skill Manager） |
| **1.1.16(19) Rap 入口 + 紧凑版式** | `docs/qa/evidence-2026-10-31-dock-tighten/QA_RESULT.md` |
| 1.1.16 真机翻译 UI + 409 身份不匹配 | `docs/qa/evidence-2026-10-31-translation-ui-phone/QA_RESULT.md` |
| 1.1.15(18) 原型对照复验（五项修复 + 交互） | `docs/qa/evidence-2026-10-31-prototype-phone-v115/QA_RESULT.md` |
| 1.1.14(17) 真机原型对照（失败基线） | `docs/qa/evidence-2026-10-31-prototype-phone-v114/QA_RESULT.md` |
| 定位/编号/版式/抽屉修复与 1.1.15 首包核验 | `docs/qa/evidence-2026-10-31-player-seek/QA_RESULT.md` |
| 地图按位置选段修复与 1.1.15 二包核验 | `docs/qa/evidence-2026-10-31-map-autoselect/QA_RESULT.md` |
| 沉浸页底部按钮版式（8 档实测） | `docs/qa/evidence-2026-10-31-dock-fit/QA_RESULT.md` |
| 1.1.13 (16) 真机复验 + 原服务复验｜1.1.7–1.1.12 历史段 | `docs/qa/evidence-2026-10-31-reference-phone/QA_RESULT.md` 末两节；`…-phone/QA_RESULT.md` |
| 抽屉滚动修复 | `docs/qa/evidence-2026-10-31-drawer-scroll/PROBE.md` |
| V1.2 内置参考/沉浸页交付验收 | `docs/qa/evidence-2026-10-31-v12-catalog/ACCEPTANCE-REPORT.md` |
| 参考结构最小闭环 | `docs/qa/evidence-2026-10-31-structure-reference/` |
| 地图抽屉改版（探针+截图+用例） | `docs/qa/evidence-2026-10-31-map-simplify/QA_RESULT.md` |
| 译文合并执行与回滚｜译文修正依据与存疑项 | `…-realqa-merge-batch2/`、`…-realqa-merge/` 的 `EXECUTION-REPORT.md`；`…-lyrics-translation/CORRECTION-2026-10-31.md` |
| 迁出原文（旧表述与批次事实） | `docs/handoff/HANDOFF-2026-10-31-详情归档.md` |
| V3.2 结构地图 SDD/证据 | `docs/plan/P040-Song-Structure-Map-V3.2/`、`docs/qa/evidence-2026-10-31-structure-v32/` |
| 2026-10-30 及以前历史 | `docs/handoff/HANDOFF-历史归档-2026-10-30.md`、`HANDOFF-2026-10-30-batch20-归档.md` |
| V3.1 运行与恢复说明 | `docs/vocal-v31-operations.md` |
| 验收矩阵 | `docs/qa/产品验收追踪矩阵.md` |
| 架构/构建事实｜风险｜踩坑 | `docs/architecture-facts.md`｜`docs/risks.md`｜根 `agent.md` |
| 服务重启证据 / 服务登记 | `docs/qa/evidence-2026-10-31-service-restart-structure/EXECUTION-REPORT.md`；治理仓 `后台服务登记表.md`（`p040-vocal-lan-28794`） |

## 四、归档

批次正文、1.1.13 细目、旧表述与包哈希全部迁至 `HANDOFF-2026-10-31-详情归档.md`（§六–§十三）；构建记录见 `docs/architecture-facts.md` §四。
