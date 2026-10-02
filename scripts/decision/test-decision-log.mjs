#!/usr/bin/env node
// test-decision-log.mjs — Jev 决策流水（best-effort、不泄密、不改权限）回归。
// Usage: node test-decision-log.mjs -> 全绿 exit 0
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DECIDE = join(HERE, "orca-decide.mjs");
let fail = 0;

// 1) 确定性短路（不调 Jev）→ 落一行
const d = mkdtempSync(join(tmpdir(), "jevt-"));
mkdirSync(join(d, "docs", "model"), { recursive: true });
writeFileSync(join(d, "state.json"), '{"is_human_gate":true,"marker":"SECRETTEST-abcdef123456"}');
execFileSync("node", [DECIDE, "user", "state.json"], { cwd: d });
const logp = join(d, "docs", "model", "JEV-DECISION-LOG.jsonl");
const raw = existsSync(logp) ? readFileSync(logp, "utf8") : "";
const lines = raw.trim() ? raw.trim().split("\n") : [];
let rec = null; try { rec = JSON.parse(lines[0]); } catch {}
if (!(lines.length === 1 && rec && rec.decision === "YES_HUMAN_GATE" && rec.deterministic_shortcut === true)) {
  fail++; console.log("FAIL: 确定性短路未落盘或字段错", raw.slice(0, 120));
}

// 2) 不泄密：日志不得含 state 原文/marker（只记 digest）
if (raw.includes("SECRETTEST-abcdef123456")) { fail++; console.log("FAIL: 泄露 state 原文"); }
if (rec && typeof rec.input_digest === "string" && /^[0-9a-f]{16}$/.test(rec.input_digest)) { /* ok digest */ }
else { fail++; console.log("FAIL: 缺 input_digest"); }

// 3) best-effort：无 docs/model 目录时不创建文件
const d2 = mkdtempSync(join(tmpdir(), "jevt2-"));
writeFileSync(join(d2, "state.json"), '{"is_human_gate":true}');
execFileSync("node", [DECIDE, "user", "state.json"], { cwd: d2 });
if (existsSync(join(d2, "docs"))) { fail++; console.log("FAIL: 无 docs/model 却创建了日志"); }

// 4) fail() 也留痕
const d3 = mkdtempSync(join(tmpdir(), "jevt3-"));
mkdirSync(join(d3, "docs", "model"), { recursive: true });
try { execFileSync("node", [DECIDE], { cwd: d3 }); } catch {}
const raw3 = existsSync(join(d3, "docs", "model", "JEV-DECISION-LOG.jsonl")) ? readFileSync(join(d3, "docs", "model", "JEV-DECISION-LOG.jsonl"), "utf8") : "";
if (!raw3.includes('"ok":false') || !raw3.includes("BAD_ARGS")) { fail++; console.log("FAIL: fail() 未留痕"); }

// 5) 选项在 mode 之前时，fail() 仍能识别 mode
const d4 = mkdtempSync(join(tmpdir(), "jevt4-"));
mkdirSync(join(d4, "docs", "model"), { recursive: true });
try { execFileSync("node", [DECIDE, "--data-class", "PRIVATE", "user"], { cwd: d4 }); } catch {}
const raw4 = existsSync(join(d4, "docs", "model", "JEV-DECISION-LOG.jsonl")) ? readFileSync(join(d4, "docs", "model", "JEV-DECISION-LOG.jsonl"), "utf8") : "";
if (!raw4.includes('"mode":"user"')) { fail++; console.log("FAIL: 选项在前的 mode 未识别", raw4.slice(0, 120)); }

console.log(fail ? `DECISION_LOG_TESTS FAIL=${fail}` : "DECISION_LOG_TESTS all pass");
process.exit(fail ? 1 : 0);
