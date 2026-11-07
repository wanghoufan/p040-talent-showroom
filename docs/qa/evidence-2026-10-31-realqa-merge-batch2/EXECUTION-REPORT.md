# P040 real-qa 译文合并（第二批：17 首 / 895 行）｜执行报告

时间：2026-10-31 04:30–04:32 CST（UTC 20:30–20:32）
目标库：`var/vocal-v31-work/real-qa-20261030/db/qa.db`（real-qa 隔离库）
源译文库：`var/vocal-v31-work/translation-all-20261031/work.db`（只读打开，哈希 `4cf1caaf…` 前后未变）
授权：用户本轮明确授权更新该隔离库、备份并重启 28794；未再请求批准。

## 一、结论

| 项 | 结果 | 证据 |
|---|---|---|
| 28794 停止前仅本项目服务占用 | 是，pid 74097 / PPID 1 / cwd=项目根 | `pre-state.txt` |
| 优雅停止并释放端口 | `kill -TERM 74097`，约 1s 退出，`PORT_28794_FREE` | `stop.log` |
| 一致性备份 + integrity_check | `.backup` 落 `var/backups/real-qa-20261031-premerge-batch2/qa.db`，`integrity_check=ok`，内容与线上 `.dump` 同哈希 | `backup.log` / `backup-verify.log` |
| 重跑 merge plan | 22 首、17 首变更、895 行新增、287 行不变、0 拒绝/0 陈旧/0 警告/0 保护冲突 | `real-qa-plan.json` |
| 歌词一致 | 22/22 首 `lyricsIdentical=true`；合并后逐行比对 `mismatches=0` | `real-qa-plan.json` / `translation-parity.json` |
| 人工译文零覆盖 | 计划内 `replaced=0`、`MANUAL_OVERWRITE=0`；合并后 68/68 行人工译文原样保留 | `manual-before.json` / `manual-after.json` |
| apply 自检 | `verification.ok=true`、`problems=[]`、缓存 183→677（`complete=true`） | `real-qa-apply.json` |
| 非目标数据零变化 | `db-compare ok=true`、`problems=[]`，仅 17 首 revision+1、缓存按设计新增 | `db-compare.json` |
| 音轨/剪辑/媒体 | `performance_clips=46`、`source_media=31` 行数不变；媒体 48 文件摘要前后一致；`music/` 3 mp3+3 lrc mtime 仍为 10-30 11:20 | `post-integrity.log` / `media-diff.txt` / `music-mtimes.txt` |
| 组对/凭据未动 | `owner_credentials` 仍 4 行（只计行数）；`owner-pairing.json`、`.qa-token` mtime 未变 | `post-integrity.log` / `backup-recheck.log` |
| 同环境重启 | 新 pid 3170，PPID 1，手动启动、无自启；`/api/health` 200；无凭据 401 | `restart-health.log` |

## 二、实测数据

### 1) 停止前现场
```
PID 74097  PPID 1  启动 Sat Oct 31 04:21:07 2026  node server/index.mjs
cwd = /Users/zzymima0000/Developer/coding/1.Active/040-ing-才艺展示厅
HOST=0.0.0.0 PORT=28794
SQLITE_DB_PATH=<项目>/var/vocal-v31-work/real-qa-20261030/db/qa.db
MEDIA_ROOT=<项目>/var/vocal-v31-work/real-qa-20261030/media
VOCAL_IMPORT_WORKER=0 LOG_FORMAT=json
qa.db     63f888b707f05fbdd23555eec9e8f14fe618398f43809edcf172149a756160c4  (860160 B)
qa.db-wal 空（0 B）   qa.db-shm 32768 B
2879x 段仅 74097 一个监听
```

### 2) 停止
`SIGTERM 74097` → 约 1s 内退出；`PORT_28794_FREE`；`qa.db` 哈希仍为 `63f888b7…`（WAL 为空，无未落盘数据），`-wal/-shm` 由正常退出移除。

