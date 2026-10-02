# decision-router｜Decision Sidecar 调用面（基础设施规范位）

> Jev = 建议，ORCA 规则 = 权限。只在规则无唯一答案的分叉点由 TM 调用。

- 工具：`scripts/decision/orca-decide.mjs <change|route|user|p0|profile|bclass|skill> <state.json>`（直调 https://api.typesafe.ai/v1/systemone，jev-latest）。
- 输出稳定 JSON（decision＋selected_probability＋confidence＋probabilities＋advisory_only＋requested/resolved＋contract/policy版本＋usage）；失败 exit 非 0＋fallback 回 V2.1 逻辑，绝不默认成功。
- 七类：CHANGE_CLASS(A/B/C)、ISSUE_OWNER(6 枚举)、USER_REQUIRED(5 枚举)、P0_HARD(bool＋risk)、TASK_PROFILE(task_type/complexity分记)、BUILDER_CLASS(4 档＋route_targets)、SKILL_ROUTE(家族＋skills[0..2])；后三 Shadow only，阈值 null。
- Hard Filter（`scripts/decision/policy.json`，hardfilter-v3）：availability/quota/runner/caps/data_policy/authorized_targets 六判；缺声明默认 NEEDS_USER_POLICY；两目标现全 excluded（如实记录；MiMo 默认 Harness 已定 **Claude Code**，OpenCode 作备，`radeon-mimo` 直连已验 `mimo ok`）。
- 发送前门禁：字段白名单＋SECRET正则＋data_class门禁（网络调用前）。
- 不调用：规则有唯一答案、rework 计数、Human Gate 已触发、watchdog、exit code、权限明文规定。
- 置信（V1 历史默认，不继承给新 Contract）：≥0.85 可采用（先查规则冲突）；0.65–0.85 仅提示；<0.65 回退。新 Contract 阈值全为 null，采数后再校准：
  `contract_thresholds: {TASK_TYPE:null, COMPLEXITY:null, BUILDER_CLASS:null, SKILL_ROUTE:null}`。
  Human Gate/删除/不可逆/付费/换模型永不自动批。
- Secret：`~/.config/orca/decision.env`（TYPESAFE_API_KEY，600），禁入仓。
- 用量：每次 usage.input_tokens 自行累计；402 即额度用尽，停用并找用户。
- 决策流水（2026-09-26）：每次调用 best-effort 追加一行到项目内 `docs/model/JEV-DECISION-LOG.jsonl`（env `JEV_DECISION_LOG` 可覆盖）；只记非敏感元数据（mode/decision/confidence/model/requested+resolved/policy_version/input_digest/latency_ms/fallback/deterministic_shortcut/ok），**不记 state 原文、不记 Key**；目录不存在则跳过；**不改 Jev 权限与 Contract**；回归 `scripts/decision/test-decision-log.mjs`。

## 并行四 Contract（Shadow）
- pmmode：判定任务并行/串行/单跑，Shadow only，阈值 null。
- fanout：判定并行路数（W1=串行单 worker / W2=两路并行，上限 2），Shadow only，阈值 null。
- partchoice：从候选分区方案 PLAN_A/B/C/NONE 里选一套（NONE=保持串行），Shadow only，阈值 null。
- mergerisk：评估合并冲突风险等级，Shadow only，阈值 null。
- 调用失败回 V2.1 逻辑，永不自动批 Human Gate 相关项。
