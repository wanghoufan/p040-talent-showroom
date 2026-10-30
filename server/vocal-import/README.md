# server/vocal-import ｜V3.1 本地导入：安全扫描 + 后台队列 + API 基础

本目录是 V3.1 的**新增**模块，未改动任何既有文件（含 `server/index.mjs`、V2.1 未提交代码）。
数据库只新增 `server/db/migrations/0008_vocal_import.sql` 三张 `vocal_import_*` 表。

## 已完成

| 能力 | 位置 |
|---|---|
| 目录白名单 / 拒绝任意绝对路径 / 拒绝符号链接越界 / 跳过 AppleDouble `._*` | `source-policy.mjs`、`scan.mjs` |
| 文件名归一（NFKC、全角括号、逗号空格）、版本隔离、`(1)` 副本识别 | `canonical.mjs` |
| ID3 交叉核验：多歌手 `/` 与 `,` 视为等价，全角/半角括号不误报 | `canonical.mjs`、`scan.mjs` |
| LRC 解析（BOM、`[mm:ss.xx]`/`[mm:ss.xxx]`、多标签、`[offset:]`、无时戳） | `lrc.mjs` |
| 只读探测：ffprobe 时长/ID3、前 20 秒 PCM 指纹、整轨解码覆盖率 | `probe.mjs` |
| 扫描 + 保守配对 + 重复/歧义报告，songId = uuid5(音频 SHA-256) | `scan.mjs` |
| 持久队列：幂等、租约、重启恢复、逐项失败隔离、源文件被改动即作废 | `queue.mjs`、`store.mjs` |
| REST 处理器（不自行注册路由） | `routes.mjs` |
| 本机分离器适配（只读源、独立输出、并发一、失败分类） | `separator.mjs` |
| 曲库入库（同 songId 双轨、事务、幂等、保留人工歌词/结构） | `importer.mjs` |
| 运行配置与 `server/index.mjs` 装配 | `config.mjs`、`integration.mjs` |

## 与真实核验报告的对齐（`var/vocal-v31-work/real-music-audit-deep.json`）

- **尾部损坏**：T02 覆盖 98.99%、T03 覆盖 98.77%，都只有末尾报错。`probe.mjs` 计入
  `decode.state='tail-truncated'` + `coverageRatio`，扫描标记 `audio-tail-truncated`；
  这是**警告不阻断**，仍可提取伴奏（AC08）。整段损坏（覆盖 <95%）标记 `audio-damaged`。
- **封面不同导致的 PCM 重复**：T05 / T08 两组文件时长相同、SHA 不同，但前 20 秒 PCM 指纹完全相同，
  因此判为 `pcm-duplicate-different-file` 并**停在人工核对**，不静默合并、不改 songId。
- **ID3 多歌手**：真实标签用 `3LAU/Carly Paige`，文件名用逗号；已按分隔符/顺序归一，
  T01、T02、T07 不再误报歌手冲突。T05 标签比文件名多两位合作歌手，仍如实报冲突。
- 已在临时目录用上述 10 个真实音频副本跑通扫描：T01/T02/T03/T04/T06 自动就绪，
  T05/T07/T08 进入待核对，与计划包的预期一致；真实音乐目录本身只读、未被修改。

## 已接入 `server/index.mjs`（V3.1 增量）

- 配置与装配：`config.mjs` + `integration.mjs`；
- 本机分离器：`separator.mjs`（只读源、独立输出、单实例串行、失败分类）；
- 曲库入库：`importer.mjs`（同 `songId` 双轨，事务、幂等、保留人工歌词/结构）；
- 路由挂在**全局 owner 配对鉴权之后**，不新增公开上传入口。

### 运行配置（环境变量）

| 变量 | 说明 |
|---|---|
| `VOCAL_IMPORT_ROOTS` | JSON 数组 `[{"id":"music","label":"本机音乐","path":"..."}]`；或使用下面的单根写法 |
| `VOCAL_IMPORT_ROOT_PATH` | 单根路径；`VOCAL_IMPORT_ROOT_ID` / `VOCAL_IMPORT_ROOT_LABEL` 可选 |
| `VOCAL_IMPORT_WORKER` | `1` 时在 API 进程内启动单并发后台循环；默认关闭 |
| `VOCAL_IMPORT_SEPARATOR_CMD` | 本机分离命令，默认 `audio-separator` |
| `VOCAL_IMPORT_MODEL` | 传给 `--model_filename` 的模型名 |
| `VOCAL_IMPORT_OUTPUT_FORMAT` | 默认 `flac` |
| `VOCAL_IMPORT_TIMEOUT_MS` | 单首提取超时，默认 30 分钟 |
| `VOCAL_IMPORT_EXTRA_ARGS` | 追加参数 JSON 字符串数组 |

没有任何白名单根目录时不挂载 `/api/vocal-import/*`。HTTP 请求只能传 `rootId` + 相对 `subPath`。

### 本机分离器

