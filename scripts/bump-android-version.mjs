#!/usr/bin/env node
/**
 * 出包前必跑：versionCode +1、versionName 末位 +1。
 * 用户要求「每次更新版本号都要变」，装机后用「设置→关于」核对。
 * 用法：node scripts/bump-android-version.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../android/app/build.gradle', import.meta.url);

let text = readFileSync(FILE, 'utf8');
const codeMatch = text.match(/versionCode\s+(\d+)/);
const nameMatch = text.match(/versionName\s+"(\d+)\.(\d+)\.(\d+)"/);
if (!codeMatch || !nameMatch) {
  console.error('未找到 versionCode / versionName，检查 android/app/build.gradle');
  process.exit(1);
}

const oldCode = Number(codeMatch[1]);
const [major, minor, patch] = nameMatch.slice(1).map(Number);
const nextCode = oldCode + 1;
const nextName = `${major}.${minor}.${patch + 1}`;

text = text.replace(codeMatch[0], `versionCode ${nextCode}`);
text = text.replace(nameMatch[0], `versionName "${nextName}"`);
writeFileSync(FILE, text);

const rescanned = readFileSync(FILE, 'utf8');
if (!rescanned.includes(`versionCode ${nextCode}`) || !rescanned.includes(`versionName "${nextName}"`)) {
  console.error('写入后回读不一致，请手动检查 build.gradle');
  process.exit(1);
}
console.log(`版本号：${major}.${minor}.${patch} (${oldCode}) → ${nextName} (${nextCode})`);
