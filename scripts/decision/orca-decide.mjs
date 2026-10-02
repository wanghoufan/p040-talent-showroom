#!/usr/bin/env node
// orca-decide — ORCA Decision Sidecar CLI (shadow/advisory only).
// Transport: direct POST https://api.typesafe.ai/v1/systemone (model jev-latest).
// Usage: orca-decide <change|route|user|p0|profile|bclass|skill> <state.json>
// Secret: ~/.config/orca/decision.env (TYPESAFE_API_KEY). Never printed, never sent anywhere except TypeSafe.
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, dirname, delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
function loadJson(p, fb) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fb; }
}
const POLICY = loadJson(join(HERE, "policy.json"), null);
const MANIFEST = loadJson(join(HERE, "evals", "skill-manifest.json"), null);
import { accessSync, constants } from "node:fs";
function binOnPath(b) {
  if (/[^A-Za-z0-9_.\-]/.test(b)) return false;
  const paths = (process.env.PATH || process.env.Path || "/usr/bin:/bin").split(delimiter);
  for (const d of paths) {
    try { accessSync(d + "/" + b, constants.X_OK); return true; }
    catch { /* next */ }
  }
  return false;
}
function filterTargets(ids, tg, up, need, binCheck = binOnPath, taskClass = "PUBLIC") {
  const eligible = [], excluded = [];
  for (const id of ids) {
    const t = tg[id] || {};
    const reasons = [];
    if (!String(t.availability || "")) reasons.push("availability");
    else if (!["AVAILABLE", "AVAILABLE_VERIFIED"].includes(t.availability)) reasons.push("availability:" + t.availability);
    if (t.quota_status !== "OK" && !(t.quota_status === "UNKNOWN" && up.allow_unknown_quota === true)) reasons.push("quota:" + (t.quota_status || "MISSING"));
    if (t.runner_bin && !binCheck(t.runner_bin)) reasons.push("runner:" + t.runner_bin);
    const caps = t.capabilities || [];
    const miss = (need || []).filter((c) => !caps.includes(c));
    if (miss.length) reasons.push("caps:" + miss.join(","));
    // provider acceptance of THIS task class (explicit allow-list, default deny)
    const pol = t.data_policy || "MISSING";
    if (!["ALLOWED", "NEEDS_USER_POLICY"].includes(pol)) { reasons.push("data_policy:ILLEGAL-" + pol); }
    const authMap = (POLICY && POLICY.provider_data_auth) || {};
    const allowed = authMap[t.provider] || [];
    let okData = allowed.includes(taskClass);
    if (t.provider === "volc-coding" && up.volc_personal_private_code === true &&
        ["PUBLIC", "PRIVATE_CODE", "PERSONAL_SENSITIVE"].includes(taskClass)) okData = true;
    if (!okData) reasons.push("data_policy:" + pol + "/task:" + taskClass);
    if (!(up.authorized_targets || []).includes(id)) reasons.push("unauthorized-target");
    (reasons.length ? excluded : eligible).push(reasons.length ? { route_target_id: id, excluded_reasons: reasons } : { route_target_id: id, availability: t.availability, quota_status: t.quota_status });
  }
  return { eligible, excluded };
}
const POLICY_VERSION = (POLICY && POLICY.policy_version) || "unknown";

// ---- 决策流水（best-effort、不泄密、不改权限）----
// 每次调用追加一行到项目内 docs/model/JEV-DECISION-LOG.jsonl（可用 env JEV_DECISION_LOG 覆盖）。
// 只记非敏感元数据（mode/decision/confidence/model/policy_version/digest 等）；不记 state 原文、不记 Key。
// 目录不存在则静默跳过；任何异常绝不影响决策主流程与 stdout。
const T0 = Date.now();
function digest(s) { return createHash("sha256").update(s || "").digest("hex").slice(0, 16); }
function logDecision(entry) {
  try {
    const rel = process.env.JEV_DECISION_LOG || join(process.cwd(), "docs", "model", "JEV-DECISION-LOG.jsonl");
    if (!existsSync(dirname(rel))) return;
    const now = new Date();
    const line = JSON.stringify({
      date: now.toISOString().slice(0, 10), ts: now.toISOString(),
      project: process.cwd().split(/[\\/]/).filter(Boolean).pop() || null,
      latency_ms: Date.now() - T0, ...entry,
    });
    appendFileSync(rel, line + "\n");
  } catch { /* best-effort */ }
}

