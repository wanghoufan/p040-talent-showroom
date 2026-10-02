# orca-decide｜ORCA Decision Sidecar CLI（旧四 Contract 已接线；新三 Contract 仍为 Shadow）

> 状态：PASS（2026-09-22，TypeSafe 直调 Smoke＋T01-T10 10/10，实测 jev-1.13.0）。
> Jev = 建议，ORCA 规则 = 权限。不新增角色，不进主链，不改 USER_MODEL_OVERRIDE。
> 传输：Node fetch 直调 https://api.typesafe.ai/v1/systemone，无 SDK 依赖（零 dependencies）。

## 用法

```bash
./orca-decide.mjs [--data-class PUBLIC] <change|route|user|p0|profile|bclass|skill> <state.json>
（--data-class 只能由可信 Harness 提供；缺省按 NEEDS_USER_POLICY 拒绝发送）
node run-shadow.mjs [out.jsonl]   # 全量自动回归（断言决策＋过滤＋退出码）
node test-filter.mjs              # Hard Filter 六分支本地单测（零网络零额度）
```

输出稳定 JSON：`{schema_version, mode, ok, decision, selected_probability, confidence, probabilities[, risk][, task_type/complexity][, classifier/skills][, eligible_pool/pool_excluded/route_recommendation], advisory_only:true, model, requested_model, resolved_model, contract_version, policy_version, usage}`。
失败：`{ok:false, error, fallback:"ORCA_V2_1_EXISTING_LOGIC"}` + exit 非 0，绝不伪造成功。
发送前硬门禁：白名单字段外不发送；`data_class=SECRET` 或值命中密钥正则直接 `SECRET_REFUSED`（网络调用前）。
返工四字段：`supervisor_rework_count`（唯一触发确定性升级）＋`code_review_failure_count`／`qa_failure_count`／`senior_rework_count`（仅记录区分）；旧 `rework_count` 不再触发。
确定性短路输出 `SKIP_DETERMINISTIC`，selected/confidence 置 null（不伪造）。
全 Contract 严格枚举/类型/范围校验，缺字段或非法值一律 `JEV_SCHEMA_CHANGED`。
Jev 版本：`/v1/models` 仅有 `jev-latest`/`jev-preview` 别名（2026-09-22 查），无固定版；每次记录 requested/resolved（现 `jev-1.13.0`），升级视为 router 换版重跑夹具。
同步超时：在线 `JEV_SYNC_TIMEOUT_MS`（默认 12000，不重试，超时即 fallback，最坏约 12s）；
离线批量 `ORCA_DECIDE_OFFLINE=1` 走 `JEV_EVAL_TIMEOUT_MS`（默认 60000）／`JEV_EVAL_MAX_RETRIES`（默认 2）。
仅 429/529 重试，其余失败即 fallback，不卡主链。

错误码：`BAD_ARGS/BAD_MODE/STATE_FILE_MISSING/BAD_JSON/KEY_MISSING/JEV_AUTH/JEV_QUOTA_OUT/JEV_BAD_REQUEST/JEV_RATE_LIMITED/JEV_OVERLOADED/JEV_SERVER_ERROR/JEV_NETWORK/JEV_UNAVAILABLE/JEV_SCHEMA_CHANGED`。

## 确定性优先

- `p0` 且 `supervisor_rework_count>=2`：不调 API，直接返回 `SKIP_DETERMINISTIC`（确定性升级走规则，绝不写成 P0=true）。
- Human Gate/删除/不可逆/付费/模型切换：永不由本 CLI 自动批准（调用方 TM 负责）。

## Fixtures

`fixtures/T01-T10.json`：change×3、route×3、user×2、p0×2，各含 `expected`。Jev 解锁后跑：

```bash
for t in change:T01 change:T02 change:T03 route:T04 route:T05 route:T06 user:T07 user:T08 p0:T09 p0:T10; do
  ./orca-decide.mjs ${t%%:*} fixtures/${t#*:}.json
done
```

错误码：`BAD_ARGS/BAD_MODE/STATE_FILE_MISSING/BAD_JSON/KEY_MISSING/JEV_AUTH/JEV_QUOTA_OUT/JEV_BAD_REQUEST/JEV_RATE_LIMITED/JEV_OVERLOADED/JEV_SERVER_ERROR/JEV_NETWORK/JEV_UNAVAILABLE/JEV_SCHEMA_CHANGED`，一律 exit 非 0。

## Secret

仅 `~/.config/orca/decision.env`（600）。禁入仓库/日志/Prompt/HANDOFF。

## 依赖

零依赖（Node≥22 fetch 直调）。曾走 AI SDK＋Gateway 已废弃，见 Git 历史。

- 决策流水（best-effort）：每次调用追加一行到项目内 `docs/model/JEV-DECISION-LOG.jsonl`（env `JEV_DECISION_LOG` 覆盖；目录不存在则跳过；只记非敏感元数据，不记 state 原文/Key；不改权限与 Contract）。回归 `node test-decision-log.mjs`。
