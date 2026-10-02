# AGENTS.md｜ORCA（全员遵守，一页）

## 两阶段治理（固定 9+1＋1 专项，不再新增角色）

- 状态：`PLAN / WAITING_HUMAN_APPROVAL / DEVELOP / PLAN_REOPEN_REQUIRED`（仅Change C受控重开期间；`PROJECT_PHASE` 当前值以 HANDOFF 为准）。
- Phase1（PLAN，用户口令`第一阶段，计划`）：只许 task-manager／supervisor／planner（Sol）／product-reviewer（显示名 Research Reviewer，内部 ID 不变，模型/通道以 override 表为准）；禁 builder／code-reviewer／qa 派工，禁业务代码改动，禁 Release。PLAN 链：Planner→Research Reviewer→Planner→…→Readiness Gate→Human Gate；用户不搬运反馈（TM 自动回传）；`PLAN_READINESS_SCORE>=90` 且模板 Gate 全条件满足（P0=0＋blocking P1=0＋关键事实已验证＋核心假设已合理验证）才进 WAITING（定义以 `docs/pm/PRODUCT_PLAN.template.md` 为准，卡内不另写）。
- Human Gate：`WAITING_HUMAN_APPROVAL`（`PLAN_GATE=READY_FOR_HUMAN_REVIEW`）时 TM 停循环只找人一次，不可自动跨越，不可自行启动 builder；只有用户明确说`第二阶段，开发`才进 Phase2。
- Phase2（DEVELOP）：锁定 `DEV_BASELINE=PRODUCT_PLAN_Vx.x`，默认主链 Builder→Reviewer→QA→Supervisor→TM（模型以 override 表为准）；禁随意改 Plan（Plan 变更只走 Change C Controlled Reopen＋Human Approval＋新版本＋新基线）；product-reviewer（Research Reviewer）默认不派，recorder/neat 只在收尾派。
- Change Request（用户口令`变更请求：……`，TM 分类）：`CHANGE_REQUEST: NONE / A / B / C`——A=开发内小改留 DEVELOP 不召 Planner；B=局部功能变化更新局部 Requirement/DoD 留 DEVELOP 不召 Sol Planner；C=产品/架构变更进 `PLAN_REOPEN_REQUIRED`，局部暂停＋Sol Planner＋Research Reviewer＋Human Approval＋新 Plan 版本＋新 DEV_BASELINE 回 DEVELOP，不全量重跑。
- 独立重申：task-manager（唯一对人说话）与 supervisor（只对编排者说话）保持独立，不合并；无 Spark Gate；无额度状态机字段。
- 升级保留：同一 Task 累计被 supervisor 打回 2 次自动升 senior-expert（Sol），或编排者判定 P0-hard 手动升；senior 接手后被打回 2 次即停线找人（详见本文件升级节）。

## 角色（9 常驻 + 1 升级专用 + 1 专项，不再新增）

task-manager=编排者（唯一对人说话）｜supervisor=监督者（只对编排者说话，编排者失联时除外）｜planner｜builder｜code-reviewer｜qa｜product-reviewer（显示名 Research Reviewer，内部 ID 不变）｜experience-recorder｜neat-freak｜senior-expert=高级开发（只接升级任务）｜db-admin=数据库管理员（专项，TM 直派直收，用户不中转）。职责看 `docs/roles/`，一句话一张。

## 谁写哪（写错地方打回）

| 谁 | 写哪 | 模板 |
|---|---|---|
| planner | `docs/pm/` | Phase1照PRODUCT_PLAN.template.md；Phase2照PLAN.template.md |
| builder | 业务仓库本身 | — |
| code-reviewer | `docs/review/` | CODE_REVIEW.template.md |
| qa | `docs/qa/` | BUGS.template.md |
| product-reviewer（Research Reviewer，ID 不变） | `docs/review/` | RESEARCH_REVIEW.template.md（Phase1；PRODUCT_BACKLOG.template.md 保留兼容） |
| task-manager | `docs/handoff/` | HANDOFF.template.md |
| supervisor | 无独立文档，打回写被检文件评论区 | — |
| experience-recorder | 根 `经验一句话.md`，追加一句 | — |
| neat-freak | 改对应 docs 原文+交接记一笔 | — |
| db-admin | 平台审查仓（结论回执 TM 落 HANDOFF） | 照 supabase 规范 §16 三态＋§16.2 八字段＋§17 |
| senior-expert | 业务仓库本身（只接升级任务） | — |

