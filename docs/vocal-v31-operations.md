# P040 V3.1 本地导入：运行与恢复操作说明

- 依据：当前仓库 `server/vocal-import/config.mjs`、`integration.mjs`、`queue.mjs`、`separator.mjs`、`importer.mjs`、`routes.mjs`、`source-policy.mjs`、`server/index.mjs`，以及真实分离报告 `var/vocal-v31-work/reports/SUMMARY.md`、`run-manifest.json`。
- 性质：操作说明，不是音质验收报告，也不代表生产可用或 V3.1 最终完成；真机已覆盖安装 1.1.1 (4) 且四 Tab 可打开，但本地智能导入受 `AbortSignal.timeout` 缺陷阻塞（修复中），播放听感与 20 首批量验证未做。
- 适用：在本机 Mac 上以**前台、临时、可随时停止**的方式试用 V3.1 本地导入。

## 1. 默认关闭，先确认没有误开

以下三项默认均为关闭或未配置：

| 能力 | 默认 | 开启条件 |
|---|---|---|
| `/api/vocal-import/*` 接口 | 不挂载 | 必须配置至少一个白名单根目录（`VOCAL_IMPORT_ROOTS` 或 `VOCAL_IMPORT_ROOT_PATH`） |
| 后台提取 worker | 关闭 | `VOCAL_IMPORT_WORKER=1`；否则扫描只入队，任务停在「待提取」 |
| 本机人声分离 | 未配置 | 本机存在可执行的 `audio-separator`（或 `VOCAL_IMPORT_SEPARATOR_CMD`），且模型可用 |

没有任何白名单根目录时，`createVocalImportIntegration()` 直接返回 `null`，服务端不挂载导入接口，请求落到 404 `NOT_FOUND`；不会启动后台循环。

前端入口在「设置」页的「本地智能导入」面板（`src/components/VocalImportManager.tsx`）。它只读取服务端已登记的目录，不能自行添加本机路径。未配置根目录时面板会提示未配置。

导入接口还有两个兜底/冲突动作，默认都不会自动触发，必须由界面按钮或显式 API 调用：

| 动作 | 作用 | 不会做什么 |
|---|---|---|
| `POST /api/vocal-import/jobs/:id/original-only` | 只把原唱 + 歌词安全入库，任务记为 `IMPORTED` 且 `importMode=ORIGINAL_ONLY` | 不写伴奏轨、不用原唱冒充伴奏、不覆盖已有原唱/歌词 |
| `POST /api/vocal-import/jobs/:id/resolve-conflict`，body `{"choice":"keep-existing"}` 或 `{"choice":"use-new"}` | 入库阶段已有伴奏时，由用户明确选择保留旧伴奏或改用新伴奏 | 默认不静默替换；`use-new` 让旧音轨文件与记录保留，仅不再作为当前伴奏 |

## 2. 启用前的前置检查（只读）

1. Node.js ≥ 22（`package.json` 已声明）。
2. 目标数据库已包含迁移 `0008_vocal_import.sql` 的三张 `vocal_import_*` 表。缺少时队列会以 `VOCAL_IMPORT_SCHEMA_MISSING` 拒绝启动导入能力。用只读方式确认（不会触发迁移）：

   ```bash
   SQLITE_DB_PATH=/绝对路径/目标.db node --input-type=module -e "
   import { existsSync } from 'node:fs';
   import { DatabaseSync } from 'node:sqlite';
   const p = process.env.SQLITE_DB_PATH;
   if (!existsSync(p)) { console.error('数据库文件不存在'); process.exit(1); }
   const db = new DatabaseSync(p, { readOnly: true });
   console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vocal_import_%' ORDER BY name\").all());
   db.close();
   "
   ```

   **重要：**`server/index.mjs` 启动时通过 `openDatabase()` 自动应用所有未执行的迁移。因此启动前必须确认 `SQLITE_DB_PATH` 指向的是你可以改动的试用库，而不是生产库。需要提前补迁移时，对**非生产**试用库执行 `node server/db/migrate.mjs`；本说明不要求也不授权对生产库执行迁移。
