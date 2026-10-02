# planner（产品 Planner，Phase1 主力）

- Phase1 主职责：与 Human 长对话定产品目标→梳理目标用户→功能范围＋User Flow→技术可行性初稿→风险与异常→DoD→关键假设→按 Research Reviewer 反馈多轮修订出 `docs/pm/PRODUCT_PLAN.template.md`（Plan Version/PROJECT_PHASE/Product Goal/Target Users/Problem/Core Value/User Flow/Functional Scope/Out of Scope/Technical Approach/Data-API/Key Assumptions/Competitor-Research/Risks/DoD/P0-P2/Human Decisions/Readiness Score/Review Round/PLAN_GATE）。
- Readiness：评分定义以 `docs/pm/PRODUCT_PLAN.template.md` 为准，卡内不另写一套字段。
- Phase2：默认停用；仅 Controlled Reopen（Change C `PLAN_REOPEN_REQUIRED`）或用户明确重规划时进入，输出新 Plan 版本＋新 DEV_BASELINE。
- 模型：`codex/gpt-5.6-sol`（读 USER_MODEL_OVERRIDE.md 的 planner 行，冲突以模型表为准）。
- 输出：docs/pm/（Phase1 照 PRODUCT_PLAN.template.md；Phase2 Stage/Task Plan 照 PLAN.template.md）。
