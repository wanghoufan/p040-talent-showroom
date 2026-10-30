# CODE REVIEW

- Task: 批量修改弹窗扁平化（学习状态/标签直接可点）＋ 节目单/点歌/回收站列表勾选框归位
- Commit: 未提交（工作区改动）
- Reviewer: 自审（单智能体模式，执行者与开发同为本人；非独立审查）
- Result: 过

> Dispatch / Evidence ID 系字段 2.0 已废弃，不填。

## 改动范围

- `src/components/BatchEditSheet.tsx`：删除「学习状态」下拉（原 `保持现有状态` + 3 状态）与「标签操作」下拉（原 `保持现有标签 / 添加标签 / 移除指定标签 / 替换全部标签`）；改为直接渲染 4 个学习状态按钮（保持现有 / 会跳·会弹·会唱 / 正在练 / 想学）与 4 个场景标签按钮（耍酷 / 性感 / 户外 / 转场），点选即加/取消。
- `src/index.css`：`.trash-row` 增加 `flex-direction:row`（修复选框被堆到曲名上方的根因）；新增 `.batch-group` / `.batch-group__label` / `.batch-group__hint`；`.batch-tags` 由 `nowrap` 改 `wrap` 以免 4 个标签在窄屏溢出。
- `tests/browser/bulk-edit.test.tsx`：随 UI 改点选按钮，断言不变（仍 `sceneMode:'add'` + `learningStatus`）。

## P0 / P1 Findings

- 无。

## P2 / P3 Backlog Findings

- 批量标签语义现固定为「添加（合并），保留原有标签」；不再提供批量「移除 / 替换全部」。如后续确有批量清理需求，需另设入口（当前按产品简化原则去掉）。
- 未做真机（Android）验证；本轮为本地生产构建 + 浏览器实跑，真机复测待用户决定是否发版时一并做。

## 根因与修法（节目单勾选框归位）

- 根因：全局 `label { display:flex; flex-direction:column }`（index.css:31）对 `label.trash-row` 生效——`.trash-row` 只设了 `display:flex` 与 `align-items:center`，未覆盖 `flex-direction`，于是复选框与曲名被纵向排列并居中。
- 修法：`.trash-row` 显式 `flex-direction:row`。同一缺陷同时影响 `RequestAdminPage`（点歌发布列表）与 `TrashPage`（回收站），一并修好。

## 验证

- `npm run typecheck` / `npm run lint` 通过；`npm test` 18 文件 59 用例全绿。
- 本地生产构建（`npm run build`）后接入真实数据副本，浏览器实跑关键流程（见 `docs/qa/BUGS-2026-10-13-批量编辑与节目单勾选.md`）。
