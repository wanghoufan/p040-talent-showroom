# HANDOFF｜P040 个人才艺曲库（舞蹈 / 吉他 / 唱歌）

更新：2026-11-04 16:40。恢复入口（≤100 行/≤8KB）；迁出原文见 §四。

> **V1.3-R2 已落地（1.1.23 / 26；Note 11 5G + Note 12T Pro 均已装）**：沉浸页常驻「地图」（无结构可进、空态可打点）｜中文歌不翻译、不显示同文译文｜沉浸页左时标右序号｜2/4/自定义同键二次取消（不 seek 不停播）＋循环范围**整框**高亮｜Rap 分界真机可拖（像素命中＋热区＋±0.5s）｜A4 学习稿（双栏＋右栏重复对齐，中文一页、外语两页）｜纸质修订 JSON 导入＋差异预览＋确认回写＋快照撤回（AI 识别 BLOCKED）｜四栏导航＋顶部演出入口｜按需下载单曲·想学·节目单。
> **设备口径**：调测只用 Note 11 5G（`WGBMXWDIAIFMPFCQ`）；12T Pro 仅按 16:30 指令推过 1.1.23 (26)（`UKCESWB67PUO7LPB`），其余操作不做。
> **证据**：`docs/qa/evidence-2026-11-04-v13-r2/QA_RESULT.md`（前端 389 / 服务端 260 用例、真机逐项、4 项未测/阻塞）。

## Captured at / 治理字段

- Captured at：2026-11-04 16:40（V1.3-R2 收口 + 阶段复盘；未跑无关全量回归）
- PROJECT_PHASE：DEVELOP｜CHANGE_REQUEST：NONE
- Stage ID：…→V3.3→V1.2→**V1.3-R2**（未发布）
- 剩 P0：AC-PAPER-02 图文识别（无授权视觉模型，BLOCKED）；AC-LRC-04/NAV-04/NAV-07（340/360dp、字号放大、横屏、返回栈）与 AC-PRINT-04 黑白打印未测；断网播放未复测
- 后续候选：手机上 A4「下载 PDF」在 WebView 里不落盘（需 Filesystem 落盘 + 分享）；只循环不播；`미쳐` 源文件问题
- 用户签收：2026-10-31 阶段验收通过；未正式发布
- 下一步：①修手机端 PDF 落盘 ②补测窄屏/字号/横屏/返回栈与黑白打印 ③A4 规格定稿后批量出歌单

## 快速恢复入口

- 阅读顺序：根 `AGENTS.md` → 本文件 → 根 `USER_MODEL_OVERRIDE.md` → `经验一句话.md` → 任务目标；冲突才扩大读。
- **设备**：真机按用户点名执行；12T Pro 只在用户明确要求时操作。
- **禁止**：全量回归｜自动覆盖正式结构｜改源 MP3/LRC｜伴奏/音源分离｜导入用户未选歌曲｜未经核验推送敏感数据｜未经指令 commit/push。
- **数据安全**：真实 31 首舞曲、原节目单顺序、三类示例、冻结吉他 QA 均保护；备份仅 `var/backups/`；不按歌名猜删；凭据/token 不输出不提交。
- **环境/构建**：见 `docs/architecture-facts.md`；服务 `p040-vocal-lan-28794`（pid 46217，健康正常）。
- **未提交工作区**：V2.1/V3.1/V3.2/V3.3/V1.2/V1.3-R2 业务与文档改动，不要 reset/clean、覆盖或擅自提交。

## 一、当前有效状态

- 已完成批次（batch20、V3.2、V3.3、译文 22 首/1182 行、V1.2、V1.3-R2）→ 归档 §四。
- **1.1.23 (26)**：V1.3-R2 全部 P0＋P1 落地；两机已装；真机逐项证据见上。
- 已真机通过：点歌直达、歌词/抽屉滚动、参考候选、波形拖动撤销、B2 保存、切轨、断网播放（1.1.21）。
- 服务与库：28794 生产库 real-qa（38 首唱歌 + 33 首舞蹈）；调测临时隔离库 `/tmp/p040-qa-1104/qa.db`（端口 28795，只读媒体），复盘后已停并清理。
- 用户验收：本阶段及听感通过；不加逐段确认；只导入「想学」歌单。