- 默认调用 `audio-separator --single_stem Instrumental --output_format flac --output_dir <songId目录> <源文件>`；
- 提取前后核对源文件大小与 mtime，变化即作废（`SOURCE_CHANGED`）；
- 命令/模型缺失 → `SEPARATOR_NOT_CONFIGURED`，任务退回 `PENDING_EXTRACT` 且不消耗重试次数；
- 进程崩溃、超时、无产物 → 可重试失败，达到 `maxAttempts` 后 `FAILED`；
- 同一适配器实例串行执行，队列本身也是单任务，避免 M4 内存峰值叠加。

### 曲库入库

- 曲目 id 固定为 `songId`，`kind='VOCAL'`；原唱、伴奏分别写 `original_clip_id` / `accompaniment_clip_id`；
- 原唱复制到 `mediaRoot/vocal-import/<songId>/original.<ext>`，源目录只读、不改名、不覆盖；
- 伴奏使用提取产物，只引用既有 `source_media` / `performance_clips` / `repertoire_items`；
- **入库前强制校验**（`accompaniment-verify.mjs`）：必须是音频扩展名、真实完整解码、SHA 不与原唱相同、时长与原曲在容差内（≥2 秒或 2%）；失败不登记工件、不写音轨、不覆盖旧伴奏；
- 单事务提交；重复入库按确定性 id 复用媒体，不重复建卡片；
- 已有歌词/结构一律保留；只有曲目尚无歌词时才补 LRC 文本与时间戳；
- 旧音轨行只解绑不删除，避免误删仍在播放/缓存的媒体。

## 仍未完成（不得当作已实现）

1. **真实模型未在用户 M4 上运行**：本机没有安装 `audio-separator`，真实音质、速度、内存未验收；自动化测试用真实子进程契约 + 模拟模型产物，不等于真实音质 PASS。
2. **前端页面与手机端状态**：本模块只有接口，暂未修改 UI。
3. **真机与生产目录**：未操作手机、未用生产 DB、未跑真实 13 GB 目录全量扫描。
4. **手机端衍生编码**：当前原唱按原格式保存（mp3/m4a/wav/flac），伴奏为 FLAC；未生成额外 M4A/MP3 手机缓存版本。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/vocal-import/roots` | 可用导入根（只返回 id/名称/是否可用） |
| POST | `/api/vocal-import/scan` | `{rootId, subPath?}`；扫描并入队，202 |
| GET | `/api/vocal-import/jobs` | `?status=&rootId=&songId=&limit=` |
| GET | `/api/vocal-import/jobs/:id` | 任务详情 + 事件流 + 工件 |
| POST | `/api/vocal-import/jobs/:id/retry` | 失败重试（只重跑失败阶段；取消/失败后可重试） |
| POST | `/api/vocal-import/jobs/:id/cancel` | 取消（运行中只置取消标记） |
| POST | `/api/vocal-import/jobs/:id/resolve` | 人工核对：`{lyricsRelPath?, suppliedAccompanimentRelPath?}` |

任何请求体都不接受本机绝对路径；`path`/`folder` 等字段直接 403。
`resolve` 的歌词可以是白名单目录内任意 `.lrc`（不限本次候选），非候选会在事件里标记 `outsideCandidates`。

## 状态机

`NEEDS_REVIEW` →（人工核对）→ `PENDING_EXTRACT` → `EXTRACTING` → `VERIFYING` →（已注入 importer 时直接）→ `IMPORTED`；未注入 importer 时停在 `READY_TO_IMPORT`；
失败 `FAILED`（超过 `maxAttempts`），取消 `CANCELLED`，配置缺失用 `release()` 退回 `PENDING_EXTRACT` 且不计失败。

补充规则：

- 重复扫描只刷新匹配信息：不复活 `CANCELLED`，不清零 `FAILED` 的尝试次数与错误；
  `IMPORTED`/`READY_TO_IMPORT`/处理中任务保持不变。
- 扫描后或提取期间源音频 SHA 变化 → `SOURCE_CHANGED`，任务直接 `FAILED`，不登记伴奏工件（AC09）。
- 在“校验完成→入库”之间重启：已注入 `importer` 时恢复后只补跑入库，不重新提取。
- 尾部少量损坏只提示；整段损坏同样不阻断同批其它歌曲（AC08）。
- 歌词 SHA-256 会入队持久化，便于幂等定位与审计。
- 伴奏校验失败：用户自带伴奏退回 `NEEDS_REVIEW / MATCH`（可重新选择，不消耗重试）；分离产物直接失败，不产生可播放音轨。

## 测试

```bash
node --test tests/vocal-import-v31.test.mjs               # 23 项：扫描/队列/路由
node --test tests/vocal-import-integration-v31.test.mjs   # 12 项：分离器/入库/HTTP 授权/恢复
node --test tests/vocal-import-accompaniment-verify-v31.test.mjs  # 11 项：伴奏安全校验（含真实 ffmpeg 用例）
npx eslint server/index.mjs server/vocal-import tests/vocal-import-integration-v31.test.mjs
```

测试只用临时目录、临时 SQLite、假 ffprobe/ffmpeg 与临时假分离器脚本；**生产默认严格校验，测试只注入 `probe` 隔离编解码器**，扩展名/SHA/重复/时长规则不被放宽。不读用户音乐目录、不用生产 DB、不跑全量回归、不操作手机。
