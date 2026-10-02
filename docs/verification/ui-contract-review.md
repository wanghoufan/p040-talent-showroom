# UI Contract Review (T006)

- 记录日期：2026-10-02
- 任务：复核 `docs/ui/ui-contract.md` 与 SPEC / approved prototypes：底部四 Tab、3 状态、4 标签、收录流程、详情“查看原视频”、light/dark tokens；原型文字不作为 copy source。
- 已读：`docs/ui/ui-contract.md`、`docs/ui/ui-assets-manifest.md`、`specs/001-personal-dance-library/spec.md`、`plan.md`、`reference/ui/prototype-dark-approved.png`、`reference/ui/prototype-light-approved.png`、`reference/ui/launch-screen-preview-dark.png`、`.specify/memory/constitution.md`。

## 结论：一致（无冲突）

| 契约项 | UI Contract | SPEC / Constitution | 结论 |
|---|---|---|---|
| 底部导航 | 曲库 / 今晚歌单 / 演出模式 / 我的 | 同（UI Contract §Navigation；prototype 底栏一致） | ✅ 一致 |
| 学习状态 | 会跳 / 正在练 / 想学，单选 | FR-005、Constitution III；默认“想学” | ✅ 一致 |
| 场景标签 | 耍酷 / 性感 / 户外 / 转场，多选 AND | FR-006/FR-007、Constitution III | ✅ 一致 |
| 收录入口 | “+ 收录舞蹈”，说明收的是「原视频 + 原音乐片段 + 歌曲信息 + 状态/标签」 | FR-002、Constitution I | ✅ 一致 |
| 详情主操作 | 播放音乐 / 查看原视频 同级 | FR-011、Constitution IV；`查看原视频` 最多 1 次点击 | ✅ 一致 |
| 演出模式 | 大播放控件，无编辑/删除/原视频 | FR-014、Constitution IV | ✅ 一致 |
| 视觉 | 黑/深海军蓝 + 电光蓝；无可爱/粉色 chrome | Constitution VI；plan Theme tokens | ✅ 一致 |
| 触控 | ≥48dp | FR-023、Constitution VI | ✅ 一致 |
| 原型文字 | 不得 OCR 照抄；exact copy 以 SPEC 为准 | Constitution VI | ✅ 一致 |
| 原型示例封面 | 不打包，仅占位视觉 | FR-027、Constitution VI | ✅ 一致 |

## 视觉观察（从 approved prototype）

- 深色原型为主视觉：背景近黑 `#060B12`、卡片 `#0D1621`、主色电光蓝 `#1677FF`。
- 浅色原型为同结构 token 映射：背景 `#F6F8FB`、surface `#FFFFFF`、文字 `#101828`。
- 布局顺序：顶栏（标题＋搜索＋`+`）→ 顶部场景标签行 → 左侧状态栏 + 右侧卡片网格 → 底部四 Tab。
- 原型中的 K-pop 封面人物是生成占位，不进正式包。

## 需要遵循的实现要点（供后续 Phase 使用）

1. Light 不是独立产品，是同组件 token 映射（不另造布局）。
2. `+ 收录舞蹈` 的 sheet 必须解释“收的是舞”。
3. `查看原视频` 不得藏 overflow。
4. 所有 tap target ≥48dp；safe-area / system bars 用 Capacitor + `env(safe-area-inset-*)`。

结论：UI Contract 与 SPEC/Constitution/approved prototypes 无冲突，可作为 T007/T013 的实现依据。
