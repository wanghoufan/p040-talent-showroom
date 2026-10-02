#!/usr/bin/env node
// partition-validate.mjs — static legality check for candidate partition plans (no Jev).
// Usage: node partition-validate.mjs <plan.json>  -> exit 0 valid / exit 1 with reasons JSON
import { readFileSync, existsSync } from "node:fs";

const RISKY_SHARED = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "migrations/", "schema.", "dtype"];
function overlap(a, b) {
  return a.some((x) => b.some((y) => x === y || x.startsWith(y) || y.startsWith(x)));
}
function main() {
  const f = process.argv[2];
  if (!f || !existsSync(f)) { console.log(JSON.stringify({ ok: false, error: "PLAN_FILE_MISSING" })); process.exit(1); }
  let p;
  try { p = JSON.parse(readFileSync(f, "utf8")); } catch { console.log(JSON.stringify({ ok: false, error: "BAD_JSON" })); process.exit(1); }
  const reasons = [];
  const kids = p.children || [];
  const seen = new Set();
  const push = (r) => { if (!seen.has(r)) { seen.add(r); reasons.push(r); } };
  if (kids.length < 1 || kids.length > 3) push("child-count");
  const allAllowed = kids.flatMap((k) => (k.allowed_paths || []).map((x) => k.child_id + ":" + x));
  for (const k of kids) {
    for (const fp of (k.forbidden_paths || [])) {
      if ((k.allowed_paths || []).some((x) => x === fp || x.startsWith(fp))) push(`self-forbidden:${k.child_id}:${fp}`);
    }
  }
  for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
    const A = kids[i], B = kids[j];
    if (overlap(A.allowed_paths || [], B.allowed_paths || [])) push(`overlap:${A.child_id}/${B.child_id}`);
    if ((A.dependencies || []).includes(B.child_id) && (B.dependencies || []).includes(A.child_id)) push("dep-cycle");
    const shared = (A.allowed_paths || []).filter((x) => (B.allowed_paths || []).includes(x) && RISKY_SHARED.some((r) => x.includes(r)));
    if (shared.length) push("shared-risky:" + shared.join(","));
  }
  void allAllowed;
  const ok = reasons.length === 0;
  console.log(JSON.stringify({ ok, valid: ok, reasons, children: kids.length }));
  process.exit(ok ? 0 : 1);
}
main();
