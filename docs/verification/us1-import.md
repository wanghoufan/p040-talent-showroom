# US1 收录完善 / US4 分享准备 证据（2026-10-02）

## 服务端新增与验证

- `server/import/source-adapter.mjs` + `local-file-adapter` / `manual-audio-adapter` / `douyin-adapter`：唯一来源取得注册表；未注册 host 拒绝；抖音 adapter `canAcquire=false`。
- `POST /api/imports/link`：只走注册表（`startLinkImport`）；抖音链接返回 `NEEDS_INPUT` 并保留 `draft.link`。
- `POST /api/imports/:id/supplement`：对 NEEDS_INPUT 任务补充本地视频，**保留原分享链接**；处理完成后 `source_media.source_locator` 记录该链接。
- `POST /api/dances/:id/cover`：人工封面，魔数校验（jpeg/png/webp），伪图片 415。
- 测试：`tests/link-cover.test.mjs` 通过（未注册 host 400；抖音 NEEDS_INPUT 保留链接；补视频后 finalize 条目 `sourceLocator` 保留；人工封面与伪图片拒绝）。

## 前端

- `ImportSheet`：三入口 + 电脑端拖拽 drop。
- `ImportProgress.tsx`：用户语言阶段进度，不暴露命令/路径/provider。
- `ImportReviewPage`：识曲候选选择/忽略/手填；NEEDS_INPUT 走 supplement 保留链接。
- `DanceDetailPage`：非破坏 `ClipTrimmer` + `修改封面`。

## 真机（192.168.31.63:5555）

- 详情页含「裁剪片段（非破坏）」与「修改封面」；截图 `screens/us1-detail-cover-trimmer.png`。
- 说明：HMR 对新模块需整页 reload 才生效，重载后按钮出现；非缺陷。

## 自动化

- `tsc -b` 0 错；`eslint .` 通过；`vitest run` 4 通过；`node --test tests/*.test.mjs` 10 通过。
