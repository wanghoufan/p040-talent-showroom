# FR / SC 追溯矩阵（T094）

日期：2026-10-02（Asia/Shanghai）　基线：`specs/001-personal-dance-library/spec.md`（V1.1）
证据目录：`docs/verification/`（截图在 `screens/`）。状态：`PASS` / `PARTIAL`（已实现并留证，但存在如实的边界）/ `GAP`。

## Functional Requirements（FR-001～FR-028）

| 需求 | 含义（简述） | 任务 | 证据 | 状态 |
|---|---|---|---|---|
| FR-001 | 首次不强制登录；空库有“＋ 收录舞蹈” | T026/T027 | `tests/browser`、`us1-import.md`、`screens/library-first-batch-*.png` | PASS |
| FR-002 | 收录入口解释“收什么” | T028 | `us1-import.md`（ImportSheet） | PASS |
| FR-003 | 本地视频/手动音频+封面/ACTION_SEND/桌面 drop | T028/T029/T051/T052 | `us1-import.md`、`us4-share.md` | PASS |
| FR-004 | 可读视频自动建参考视频/clip/候选 | T030/T031 | `import.test.mjs`（21 用例含） | PASS |
| FR-005 | 默认“想学”；状态固定单选 | T044/T048 | `filters.test.ts`、`device-verify-round3.md` | PASS |
| FR-006 | 场景标签固定 0～4 | T045/T048 | `filters.test.ts` | PASS |
| FR-007 | 顶部多标签 AND；与状态跨维度 AND | T043/T047 | `filters.test.ts`（全组合） | PASS |
| FR-008 | PerformanceClip 源自来源音频；识曲不得替换 | T037/T038 | `clips.test.mjs`、`media-truth.md`（12/12） | PASS |
| FR-009 | 裁剪仅 start/end + 试听 + 恢复完整 | T039/T040 | `us1-import.md`、`screens/us2-detail-trimmer.png` | PASS |
| FR-010 | 识曲/封面失败仍能保存；SongIdentity 可后改 | T033/T035 | `provider.test.mjs`、`import.test.mjs` | PASS |
| FR-011 | 保留 SourceMedia；详情显眼“查看原视频” | T066/T067/T068 | `device-verify-round3.md`（T072）、`t072-*.png` | PASS |
| FR-012 | 重复来源提醒；同歌不同源并存 | T069 | `import.test.mjs`（duplicate）、`delete.test.mjs` | PASS |
| FR-013 | 卡片一键播放；点击区域语义区分 | T046 | `bundled-build.txt`、`android-offline.md` | PASS |
| FR-014 | 演出模式分离；结束不自动下一首 | T062/T077 | `tonight-playlist.md`；`PerformancePage.tsx:87` | PASS |
| FR-015 | 离线校验真实反映可播状态 | T058/T060/T063 | `offline-manifest.test.ts`、`us5-offline.md` | PASS |
| FR-016 | 今晚歌单增删/排序/离线准备/readiness | T073–T076 | `playlist.test.mjs`、`tonight-playlist.md` | PASS |
| FR-017 | ACTION_SEND text/plain；去重消费 | T051/T052/T053 | `us4-share.md`（A/B）、`pending-shares.test.ts` | PASS |
| FR-018 | Mac 不可达时 PendingShare 本地持久化 | T053/T056 | `us4-share.md`（C OFFLINE_SAVED） | PASS |
| FR-019 | Douyin adapter 不可用 → NEEDS_INPUT，无通用抓取 | T054/T055 | `us4-share.md`（A/D）、`link-cover.test.mjs` | PASS |
| FR-020 | 识曲仅上传最小短音频；key server-only | T023/T084 | `provider.test.mjs`；`src/` grep 无任何 key/token（provider=disabled） | PASS |
| FR-021 | light/dark 双主题，默认跟随系统，持久化 | T013/T079/T080 | `device-settings.test.ts`、`theme-*.png` | PASS |
| FR-022 | “我的”endpoint/health/最近同步/缓存统计与安全清理 | T080/T081/T082 | `settings-red.txt`、`theme-*-settings.png`、`us5-offline.md` | PASS |
| FR-023 | 可交互目标 ≥48dp；safe-area/system bars | T013 | `index.css` 核查 + `ui-visual-qa.md`（本轮修 playlist 44/40→48） | PASS |
| FR-024 | Android 12+ 系统 SplashScreen，不额外阻塞 | T012 | `android-assets.txt` | PASS |
| FR-025 | `assets/app-icon-master.png` + adaptive/monochrome | T005/T012 | `asset-manifest.md`、`android-assets.txt` | PASS |
| FR-026 | 删除区分记录/媒体；引用时不误删 | T071 | `delete.test.mjs`、`device-verify-round3.md`（T071） | PASS |
| FR-027 | UI 不内置原型示例封面 | T050 | `screens/library-first-batch-*.png`（真实用户封面） | PASS |
| FR-028 | endpoint 仅可信私有网络；公开 HTTP 拒绝 | T024/T081 | `device-settings.test.ts`、`security.test.mjs` | PASS |

