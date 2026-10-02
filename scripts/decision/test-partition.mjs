#!/usr/bin/env node
// test-partition.mjs — partition-validate branch coverage (no network).
import { execFileSync, execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const T = [];
const plan = (children) => ({ plan_id: "T", children });
let n = 0;
function expect(obj, wantOk, wantReasons, label) {
  const f = `/tmp/pv-t${n++}.json`;
  writeFileSync(f, JSON.stringify(obj));
  let code = 0, body = {};
  try {
    body = JSON.parse(execFileSync("node", ["scripts/decision/partition-validate.mjs", f], { encoding: "utf8" }));
  } catch (e) { code = e.status ?? 99; try { body = JSON.parse(e.stdout || "{}"); } catch { body = {}; } }
  const got = body.reasons || [];
  const ok = (code === 0) === wantOk && JSON.stringify(got) === JSON.stringify(wantReasons);
  T.push([label, ok, code, JSON.stringify(got)]);
}
const K = (id, allowed, forbidden = [], dependencies = []) => ({ child_id: id, allowed_paths: allowed, forbidden_paths: forbidden, dependencies });

expect(plan([]), false, ["child-count"], "zero-children");
expect(plan([K("A", ["a/"]), K("B", ["b/"]), K("C", ["c/"]), K("D", ["d/"])]), false, ["child-count"], "four-children");
expect(plan([K("A", ["src/api/profile/"], ["src/ui/"]), K("B", ["src/ui/profile/"], ["src/api/"])]), true, [], "good-doc-example");
expect(plan([K("A", ["src/api/"]), K("B", ["src/api/profile/"])]), false, ["overlap:A/B"], "overlap-prefix");
expect(plan([K("A", ["src/api/profile/"]), K("B", ["src/ui/profile/"])]), true, [], "siblings-no-overlap");
expect(plan([K("A", ["src/api/", "package-lock.json"]), K("B", ["src/api/profile/", "package-lock.json"])]), false, ["overlap:A/B", "shared-risky:package-lock.json"], "shared-risky");
expect(plan([K("A", ["x/"], [], ["B"]), K("B", ["y/"], [], ["A"])]), false, ["dep-cycle"], "dep-cycle");
expect(plan([K("A", ["src/api/profile/"], ["src/api/"])]), false, ["self-forbidden:A:src/api/"], "self-forbidden");
expect(plan([K("A", ["m/"]), K("B", ["n/"]), K("C", ["m/", "n/"])]), false, ["overlap:A/C", "overlap:B/C"], "three-pairwise");
// missing-fields tolerance
expect(plan([{ child_id: "A" }, { child_id: "B" }]), true, [], "missing-fields-tolerated");
// Windows backslash separator behaviour (overlap is literal string-prefix, no normalization)
expect(plan([K("A", ["src\\api\\"]), K("B", ["src/api/"])]), true, [], "backslash-separator-mismatch-no-overlap");
expect(plan([K("A", ["src\\api\\"]), K("B", ["src\\api\\profile\\"])]), false, ["overlap:A/B"], "backslash-prefix-overlap");

let fail = 0;
for (const [label, ok, code, got] of T) if (!ok) { fail++; console.log("FAIL:", label, "exit=", code, got); }
// error paths
try { execSync("node scripts/decision/partition-validate.mjs", { stdio: "pipe" }); fail++; console.log("FAIL: no-arg should exit 1"); }
catch (e) { if (e.status !== 1) { fail++; console.log("FAIL: no-arg exit"); } }
try { execSync("node scripts/decision/partition-validate.mjs /tmp/nope-pv.json", { stdio: "pipe" }); fail++; console.log("FAIL: missing should exit 1"); }
catch (e) { if (e.status !== 1) { fail++; console.log("FAIL: missing exit"); } }
console.log(fail ? `PARTITION_TESTS FAIL=${fail}` : `PARTITION_TESTS all ${T.length + 2} pass`);
process.exit(fail ? 1 : 0);