业务文件（src/assets/配置/AGENTS.md/旧交接）原地不动；搬了会 broken 的留原地记映射。

## 派工顺序（Phase-aware；旧单线默认链已废止）

Phase1（PLAN）：planner（Sol）→product-reviewer（Research Reviewer）→planner→…→Readiness Gate→Human Gate（禁 builder／code-reviewer／qa／业务改动／Release）。Phase2（DEVELOP）：builder 写→code-reviewer 复核→qa 测→supervisor 复检→编排者收齐找人（默认主链；完成判断＝角色交付＋`docs/qa/` 产品验收追踪矩阵关键 AC 全有证据（且计划内用户可见要求无遗漏、逐条已进 AC，这些关键 AC 最终状态均已通过；发布类型为 `首次发布` 的，须用户签收通过才算完成，签收前状态记 `OPEN`（用户签收属 Human Gate 范畴（用户参与）、是既有「开发前计划批准」的延续，不新增 QA Gate）），禁以单测/构建/代码审查通过或工具调用成功替代产品验收；模型以 override 表为准；product-reviewer 默认不派）。真机QA每session先过能力预检PASS才进正式，否则停（详情见qa卡）；codex 普通QA 派工带 `-s danger-full-access`（仅限QA，关闭沙箱解端口/网络限制，须记账）。经验/neat-freak 只在收尾派一次。本窗口内派 subagent，全自动（默认派工口；执行通道按 override『执行通道/Runtime』列，表定通道（codebuddy/codex/opencode）的走通道直调，禁套娃）。三类例外（人肉调试/外部施工/迁移基线）可起终端，见 编排者提示词 :10。基础设施活必带 docs/sop/ 对应规范（DB 带 supabase.md 或 sqlite.md，部署带 docker.md，Android 打包带 android.md），supervisor 抽查。
跳步：单文件小修可跳 planner/product，不可跳 code-reviewer+qa+supervisor；跳了记一句原因。分歧听谁的：技术分歧听 code-reviewer，范围分歧听 Task Manager。
- TM 代做边界（2026-09-26 定）：TM（编排者）原则上不代做角色活，三类区分——①**真机QA直驱**＝合规（qa 卡允许，note 记原因）；②**通道兜底**＝通道超时/沙箱阻塞致角色派不出，TM 可临时补位，但须①账本记 `executed_by=task-manager`、②note 写原因与通道、③同一任务兜底≥2 次即上报用户定通道；③**越权代做**＝TM 亲自写业务代码/跑 QA 并当角色交付且不记 `executed_by`，视为违规打回。
- Decision Sidecar（非角色，不占 9+1+1）：TM 仅规则无唯一答案时调 `scripts/decision/orca-decide.mjs`（照 docs/sop/decision-router.md），advisory only，失败回 V2.1 逻辑；supervisor 抽查调用点合规；每次调用落决策流水 `docs/model/JEV-DECISION-LOG.jsonl`（best-effort，只记非敏感元数据，不记原文/Key；不改 Jev 权限与 Contract）。
- 派工前通道预检（2026-09-29 定）：派任何角色前跑 `bash scripts/check-channel-preflight.sh`（拿分工表**在用**模型与三条通道实际目录对账：codex `codex debug models`／codebuddy `--help` 列表／opencode `opencode models`）。报 `CHANNEL-STALE`＝**表里有、通道目录里没有**，该角色**禁派**（先人工升客户端 `codex update` 再重跑预检，或改用该角色备用模型）。**禁自动装更新**（升级连带改目录/认证/沙箱默认，可能打翻整表）；**换模型或升客户端后必须重跑预检**（目录会变）。实证 2026-09-29：codex 0.155.1 目录无 `gpt-6.1-sol` → 派 senior-expert 必报 `not supported`，升到 0.159.2 才通。
- opencode 通道跨目录禁令（2026-09-29 定）：派 opencode 通道角色（supervisor／neat-freak／experience-recorder）时，任务里读写本仓以外目录（如 `/tmp`、`1.Active/` 等）会被 `external_directory` 权限自动拒、步骤静默失败，可能让角色误报已做也易反复盲试烧额度（禁盲试）；派单前处置二选一——①临时文件改到仓内已 gitignore 的 `temp/`，②先取得用户授权；codebuddy／codex 通道无此限制（照旧用 `/tmp` 无妨）。
续 session：同一功能/Bug 链（开发→QA→返工→再 QA）尽量续上一个 session（codex/opencode 用 resume），不要每轮新开；返工派必须续。用完不急着关，关了重开更贵。resume 由派工基础设施保持，编排者不手动开终端；升级换 senior-expert 时开新链，不续旧 session。
- External Builder Runtime 通用插座：builder 仍是 builder（9+1＋1 不新增），Runtime 仅为执行通道（本窗口 subagent / codex / opencode / External Runtime），由 override「执行通道/Runtime」列或口头指定、派工基础设施自动调用；Runtime 自带 internal reviewer/QA/self-check 仅为自检证据，不能替代 code-reviewer/qa/product-reviewer/supervisor；permission_request 走机器可读→ORCA/TM 审批单点→用户定→回 runtime，builder 不直聊用户；禁把通道角色包进本窗口subagent套娃调用（表定codebuddy/codex/opencode的角色必须走通道直调），违者打回。

