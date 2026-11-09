# 2026-11-09 视频长期持久＋局域网换机迁移｜当前事实与风险

> **21:45 更新：本文 §一「代码开发中、UI 接线中断、未验收」已被 §七 覆盖。** 本轮已完成开发、构建 1.1.36（39）、两机真机验收；配对方式按用户要求改为 6 位数字 + 同 Wi-Fi 自动发现。

> 本文件承接 `HANDOFF.md` 迁出的细节，避免恢复入口超过 8KB。**只记录事实与风险，不代表验收通过。**
> 执行方式：主开发者模式。用户要求：本地视频长期持久、局域网换机迁移；**禁止全量回归**。

## 一、结论

- **代码开发中，UI 接线任务中断，未验收。** 视频持久化、迁移数据层、同步保护、加密配对均已改动；UI 接线被小交接中断，尚未做界面验收。
- 本轮通过的只是**定向测试**，不是真机验收，也不是端到端验收。
- 未提交、未推送；本轮改动从未安装到任何设备；工作区原有未提交更改一律未覆盖。

## 二、已改动的代码（开发中，未验收）

### 1. 视频长期持久（`src/lib/video-store.ts`、`src/lib/offline-files.ts`）
- `hashFile` 短读即抛错，不完整副本不再被标 `verified:true`；孤儿文件保持待核实，不能播放/上传。
- `StoredVideo.stamp`（字节数:mtime）随索引入盘，`contentVerified` 按指纹跳过重启后的整份重算；并发校验共享一次读取。
- `discardStoredVideo` 先删文件成功才摘索引，失败抛错并在 UI 提示「删除失败，视频仍在手机里」。
- `linkStoredVideo` 索引缺失先 recovery，按 id 串行；播放/上传按当前容器 `getUri` 重新解析。
- `recoverStoredVideos` 并发共享一轮、索引一次性写回。
- 无 sidecar/缺摘要的孤儿只登记 `verified:false`、`checksum:undefined`，保留文件与 `.part` 现场；`readStoredVideo` 抛错拦住上传/播放。
- `discardPendingFile` 只删待办临时文件与记录，**不删持久视频副本/sidecar/jobId/sourceMediaId**。

### 2. 迁移数据层（`src/lib/migration.ts`）
- `MigrationState` 增加 `operations`/`pendingFiles`，旧机只读收集、新机幂等写回；迁移清单加入 `dance-pending/`。
- `inspectVideoCopies` 要求 sidecar 到位、`verified:true`、有 checksum 且 path/size 一致，才登记视频待办。
- `collectOfflineManifest`/`buildOfflineManifest`：迁移 `dance.offline.manifest` 摘要，新机无清单时按合并后曲库重建。
- `planCacheIndex` 冲突文件按 `conflict` 报告，不再混入 `skipped`。
- 迁移 `dance.pending-imports.v1`，按 `jobId` 幂等合并。
- `applyMigrationState.complete` 收紧：无失败、无隔离冲突、无缓存/待办/未完成收录的跳过或冲突，且 state 已接收。

### 3. 同步保护（`src/lib/migration-sync-guard.ts`、`src/lib/offline-files.ts`）
- `beginMigrationSyncGuard()`：同步置位后等在途上传自然结束；默认 30s 超时并自动释放。
- 保护期内 `flushLocalFiles()` 不发起上传；`perform()` 传完当前文件即收手；`discardPendingFile()` 拒绝执行。
- 不取消在途上传、不改上传协议；保护态为内存态。
- **UI 接入顺序**：`begin` → 收集/`startShare`（清单此后生成）→ 停止分享后 `release`；失败必须释放；卸载用 `endMigrationSyncGuard()` 兜底。

### 4. 加密与配对（Android 原生）
- 配对凭据改为 160 位随机值（32 个 Crockford Base32 字符，4 字符分组），密钥从不上网。
- 会话密钥 = HKDF(配对密钥 ‖ ECDH 共享秘密)，盐绑定 `handshakeId` 与双方临时公钥；双向证明各绑定两侧公钥，新机强制校验旧机证明。
- 清单整体加密；文件按 256 KiB 分块独立加密；每块随机 96 位 nonce，AAD 绑定 `handshakeId|fileId|chunkIndex|size`；发送前复核 size/lastModified，变化即 409。
- `MigrationPairingGuard`：握手限速、失败退避、未确认会话名额按来源 IP 计；确认只允许一次，第二个确认 409。
- 半包名绑定「握手 + 内容摘要」，续传前截断到块边界，校验失败删包重试一次；冲突副本按原始路径+摘要派生固定名，幂等跳过。
- 旧明文 `/api/migration/pair` 入口已删除；旧客户端明确失败，不回落明文。