3. `MEDIA_ROOT` 指向可写、且与源音乐目录分开的位置。导入产物只写 `MEDIA_ROOT/vocal-import/`。
4. `ffprobe` / `ffmpeg` 可用（默认取 `PATH`，可用 `FFPROBE_BIN` 覆盖 `ffprobe`）。
5. 如需真实分离，确认分离命令与模型文件存在（见第 4 节）。

## 3. 受控目录配置（只能由服务端环境变量声明）

支持两种写法，二选一：

```bash
# 写法一：多个根目录
export VOCAL_IMPORT_ROOTS='[{"id":"music","label":"本机音乐","path":"/绝对路径/只读音乐目录"}]'

# 写法二：单根快捷写法
export VOCAL_IMPORT_ROOT_PATH='/绝对路径/只读音乐目录'
export VOCAL_IMPORT_ROOT_ID='music'        # 可省略，默认 music
export VOCAL_IMPORT_ROOT_LABEL='本机音乐'  # 可省略
```

规则（由 `config.mjs` 与 `source-policy.mjs` 实现）：

- `id` 只允许 `A-Za-z0-9_-`，长度 1–40，不能重复；不要使用中文、空格或其他符号。
- 路径在启动时经 `resolve()` 转绝对路径；外置卷未挂载或目录不可读时，`/roots` 中该根显示 `available:false`。
- 根目录本身允许是挂载点或系统符号链接（例如外置卷挂载路径）；**根目录以下任何一段符号链接都会被拒绝**，扫描也会跳过符号链接文件。
- HTTP 请求只能传 `rootId` + 相对 `subPath`。绝对路径、`..`、盘符、UNC、NUL、`path` / `folder` / `dir` 等字段一律拒绝（403 `PATH_NOT_ALLOWED` 或 400 `BAD_REQUEST`）。
- 源目录按只读使用：扫描、探测、哈希、ffprobe 都不写源目录；不改名、不移动、不删除、不覆盖。

不要把自己的音乐目录同时设为 `MEDIA_ROOT`。`MEDIA_ROOT` 会被写入 `vocal-import/<songId>/`；源目录必须保持独立。

## 4. 分离器与模型路径配置

| 变量 | 当前行为 |
|---|---|
| `VOCAL_IMPORT_SEPARATOR_CMD` | 分离命令，默认 `audio-separator`。可写绝对路径或 `PATH` 中可找到的命令名。 |
| `VOCAL_IMPORT_MODEL` | 原样作为 `--model_filename` 传给分离命令。写纯模型文件名时交由 audio-separator 自行解析；写成本地文件路径但文件不存在时，明确报 `SEPARATOR_NOT_CONFIGURED` 并退回待提取，不计失败次数。 |
| `VOCAL_IMPORT_OUTPUT_FORMAT` | 默认 `flac`。 |
| `VOCAL_IMPORT_TIMEOUT_MS` | 单首提取超时，默认 30 分钟。 |
| `VOCAL_IMPORT_EXTRA_ARGS` | JSON 字符串数组，追加到分离命令参数中。 |

模型目录示例（交给分离命令自带的模型目录参数）：

```bash
export VOCAL_IMPORT_SEPARATOR_CMD='/绝对路径/.venv/bin/audio-separator'
export VOCAL_IMPORT_MODEL='model_bs_roformer_ep_317_sdr_12.9755.ckpt'
export VOCAL_IMPORT_EXTRA_ARGS='["--model_file_dir","/绝对路径/models"]'
export VOCAL_IMPORT_OUTPUT_FORMAT='flac'
export VOCAL_IMPORT_TIMEOUT_MS='1800000'
```

注意：

- `queue.mjs` / `separator.mjs` 强制追加 `--single_stem Instrumental` 与本次任务的 `--output_dir`，且放在 `VOCAL_IMPORT_EXTRA_ARGS` 之后，因此额外参数不能把人声当伴奏，也不能改写输出目录。
- `VOCAL_IMPORT_MODEL` 与 `--model_file_dir` 的组合来自真实分离报告的调用方式；通过本项目适配器跑通真实音质的验收尚未完成，不能据此宣称音质 PASS。
- 输出目录必须位于 `MEDIA_ROOT/vocal-import` 下，否则适配器拒绝执行。
- 分离器只接受可识别为伴奏的产物：文件名含 `Instrumental` / `Accompaniment` / `Off Vocal` / `伴奏` 视为伴奏；含 `Vocals` / `人声` / `主唱` / `acapella` 一律不作为伴奏。无法确认时宁可失败，不任取其一。

