# 真实提取 + 入库核验结果（2026-10-30）

> 只读核验：未改业务代码、未改库、未重启服务、未操作手机、未跑全量测试。
> 证据：`real-import-evidence.json`；原始快照/日志 `raw/`；脚本 `scripts/`。
> 环境：隔离目录 `real-qa-20261030`，API `127.0.0.1:28794`，真实 `audio-separator` 0.47.2 + `model_bs_roformer_ep_317_sdr_12.9755.ckpt`。

## 总览

| 歌曲 | 状态 | 双轨 | 结论 |
|---|---|---|---|
| 덤더럼 (Dumhdurum) | IMPORTED / DUAL_TRACK | 原唱 + 伴奏 | PASS |
| Touch | IMPORTED / DUAL_TRACK | 原唱 + 伴奏 | PASS |
| 爱的恰恰 | NEEDS_REVIEW / MATCH | — | 预期歧义，不算缺陷 |

## 1｜任务状态

- Dumhdurum：`IMPORTED`、`DUAL_TRACK`、`stage=IMPORT`、`attempts=0`、无错误码；提取 11:23:59→11:36:37（12m38s）。
- Touch：`IMPORTED`、`DUAL_TRACK`、`stage=IMPORT`、`attempts=0`、无错误码；事件 created→claimed→**recovered(expired-lease-runtime)**→claimed(12:05:47)→extracted/verified/imported(12:17:29)，第二次提取 11m42s。
- 爱的恰恰：`NEEDS_REVIEW`，issues = `audio-role-unmarked-original-assumed`、`filename-id3-artist-conflict`（文件名与标签歌手不一致），按背景属正常歧义。
- **首轮 Touch 顺延说明**：11:20:46 领取后服务器进程在 11:23–11:40 间退出，任务未标失败、租约 45 分钟未到期，队列只能等 12:05:47 自动回收重跑；旧 run 目录为空，无脏产物。**PASS**

## 2｜工件（artifacts_json / vocal_import_artifacts / performance_clips）

| 歌曲 | 伴奏 | 原唱 |
|---|---|---|
| Dumhdurum | flac 22,958,141 B，SHA `db07ab09…f250`，208,053 ms | mp3 8,325,250 B，SHA `8b7de77…47b7`，208,053 ms，sourcePreserving=true |
| Touch | flac 23,041,860 B，SHA `e79414ee…0352`，205,773 ms | mp3 10,009,259 B，SHA `b761938…4cee`，205,773 ms，sourcePreserving=true |

两首伴奏字段均含 `model=model_bs_roformer_ep_317_sdr_12.9755.ckpt`、`separator=audio-separator`、`outputFormat=flac`、`state=ready`、`qualityState=unverified`；伴奏 SHA ≠ 原唱 SHA；时长差 0 ms（容差 4,161 / 4,115 ms）→ 在容差内。**PASS**

## 3｜媒体文件与库记录一致

`media/vocal-import/<songId>/` 实测重算大小与 SHA 与库逐字节一致；ffprobe 形式 mp3 / flac，时长 208.053 / 205.773 s。`GET /api/media/audio/<clipId>` 四个音轨均 200（audio/mpeg、audio/flac），Content-Length 与库一致。**PASS**

## 4｜曲库与歌词

- 两首均为 `kind=VOCAL`，`original_clip_id` + `accompaniment_clip_id` 双轨齐全；`/api/repertoire/<songId>` 返回 `tracks.original` / `tracks.accompaniment`，默认 `audioRole=ACCOMPANIMENT`（默认播放伴奏轨）。
- 歌词：Dumhdurum LRC 44 行 = 库 44 = 接口 44；Touch LRC 50 行 = 库 50 = 接口 50；首尾时间戳一致。**PASS**
- 三个表当前计数：`repertoire_items` 2、`performance_clips` 4、`source_media` 2（Dumhdurum + Touch）。

## 5｜源目录只读

`music/` 下 3 个 mp3 重算 SHA-256 与 `source_sha256` 完全一致；LRC 哈希与时间行数（50/44/70）也一致；文件未改动（mtime 仍为 11:20），原唱产物 SHA 与源一致（复制不重编码）。**PASS**

## 6｜真实分离器确被调用

`separator=audio-separator`、`model=bs_roformer ep317 sdr12.9755`、产物 flac；两轮都观察到 `audio-separator --model_filename … --output_format flac --single_stem Instrumental` 子进程，退出后立即产生 extracted/imported 事件；venv 版本 0.47.2，模型文件 639,331,213 B 在位。**PASS**

## 观察项（不阻塞，建议排期）

1. **英文歌 Touch 被判 `vocal_language=zh`**：`detectLanguage` 先判汉字再判拉丁，Touch 的 LRC 头两行是中文富文本头（作词/作曲）导致误判；影响按语言区分的练习/展示，不影响播放。
2. **服务进程退出导致首轮提取中断、租约锁 45 分钟**：任务不标失败、attempts 不增，单首墙钟从约 12 分钟拉长到约 55 分钟。
3. **artifacts_json 不登记原唱**：只登记伴奏，原唱在 performance_clips/source_media，下游若只读 artifacts_json 会误判无原唱。

## 真实限制

1. **未听测**：伴奏是否真的去掉人声未验证（`qualityState=unverified`）；Dumhdurum 的手机播放/音轨切换/离线播放已由主开发者真机完成，Touch 听感待人工确认。
2. 只 2 首走完全链路（非 20 首）；爱的恰恰 未做人工核对后入库。
3. 歌词只核对行数与首尾行，未逐行比对文本。
4. 未跑自动化测试；未验证手机端 UI、边听边录等下游功能。
