# HANDOFF｜P040 个人才艺曲库（舞蹈 / 吉他 / 唱歌）

更新：2026-11-09 22:48。恢复入口（≤100 行/≤8KB）；迁出原文见 §四与状态文件附录。

> **11-09 22:48 阶段复盘**：踩坑已收口；换机迁移方案沉淀为中央 Skill `lan-device-migration-local-zh`（已分发 11/11）；自动化候选与「给管家的话」待处置。
> **11-09 完成（本轮）**：视频长期持久＋局域网换机迁移已开发完毕、构建 **1.1.36（39）**、两台真机（Note 12T Pro → Note 12 Pro）覆盖安装并验收通过。
> 配对改为 **6 位数字**（用户明确否掉 32 位长码）；同 Wi-Fi「自动搜索旧手机 → 旧机点一次允许」即可迁移。证据 `docs/qa/evidence-2026-11-09-migration-e2e/QA_RESULT.md`。
> **11-08 用户指令**：手机端 A4 导出/打印不做；其余待办暂缓（原文见状态文件附录）。
> **V1.3-R2（1.1.23/26）**：地图常驻｜中文不译｜左时标右序号｜键位二次取消＋循环整框｜Rap 可拖｜A4 双栏｜纸质修订 JSON＋快照撤回（识别 BLOCKED）｜四栏导航＋演出入口｜按需下载。
> **1.1.31 (34)**：练唱三改＋提示区固定状态槽/浮层；**出包前必跑 `npm run android:bump`**。
> **设备口径**：按用户点名执行；12T Pro 仅在用户明确要求时操作。串口不写文档、不复述。
> **1.1.32 (35)**：取消服务器配对码，局域网/Tailscale/本机自动签发凭据；证据 `docs/qa/evidence-2026-11-08-auto-pair/QA_RESULT.md`。

## Captured at / 治理字段

- Captured at：2026-11-09 22:48（换机迁移完成、两机真机验收通过＋阶段复盘的小交接）
- PROJECT_PHASE：DEVELOP｜CHANGE_REQUEST：NONE
- Stage ID：…→V3.3→V1.2→**V1.3-R2**（未发布）
- 剩 P0：**同步保护真机核验（OPEN）**；断网/杀进程续传实测；主动 MITM/真机抓包；Note 12 Pro 的练唱 UI（1.1.31 项）仍未验收；AC-PAPER-02 BLOCKED；AC-LRC-04/NAV-04/NAV-07 与 AC-PRINT-04 未测
- 后续候选：手机 A4 PDF 落盘（11-08 否决）；「只循环不播」「미쳐」待用户描述
- 用户签收：2026-10-31 阶段验收通过；未正式发布
- 下一步：见 §二；不改手机端 PDF、不碰打印线。**push 未授权**，本地已 commit（36544b6/4385fe7/c4cacac），不自行推送

## 快速恢复入口

- 阅读顺序：根 `AGENTS.md` → 本文件 → 根 `USER_MODEL_OVERRIDE.md` → `经验一句话.md` → 任务目标；冲突才扩大读。
- **禁止**：全量回归｜自动覆盖正式结构｜改源 MP3/LRC｜伴奏/音源分离｜导入用户未选歌曲｜未经核验推送敏感数据｜未经指令 push。
- **数据安全**：真实 31 首舞曲、原节目单顺序、三类示例、冻结吉他 QA 均保护；备份仅 `var/backups/`；不按歌名猜删；凭据/token 不输出不提交。
- **环境/构建**：JDK 21（`~/android-toolchain/jdk-21.0.12.1+1/Contents/Home`）→ `npm run build` → `npx cap sync android` → `./gradlew :app:assembleRelease`（验收包为 release，包名 `com.wanghoufan.dancelibrary`）。服务 `p040-vocal-lan-28794` 由 LaunchAgent `local.p040-vocal-lan-28794` 托管（PORT 28794）。
- **工作区**：见 `git status`；`.local/`、`var/`、`temp/` 不入库；勿 reset/clean。
- **本轮结论**：release 包无 WebView CDP，真机验收用 `uiautomator dump` + `input tap` + `screencap`；点击底部导航区（y>1900）容易误触，坐标须先滚动到 500–1750 再点。

## 一、当前有效状态