## 二、下一步

1. **手机端 A4 导出落盘**：现在只生成字节 + `a[download]`，Capacitor WebView 不落盘 → 改 Filesystem 写 Documents 并给分享入口；电脑端导出脚本已可用（`导出/A4学习稿/PDF`、`HTML`）。
2. **窄屏/字号/横屏/返回栈** 与黑白打印补测（Note 11 5G）。
3. **A4 规格待用户定稿**：当前中文 1 页、外语 2 页；右栏放重复段并与首次出现处对齐；定稿后批量出全部想学歌单。
4. **导入想学音乐**：「想学」现有 1 首《绿光（抖音热播）》/ 阿成哥 03:08，库内无重复；卡在客户端点击下载（macOS 未给模拟点击授权），等文件落盘后按 skill 1.1.1 流程走。
5. **移动网络在线流式**：DERP(sfo) 14–36 KB/s，要在线听须自建就近 DERP/VPS，属基建，待拍板。
6. 本轮改动已提交并推送 `main`（830aa12 + 后续服务端补提交）；回滚备份 `var/backups/merge-dance-20261103/`。

**接续提示词**：先读「快速恢复入口」与 §二；V1.3-R2 已真机验过，勿重跑；下一步做手机端 PDF 落盘。

## 三、指针（按需读，别全量加载）

| 内容 | 位置 |
|---|---|
| V1.3-R2 整改与真机 QA | `docs/qa/evidence-2026-11-04-v13-r2/QA_RESULT.md`（含 5 张截图） |
| 验收矩阵（含 V1.3-R2 逐条） | `docs/qa/产品验收追踪矩阵.md` |
| 1.1.21 Tailscale 白名单 + 室外链路｜导入持久化 | `docs/qa/evidence-2026-11-04-tailscale-endpoint/QA_RESULT.md`｜`…-11-03-import-persist/` |
| 1.1.16 Rap 入口/紧凑版式｜翻译 UI + 409｜1.1.15 原型复验 | `…-10-31-dock-tighten/`｜`…-translation-ui-phone/`｜`…-prototype-phone-v115/` |
| 定位/编号/抽屉/地图选段/底栏版式 | `…-10-31-player-seek/`、`…-map-autoselect/`、`…-drawer-scroll/PROBE.md`、`…-dock-fit/` |
| V1.2 参考目录与沉浸页验收｜结构最小闭环｜地图抽屉改版 | `…-v12-catalog/ACCEPTANCE-REPORT.md`、`…-structure-reference/`、`…-map-simplify/` |
| 译文合并与修正依据 | `…-realqa-merge*/EXECUTION-REPORT.md`、`…-lyrics-translation/CORRECTION-2026-10-31.md` |
| V3.2 结构地图 SDD/证据｜V3.1 运行说明 | `docs/plan/P040-Song-Structure-Map-V3.2/`、`…-structure-v32/`｜`docs/vocal-v31-operations.md` |
| 网易云单曲导入与 skill | `…-netease-first/QA_RESULT.md`；`netease-want-to-learn-local-zh/`（仓库源 1.1.1 / 中央 1.1.0 / 项目副本 1.0.0，未同步，管理员处理） |
| 迁出原文｜历史归档 | `HANDOFF-2026-10-31-详情归档.md`｜`HANDOFF-历史归档-2026-10-30.md`、`…-batch20-归档.md` |
| A4 学习稿导出脚本（电脑端批量） | `scripts/export-a4-sheets.mjs`（`--api/--out/--song id:名称`，产 PDF/HTML 分目录） |
| 架构/构建｜风险｜踩坑｜服务登记 | `docs/architecture-facts.md`｜`docs/risks.md`｜根 `agent.md`｜治理仓 `后台服务登记表.md` |

## 四、归档

批次正文、1.1.13 细目、旧表述与包哈希全部迁至 `HANDOFF-2026-10-31-详情归档.md`（§六–§十三）；构建记录见 `docs/architecture-facts.md` §四。