const ENDPOINT = process.env.ORCA_DECIDE_ENDPOINT || "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const SCHEMA = "2.0";

function firstNonOption() {
  const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === "--data-class" || a === "--runner") { i++; continue; }
    if (a.startsWith("--data-class=") || a.startsWith("--runner=")) continue;
    if (a.startsWith("-")) continue;
    return a;
  }
  return null;
}

function fail(code, fallback = "ORCA_V2_1_EXISTING_LOGIC") {
  const m = firstNonOption();
  logDecision({ ok: false, error: code, fallback, mode: MODES[m] ? m : null, advisory_only: null });
  console.log(JSON.stringify({ ok: false, error: code, fallback, advisory_only: null, contract_version: "v1.5", policy_version: POLICY_VERSION }));
  process.exit(1);
}

function loadKey() {
  const p = join(homedir(), ".config", "orca", "decision.env");
  if (!existsSync(p)) fail("KEY_MISSING");
  const txt = readFileSync(p, "utf8");
  const m = txt.match(/^TYPESAFE_API_KEY=(.+)$/m);
  if (!m || m[1].trim().length < 10) fail("KEY_MISSING");
  return m[1].trim();
}

// ---- pre-send hard gate ----
const SECRET_RE = /(api[_-]?key|passwd|password|secret)\s*[:=]\s*\S{8,}|bearer\s+\S{8,}|sk-(proj|ant|svcacct|user)-[A-Za-z0-9\-_]+|sk-[A-Za-z0-9]{8,}|apikey_[A-Za-z0-9]+|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]+|xox[bap]-[A-Za-z0-9\-]+|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{20,}|npm_[A-Za-z0-9]{8,}|pypi-[A-Za-z0-9\-_]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|vck-[A-Za-z0-9\-]+|ark-[A-Za-z0-9]{8,}-[A-Za-z0-9\-]{4,}/i;
const SEND_ALLOW = {
  change: ["change_request", "project_phase", "dev_baseline", "requirement_dod", "affected_modules", "schema_changed", "arch_changed", "core_flow_changed", "perm_changed", "note"],
  route: ["task", "failure", "evidence", "test_result", "files", "phase", "note"],
  user: ["pending", "irreversible", "needs_perm", "is_human_gate", "direction_change", "rule_has_answer", "note"],
  p0: ["issue", "impact", "core_sm", "perm", "data_loss", "arch", "blocking", "evidence", "supervisor_rework_count", "code_review_failure_count", "qa_failure_count", "senior_rework_count", "note"],
  profile: ["task", "required_capabilities", "note"],
  bclass: ["task", "task_profile", "required_capabilities", "note"],
  skill: ["task", "required_capabilities", "note"],
};
function gateInput(mode, s) {
  // data_class NEVER comes from task JSON (untrusted). Caller supplies via --data-class or ORCA_DATA_CLASS.
  const dc = String(CLI_DATA_CLASS || process.env.ORCA_DATA_CLASS || "NEEDS_USER_POLICY").toUpperCase();
  const rule = (POLICY && POLICY.data_rules && POLICY.data_rules[dc]) || "NEEDS_USER_POLICY";
  if (rule === "REFUSE") fail("SECRET_REFUSED");
  if (rule === "NEEDS_USER_POLICY") fail("NEEDS_USER_POLICY");
  // Jev send gate consumes provider_data_auth too: typesafe must explicitly allow this class
  const authMap = (POLICY && POLICY.provider_data_auth) || {};
  if (!(authMap.typesafe || []).includes(dc)) fail("NEEDS_USER_POLICY");
  const allow = SEND_ALLOW[mode] || [];
  const out = {};
  for (const k of allow) if (s[k] !== undefined && k !== "data_class") out[k] = s[k];
  out.data_class = dc;
  const blob = JSON.stringify(out);
  if (SECRET_RE.test(blob)) fail("SECRET_REFUSED");
  return out;
}

