#!/usr/bin/env node
// test-slow.mjs — delay endpoint in an INDEPENDENT child process (dynamic port, stderr kept, finally cleanup).
import { spawn, spawnSync } from "node:child_process";

const srv = spawn("node", ["-e", `
const http = require("http");
http.createServer((req, res) => {
  setTimeout(() => { res.writeHead(200, {"Content-Type":"application/json"}); res.end("{}"); }, 3000);
}).listen(0, "127.0.0.1", function() { console.log("READY " + this.address().port); });
`], { stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
srv.stderr.on("data", (d) => { stderr += String(d).slice(0, 500); });
const port = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("server not ready")), 10000);
  srv.stdout.on("data", (d) => {
    const m = String(d).match(/READY (\d+)/);
    if (m) { clearTimeout(t); resolve(m[1]); }
  });
  srv.on("error", (e) => { clearTimeout(t); reject(e); });
}).catch((e) => ({ error: String(e) }));
const base = { ORCA_DATA_CLASS: "PUBLIC", ORCA_DECIDE_ENDPOINT: typeof port === "string" ? `http://127.0.0.1:${port}/slow` : "http://127.0.0.1:1/slow" };
function run(env) {
  const r = spawnSync("node", ["scripts/decision/orca-decide.mjs", "change", "scripts/decision/fixtures/T01.json"],
    { encoding: "utf8", timeout: 30000, env: { ...process.env, ...env } });
  let body = {};
  try { body = JSON.parse(r.stdout || "{}"); } catch { /* ignore */ }
  return { code: r.status ?? 99, body, stderr: (r.stderr || "").slice(0, 200) };
}
let fail = 0;
const notes = [];
try {
  if (port.error) throw new Error(port.error);
  {
    const { code, body } = run({ ...base, JEV_SYNC_TIMEOUT_MS: "1000", JEV_SYNC_MAX_RETRIES: "0" });
    notes.push(`negative: exit=${code} err=${body.error}`);
    if (!(code !== 0 && body.error === "JEV_NETWORK")) { fail++; console.log("FAIL: slow-negative", code, JSON.stringify(body).slice(0, 100)); }
  }
  {
    const { code, body } = run({ ...base, JEV_SYNC_TIMEOUT_MS: "5000", JEV_SYNC_MAX_RETRIES: "0" });
    notes.push(`positive: exit=${code} err=${body.error || "none"}`);
    if (!(code !== 0 && (body.error === "JEV_BAD_REQUEST" || body.error === "JEV_SCHEMA_CHANGED"))) { fail++; console.log("FAIL: slow-positive", code, JSON.stringify(body).slice(0, 100)); }
  }
} catch (e) {
  fail++;
  notes.push("harness-error: " + String(e).slice(0, 120));
} finally {
  srv.kill();
}
notes.push("server_stderr: " + (stderr || "(empty)"));
console.log(fail ? `SLOW_TEST FAIL=${fail}` : "SLOW_TEST pass (abort@1s + roundtrip@5s, independent server)");
console.log(notes.join(" | "));
process.exit(fail ? 1 : 0);