### 3) 备份（SQLite 一致性备份）
```
sqlite3 qa.db ".backup 'var/backups/real-qa-20261031-premerge-batch2/qa.db'"
备份 integrity_check = ok；page_count 210 / page_size 4096 / freelist 0
备份与线上 .dump sha256 同为 50adeb6be195…（内容一致）
迁移 10 条 / items 31 / cache 183 / creds 4
```
脚本 apply 时另存一份：`merge-clone-2026-10-30T20-30-53-841Z.db`，`.dump` 哈希同为 `50adeb6b…`。
注：`.backup` 产出的文件与源文件**字节哈希不同**（7d69591a vs 63f888b7），但表结构、行数与 `.dump` 完全一致——SQLite 一致性备份按页复制，不保证字节级等同，判定以内容为准。

### 4) 重跑 plan（写库前判定）
```
migrations.appliedNow = []     dataPreserved = true
songsConsidered 22  songsChanging 17  linesAdding 895
linesRejected 0  linesKeptProtected 0  linesUnchanged 287  warnings 0  staleLines 0
cache: 677 源键 / 183 目标键 / 待补 494
```
逐项加固检查（`plan.log` 及下述脚本输出）：
- `lyricsNotIdentical=0`、`missingInTarget=0`
- `replaced=0`、`MANUAL_OVERWRITE=0`、`kept=0`
- `existingManualLinesChecked=68`、`wouldBeOverwritten=0`（源库对每条已有人工行均为同文 manual）
- 17 首 `predictedRevision = 当前+1`，5 首不变（`chg=0`、`willWrite=false`）
- 变更行合计 = 21+48+83+48+56+54+39+54+73+52+50+62+71+65+49+12+58 = **895**

`verification.ok=false` 仅因 plan 模式尚未插缓存（`problems=[]`），与上轮 plan 语义一致。

### 5) apply（单事务）
- 写入 17 行 `translations_json`，每行 `changes=1`；缓存 `INSERT OR IGNORE` 补 494 行。
- `verification.ok=true`、`problems=[]`、`cacheAfter=677`、`cacheIntegrity.complete=true`。

逐曲（行数 / manual / ai / lrc / 修订）：

| 曲目 | 行 | manual | ai | lrc | 修订 |
|---|---:|---:|---:|---:|---|
| Alan Walker-All Falls Down (刘至佳 lambert remix) | 21 | 0 | 14 | 7 | 3→4 |
| Bubble Pop! | 48 | 0 | 48 | 0 | 1→2 |
| Clean Bandit Rather Be Without Me | 83 | 0 | 83 | 0 | 1→2 |
| Cure For Me | 48 | 0 | 48 | 0 | 2→3 |
| Dynamic female voice | 56 | 0 | 56 | 0 | 2→3 |
| Faded | 54 | 0 | 54 | 0 | 2→3 |
| Jar Of Love | 39 | 0 | 39 | 0 | 2→3 |
| Let Go | 54 | 0 | 54 | 0 | 3→4 |
| Papillon | 73 | 0 | 73 | 0 | 2→3 |
| Teeth | 52 | 0 | 52 | 0 | 2→3 |
| Touch | 50 | 0 | 50 | 0 | 3→4 |
| Trespassing | 62 | 0 | 62 | 0 | 2→3 |
| Welcome to New York (Big Apple Version) | 71 | 0 | 71 | 0 | 2→3 |
| senorita (翻自 Shawn Mendes) | 65 | 0 | 15 | 50 | 2→3 |
| 소나기 (Feat. 10cm) | 49 | 0 | 49 | 0 | 2→3 |
| 여름 안에서 (Live) | 12 | 0 | 12 | 0 | 2→3 |
| 흉터 (Feat. 치타) | 58 | 0 | 58 | 0 | 1→2 |
| **合计** | **895** | 0 | 809 | 86 | — |

未写入的 5 首（上一轮已合并，本轮逐行一致，未触碰）：Insomnia 40（manual 7/ai 33）、덤더럼 44（14/30）、베베 65（20/45）、보여줄게 47（13/34）、사뿐사뿐 91（14/77）。

### 6) 独立复核（不复用脚本自检）
| 检查 | 工具 | 结果 |
|---|---|---|
| 逐行与源库一致（id/text/source）+ 原歌词数组逐行一致 + 目标无多余译文 | `verify-parity-v2.mjs` | 31 首受检、22 首有译文、1182 行、`mismatches=0`、`ok=true` |
| 已有人工行保留 | `verify-manual-preserved.mjs` | `checkedManualLines=68`、`problems=[]`、manual 68→68 |
| 前后快照 diff | `compare-db-state.mjs` | `ok=true`、`problems=[]`、`translated=22`、`revisions=17`（delta 全为 1） |
| 库完整性 | `PRAGMA integrity_check` | `ok`（停止态 `immutable=1`；运行态 `mode=ro` 各一次） |
| 媒体 48 文件 | `shasum -a 256` diff | 无差异（与上轮基线也完全一致） |
| 原 `music/` mp3+lrc | `stat` mtime | 均仍为 2026-10-30 11:20 |

