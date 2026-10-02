#!/usr/bin/env node
// test-mock.mjs — failure/fallback matrix via ORCA_DECIDE_MOCK (no network, no quota).
import { execFileSync } from "node:child_process";

function runMock(mock, mode, fx, extraEnv) {
  let code = 0, body = {};
  try {
    const raw = execFileSync("node", ["scripts/decision/orca-decide.mjs", mode, `scripts/decision/fixtures/${fx}.json`],
      { encoding: "utf8", timeout: 30000, env: { ...process.env, ORCA_DATA_CLASS: "PUBLIC", ORCA_DECIDE_MOCK: mock, ...(extraEnv || {}) } });
    body = JSON.parse(raw);
  } catch (e) {
    code = e.status ?? 99;
    try { body = JSON.parse(e.stdout || "{}"); } catch { body = {}; }
  }
  return { code, body };
}
const T = [
  ["timeout", "change", "T01", 1, "JEV_NETWORK"],
  ["401", "change", "T01", 1, "JEV_AUTH"],
  ["402", "change", "T01", 1, "JEV_QUOTA_OUT"],
  ["422", "change", "T01", 1, "JEV_BAD_REQUEST"],
  ["429", "change", "T01", 1, "JEV_RATE_LIMITED"],
  ["5xx", "change", "T01", 1, "JEV_SERVER_ERROR"],
  ["badjson", "change", "T01", 1, "JEV_SCHEMA_CHANGED"],
  ["missingfield", "change", "T01", 1, "JEV_SCHEMA_CHANGED"],
  ["badenum", "change", "T01", 1, "JEV_SCHEMA_CHANGED"],
  ["ok-a", "change", "T01", 0, null],
];
let fail = 0;
for (const [mock, mode, fx, wantExit, wantErr] of T) {
  const { code, body } = runMock(mock, mode, fx);
  let ok = code === wantExit;
  if (wantErr) ok = ok && body.error === wantErr && body.fallback === "ORCA_V2_1_EXISTING_LOGIC";
  else ok = ok && body.ok === true && body.decision === "A" && body.contract_version === "v1.5";
  if (!ok) { fail++; console.log("FAIL:", mock, "exit=", code, JSON.stringify(body).slice(0, 160)); }
}
// retry-count proof: online (default) fails fast on flaky; offline retries twice then succeeds
{
  const a = runMock("flaky2", "change", "T01");
  if (!(a.code !== 0 && a.body.error === "JEV_RATE_LIMITED")) { fail++; console.log("FAIL: flaky2-online should fail fast"); }
  const b = runMock("flaky2", "change", "T01", { ORCA_DECIDE_OFFLINE: "1" });
  if (!(b.code === 0 && b.body.ok === true && b.body.decision === "A")) { fail++; console.log("FAIL: flaky2-offline should succeed after retries"); }
}
console.log(fail ? `MOCK_TESTS FAIL=${fail}` : `MOCK_TESTS all ${T.length + 2} pass`);
process.exit(fail ? 1 : 0);