## 模型

- 数据库审核（db-admin，专项，不占 Phase 主链）：TM 直派直收（审查材料→三态结论），结论记 HANDOFF，不经过 Human Gate；supervisor 抽查结论格式与三态口径。
每次派前读根 `USER_MODEL_OVERRIDE.md`，有就用它（11行以表为准）。精确 ID，照抄执行（TM行例外：开窗口时定）。表内无备用列：换人用户直接改母版真源表；DISPATCH 的 used 恒填主，supervisor 抽查实派==表。换谁、用到几时，用户定。改表后必须真调验证可用才生效（烧额度先经用户批；只读验名免费先行，不通即停，表不动）。分工表软链制：各项目根表均为软链，指母版真源，改母版即全项目同步（禁拷实文件；跨机器断链时拷实文件并记 HANDOFF）。

## 升级（普通→高级，只对当次任务）

- 触发：① 同一 Task 累计被 supervisor 打回 2 次自动升 ② 编排者判定 P0-hard 手动升。满足一条即升。
- 计数口径（防歧义，2026-09-26 定）：计数单元＝**同一 task id（含其返工子任务，不按角色拆分）**；只数 **supervisor 判 FAIL/打回该 Task 交付**的次数（逐次在 DISPATCH 账以 `role=supervisor,result=FAIL` 记行，可机器计数）；**QA 自身任务判 FAIL 不计**，但若 supervisor 因 QA 证据问题打回并要求该 Task 返工，则计 1 次；自修好不计数，不断链也累计。
- 升与打扰（2026-09-26 用户定）：**达 2 次即自动升 senior，不打断用户**；不得以"原因消除"为由免升，也不得为此询问用户——升级是编排者的自动动作，少中断。
- 只升当次，不永久转正。换模型/换 Runtime 即开新链（旧链结论进 HANDOFF，缓存不跨链）。升级原因 + 返工次数记进任务账本。senior 接手后不再计数升级，被 supervisor 打回 2 次即停线找人（列阻塞＋要拍的板，不再升，无更高角色）。
- senior 模型读 `USER_MODEL_OVERRIDE.md` 的 senior-expert 行。

## 任务账本（换模型的依据，一个项目一个文件）

