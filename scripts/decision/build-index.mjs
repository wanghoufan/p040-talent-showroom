#!/usr/bin/env node
// build-index.mjs — auditable RUNTIME_SKILL_INDEX generator.
// Scans known agent skill roots, normalizes to portable ~/ paths, flags broken/dups.
// Usage: node build-index.mjs [out.json]
import { readdirSync, existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOTS = {
  opencode: "~/.config/opencode/skills",
  codebuddy: "~/.codebuddy/skills",
  central: "~/.agents/skills",
  claude: "~/.claude/skills",
  codex: "~/.codex/skills",
  cursor: "~/.cursor/skills",
  trae: "~/.trae-cn/skills",
  devin: "~/.config/devin/skills",
  crush: "~/.config/crush/skills",
  goose: "~/.config/goose/skills",
};
const real = (p) => p.replace(/^~\//, homedir() + "/");
const idx = {};
const scanned = {};
for (const [agent, base] of Object.entries(ROOTS)) {
  const r = real(base);
  if (!existsSync(r) || !lstatSync(r).isDirectory()) { scanned[agent] = "missing"; continue; }
  const names = readdirSync(r).filter((n) => !n.startsWith("."));
  scanned[agent] = names.length;
  for (const n of names) {
    const p = join(r, n);
    let broken = false;
    try { if (lstatSync(p).isSymbolicLink() && !existsSync(p)) broken = true; } catch { broken = true; }
    const e = idx[n] || (idx[n] = { id: n, paths: {}, broken: [], agents: [] });
    e.paths[agent] = base + "/" + n;
    (broken ? e.broken : e.agents).push(agent);
  }
}
const man = {
  version: 6,
  generated_at: new Date().toISOString().slice(0, 19),
  generated_by: "scripts/decision/build-index.mjs",
  sources: ROOTS,
  scanned,
  skills: idx,
  broken_ids: Object.keys(idx).filter((k) => idx[k].broken.length && !idx[k].agents.length).sort(),
  dup_groups: Object.keys(idx).filter((k) => idx[k].agents.length > 1).sort(),
};
const out = process.argv[2] || "scripts/decision/evals/skill-manifest.json";
const { writeFileSync } = await import("node:fs");
writeFileSync(out, JSON.stringify(man, null, 1) + "\n");
console.log(`unique=${Object.keys(idx).length} broken_only=${man.broken_ids.length} dups=${man.dup_groups.length} -> ${out}`);