## 5. 仅前台启动（推荐且唯一允许的试用方式）

使用独立试用库、独立媒体目录、回环地址，前台运行：

```bash
cd /项目根目录

export HOST='127.0.0.1'
export PORT='8791'
export SQLITE_DB_PATH='/绝对路径/试用目录/试用.db'
export MEDIA_ROOT='/绝对路径/试用目录/media'

export VOCAL_IMPORT_ROOTS='[{"id":"music","label":"试用音乐","path":"/绝对路径/只读音乐目录"}]'
export VOCAL_IMPORT_WORKER='1'
export VOCAL_IMPORT_SEPARATOR_CMD='/绝对路径/.venv/bin/audio-separator'
export VOCAL_IMPORT_MODEL='model_bs_roformer_ep_317_sdr_12.9755.ckpt'
export VOCAL_IMPORT_EXTRA_ARGS='["--model_file_dir","/绝对路径/models"]'

node server/index.mjs
```

- 启动后终端持续占用；`Ctrl+C` 触发 SIGINT 优雅关闭，worker 停止，服务关闭，数据库关闭。
- 首次启动会通过 `openDatabase()` 自动对 `SQLITE_DB_PATH` 指向的数据库执行未完成迁移；若希望先单独确认，可对同一个试用库执行 `SQLITE_DB_PATH='...' node server/db/migrate.mjs`。再次提醒：迁移会写入目标库，启动前务必确认不是生产库。
- 不建议用 `npm run server:dev` 做受控试用：它带 `--watch`，文件变动会重启进程，容易在提取中途打断任务。
- 不要使用 `nohup`、`&`、`disown`、tmux 常驻、PM2、launchd、systemd、Docker `restart`、计划任务等方式让它后台常驻或开机自启。本说明明确禁止自行设置任何自启或常驻服务；需要长期运行时另行取得授权并走后台服务规范。
- 鉴权：导入接口必须带 owner 配对令牌。服务首次启动会在数据库同目录生成 `owner-pairing.json`（权限 `0600`）。令牌和配对码只在本机使用，不写进文档、不粘贴到聊天、不记录到日志。设备未配对或令牌无效时，导入接口固定返回 401 `UNAUTHORIZED`。
- 可用浏览器打开本机页面，在「设置 → 本地智能导入」选择目录并扫描；也可用 HTTP 接口操作，但不要手工拼绝对路径。
- 提取失败或本机模型不可用时，界面会提供「只入库原唱 + 歌词」；已 `ORIGINAL_ONLY` 入库的条目会显示「继续提取伴奏」，点击后从同一任务补跑提取，不新建卡片。曲库已有伴奏时，界面先要求「保留旧伴奏 / 改用新伴奏」，改用新伴奏还需再次确认。

## 6. 只读原始素材的边界

- 扫描阶段只读取：读取文件、计算 SHA-256、ffprobe 时长/标签、前 20 秒 PCM 指纹、整轨解码覆盖率。
- 提取阶段前后核对源文件大小与 mtime；队列还会在提取前后核对源 SHA-256。任一变化即 `SOURCE_CHANGED`，本次结果作废，任务失败并要求重新扫描。
- 伴奏产物只写 `MEDIA_ROOT/vocal-import/<songId>/`；入库时原唱是**复制**到该目录下的 `original.<ext>`，不是移动、不是改名、不是覆盖源文件。
- 入库只新增/复用曲库媒体，不改写源音乐目录。已有歌词/结构保留。
- 已有伴奏轨时：分离前只读预检就会停下，不调用分离器、不覆盖同名输出，任务转 `NEEDS_REVIEW`（stage `IMPORT`）；只有 `resolve-conflict` 明确选择才继续处理：
  - `keep-existing`：保留曲库现有伴奏，只补原唱、歌词、语言。
  - `use-new`：确认后才改用新伴奏；尚无新工件时先单独提取一份，旧音轨文件与记录保留，仅不再作为当前伴奏。提取失败会恢复冲突现场，旧伴奏仍在。
- `original-only` 只允许没有伴奏工件、且状态为 `PENDING_EXTRACT` 或 `FAILED` 的任务；入库后 `importMode=ORIGINAL_ONLY`，仍可通过重试继续补提取伴奏。

