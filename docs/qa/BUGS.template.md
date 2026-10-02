
# BUGS

| Bug ID | Priority | Stage P0 Blocking? | Repro | Status | Current Task | 备注（截图/日志一句） |
|---|---|---:|---|---|---|---|

## 产品验收追踪矩阵

> 本节为 Phase2 放行必填：关键 AC 未测或核心路径未实际点击即不得 `PASS`；状态枚举 `PASS / FAIL / DEGRADED / 未测 / 人工判定`，其中 `人工判定` 为**中间态**、`PASS / FAIL / DEGRADED / 未测` 为**终态**——不可自动测的审美/设计项，其**最终状态必须落 `PASS` 或 `FAIL`**，中间过程才记 `人工判定`；记 `人工判定` 必须同时记录判定人、判定依据、判定时间与 PASS/FAIL 结果；**未判的一律记 `未测`**，不得用 `人工判定` 顶替未测。状态列为单条 AC 的证据状态；整体结论 QA_RESULT=PASS/DEGRADED/FAIL 仍按 `docs/sop/webqa.md` §六 出。`关键 AC` 列须与 `PRODUCT_PLAN` 的「关键 AC 集合」逐条一致（Plan 标“是”的，本表必须标“是”；禁在 QA 阶段自行升降级）。

| AC 编号 | 关键 AC | 用户任务 | 前置数据/边界样本 | 设备/视口 | 操作步骤 | 预期结果 | 实际结果 | 状态 | 证据位置（截图/浏览器日志/路由） | 关联缺陷 ID |
|---|---|---|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |  |  |  |  |

- 不可自动测的审美/设计项：中间过程记 `人工判定` 并写明判定人、判定依据、判定时间；**最终状态必须落 `PASS` 或 `FAIL`**，未判记 `未测`，禁以 `人工判定` 顶替未测。
- 本节不替代也不删减既有「真机QA会话能力预检结果」节，两者都要填。

## 真机QA会话能力预检结果（每真机session正式用例前必填，PASS才进正式QA，否则停）

> 判据：`ok=true/exit 0/工具调用成功`但无状态或像素变化一律记 `FAIL_UNVERIFIED_ACTION`；禁跨模型/跨Runtime/跨session拼PASS。

- 日期/任务名：
- session ID：
- 模型精确ID：
- Runtime：
- 原生CUA是否实际注入（确认是否真实存在 `mcp__cua_repl.js`，无结果如实记“未注入”，禁伪称已存在）：
- 可用工具精确名称：
- CLI备用入口是否存在（Bash→orca computer CLI）：
- Orca Runtime（`orca status --json` 实时结果，禁沿用旧报告）：state／reachable／connectionState：
- 能力（`orca computer capabilities --json` 实时结果）：
- 权限（`orca computer permissions --json` 实时结果）：Accessibility／Screenshots／Orca应用访问是否批准：
- 读屏结果（事先指定可见文字，禁拿date/静态文件/命令输出冒充）：
- 截图结果（真实截图核对目标窗口＋像素尺寸）：
- 点击并恢复结果（只点无副作用控件如切换侧边栏，读动作后状态确认变化，刷新元素索引后恢复，窗口变化后重取状态禁复用旧索引）：
- 输入并清除结果（专用测试框写 `QA-CUA-CANARY`，AX值＋像素/真实UI双验，清除残留禁按Enter）：
- 滚动及可见位移结果（明确可滚动区域，必须观察到内容或像素位移，像素差为零记 `FAIL_UNVERIFIED_ACTION`）：
- 界面恢复确认（无残留）：
- 最终结论（枚举只许 `PASS / BLOCKED_TOOL_NOT_INJECTED / BLOCKED_ORCA_APPROVAL / BLOCKED_RUNTIME / BLOCKED_OS_PERMISSION / FAIL_UNVERIFIED_ACTION / NOT_VERIFIED`，禁 `FAIL_MODEL_ACTION`）：
- 原始错误摘要：
- 是否允许进入正式QA（全PASS才YES，否则NO即停）：

## Fix Attempt Fingerprint

- Task ID:
- Root Cause Hypothesis:
- Approach:
- Files Changed:
- Verification:
- Failure Reason:
- Difference From Previous Attempt:

> Attempt ID / Dispatch ID / Model-Backend 系字段 2.0 已废弃，不填（模型轨迹记账本）。
