#!/usr/bin/env node
// test-filter.mjs — deterministic Hard Filter unit tests (no network, no quota).
import { filterTargets } from "./orca-decide.mjs";

const binStub = (b) => b !== "nope-missing-bin";
const AUTH = { "p": ["PUBLIC"] };
const base = { availability: "AVAILABLE", quota_status: "OK", data_policy: "ALLOWED", capabilities: ["code"], runner_bin: "sh", provider: "p" };
const up0 = { allow_unknown_quota: false, volc_personal_private_code: false, authorized_targets: ["t0"] };
const T = (id, over = {}, up = up0, need = [], cls = "PUBLIC") => {
  const tg = { [id]: { ...base, ...over } };
  return filterTargets([id], tg, up, need, binStub, cls);
};
// provider×class allow-list comes from real POLICY (mutated to test double for determinism)
import { POLICY } from "./orca-decide.mjs";
POLICY.provider_data_auth = AUTH;

const cases = [
  ["avail", T("t0", { availability: "UNAVAILABLE" }).excluded[0]?.excluded_reasons.join().startsWith("availability")],
  ["quota", T("t0", { quota_status: "UNKNOWN" }).excluded[0]?.excluded_reasons.join().startsWith("quota:")],
  ["runner", T("t0", { runner_bin: "nope-missing-bin" }).excluded[0]?.excluded_reasons.join() === "runner:nope-missing-bin"],
  ["caps", T("t0", {}, up0, ["vision"]).excluded[0]?.excluded_reasons.join() === "caps:vision"],
  ["data-needs", T("t0", { data_policy: "NEEDS_USER_POLICY" }, up0, [], "PRIVATE_CODE").excluded[0]?.excluded_reasons.join().startsWith("data_policy:")],
  ["authz", T("t0", {}, { ...up0, authorized_targets: [] }).excluded[0]?.excluded_reasons.join() === "unauthorized-target"],
  ["positive", T("t0").eligible.length === 1],
  ["bogus-avail", T("t0", { availability: "AVAILABLE_BOGUS" }).excluded[0]?.excluded_reasons.join().startsWith("availability:")],
  ["class-public-ok", T("t0", {}, up0, [], "PUBLIC").eligible.length === 1],
  ["class-private-deny", T("t0", {}, up0, [], "PRIVATE_CODE").excluded[0]?.excluded_reasons.join().includes("task:PRIVATE_CODE")],
  ["class-sensitive-deny", T("t0", {}, up0, [], "PERSONAL_SENSITIVE").excluded[0]?.excluded_reasons.length > 0],
  ["class-secret-deny", T("t0", {}, up0, [], "SECRET").excluded[0]?.excluded_reasons.length > 0],
  ["illegal-policy", T("t0", { data_policy: "BLOCKED" }).excluded[0]?.excluded_reasons.join().includes("ILLEGAL-BLOCKED")],
  ["illegal-garbage", T("t0", { data_policy: "whatever" }).excluded[0]?.excluded_reasons.join().startsWith("data_policy:ILLEGAL")],
];
let fail = 0;
for (const [n, ok] of cases) { if (!ok) { fail++; console.log("FAIL:", n); } }
console.log(fail ? `FILTER_TESTS FAIL=${fail}` : `FILTER_TESTS all ${cases.length} pass`);
process.exit(fail ? 1 : 0);