## 7. 失败与恢复

状态流转：`NEEDS_REVIEW` →（人工核对）→ `PENDING_EXTRACT` → `EXTRACTING` → `VERIFYING` → `IMPORTED`；未注入入库器时停在 `READY_TO_IMPORT`。`IMPORTED` 有两种模式：`DUAL_TRACK`（原唱 + 伴奏）和 `ORIGINAL_ONLY`（只有原唱 + 歌词，可继续提取伴奏）。

| 现象 / 错误码 | 当前行为 | 恢复动作 |
|---|---|---|
| `EXTRACTOR_NOT_CONFIGURED` / `SEPARATOR_NOT_CONFIGURED` | 退回 `PENDING_EXTRACT`，**不消耗重试次数** | 修正命令/模型配置后重启前台进程；worker 不会整体停止，只跳过需要分离的任务并继续处理自带伴奏/待入库任务，但提取能力要重启才恢复 |
| `SEPARATOR_TIMEOUT` / `SEPARATOR_FAILED` | 可重试失败，累计 `attempts`，达到 `maxAttempts`（默认 3）后 `FAILED` | 在界面或 `POST /api/vocal-import/jobs/:id/retry` 重试；重试会把 `attempts` 归零 |
| `SEPARATOR_NO_OUTPUT` | 无可识别伴奏（或只产出人声） | 检查模型/参数后重试；不要手工把 Vocals 改名成 Instrumental |
| `SOURCE_CHANGED` | 不可重试，直接 `FAILED` | 当前没有安全的 API 级恢复路径：重复扫描会保留 `FAILED` 且不更新任务的源 SHA，直接重试仍会再次 `SOURCE_CHANGED`。停止对该任务继续操作，记录现象后交维护者按数据修复流程处理；不要手工改库 |
| 曲库已有伴奏 | 分离前预检即停止，不调用分离器、不覆盖；进入 `NEEDS_REVIEW`（stage `IMPORT`），旧轨保留；同一工件则幂等收尾 | 用 `resolve-conflict` 明确选择 `keep-existing`（只补原唱/歌词）或 `use-new`（旧轨不再作为当前伴奏，文件保留）；该类任务不能用歌词候选消除 |
| 点「只入库原唱 + 歌词」 | 仅 `PENDING_EXTRACT` / `FAILED` 且无伴奏工件可执行；原唱 + LRC 入库，`importMode=ORIGINAL_ONLY`，不写伴奏轨 | 界面会显示「继续提取伴奏」；点重试会从同一 `songId` 补跑提取，不新建卡片 |
| 已 `IMPORTED`（`ORIGINAL_ONLY`）后点「继续提取伴奏」 | 允许重试，任务回到 `PENDING_EXTRACT` 重新提取；若曲库已有伴奏，先预检并进入入库冲突，不覆盖 | 按上一行选择保留旧伴奏或改用新伴奏；双轨 `IMPORTED` 是终态，不能再重新提取 |
| `use-new` 时没有新伴奏工件 | 单独提取一份新伴奏并校验，旧音轨不再作为当前伴奏、文件保留；提取失败恢复 `NEEDS_REVIEW` 冲突现场 | 检查分离器后重试，或改选 `keep-existing` 保留旧伴奏 |
| 进程崩溃、超时被杀 | 租约到期后由 `recover()` 处理：`EXTRACTING` 退回 `PENDING_EXTRACT`，`VERIFYING` 保留校验阶段 | 优先 `Ctrl+C` 优雅停止。若被强杀，先等待租约过期（默认 120 秒）再重启；否则任务可能仍停在 `EXTRACTING`，需再次重启才会回收 |
| 在「校验完成 → 入库」之间重启 | 已注入入库器时，恢复后只补跑校验与入库，不重新提取 | 正常重启前台进程即可 |
| 取消 | 运行中只置取消标记，提取结束、校验后、入库前各检查一次；命中即 `CANCELLED` | 取消后不会被重扫自动复活；需要时通过重试（`POST /api/vocal-import/jobs/:id/retry`）重新处理，重试会重置 `attempts` |
| 重复扫描 | 只刷新匹配信息；不复活 `CANCELLED`，不清零 `FAILED`，不改写 `IMPORTED`/处理中任务 | 普通失败任务需显式重试；取消任务需重新处理。`SOURCE_CHANGED` 见上一行，当前无法通过 API 恢复 |

