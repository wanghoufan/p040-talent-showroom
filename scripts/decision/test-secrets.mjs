#!/usr/bin/env node
// test-secrets.mjs — table-driven secret-pattern tests (11 classes + false positives). No network.
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./orca-decide.mjs", import.meta.url), "utf8");
const m = src.match(/const SECRET_RE = (\/.*?\/i);/);
if (!m) { console.log("FAIL: SECRET_RE not found"); process.exit(1); }
const RE = eval(m[1]);
const YES = [
  "api_key=abcdefgh12345678", "api-key: abcdefgh12345678", "Bearer abcdefgh12345678",
  "password: s3cr3tpass99", "secret=tok987654321",
  "sk-fake1234567890abcdef", "sk-proj-abcdefghijklmnopqrstuvwxyz123456", "sk-ant-api03-abcdefgh12345678", "AIzaSyFake1234567890abcdef", "npm_fake1234567890abcdef", "pypi-fake1234567890abcdef", "apikey_test1234567890",
  "ghp_fake1234567890abcdef", "gho_fake1234567890abcdef", "github_pat_11ABCDEFG12345678",
  "xoxb-1234-5678-abcd", "xoxp-aaaa-bbbb", "AKIAIOSFODNN7EXAMPLE",
  "-----BEGIN RSA PRIVATE KEY-----", "vck-test-key-12345", "ark-d45cd3ba-2c6a-493e",
];
const NO = [
  "fix the login button", "rotate the tires", "password policy doc",
  "ask Alice about keys", "monkey business", "ark-code-latest model",
];
let fail = 0;
for (const s of YES) if (!RE.test(s)) { fail++; console.log("MISS:", s); }
for (const s of NO) if (RE.test(s)) { fail++; console.log("FALSEPOS:", s); }
console.log(fail ? `SECRET_TESTS FAIL=${fail}` : `SECRET_TESTS all ${YES.length + NO.length} pass`);
process.exit(fail ? 1 : 0);