### 5. UI（`src/components/MigrationPanel.tsx`，**未验收**）
- 已接入 `beginMigrationSyncGuard`。
- 已展示 `cacheSkipped`、`conflictFiles`、`pendingImportsSkipped`、`pendingImportsConflicts` 等未完成原因。
- 该文件为未跟踪文件，改动未提交；小交接中断时尚未做界面验收。

## 三、已验证（定向，不代表总体通过）

- 视频：`tests/unit/video-store.test.ts` + `offline-files-video-persist.test.ts` 等复跑 **34 通过**。
- 迁移数据：`tests/unit/migration.test.ts` 复跑 **35 通过**。
- 同步保护：`tests/unit/migration-sync-guard.test.ts` 7 + `tests/unit/offline-files.test.ts` 4，两文件合计 **11 通过**（11 不是单文件数）。
- 原生协议（JDK 21）：`MigrationCryptoTest` 9 + `MigrationWireTest` 5 + `MigrationPairingGuardTest` 8，共 **22 通过**；`:app:compileDebugJavaWithJavac` 成功。
- `tsc -b`、相关文件 ESLint 通过。

## 四、未做与风险（按优先级）

1. **最新整合改动未重跑、未构建**：视频/迁移/同步/UI 的最后合并状态尚未整体复跑，也未出包。
2. **安全与传输端到端审查未做**：主动 MITM、真机抓包、断网/杀进程续传、安卓端 PBKDF2/ECDH 实际耗时均未实测。当前只宣称代码与定向测试通过。
   - 安全审查余项未处理：F6 nonce 缓存按最旧淘汰/响应重放、F7 CGNAT 与「同一 Wi-Fi」文案不一致、F8 worker/连接上限与 `handleConfirm` 未复核 `codeExpiresAt`。需逐项核对后决定修或记为已知限制。
3. **两机真机验收未做**：未验证真实 Wi-Fi 下配对、清单、文件传输、冲突、恢复。
4. **同步保护是否真生效未真机核验**：需在迁移中确认老机后台上传被闸门挡住、队列未被删除。
5. **冲突与未同步队列未核验**：`operations`、`pendingFiles`、`pendingImports` 的冲突报告与新机落地未真机核对。
6. **旧视频恢复未核验**：需确认旧机缓存视频迁移后在新机可播放、可上传，孤儿副本不被误判。
7. **已知残留**：
   - 旧版本已写入的「孤儿 sidecar 自带自算摘要」无法回溯识别，只影响新扫描路径。
   - 视频索引不随迁移走，新机首次可能整份重算摘要（512MiB 级视频有卡顿/内存风险）。
   - 空间检查按清单总量而非尚缺量，可能误报空间不足；单文件 512MiB/总量 6GB 限制。
   - 续传前缀不逐块认证，依赖整文件 SHA-256 兜底。
   - 迁移期间手动删视频副本不受同步保护拦截。
   - 同一局域网大量来源可占满未确认会话名额，短暂拒绝新握手（容量问题）。
8. **设备**：Note 12 Pro 连接未授权；此前未锁定、未做真机操作；本轮改动从未安装。后续真机验收按设备借用纪律（`status → resolve → adb -s`）执行，设备口径与借用纪律见 `HANDOFF.md`。

## 五、禁令

- **禁止全量回归**；只跑定向测试与必要回归。
- **严禁以单测代替真机**；未真机验证不得报完工。
- 不提交、不推送；不改业务代码之外的账本、设备与远端。
- 不覆盖工作区原有未提交更改。
- **未安装**：截至本文件更新，本轮改动从未安装到任何设备；后续装机按设备借用纪律与覆盖安装纪律（`adb install -r`，装后回读数据）执行。

## 六、详细日志指针

