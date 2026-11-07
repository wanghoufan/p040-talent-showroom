# HANDOFF｜P040 个人才艺曲库（舞蹈 / 吉他 / 唱歌）

更新：2026-11-08 00:10。恢复入口（≤100 行/≤8KB）；迁出原文见 §四。

> **11-08 用户指令**：**手机端 A4 导出/打印不做**（打印在电脑上用户自做），手机 PDF 落盘不再开发/验收；其余待办本轮全部不做，等新指令。
> **11-08 收尾**：清 `/tmp/p040*` 与断链软链（`USER_MODEL_OVERRIDE.md` 重指 `003-体系管家` 现路径）；全部改动已提交并 push `main`。

> **V1.3-R2（1.1.23/26）**：地图常驻｜中文不译｜左时标右序号｜键位二次取消＋循环整框｜Rap 可拖｜A4 双栏｜纸质修订 JSON＋快照撤回（识别 BLOCKED）｜四栏导航＋演出入口｜按需下载。
> **11-07 推送 1.1.31 (34)**：练唱三改（Rap 按句框选、3/5 句、循环开始/结束区间循环）＋提示区布局稳定（固定状态槽＋浮层，点倍速/循环不再顶动按钮行）；**出包前必跑 `npm run android:bump`**，装后看「设置→关于」核对。三台均已装 1.1.31，12T Pro 已做 UI 验收。旧 1.1.30 (33) 包哈希 `2315508…cef1`。
> **设备口径**：12T Pro `UKCESWB67PUO7LPB`｜Note 11 5G `WGBMXWDIAIFMPFCQ`｜Note 12 `indq5xfi6hovay4d`；12T Pro 仅按明确指令操作。
> **归档（11-05）**：网易云根=待处理区，验收后移入 `已导入软件/`；清单用 `scripts/music-archive-manifest.mjs`（导入前 `--check` 判重）。
> **11-05 收尾**：曲库精简为 8 首（备份 `var/backups/prune-20261105/`）；导入记录清空；1.1.26「批量管理/＋」并入搜索行；A4 稿见 `导出/A4学习稿/`。
> **翻译口径（11-05 用户指令）**：翻译由主开发者＋并行子代理完成，**禁用 CodeBuddy 通道**；复核用 `translatableLines`。当前 26 首外语歌译文 100% 齐。
> **1.1.24 (27)**：主备地址探测 `/api/health`(1.5s) 择优缓存 5 分钟，真机已验；**1.1.23 证据**：`docs/qa/evidence-2026-11-04-v13-r2/QA_RESULT.md`。

## Captured at / 治理字段

- Captured at：2026-11-08 00:10（残留清理＋全量改动提交推送后小交接）
- PROJECT_PHASE：DEVELOP｜CHANGE_REQUEST：NONE
- Stage ID：…→V3.3→V1.2→**V1.3-R2**（未发布）
- 剩 P0（11-08 起全部暂缓）：Note 12 未做 1.1.31 UI 验收；AC-PAPER-02 图文识别 BLOCKED；AC-LRC-04/NAV-04/NAV-07（窄屏/字号/横屏/返回栈）与 AC-PRINT-04 黑白打印未测；断网播放未复测
- 后续候选：手机 A4 PDF 落盘（11-08 否决，电脑端打印）；「只循环不播」「미쳐」现象待用户描述
- 用户签收：2026-10-31 阶段验收通过；未正式发布
- 下一步：等用户新指令；不改手机端 PDF、不碰打印线

## 快速恢复入口

- 阅读顺序：根 `AGENTS.md` → 本文件 → 根 `USER_MODEL_OVERRIDE.md` → `经验一句话.md` → 任务目标；冲突才扩大读。
- **设备**：真机按用户点名执行；12T Pro 只在用户明确要求时操作。
- **禁止**：全量回归｜自动覆盖正式结构｜改源 MP3/LRC｜伴奏/音源分离｜导入用户未选歌曲｜未经核验推送敏感数据｜未经指令 commit/push。
- **数据安全**：真实 31 首舞曲、原节目单顺序、三类示例、冻结吉他 QA 均保护；备份仅 `var/backups/`；不按歌名猜删；凭据/token 不输出不提交。
- **环境/构建**：见 `docs/architecture-facts.md`；服务 `p040-vocal-lan-28794`（pid 46217，健康正常）。
- **工作区**：业务与文档改动已全部提交（`.local/`、`var/`、`temp/` 不入库；勿 reset/clean）。

## 一、当前有效状态