## Success Criteria（SC-001～SC-010）

| 需求 | 含义（简述） | 任务 | 证据 | 状态 |
|---|---|---|---|---|
| SC-001 | 空库→保存首条视频舞蹈，人工步骤 ≤5 | T036 | `us1-import.md`（三入口+确认页）；**未在空库上做逐步计数** | PARTIAL |
| SC-002 | ≥10 样本 clip 起止/速度/音调一致；改 SongIdentity 不改 hash | T042 | `media-truth.md`（12/12 通过） | PASS |
| SC-003 | 固定筛选集全部组合 100% 符合 AND 规则 | T043 | `filters.test.ts` | PASS |
| SC-004 | 完全离线冷启动 ≤3 操作播放已缓存“会跳” | T064 | `android-offline.md`（飞行模式 + Wi-Fi 关闭、无默认网络；冷启动 1 击播放、10 首通过；现有条目均“想学”，“会跳”指定前置待验） | PARTIAL |
| SC-005 | 10 首 Ready 断网 10/10；删 1 文件即时失效 | T078 | `tonight-playlist.md`（已准备好→删文件→未准备好） | PASS |
| SC-006 | 详情→原视频最多 1 次点击 | T072 | `device-verify-round3.md`、`t072-*.png` | PASS |
| SC-007 | 识曲 off/封面失败/adapter unavailable 三故障不丢意图 | T091 | `us1-import.md`、`us4-share.md`、`provider.test.mjs` | PASS |
| SC-008 | Light/Dark 关键屏真机视觉达标，无可爱/粉色 chrome | T083 | `ui-visual-qa.md`、`theme-*.png` | PASS |
| SC-009 | Foundation 期 ADB 实时预览 + 真实生成/安装 debug APK | T014/T016/T017 | `android-preflight.md`、`early-apk-build.txt`、`reinstall-*.txt` | PASS |
| SC-010 | 演出模式自然结束 20 次均不自动下一首 | T062/T077 | 代码不变量（`PerformancePage.tsx:87`、`LibraryPage.tsx:17` 的 `onEnded` 仅停止/隐藏，无 `select(next)`）+ `tonight-playlist.md`（下一首只选中不发声）；**未脚本化 20 次重复计数** | PARTIAL |

## 缺口与处置

- **SC-001（PARTIAL）**：真实 31 条为 API 批量导入（`import-first-batch.mjs`），未在空库上用 UI 逐步计数人工操作。逐个 UI 流程已实现并有截图；缺口为“空库→首条”的逐步计数未做。低风险，列入 HUMAN-GATE 待用户知悉。
- **SC-004（PARTIAL）**：USB 固定真机飞行模式 + Wi-Fi 关闭，完全断网冷启动与 10 首逐曲切歌已经通过；真实曲库均“想学”，未擅改真实学习状态，“会跳”指定前置未按字面验证，继续保留 PARTIAL。
- **SC-010（PARTIAL）**：行为由代码不变量保证（全仓无任何 `ended→下一首` 代码路径），并有单次观测；20 次重复计数未脚本化（长异步 eval 在真机 WebView 卡住）。
- **FR-023（已闭合）**：本轮发现并修复 `.playlist__handle` 44→48、`.playlist__move button` 40→48。
- **T015（USB）**：Foundation 当时固定真机仅有网络 ADB，另一台 USB 设备为 Note12 Pro（禁用）；本轮固定真机已 USB 接入并完成 bundled 复验。T015 的 USB live reload 未按字面执行，改用网络 ADB live 预览（`early-live-preview.txt`）。如实标注。

结论：FR 全项 PASS；SC 中 7 项 PASS、3 项 PARTIAL（SC-001/004/010，均为“已实现且主要证据在手、个别计量/物理条件未逐字满足”），无 GAP。全部缺口与边界列入 `HUMAN-GATE.md`。


## 2026-10-03 局部增量验收

| 要求 | 证据 | 状态 |
|---|---|---|
| FR-029 当前结果批量选择、筛选改变清空、退出不保存 | bulk-edit.test.tsx + bulk-edit-round5.json 原生触摸 | PASS |
| FR-030 三种状态/四标签添加移除替换与清空预览 | bulk-update.test.mjs + 真机隔离示范六项记录 + 弹层截图 | PASS |
| FR-031 原子选中项更新、失败重试、元数据/缓存保护 | SQLite 中途失败回滚 + HTTP 校验 + 界面断连 + 真机前后缓存比对 | PASS |
| 用户并行封面改动保留 + README 中英事实一致 | 最终 APK 浅深首页/详情截图 + lint/test/build | PASS |

前述 SC-004“真实曲库均想学”指此前物理断网测试时；后续交互使用中已变为会跳，未在此增量重做该指定前置的物理断网计数，保留 PARTIAL。
