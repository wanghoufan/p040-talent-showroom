# ORCA 新项目模板包

## 用途

用于新项目初始化。该包只提供 ORCA 的运行入口和模板，不包含任何旧项目业务代码。

## 放入项目根目录（文件位置）

```text
AGENTS.md                 → ORCA 分发版根目录 AGENTS.md
USER_MODEL_OVERRIDE.md    → 软链指 ORCA 分发版根目录 USER_MODEL_OVERRIDE.md（禁拷实文件；改母版全项目同步；跨机器断链时拷实文件并记 HANDOFF）
docs/roles/               → ORCA 分发版 docs/roles/
docs/pm/                  → ORCA 分发版 docs/pm/
docs/handoff/             → ORCA 分发版 docs/handoff/
docs/model/               → ORCA 分发版 docs/model/
docs/qa/                  → ORCA 分发版 docs/qa/
docs/review/              → ORCA 分发版 docs/review/
docs/sop/                 → ORCA 分发版 docs/sop/（docker.md、supabase.md、sqlite.md、android.md、webqa.md、decision-router.md，去版本号引用）
经验一句话.md             → ORCA 分发版根目录 经验一句话.md
GOVERNANCE_VERSION                   → 项目根（包内已含原文）
外部开发者提示词.md / 编排者提示词.md → 项目根（包内原位）
Orca 通用编排者持续推进协议.md / Orca 编排治理监督者提示词.md → 项目 docs/prompts/（AGENTS 与编排者提示词按此路径引用，勿留根）
归位表.template.md                   → 项目 docs/templates/（包内原位）
docs/model/DISPATCH-LOG.jsonl        → 项目 docs/model/（包内已含示例行，首派前删除）
docs/pm/PRODUCT_PLAN.template.md     → 项目 docs/pm/（Phase1专用，Readiness正典）
docs/review/RESEARCH_REVIEW.template.md → 项目 docs/review/（Phase1专用，内部ID product-reviewer不变，新增）
scripts/orchestration/               → 项目 scripts/orchestration/（可选：仅 Orca 终端/外部通道编排长任务时部署 L3 watchdog，部署法见其 README）
scripts/decision/                    → 项目 scripts/decision/（Decision Sidecar orca-decide，读 docs/sop/decision-router.md，用法见其 README）
```

本包已包含可直接运行的文件原文，拷贝到新项目后不依赖源仓库路径。项目运行记录（HANDOFF、任务账本、QA 和 Review）必须落在项目本地。

## 不应复制

- ORCA 分发版的 Git 历史；
- 其他项目的 HANDOFF、BUG、Review 和真实数据；
- 旧版本封存文件。

## 初始化后

1. 确认 `AGENTS.md` 已拷入项目根；`USER_MODEL_OVERRIDE.md` 建软链指母版真源（禁拷实文件，跨机器断链才拷实＋记 HANDOFF）。
2. 建立项目本地 `docs/model/TASK-MODEL-LOG.jsonl`。
3. 创建项目 `docs/handoff/HANDOFF.md`。
4. 再开始第一项任务。