const MODES = {
  change: {
    q: {
      change_class: {
        type: "choice",
        instructions: "Classify the change request. Reply with exactly one key.",
        criteria: { A: "dev-internal small tweak", B: "local feature change", C: "product/architecture change needing Controlled Reopen" },
      },
    },
    need: ["change_class"],
    check: (a) => choiceOk(a.change_class, ["A", "B", "C"]),
    pick: (a) => a.change_class.choice,
    stats: (a) => split(a.change_class),
  },
  route: {
    q: {
      issue_owner: {
        type: "choice",
        instructions: "Decide which role owns this issue. Reply with exactly one key.",
        criteria: { PLANNER: "requirement undefined", BUILDER: "implementation bug", CODE_REVIEWER: "review finding", QA: "test/stale-case issue", DB_ADMIN: "RLS/schema/migration issue", TASK_MANAGER: "uncertain, needs orchestrator ruling" },
      },
    },
    need: ["issue_owner"],
    check: (a) => choiceOk(a.issue_owner, ["PLANNER", "BUILDER", "CODE_REVIEWER", "QA", "DB_ADMIN", "TASK_MANAGER"]),
    pick: (a) => a.issue_owner.choice,
    stats: (a) => split(a.issue_owner),
  },
  user: {
    q: {
      user_required: {
        type: "choice",
        instructions: "Decide whether the user must be consulted. Reply with exactly one key.",
        criteria: { NO: "decidable by rules", YES_PRODUCT_DIRECTION: "product direction", YES_PERMISSION: "needs permission", YES_IRREVERSIBLE: "irreversible", YES_HUMAN_GATE: "human gate" },
      },
    },
    need: ["user_required"],
    check: (a) => choiceOk(a.user_required, ["NO", "YES_PRODUCT_DIRECTION", "YES_PERMISSION", "YES_IRREVERSIBLE", "YES_HUMAN_GATE"]),
    pick: (a) => a.user_required.choice,
    stats: (a) => split(a.user_required),
  },
  p0: {
    q: {
      p0_hard: { type: "noul", instructions: "Is this a P0-hard blocking issue?" },
      risk: { type: "score", instructions: "Risk from harmless to critical.", criteria: ["harmless", "low", "medium", "high", "critical"] },
    },
    need: ["p0_hard", "risk"],
    check: (a) => {
      if (!a.p0_hard || typeof a.p0_hard.noul !== "number" || a.p0_hard.noul < 0 || a.p0_hard.noul > 1) return false;
      if (!a.risk || typeof a.risk.score !== "number" || a.risk.score < 0 || a.risk.score > 4) return false;
      return true;
    },
    pick: (a) => (a.p0_hard.noul >= 0.5 ? true : false),
    stats: (a) => {
      const n = a.p0_hard.noul;
      return { selected: n >= 0.5 ? n : 1 - n, confidence: null, probs: null };
    },
    extra: (a, levels) => ({ risk: scaleScore(a.risk, levels) }),
  },
  profile: {
    q: {
      task_type: { type: "choice", instructions: "Task type. Reply one key.", criteria: { UI_TEXT: "copy/style tweak", CRUD: "create/read/update/delete", BUGFIX: "fix with tests", DEBUG: "complex investigation", REFACTOR: "repo-wide change", DB_MIGRATION: "schema/migration", DEPLOY: "deploy/release", DOCS: "documentation", TEST: "test work", DESTRUCTIVE: "high-risk delete" } },
      complexity: { type: "choice", instructions: "Complexity. Reply one key.", criteria: { S: "trivial", M: "moderate", L: "large", XL: "repo-wide" } },
    },
    need: ["task_type", "complexity"],
    check: (a) => choiceOk(a.task_type, ["UI_TEXT", "CRUD", "BUGFIX", "DEBUG", "REFACTOR", "DB_MIGRATION", "DEPLOY", "DOCS", "TEST", "DESTRUCTIVE"]) && choiceOk(a.complexity, ["S", "M", "L", "XL"]),
    pick: (a) => `${a.task_type.choice}/${a.complexity.choice}`,
    stats: (a) => ({ selected: null, confidence: null, probs: null }),
    extra: (a) => ({
      shadow: true, applied_threshold: null,
      task_type: { decision: a.task_type.choice, ...split(a.task_type) },
      complexity: { decision: a.complexity.choice, ...split(a.complexity) },
    }),
  },
  bclass: {
    q: {
      builder_class: { type: "choice", instructions: "Suggest builder capability tier. Reply one key.", criteria: { BULK_FAST: "fast bulk edits", GENERAL_AGENT: "general coding", HARD_CODE: "hard logic", NO_RECOMMENDATION: "uncertain, keep current default" } },
    },
    need: ["builder_class"],
    check: (a) => choiceOk(a.builder_class, ["BULK_FAST", "GENERAL_AGENT", "HARD_CODE", "NO_RECOMMENDATION"]),
    pick: (a) => a.builder_class.choice,
    stats: (a) => split(a.builder_class),
    extra: (a, _lv, ctx) => {
      const cls = a.builder_class && a.builder_class.choice;
      // Pool was computed BEFORE the Jev call (see main); extra only maps class∩pool.
      const pool = (ctx && ctx.pool) || { eligible: [], excluded: [] };
      const inPool = new Set(pool.eligible.map((e) => e.route_target_id));
      const classIds = ((POLICY && POLICY.class_targets && POLICY.class_targets[cls]) || []);
      const mapped = classIds.filter((id) => inPool.has(id));
      const rec = mapped.length ? mapped[0] : null;
      return {
        shadow: true, applied_threshold: null,
        eligible_pool: pool.eligible.map((e) => e.route_target_id),
        pool_excluded: pool.excluded,
        route_recommendation: rec,
        route_recommendation_note: rec ? "pool∩class hit" : "zero eligible -> NO RECOMMENDATION (shadow classification kept in builder_class)",
      };
    },
  },
  skill: {
    q: {
      skill_route: { type: "choice", instructions: "Which skill family fits? Reply one key.", criteria: { NONE: "no skill needed", QA: "browser/device testing", DB: "database", DEPLOY: "deploy", DOCS: "docs(writeup)", CODE: "codegen/review" } },
    },
    need: ["skill_route"],
    check: (a) => choiceOk(a.skill_route, ["NONE", "QA", "DB", "DEPLOY", "DOCS", "CODE"]),
    pick: (a) => a.skill_route.choice,
    stats: (a) => split(a.skill_route),
    extra: (a, _lv, ctx) => ({ classifier: "SKILL_FAMILY_CLASSIFIER", shadow: true, applied_threshold: null, skills: familySkills(a.skill_route?.choice, CLI_RUNNER || process.env.ORCA_RUNNER || null) }),
  },
  pmmode: {
    q: {
      parallel_mode: { type: "choice", instructions: "Should this task run serial or parallel? Reply one key.", criteria: { SERIAL: "single shared state machine, migration, lockfile, or tightly coupled change: must stay serial", PARALLEL_DISCOVERY: "unknown root cause needing read-only investigation by 2 workers, no code changes", PARALLEL_IMPLEMENTATION: "two or more independent modules with no shared state, safe to build in parallel", PARTIAL: "must first change shared types/interface serially, then build independent modules in parallel" } },
    },
    need: ["parallel_mode"],
    check: (a) => choiceOk(a.parallel_mode, ["SERIAL", "PARALLEL_DISCOVERY", "PARALLEL_IMPLEMENTATION", "PARTIAL"]),
    pick: (a) => a.parallel_mode.choice,
    stats: (a) => split(a.parallel_mode),
    extra: () => ({ shadow: true, applied_threshold: null }),
  },
  fanout: {
    q: {
      fanout_width: { type: "choice", instructions: "How many parallel workers? Reply one key.", criteria: { W1: "serial, one worker", W2: "two workers" } },
    },
    need: ["fanout_width"],
    check: (a) => choiceOk(a.fanout_width, ["W1", "W2"]),
    pick: (a) => a.fanout_width.choice,
    stats: (a) => split(a.fanout_width),
    extra: () => ({ shadow: true, applied_threshold: null, max_parallel_builders: 2 }),
  },
  partchoice: {
    q: {
      partition_choice: { type: "choice", instructions: "Which candidate partition plan to use? Reply one key.", criteria: { PLAN_A: "candidate A", PLAN_B: "candidate B", PLAN_C: "candidate C", NONE: "no parallel, stay serial" } },
    },
    need: ["partition_choice"],
    check: (a) => choiceOk(a.partition_choice, ["PLAN_A", "PLAN_B", "PLAN_C", "NONE"]),
    pick: (a) => a.partition_choice.choice,
    stats: (a) => split(a.partition_choice),
    extra: () => ({ shadow: true, applied_threshold: null }),
  },
  mergerisk: {
    q: {
      merge_risk: { type: "choice", instructions: "Merge risk of the partition? Reply one key.", criteria: { LOW: "safe to parallel", MEDIUM: "shadow/advisory only", HIGH: "default serial" } },
    },
    need: ["merge_risk"],
    check: (a) => choiceOk(a.merge_risk, ["LOW", "MEDIUM", "HIGH"]),
    pick: (a) => a.merge_risk.choice,
    stats: (a) => split(a.merge_risk),
    extra: () => ({ shadow: true, applied_threshold: null }),
  },
};