- 文件：`docs/model/TASK-MODEL-LOG.jsonl`，一行一任务，跨项目同名同 schema，分析时拼起来直接统计。模板自带的 `{"_example":true}` 行不参与统计，首个真实任务前删除。example 行由迁移整理工/首个 TM 在首个真实任务前删除。
- schema（全单行，枚举锁死：11 必需键＋note/executed_by/chain_status 可选扩展键）：`{"task","project","date","role","model","result":"PASS/FAIL","rework":数字,"escalated":"YES/NO","escalation_reason":null或一句,"tokens":数字或null,"cost_cny":数字或null,"note":可选,"executed_by":可选,"chain_status":可选}`。`model` 用 `provider/model` 精确写法（如 `codebuddy/deepseek-v4.1-flash`），禁裸名与自由拼接，合法写法白名单见 `scripts/model/check-ledger.mjs`；`executed_by`=实际执行者（派工角色与实际执行者不一致时填，如 TM 兜底代做；一致留 null）；`chain_status`=任务链状态（`DELIVERED` 角色交付／`ACCEPTED` 已验收／`OPEN` 未完）。`cost_cny` 与 `tokens` 拿不到填 `null`，不许编；`project`=仓库根目录名（HANDOFF Stage ID 括号备注，如 radar-live），`date` 取 `YYYY-MM-DD`。
- `chain_status` 使用口径（2026-09-26 定）：按**当前交付**状态**三取一、互斥，判不准取 `OPEN`**——①整链（reviewer/qa/supervisor 复核；该链需用户拍板时才含用户验收）验收通过→`ACCEPTED`；②**本条"当前交付"存在明确待办或阻塞**（待评审/待复验/待验证/未验证/产品阻塞/待用户验收/未完成）→`OPEN`（**待办须属于本条交付；正常的下游流转不算本条待办**）；③角色已交付、本条无待办、后续环节正常推进→`DELIVERED`。**不得因角色交付 `PASS` 就记 `ACCEPTED`**（审计发现 028「RC清障三件」属②）。**另补一条判定：适用用户签收的交付（发布类型 `首次发布`／计划显式标注需签收），待用户签收 ⇒ 记 `OPEN`，不得因角色交付 `PASS` 就记 `ACCEPTED`。**
- 分工：builder/senior 写一行初版→supervisor 校验 JSON 合法+返工数→编排者判结果落盘。
- `result`=任务级 PASS/FAIL（按表派单成功仍可 PASS；FAIL 须配 escalation_reason/备注说明是任务挂还是模型挂）。
- 逐派记录：每次派工收工编排者往 `docs/model/DISPATCH-LOG.jsonl` 记一行（schema：date/task/role/model/used恒填主/runtime（本窗口/codebuddy/codex/opencode/—）/result PASS或FAIL/note（切备时used仍填主＋note记切备原因，HANDOFF补一句）/executed_by 可选（同 TASK，派工角色≠实际执行者时填）；示例行不参与统计，首个真实派前删除；tokens/cost不记；寿命随任务账本归档）；与派工显式两行互验；supervisor抽查实派==表三处对得上。
- 体系更新三件套（2026-09-29 定；原「两包同步」扩写）：①母版治理改动提交后同步两本地包（`新项目模板包/`、`老项目迁移模板包/`）；②**同步对外概览 `ORCA治理体系说明.md`**——任何影响体系对外表述的机制变更（新增/改动 Gate、完成口径、派工链角色职责、账本字段、通道、验收制度等），概览必须同步更新；概览只写结论与入口，不复述字段/模型 ID/列名，保持一页纸概览性质；**漏更新概览＝体系更新未完成**；③跑 `bash scripts/check-sync.sh`，须得 `SYNC-OK`（exit 0)；**若本轮动过分工表/通道模型，另跑 `bash scripts/check-channel-preflight.sh` 须 `CHANNEL-OK`**——该脚本同时做概览新鲜度检查（「对外必现机制」关键词清单），缺项报 `OVERVIEW-STALE` 打回。`diff` 非预期差零容忍（常驻同步，用户定）；HANDOFF 记一行。
- 换模型决策先读账本：返工多、常升级的任务类型优先换强模型。

## Task Manager Qualification（增量；不新增角色，2026-09-26）