- **换机迁移（本轮完成）**：6 位数字配对码 + 同 Wi-Fi UDP 自动发现；旧机必须点「允许」；传输 ECDH/AES-256-GCM 加密；二次迁移幂等（新增 0、跳过 101）；冲突默认保留新机（本轮 3 项：绿光/跳楼机/风吹一夏）；迁移后设置页计数即时刷新。方案已沉淀中央 Skill `lan-device-migration-local-zh` 1.0.0（Mac 已分发 11/11）。
- **本地提交**：`36544b6`/`4385fe7`/`c4cacac`（迁移代码＋验收矩阵＋证据）；push 等授权。
- **事故与恢复**：一次 adb 误触「清空离线缓存」，已重迁移恢复（101 文件 444.1 MB、31 视频）；见证据 §五。
- **阶段复盘（11-09 22:48）**：新增踩坑 3 条；机制二自动沉淀 `android-true-device-qa-orchestrator-local-zh` 1.3.2→1.4.0（阶段 0.5 点击安全区门禁＋强制回执，已分发 11/11）；自动化候选 A1、「给管家的话」待处置；机制一候选为空。
- **视频持久**：索引 stamp 指纹、孤儿副本待核实且禁止播放/上传、删文件成功才摘索引、待办移除不删持久副本；新机断网 + force-stop 重开后原视频可播（本轮实测）。
- **1.1.36 (39)** APK SHA-256 `849b60cf…`，11,333,220 B；两台真机「关于」显示 1.1.36（构建 39）。
- 定向测试：JS 92 用例（10 文件）、Java 24 用例全过；`tsc -b`、相关 ESLint 通过；未跑全量回归（按用户红线）。
- 已真机通过（历史）：点歌直达、歌词/抽屉滚动、波形拖动撤销、切歌、断网播放（1.1.21）、主备地址切换（1.1.24）。
- **译文**：26 首外语歌 100% 齐（11-05 主开发者＋并行子代理补齐）；中文 13 首不需译文。
- **踩坑沉淀**：`agent.md` 10.0KB（上限 10KB，增前先压）。服务与库：28794 生产库 real-qa（38 唱歌/33 舞蹈）。
- 用户验收：本阶段及听感通过；不加逐段确认；只导入「想学」歌单。

## 二、下一步

1. **同步保护真机核验（唯一剩余 P0）**：构造旧机有在途上传时开始迁移，确认后台上传被闸门挡住、队列与文件未被删；单测已覆盖，不能代替真机。
2. **传输健壮性实测**：迁移中断网/杀进程后续传、真机抓包确认无明文；主动 MITM 仅作安全余项记录。
3. **本地已 commit**（本轮改动 + 证据 + 文档）；**push 需用户明确授权**，不得自行推送。
4. 残余风险见 `docs/risks.md` #14、#16、#19–#20；新机首次可能整份重算视频摘要（512MiB 级有卡顿风险）。
5. 手机端 A4 导出落盘：11-08 用户明确不做；电脑端 `scripts/export-a4-sheets.mjs` 保持可用。
6. 复盘产出待处置：自动化候选 A1 待回「A1」；「给管家的话」待转发；机制一候选为空。

**接续提示词**：先读本文件与 `docs/handoff/2026-11-09-video-migration-status.md` §七；下一步做「同步保护真机核验」与「断网/杀进程续传实测」，禁全量回归、禁以单测代替真机；push 前先取得用户明确授权。

## 三、指针（按需读，别全量加载）

| 内容 | 位置 |
|---|---|
| 本轮换机迁移真机验收 | `docs/qa/evidence-2026-11-09-migration-e2e/QA_RESULT.md` |
| 迁移实现与风险细节 | `docs/handoff/2026-11-09-video-migration-status.md` §二/§七 |
| 换机迁移中央 Skill | `lan-device-migration-local-zh`（中央仓库，1.0.0，已分发 11/11） |
| V1.3-R2 整改与真机 QA | `docs/qa/evidence-2026-11-04-v13-r2/QA_RESULT.md` |
| 验收矩阵 | `docs/qa/产品验收追踪矩阵.md` |
| 1.1.32 自动配对｜1.1.21 Tailscale | `…-2026-11-08-auto-pair/`｜`…-tailscale-endpoint/` |
| 视频持久/孤儿 QA | `docs/qa/evidence-2026-11-09-video-store-orphan/QA_RESULT.md` |
| 译文合并与修正依据 | `…-realqa-merge*/EXECUTION-REPORT.md`、`…-lyrics-translation/CORRECTION-2026-10-31.md` |
| V3.2 结构地图 SDD｜V3.1 运行说明 | `docs/plan/P040-Song-Structure-Map-V3.2/`｜`docs/vocal-v31-operations.md` |
| A4 导出脚本（电脑端） | `scripts/export-a4-sheets.mjs` |
| 架构/构建｜风险｜踩坑｜服务登记 | `docs/architecture-facts.md` §六｜`docs/risks.md`｜根 `agent.md`｜治理仓 `后台服务登记表.md` |

## 四、归档

批次正文、旧表述与包哈希迁至 `HANDOFF-2026-10-31-详情归档.md`；构建记录见 `docs/architecture-facts.md` §四。
