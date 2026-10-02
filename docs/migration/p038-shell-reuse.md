# P038 Shell Reuse (T003)

- 记录日期：2026-10-02
- 任务：T003 核对 P038 当前 Project Reader worktree 落后/缺源码事实，自动定位 `origin/main` fresh clone 或已记录最新源码副本；只列可复用 UI/Range 思路与来源 revision。
- 模式：**只读**。未复制 P038 的 `.git`、健身视频、annotations、`.env`、keys、DockerData、业务模型。

## 事实核对

| 项 | 结果 |
|---|---|
| P038 本地目录 | `/Users/zzymima0000/Developer/coding/1.Active/038-ing-keep 运动健身仓库` |
| 本地 HEAD | `9534f00 chore: bootstrap keep 运动健身仓库 (P038)` |
| 本地分支状态 | `main` 落后 `origin/main` **6 个提交**（可 fast-forward） |
| 本地工作树是否含 app 源码 | **否**：无 `src/`，无 `server/`、`server.mjs` |
| 远端仓库 | `https://github.com/wanghoufan/p038-keep-fitness-workout-repo.git` |
| 最新真实源码 | **`origin/main` @ `a906d78dac3e84e7f7b001dae14518c95ed62aec`**（已 fetch 到本地 remote-tracking ref，无需新 clone） |

结论符合计划中的告警：**Project Reader 指向的 working tree 落后且缺正式 app 源码**，不得从该工作树盲拷。

## 可复用资产（来源 revision：`a906d78`）

只复用**通用思路**，不复制文件、不复制业务数据。

### 1. HTTP Range（媒体真源/播放）

- 来源：`server/http-range.mjs`（@a906d78）。
- 思路：`parseRange(header, size)` 返回四态 `full / multi / range / unsatisfiable`；`buildRangeResponse` 产出 `200 / 206 + Content-Range / 416 + bytes */size`。
- 可复用点：播放器 seek 依赖 206；多范围请求直接降级为 200 整段以避免 multipart 排障成本；未知扩展名回退 `application/octet-stream` 而非假报 `video/mp4`。
- 本项目落点：T066 `GET/HEAD /api/media/reference/:sourceId`、T037/T040 音频播放（Phase 5/9，本轮不实现）。

### 2. 统一 JSON 错误信封

- 来源：`server/http-responses.mjs`（@a906d78）。
- 思路：所有错误返回 JSON `{error, message}` + `Content-Type: application/json; charset=utf-8` + `no-store`；`headersSent` 时 `destroy()`。
- 本项目落点：T008 `server/http/responses.mjs` 的 error envelope（本轮实现）。

### 3. 稳定 opaque ID

- 来源：`server/ids.mjs`（@a906d78）。
- 思路：路径/来源做 NFC + 正斜杠规范化后哈希取 16 位 hex；URL 段只放行 `^[0-9a-f]{16}$`，天然拒绝 `..`/绝对路径/URL 编码穿越；id 不含绝对路径，客户端拿不到宿主机目录。
- 本项目落点：T009 `assets`/`dance_items`/`media` 的 opaque id 生成；`server/security/paths.mjs`（T020，本轮不实现）。

### 4. 配置集中解析

- 来源：`server/config.mjs`（@a906d78）。
- 思路：所有 `process.env` 只在 config 模块读取，加载时 `path.resolve` 成绝对路径；启动前做根目录体检，目录不存在直接失败而非静默建空目录。
- 本项目落点：T010 媒体目录配置（本轮实现），`server/config.mjs` 思想沿用。

### 5. 前端卡片 / 筛选 / 播放器框架

- 来源：`src/components/VideoCard.tsx`、`src/components/VideoFilters.tsx`、`src/lib/filter-videos.ts`、`src/pages/VideoPlayer.tsx`（@a906d78）。
- 思路（**未复制**，仅记录方向）：卡片“主体点击进详情 + 独立播放按钮”的双 hit-area 语义、筛选状态与结果计数、播放器 seek 交互。
- 本项目落点：T044–T046（`LearningStatusRail`/`SceneTagBar`/`DanceCard`）、T067–T068（详情/原视频页）（Phase 6/9，本轮不实现）。

## 禁止复制清单（已遵守）

- P038 `.git`、`封面图库`、健身视频、`catalog/annotations.json`、`.env`/`.env.example` 真值、任何 key/secret、DockerData、`p038-video-tagging` 业务模型。

## 结论

- P038 最新真实源码 = `origin/main @ a906d78`。
- 本项目以“思路复用”方式吸收 Range/JSON-error/opaque-id/config/卡片筛选逻辑，**不产生任何 P038 文件副本**。