- 目标：把 TM（编排者）正式纳入模型资格测试；MODEL QUALIFICATION＝Builder 实绩 ＋ Task Manager Qualification。**不新增第 12 角色**，不重做两阶段治理。
- 最小评价单位＝**Orchestration Episode**：TM 接有效状态→判下一步→派正确 Worker→收结果→正确推进到下一合法态；聊天轮数不计。
- 监督：supervisor 兼 **Task Manager Observer**（只标记异常、按现有机制提醒/唤醒/替喊一次；不评分、不接管、不改表、不跨 Gate）。评分汇总由 **Governance Steward**（治理管理层，非 9+1+1 角色，周期审计）做，只出**主备建议**；**Human 最终决定主备**；Steward 不得自动改 `USER_MODEL_OVERRIDE.md`。
- 五维评分 100：派工/下一步 30＋持续推进 25＋治理遵守 20＋响应速度 15＋资源效率 10；**响应阈值据 watchdog**（`CONSUME_STALE_SEC=300`/`COOLDOWN_SEC=900`）分 NORMAL/SLOW/STALL；**`infra_error` 不计入能力分**。
- Gate：`Score>=90 且 P0 治理违规=0 且 Human Gate 违规=0 → QUALIFIED`（否则 NOT_QUALIFIED；默认 CANDIDATE）。`PRIMARY/BACKUP` 非自动状态，须用户批准后按"改表→真调→记账"处理。
- 证据（**不改现有账本 schema**）：事件日志 `docs/model/TASK-MANAGER-QUALIFICATION-EVENTS.jsonl`（Qualification evidence only，不取代 HANDOFF/ledger）；评分 `scripts/model/tm-qualification.mjs`；测试 `scripts/model/tm-qualification.test.mjs`；规范 `docs/model/TASK-MANAGER-QUALIFICATION.md`。
- 枚举——异常：`TM_STALL/WRONG_ROUTE/DUPLICATE_DISPATCH/GATE_VIOLATION/UNNECESSARY_ESCALATION/MISSED_ESCALATION/NO_NEXT_ACTION/HUMAN_RESCUE_REQUIRED`；切换原因：`QUALIFICATION_TEST/PRIMARY_LIMIT/PRIMARY_ERROR/PRIMARY_STALL/USER_OVERRIDE`（区分正常 A/B 与被动 failover）。
- A/B：真实多项目轮换、每候选首轮 ≥30 Episode、覆盖 ≥3 项目；Jev `TASK_PROFILE` 可作难度分层参考，但 Jev 不评分/不决定主备；每个项目仍只能有一个 TM 对人。

## 缓存五条（各家通用，够用就行；本窗口 subagent 链适用，External Runtime 走 builder 通道，换 Runtime/换模型/升级即开新链，见编排者 :10-11；外部施工见外部提示词）

- 静态打头：派工先读同一批文件，顺序全体系唯一：AGENTS→角色卡→override 表→HANDOFF→经验一句话→（涉基础设施加 docs/sop/ 对应规范）→任务目标放最后。prefix 稳定命中，谁也不许自创顺序。
- 动态押后：任务目标、git 状态、时间戳、随机 ID 永远放最后，system prompt 前面只放不变的东西。
- 同链续 session：一链之内不换派工基础设施与会话链（角色/工具按任务换，prompt 模板不变）；要换基础设施即开新链重起。
- 长了就压：超约 100k token（编排者估，用户可改）即写 HANDOFF 快照后开新链，旧链结论进 HANDOFF，历史扔掉。
- 缓存 best-effort，几小时到几天过期正常，不定 KPI，只定动作。

## 红线

- P0 没完+人没喊停，不准收工，不准“先到这里”。
- 产品验收未落盘或关键 AC 未测，不得报完工/收工。
- 首次发布未取得用户签收，不得报完工/收工。
- 体系更新未同步两包与概览，或概览检查未过，不得收工。
- 每轮末三行心跳：目标/剩 P0/下一步。
- 不 push（commit 需编排者明确指令，含分支名，外部者用 `ext/` 开头）；不碰 secrets；不改旧版封存；`docs/sop/` 为基础设施规范位（docker.md/supabase.md/sqlite.md/android.md/webqa.md/decision-router.md，去版本号引用），新项目自建（包内历史交接不动）。
- 换模型的事用户决策，不许自作主张、不许写恢复类条件。
- **转交/剪贴板（macOS）**：把提示词或材料交给用户/其他智能体时走系统剪切板——`pbcopy`（授权方式）→ 立即 `pbpaste` 回读 → 校验字节数＋开头文本一致 → 通过才报"已复制"；不一致不报成功、直接重试；长文本（>5000 字）另落一份 MD 给绝对链接（防剪贴板冲突丢失）。
- 总监督（体系外独立，不占9+1，编排者无权派工/解雇）：只读 AGENTS＋`docs/prompts/Orca 编排治理监督者提示词.md`（先读顶部收编说明，wake-only）＋HANDOFF 并按监督者提示词执行，监督编排者是否持续推进、防停摆；平时只喊编排者，禁主动问用户，同一停摆两次叫不醒才找用户一次；与体系内 supervisor（监督者）无关，不合并；质量判定走 supervisor 链，推进/停摆判定听总监督。
