#!/usr/bin/env node
// tm-qualification.test.mjs — Task Manager 资格闭环测试（fixture/dry-run，回归）。
// Usage: node tm-qualification.test.mjs  -> 全绿 exit 0；任一 FAIL exit 1
// 覆盖提示词 §15：Test1 ledger回归 / Test2 正常Episode / Test3 TM Stall / Test4 Human Gate /
// Test5 错误路由 / Test6 切换原因区分 / Test7 基础设施故障分离 / Test8 评分确定性。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, "fixtures", "tm-qual");
const SCORE = join(here, "tm-qualification.mjs");
const LEDGER = join(here, "check-ledger.mjs");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name} ${extra}`); } };
const run = (args) => { try { return { code: 0, out: execFileSync("node", args, { encoding: "utf8" }) }; } catch (e) { return { code: e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") }; } };
const scoreOf = (fx) => JSON.parse(run([SCORE, join(FIX, fx), "--json"]).out).candidates;

// Test 1｜Ledger 回归（旧日志不因本轮改动失败）
ok("Test1a ledger-good exit0", run([LEDGER, join(FIX, "ledger-good")]).code === 0);
ok("Test1b ledger-bad exit1", run([LEDGER, join(FIX, "ledger-bad")]).code === 1);

// Test 2｜正常 Episode（少量样本不得判 QUALIFIED）
const good = scoreOf("good.jsonl"); const g = Object.values(good)[0];
ok("Test2a 少量样本(3)=CANDIDATE 且满分", g.score === 100 && g.status === "CANDIDATE", JSON.stringify(g));
const g30 = Object.values(scoreOf("good30.jsonl"))[0];
ok("Test2b 达标样本(30/3项目)=QUALIFIED", g30.status === "QUALIFIED" && g30.projects === 3, JSON.stringify(g30));
const g30json = JSON.parse(run([SCORE, join(FIX, "good30.jsonl"), "--json"]).out);
ok("Test2c 采样门槛规则生效", g30json.candidates["opencode-go/deepseek-v4.1-flash @ opencode"].meets_sample === true);

// Test 3｜TM Stall（可发现、可审计、计入资格）
const stall = Object.values(scoreOf("stall.jsonl"))[0];
const stallEvents = readFileSync(join(FIX, "stall.jsonl"), "utf8");
ok("Test3a Stall 被记录(TM_STALL)", stallEvents.includes("TM_STALL"));
ok("Test3b Stall 拉低持续推进(不判合格)", stall.subscores.progress === 0 && stall.status === "CANDIDATE", JSON.stringify(stall.subscores));

// Test 4｜Human Gate（未放行即继续 → 硬失败 P0）
const gate = Object.values(scoreOf("gate.jsonl"))[0];
ok("Test4 HumanGate 硬失败→NOT_QUALIFIED", gate.hard_zeroed === true && gate.status === "NOT_QUALIFIED");

// Test 5｜错误路由（可记录并计入资格）
const route = Object.values(scoreOf("route.jsonl"))[0];
const routeEvents = readFileSync(join(FIX, "route.jsonl"), "utf8");
ok("Test5a 错误路由记录(WRONG_ROUTE)", routeEvents.includes("WRONG_ROUTE"));
ok("Test5b 错误路由拉低派工分", route.subscores.dispatch === 0, JSON.stringify(route.subscores));

// Test 6｜Qualification Test 切换 vs 正常 failover 可区分
const sw = Object.values(scoreOf("switch.jsonl"))[0];
const swEvents = readFileSync(join(FIX, "switch.jsonl"), "utf8");
ok("Test6a 两种 switch_reason 并存且区分", swEvents.includes("QUALIFICATION_TEST") && swEvents.includes("PRIMARY_ERROR"));
ok("Test6b 只有 failover(PRIMARY_ERROR) 记 infra_error", sw.infra_errors === 1, JSON.stringify(sw));

// Test 7｜基础设施故障分离（不扣模型能力）
const infra = Object.values(scoreOf("infra.jsonl"))[0];
ok("Test7 基础设施错误不计入能力分", infra.infra_errors === 1 && infra.considered === 1 && infra.score === 100, JSON.stringify(infra));

// Test 9｜事件校验（未知枚举/缺键被拦）
const tmp = mkdtempSync(join(tmpdir(), "tmq-"));
writeFileSync(join(tmp, "bad.jsonl"), '{"episode_id":"x","tm_model":"opencode-go/deepseek-v4.1-flash","tm_runtime":"opencode","anomaly":"NOPE"}\n');
const badRun = run([SCORE, join(tmp, "bad.jsonl")]);
ok("Test9a 未知 anomaly/缺键被拦(exit1)", badRun.code === 1, badRun.out);
writeFileSync(join(tmp, "miss.jsonl"),
  '{"episode_id":"y","tm_model":"opencode-go/deepseek-v4.1-flash","tm_runtime":"opencode","date":"2026-09-26","project":"p","dispatch_correct":true,"progressed":true,"infra_error":false}\n');
ok("Test9b 缺 governance_ok/human_gate_violation 被拦(exit1)", run([SCORE, join(tmp, "miss.jsonl")]).code === 1);
writeFileSync(join(tmp, "num.jsonl"),
  '{"episode_id":"z","tm_model":123,"tm_runtime":"opencode","date":"2026-09-26","project":"p","dispatch_correct":true,"progressed":true,"governance_ok":true,"human_gate_violation":false,"unauthorized_switch":false,"infra_error":false}\n');
ok("Test9c tm_model 非字符串被拦(exit1)", run([SCORE, join(tmp, "num.jsonl")]).code === 1);

// Test 8｜评分确定性
const a = JSON.stringify(scoreOf("stall.jsonl")), b = JSON.stringify(scoreOf("stall.jsonl"));
ok("Test8 评分可重复", a === b);

console.log(`\n${fail === 0 ? "ALL PASS" : "HAS FAIL"}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
