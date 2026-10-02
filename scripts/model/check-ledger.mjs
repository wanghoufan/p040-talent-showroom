#!/usr/bin/env node
// check-ledger.mjs — 账本合法性校验（TASK-MODEL-LOG / DISPATCH-LOG）。
// Usage: node check-ledger.mjs [dir] -> exit 0 合法 / exit 1 列出问题
// 分级：结构/枚举错误 = FAIL（exit 1）；写法不规范 = WARN（不影响 exit，供 supervisor 抽查）。
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] || "docs/model";
const fails = [];
const warns = [];

// model 精确写法白名单
const MODEL_PROVIDERS = [
  "codebuddy/", "codex/", "opencode/", "opencode-go/", "opencode-free/",
  "volcengine-plan/", "radeon-mimo/",
];
// 已知合法模型全串（来自 USER_MODEL_OVERRIDE；不在表内但前缀合法的记 WARN，提醒更新）
const KNOWN_MODELS = [
  "codebuddy/deepseek-v4.1-flash", "codebuddy/glm-5.3-flash",
  "codex/gpt-6-sol", "codex/gpt-6-luna", "codex/gpt-5.6-luna",
  "codex/gpt-5.6-terra", "codex/gpt-5.6-sol",
  "opencode/muse-spark-1.3-contributor-free", "opencode/muse-spark-1.3-contributor",
  "opencode/mimo-v2.5-free",
  "opencode-go/muse-spark-1.3-contributor", "opencode-go/deepseek-v4.1-flash",
  "opencode-go/glm-5.3-flash", "opencode-go/space-bunny-free",
  "opencode-free/mimo-v2.5-free", "opencode-free/muse-spark-1.3-contributor-free",
  "volcengine-plan/ark-code-latest",
  "radeon-mimo/MiMo-V2.6-Flash",
];
// 特殊合法写法（非 provider/model，但属规范内的“非模型”记录）
const MODEL_SPECIAL = ["本窗口", "本窗口直驱", "本窗口Agent子代理", "—"];
const MODEL_UNRECORDED = /未派|未记录|未报|unknown/i;

function checkModel(file, ln, d) {
  const m = d.model;
  if (m === null || m === "" || m === undefined) {
    warns.push(`${file}#${ln}: WARN model 为空（须 provider/model 精确写法）`);
    return;
  }
  if (typeof m !== "string") { fails.push(`${file}#${ln}: model 非字符串`); return; }
  if (MODEL_SPECIAL.includes(m)) return;
  if (MODEL_UNRECORDED.test(m)) { warns.push(`${file}#${ln}: WARN unrecorded model="${m}"`); return; }
  if (!MODEL_PROVIDERS.some((p) => m.startsWith(p))) {
    warns.push(`${file}#${ln}: WARN bad model="${m}" (须 provider/model 精确写法，见白名单)`);
    return;
  }
  // 前缀合法：再核是否在已知模型全串内
  if (!KNOWN_MODELS.includes(m)) {
    warns.push(`${file}#${ln}: WARN unknown model="${m}" (前缀合法但不在已知表，请核 USER_MODEL_OVERRIDE)`);
  }
}

const CHAIN_STATUS = ["DELIVERED", "ACCEPTED", "OPEN"];
const ROLES = ["task-manager", "supervisor", "planner", "builder", "code-reviewer", "qa",
  "product-reviewer", "experience-recorder", "neat-freak", "senior-expert", "db-admin",
  "迁移整理工", "orchestrator"];

function check(file, need, enums, evidence) {
  const p = join(dir, file);
  if (!existsSync(p)) { fails.push(`${file}: MISSING`); return; }
  const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
  let n = 0;
  for (const [i, l] of lines.entries()) {
    let d;
    try { d = JSON.parse(l); } catch { fails.push(`${file}#${i + 1}: BAD_JSON`); continue; }
    if (d === null || typeof d !== "object" || Array.isArray(d)) { fails.push(`${file}#${i + 1}: NOT_OBJECT`); continue; }
    if (d._example === true) continue;
    n++;
    const ln = i + 1;
    for (const k of need) if (!(k in d)) fails.push(`${file}#${ln}: missing ${k}`);
    for (const [k, vs] of Object.entries(enums)) {
      if (k in d && d[k] !== null && !vs.includes(d[k])) fails.push(`${file}#${ln}: bad ${k}=${d[k]}`);
    }
    checkModel(file, ln, d);
    if ("executed_by" in d && d.executed_by !== null && !ROLES.includes(d.executed_by)) {
      fails.push(`${file}#${ln}: bad executed_by=${d.executed_by}`);
    }
    if ("chain_status" in d && d.chain_status !== null && !CHAIN_STATUS.includes(d.chain_status)) {
      fails.push(`${file}#${ln}: bad chain_status=${d.chain_status}`);
    }
    // 证据质量（仅 TASK 账；启发式、advisory）：result=PASS 但备注含未闭环字样且未标 OPEN → WARN
    if (evidence && d.result === "PASS" && typeof d.note === "string"
        && /待评审|待复验|待验证|未验证|产品阻塞|待用户验收|未闭环|未完成/.test(d.note)
        && d.chain_status !== "OPEN") {
      warns.push(`${file}#${ln}: WARN result=PASS 但备注含未闭环字样，建议 chain_status=OPEN`);
    }
  }
  const nex = lines.filter((l) => { try { return JSON.parse(l)._example === true; } catch { return false; } }).length;
  if (n === 0 && nex > 0) fails.push(`${file}: _example 行未删（首个真实任务前删除示例行）`);
  else if (n === 0) warns.push(`${file}: 空账本（首个真实任务/派工前正常）`);
  if (n > 0 && nex > 0) fails.push(`${file}: ${nex} _example rows mixed with ${n} real rows (示例行必须在首个真实任务前删除)`);
}
check("TASK-MODEL-LOG.jsonl",
  ["task", "project", "date", "role", "model", "result", "rework", "escalated", "escalation_reason", "tokens", "cost_cny"],
  { result: ["PASS", "FAIL"], escalated: ["YES", "NO"] }, true);
check("DISPATCH-LOG.jsonl",
  ["date", "task", "role", "model", "used", "runtime", "result"],
  { result: ["PASS", "FAIL"] });

for (const w of warns) console.log(w);
if (fails.length) { console.log(fails.join("\n")); process.exit(1); }
console.log(warns.length ? "LEDGER-OK (含 WARN)" : "LEDGER-OK");