> 说明：上轮 `verify-translation-parity.mjs` 解析歌词时按 `{lines:[]}` 取，实际 `lyrics_json` 是顶层数组，导致歌词比对为空转。本轮新增 `verify-parity-v2.mjs` 按数组解析，歌词逐行比对才真正生效。上轮报告的「逐行一致」结论对 text/source 成立，对歌词部分此前未被真实覆盖。

### 7) 重启（原环境，无自启）
```
新 pid 3170  PPID 1  启动 Sat Oct 31 04:31:47 2026  node server/index.mjs
HOST=0.0.0.0 PORT=28794 SQLITE_DB_PATH=<同前> MEDIA_ROOT=<同前> VOCAL_IMPORT_WORKER=0 LOG_FORMAT=json
日志追加 var/vocal-v31-work/logs/lan-server.log
GET /api/health → 200 {"ok":true,"recognition":"disabled"}
GET /api/repertoire?kind=VOCAL（无凭据）→ 401
日志尾：`=== restart 2026-10-30T20:31:47Z (batch2: 17 songs / 895 lines merged) ===` + `Dance API http://0.0.0.0:28794`，无堆栈
```
未安装 LaunchAgent、未设置开机自启或自动重启；进程形态与原进程一致（手动启动、PPID 1）。

### 8) 合并后库状态
```
integrity_check ok | vocal 31 | translated 22 | cache 677 | creds 4 | migrations 10 | clips 46 | source_media 31
qa.db sha256 1de4b4d746f8b993ec2759568f6cb1778a80a57fdae0216240e49928e93d7e38（运行中，含 WAL 重新打开后的头部变化）
```

## 三、边界与未做事项

- 未写生产库 `var/personal-dance-library.db`；未改原 MP3、LRC、媒体、`music/`。
- 未读、未导出、未输出凭据内容（`owner_credentials` 只统计行数 4；`.qa-token` 只取 mtime）。
- 未触碰手机、未外放、未调用其他同模型实例、未跑全量回归、未 commit、未 push。
- **未做接口层译文可见性验证**（本轮按用户要求只做健康检查 + 库级验证；带凭据的 `/api/repertoire` 未调用）。
- **译文质量未逐句复核**：本轮只验证「库内容 = 源库内容」与结构完整性，不构成翻译准确性结论；`lrc` 来源 86 行、`ai` 来源 809 行，均沿用源库标注。

## 四、回滚路径（未触发）

```bash
kill -TERM 3170
node scripts/merge-translations-clone.mjs --mode rollback \
  --target-db var/vocal-v31-work/real-qa-20261030/db/qa.db \
  --backup-file var/backups/real-qa-20261031-premerge-batch2/qa.db \
  --confirm-original YES-WITH-AUTHORIZATION
# 然后以原环境重启；回滚后 translated=5、cache=183、.dump 哈希应回到 50adeb6b…
```

## 五、本轮文件

| 文件 | 内容 |
|---|---|
| `pre-state.txt` | 停止前进程/环境/端口/库与源库哈希 |
| `stop.log` | SIGTERM、退出耗时、端口释放、文件变化 |
| `backup.log` / `backup-verify.log` / `backup-recheck.log` | 一致性备份、integrity、内容哈希 |
| `db-before.json` / `db-after.json` / `db-compare.json` | 合并前后快照与 diff |
| `real-qa-plan.json` / `real-qa-apply.json` | 本轮 plan 与 apply 全量判定 |
| `translation-parity.json` / `manual-before.json` / `manual-after.json` | 逐行一致与人工行保留 |
| `media-before.sha256` / `media-after.sha256` / `media-diff.txt` / `music-mtimes.txt` | 媒体与原始音频基线 |
| `restart-health.log` / `final-db-check.log` | 重启健康、运行态库检查 |
| `verify-parity-v2.mjs` / `verify-manual-preserved.mjs` | 本轮独立复核脚本（可复跑） |
