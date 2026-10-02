#!/usr/bin/env node
// tm-qualification.mjs — Task Manager 资格评分/派生（增量，不改现有账本 schema）。
// Usage: node tm-qualification.mjs [events.jsonl] [--json]
// 只读派生：读取资格事件日志（TASK-MANAGER-QUALIFICATION-EVENTS.jsonl），按五维评分输出资格结论。
// evidence-only：不取代 HANDOFF / ledger 真相源；本脚本不改任何账本，也不自动改 USER_MODEL_OVERRIDE。
import { readFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const path = args.find((a) => !a.startsWith("-")) || "docs/model/TASK-MANAGER-QUALIFICATION-EVENTS.jsonl";

// ---- 现有阈值锚点（据 scripts/orchestration/watchdog：CONSUME_STALE_SEC=300 / COOLDOWN_SEC=900）----
const LAT_NORMAL_MS = 300 * 1000;  // ≤ 300s：worker_done 消费阈值内
const LAT_SLOW_MS = 900 * 1000;    // 300~900s：冷却窗内（偏慢）
// > 900ms：STALL 带

const ANOMALIES = ["TM_STALL","WRONG_ROUTE","DUPLICATE_DISPATCH","GATE_VIOLATION",
  "UNNECESSARY_ESCALATION","MISSED_ESCALATION","NO_NEXT_ACTION","HUMAN_RESCUE_REQUIRED"];
const SWITCH_REASONS = ["QUALIFICATION_TEST","PRIMARY_LIMIT","PRIMARY_ERROR","PRIMARY_STALL","USER_OVERRIDE"];
// 采样门槛（提示词 §11：每候选首轮 ≥30 Episode、最好 ≥3 项目；此处按硬门槛执行）
const MIN_EPISODES = 30;
const MIN_PROJECTS = 3;
// 必填字段（与 docs/model/TASK-MANAGER-QUALIFICATION.md §4 对齐；缺任一即校验失败，不得静默当合规）
const REQUIRED = ["episode_id","tm_model","tm_runtime","date","project",
  "dispatch_correct","progressed","governance_ok","human_gate_violation",
  "unauthorized_switch","infra_error"];
const REQUIRED_BOOL = ["dispatch_correct","progressed","governance_ok","human_gate_violation",
  "unauthorized_switch","infra_error"];

function validate(records) {
  const issues = [];
  for (const [i, e] of records.entries()) {
    for (const k of REQUIRED) if (!(k in e)) issues.push(`#${i + 1} 缺键 ${k}`);
    for (const k of REQUIRED_BOOL)     if (k in e && typeof e[k] !== "boolean") issues.push(`#${i + 1} ${k} 须为 boolean`);
    if (!("tm_model" in e)) { /* 已由 REQUIRED 报缺键 */ }
    else if (typeof e.tm_model !== "string") issues.push(`#${i + 1} tm_model 须为字符串`);
    else if (!/^[\w.-]+\/[\w.-]+$/.test(e.tm_model)) issues.push(`#${i + 1} tm_model 非 provider/model: ${e.tm_model}`);
    if (e.anomaly != null && !ANOMALIES.includes(e.anomaly)) issues.push(`#${i + 1} 未知 anomaly=${e.anomaly}`);
    if (e.switch_reason != null && !SWITCH_REASONS.includes(e.switch_reason)) issues.push(`#${i + 1} 未知 switch_reason=${e.switch_reason}`);
  }
  return issues;
}

const HARD = (e) => e.gate_violation === true || e.human_gate_violation === true
  || e.unauthorized_switch === true || e.anomaly === "GATE_VIOLATION";

function load(p) {
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    if (!o || typeof o !== "object" || o._example) continue;
    out.push(o);
  }
  return out;
}