- 已完成批次 → 归档 §四。
- **1.1.31 (34)**：练唱三改＋提示区固定状态槽/浮层（详见顶部横幅与 QA §七）；证据 `docs/qa/evidence-2026-11-07-loop-rap/`。**1.1.29 (32)**：版本号纪律＋删旧调试包。**1.1.28 (31)**：补 `usesCleartextTraffic` 修局域网 http 拦截。**1.1.24 (27)**：主备地址自动切换。**1.1.23 (26)**：V1.3-R2 全部 P0＋P1。
- **11-06 绿光时间轴修复**（rev 7→8）：LRC 锚点整体偏晚致「差一句」，56 行按音频重排、文字未改；他曲 7 首锚点复核通过（韩语 small 抽检），Note 11 真机 3 首高亮 PASS；证据 `docs/qa/evidence-2026-11-06-lyric-timing/`。
- **推送取证**：截图在 `.local/push-*.png`（未归档）。
- **译文**：26 首外语歌 100% 齐（11-05 主开发者＋并行子代理补齐，senorita 修 4 行假通过）；中文 13 首不需译文。
- **踩坑沉淀**：`agent.md` 9.7KB（近 10KB，增前先压）。
- 已真机通过：点歌直达、歌词/抽屉滚动、波形拖动撤销、切歌、断网播放（1.1.21）。
- 服务与库：28794 生产库 real-qa（38 唱歌/33 舞蹈）；临时隔离库已停并清理。
- 用户验收：本阶段及听感通过；不加逐段确认；只导入「想学」歌单。

## 二、下一步

1. **三台已装 1.1.31 (34)**：12T Pro 已做完整 UI 验收；Note 11 5G 与 Note 12 仅核对版本号，**剩 Note 12 补 UI 验收**（11-08 起暂缓）。主 `http://192.168.31.61:28794` / 备 `http://100.125.100.15:28794`、配对码见本机 `var/vocal-v31-work/real-qa-20261030/db/owner-pairing.json`。release 包不可调试，只能 UI 自动化。**踩坑**：填配对码前先 `ime disable`（否则 Note 12 黑屏），用完恢复输入法。
2. **手机端 A4 导出落盘：11-08 用户明确不做**（电脑上自行打印）。代码已随 1.1.31 在包内（`PdfSavePlugin` + `src/native/pdf-save.ts`），不再开发；电脑端脚本 `scripts/export-a4-sheets.mjs` 保持可用。
3. **窄屏/字号/横屏/返回栈** 与黑白打印补测——用户 11-08 指示本轮不做。
4. **导入想学音乐**：「想学」现有《绿光（抖音热播）》03:08，库内无重复；卡在客户端点击下载（macOS 未给模拟点击授权），等文件落盘后走 skill 1.1.1 流程。
5. **移动网络在线流式**：DERP(sfo) 14–36 KB/s，要在线听须自建就近 DERP/VPS，待拍板。
6. **11-08 已提交并 push `main`**：V1.3-R2→1.1.31 全部业务/文档/QA 证据（830aa12 / 4e85c77 及本次提交）；回滚备份 `var/backups/merge-dance-20261103/`。

**接续提示词**：先读 §0–§二；**11-08 用户指示：手机 PDF/打印不做、其余待办全不做**，等新指令。release 包只能走 adb/uiautomator。

## 三、指针（按需读，别全量加载）

| 内容 | 位置 |
|---|---|
| V1.3-R2 整改与真机 QA | `docs/qa/evidence-2026-11-04-v13-r2/QA_RESULT.md` |
| 验收矩阵（含 V1.3-R2 逐条） | `docs/qa/产品验收追踪矩阵.md` |
| 1.1.21 Tailscale 白名单｜导入持久化 | `…-tailscale-endpoint/QA_RESULT.md`｜`…-11-03-import-persist/` |
| 1.1.16｜1.1.15 原型 | `…-dock-tighten/`｜`…-translation-ui-phone/`｜`…-prototype-phone-v115/` |
| 定位/编号/抽屉/地图选段/底栏版式 | `…-10-31-player-seek/`、`…-map-autoselect/`、`…-drawer-scroll/PROBE.md`、`…-dock-fit/` |
| V1.2 参考目录与沉浸页验收｜结构最小闭环｜地图抽屉改版 | `…-v12-catalog/ACCEPTANCE-REPORT.md`、`…-structure-reference/`、`…-map-simplify/` |
| 译文合并与修正依据 | `…-realqa-merge*/EXECUTION-REPORT.md`、`…-lyrics-translation/CORRECTION-2026-10-31.md` |
| V3.2 结构地图 SDD/证据｜V3.1 运行说明 | `docs/plan/P040-Song-Structure-Map-V3.2/`、`…-structure-v32/`｜`docs/vocal-v31-operations.md` |
| 网易云单曲导入与 skill | `…-netease-first/QA_RESULT.md`；`netease-want-to-learn-local-zh/` |
| 迁出原文｜历史归档 | `HANDOFF-2026-10-31-详情归档.md`｜`HANDOFF-历史归档-2026-10-30.md`、`…-batch20-归档.md` |
| A4 导出脚本（电脑端） | `scripts/export-a4-sheets.mjs`（产 PDF/HTML 分目录） |
| 架构/构建｜风险｜踩坑｜服务登记 | `docs/architecture-facts.md`｜`docs/risks.md`｜根 `agent.md`｜治理仓 `后台服务登记表.md` |

## 四、归档

批次正文、旧表述与包哈希迁至 `HANDOFF-2026-10-31-详情归档.md`；构建记录见 `docs/architecture-facts.md` §四。