恢复原则：只通过界面或 REST 接口操作任务；不要手工改 SQLite 行、不要删除 `vocal_import_*` 表、不要手工伪造工件路径。需要清理时先备份数据库与 `MEDIA_ROOT/vocal-import/`。

## 8. 已知限制（按当前代码与真实报告）

1. 真实分离报告只覆盖 3 首（中/英/韩），使用 `model_bs_roformer_ep_317_sdr_12.9755.ckpt`，MPS fp32，单首约 667 / 696.6 / 671.9 秒；未做人工听感，未取得真值 SDR，跨模型一致性不代表分离质量。
2. 该报告由独立脚本完成，并未证明「本项目适配器 → audio-separator」链路的真实音质、内存与稳定性；适配器测试使用假分离器，不等于真实分离 PASS。
3. 真机仅完成覆盖安装 `1.1.1 (4)` 与四 Tab 打开（见 `docs/qa/vocal-v31-device/QA_RESULT.md`）；「我的 → 本地智能导入」报 `AbortSignal.timeout is not a function`，目录列表与任务状态失败，修复中、未复验。曲库无真实歌曲，播放器音频听感未验证，不代表手机端功能或离线播放 PASS。生产服务未启用，生产库未迁移（`var/personal-dance-library.db` 仍只到 0006，无 0007/0008 与 `vocal_import_*` 表）。未对真实大目录做全量扫描，未做 20 首批量验证。不要在未授权时把这些当作已完成能力。
4. 不生成额外的手机端 M4A/MP3 缓存版本；原唱按原格式保存，伴奏为 FLAC。
5. 提取并发固定为 1（适配器串行 + 队列单任务），不提供批处理并发。
6. `qualityState` 固定为 `unverified`；技术校验要求音频扩展名、真实完整解码、SHA 不与原唱相同、时长与原曲在容差内，失败不登记音轨；技术校验不代替听测。
7. 外部卷未挂载时目录显示不可用，不会自动重试挂载。
8. 模型权重许可证未明确，不能据此推断可再分发或商用。
9. 根目录只能通过环境变量配置，界面不提供添加目录；新增/修改目录需要重启前台进程。
10. 单首默认超时 30 分钟；真实报告单首接近 11–12 分钟，长音频或低配环境需自行上调 `VOCAL_IMPORT_TIMEOUT_MS`。
11. `SOURCE_CHANGED` 任务目前没有经 API 的恢复路径：重复扫描会保留 `FAILED` 且不更新源 SHA，重试也会再次失败。遇到时不要改库，记录任务 id 与源文件变化情况，交维护者处理。

## 9. 明确禁止

- 禁止自行设置开机自启、后台常驻、守护进程、容器重启策略或系统计划任务来运行本导入服务。
- 禁止把 owner 配对令牌、配对码、API Key、`.env` 内容复制进文档、日志、截图或聊天；本机凭据只留在本机受控文件中。
- 禁止对生产数据库执行扫描入库、迁移、重试或清理；试用必须使用独立试用库与独立媒体目录。
- 禁止在未获授权时操作手机、ADB、安装包或生产环境；本说明不包含真机步骤，手机设置与手机/用户数据不得擅自更改。**2026-10-30 用户已明确批准出声测试**：可正常出声播放并做听感验证，旧「所有媒体一律静音」限制（`muted=true`、`volume=0`）已撤销；但仍不得把未听测当作音质 PASS。
- 禁止在源音乐目录内写入、改名、移动或删除文件；禁止关闭只读保护绕过路径检查。
- 禁止手工篡改 `vocal_import_*` 数据或伪造伴奏工件来「让任务通过」。

## 10. 停止与回退

1. 前台进程 `Ctrl+C` 即停止导入 worker 与 API；已入队任务保留在数据库中，不会自动继续。
2. 只是不想再用：取消 `VOCAL_IMPORT_*` 环境变量并重启，导入接口不再挂载，前端显示未配置；不要删除数据库或媒体目录。
3. 需要彻底回退时，先备份数据库和 `MEDIA_ROOT/vocal-import/`，再按版本管理流程处理；本说明不授权删除任何用户数据。