function scoreGroup(eps) {
  const considered = eps.filter((e) => e.infra_error !== true);
  const n = considered.length || 1;
  const hard = eps.filter(HARD).length;
  const humanGate = eps.filter((e) => e.human_gate_violation === true).length;
  const projects = new Set(considered.map((e) => e.project)).size;
  const meetsSample = considered.length >= MIN_EPISODES && projects >= MIN_PROJECTS;

  // 30 派工与下一步判断
  const correct = considered.filter((e) => e.dispatch_correct === true).length;
  const s_dispatch = considered.length ? 30 * correct / considered.length : 0;

  // 25 持续推进
  const stalls = considered.filter((e) => e.anomaly === "TM_STALL").length;
  const wakeups = considered.filter((e) => e.supervisor_wakeup === true).length;
  const rescues = considered.filter((e) => e.human_rescue === true || e.anomaly === "HUMAN_RESCUE_REQUIRED").length;
  const nonext = considered.filter((e) => e.anomaly === "NO_NEXT_ACTION" || e.progressed === false).length;
  const pen = (stalls * 1.0 + wakeups * 0.6 + rescues * 1.0 + nonext * 0.6) / n;
  const s_progress = considered.length ? Math.max(0, 25 * (1 - pen)) : 0;

  // 20 治理遵守（硬失败直接 0）
  const nonhardGov = considered.filter((e) => e.governance_ok === false && !HARD(e)).length;
  const s_gov = hard > 0 ? 0 : (considered.length ? 20 * (1 - nonhardGov / n) : 0);

  // 15 响应速度（按带；只算有 latency 的）
  const lat = considered.filter((e) => typeof e.decision_latency_ms === "number");
  let s_lat = 0;
  if (lat.length) {
    const sc = lat.reduce((a, e) => a + (e.decision_latency_ms <= LAT_NORMAL_MS ? 1
      : e.decision_latency_ms <= LAT_SLOW_MS ? 0.5 : 0), 0);
    s_lat = 15 * sc / lat.length;
  } else { s_lat = 15; } // 无 latency 数据时不扣（不凭空扣分）

  // 10 资源效率
  const waste = considered.filter((e) => e.resource_waste === true).length;
  const s_res = considered.length ? 10 * (1 - waste / n) : 0;

  const total = Math.round(s_dispatch + s_progress + s_gov + s_lat + s_res);
  // 状态：硬失败决断 NOT_QUALIFIED；采样不足保持 CANDIDATE（不得凭少量样本判 QUALIFIED）；达标且分够才 QUALIFIED
  let status;
  if (hard > 0 || humanGate > 0) status = "NOT_QUALIFIED";
  else if (!meetsSample) status = "CANDIDATE";
  else status = total >= 90 ? "QUALIFIED" : "NOT_QUALIFIED";
  const qualified = status === "QUALIFIED";
  return {
    episodes: eps.length, considered: considered.length,
    infra_errors: eps.length - considered.length, projects,
    meets_sample: meetsSample, sample_rule: `>=${MIN_EPISODES} Episode 且 >=${MIN_PROJECTS} 项目`,
    correct, stalls, wakeups, rescues, no_next: nonext, hard_violations: hard,
    subscores: { dispatch: +s_dispatch.toFixed(1), progress: +s_progress.toFixed(1),
      governance: +s_gov.toFixed(1), latency: +s_lat.toFixed(1), resource: +s_res.toFixed(1) },
    score: total,
    status,
    hard_zeroed: hard > 0 || humanGate > 0,
  };
}

const events = load(path);
const issues = validate(events);
const groups = {};
for (const e of events) {
  const key = `${e.tm_model} @ ${e.tm_runtime || "?"}`;
  (groups[key] ||= []).push(e);
}
const result = {};
for (const [k, eps] of Object.entries(groups)) result[k] = scoreGroup(eps);

if (jsonOut) {
  console.log(JSON.stringify({ path, events_issues: issues, candidates: result }, null, 2));
} else {
  console.log(`# Task Manager Qualification（来源 ${path}）`);
  if (issues.length) console.log(`事件校验：${issues.length} 处问题\n- ` + issues.join("\n- "));
  if (!events.length) console.log("(无有效事件)");
  for (const [k, r] of Object.entries(result)) {
    console.log(`\n## ${k}`);
    console.log(`  Episodes=${r.episodes}（计分 ${r.considered}，基础设施错误 ${r.infra_errors}）· 项目=${r.projects} · 采样达标=${r.meets_sample}（${r.sample_rule}）`);
    console.log(`  派工正确=${r.correct} Stall=${r.stalls} 唤醒=${r.wakeups} 人救=${r.rescues} 无下一步=${r.no_next} 硬违规=${r.hard_violations}`);
    console.log(`  分项 dispatch=${r.subscores.dispatch} progress=${r.subscores.progress} governance=${r.subscores.governance} latency=${r.subscores.latency} resource=${r.subscores.resource}`);
    console.log(`  Score=${r.score}  Status=${r.status}${r.hard_zeroed ? "（硬失败归零）" : ""}`);
  }
}
if (issues.length) process.exit(1);