function choiceOk(c, keys) {
  if (!c || typeof c.choice !== "string" || !keys.includes(c.choice)) return false;
  if (c.probabilities === undefined || c.probabilities === null) return false;
  const ks = Object.keys(c.probabilities);
  if (ks.length !== keys.length || !keys.every((k) => ks.includes(k))) return false;
  let sum = 0;
  for (const v of Object.values(c.probabilities)) {
    if (typeof v !== "number" || v < 0 || v > 1) return false;
    sum += v;
  }
  if (Math.abs(sum - 1) > 0.02) return false;
  if (!(c.choice in c.probabilities)) return false;
  if (c.confidence !== undefined && c.confidence !== null && (typeof c.confidence !== "number" || c.confidence < 0 || c.confidence > 1)) return false;
  return true;
}
function split(c) {
  c = c ?? {};
  return { selected: c.probabilities?.[c.choice] ?? null, confidence: c.confidence ?? null, probs: c.probabilities ?? null };
}
const FAMILY_SKILLS = { QA: ["browseros-neo"], DB: [], DEPLOY: ["deploy-to-vercel", "netlify-deploy"], DOCS: ["ai-coding-homework-writeup", "github-readme-maintainer"], CODE: [], NONE: [] };
function familySkills(f, runner) {
  const idx = (MANIFEST && MANIFEST.skills) || {};
  const broken = new Set((MANIFEST && MANIFEST.broken_ids) || []);
  const out = [];
  for (const s of (FAMILY_SKILLS[f] || [])) {
    const e = idx[s];
    if (!e || broken.has(s)) continue;
    const agents = e.agents || [];
    if (runner && !agents.includes(runner)) continue;
    // path must belong to the matched runner and exist now
    const rp = (e.paths || {})[runner || agents[0]];
    if (!rp) continue;
    try { accessSync(rp.replace(/^~\//, homedir() + "/")); }
    catch { continue; }
    out.push(s);
    if (out.length >= 2) break;
  }
  return out;
}

function scaleScore(ans, levels) {
  if (!ans || typeof ans.score !== "number" || levels < 2) return null;
  return Math.max(0, Math.min(1, ans.score / (levels - 1)));
}

function stateText(mode, s) {
  // Deterministic ORCA escalation: supervisor_rework_count>=2 handled by rule; never ask P0_HARD, never emit P0=true.
  const n = s.supervisor_rework_count;
  if (mode === "p0" && typeof n === "number" && n >= 2) {
    return { deterministic: { skip: true, reason: "supervisor_rework_count>=2 -> deterministic senior escalation (rule); P0_HARD not consulted" } };
  }
  // Deterministic Human Gate: explicit gate flag never consults Jev.
  if (mode === "user" && s.is_human_gate === true) {
    return { deterministic: { decision: "YES_HUMAN_GATE", reason: "is_human_gate=true -> deterministic Human Gate (rule); Jev not consulted" } };
  }
  // Deterministic irreversible-delete gate: never consult Jev, force human decision.
  if (mode === "user" && s.irreversible === true) {
    return { deterministic: { decision: "YES_IRREVERSIBLE", reason: "irreversible=true -> deterministic human decision required (rule); Jev not consulted" } };
  }
  const gated = gateInput(mode, s);
  const parts = [];
  for (const [k, v] of Object.entries(gated)) parts.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
  return { text: parts.join("\n"), gated };
}

let mockFlaky = 0;
async function callApi(key, state, questions, attempt = 1) {
  const OFFLINE = process.env.ORCA_DECIDE_OFFLINE === "1";
  const TIMEOUT = Number(process.env[OFFLINE ? "JEV_EVAL_TIMEOUT_MS" : "JEV_SYNC_TIMEOUT_MS"] || (OFFLINE ? 60000 : 12000));
  const MAX_ATT = Number(process.env[OFFLINE ? "JEV_EVAL_MAX_RETRIES" : "JEV_SYNC_MAX_RETRIES"] || (OFFLINE ? 2 : 0)) + 1;
  const mock = process.env.ORCA_DECIDE_MOCK || "";
  if (mock === "timeout") fail("JEV_NETWORK");
  if (mock === "401") fail("JEV_AUTH");
  if (mock === "402") fail("JEV_QUOTA_OUT");
  if (mock === "422") fail("JEV_BAD_REQUEST");
  if (mock === "429") fail("JEV_RATE_LIMITED");
  if (mock === "flaky2") {
    mockFlaky++;
    if (mockFlaky <= 2) {
      if (attempt < MAX_ATT) {
        await new Promise((r) => setTimeout(r, 10));
        return callApi(key, state, questions, attempt + 1);
      }
      fail("JEV_RATE_LIMITED");
    }
    return { model: "jev-mock-1", answers: { change_class: { type: "choice", choice: "A", probabilities: { A: 0.9, B: 0.05, C: 0.05 }, confidence: 0.85 } }, usage: { input_tokens: 10, output_tokens: 5 } };
  }
  if (mock === "5xx") fail("JEV_SERVER_ERROR");
  if (mock === "badjson") fail("JEV_SCHEMA_CHANGED");
  if (mock === "missingfield") return { answers: {}, usage: { input_tokens: 1, output_tokens: 1 } };
  if (mock === "badenum") return { answers: { change_class: { type: "choice", choice: "ZZZ", probabilities: { ZZZ: 1 }, confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } };
  if (mock === "ok-a") return { model: "jev-mock-1", answers: { change_class: { type: "choice", choice: "A", probabilities: { A: 0.9, B: 0.05, C: 0.05 }, confidence: 0.85 } }, usage: { input_tokens: 10, output_tokens: 5 } };
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state, model: MODEL, questions }),
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(to);
    fail("JEV_NETWORK");
  }
  clearTimeout(to);
  if (res.status === 401) fail("JEV_AUTH");
  if (res.status === 402) fail("JEV_QUOTA_OUT");
  if (res.status === 422) fail("JEV_BAD_REQUEST");
  if (res.status === 429 || res.status === 529) {
    if (attempt < MAX_ATT) {
      await new Promise((r) => setTimeout(r, attempt * 3000));
      return callApi(key, state, questions, attempt + 1);
    }
    fail(res.status === 429 ? "JEV_RATE_LIMITED" : "JEV_OVERLOADED");
  }
  if (res.status >= 500) fail("JEV_SERVER_ERROR");
  if (!res.ok) fail("JEV_UNAVAILABLE");
  let body;
  try {
    body = await res.json();
  } catch {
    fail("JEV_SCHEMA_CHANGED");
  }
  if (!body || typeof body !== "object" || !body.answers) fail("JEV_SCHEMA_CHANGED");
  return body;
}

let CLI_DATA_CLASS = "";
let CLI_RUNNER = "";
async function main() {
  const raw = process.argv.slice(2);
  const args = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "--data-class" && i + 1 < raw.length) { CLI_DATA_CLASS = raw[++i]; continue; }
    if (raw[i].startsWith("--data-class=")) { CLI_DATA_CLASS = raw[i].split("=").slice(1).join("="); continue; }
    if (raw[i] === "--runner" && i + 1 < raw.length) { CLI_RUNNER = raw[++i]; continue; }
    if (raw[i].startsWith("--runner=")) { CLI_RUNNER = raw[i].split("=").slice(1).join("="); continue; }
    args.push(raw[i]);
  }
  const [mode, file] = args;
  if (!mode || !file) fail("BAD_ARGS");
  if (!MODES[mode]) fail("BAD_MODE");
  if (!existsSync(file)) fail("STATE_FILE_MISSING");
  let state;
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    fail("BAD_JSON");
  }
  const st = stateText(mode, state);
  if (st.deterministic) {
    const det = { schema_version: SCHEMA, mode, ok: true, advisory_only: true, model: "deterministic-rule", contract_version: "v1.5", policy_version: POLICY_VERSION, requested_model: null, resolved_model: null, usage: null, data_class: String(CLI_DATA_CLASS || process.env.ORCA_DATA_CLASS || "NEEDS_USER_POLICY").toUpperCase(), note: st.deterministic.reason };
    if (st.deterministic.decision) det.decision = st.deterministic.decision;
    else det.decision = "SKIP_DETERMINISTIC";
    det.selected_probability = null; det.confidence = null; det.probabilities = null;
    logDecision({ ok: true, mode, decision: det.decision, model: "deterministic-rule",
      deterministic_shortcut: true, advisory_only: true, contract_version: "v1.5",
      policy_version: POLICY_VERSION, data_class: det.data_class, input_digest: digest(JSON.stringify(state)), note: st.deterministic.reason });
    console.log(JSON.stringify(det));
    return;
  }
  const key = loadKey();
  if (mode === "skill" && !(CLI_RUNNER || process.env.ORCA_RUNNER)) fail("RUNNER_UNKNOWN");
  // Route order: Authorized Targets -> Hard Filter -> Eligible Pool -> Jev class -> local mapping.
  let prePool = null, effDataClass = "NEEDS_USER_POLICY";
  if (mode === "bclass") {
    const tg = (POLICY && POLICY.route_targets) || {};
    const up = (POLICY && POLICY.user_policy) || {};
    effDataClass = String(CLI_DATA_CLASS || process.env.ORCA_DATA_CLASS || "NEEDS_USER_POLICY").toUpperCase();
    prePool = filterTargets(Object.keys(tg), tg, up, (st.gated && st.gated.required_capabilities) || [], binOnPath, effDataClass);
  }
  const body = await callApi(key, st.text, MODES[mode].q);
  const a = body.answers;
  for (const k of MODES[mode].need) {
    if (!(k in a)) fail("JEV_SCHEMA_CHANGED");
  }
  if (!MODES[mode].check(a)) fail("JEV_SCHEMA_CHANGED");
  const decision = MODES[mode].pick(a);
  const st3 = MODES[mode].stats(a);
  const out = {
    schema_version: SCHEMA, mode, ok: true,
    decision, selected_probability: st3.selected, confidence: st3.confidence,
    probabilities: st3.probs, advisory_only: true, model: body.model || MODEL,
    requested_model: MODEL, resolved_model: body.model || null,
    contract_version: "v1.5", policy_version: POLICY_VERSION,
    data_class: String(CLI_DATA_CLASS || process.env.ORCA_DATA_CLASS || "NEEDS_USER_POLICY").toUpperCase(),
    usage: body.usage ?? null,
  };
  if (MODES[mode].extra) Object.assign(out, MODES[mode].extra(a, MODES[mode].q.risk?.criteria?.length ?? 0, { ...((st.gated) || {}), pool: prePool }));
  logDecision({ ok: true, mode, decision: out.decision, confidence: st3.confidence,
    selected_probability: st3.selected, model: out.model, requested_model: out.requested_model,
    resolved_model: out.resolved_model, contract_version: "v1.5", policy_version: POLICY_VERSION,
    data_class: out.data_class, advisory_only: true, input_digest: digest(st.text) });
  console.log(JSON.stringify(out));
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) main();

export { filterTargets, binOnPath, POLICY, POLICY_VERSION };
