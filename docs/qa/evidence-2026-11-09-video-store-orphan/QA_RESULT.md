# 视频存储两项残留问题修正 · 自测结果（2026-11-09）

范围：只改 `src/lib/video-store.ts`、`src/lib/offline-files.ts`、`src/components/PendingImports.tsx`、
`src/components/SyncControls.tsx` 与两份相关单测。未碰数据库迁移、未装机、未动真实数据、未部署、未提交。

## 问题 1｜无 sidecar 的孤儿文件不得自证完整

改动：
- `scanStoredVideos()` 的孤儿登记分支不再对实际文件自算摘要、不再写 sidecar、不再置 `verified:true`；
  只登记 `verified:false`、`checksum:undefined`，保留文件与 `.part` 现场。
- sidecar 缺 `checksum`（无原始预期摘要）时同样只登记为待核实，且不读全文件自算摘要、不改写 sidecar。
  再次扫描也不会被"洗"成已核实（`previous.stamp === stamp` 时直接保持）。
- `readStoredVideo()` 对 `!verified` 直接抛 `VideoCopyError`，因此不能上传（`uploadStoredVideo` /
  `offline-files.fileBody` 全部经此入口）；`verifiedVideoUri()` 原本已对 `!verified` 返回 null，不能播放。
- `PendingImports` 显式显示「内容待核实：缺少原始大小与摘要…暂不能上传或播放；文件仍保留在手机里」，
  并禁用「继续上传」。

## 问题 2｜移除待办不等于删除视频

改动：`discardPendingFile()` 不再调用 `discardStoredVideo()`；只删待办自身的 `dance-pending/…`
临时文件与待办记录。视频持久副本、sidecar 与 `jobId/sourceMediaId` 关联全部保留，可恢复。
`SyncControls` 的移除确认文案按 `videoId` 区分，不再声称会删除视频副本。

## 测试证据（本轮实跑）

```
npx tsc -b --pretty false
npx eslint src/lib/video-store.ts src/lib/offline-files.ts src/components/PendingImports.tsx src/components/SyncControls.tsx
npx vitest run tests/unit/video-store.test.ts tests/unit/offline-files-video-persist.test.ts \
  tests/unit/offline-files.test.ts tests/browser/video-import-persistence.test.tsx
```

结果：tsc 无输出（exit 0）；eslint 无输出（exit 0）；vitest `4 passed / 37 passed`。

新增/改写的针对性用例：
- `不完整孤儿（无 sidecar、只剩前几十字节）不得被标为已核实或当成可播放/可上传`
  —— 负例：2000 字节视频只剩 64 字节且无 sidecar；断言 `verified:false`、无 `checksum`、
  `verifiedVideoUri()===null`、`readStoredVideo()`/`uploadStoredVideo()` 均 reject、
  文件仍在、无伪造 sidecar、二次扫描仍未被标为已核实。
- `正式文件已落盘但 sidecar 没写成时，按文件名补登记为「待核实」，不冒充可用`（原用例改为新口径）。
- `sidecar 缺少摘要时也保持待核实，不自算摘要补成可用`（断言读盘次数 0）。
- `批量视频上传失败时保留待办与副本；移除待办不等于删除视频，持久副本保留可恢复`。
- `已关联任务但上传未完成的待办被移除后，持久副本与 jobId 关联仍保留可恢复`。

## 未覆盖 / 风险

- 旧版本已写入的"孤儿 sidecar 自带自算摘要"无法与真实核验区分，本次只影响新扫描路径。
- 未做真机验证（本轮不装机），结论仅覆盖单测层面的逻辑与界面文案。