| 内容 | 位置 |
|---|---|
| 安全审查（F1–F8，主动冒充/清单自证/GCM nonce/会话抢占/续传边界） | `.local/video-migration-review/security.log` |
| 整合审查（A1–A4、B1、C1–C4、D1/D2、F1–F3） | `.local/video-migration-review/integration.log` |
| 安全修复与原生测试 22 | `.local/video-migration-review/fix.log` |
| 迁移数据层修复与测试 35 | `.local/video-migration-review/data-fix.log` |
| 同步保护修复与测试 11（sync-guard 7 + offline-files 4） | `.local/video-migration-review/sync-fix.log` |
| 视频持久化首轮修复 | `.local/video-migration-followup/video.log` |
| 视频孤儿/待办修复与 34 测试 | `.local/video-migration-followup/video-final.log` |
| 迁移加密/传输实现记录 | `.local/video-migration-followup/migration.log` |
| 原生 JDK21 验证产物 | `.local/video-migration-followup/java-verify/` |
| 视频孤儿 QA 留痕 | `docs/qa/evidence-2026-11-09-video-store-orphan/QA_RESULT.md` |

## 附录：自 HANDOFF 迁出的旧横幅原文（2026-11-09，未删改）

> **11-07 推送 1.1.31 (34)**：练唱三改（Rap 按句框选、3/5 句、循环开始/结束区间循环）＋提示区布局稳定（固定状态槽＋浮层，点倍速/循环不再顶动按钮行）；**出包前必跑 `npm run android:bump`**，装后看「设置→关于」核对。三台均已装 1.1.31，12T Pro 已做 UI 验收。旧 1.1.30 (33) 包哈希 `2315508…cef1`。

> **11-08 推送 1.1.32 (35)**：取消 32 位配对码（局域网/Tailscale/本机自动签发凭据，连接后自动配对）；新 OPPO 机已装并缓存音乐 31/39 首、原视频 31/31。证据 `docs/qa/evidence-2026-11-08-auto-pair/QA_RESULT.md`。

> **原接续提示词（11-08）**：先读 §0–§二；11-08 阶段复盘已落 `docs/risks.md` #12 与 `agent.md` 新节；`netease-want-to-learn-local-zh/` 两文件在 `git status` 显示被删（非本轮所为），先确认来源再动。

> **原 11-08 用户指令**：**手机端 A4 导出/打印不做**（打印在电脑上用户自做），手机 PDF 落盘不再开发/验收；其余待办本轮全部不做，等新指令。

## 七、2026-11-09 21:45 完成状态（覆盖 §一 的「开发中/未验收」结论）

- **已完成并真机验收**：6 位数字配对码（替换 160 位 32 字符长码）＋同 Wi-Fi UDP 自动发现（旧机 42872 应答 token）＋旧机「允许 / 拒绝」确认；102 文件 / 444.3 MB 全量传输；二次迁移幂等（新增 0、跳过 101）；新机断网 + force-stop 后原视频可播；旧机数据不变。
- **版本**：1.1.36（构建 39），APK SHA-256 `849b60cf226846ef520c4c555208ac38650937eedf1fa42fd734f15d02cb0ebc`，11,333,220 B；两台真机覆盖安装并回读「关于」一致。
- **测试**：JS 10 文件 92 用例、Java 24 用例全过；`tsc -b`、相关 ESLint 通过（未跑全量回归）。
- **安全余项处理**：F6 nonce 改按会话保存/满则拒绝/随会话丢弃；F8 `handleConfirm` 复核 `codeExpiresAt` 已有，本轮补连接上限（8/单 IP 3）与 10s 头部超时；F7 文案改为「同一局域网（同一 Wi-Fi 或 Tailscale）」。
- **UI 收口**：迁移成功广播 `dance-migration-applied`，设置页即时重算缓存统计；原生失败会落 logcat 且界面不再只显示 `MIGRATION_FAILED` 代号。
- **失败样本（保留）**：1.1.34 轮两次失败经排查为 adb 坐标误触导致旧机面板卸载、分享中止，非产品缺陷；修复点＝点击前滚动到安全区（500–1750）并回读验证。
- **仍未做（不得当已通过）**：同步保护闸门真机核验、断网/杀进程续传实测、主动 MITM/真机抓包。
- **证据**：`docs/qa/evidence-2026-11-09-migration-e2e/QA_RESULT.md` 及同目录 3 张截图。
