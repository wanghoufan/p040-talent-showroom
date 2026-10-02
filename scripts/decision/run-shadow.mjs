#!/usr/bin/env node
// run-shadow.mjs — auto runner: executes all fixtures, writes full-trace JSONL.
// Strict: expected missing => FAIL. F-cases assert fail-closed error codes.
// Usage: node run-shadow.mjs [out.jsonl]
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PKG = require("./package.json");
const RUNNER = (PKG.version || "0.0.0") + "+mjs";
let codeHash = "";
try {
  codeHash = createHash("sha256").update(readFileSync(new URL("./orca-decide.mjs", import.meta.url))).digest("hex").slice(0, 12);
} catch { /* ignore */ }

const CASES = [
  ["change", "T01"], ["change", "T02"], ["change", "T03"],
  ["route", "T04"], ["route", "T05"], ["route", "T06"],
  ["user", "T07"], ["user", "T08"], ["p0", "T09"], ["p0", "T10"],
  ["profile", "S01"], ["profile", "S02"], ["bclass", "S03"], ["bclass", "S04"], ["bclass", "S07"], ["bclass", "S08"],
  ["skill", "S05"], ["skill", "S06"], ["change", "X01"], ["user", "X02"],
];
const FAILCASES = [
  ["user", "F01", "SECRET_REFUSED"],
  ["skill", "F04", "RUNNER_UNKNOWN"],
  ["user", "F03", "SECRET_REFUSED"],
  ["p0", "F02", null], // F02 is deterministic SKIP path (exit 0, no API)
];
const out = process.argv[2] || "temp/ROUTER-SHADOW-LOG.jsonl";
const lines = [];
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const hashOf = (p) => { try { return createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 12); } catch { return null; } };
const POLICY_HASH = hashOf("scripts/decision/policy.json");
const MANIFEST_HASH = hashOf("scripts/decision/evals/skill-manifest.json");
const RUNNER_HASH = hashOf("scripts/decision/run-shadow.mjs");
// policy static assertions (fail fast): exact 3-target set, mimo via claude, BULK_FAST=mimo
{
  const pol = JSON.parse(readFileSync("scripts/decision/policy.json", "utf8"));
  const tids = Object.keys(pol.route_targets || {}).sort();
  const want = ["codebuddy__glm-5.3-flash__high", "radeon-mimo__mimo-v2.6-flash__claude", "volc-coding__deepseek-flash__high"].sort();
  if (JSON.stringify(tids) !== JSON.stringify(want)) { console.log("POLICY_FAIL: route_targets != {glm,mimo,deepseek} got " + JSON.stringify(tids)); process.exit(1); }
  const bulk = pol.class_targets?.BULK_FAST || [];
  if (bulk.length !== 1 || bulk[0] !== "radeon-mimo__mimo-v2.6-flash__claude") { console.log("POLICY_FAIL: BULK_FAST != [mimo/claude]"); process.exit(1); }
  console.log("POLICY_OK: 3-targets mimo/claude BULK_FAST=mimo version=" + pol.policy_version);
}
// probe CLI-declared versions (no hardcode): mock ok-a returns canned success
let PROBE = { contract_version: null, policy_version: null, requested_model: null, advisory_only: null };
try {
  const raw = execFileSync("node", ["scripts/decision/orca-decide.mjs", "change", "scripts/decision/fixtures/T01.json"],
    { encoding: "utf8", timeout: 30000, env: { ...process.env, ORCA_DECIDE_MOCK: "ok-a", ORCA_DATA_CLASS: "PUBLIC" } });
  const b = JSON.parse(raw);
  PROBE = { contract_version: b.contract_version, policy_version: b.policy_version, requested_model: b.requested_model, advisory_only: b.advisory_only };
} catch { /* probe failure surfaces in case results */ }
function run(mode, fx, extraEnv) {
  const fhash = createHash("sha256").update(readFileSync(fx)).digest("hex").slice(0, 12);
  let code = 0, body = null;
  try {
    // trusted harness classifies fixtures as PUBLIC synthetic content
    const env = { ORCA_DATA_CLASS: "PUBLIC", ORCA_DECIDE_OFFLINE: "1", ...process.env, ...(extraEnv || {}) };
    const raw = execFileSync("node", ["scripts/decision/orca-decide.mjs", mode, fx], { encoding: "utf8", timeout: 90000, env });
    body = JSON.parse(raw);
  } catch (e) {
    code = e.status ?? 99;
    try { body = JSON.parse(e.stdout || "{}"); } catch { body = { parse: "failed" }; }
  }
  return { fhash, code, body };
}
for (const [mode, name] of CASES) {
  let fx = `scripts/decision/fixtures/${name}.json`;
  let e2eUpstream = null, e2eHashes = null;
  if (name === "S08") {
    // true e2e: run PROFILE S01, feed its decision into BCLASS task_profile
    const up = run("profile", "scripts/decision/fixtures/S01.json");
    e2eUpstream = up.body.decision || null;
    const base = JSON.parse(readFileSync("scripts/decision/fixtures/S08.json", "utf8"));
    base.task_profile = e2eUpstream;
    fx = "/tmp/S08-e2e.json";
    writeFileSync(fx, JSON.stringify(base));
    e2eHashes = { s01_fixture: hashOf("scripts/decision/fixtures/S01.json"), s01_output: sha(JSON.stringify(up.body)), s08_input: sha(readFileSync(fx, "utf8")) };
  }
  const fxj = JSON.parse(readFileSync(fx, "utf8"));
  let r = run(mode, fx, mode==="skill" ? { ORCA_RUNNER: "opencode" } : null);
  let retried = false;
  if (r.code !== 0 && r.body.error === "JEV_NETWORK") {
    try { execSync("sleep 45", { stdio: "ignore" }); } catch { /* ignore */ }
    r = run(mode, fx, mode==="skill" ? { ORCA_RUNNER: "opencode" } : null);
    retried = true;
  }
  const { fhash, code, body } = r;
  try { execSync("sleep 8", { stdio: "ignore" }); } catch { /* ignore */ }
  const exp = ("expected" in fxj) ? fxj.expected : "MISSING";
  let pass = false;
  if (code === 0 && body.ok === true && exp !== "MISSING") {
    if (exp === "bool") pass = typeof body.decision === "boolean";
    else pass = Array.isArray(exp) ? exp.map(String).includes(String(body.decision)) : String(body.decision) === String(exp);
    // broad field assertions: versions read from CLI probe, not hardcoded
    // (deterministic-rule outputs carry null requested/resolved/usage by design)
    const isDet = body.model === "deterministic-rule";
    pass = pass && body.advisory_only === PROBE.advisory_only &&
      body.data_class === "PUBLIC" &&
      (["profile", "bclass", "skill"].includes(mode) ? body.shadow === true : true) &&
      body.contract_version === PROBE.contract_version &&
      typeof body.policy_version === "string" &&
      (isDet || (body.requested_model === PROBE.requested_model && typeof body.resolved_model === "string")) &&
      (isDet || (body.usage && typeof body.usage.input_tokens === "number")) &&
      (body.applied_threshold ?? null) === null &&
      (body.selected_probability === null || (typeof body.selected_probability === "number" && body.selected_probability >= 0 && body.selected_probability <= 1)) &&
      (body.confidence === null || (typeof body.confidence === "number" && body.confidence >= 0 && body.confidence <= 1)) &&
      (isDet || (body.probabilities === null || typeof body.probabilities === "object"));
    if (pass && fxj.expected_skills) {
      const got = body.skills || [];
      pass = JSON.stringify(got) === JSON.stringify(fxj.expected_skills);
    }
    if (pass && mode === "bclass") {
      const poolEx = body.pool_excluded || body.excluded_targets || [];
      const poolEl = body.eligible_pool || (body.eligible_targets || []).map((e) => e.route_target_id);
      const wantIds = fxj.expected_excluded_ids || null;
      const gotIds = poolEx.map((e) => e.route_target_id).sort();
      pass = Array.isArray(poolEx) && poolEx.length > 0 &&
        poolEx.every((e) => Array.isArray(e.excluded_reasons) && e.excluded_reasons.length > 0) &&
        poolEl.length === 0 && body.route_recommendation === null &&
        (!wantIds || wantIds.every((id) => gotIds.includes(id)));
    }
  }
  lines.push(JSON.stringify({
    date: new Date().toISOString().slice(0, 10), case: name, mode,
    exit: code, ok: body.ok ?? false, decision: body.decision ?? null,
    selected_probability: body.selected_probability ?? null,
    confidence: body.confidence ?? null,
    probabilities: body.probabilities ?? null,
    task_type: body.task_type ?? null, complexity: body.complexity ?? null,
    classifier: body.classifier ?? null, skills: body.skills ?? null,
    eligible_pool: body.eligible_pool ?? null, pool_excluded: body.pool_excluded ?? null,
    route_recommendation: body.route_recommendation ?? null,
    eligible_targets: body.eligible_targets ?? null, excluded_targets: body.excluded_targets ?? null,
    route_targets: body.route_targets ?? null, risk: body.risk ?? null,
    requested_model: body.requested_model ?? null, resolved_model: body.resolved_model ?? null,
    contract_version: body.contract_version ?? null, policy_version: body.policy_version ?? null,
    applied_threshold: body.applied_threshold ?? null, e2e_upstream: e2eUpstream, e2e_hashes: e2eHashes, shadow: body.shadow ?? false,
    usage: body.usage ?? null, expected: exp, expected_note: fxj.expected_note ?? null, pass,
    fixture_hash: fhash, runner: RUNNER, code_hash: codeHash, policy_hash: POLICY_HASH, runner_hash: RUNNER_HASH, retried_network: retried, manifest_hash: MANIFEST_HASH,
    advisory_only: body.advisory_only ?? null, error: body.error ?? null, fallback: body.fallback ?? null,
    dispatch: "shadow-no-dispatch",
  }));
}
for (const [mode, name, wantErr] of FAILCASES) {
  const fx = `scripts/decision/fixtures/${name}.json`;
  const fhash = createHash("sha256").update(readFileSync(fx)).digest("hex").slice(0, 12);
  const { code, body } = run(mode, fx);
  let pass;
  if (wantErr) pass = code !== 0 && body.error === wantErr &&
    body.advisory_only === null && body.contract_version === PROBE.contract_version &&
    body.policy_version === PROBE.policy_version && body.fallback === "ORCA_V2_1_EXISTING_LOGIC";
  else pass = code === 0 && body.decision === "SKIP_DETERMINISTIC" &&
    body.advisory_only === true && body.contract_version === PROBE.contract_version &&
    body.policy_version === PROBE.policy_version;
  lines.push(JSON.stringify({
    date: new Date().toISOString().slice(0, 10), case: name, mode, exit: code,
    ok: body.ok ?? false, error: body.error ?? null, decision: body.decision ?? null,
    expected: wantErr || "SKIP_DETERMINISTIC", advisory_only: body.advisory_only ?? null, contract_version: body.contract_version ?? null, policy_version: body.policy_version ?? null, pass,
    fixture_hash: fhash, runner: RUNNER, code_hash: codeHash, policy_hash: POLICY_HASH, runner_hash: RUNNER_HASH, retried_network: false, manifest_hash: MANIFEST_HASH,
    fallback: body.fallback ?? null, dispatch: "shadow-no-dispatch",
  }));
}
writeFileSync(out, lines.join("\n") + "\n");
const np = lines.filter((l) => JSON.parse(l).pass).length;
console.log(`cases=${lines.length} pass=${np} fail=${lines.length - np} -> ${out}`);
process.exit(np === lines.length ? 0 : 1);
